// Users beyond the owner (dev-work-plan P8-A step 2): roles, per-server
// grants, invitation links and owner-made password reset links, plus the
// privacy controls on users (step 7): delete, anonymise and export. Invitation
// and reset values are 32 random bytes; only their SHA-256 is stored, and the
// value is shown once, in the answer that made it.
//
// Invitations are Paid (team.users); every privacy control works on every
// plan (contract C1), so delete, anonymise and export never answer 402. The
// users limit of C1 is checked only when a user is added.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import { and, asc, count, eq, gt, isNull, or } from "drizzle-orm";
import type { ActivityService } from "../activity/service.js";
import { hashPassword } from "../auth/hashing.js";
import type { LoginLimiter } from "../auth/limiter.js";
import type { SessionService } from "../auth/sessions.js";
import {
  activityEvents,
  apiTokens,
  auditActors,
  auditEvents,
  changeSets,
  invitations,
  passwordResets,
  recoveryCodes,
  servers,
  sessions,
  userGrants,
  users,
} from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, limitReached } from "../http/errors.js";
import {
  canManage,
  effectiveRole,
  isRole,
  seesEveryServer,
  type AssignableRole,
  type GrantLevel,
  type Principal,
  type Role,
} from "./roles.js";

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The password hash of an account without a usable local password (an OIDC
 * user, or an anonymised one). It is no argon2 hash, so verifyPassword
 * refuses it without throwing.
 */
export const UNUSABLE_PASSWORD = "!unusable";

export interface Grant {
  server: string;
  level: GrantLevel;
}

export interface UserView {
  id: string;
  email: string;
  name: string;
  /** The stored role. */
  role: Role;
  /** The role the user acts with now (viewer on the Free fallback). */
  effectiveRole: Role;
  totpEnabled: boolean;
  /** True for a user who signs in with OIDC. */
  sso: boolean;
  /** False when the account has no usable local password. */
  localPassword: boolean;
  createdAt: string;
  grants: Grant[];
}

export interface InvitationView {
  id: string;
  email: string;
  role: AssignableRole;
  grants: Grant[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewLink {
  /** The value, shown once; never stored or logged. */
  token: string;
  /** BASE_URL, the page, then the value in the fragment (never sent). */
  link: string;
  expiresAt: string;
}

type UserRow = typeof users.$inferSelect;
type InvitationRow = typeof invitations.$inferSelect;

export const hashValue = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** 32 random bytes as base64url (43 characters). */
const newValue = (): string => randomBytes(32).toString("base64url");

const invitationInvalid = () => new ApiError(410, "invitation_invalid");
const resetInvalid = () => new ApiError(410, "reset_invalid");
const userNotFound = () => new ApiError(404, "user_not_found");

/** A 400 with the shape of a zod refusal, for rules a schema cannot hold. */
export function validationError(path: string, message: string): ApiError {
  return new ApiError(400, "validation", { issues: [{ path, message }] });
}

/** The label an erased user leaves behind in history and the audit log. */
export const erasedLabel = (id: string): string =>
  `Erased user ${id.slice(0, 4)}`;

/** A stored grant level; anything but write reads only. */
const levelOf = (level: string): GrantLevel =>
  level === "write" ? "write" : "read";

function isGrant(item: unknown): item is Grant {
  if (typeof item !== "object" || item === null) return false;
  const { server, level } = item as Partial<Grant>;
  return typeof server === "string" && (level === "read" || level === "write");
}

function parseGrants(text: string): Grant[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter(isGrant) : [];
  } catch {
    return [];
  }
}

export interface TeamServiceOptions {
  store: Store;
  activity: ActivityService;
  entitlement: EntitlementGate;
  sessions: SessionService;
  limiter: LoginLimiter;
  baseUrl: string | null;
  now?: () => Date;
}

export class TeamService {
  readonly #store: Store;
  readonly #activity: ActivityService;
  readonly #entitlement: EntitlementGate;
  readonly #sessions: SessionService;
  readonly #limiter: LoginLimiter;
  readonly #baseUrl: string;
  readonly #now: () => Date;

