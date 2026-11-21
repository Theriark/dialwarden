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
