// Accounts (dev-work-plan P1-A step 3): first-run setup, sign-in with the rate
// limit and the optional TOTP step, password change, profile, and TOTP enrol,
// enable and disable with 10 recovery codes. P1 has one role, owner; P8 adds
// admin, editor and viewer.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, isNull, lt, or } from "drizzle-orm";
import type { ActivityService } from "../activity/service.js";
import { ApiError } from "../http/errors.js";
import type { Aead } from "../crypto/aead.js";
import { apiTokens, recoveryCodes, users } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./hashing.js";
import { LoginLimiter } from "./limiter.js";
import {
  newRecoveryCodes,
  newTotpSecret,
  normaliseRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.js";

export const TOTP_SECRET_CONTEXT = "users.totp_secret";
export const TOTP_PENDING_CONTEXT = "users.totp_pending";
export const RECOVERY_KEY_CONTEXT = "users.recovery_key";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
const MAX_CHALLENGES = 1000;
/**
 * Consecutive second-factor failures of one account, from any address, before
 * the account waits (P10-A L16). Only a success clears the count; each failure
 * past the limit doubles the wait, from one minute up to a day.
 */
export const MAX_SECOND_FACTOR_FAILURES = 100;
const SECOND_FACTOR_BASE_WAIT_MS = 60_000;
const SECOND_FACTOR_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_SECOND_FACTOR_ACCOUNTS = 10_000;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  totpEnabled: boolean;
}

type UserRow = typeof users.$inferSelect;

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    totpEnabled: row.totpSecretEnc !== null,
  };
}

export type LoginResult =
  | { status: "ok"; user: PublicUser }
  | { status: "totp_required"; challenge: string };

interface Challenge {
  userId: string;
  expiresAt: number;
  attempts: number;
}

interface SecondFactorFailures {
  count: number;
  /** No attempt before this time (epoch ms); 0 while under the limit. */
  until: number;
}

export interface AuthServiceOptions {
  store: Store;
  aead: Aead;
  activity: ActivityService;
  now?: () => Date;
  limiter?: LoginLimiter;
}

const invalidCredentials = () => new ApiError(401, "invalid_credentials");

export class AuthService {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #activity: ActivityService;
  readonly #now: () => Date;
  readonly #limiter: LoginLimiter;
  readonly #challenges = new Map<string, Challenge>();
  readonly #secondFactorFailures = new Map<string, SecondFactorFailures>();

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#activity = options.activity;
    this.#now = options.now ?? (() => new Date());
    this.#limiter =
      options.limiter ?? new LoginLimiter(() => this.#now().getTime());
  }