  constructor(options: TeamServiceOptions) {
    this.#store = options.store;
    this.#activity = options.activity;
    this.#entitlement = options.entitlement;
    this.#sessions = options.sessions;
    this.#limiter = options.limiter;
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.#now = options.now ?? (() => new Date());
  }

  /** True while the plan has roles (Paid); false on the Free fallback. */
  get teamRoles(): boolean {
    return this.#entitlement.can("team.roles");
  }

  #link(page: string, token: string): string {
    return `${this.#baseUrl}/${page}#${token}`;
  }

  #row(id: string): UserRow | null {
    const row = this.#store.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    return row ?? null;
  }

  /** The user row, or 404 user_not_found. */
  require(id: string): UserRow {
    const row = this.#row(id);
    if (row === null) throw userNotFound();
    return row;
  }

  #roleOf(row: UserRow): Role {
    return isRole(row.role) ? row.role : "viewer";
  }

  #view(row: UserRow): UserView {
    const role = this.#roleOf(row);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role,
      effectiveRole: effectiveRole(role, this.teamRoles),
      totpEnabled: row.totpSecretEnc !== null,
      sso: row.oidcSubject !== null,
      localPassword: row.passwordHash !== UNUSABLE_PASSWORD,
      createdAt: row.createdAt,
      grants: this.grantsOf(row.id),
    };
  }

  userCount(): number {
    const row = this.#store.db.select({ n: count() }).from(users).get();
    return row?.n ?? 0;
  }

  list(): UserView[] {
    const rows = this.#store.db
      .select()
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .all();
    return rows.map((row) => this.#view(row));
  }

  get(id: string): UserView {
    return this.#view(this.require(id));
  }

  /** The principal of a user row (the guard builds one per request). */
  principalOf(row: { id: string; email: string; role: string }): Principal {
    const storedRole: Role = isRole(row.role) ? row.role : "viewer";
    return {
      userId: row.id,
      email: row.email,
      storedRole,
      role: effectiveRole(storedRole, this.teamRoles),
      via: "session",
      tokenId: null,
    };
  }

  grantsOf(userId: string): Grant[] {
    return this.#store.db
      .select({ server: userGrants.serverId, level: userGrants.level })
      .from(userGrants)
      .where(eq(userGrants.userId, userId))
      .orderBy(asc(userGrants.serverId))
      .all()
      .map((row) => ({ server: row.server, level: levelOf(row.level) }));
  }

  #serverExists(id: string): boolean {
    const row = this.#store.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, id))
      .get();
    return row !== undefined;
  }

  /** The grant of a user on one server, or null. */
  grantLevel(userId: string, serverId: string): GrantLevel | null {
    const row = this.#store.db
      .select({ level: userGrants.level })
      .from(userGrants)
      .where(
        and(eq(userGrants.userId, userId), eq(userGrants.serverId, serverId)),
      )
      .get();
    return row === undefined ? null : levelOf(row.level);
  }

  /**
   * Which servers a principal may see: every one for an owner or admin
   * acting as one (not an admin on the Free fallback), see seesEveryServer.
   */
  visibleServers(principal: Principal | null): (serverId: string) => boolean {
    if (principal === null) return () => false;
    if (seesEveryServer(principal)) return () => true;
    const grants = this.grantsOf(principal.userId);
    const granted = new Set(grants.map((grant) => grant.server));
    return (serverId) => granted.has(serverId);
  }

  /**
   * Refuses grants on servers that do not exist (422 unknown_server) and a
   * write grant for a viewer (D4: viewers read only).
   */
  #checkGrants(role: string, grants: readonly Grant[]): Grant[] {
    const seen = new Map<string, GrantLevel>();
    for (const grant of grants) {
      if (!this.#serverExists(grant.server)) {
        throw new ApiError(422, "unknown_server", { server: grant.server });
      }
      if (role === "viewer" && grant.level === "write") {
        throw new ApiError(422, "validation", {
          issues: [{ path: "servers", message: "a viewer holds read grants" }],
        });
      }
      seen.set(grant.server, grant.level);
    }
    return [...seen].map(([server, level]) => ({ server, level }));
  }

  #writeGrants(userId: string, grants: readonly Grant[]): void {
    const db = this.#store.db;
    db.delete(userGrants).where(eq(userGrants.userId, userId)).run();
    for (const grant of grants) {
      db.insert(userGrants)
        .values({ userId, serverId: grant.server, level: grant.level })
        .run();
    }
  }

  /** Checks that the actor may act on this user (owner and own account). */
  #assertManaged(actor: Principal, target: UserRow): void {
    if (target.role === "owner") {
      throw new ApiError(403, "cannot_change_owner");
    }
    if (!canManage(actor.role, target.role)) {
      throw new ApiError(403, "role_too_high");
    }
  }

  setRole(actor: Principal, userId: string, role: string): UserView {
    const target = this.require(userId);
    if (target.id === actor.userId) {
      throw new ApiError(403, "cannot_change_own_role");
    }
    if (target.role === "owner") {
      throw new ApiError(403, "cannot_change_owner");
    }
    if (role === "owner" || !isRole(role)) {
      throw validationError("role", "the owner role cannot be assigned");
    }
    if (!canManage(actor.role, target.role) || !canManage(actor.role, role)) {
      throw new ApiError(403, "role_too_high");
    }
    const updatedAt = this.#now().toISOString();
    this.#store.sqlite.transaction(() => {
      this.#store.db
        .update(users)
        .set({ role, updatedAt })
        .where(eq(users.id, userId))
        .run();
      if (role === "viewer") {
        // A viewer reads only: write grants become read grants.
        this.#store.db
          .update(userGrants)
          .set({ level: "read" })
          .where(eq(userGrants.userId, userId))
          .run();
      }
      this.#dropResets(userId);
    })();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "role_changed", userId, role },
    });
    return this.get(userId);
  }

  setGrants(actor: Principal, userId: string, grants: Grant[]): UserView {
    const target = this.require(userId);
    this.#assertManaged(actor, target);
    const checked = this.#checkGrants(target.role, grants);
    this.#store.sqlite.transaction(() => {
      this.#writeGrants(userId, checked);
    })();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "grants_changed", userId, servers: checked.length },
    });
    return this.get(userId);
  }

  // Invitations --------------------------------------------------------------

  #invitationView(row: InvitationRow): InvitationView {
    const role = row.role as AssignableRole;
    return {
      id: row.id,
      email: row.email,
      role,
      grants: parseGrants(row.grants),
      invitedBy: row.invitedBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  /** Open invitations (not used, revoked or expired), newest first. */
  invitations(): InvitationView[] {
    const now = this.#now().toISOString();
    const rows = this.#store.db
      .select()
      .from(invitations)
      .where(
        and(
          isNull(invitations.usedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .orderBy(asc(invitations.createdAt))
      .all();
    return rows.map((row) => this.#invitationView(row)).reverse();
  }

  invite(
    actor: Principal,
    input: { email: string; role: AssignableRole; grants: Grant[] },
  ): InvitationView & NewLink {
    if (!canManage(actor.role, input.role)) {
      throw new ApiError(403, "role_too_high");
    }
    const email = input.email.trim().toLowerCase();
    const taken = this.#store.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (taken !== undefined) throw new ApiError(409, "user_exists");
    const grants = this.#checkGrants(input.role, input.grants);
    const token = newValue();
    const now = this.#now();
    const row: InvitationRow = {
      id: randomUUID(),
      tokenHash: hashValue(token),
      email,
      role: input.role,
      grants: JSON.stringify(grants),
      invitedBy: actor.userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
      usedAt: null,
      revokedAt: null,
    };
    this.#store.db.insert(invitations).values(row).run();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "invited", invitationId: row.id, role: input.role },
    });
    return {
      ...this.#invitationView(row),
      token,
      link: this.#link("invite", token),
    };
  }

  revokeInvitation(actor: Principal, id: string): void {
    const row = this.#store.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, id))
      .get();
    if (row === undefined || row.usedAt !== null || row.revokedAt !== null) {
      throw new ApiError(404, "invitation_not_found");
    }
    if (!canManage(actor.role, row.role)) {
      throw new ApiError(403, "role_too_high");
    }
    const revokedAt = this.#now().toISOString();
    this.#store.db
      .update(invitations)
      .set({ revokedAt })
      .where(eq(invitations.id, id))
      .run();
  }

  /** Refuses a new user past limit(users) with the C1 402 body. */
  #assertUsersLimit(): void {
    const max = this.#entitlement.limit("users");
    const current = this.userCount();
    if (max !== null && current >= max) {
      throw limitReached("users", current, max);
    }
  }

  /** The inviter still exists and may still give the invited role. */
  #inviterAllows(row: InvitationRow): boolean {
    const inviter = this.#row(row.invitedBy);
    if (inviter === null) return false;
    const role = effectiveRole(inviter.role, this.teamRoles);
    return canManage(role, row.role);
  }

  #openInvitation(tokenHash: string): InvitationRow | null {
    const now = this.#now().toISOString();
    const row = this.#store.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .get();
    if (row === undefined) return null;
    if (row.usedAt !== null || row.revokedAt !== null) return null;
    if (row.expiresAt <= now) return null;
    return row;
  }

  /**
   * Accepts an invitation: one new user with the invited e-mail, role and
   * grants. Every refusal of the value answers the same 410. Failed accepts
   * count against the client address in the login limiter.
   */
  async accept(
    input: { token: string; name: string; password: string },
    address: string,
  ): Promise<UserRow> {
    const tokenHash = hashValue(input.token);
    // Each attempt is its own account in the limiter: the per-address limit
    // is what stops guessing, and parallel accepts of one link get the 410.
    const account = `invitation:${randomUUID()}`;
    const wait = this.#limiter.reserve(address, account);
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: wait });
    }
    const first = this.#openInvitation(tokenHash);
    if (first === null || !this.#inviterAllows(first)) {
      throw invitationInvalid();
    }
    this.#assertUsersLimit();
    const passwordHash = await hashPassword(input.password);
    const now = this.#now().toISOString();
    const created = this.#store.sqlite.transaction((): UserRow => {
      const row = this.#openInvitation(tokenHash);
      if (row === null || !this.#inviterAllows(row)) {
        throw invitationInvalid();
      }
      this.#assertUsersLimit();
      const taken = this.#store.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, row.email))
        .get();
      if (taken !== undefined) throw invitationInvalid();
      const used = this.#store.db
        .update(invitations)
        .set({ usedAt: now })
        .where(and(eq(invitations.id, row.id), isNull(invitations.usedAt)))
        .run();
      if (used.changes !== 1) throw invitationInvalid();
      const user: UserRow = {
        id: randomUUID(),
        email: row.email,
        name: input.name.trim(),
        role: row.role,
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
      this.#store.db.insert(users).values(user).run();
      // Grants on servers removed since the invitation are dropped.
      const grants = parseGrants(row.grants);
      const kept = grants.filter((grant) => this.#serverExists(grant.server));
      this.#writeGrants(user.id, kept);
      return user;
    })();
    this.#limiter.release(address, account);
    this.#activity.record("user.changed", {
      actor: created.id,
      data: { action: "created", userId: created.id, role: created.role },
    });
    return created;
  }

  // Password reset links (D21) -----------------------------------------------

  /**
   * A reset link for a user: the owner for anyone else, an admin for editors
   * and viewers. Used after the Free fallback turns OIDC off.
   */
  createReset(actor: Principal, userId: string): NewLink {
    const target = this.require(userId);
    this.#assertManaged(actor, target);
    const token = newValue();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS).toISOString();
    this.#store.db
      .insert(passwordResets)
      .values({
        id: randomUUID(),
        tokenHash: hashValue(token),
        userId,
        createdBy: actor.userId,
        createdAt: now.toISOString(),
        expiresAt,
        usedAt: null,
      })
      .run();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "reset_link_created", userId },
    });
    return { token, link: this.#link("reset", token), expiresAt };
  }

  /**
   * Removes the open reset links a user made and the open links for that
   * user: a role change, a deletion or an anonymisation ends them (M1).
   */
  #dropResets(userId: string): void {
    this.#store.db
      .delete(passwordResets)
      .where(
        and(
          isNull(passwordResets.usedAt),
          or(
            eq(passwordResets.createdBy, userId),
            eq(passwordResets.userId, userId),
          ),
        ),
      )
      .run();
  }

  /**
   * The maker of a reset link still exists and may still manage its target
   * as the target is now (like #inviterAllows for invitations).
   */
  #resetAllowed(row: { createdBy: string; userId: string }): boolean {
    const creator = this.#row(row.createdBy);
    const target = this.#row(row.userId);
    if (creator === null || target === null) return false;
    const role = effectiveRole(creator.role, this.teamRoles);
    return canManage(role, target.role);
  }

  /**
   * Sets a new password with a reset link; every session of the user ends.
   * Returns the user, so the route can sign them in (S-05: the reset use
   * sets the session cookie like a login does) unless a second factor or
   * OIDC still applies. The maker of the link is checked again at use.
   */
  async useReset(
    input: { token: string; password: string },
    address: string,
  ): Promise<UserRow> {
    const tokenHash = hashValue(input.token);
    const account = `reset:${randomUUID()}`;
    const wait = this.#limiter.reserve(address, account);
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", { retryAfter: wait });
    }
    const open = () => {
      const now = this.#now().toISOString();
      const row = this.#store.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, tokenHash))
        .get();
      if (row === undefined || row.usedAt !== null) return null;
      if (row.expiresAt <= now) return null;
      return this.#resetAllowed(row) ? row : null;
    };
    if (open() === null) throw resetInvalid();
    const passwordHash = await hashPassword(input.password);
    const now = this.#now().toISOString();
    const userId = this.#store.sqlite.transaction((): string => {
      const row = open();
      if (row === null) throw resetInvalid();
      const used = this.#store.db
        .update(passwordResets)
        .set({ usedAt: now })
        .where(
          and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)),
        )
        .run();
      if (used.changes !== 1) throw resetInvalid();
      this.#store.db
        .update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, row.userId))
        .run();
      return row.userId;
    })();
    this.#limiter.release(address, account);
    this.#sessions.destroyForUser(userId);
    this.#store.db.delete(apiTokens).where(eq(apiTokens.userId, userId)).run();
    this.#activity.record("user.changed", {
      actor: "system",
      data: { action: "password_reset", userId },
    });
    return this.require(userId);
  }

  // Privacy: delete, anonymise, export ---------------------------------------

  /** Owner protection of D24: 409 for the owner, 403 for anyone else. */
  #assertErasable(actor: Principal, target: UserRow): void {
    if (target.role === "owner") {
      if (actor.storedRole === "owner") {
        throw new ApiError(409, "owner_required");
      }
      throw new ApiError(403, "cannot_change_owner");
    }
    if (!canManage(actor.role, target.role)) {
      throw new ApiError(403, "role_too_high");
    }
  }

  /**
   * Records the erased label of the person (the audit-actors row every view
   * resolves its labels through) and removes open invitations to that
   * address. Since D7 the history tables name the user by id, so nothing
   * else has to be rewritten: the id stays and the label shows the erasure.
   */
  #scrub(target: UserRow): void {
    const label = erasedLabel(target.id);
    const db = this.#store.db;
    db.delete(invitations).where(eq(invitations.email, target.email)).run();
    this.#dropResets(target.id);
    // The address sits outside the hash (D9), so clearing it keeps the chain.
    db.update(auditEvents)
      .set({ ip: null })
      .where(eq(auditEvents.actorId, target.id))
      .run();
    db.insert(auditActors)
      .values({ id: target.id, label, erased: 1 })
      .onConflictDoUpdate({
        target: auditActors.id,
        set: { label, erased: 1 },
      })
      .run();
  }

  remove(actor: Principal, userId: string): void {
    const target = this.require(userId);
    this.#assertErasable(actor, target);
    this.#store.sqlite.transaction(() => {
      this.#scrub(target);
      this.#store.db.delete(users).where(eq(users.id, userId)).run();
    })();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "deleted", userId },
    });
  }

  anonymise(actor: Principal, userId: string): UserView {
    const target = this.require(userId);
    this.#assertErasable(actor, target);
    const label = erasedLabel(target.id);
    const updatedAt = this.#now().toISOString();
    this.#store.sqlite.transaction(() => {
      this.#scrub(target);
      const db = this.#store.db;
      db.update(users)
        .set({
          email: `erased-${target.id}@erased.invalid`,
          name: label,
          passwordHash: UNUSABLE_PASSWORD,
          totpSecretEnc: null,
          totpPendingEnc: null,
          totpLastStep: null,
          recoveryKeyEnc: null,
          oidcIssuer: null,
          oidcSubject: null,
          updatedAt,
        })
        .where(eq(users.id, userId))
        .run();
      db.delete(sessions).where(eq(sessions.userId, userId)).run();
      db.delete(apiTokens).where(eq(apiTokens.userId, userId)).run();
      db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
      db.delete(passwordResets).where(eq(passwordResets.userId, userId)).run();
      db.delete(userGrants).where(eq(userGrants.userId, userId)).run();
    })();
    this.#activity.record("user.changed", {
      actor: actor.userId,
      data: { action: "anonymised", userId },
    });
    return this.get(userId);
  }

  /**
   * The personal data of one user as JSON (privacy control): profile,
   * grants, sessions, API tokens (names and prefixes only), the change sets
   * and activity the user made. No credential, hash or secret value.
   */
  exportOf(userId: string): Record<string, unknown> {
    const row = this.require(userId);
    const db = this.#store.db;
    const sessionRows = db
      .select({
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .all();
    const tokenRows = db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        role: apiTokens.role,
        prefix: apiTokens.prefix,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .all();
    const changeRows = db
      .select({
        id: changeSets.id,
        serverId: changeSets.serverId,
        status: changeSets.status,
        cause: changeSets.cause,
        createdAt: changeSets.createdAt,
        appliedAt: changeSets.appliedAt,
        diff: changeSets.diff,
      })
      .from(changeSets)
      .where(eq(changeSets.author, row.id))
      .all()
      .map(({ diff, ...rest }) => ({
        ...rest,
        // The semantic chips only: secrets are masked in them.
        chips: (JSON.parse(diff) as { semantic?: unknown }).semantic ?? [],
      }));
    const activityRows = db
      .select({
        type: activityEvents.type,
        serverId: activityEvents.serverId,
        at: activityEvents.at,
      })
      .from(activityEvents)
      .where(eq(activityEvents.actor, row.id))
      .all();
    return {
      format: 1,
      exportedAt: this.#now().toISOString(),
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        totpEnabled: row.totpSecretEnc !== null,
        sso: row.oidcSubject !== null,
      },
      grants: this.grantsOf(userId),
      sessions: sessionRows,
      apiTokens: tokenRows,
      changeSets: changeRows,
      activity: activityRows,
    };
  }
}
