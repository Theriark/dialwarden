// TanStack Query definitions for the P1-B screens. Keys are grouped so a
// sign-in or a licence change can invalidate what depends on it.
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, setCsrf } from "./client";
import type {
  ActivityPage,
  ActivityType,
  AuditFilters,
  AuditPage,
  AuditSettings,
  AuditVerify,
  BackupList,
  ChangeSet,
  ChannelList,
  DriftList,
  EditableServers,
  Entitlement,
  GameList,
  Health,
  History,
  HooksView,
  InboxPage,
  InstanceKey,
  InvitationList,
  Matrix,
  OidcStatus,
  OidcView,
  PendingList,
  RawFile,
  Registry,
  Report,
  ReportSelection,
  ScheduleList,
  Server,
  ServerList,
  ServerSettings,
  ServerStatus,
  SettingsMeta,
  SetupStatus,
  SignedIn,
  SnapshotSettings,
  SystemStatus,
  TokenList,
  UserList,
  UserPresetList,
  UserView,
} from "./schema";

export const keys = {
  session: ["session"] as const,
  setup: ["setup"] as const,
  entitlement: ["entitlement"] as const,
  registry: ["plan", "registry"] as const,
  editable: ["plan", "editable-servers"] as const,
  health: ["health"] as const,
  status: ["system", "status"] as const,
  backups: ["system", "backups"] as const,
};

/** The session, or null when signed out (a 401 is not an error here). */
export async function fetchSession(): Promise<SignedIn | null> {
  try {
    const session = await api<SignedIn>("/api/v1/auth/session");
    setCsrf(session.csrfToken);
    return session;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrf(null);
      return null;
    }
    throw error;
  }
}

export const sessionQuery = () =>
  queryOptions({
    queryKey: keys.session,
    queryFn: fetchSession,
    staleTime: 60_000,
    retry: false,
  });

export const setupQuery = () =>
  queryOptions({
    queryKey: keys.setup,
    queryFn: () => api<SetupStatus>("/api/v1/setup"),
    staleTime: 0,
    retry: false,
  });

export const entitlementQuery = () =>
  queryOptions({
    queryKey: keys.entitlement,
    queryFn: () => api<Entitlement>("/api/v1/entitlement"),
    staleTime: 30_000,
  });

export const registryQuery = () =>
  queryOptions({
    queryKey: keys.registry,
    queryFn: () => api<Registry>("/api/v1/plan/registry"),
    staleTime: 5 * 60_000,
  });

export const editableServersQuery = () =>
  queryOptions({
    queryKey: keys.editable,
    queryFn: () => api<EditableServers>("/api/v1/plan/editable-servers"),
    staleTime: 30_000,
  });

export const healthQuery = () =>
  queryOptions({
    queryKey: keys.health,
    queryFn: () => api<Health>("/healthz"),
    staleTime: 5 * 60_000,
  });

export const statusQuery = () =>
  queryOptions({
    queryKey: keys.status,
    queryFn: () => api<SystemStatus>("/api/v1/system/status"),
    staleTime: 30_000,
  });

export const backupsQuery = () =>
  queryOptions({
    queryKey: keys.backups,
    queryFn: () => api<BackupList>("/api/v1/system/backups"),
    staleTime: 15_000,
  });

// ---- P4/P5: servers, packs, change sets and history (contracts C3 and C5) ----

export const p4keys = {
  servers: ["servers"] as const,
  server: (slug: string) => ["servers", slug] as const,
  settings: (slug: string) => ["servers", slug, "settings"] as const,
  rawFile: (slug: string, fileId: string) =>
    ["servers", slug, "files", fileId] as const,
  history: (slug: string) => ["servers", slug, "history"] as const,
  changeSet: (id: string) => ["change-sets", id] as const,
  games: ["games"] as const,
  settingsMeta: (packId: string) => ["games", packId, "settings-meta"] as const,
  instanceKey: ["connectors", "ssh-key"] as const,
  presets: ["presets"] as const,
};

/** The fleet wall; also the plan page's server list. */
export const serversQuery = () =>
  queryOptions({
    queryKey: p4keys.servers,
    queryFn: () => api<ServerList>("/api/v1/servers"),
    staleTime: 15_000,
  });