  /**
   * Recovery codes are an HMAC with a random key per user. The key is stored
   * encrypted with APP_SECRET_KEY (users.recovery_key_enc), so the first-run
   * import re-encrypts it and the codes survive a move to another key.
   */
  #recoveryHash(key: Buffer, code: string): string {
    return createHmac("sha256", key)
      .update(normaliseRecoveryCode(code))
      .digest("hex");
  }

  #user(id: string): UserRow {
    const row = this.#store.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (row === undefined) {
      throw new ApiError(401, "unauthenticated");
    }
    return row;
  }

  userCount(): number {
    const row = this.#store.db.select({ n: count() }).from(users).get();
    return row?.n ?? 0;
  }

  setupRequired(): boolean {
    return this.userCount() === 0;
  }

  /**
   * Creates the owner. Only while no user exists (first run): through the
   * setup API, or at start from DEV_SEED_OWNER_* (cause bootstrap).
   */
  async setup(
    input: { email: string; password: string; name: string },
    cause: "setup" | "bootstrap" = "setup",
  ): Promise<PublicUser> {
    if (!this.setupRequired()) {
      throw new ApiError(409, "setup_done");
    }
    const passwordHash = await hashPassword(input.password);
    const now = this.#now().toISOString();
    const row: UserRow = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: "owner",
      passwordHash,
      totpSecretEnc: null,
      totpPendingEnc: null,
      totpLastStep: null,
      createdAt: now,
      updatedAt: now,
      recoveryKeyEnc: null,
      oidcIssuer: null,
      oidcSubject: null,
    };
    // The check and the insert run in one transaction: two concurrent setup
    // requests cannot both create an owner.
    const created = this.#store.sqlite.transaction(() => {
      if (!this.setupRequired()) {
        return false;
      }
      this.#store.db.insert(users).values(row).run();
      return true;
    })();
    if (!created) {
      throw new ApiError(409, "setup_done");
    }
    this.#activity.record("user.changed", {
      actor: row.id,
      data: { action: "created", userId: row.id, role: row.role, cause },
    });
    return publicUser(row);
  }

  /**
   * Sign-in with a password. afterPassword runs only once the limit and the
   * password check have passed (P10-A L17: the OIDC owner-only rule must not
   * tell a wrong password of the owner from one of anyone else); when it
   * throws, the attempt is handed back and its error is the answer.
   */
  async login(
    emailInput: string,
    passwordInput: string,
    address: string,
    afterPassword?: (email: string) => void,
  ): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    // The attempt counts as a failure before the (awaited) hash check, so
    // concurrent requests cannot all pass the limit; a success hands it back.
    const wait = this.#limiter.reserve(address, email);
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: wait });
    }
    const row = this.#store.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    const ok =
      row === undefined
        ? await verifyAgainstDummy(passwordInput)
        : await verifyPassword(row.passwordHash, passwordInput);
    if (!ok || row === undefined) {
      throw invalidCredentials();
    }
    if (afterPassword !== undefined) {
      try {
        afterPassword(email);
      } catch (error) {
        this.#limiter.release(address, email);
        throw error;
      }
    }
    if (row.totpSecretEnc === null) {
      this.#limiter.succeed(address, email);
      return { status: "ok", user: publicUser(row) };
    }
    // The password was right; the second step decides the rest.
    this.#limiter.release(address, email);
    return { status: "totp_required", challenge: this.#newChallenge(row.id) };
  }

  #newChallenge(userId: string): string {
    const now = this.#now().getTime();
    for (const [key, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) {
        this.#challenges.delete(key);
      }
    }
    if (this.#challenges.size >= MAX_CHALLENGES) {
      const oldest = this.#challenges.keys().next();
      if (oldest.done !== true) {
        this.#challenges.delete(oldest.value);
      }
    }
    const value = randomBytes(32).toString("base64url");
    const key = createHash("sha256").update(value).digest("hex");
    this.#challenges.set(key, {
      userId,
      expiresAt: now + CHALLENGE_TTL_MS,
      attempts: 0,
    });
    return value;
  }

  /** The second sign-in step: a TOTP code or one unused recovery code. */
  loginSecondFactor(
    challengeValue: string,
    answer: { code?: string; recoveryCode?: string },
    address: string,
  ): PublicUser {
    const key = createHash("sha256").update(challengeValue).digest("hex");
    const challenge = this.#challenges.get(key);
    const now = this.#now().getTime();
    if (challenge === undefined || challenge.expiresAt <= now) {
      this.#challenges.delete(key);
      throw new ApiError(401, "challenge_expired");
    }
    const row = this.#user(challenge.userId);
    const locked = this.#secondFactorWait(row.id, now);
    if (locked > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: locked });
    }
    const wait = this.#limiter.reserve(address, row.email);
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: wait });
    }
    challenge.attempts += 1;
    if (this.#checkSecondFactor(row, answer)) {
      this.#challenges.delete(key);
      this.#limiter.succeed(address, row.email);
      this.#secondFactorFailures.delete(row.id);
      return publicUser(this.#user(row.id));
    }
    this.#secondFactorFailed(row.id, now);
    if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      this.#challenges.delete(key);
    }
    throw new ApiError(401, "invalid_code");
  }

  /** Seconds the account still waits after too many second-factor failures. */
  #secondFactorWait(userId: string, now: number): number {
    const entry = this.#secondFactorFailures.get(userId);
    if (entry === undefined || entry.until <= now) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  #secondFactorFailed(userId: string, now: number): void {
    const entry = this.#secondFactorFailures.get(userId) ?? {
      count: 0,
      until: 0,
    };
    entry.count += 1;
    this.#secondFactorFailures.delete(userId);
    this.#secondFactorFailures.set(userId, entry);
    if (this.#secondFactorFailures.size > MAX_SECOND_FACTOR_ACCOUNTS) {
      const oldest = this.#secondFactorFailures.keys().next();
      if (oldest.done !== true) this.#secondFactorFailures.delete(oldest.value);
    }
    const over = entry.count - MAX_SECOND_FACTOR_FAILURES;
    if (over < 0) return;
    const wait = Math.min(
      SECOND_FACTOR_BASE_WAIT_MS * 2 ** Math.min(over, 20),
      SECOND_FACTOR_MAX_WAIT_MS,
    );
    entry.until = now + wait;
    if (over === 0) {
      this.#activity.record("user.changed", {
        actor: "system",
        data: { action: "second_factor_locked", userId },
      });
    }
  }

  /**
   * A signed-in user proves the current password again (P10-A L15): the
   * attempt counts against the sign-in limit of the account at this address,
   * so a stolen session cannot guess the password. The reserved attempt is
   * handed back only by #reauthenticated, after the whole check passed.
   */
  async #reauthenticate(
    row: UserRow,
    passwordInput: string,
    address: string,
  ): Promise<void> {
    const wait = this.#limiter.reserve(address, row.email);
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: wait });
    }
    if (!(await verifyPassword(row.passwordHash, passwordInput))) {
      throw invalidCredentials();
    }
  }

  #reauthenticated(row: UserRow, address: string): void {
    this.#limiter.succeed(address, row.email);
  }

  /**
   * Revokes every API token of a user (P10-A M1): a password change and a
   * TOTP change end the tokens like they end the other sessions, the way a
   * reset already does. Returns the number of tokens removed.
   */
  #revokeTokens(userId: string): number {
    return this.#store.db
      .delete(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .run().changes;
  }

  /** Checks a TOTP code (marking its step used) or consumes a recovery code. */
  #checkSecondFactor(
    row: UserRow,
    answer: { code?: string; recoveryCode?: string },
  ): boolean {
    if (answer.code !== undefined && row.totpSecretEnc !== null) {
      const secret = this.#aead.decryptText(
        row.totpSecretEnc,
        TOTP_SECRET_CONTEXT,
      );
      const last = row.totpLastStep;
      const step = verifyTotp(secret, answer.code, this.#now(), last);
      if (step === null) {
        return false;
      }
      // Only one request can move the step forward: a code works once.
      const unused = or(
        isNull(users.totpLastStep),
        lt(users.totpLastStep, step),
      );
      const result = this.#store.db
        .update(users)
        .set({ totpLastStep: step })
        .where(and(eq(users.id, row.id), unused))
        .run();
      return result.changes === 1;
    }
    if (answer.recoveryCode !== undefined && row.recoveryKeyEnc !== null) {
      const key = this.#aead.decrypt(row.recoveryKeyEnc, RECOVERY_KEY_CONTEXT);
      const codeHash = this.#recoveryHash(key, answer.recoveryCode);
      const usedAt = this.#now().toISOString();
      const result = this.#store.db
        .update(recoveryCodes)
        .set({ usedAt })
        .where(
          and(
            eq(recoveryCodes.userId, row.id),
            eq(recoveryCodes.codeHash, codeHash),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .run();
      return result.changes === 1;
    }
    return false;
  }

  async changePassword(
    userId: string,
    currentInput: string,
    nextInput: string,
    address: string,
  ): Promise<void> {
    const row = this.#user(userId);
    await this.#reauthenticate(row, currentInput, address);
    this.#reauthenticated(row, address);
    const passwordHash = await hashPassword(nextInput);
    const updatedAt = this.#now().toISOString();
    this.#store.db
      .update(users)
      .set({ passwordHash, updatedAt })
      .where(eq(users.id, userId))
      .run();
    // A second-factor step started with the old password ends here too.
    for (const [key, challenge] of this.#challenges) {
      if (challenge.userId === userId) {
        this.#challenges.delete(key);
      }
    }
    const tokensRevoked = this.#revokeTokens(userId);
    this.#activity.record("user.changed", {
      actor: row.id,
      data: { action: "password_changed", userId, tokensRevoked },
    });
  }

  updateProfile(userId: string, name: string): PublicUser {
    const updatedAt = this.#now().toISOString();
    this.#store.db
      .update(users)
      .set({ name: name.trim(), updatedAt })
      .where(eq(users.id, userId))
      .run();
    return publicUser(this.#user(userId));
  }

  /** Starts enrolment: a new secret, kept pending until a code confirms it. */
  async totpEnrol(
    userId: string,
    passwordInput: string,
    address: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const row = this.#user(userId);
    await this.#reauthenticate(row, passwordInput, address);
    this.#reauthenticated(row, address);
    if (row.totpSecretEnc !== null) {
      throw new ApiError(409, "totp_already_enabled");
    }
    const secret = newTotpSecret();
    const totpPendingEnc = this.#aead.encrypt(secret, TOTP_PENDING_CONTEXT);
    this.#store.db
      .update(users)
      .set({ totpPendingEnc, updatedAt: this.#now().toISOString() })
      .where(eq(users.id, userId))
      .run();
    return { secret, otpauthUri: otpauthUri(secret, row.email) };
  }

  /** Confirms enrolment with a code; returns the 10 recovery codes once. */
  totpEnable(userId: string, code: string): string[] {
    const row = this.#user(userId);
    if (row.totpPendingEnc === null) {
      throw new ApiError(409, "totp_not_enrolling");
    }
    const secret = this.#aead.decryptText(
      row.totpPendingEnc,
      TOTP_PENDING_CONTEXT,
    );
    const step = verifyTotp(secret, code, this.#now(), null);
    if (step === null) {
      throw new ApiError(400, "invalid_code");
    }
    const codes = newRecoveryCodes();
    const totpSecretEnc = this.#aead.encrypt(secret, TOTP_SECRET_CONTEXT);
    const recoveryKey = randomBytes(32);
    const recoveryKeyEnc = this.#aead.encrypt(
      recoveryKey,
      RECOVERY_KEY_CONTEXT,
    );
    const updatedAt = this.#now().toISOString();
    let tokensRevoked = 0;
    this.#store.sqlite.transaction(() => {
      this.#store.db
        .update(users)
        .set({
          totpSecretEnc,
          totpPendingEnc: null,
          totpLastStep: step,
          recoveryKeyEnc,
          updatedAt,
        })
        .where(eq(users.id, userId))
        .run();
      this.#store.db
        .delete(recoveryCodes)
        .where(eq(recoveryCodes.userId, userId))
        .run();
      for (const recovery of codes) {
        const codeHash = this.#recoveryHash(recoveryKey, recovery);
        this.#store.db
          .insert(recoveryCodes)
          .values({ userId, codeHash, usedAt: null })
          .run();
      }
      tokensRevoked = this.#revokeTokens(userId);
    })();
    this.#activity.record("user.changed", {
      actor: row.id,
      data: { action: "totp_enabled", userId, tokensRevoked },
    });
    return codes;
  }

  /** Turns TOTP off; needs the password and a code or a recovery code. */
  async totpDisable(
    userId: string,
    passwordInput: string,
    answer: { code?: string; recoveryCode?: string },
    address: string,
  ): Promise<void> {
    const row = this.#user(userId);
    await this.#reauthenticate(row, passwordInput, address);
    if (row.totpSecretEnc === null) {
      this.#reauthenticated(row, address);
      throw new ApiError(409, "totp_not_enabled");
    }
    if (!this.#checkSecondFactor(row, answer)) {
      throw new ApiError(400, "invalid_code");
    }
    this.#reauthenticated(row, address);
    const updatedAt = this.#now().toISOString();
    let tokensRevoked = 0;
    this.#store.sqlite.transaction(() => {
      this.#store.db
        .update(users)
        .set({
          totpSecretEnc: null,
          totpPendingEnc: null,
          totpLastStep: null,
          recoveryKeyEnc: null,
          updatedAt,
        })
        .where(eq(users.id, userId))
        .run();
      this.#store.db
        .delete(recoveryCodes)
        .where(eq(recoveryCodes.userId, userId))
        .run();
      tokensRevoked = this.#revokeTokens(userId);
    })();
    this.#activity.record("user.changed", {
      actor: row.id,
      data: { action: "totp_disabled", userId, tokensRevoked },
    });
  }

  unusedRecoveryCodes(userId: string): number {
    const row = this.#store.db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(
        and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)),
      )
      .get();
    return row?.n ?? 0;
  }
}
