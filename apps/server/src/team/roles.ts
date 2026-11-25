// Roles and per-server access (dev-work-plan P8-A step 2). Four roles, from
// the most to the least: owner, admin, editor and viewer. There is exactly
// one owner, and the owner role is never assigned. The owner and admins see
// every server; editors and viewers see only the servers they hold a grant
// for (editors read or write, viewers read). A server without a grant does
// not exist for that user: the API answers exactly as for a missing one.
//
// The Free fallback (step 8): without the team.roles feature every user but
// the owner acts as a viewer. The stored role and grants are kept, so a
// switch back to Paid restores everything at once.

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** The roles an invitation, a role change or an API token may carry. */
export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const GRANT_LEVELS = ["read", "write"] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

/** Lowest first, so the index is the rank. */
const BY_RANK: readonly Role[] = ["viewer", "editor", "admin", "owner"];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The rank of a role; an unknown stored value ranks below a viewer. */
export function rankOf(role: string): number {
  return isRole(role) ? BY_RANK.indexOf(role) : -1;
}

export function atLeast(role: string, needed: Role): boolean {
  return rankOf(role) >= rankOf(needed);
}

/** The lower of two roles (an API token never reaches above its creator). */
export function lowerOf(a: Role, b: Role): Role {
  return rankOf(a) <= rankOf(b) ? a : b;
}

/**
 * The role a user acts with: the stored one on Paid; on Free (no team.roles)
 * every user but the owner acts as a viewer. An unknown stored value acts as
 * a viewer too, never as more.
 */
export function effectiveRole(stored: string, teamRoles: boolean): Role {
  if (stored === "owner") return "owner";
  if (!isRole(stored) || !teamRoles) return "viewer";
  return stored;
}

/**
 * Whether an actor may give a role to someone, or change the role, grants or
 * account of a user who holds the target role: the owner manages admins,
 * editors and viewers; an admin manages editors and viewers only (R&D
 * default D3). Nobody manages the owner.
 */
export function canManage(actor: Role, target: string): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target === "editor" || target === "viewer";
  return false;
}

/** Who acts on a request: a signed-in user or an API token of one. */
export interface Principal {
  userId: string;
  email: string;
  /** The role stored on the user row. */
  storedRole: Role;
  /** The role the request acts with (Free fallback and token scope). */
  role: Role;
  via: "session" | "token";
  /** The token id when via is token. */
  tokenId: string | null;
}

/**
 * True when the principal sees every server: an owner or admin user acting
 * with that role. On the Free fallback a stored admin acts as a viewer and
 * sees only their granted servers. A token works only on Paid (T-08), where
 * its creator acts with the stored role; its scope caps what it may do on a
 * server (serverLevel), not which servers its creator sees, so a read-only
 * token of the owner still reads every server.
 */
export function seesEveryServer(principal: Principal): boolean {
  const acting =
    principal.via === "token" ? principal.storedRole : principal.role;
  return atLeast(acting, "admin");
}

/**
 * What a principal may do on one server: write, read or nothing (null). The
 * grant comes from the user (owner and admin hold every server); the
 * effective role caps it, so a viewer, or anyone on the Free fallback, reads
 * at most.
 */
export function serverLevel(
  principal: Principal,
  grant: GrantLevel | null,
): GrantLevel | null {
  const base: GrantLevel | null = seesEveryServer(principal) ? "write" : grant;
  if (base === null) return null;
  return atLeast(principal.role, "editor") ? base : "read";
}
