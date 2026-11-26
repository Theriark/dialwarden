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

/**
 * What the caller may do with a server, from the per-server grant of the
 * moment (P10-A L22): the owner and admins write everywhere, an editor
 * writes where a write grant says so, a viewer reads.
 */
export type ServerAccess = "read" | "write";

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
  readonly access: ServerAccess;
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
  readonly access: ServerAccess;
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

// ---- P8: users, roles and grants, invitations, audit, OIDC, API tokens ----
// ---- and privacy. The shapes the P8-A server declares in apps/server/ ----
// ---- src/routes/users.ts, invitations.ts, audit.ts, api-access.ts,    ----
// ---- oidc.ts and retention.ts at b3a19ef. Field names are exact.      ----

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;

export type Role = (typeof ROLES)[number];

/** The roles an invitation, a role change or an API token may carry. */
export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const GRANT_LEVELS = ["read", "write"] as const;

export type GrantLevel = (typeof GRANT_LEVELS)[number];

/** One per-server grant of an editor or a viewer. */
export interface Grant {
  readonly server: string;
  readonly level: GrantLevel;
}

/** GET /api/v1/users items and the answer of every user write. */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** The stored role. */
  readonly role: Role;
  /** The role the user acts with now: viewer on the Free fallback. */
  readonly effectiveRole: Role;
  readonly totpEnabled: boolean;
  /** True for a user who signs in through the identity provider. */
  readonly sso: boolean;
  /** False when the account has no usable local password. */
  readonly localPassword: boolean;
  readonly createdAt: string;
  readonly grants: readonly Grant[];
}

export interface UserList {
  readonly items: readonly UserView[];
}

