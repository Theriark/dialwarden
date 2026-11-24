// The writes of contract C5 (change sets, apply, restore) and of the add
// server wizard (connectors). Pure functions over api(); the pages own the
// query cache.
import { api } from "./client";
import type {
  ChangeSet,
  ConnectionSpec,
  Detection,
  EditableServers,
  PinnedHostKey,
  Server,
  TestResult,
  UserPreset,
  UserPresetList,
} from "./schema";

/** One typed edit of the change-set body. */
export interface EditInput {
  readonly settingKey: string;
  readonly value: unknown;
}

/** One raw text patch of the change-set body. */
export interface PatchInput {
  readonly fileId: string;
  readonly text: string;
}

export type RunHooks = "none" | "restart" | "stop-start";

/** POST /api/v1/servers/:slug/change-sets: the draft a save creates. */
export function createChangeSet(
  slug: string,
  body: { edits?: readonly EditInput[]; patches?: readonly PatchInput[] },
): Promise<ChangeSet> {
  return api<ChangeSet>(`/api/v1/servers/${slug}/change-sets`, {
    method: "POST",
    body,
  });
}

export function getChangeSet(id: string): Promise<ChangeSet> {
  return api<ChangeSet>(`/api/v1/change-sets/${id}`);
}

/**
 * POST /api/v1/change-sets/:id/apply. Hooks arrive with P6 (the server
 * answers hooks_not_available for anything but "none" until then).
 */
export function applyChangeSet(
  id: string,
  runHooks: RunHooks = "none",
): Promise<ChangeSet> {
  return api<ChangeSet>(`/api/v1/change-sets/${id}/apply`, {
    method: "POST",
    body: { runHooks },
  });
}

/** POST /api/v1/snapshots/:id/restore: a rollback change set. */
export function restoreSnapshot(snapshotId: string): Promise<ChangeSet> {
  return api<ChangeSet>(`/api/v1/snapshots/${snapshotId}/restore`, {
    method: "POST",
  });
}

export interface CreateServerBody {
  readonly name: string;
  readonly id?: string;
  readonly packId?: string;
  readonly os?: "linux" | "windows";
  readonly connector: ConnectionSpec;
}

export function addServer(body: CreateServerBody): Promise<Server> {
  return api<Server>("/api/v1/servers", { method: "POST", body });
}

export function removeServer(slug: string): Promise<void> {
  return api<unknown>(`/api/v1/servers/${slug}`, {
    method: "DELETE",
  }) as Promise<void>;
}

/** POST /api/v1/connectors/test: the connection test of the wizard. */
export function testConnection(spec: ConnectionSpec): Promise<TestResult> {
  return api<TestResult>("/api/v1/connectors/test", {
    method: "POST",
    body: spec,
  });
}

export function confirmHostKey(
  host: string,
  port: number,
  fingerprint: string,
  replace = false,
): Promise<PinnedHostKey> {
  return api<PinnedHostKey>("/api/v1/connectors/host-keys", {
    method: "POST",
    body: { host, port, fingerprint, replace },
  });
}

/** POST /api/v1/connectors/detect: the wizard's game detection. */
export interface DetectionList {
  readonly items: readonly Detection[];
}

export function detectGames(spec: ConnectionSpec): Promise<DetectionList> {
  return api<DetectionList>("/api/v1/connectors/detect", {
    method: "POST",
    body: spec,
  });
}

/** PUT /api/v1/plan/editable-servers: the owner's three on Free (screen 8). */
export function chooseEditableServers(
  servers: readonly string[],
): Promise<EditableServers> {
  return api<EditableServers>("/api/v1/plan/editable-servers", {
    method: "PUT",
    body: { servers },
  });
}

// ---- User presets (screen 7). No P4 endpoint ships these; the shapes are ----
// ---- the contract Delivery hands the small Backend task.                 ----

export function listPresets(): Promise<UserPresetList> {
  return api<UserPresetList>("/api/v1/presets");
}

export function createPreset(body: {
  readonly name: string;
  readonly description: string;
  readonly packId: string;
  readonly values: Readonly<Record<string, unknown>>;
}): Promise<UserPreset> {
  return api<UserPreset>("/api/v1/presets", { method: "POST", body });
}

export function deletePreset(id: string): Promise<void> {
  return api<unknown>(`/api/v1/presets/${id}`, {
    method: "DELETE",
  }) as Promise<void>;
}

export function applyPreset(id: string, server: string): Promise<ChangeSet> {
  return api<ChangeSet>(`/api/v1/presets/${id}/apply`, {
    method: "POST",
    body: { server },
  });
}
