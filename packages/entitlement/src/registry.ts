// The feature registry (contract C1). LICENSING.md names every feature and limit
// marked Paid here as the protected functionality of FCL-1.0-MIT.
//
// Every later phase registers its Paid features and limits here before it
// writes them. A Paid route declares config.entitlement with its FeatureKey and
// is listed under routes below; every other API route is listed in
// ALWAYS_FREE_ROUTES. The registry test in apps/server fails when a listed
// route lacks the declaration, when an API route is in neither list (so a
// Paid route cannot be forgotten silently), and checks that every declared
// route answers 402 on the Free plan.

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

/** Limit values; null means unlimited. */
export type Limits = Record<LimitKey, number | null>;

export interface FeatureDefinition {
  key: FeatureKey;
  /** Plain words for the upgrade hint and the About page. */
  label: string;
  /** False for a reserved key that no build enables yet. */
  available: boolean;
  /** Paid routes of this feature, as "METHOD /path" (filled by later phases). */
  routes: readonly string[];
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    key: "presets.bulk",
    label: "Apply presets to many servers at once",
    available: true,
    routes: [],
  },
  {
    key: "schedules",
    label: "Scheduled changes",
    available: true,
    routes: [],
  },
  {
    key: "drift.background",
    label: "Background drift checks",
    available: true,
    routes: [],
  },
  {
    key: "notifications",
    label: "Notification channels",
    available: true,
    routes: [],
  },
  {
    key: "team.users",
    label: "More than one user",
    available: true,
    routes: ["POST /api/v1/invitations", "GET /api/v1/invitations"],
  },
  {
    key: "team.roles",
    label: "User roles and per-server grants",
    available: true,
    routes: ["PUT /api/v1/users/:id/role", "PUT /api/v1/users/:id/grants"],
  },
  {
    key: "audit",
    label: "Audit log CSV export",
    available: true,
    routes: ["GET /api/v1/audit/export.csv"],
  },
  {
    key: "oidc",
    label: "Single sign-on (OIDC)",
    available: true,
    routes: ["GET /api/v1/settings/oidc", "PUT /api/v1/settings/oidc"],
  },
  {
    key: "apiTokens",
    label: "API tokens",
    available: true,
    routes: ["POST /api/v1/tokens"],
  },
  {
    key: "fleet.matrix",
    label: "Fleet settings matrix",
    available: true,
    routes: [],
  },
  { key: "reports", label: "Reports", available: true, routes: [] },
  {
    key: "assistant",
    label: "Settings assistant (not in this version)",
    available: false,
    routes: [],
  },
];

export interface LimitDefinition {
  key: LimitKey;
  label: string;
  free: number;
  /** Paid value; null means unlimited, "licence" means the licence maxServers. */
  paid: number | null | "licence";
}

export const LIMITS: readonly LimitDefinition[] = [
  { key: "servers", label: "Editable servers", free: 3, paid: "licence" },
  { key: "users", label: "Users", free: 1, paid: null },
  { key: "historyVisible", label: "Visible versions", free: 5, paid: null },
  { key: "presets", label: "Saved presets", free: 3, paid: null },
];

/** The servers limit of a Paid licence without maxServers. */
export const DEFAULT_MAX_SERVERS = 50;

/** Always Free: never in the registry as Paid (contract C1). */
export const ALWAYS_FREE: readonly string[] = [
  "Connectors (local folders and SFTP)",
  "Every game pack",
  "Typed and raw editors",
  "Lint",
  "Diffs",
  "Apply hooks and server status",
  "Outside-edit detection on open",
  "Two-factor sign-in",
  "App backup",
  "Privacy controls",
  "Audit log viewing and chain check",
];

/**
 * Every API route that is not Paid, as "METHOD /path" (GET covers HEAD).
 * Each belongs to an Always-Free area of contract C1, or is a route every
 * plan needs (setup, sign-in, the licence page, the plan, users and the
 * privacy controls).
 */