/** POST /api/v1/users/:id/password-reset (201): the link, shown once. */
export interface NewLink {
  readonly token: string;
  readonly link: string;
  readonly expiresAt: string;
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: AssignableRole;
  readonly grants: readonly Grant[];
  readonly invitedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface InvitationList {
  readonly items: readonly InvitationView[];
}

/** POST /api/v1/invitations (201): the invitation plus its link, once. */
export interface NewInvitation extends InvitationView {
  readonly token: string;
  readonly link: string;
}

export interface InvitationInput {
  readonly email: string;
  readonly role: AssignableRole;
  readonly grants: readonly Grant[];
}

/** POST /api/v1/invitations/accept and /api/v1/auth/password-reset. */
export interface AcceptInvitationBody {
  readonly token: string;
  readonly name: string;
  readonly password: string;
}

export interface PasswordResetBody {
  readonly token: string;
  readonly password: string;
}

/** GET /api/v1/tokens items; the value is in the POST answer only. */
export interface TokenView {
  readonly id: string;
  readonly name: string;
  readonly role: AssignableRole;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface TokenList {
  readonly items: readonly TokenView[];
}

export interface NewToken extends TokenView {
  readonly token: string;
}

export interface AuditActor {
  readonly id: string;
  readonly label: string;
  readonly erased: boolean;
}

/** One row of GET /api/v1/audit. */
export interface AuditEntry {
  readonly id: number;
  readonly at: string;
  readonly actor: AuditActor;
  /** The method and route pattern, such as PUT /api/v1/users/:id/role. */
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly serverId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly ip: string | null;
}

export interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly nextBefore: number | null;
}

/** The filters of GET /api/v1/audit and of the CSV export. */
export interface AuditFilters {
  readonly actorId?: string;
  readonly action?: string;
  readonly serverId?: string;
  readonly from?: string;
  readonly to?: string;
}

/** GET /api/v1/audit/verify: the whole chain checked. */
export type AuditVerify =
  | { readonly valid: true; readonly count: number; readonly headHash: string }
  | {
      readonly valid: false;
      readonly firstBrokenId: number | null;
      readonly reason: string;
    };

export const IP_MODES = ["full", "truncated", "none"] as const;

export type IpMode = (typeof IP_MODES)[number];

/** GET and PUT /api/v1/settings/audit (every plan). */
export interface AuditSettings {
  readonly ipMode: IpMode;
  /** Rows older than this are removed by the daily job; null keeps all. */
  readonly retentionDays: number | null;
}

export const RETENTION_MODES = ["all", "days", "versions"] as const;

export type RetentionMode = (typeof RETENTION_MODES)[number];

export interface SnapshotRetention {
  readonly mode: RetentionMode;
  readonly days: number | null;
  readonly versions: number | null;
}

/** GET and PUT /api/v1/settings/snapshots (every plan). */
export interface SnapshotSettings {
  readonly snapshotRetention: SnapshotRetention;
}

/** GET /api/v1/settings/oidc (owner, Paid). */
export interface OidcView {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly issuer: string | null;
  readonly clientId: string | null;
  readonly hasClientSecret: boolean;
  readonly scope: string;
  readonly groupsClaim: string;
  readonly roleMapping: Readonly<Record<string, string>>;
  readonly allowPrivateNetwork: boolean;
  readonly redirectUri: string | null;
}

/** PUT /api/v1/settings/oidc: clientSecret left out keeps the stored one. */
export interface OidcInput {
  readonly enabled: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scope?: string;
  readonly groupsClaim?: string;
  readonly roleMapping: Readonly<Record<string, AssignableRole>>;
  readonly allowPrivateNetwork: boolean;
}

/** GET /api/v1/auth/oidc (public): whether the sign-in page offers it. */
export interface OidcStatus {
  readonly enabled: boolean;
}

// ---- P9: bulk presets, schedules, drift, the matrix, reports and the ----
// ---- notification channels. The shapes the P9-A and P9-B server       ----
// ---- declares in apps/server/src/routes/presets.ts, schedules.ts,     ----
// ---- drift.ts, fleet.ts, reports.ts and notifications.ts at 474ef7c.  ----
// ---- Field names are exact; every route is Paid (contract C1).        ----

/** The error of one item of a bulk answer: a code and whatever it adds. */
export interface BulkFailure {
  readonly code: string;
  readonly message?: string;
  readonly [field: string]: unknown;
}

/** One item of POST /api/v1/presets/:id/bulk-drafts. */
export interface BulkDraftItem {
  readonly server: string;
  readonly changeSet: ChangeSet | null;
  readonly error: BulkFailure | null;
}

export interface BulkDraftList {
  readonly items: readonly BulkDraftItem[];
}

export type BulkItemStatus = ChangeSetStatus | "refused";

/** One item of POST /api/v1/presets/bulk-apply. */
export interface BulkReportItem {
  readonly changeSetId: string;
  readonly server: string | null;
  readonly status: BulkItemStatus;
  readonly error: BulkFailure | null;
}

export interface BulkReport {
  readonly items: readonly BulkReportItem[];
  readonly applied: number;
  readonly pending: number;
  readonly failed: number;
}

export const SCHEDULE_STATES = ["active", "paused", "done", "missed"] as const;

export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export const RUN_RESULTS = [
  "applied",
  "pending",
  "conflict",
  "failed",
  "no_change",
  "missed",
] as const;

export type RunResult = (typeof RUN_RESULTS)[number];

export type ScheduleKind = "once" | "cron";

export interface ScheduleEdit {
  readonly settingKey: string;
  /** The value; the secret mask for a secret setting. */
  readonly value: unknown;
}

/** One schedule as GET /api/v1/schedules answers it. */
export interface Schedule {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly author: string;
  readonly kind: ScheduleKind;
  readonly runAt: string | null;
  readonly cron: string | null;
  readonly timezone: string;
  readonly revertAt: string | null;
  readonly revertAfterMinutes: number | null;
  readonly runHooks: "none" | "restart" | "stop-start";
  readonly edits: readonly ScheduleEdit[];
  readonly state: ScheduleState;
  /** paid while the Free plan pauses it, else null. */
  readonly pausedReason: "paid" | null;
  readonly nextRunAt: string | null;
  readonly revertDueAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastResult: RunResult | null;
  readonly lastChangeSetId: string | null;
  readonly lastRevertAt: string | null;
  readonly lastRevertResult: RunResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleList {
  readonly items: readonly Schedule[];
}

/** POST /api/v1/schedules: runAt or cron, never both. */
export interface ScheduleInput {
  readonly server: string;
  readonly name: string;
  readonly edits: readonly ScheduleEdit[];
  readonly runHooks: "none" | "restart" | "stop-start";
  readonly runAt?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly revertAt?: string;
  readonly revertAfterMinutes?: number;
}

export type DriftResult = "clean" | "drift" | "error";

/** The background check of one server (GET /api/v1/drift items). */
export interface Drift {
  readonly serverId: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly lastCheckedAt: string | null;
  readonly lastResult: DriftResult | null;
  readonly lastError: string | null;
  readonly lastChangeSetId: string | null;
  readonly nextCheckAt: string | null;
}

export interface DriftList {
  readonly items: readonly Drift[];
}

/** PUT /api/v1/servers/:slug/drift (owner or admin). */
export interface DriftInput {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

export const DRIFT_INTERVAL = { min: 5, max: 1440, default: 15 } as const;

export interface MatrixServer {
  readonly id: string;
  readonly name: string;
  readonly editable: boolean;
  /** A connector error; the column holds no values then. */
  readonly error: string | null;
}

export interface MatrixRow {
  readonly key: string;
  readonly label: string;
  readonly group: string | null;
  readonly secret: boolean;
  readonly values: Readonly<Record<string, unknown>>;
  readonly differs: boolean;
}

/** GET /api/v1/fleet/matrix: the settings of one game by its servers. */
export interface Matrix {
  readonly packId: string;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly group: string | null;
  readonly servers: readonly MatrixServer[];
  readonly rows: readonly MatrixRow[];
  readonly differing: number;
}

export interface ReportEntry {
  readonly changeSetId: string;
  readonly at: string;
  readonly author: string;
  readonly cause: string;
  readonly status: string;
  /** The chips as text, secrets redacted. */
  readonly chips: readonly string[];
}

export interface ReportServer {
  readonly id: string;
  readonly name: string;
  readonly game: string;
  readonly entries: readonly ReportEntry[];
}

/** GET /api/v1/reports/changes. */
export interface Report {
  readonly generatedAt: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly servers: readonly ReportServer[];
  readonly entryCount: number;
  readonly truncated: boolean;
  readonly markdown: string;
  readonly discord: { readonly content: string };
}

/** The query of both report routes: change sets or a range, and servers. */
export interface ReportSelection {
  readonly changeSets?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly servers?: readonly string[];
}

export const CHANNEL_KINDS = ["in_app", "webhook", "discord", "smtp"] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type SmtpSecurity = "starttls" | "tls";

/**
 * The settings of a channel as sent. On an update an omitted url keeps the
 * stored one; an omitted signingSecret or password keeps the stored one and
 * null removes it.
 */
export type ChannelSettingsInput =
  | { readonly kind: "in_app" }
  | {
      readonly kind: "webhook";
      readonly url?: string;
      readonly signingSecret?: string | null;
      readonly allowPrivateHost: boolean;
    }
  | {
      readonly kind: "discord";
      readonly url?: string;
      readonly allowPrivateHost: boolean;
    }
  | {
      readonly kind: "smtp";
      readonly host: string;
      readonly port: number;
      readonly security: SmtpSecurity;
      readonly username: string | null;
      readonly password?: string | null;
      readonly from: string;
      readonly to: readonly string[];
      readonly allowPrivateHost: boolean;
    };

export interface ChannelInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly types: readonly ActivityType[];
  readonly settings: ChannelSettingsInput;
}

/** The settings as answered: the URL masked, secrets as a yes or no. */
export type ChannelSettingsView =
  | { readonly kind: "in_app" }
  | {
      readonly kind: "webhook";
      readonly url: string;
      readonly host: string;
      readonly hasSigningSecret: boolean;
      readonly allowPrivateHost: boolean;
    }
  | {
      readonly kind: "discord";
      readonly url: string;
      readonly host: string;
      readonly allowPrivateHost: boolean;
    }
  | {
      readonly kind: "smtp";
      readonly host: string;
      readonly port: number;
      readonly security: SmtpSecurity;
      readonly username: string | null;
      readonly hasPassword: boolean;
      readonly from: string;
      readonly to: readonly string[];
      readonly allowPrivateHost: boolean;
    };

export interface ChannelView {
  readonly id: string;
  readonly name: string;
  readonly kind: ChannelKind;
  readonly enabled: boolean;
  readonly types: readonly ActivityType[];
  readonly settings: ChannelSettingsView;
  readonly lastDeliveryAt: string | null;
  readonly lastResult: "ok" | "failed" | null;
  /** An error code only, never a server answer or an address. */
  readonly lastError: string | null;
  readonly failures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelList {
  readonly items: readonly ChannelView[];
}

/** POST /api/v1/notifications/channels/:id/test. */
export interface ChannelTestResult {
  readonly ok: boolean;
  readonly error: string | null;
}

export interface InboxItem {
  readonly id: number;
  readonly type: ActivityType | "test";
  readonly serverId: string | null;
  readonly at: string;
  readonly title: string;
  readonly lines: readonly string[];
}

/** GET /api/v1/notifications: the in-app rows this user may see. */
export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly unread: number;
  readonly nextBefore: number | null;
}

/** POST /api/v1/system/demo-drift/run (owner, DEMO_SEED only). */
export interface DemoDriftRun {
  readonly serverId: string;
  readonly changeSetId: string;
  readonly line: string;
}
