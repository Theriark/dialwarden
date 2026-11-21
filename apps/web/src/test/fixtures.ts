// Answer shapes for the page tests, exactly as the P1-A server sends them.
import {
  FEATURE_KEYS,
  type BackupItem,
  type Entitlement,
  type FeatureKey,
  type Health,
  type Registry,
  type SystemStatus,
} from "../api/schema";

export function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  const features = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, false]),
  ) as Record<FeatureKey, boolean>;
  return {
    plan: "free",
    state: "none",
    source: "none",
    limits: { servers: 3, users: 1, historyVisible: 5, presets: 3 },
    features,
    licence: null,
    envLicence: { present: false, state: "none", ignored: false },
    buildDate: "2026-11-21T10:00:00Z",
    featureBaseline: "2026-11-21T10:00:00Z",
    ...overrides,
  };
}

export function paidFromEnvironment(): Entitlement {
  const features = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, key !== "assistant"]),
  ) as Record<FeatureKey, boolean>;
  return entitlement({
    plan: "paid",
    state: "active",
    source: "environment",
    limits: { servers: 50, users: null, historyVisible: null, presets: null },
    features,
    licence: {
      lidHash8: "a1b2c3d4",
      last6: "xyz789",
      customerName: "Theriark Development",
      kind: "internal-dev",
      issuedAt: "2026-11-01",
      updatesUntil: "2026-12-31",
      warn30: false,
    },
    envLicence: { present: true, state: "active", ignored: false },
  });
}

export const registry: Registry = {
  features: [
    { key: "presets.bulk", label: "Apply presets in bulk", available: true },
    { key: "schedules", label: "Scheduled changes", available: true },
    { key: "assistant", label: "Settings assistant", available: false },
  ],
  limits: [
    { key: "servers", label: "Editable servers", free: 3, paid: "licence" },
    { key: "users", label: "Users", free: 1, paid: null },
    { key: "historyVisible", label: "Visible versions", free: 5, paid: null },
    { key: "presets", label: "Saved presets", free: 3, paid: null },
  ],
  alwaysFree: ["Every game pack", "Two-factor sign-in", "App backup"],
};

export const health: Health = {
  status: "ok",
  version: "27.0.0",
  revision: "1cd7a85e9a14193da838ccf3b8aa2ec8b2e52b36",
  buildDate: "2026-11-21T18:00:00Z",
  featureBaseline: "2026-11-21T18:00:00Z",
  plan: "free",
};

export const systemStatus: SystemStatus = {
  version: "27.0.0",
  revision: "1cd7a85e9a14193da838ccf3b8aa2ec8b2e52b36",
  buildDate: "2026-11-21T18:00:00Z",
  featureBaseline: "2026-11-21T18:00:00Z",
  appSecret: {
    source: "file",
    keyId: "k1",
    backupAcknowledged: false,
    showBackupBanner: true,
  },
  backups: {
    running: false,
    schedule: "30 3 * * *",
    timezone: "Europe/Lisbon",
  },
};

export const backupItems: BackupItem[] = [
  {
    id: "20261121-0330",
    createdAt: "2026-11-21T03:30:00Z",
    sizeBytes: 2_621_440,
    blobCount: 12,
    appVersion: "27.0.0",
    integrity: "ok",
  },
  {
    id: "20261120-0330",
    createdAt: "2026-11-20T03:30:00Z",
    sizeBytes: 1_048_576,
    blobCount: 9,
    appVersion: "27.0.0",
    integrity: "incomplete",
  },
];
