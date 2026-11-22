// TanStack Query definitions for the P1-B screens. Keys are grouped so a
// sign-in or a licence change can invalidate what depends on it.
import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, setCsrf } from "./client";
import type {
  BackupList,
  EditableServers,
  Entitlement,
  Health,
  Registry,
  SetupStatus,
  SignedIn,
  SystemStatus,
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
