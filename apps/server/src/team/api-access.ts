// API tokens (dev-work-plan P8-A step 6, Paid feature apiTokens). A token is
// "dw_" plus 32 random bytes as base64url; only its SHA-256 is stored, and
// the value is shown once, in the answer that made it. A token carries a role
// no higher than its creator's when it is made, and on every request it acts
// with the lower of that role and the role its creator holds now, so a
// demoted creator demotes the token too. Tokens are sent as
// "Authorization: Bearer <value>"; they never reach the identity routes
// (D15, see tokenAllowed in the guard).
//
// On the Free fallback (step 8) tokens stop working (402, feature apiTokens)
// but stay stored, so a switch back to Paid restores them at once. Listing
// and revoking work on every plan.
import { randomBytes, randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import { and, asc, count, eq } from "drizzle-orm";
import { apiTokens, users } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, featureRequired } from "../http/errors.js";
import {
  canManage,
  effectiveRole,
  isRole,
  lowerOf,
  rankOf,
  type AssignableRole,
  type Principal,
  type Role,
} from "./roles.js";
import { hashValue } from "./service.js";

export const TOKEN_PREFIX = "dw_";

/** The shape of a token value: the prefix and 43 base64url characters. */
export const TOKEN_VALUE = /^dw_[A-Za-z0-9_-]{43}$/;

/** At most this many tokens per user. */
export const MAX_TOKENS_PER_USER = 50;

/** last_used_at is written at most once a minute per token. */
const LAST_USED_STEP_MS = 60_000;

/** The characters of the value kept for lists (prefix plus 6). */
const SHOWN_LENGTH = TOKEN_PREFIX.length + 6;

export interface TokenView {
  id: string;
  name: string;
  role: AssignableRole;
  /** The first characters of the value, to tell tokens apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

type TokenRow = typeof apiTokens.$inferSelect;

const tokenNotFound = () => new ApiError(404, "token_not_found");

/** A stored token role; anything unknown acts as a viewer, never as more. */
function tokenRoleOf(stored: string): AssignableRole {
  return stored === "admin" || stored === "editor" ? stored : "viewer";
}

function viewOf(row: TokenRow): TokenView {
  return {
    id: row.id,
    name: row.name,
    role: tokenRoleOf(row.role),
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export interface TokenServiceOptions {
  store: Store;
  entitlement: EntitlementGate;
  now?: () => Date;
}

export class TokenService {
  readonly #store: Store;
  readonly #entitlement: EntitlementGate;
  readonly #now: () => Date;

  constructor(options: TokenServiceOptions) {
    this.#store = options.store;
    this.#entitlement = options.entitlement;
    this.#now = options.now ?? (() => new Date());
  }

  /** The tokens of one user, oldest first. */
  list(userId: string): TokenView[] {
    return this.#store.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(asc(apiTokens.createdAt), asc(apiTokens.id))
      .all()
      .map(viewOf);
  }

  /**
   * A new token of the actor. The role may not be higher than the role the
   * actor acts with now (403 role_too_high); the owner role is never given.
   */
  create(
    actor: Principal,
    input: { name: string; role: AssignableRole },
  ): TokenView & { token: string } {
    if (rankOf(input.role) > rankOf(actor.role)) {
      throw new ApiError(403, "role_too_high");
    }
    const held = this.#store.db
      .select({ n: count() })
      .from(apiTokens)
      .where(eq(apiTokens.userId, actor.userId))
      .get();
    if ((held?.n ?? 0) >= MAX_TOKENS_PER_USER) {
      throw new ApiError(409, "token_limit", { max: MAX_TOKENS_PER_USER });
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const row: TokenRow = {
      id: randomUUID(),
      userId: actor.userId,
      name: input.name.trim(),
      role: input.role,
      tokenHash: hashValue(token),
      prefix: token.slice(0, SHOWN_LENGTH),
      createdAt: this.#now().toISOString(),
      lastUsedAt: null,
    };
    this.#store.db.insert(apiTokens).values(row).run();
    return { ...viewOf(row), token };
  }

  /**
   * Revokes a token: its creator, or a user who manages the creator (the
   * owner for anyone, an admin for editors and viewers). Anyone else gets
   * the answer of a missing token.
   */
  revoke(actor: Principal, id: string): void {
    const row = this.#store.db
      .select({ userId: apiTokens.userId, role: users.role })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.id, id))
      .get();
    if (row === undefined) throw tokenNotFound();
    const own = row.userId === actor.userId;
    if (!own && !canManage(actor.role, row.role)) throw tokenNotFound();
    this.#store.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, row.userId)))
      .run();
  }

  /**
   * The principal of a token value, or null for a value that is malformed,
   * unknown or revoked. Throws 402 (feature apiTokens) while the plan has no
   * API tokens: the token is kept and works again after a switch back. The
   * plan is checked before the value is looked at, so on Free every request
   * that carries a token answers 402, whatever the value is (T-08, D15).
   */
  resolve(value: string, teamRoles: boolean): Principal | null {
    if (!this.#entitlement.can("apiTokens")) {
      throw featureRequired("apiTokens");
    }
    if (!TOKEN_VALUE.test(value)) return null;
    const found = this.#store.db
      .select({
        id: apiTokens.id,
        role: apiTokens.role,
        lastUsedAt: apiTokens.lastUsedAt,
        userId: users.id,
        email: users.email,
        userRole: users.role,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.tokenHash, hashValue(value)))
      .get();
    if (found === undefined) return null;
    this.#touch(found.id, found.lastUsedAt);
    const storedRole: Role = isRole(found.userRole) ? found.userRole : "viewer";
    const acting = effectiveRole(storedRole, teamRoles);
    return {
      userId: found.userId,
      email: found.email,
      storedRole,
      role: lowerOf(tokenRoleOf(found.role), acting),
      via: "token",
      tokenId: found.id,
    };
  }

  #touch(id: string, lastUsedAt: string | null): void {
    const now = this.#now();
    if (lastUsedAt !== null) {
      const last = Date.parse(lastUsedAt);
      if (now.getTime() - last < LAST_USED_STEP_MS) return;
    }
    this.#store.db
      .update(apiTokens)
      .set({ lastUsedAt: now.toISOString() })
      .where(eq(apiTokens.id, id))
      .run();
  }
}
