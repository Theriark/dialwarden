// The writes of the P9 fleet layer (dev-work-plan P9-C): the bulk preset
// apply, schedules, the background drift check, the notification channels
// and the in-app read marker. Pure functions over api(); the pages own the
// query cache. Every route is Paid (contract C1): a 402 arrives as an
// ApiError whose paymentRequired body the pages render as the upgrade hint.
import { api } from "./client";
import type { RunHooks } from "./changes";
import type {
  BulkDraftList,
  BulkReport,
  ChannelInput,
  ChannelTestResult,
  ChannelView,
  DemoDriftRun,
  Drift,
  DriftInput,
  Schedule,
  ScheduleInput,
} from "./schema";

/** POST /api/v1/presets/:id/bulk-drafts: one draft per server, or its error. */
export function bulkDrafts(
  presetId: string,
  servers: readonly string[],
): Promise<BulkDraftList> {
  return api<BulkDraftList>(`/api/v1/presets/${presetId}/bulk-drafts`, {
    method: "POST",
    body: { servers },
  });
}

/** POST /api/v1/presets/bulk-apply: one apply per draft, never stopped by one failure. */
export function bulkApply(
  changeSets: readonly string[],
  runHooks: RunHooks,
): Promise<BulkReport> {
  return api<BulkReport>("/api/v1/presets/bulk-apply", {
    method: "POST",
    body: { changeSets, runHooks },
  });
}

/** POST /api/v1/schedules (write access on the server). */
export function createSchedule(input: ScheduleInput): Promise<Schedule> {
  return api<Schedule>("/api/v1/schedules", { method: "POST", body: input });
}

/** DELETE /api/v1/schedules/:id; a pending revert is dropped with it. */
export function deleteSchedule(id: string): Promise<void> {
  return api<unknown>(`/api/v1/schedules/${id}`, {
    method: "DELETE",
  }) as Promise<void>;
}

/** PUT /api/v1/servers/:slug/drift (owner or admin). */
export function setDrift(slug: string, input: DriftInput): Promise<Drift> {
  return api<Drift>(`/api/v1/servers/${slug}/drift`, {
    method: "PUT",
    body: input,
  });
}

/** POST /api/v1/servers/:slug/drift/check: a check now (read access). */
export function checkDrift(slug: string): Promise<Drift> {
  return api<Drift>(`/api/v1/servers/${slug}/drift/check`, {
    method: "POST",
  });
}

export function createChannel(input: ChannelInput): Promise<ChannelView> {
  return api<ChannelView>("/api/v1/notifications/channels", {
    method: "POST",
    body: input,
  });
}

export function updateChannel(
  id: string,
  input: ChannelInput,
): Promise<ChannelView> {
  return api<ChannelView>(`/api/v1/notifications/channels/${id}`, {
    method: "PUT",
    body: input,
  });
}

export function deleteChannel(id: string): Promise<void> {
  return api<unknown>(`/api/v1/notifications/channels/${id}`, {
    method: "DELETE",
  }) as Promise<void>;
}

/** Sends one test message now; the answer is ok or an error code. */
export function testChannel(id: string): Promise<ChannelTestResult> {
  return api<ChannelTestResult>(`/api/v1/notifications/channels/${id}/test`, {
    method: "POST",
  });
}

/** POST /api/v1/notifications/read: the own read marker. */
export function markInboxRead(upTo: number): Promise<{ unread: number }> {
  return api<{ unread: number }>("/api/v1/notifications/read", {
    method: "POST",
    body: { upTo },
  });
}

/** POST /api/v1/system/demo-drift/run (owner; 404 without DEMO_SEED). */
export function runDemoDrift(): Promise<DemoDriftRun> {
  return api<DemoDriftRun>("/api/v1/system/demo-drift/run", {
    method: "POST",
  });
}
