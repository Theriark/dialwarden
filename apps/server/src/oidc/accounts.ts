// The accounts of OIDC sign-ins (P8-A step 5). The identity is the issuer
// plus the subject, never the e-mail (D11): a new identity whose e-mail
// belongs to an existing account answers 409 oidc_email_conflict, so an
// identity-provider account can never take over a local one, the owner's
// included. The role comes from the group mapping on every login (at most
// admin, D13). An OIDC account has no usable local password (D21).
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import { and, count, eq } from "drizzle-orm";
import type { ActivityService } from "../activity/service.js";
import type { SessionService } from "../auth/sessions.js";
import { userGrants, users } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, limitReached } from "../http/errors.js";
import type { AssignableRole } from "../team/roles.js";
import { UNUSABLE_PASSWORD } from "../team/service.js";

type UserRow = typeof users.$inferSelect;

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string;
  role: AssignableRole;
}

export interface OidcAccountsOptions {
  store: Store;
  sessions: SessionService;
  activity: ActivityService;
  entitlement: EntitlementGate;
  now?: () => Date;
}

export class OidcAccounts {
  readonly #store: Store;
  readonly #sessions: SessionService;
  readonly #activity: ActivityService;
  readonly #entitlement: EntitlementGate;
  readonly #now: () => Date;

  constructor(options: OidcAccountsOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#activity = options.activity;
    this.#entitlement = options.entitlement;
    this.#now = options.now ?? (() => new Date());
  }

  #linked(issuer: string, subject: string): UserRow | null {
    const row = this.#store.db
      .select()
      .from(users)
      .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
      .get();
    return row ?? null;
  }

  /** The owner's e-mail (the only local login while OIDC is on). */
  ownerEmail(): string | null {
    const row = this.#store.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "owner"))
      .get();
    return row?.email ?? null;
  }

  /**
   * A login without a mapped role: no account is made, and every session of
   * an existing account ends (O-19).
   */
  refused(issuer: string, subject: string): void {
    const row = this.#linked(issuer, subject);
    if (row !== null) this.#sessions.destroyForUser(row.id);
  }

  /** The account of a login: found by issuer and subject, or made. */
  signIn(identity: OidcIdentity): UserRow {
    const now = this.#now().toISOString();
    const found = this.#linked(identity.issuer, identity.subject);
    if (found !== null) return this.#follow(found, identity.role, now);
    const email = identity.email.trim().toLowerCase();
    const name = identity.name.trim().slice(0, 100);
    const created = this.#store.sqlite.transaction((): UserRow => {
      const taken = this.#store.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .get();
      if (taken !== undefined) {
        throw new ApiError(409, "oidc_email_conflict");
      }
      // The users limit of C1 (E-05): checked when a user is added.
      const max = this.#entitlement.limit("users");
      const row = this.#store.db.select({ n: count() }).from(users).get();
      const current = row?.n ?? 0;
      if (max !== null && current >= max) {
        throw limitReached("users", current, max);
      }
      const user: UserRow = {
        id: randomUUID(),
        email,
        name: name === "" ? email : name,
        role: identity.role,
        passwordHash: UNUSABLE_PASSWORD,
        totpSecretEnc: null,
        totpPendingEnc: null,
        totpLastStep: null,
        createdAt: now,
        updatedAt: now,
        recoveryKeyEnc: null,
        oidcIssuer: identity.issuer,
        oidcSubject: identity.subject,
      };
      this.#store.db.insert(users).values(user).run();
      return user;
    })();
    this.#activity.record("user.changed", {
      actor: created.id,
      data: { action: "created", userId: created.id, role: created.role },
    });
    return created;
  }

  /** The role of a linked account follows the mapping (O-19). */
  #follow(found: UserRow, role: AssignableRole, now: string): UserRow {
    if (found.role === "owner" || found.role === role) return found;
    this.#store.sqlite.transaction(() => {
      this.#store.db
        .update(users)
        .set({ role, updatedAt: now })
        .where(eq(users.id, found.id))
        .run();
      if (role === "viewer") {
        // A viewer reads only: write grants become read grants.
        this.#store.db
          .update(userGrants)
          .set({ level: "read" })
          .where(eq(userGrants.userId, found.id))
          .run();
      }
    })();
    this.#activity.record("user.changed", {
      actor: "system",
      data: { action: "role_changed", userId: found.id, role },
    });
    return { ...found, role, updatedAt: now };
  }
}
