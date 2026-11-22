// The feature registry (contract C1). LICENSING.md names every feature and limit
// marked Paid here as the protected functionality of FCL-1.0-MIT.
//
// Every later phase registers its Paid features and limits here before it
// writes them. A Paid route declares config.entitlement with its FeatureKey and
// is listed under routes below; the registry test in apps/server fails when a
// listed route lacks the declaration, and checks that every declared route
// answers 402 on the Free plan.

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
    routes: [],
  },
  {
    key: "team.roles",
    label: "User roles and per-server grants",
    available: true,
    routes: [],
  },
  { key: "audit", label: "Audit log", available: true, routes: [] },
  { key: "oidc", label: "Single sign-on (OIDC)", available: true, routes: [] },
  { key: "apiTokens", label: "API tokens", available: true, routes: [] },
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
