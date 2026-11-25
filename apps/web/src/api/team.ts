// The writes of P8 (users, grants, invitations, reset links, API tokens, the
// audit and privacy settings, OIDC) and the file downloads (user exports,
// the audit CSV). Pure functions over api() and apiBlob(); the pages own the
// query cache. Every write that is Paid answers the C1 402 body on Free,
// which the pages render with UpgradeHint.
import { api, apiBlob } from "./client";
import { auditSearch } from "./queries";
import type {
  AcceptInvitationBody,
  AssignableRole,
  AuditFilters,
  AuditSettings,
  Grant,
  InvitationInput,
  NewInvitation,
  NewLink,
  NewToken,
  OidcInput,
  OidcView,
  PasswordResetBody,
  SignedIn,
  SnapshotRetention,
  SnapshotSettings,
  UserView,
} from "./schema";

/** PUT /api/v1/users/:id/role (Paid team.roles). */
export function setUserRole(
  id: string,
  role: AssignableRole,
): Promise<UserView> {
  return api<UserView>(`/api/v1/users/${id}/role`, {
    method: "PUT",
    body: { role },
  });
}

/** PUT /api/v1/users/:id/grants (Paid team.roles). */
export function setUserGrants(
  id: string,
  servers: readonly Grant[],
): Promise<UserView> {
  return api<UserView>(`/api/v1/users/${id}/grants`, {
    method: "PUT",
    body: { servers },
  });
}

/** DELETE /api/v1/users/:id: the account is removed (every plan). */
export function deleteUser(id: string): Promise<undefined> {
  return api<undefined>(`/api/v1/users/${id}`, { method: "DELETE" });
}

/** POST /api/v1/users/:id/anonymise: the person is erased, the id stays. */
export function anonymiseUser(id: string): Promise<UserView> {
  return api<UserView>(`/api/v1/users/${id}/anonymise`, { method: "POST" });
}

/** POST /api/v1/users/:id/password-reset: a 24-hour link, shown once. */
export function createResetLink(id: string): Promise<NewLink> {
  return api<NewLink>(`/api/v1/users/${id}/password-reset`, {
    method: "POST",
  });
}

/** GET /api/v1/users/:id/export (owner): the person's data as JSON. */
export function exportUser(
  id: string,
): Promise<{ blob: Blob; filename: string | null }> {
  return apiBlob(`/api/v1/users/${id}/export`, { method: "GET" });
}

/** GET /api/v1/me/export: the signed-in user's own data as JSON. */
export function exportMe(): Promise<{ blob: Blob; filename: string | null }> {
  return apiBlob("/api/v1/me/export", { method: "GET" });
}

/** POST /api/v1/invitations (Paid team.users): the link, shown once. */
export function createInvitation(
  input: InvitationInput,
): Promise<NewInvitation> {
  return api<NewInvitation>("/api/v1/invitations", {
    method: "POST",
    body: input,
  });
}

/** DELETE /api/v1/invitations/:id (every plan). */
export function revokeInvitation(id: string): Promise<undefined> {
  return api<undefined>(`/api/v1/invitations/${id}`, { method: "DELETE" });
}

/** POST /api/v1/invitations/accept (public): the new user is signed in. */
export function acceptInvitation(
  body: AcceptInvitationBody,
): Promise<SignedIn> {
  return api<SignedIn>("/api/v1/invitations/accept", {
    method: "POST",
    body,
  });
}

/**
 * POST /api/v1/auth/password-reset (public). The answer signs the user in,
 * or is empty (204) when a second factor or OIDC applies: then the user
 * signs in on the login page.
 */
export function redeemPasswordReset(
  body: PasswordResetBody,
): Promise<SignedIn | undefined> {
  return api<SignedIn | undefined>("/api/v1/auth/password-reset", {
    method: "POST",
    body,
  });
}

/** POST /api/v1/tokens (Paid apiTokens): the value, shown once. */
export function createToken(
  name: string,
  role: AssignableRole,
): Promise<NewToken> {
  return api<NewToken>("/api/v1/tokens", {
    method: "POST",
    body: { name, role },
  });
}

/** DELETE /api/v1/tokens/:id (every plan). */
export function revokeToken(id: string): Promise<undefined> {
  return api<undefined>(`/api/v1/tokens/${id}`, { method: "DELETE" });
}

/** PUT /api/v1/settings/audit (every plan). */
export function saveAuditSettings(
  input: Partial<AuditSettings>,
): Promise<AuditSettings> {
  return api<AuditSettings>("/api/v1/settings/audit", {
    method: "PUT",
    body: input,
  });
}

/** PUT /api/v1/settings/snapshots (every plan). */
export function saveSnapshotSettings(
  snapshotRetention: SnapshotRetention,
): Promise<SnapshotSettings> {
  return api<SnapshotSettings>("/api/v1/settings/snapshots", {
    method: "PUT",
    body: { snapshotRetention },
  });
}

/** GET /api/v1/audit/export.csv (Paid audit) with the current filters. */
export function exportAuditCsv(
  filters: AuditFilters,
): Promise<{ blob: Blob; filename: string | null }> {
  const search = new URLSearchParams(auditSearch(filters, null, 1));
  search.delete("limit");
  const query = search.toString();
  const path = query === "" ? "" : `?${query}`;
  return apiBlob(`/api/v1/audit/export.csv${path}`, { method: "GET" });
}

/** PUT /api/v1/settings/oidc (owner, Paid oidc). */
export function saveOidc(input: OidcInput): Promise<OidcView> {
  return api<OidcView>("/api/v1/settings/oidc", {
    method: "PUT",
    body: input,
  });
}

/** The address of the single sign-on start, with the page to return to. */
export function oidcStartUrl(returnTo: string): string {
  const search = new URLSearchParams({ returnTo });
  return `/api/v1/auth/oidc/start?${search.toString()}`;
}