export const ALWAYS_FREE_ROUTES: readonly string[] = [
  // Setup, sign-in and the account (two-factor sign-in is Always Free).
  "GET /api/v1/setup",
  "POST /api/v1/setup",
  "POST /api/v1/setup/import",
  "GET /api/v1/auth/session",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/login/totp",
  "POST /api/v1/auth/logout",
  "PATCH /api/v1/auth/profile",
  "POST /api/v1/auth/password",
  "POST /api/v1/auth/totp/enrol",
  "POST /api/v1/auth/totp/enable",
  "POST /api/v1/auth/totp/disable",
  "POST /api/v1/auth/password-reset",
  // OIDC sign-in is Paid, but a visitor has no session yet: these routes are
  // public and answer the C1 402 body from the service (O-30).
  "GET /api/v1/auth/oidc",
  "GET /api/v1/auth/oidc/start",
  "GET /api/v1/auth/oidc/callback",
  "GET /api/v1/openapi.json",
  // Licence, plan and the Free fallback choice.
  "GET /api/v1/entitlement",
  "PUT /api/v1/licence",
  "DELETE /api/v1/licence",
  "PUT /api/v1/licence/environment",
  "GET /api/v1/plan/registry",
  "GET /api/v1/plan/editable-servers",
  "PUT /api/v1/plan/editable-servers",
  // Activity, app backup and the system page.
  "GET /api/v1/activity",
  "GET /api/v1/system/status",
  "POST /api/v1/system/app-secret/acknowledge",
  "GET /api/v1/system/backups",
  "POST /api/v1/system/backups",
  "POST /api/v1/system/backups/:id/drill",
  "POST /api/v1/system/backup-export",
  "GET /api/v1/system/snapshots",
  // Game packs, connectors, servers, editors, diffs and history.
  "GET /api/v1/games",
  "GET /api/v1/games/:id/settings-meta",
  "GET /api/v1/connectors/ssh-key",
  "POST /api/v1/connectors/test",
  "POST /api/v1/connectors/host-keys",
  "POST /api/v1/connectors/detect",
  "GET /api/v1/servers",
  "POST /api/v1/servers",
  "GET /api/v1/servers/:slug",
  "PATCH /api/v1/servers/:slug",
  "DELETE /api/v1/servers/:slug",
  "POST /api/v1/servers/:slug/test",
  "POST /api/v1/servers/:slug/detect",
  "GET /api/v1/servers/:slug/settings",
  "GET /api/v1/servers/:slug/files/:fileId",
  "GET /api/v1/servers/:slug/history",
  "GET /api/v1/servers/:slug/pending",
  "POST /api/v1/servers/:slug/change-sets",
  "GET /api/v1/change-sets/:id",
  "POST /api/v1/change-sets/:id/apply",
  "POST /api/v1/snapshots/:id/restore",
  // Presets up to limit(presets); apply hooks and server status.
  "GET /api/v1/presets",
  "POST /api/v1/presets",
  "DELETE /api/v1/presets/:id",
  "POST /api/v1/presets/:id/apply",
  "GET /api/v1/servers/:slug/hooks",
  "PUT /api/v1/servers/:slug/hooks",
  "POST /api/v1/servers/:slug/hooks/run",
  "GET /api/v1/servers/:slug/status",
  // Users: the owner keeps managing accounts on Free; invitations are Paid,
  // an accept is checked against limit(users), and a revoke is cleanup.
  "GET /api/v1/users",
  "GET /api/v1/users/:id",
  "POST /api/v1/users/:id/password-reset",
  "DELETE /api/v1/invitations/:id",
  "POST /api/v1/invitations/accept",
  // Privacy controls (every plan).
  "DELETE /api/v1/users/:id",
  "POST /api/v1/users/:id/anonymise",
  "GET /api/v1/users/:id/export",
  "GET /api/v1/me/export",
  "GET /api/v1/settings/audit",
  "PUT /api/v1/settings/audit",
  "GET /api/v1/settings/snapshots",
  "PUT /api/v1/settings/snapshots",
  // The audit log is recorded on every plan, and the owner can always read
  // and verify it; its CSV export is the Paid part (R&D default D5).
  "GET /api/v1/audit",
  "GET /api/v1/audit/verify",
  // API tokens: making one is Paid; listing and revoking are cleanup.
  "GET /api/v1/tokens",
  "DELETE /api/v1/tokens/:id",
];

export const FREE_LIMITS: Limits = {
  servers: 3,
  users: 1,
  historyVisible: 5,
  presets: 3,
};

export function paidLimits(maxServers: number | undefined): Limits {
  return {
    servers: maxServers ?? DEFAULT_MAX_SERVERS,
    users: null,
    historyVisible: null,
    presets: null,
  };
}

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  const found = FEATURES.find((feature) => feature.key === key);
  if (found === undefined) {
    throw new Error(`feature ${key} is not registered`);
  }
  return found;
}

/** The feature map of a plan: every available feature on Paid, none on Free. */
export function featureMap(paid: boolean): Record<FeatureKey, boolean> {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature.key, paid && feature.available]),
  ) as Record<FeatureKey, boolean>;
}
