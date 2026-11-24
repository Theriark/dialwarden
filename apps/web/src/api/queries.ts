// TanStack Query definitions for the P1-B screens. Keys are grouped so a
// sign-in or a licence change can invalidate what depends on it.
import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, setCsrf } from "./client";
import type {
  ActivityPage,
  ActivityType,
  BackupList,
  ChangeSet,
  EditableServers,
  Entitlement,
  GameList,
  Health,
  History,
  HooksView,
  InstanceKey,
  PendingList,
  RawFile,
  Registry,
  Server,
  ServerList,
  ServerSettings,
  ServerStatus,
  SettingsMeta,
  SetupStatus,
  SignedIn,
  SystemStatus,
  UserPresetList,
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