export const serverQuery = (slug: string) =>
  queryOptions({
    queryKey: p4keys.server(slug),
    queryFn: () => api<Server>(`/api/v1/servers/${slug}`),
    staleTime: 15_000,
  });

export const serverSettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: p4keys.settings(slug),
    queryFn: () => api<ServerSettings>(`/api/v1/servers/${slug}/settings`),
    staleTime: 10_000,
  });

export const rawFileQuery = (slug: string, fileId: string) =>
  queryOptions({
    queryKey: p4keys.rawFile(slug, fileId),
    queryFn: () => api<RawFile>(`/api/v1/servers/${slug}/files/${fileId}`),
    staleTime: 10_000,
  });

export const historyQuery = (slug: string) =>
  queryOptions({
    queryKey: p4keys.history(slug),
    queryFn: () => api<History>(`/api/v1/servers/${slug}/history`),
    staleTime: 10_000,
  });

export const changeSetQuery = (id: string) =>
  queryOptions({
    queryKey: p4keys.changeSet(id),
    queryFn: () => api<ChangeSet>(`/api/v1/change-sets/${id}`),
    staleTime: 0,
  });

export const gamesQuery = () =>
  queryOptions({
    queryKey: p4keys.games,
    queryFn: () => api<GameList>("/api/v1/games"),
    staleTime: 5 * 60_000,
  });

export const settingsMetaQuery = (packId: string) =>
  queryOptions({
    queryKey: p4keys.settingsMeta(packId),
    queryFn: () => api<SettingsMeta>(`/api/v1/games/${packId}/settings-meta`),
    staleTime: 5 * 60_000,
  });

/** This instance's public key, shown by the add-server wizard. */
export const instanceKeyQuery = () =>
  queryOptions({
    queryKey: p4keys.instanceKey,
    queryFn: () => api<InstanceKey>("/api/v1/connectors/ssh-key"),
    staleTime: 5 * 60_000,
  });

/**
 * The presets list (screen 7). P4 ships no endpoint for it: the page answers
 * the 404 with its designed state and the e2e preset flow skips.
 */
export const presetsQuery = () =>
  queryOptions({
    queryKey: p4keys.presets,
    queryFn: () => api<UserPresetList>("/api/v1/presets"),
    staleTime: 15_000,
    retry: false,
  });

// ---- P6: hooks, status, pending and activity (contracts C5, C6, C7) ----

export const p6keys = {
  hooks: (slug: string) => ["servers", slug, "hooks"] as const,
  status: (slug: string) => ["servers", slug, "status"] as const,
  pending: (slug: string) => ["servers", slug, "pending"] as const,
  activity: (type: ActivityType | null) => ["activity", type ?? "all"] as const,
};

/** The hook configuration and the actions it makes available. */
export const hooksQuery = (slug: string) =>
  queryOptions({
    queryKey: p6keys.hooks(slug),
    queryFn: () => api<HooksView>(`/api/v1/servers/${slug}/hooks`),
    staleTime: 15_000,
  });

/**
 * The probe answer of one server. A probe that cannot answer is not an
 * error worth retrying: the chip shows unknown and the next read asks again.
 */
export const serverStatusQuery = (slug: string) =>
  queryOptions({
    queryKey: p6keys.status(slug),
    queryFn: () => api<ServerStatus>(`/api/v1/servers/${slug}/status`),
    staleTime: 10_000,
    retry: false,
  });

/** The change sets of a server waiting for it to stop, oldest first. */
export const pendingQuery = (slug: string) =>
  queryOptions({
    queryKey: p6keys.pending(slug),
    queryFn: () => api<PendingList>(`/api/v1/servers/${slug}/pending`),
    staleTime: 10_000,
  });

/** One page of the activity feed; the Activity page chains them. */
export function fetchActivityPage(params: {
  readonly type: ActivityType | null;
  readonly before: number | null;
  readonly limit: number;
}): Promise<ActivityPage> {
  const search = new URLSearchParams({ limit: String(params.limit) });
  if (params.type !== null) {
    search.set("type", params.type);
  }
  if (params.before !== null) {
    search.set("before", String(params.before));
  }
  return api<ActivityPage>(`/api/v1/activity?${search.toString()}`);
}

