// Shapes of the Dialwarden API as the P1-A server declares them
// (apps/server/src/http/schemas.ts and routes/*.ts at commit 1cd7a85). The
// field names of the entitlement and of the 402 body are contract C1 and are
// exact. The server prints its OpenAPI 3.1 document with
// `pnpm --filter @dialwarden/server openapi`; these types mirror that document
// by hand because the web build cannot start the server in CI. A later task may
// replace this file with generated output; the names must not change.

export const FEATURE_KEYS = [
  "presets.bulk",
  "schedules",
  "drift.background",
  "notifications",
  "team.users",
  "team.roles",
  "audit",
  "oidc",
  "apiTokens",
  "fleet.matrix",
  "reports",
  "assistant",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const LIMIT_KEYS = [
  "servers",
  "users",
  "historyVisible",
  "presets",
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LICENCE_STATES = [
  "active",
  "term_ended_for_this_version",
  "revoked",
  "invalid_signature",
  "malformed",
  "dev_window_passed",
  "none",
] as const;

export type LicenceState = (typeof LICENCE_STATES)[number];

export type Plan = "free" | "paid";
export type LicenceSource = "none" | "ui" | "environment";
export type LicenceKind = "customer" | "internal-dev";

export interface LicenceSummary {
  lidHash8: string | null;
  last6: string;
  customerName: string | null;
  kind: LicenceKind | null;
  issuedAt: string | null;
  updatesUntil: string | null;
  warn30: boolean;
}

/** GET /api/v1/entitlement (contract C1). */
export interface Entitlement {
  plan: Plan;
  state: LicenceState;
  source: LicenceSource;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  licence: LicenceSummary | null;
  envLicence: {
    present: boolean;
    state: LicenceState;
    ignored: boolean;
  };
  buildDate: string | null;
  featureBaseline: string | null;
}

/** The body of every 402 answer (contract C1). */
export interface PaymentRequiredBody {
  error: "payment_required";
  plan: "free";
  feature?: string;
  limit?: string;
  current?: number;
  max?: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  totpEnabled: boolean;
}

export interface SignedIn {
  status: "ok";
  user: User;
  csrfToken: string;
}

export interface TotpRequired {
  status: "totp_required";
  challenge: string;
}

export type LoginResponse = SignedIn | TotpRequired;

export interface SetupStatus {
  required: boolean;
}

export interface ImportResult {
  status: "imported";
  createdAt: string;
  reencrypted: number;
}

export interface TotpEnrolment {
  secret: string;
  otpauthUri: string;
}

export interface RecoveryCodes {
  recoveryCodes: string[];
}

/** GET /healthz (public). */
export interface Health {
  status: "ok";
  version: string;
  revision: string;
  buildDate: string | null;
  featureBaseline: string | null;
  plan: Plan;
}

/** GET /api/v1/plan/registry: the Free versus Paid list for About. */
export interface Registry {
  features: { key: string; label: string; available: boolean }[];
  limits: {
    key: string;
    label: string;
    free: number;
    paid: number | null | "licence";
  }[];
  alwaysFree: string[];
}

/** GET /api/v1/plan/editable-servers: the servers editable on Free. */
export interface EditableServers {
  servers: string[];
  chosen: string[];
  max: number;
}

/** GET /api/v1/system/status (owner). */
export interface SystemStatus {
  version: string;
  revision: string;
  buildDate: string | null;
  featureBaseline: string | null;
  appSecret: {
    source: "environment" | "file";
    keyId: string;
    backupAcknowledged: boolean;
    showBackupBanner: boolean;
  };
  backups: {
    running: boolean;
    schedule: string;
    timezone: string;
  };
}

export interface BackupItem {
  id: string;
  createdAt: string | null;
  sizeBytes: number;
  blobCount: number;
  appVersion: string | null;
  integrity: "ok" | "incomplete";
}

export interface BackupList {
  items: BackupItem[];
}

export interface DrillCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DrillReport {
  backupId: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  checks: DrillCheck[];
}

/** Every error body carries an error code; details vary by code. */
export interface ApiErrorBody {
  error: string;
  reason?: string;
  retryAfter?: number;
  issues?: { path: string; message: string }[];
  feature?: string;
  limit?: string;
  current?: number;
  max?: number;
}

// ---- P4: servers, connectors, change sets and history (contract C5) ----
// The shapes the P4 server declares in apps/server/src/routes/servers.ts,
// changes.ts, connectors.ts and games.ts at 1c8cbf8. Field names are exact.

export type Os = "linux" | "windows";

/** The connection spec of a server (contract C4); a password only on panel SFTP. */
export interface LocalSpec {
  readonly kind: "local";
  readonly root: string;
}

export interface SftpSpec {
  readonly kind: "sftp";
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly panel: boolean;
  readonly password?: string;
}

export type ConnectionSpec = LocalSpec | SftpSpec;

/** A stored spec: the server never returns the password it stores. */
export type StoredSpec =
  | { readonly kind: "local"; readonly root: string }
  | {
      readonly kind: "sftp";
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly root: string;
      readonly panel: boolean;
    };

export interface Server {
  readonly id: string;
  readonly name: string;
  readonly packId: string;
  readonly displayName: string;
  readonly os: Os;
  readonly connector: StoredSpec;
  readonly hasPassword: boolean;
  readonly demo: boolean;
  /** False for a server beyond the editable three on Free (read-only). */
  readonly editable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEditedAt: string | null;
}

export interface ServerList {
  readonly items: readonly Server[];
}

/** The answer of a connector test (contract C4). */
export interface TestResult {
  readonly ok: boolean;
  readonly root: string | null;
  readonly hostKey?: HostKeyState;
  readonly error?:
    | "PathEscape"
    | "HostKeyChanged"
    | "HashMismatch"
    | "Connection"
    | "NotFound";
  readonly message?: string;
}

export interface HostKeyState {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly status: "pinned" | "unpinned" | "changed";
}

export interface PinnedHostKey {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly confirmedAt: string;
}

/** GET /api/v1/connectors/ssh-key: this instance's public key. */
export interface InstanceKey {
  readonly algorithm: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface Detection {
  readonly packId: string;
  readonly displayName: string;
  readonly by: "appmanifest" | "markers";
  readonly os: Os | null;
  readonly buildId: number | null;
  readonly buildSupported: boolean;
  readonly warnings: readonly string[];
}

export const CHANGE_SET_STATUSES = [
  "draft",
  "pending",
  "applied",
  "conflict",
  "failed",
  "scheduled",
  "reverted",
] as const;

export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

export const CAUSES = [
  "app",
  "external",
  "rollback",
  "schedule",
  "preset",
  "import",
] as const;

export type Cause = (typeof CAUSES)[number];

export const CHIP_KINDS = [
  "changed",
  "added",
  "removed",
  "masked",
  "lines",
  "external",
  "import",
] as const;

export type ChipKind = (typeof CHIP_KINDS)[number];

/** One chip of the semantic diff (contract C5 semantic[]). */
export interface Chip {
  readonly kind: ChipKind;
  readonly fileId: string;
  readonly settingKey: string | null;
  readonly label: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly restartRequired: boolean;
}

export const LINT_SEVERITIES = ["error", "warning", "info"] as const;
export type LintSeverity = (typeof LINT_SEVERITIES)[number];

export interface LintEntry {
  readonly fileId: string | null;
  readonly settingKey: string | null;
  readonly code: string;
  readonly severity: LintSeverity;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly serverEvaluated: boolean;
}

export interface TextDiffPart {
  readonly fileId: string;
  readonly unifiedDiff: string;
}

export interface ConflictSetting {
  readonly settingKey: string;
  readonly label: string;
  readonly base: unknown;
  readonly ours: unknown;
  readonly theirs: unknown;
}

export type ConflictFile =
  | {
      readonly kind: "settings";
      readonly fileId: string;
      readonly settings: readonly ConflictSetting[];
    }
  | {
      readonly kind: "text";
      readonly fileId: string;
      readonly conflicts: number;
      readonly ours: string;
      readonly theirs: string;
    };

export interface ConflictView {
  readonly files: readonly ConflictFile[];
}

/** One change set (contract C5): the draft a save creates, apply and restore. */
export interface ChangeSet {
  readonly id: string;
  readonly serverId: string;
  readonly status: ChangeSetStatus;
  readonly cause: Cause;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
  readonly restoreOf: string | null;
  readonly diff: {
    readonly semantic: readonly Chip[];
    readonly text: readonly TextDiffPart[];
  };
  readonly lint: readonly LintEntry[];
  readonly conflict: ConflictView | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface HistorySnapshot {
  readonly id: string;
  readonly fileId: string;
  readonly kind: string;
  readonly at: string;
}

export interface HistoryEntry {
  readonly changeSetId: string;
  readonly at: string;
  readonly author: string;
  readonly cause: Cause;
  readonly status: ChangeSetStatus;
  readonly chips: readonly Chip[];
  readonly snapshots: readonly HistorySnapshot[];
}

/** GET /api/v1/servers/:slug/history (contract C5). */
export interface History {
  readonly entries: readonly HistoryEntry[];
  readonly visibleLimit: number | null;
  readonly hiddenCount: number;
}

export interface SettingsFile {
  readonly fileId: string;
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
}

/** GET /api/v1/servers/:slug/settings: typed values of every file. */
export interface ServerSettings {
  readonly serverId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly editable: boolean;
  readonly files: readonly SettingsFile[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly lint: readonly LintEntry[];
}

/** GET /api/v1/servers/:slug/files/:fileId: one raw file (owner only). */
export interface RawFile {
  readonly fileId: string;
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly text: string;
  readonly lint: readonly LintEntry[];
}

export interface GameSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
}

export interface GameList {
  readonly items: readonly GameSummary[];
}

/**
 * GET /api/v1/games/:id/settings-meta (contract C3). files, settings, rules
 * and presets arrive as JSON records; the editor casts them to the
 * @dialwarden/packs-schema types, which run in the browser unchanged.
 */
export interface SettingsMeta {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly steamAppId: number;
  readonly os: readonly Os[];
  readonly files: readonly unknown[];
  readonly settings: readonly unknown[];
  readonly rules: readonly unknown[];
  readonly presets: readonly unknown[];
  readonly hooksSupported: readonly string[];
  readonly sources: readonly string[];
}

// ---- User presets (screen 7): the shapes the Presets screen is built ----
// ---- against. P4 ships no endpoints for them; Delivery opens the small ----
// ---- Backend task, and this file is the contract for it.              ----

export interface UserPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly packId: string;
  readonly createdAt: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface UserPresetList {
  readonly items: readonly UserPreset[];
}

export interface CreatePresetBody {
  readonly name: string;
  readonly description: string;
  readonly packId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** POST /api/v1/presets/:id/apply { server }: a change set of cause preset. */
export interface ApplyPresetBody {
  readonly server: string;
}

// ---- P6: hooks, status, pending and activity (contracts C5, C6 and C7) ----
// The shapes the P6-A and P6-B server declares in apps/server/src/routes/
// hooks.ts, servers.ts and activity.ts at 2641ff7. Field names are exact.

export const HOOK_ACTIONS = ["save", "stop", "start", "restart"] as const;

export type HookAction = (typeof HOOK_ACTIONS)[number];

/** The per-server hook of contract C7: an SSH command or a docker proxy. */
export type HookConfig =
  | { readonly kind: "sshCommand"; readonly command: string }
  | {
      readonly kind: "dockerProxy";
      readonly url: string;
      readonly containerLabel: string;
    };

/** One probe of the pack with its per-server override; no password ever. */
export interface ProbeOverrideView {
  readonly kind: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly hasPassword: boolean;
}

/** The client kind that runs each action today, or null when none can. */
export type HookActions = Readonly<Record<HookAction, string | null>>;

/** GET and PUT /api/v1/servers/:slug/hooks. */
export interface HooksView {
  readonly packId: string;
  readonly hooksSupported: readonly string[];
  readonly hook: HookConfig | null;
  readonly probes: readonly ProbeOverrideView[];
  readonly available: HookActions;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface ProbeInput {
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
}

/** PUT body: a missing hook keeps the current one, null clears it. */
export interface PutHooksBody {
  readonly hook?: HookConfig | null;
  readonly probes?: Readonly<Record<string, ProbeInput | null>>;
}

/** POST /api/v1/servers/:slug/hooks/run. */
export interface RunAnswer {
  readonly action: HookAction;
  readonly source: string;
  readonly at: string;
  /** Set for a stop only: whether the probe saw the server down. */
  readonly stopped: boolean | null;
  /** Set for a stop only: the pending change sets written after it. */
  readonly flushed: number | null;
}

export type ServerState = "running" | "stopped" | "unknown";

/** GET /api/v1/servers/:slug/status: the probe answer and the pending count. */
export interface ServerStatus {
  readonly state: ServerState;
  readonly players: number | null;
  /** The probe kind that answered, or null when no probe exists. */
  readonly source: string | null;
  readonly at: string;
  readonly pending: number;
}

/** GET /api/v1/servers/:slug/pending: the change sets waiting for a stop. */
export interface PendingList {
  readonly items: readonly ChangeSet[];
}

export const ACTIVITY_TYPES = [
  "change.applied",
  "change.pending",
  "change.conflict",
  "hook.run",
  "drift.detected",
  "schedule.run",
  "schedule.reverted",
  "backup.done",
  "backup.failed",
  "licence.changed",
  "user.changed",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** One event of contract C6. */
export interface ActivityEvent {
  readonly id: number;
  readonly type: ActivityType;
  readonly serverId: string | null;
  readonly at: string;
  /** "system" or the e-mail of the user who acted. */
  readonly actor: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** GET /api/v1/activity, newest first; nextBefore pages onwards. */
export interface ActivityPage {
  readonly items: readonly ActivityEvent[];
  readonly nextBefore: number | null;
}