// ---- P8: users, invitations, audit, tokens, OIDC and privacy (C1) ----
// Every key sits under a prefix of its own so the plan switch (licence page)
// can refresh what the entitlement changes without a reload.

export const p8keys = {
  users: ["users"] as const,
  user: (id: string) => ["users", id] as const,
  invitations: ["invitations"] as const,
  audit: (filters: AuditFilters) => ["audit", "list", filters] as const,
  auditVerify: ["audit", "verify"] as const,
  auditSettings: ["audit", "settings"] as const,
  tokens: ["tokens"] as const,
  oidc: ["oidc", "settings"] as const,
  oidcStatus: ["oidc", "status"] as const,
  snapshots: ["privacy", "snapshots"] as const,
};

/** The query prefixes whose answers depend on the plan (contract C1). */
export const PLAN_DEPENDENT_KEYS: readonly (readonly string[])[] = [
  p8keys.users,
  p8keys.invitations,
  ["audit"],
  p8keys.tokens,
  ["oidc"],
  ["servers"],
  ["schedules"],
  ["drift"],
  ["matrix"],
  ["reports"],
  ["notifications"],
];

/**
 * After a licence change: the users list (effective roles), the invitations
 * (402 on Free), the audit export, the tokens and the OIDC settings all
 * answer differently, so they are fetched again, without a reload.
 */
export function invalidatePlanDependent(client: QueryClient): void {
  for (const queryKey of PLAN_DEPENDENT_KEYS) {
    void client.invalidateQueries({ queryKey });
  }
}

/** The users with their stored and effective roles (owner and admins). */
export const usersQuery = () =>
  queryOptions({
    queryKey: p8keys.users,
    queryFn: () => api<UserList>("/api/v1/users"),
    staleTime: 15_000,
  });

export const userQuery = (id: string) =>
  queryOptions({
    queryKey: p8keys.user(id),
    queryFn: () => api<UserView>(`/api/v1/users/${id}`),
    staleTime: 15_000,
  });

/** Open invitations; Paid (team.users), so Free answers 402 (no retry). */
export const invitationsQuery = () =>
  queryOptions({
    queryKey: p8keys.invitations,
    queryFn: () => api<InvitationList>("/api/v1/invitations"),
    staleTime: 15_000,
    retry: false,
  });

export function auditSearch(
  filters: AuditFilters,
  before: number | null,
  limit: number,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") {
      search.set(key, value);
    }
  }
  if (before !== null) {
    search.set("before", String(before));
  }
  search.set("limit", String(limit));
  return search.toString();
}

/** One page of the audit log; the Audit page chains them. */
export function fetchAuditPage(params: {
  readonly filters: AuditFilters;
  readonly before: number | null;
  readonly limit: number;
}): Promise<AuditPage> {
  const search = auditSearch(params.filters, params.before, params.limit);
  return api<AuditPage>(`/api/v1/audit?${search}`);
}

/** The whole chain checked: valid, or broken at the first bad row. */
export const auditVerifyQuery = () =>
  queryOptions({
    queryKey: p8keys.auditVerify,
    queryFn: () => api<AuditVerify>("/api/v1/audit/verify"),
    staleTime: 10_000,
  });

export const auditSettingsQuery = () =>
  queryOptions({
    queryKey: p8keys.auditSettings,
    queryFn: () => api<AuditSettings>("/api/v1/settings/audit"),
    staleTime: 30_000,
  });

export const snapshotSettingsQuery = () =>
  queryOptions({
    queryKey: p8keys.snapshots,
    queryFn: () => api<SnapshotSettings>("/api/v1/settings/snapshots"),
    staleTime: 30_000,
  });

/** The signed-in user's own API tokens (every plan). */
export const tokensQuery = () =>
  queryOptions({
    queryKey: p8keys.tokens,
    queryFn: () => api<TokenList>("/api/v1/tokens"),
    staleTime: 15_000,
  });

/** The OIDC settings; Paid (oidc), so Free answers 402 (no retry). */
export const oidcSettingsQuery = () =>
  queryOptions({
    queryKey: p8keys.oidc,
    queryFn: () => api<OidcView>("/api/v1/settings/oidc"),
    staleTime: 30_000,
    retry: false,
  });

/** Whether the sign-in page offers single sign-on (public). */
export const oidcStatusQuery = () =>
  queryOptions({
    queryKey: p8keys.oidcStatus,
    queryFn: () => api<OidcStatus>("/api/v1/auth/oidc"),
    staleTime: 60_000,
    retry: false,
  });

// ---- P9: the Paid fleet layer (schedules, drift.background, fleet.matrix, ----
// ---- reports and notifications, contract C1). Every answer here is 402 on ----
// ---- Free, so nothing retries and the pages render the upgrade hint.      ----

export const p9keys = {
  schedules: (server: string | null) =>
    ["schedules", "list", server ?? "all"] as const,
  drift: ["drift"] as const,
  matrix: (game: string, group: string | null, servers: readonly string[]) =>
    ["matrix", game, group ?? "", servers.join(",")] as const,
  report: (selection: ReportSelection) => ["reports", selection] as const,
  channels: ["notifications", "channels"] as const,
  inbox: ["notifications", "inbox"] as const,
};

/** The schedules of the servers the user may see, or of one server. */
export const schedulesQuery = (server: string | null = null) =>
  queryOptions({
    queryKey: p9keys.schedules(server),
    queryFn: () =>
      api<ScheduleList>(
        server === null
          ? "/api/v1/schedules"
          : `/api/v1/schedules?server=${encodeURIComponent(server)}`,
      ),
    staleTime: 15_000,
    retry: false,
  });

/** The background drift checks of the visible servers. */
export const driftQuery = () =>
  queryOptions({
    queryKey: p9keys.drift,
    queryFn: () => api<DriftList>("/api/v1/drift"),
    staleTime: 15_000,
    retry: false,
  });

/** The query string of GET /api/v1/fleet/matrix. */
export function matrixSearch(
  game: string,
  group: string | null,
  servers: readonly string[],
): string {
  const search = new URLSearchParams({ game });
  if (group !== null && group !== "") {
    search.set("group", group);
  }
  if (servers.length > 0) {
    search.set("servers", servers.join(","));
  }
  return search.toString();
}

/** The settings of one game by its servers; empty servers means every one. */
export const matrixQuery = (
  game: string,
  group: string | null,
  servers: readonly string[],
) =>
  queryOptions({
    queryKey: p9keys.matrix(game, group, servers),
    queryFn: () =>
      api<Matrix>(`/api/v1/fleet/matrix?${matrixSearch(game, group, servers)}`),
    staleTime: 15_000,
    retry: false,
  });

/** The query string both report routes take. */
export function reportSearch(selection: ReportSelection): string {
  const search = new URLSearchParams();
  if (selection.changeSets !== undefined && selection.changeSets.length > 0) {
    search.set("changeSets", selection.changeSets.join(","));
  }
  if (selection.from !== undefined && selection.from !== "") {
    search.set("from", selection.from);
  }
  if (selection.to !== undefined && selection.to !== "") {
    search.set("to", selection.to);
  }
  if (selection.servers !== undefined && selection.servers.length > 0) {
    search.set("servers", selection.servers.join(","));
  }
  return search.toString();
}

/** The HTML print view of a report (opened in a new tab). */
export function reportPrintUrl(selection: ReportSelection): string {
  const search = reportSearch(selection);
  return `/api/v1/reports/changes/print${search === "" ? "" : `?${search}`}`;
}

/** The report data with its Markdown and Discord texts. */
export const reportQuery = (selection: ReportSelection) =>
  queryOptions({
    queryKey: p9keys.report(selection),
    queryFn: () => {
      const search = reportSearch(selection);
      return api<Report>(
        `/api/v1/reports/changes${search === "" ? "" : `?${search}`}`,
      );
    },
    staleTime: 0,
    retry: false,
  });

/** The notification channels (owner and admin). */
export const channelsQuery = () =>
  queryOptions({
    queryKey: p9keys.channels,
    queryFn: () => api<ChannelList>("/api/v1/notifications/channels"),
    staleTime: 15_000,
    retry: false,
  });

/** The first page of the in-app notifications and the unread count. */
export const inboxQuery = () =>
  queryOptions({
    queryKey: p9keys.inbox,
    queryFn: () => api<InboxPage>("/api/v1/notifications?limit=50"),
    staleTime: 30_000,
    retry: false,
  });
