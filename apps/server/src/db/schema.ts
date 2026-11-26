// Drizzle schema of the P1, P4, P6, P8 and P9 tables. The SQL that creates them
// is in migrations.ts; schema.test.ts fails when the two disagree. Later
// phases add their tables here and a new migration (never an edit of an
// applied one).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    /** An argon2id hash, or the unusable marker of an OIDC-only user. */
    passwordHash: text("password_hash").notNull(),
    totpSecretEnc: text("totp_secret_enc"),
    totpPendingEnc: text("totp_pending_enc"),
    totpLastStep: integer("totp_last_step"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** HMAC key of the recovery codes, encrypted (migration 0002). */
    recoveryKeyEnc: text("recovery_key_enc"),
    /** The OIDC identity (P8-A): issuer plus subject, never the e-mail. */
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
  },
  (table) => [
    uniqueIndex("users_oidc_identity").on(table.oidcIssuer, table.oidcSubject),
  ],
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    uniqueIndex("recovery_codes_user_code").on(table.userId, table.codeHash),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the session secret in the cookie, hex. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user").on(table.userId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON text. */
  value: text("value").notNull(),
});

/** The licence pasted in the UI: one row, encrypted with APP_SECRET_KEY. */
export const licence = sqliteTable(
  "licence",
  {
    id: integer("id").primaryKey(),
    tokenEnc: text("token_enc").notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [check("licence_one_row", sql`${table.id} = 1`)],
);

/** Contract C6. */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    serverId: text("server_id"),
    at: text("at").notNull(),
    actor: text("actor").notNull(),
    data: text("data")
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [
    index("activity_events_type").on(table.type, table.id),
    index("activity_events_server").on(table.serverId, table.id),
  ],
);

/** The instance SSH key pair (P4-A): one row, made on first use. */
export const instanceSshKey = sqliteTable(
  "instance_ssh_key",
  {
    id: integer("id").primaryKey(),
    /** OpenSSH private key, encrypted with APP_SECRET_KEY. */
    privateKeyEnc: text("private_key_enc").notNull(),
    /** OpenSSH public key line (ssh-ed25519 AAAA... comment). */
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("instance_ssh_key_one_row", sql`${table.id} = 1`)],
);

/** SSH host keys the owner confirmed (P4-A), one per host and port. */
export const knownHosts = sqliteTable(
  "known_hosts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    algorithm: text("algorithm").notNull(),
    fingerprint: text("fingerprint").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    confirmedBy: text("confirmed_by"),
  },
  (table) => [uniqueIndex("known_hosts_host_port").on(table.host, table.port)],
);

/** Game servers (P4-B); the slug is the id. */
export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  packId: text("pack_id").notNull(),
  os: text("os").notNull(),
  /** The connection spec as JSON, without the password. */
  connector: text("connector").notNull(),
  /** The panel SFTP password, encrypted with APP_SECRET_KEY. */
  passwordEnc: text("password_enc"),
  /** 1 for a demo server of DEMO_SEED. */
  demo: integer("demo").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** When a change set of the app was last applied (the Free fallback). */
  lastEditedAt: text("last_edited_at"),
});

/** The SHA-256 the app last saw per pack file (outside-edit detection). */
export const serverFiles = sqliteTable(
  "server_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull(),
    path: text("path").notNull(),
    /** null: the file did not exist. */
    sha256: text("sha256"),
    checkedAt: text("checked_at").notNull(),
  },
  (table) => [
    uniqueIndex("server_files_server_file").on(table.serverId, table.fileId),
  ],
);

/** Change sets and history entries (contract C5). */
export const changeSets = sqliteTable(
  "change_sets",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    cause: text("cause").notNull(),
    author: text("author").notNull(),
    /** The edits or patches as JSON, encrypted with APP_SECRET_KEY. */
    payloadEnc: text("payload_enc"),
    /** JSON: the path and SHA-256 of every file the change was made on. */
    base: text("base").notNull(),
    /** JSON: the semantic and text diff, secrets masked. */
    diff: text("diff").notNull(),
    /** JSON: the lint and validation issues. */
    lint: text("lint").notNull(),
    /** JSON: the conflict view, when the status is conflict. */
    conflict: text("conflict"),
    /** JSON: the error code and message, when the status is failed. */
    error: text("error"),
    /**
     * The hook mode a pending change asked for (P6-B): none, restart or
     * stop-start. Set while it waits; the flush reads it to decide whether
     * the start hook runs after the write.
     */
    runHooks: text("run_hooks"),
    /** The snapshot a rollback restores. */
    restoreOf: text("restore_of"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    appliedAt: text("applied_at"),
  },
  (table) => [index("change_sets_server").on(table.serverId, table.createdAt)],
);

/** Snapshots of server files; the bytes are blobs under DATA_DIR/snapshots. */
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    changeSetId: text("change_set_id").references(() => changeSets.id, {
      onDelete: "set null",
    }),
    fileId: text("file_id").notNull(),
    path: text("path").notNull(),
    /** import, external, before or after. */
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    at: text("at").notNull(),
  },
  (table) => [
    index("snapshots_server").on(table.serverId, table.fileId, table.at),
    index("snapshots_change_set").on(table.changeSetId),
  ],
);

/** Each snapshot blob once, with its size on disk (the 1 GB meter). */
export const snapshotBlobs = sqliteTable("snapshot_blobs", {
  sha256: text("sha256").primaryKey(),
  size: integer("size").notNull(),
  stored: integer("stored").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * The saved user presets (screen 7 of the P5 plan): named bundles of typed
 * setting values, applied to a server through a change set of cause preset.
 * The built-in pack presets of P3 stay in the pack data, not here.
 */
export const presets = sqliteTable(
  "presets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    packId: text("pack_id").notNull(),
    /** JSON: typed values by setting key, secrets as their mask. */
    values: text("values").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("presets_created").on(table.createdAt)],
);

/**
 * The per-server hook configuration (P6-B, contract C7): the ssh command
 * string or the docker-socket-proxy the owner or an admin set, and the
 * per-kind probe overrides (host, port and an encrypted password). Only the
 * owner or an admin writes it; editors can only trigger it.
 */
export const serverHooks = sqliteTable("server_hooks", {
  /** The slug of the server; one row per server at most. */
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  /** JSON: the ControlConfig, or null when only the pack hooks are used. */
  hook: text("hook"),
  /** JSON: ProbeOverride by probe kind; passwords stay encrypted inside. */
  overrides: text("overrides").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** Per-server grants of editors and viewers (P8-A): read or write. */
export const userGrants = sqliteTable(
  "user_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    level: text("level").notNull(),
  },
  (table) => [
    uniqueIndex("user_grants_user_server").on(table.userId, table.serverId),
    index("user_grants_server").on(table.serverId),
    check("user_grants_level", sql`${table.level} IN ('read', 'write')`),
  ],
);

/** Invitation links (P8-A): single use, 72 hours, only the hash stored. */
export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  /** JSON: the grants the new user gets, [{ server, level }]. */
  grants: text("grants").notNull(),
  invitedBy: text("invited_by").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  revokedAt: text("revoked_at"),
});

/** Owner-made password reset links (P8-A): single use, 24 hours. */
export const passwordResets = sqliteTable("password_resets", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

/** API tokens (P8-A, Paid): only the SHA-256 of the value is stored. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** The first characters of the value, shown in lists. */
    prefix: text("prefix").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [index("api_tokens_user").on(table.userId)],
);

/** Who an audit actor id is; erasing a person changes only this row. */
export const auditActors = sqliteTable("audit_actors", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  erased: integer("erased").notNull(),
});

/**
 * The audit log (P8-A): each row stores the hash of the row before it. The
 * hash covers id, at, actor_id, action, target_type, target_id, server_id,
 * data and prev_hash; ip is outside it.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey(),
    at: text("at").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    serverId: text("server_id"),
    /** JSON with ids only, never names, e-mail addresses or secrets. */
    data: text("data").notNull(),
    ip: text("ip"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    index("audit_events_at").on(table.at),
    index("audit_events_actor").on(table.actorId, table.id),
    index("audit_events_server").on(table.serverId, table.id),
  ],
);

/**
 * Scheduled changes (P9-A, Paid): a run-at time or a cron pattern, the
 * setting edits, the hook mode and the optional automatic revert.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The user id of who made it; the runs act as this user. */
    author: text("author").notNull(),
    /** once (run_at) or cron (cron and timezone). */
    kind: text("kind").notNull(),
    runAt: text("run_at"),
    cron: text("cron"),
    timezone: text("timezone").notNull(),
    /** The revert of a once schedule, at a set time. */
    revertAt: text("revert_at"),
    /** The revert of each cron run, this many minutes after it. */
    revertAfterMinutes: integer("revert_after_minutes"),
    runHooks: text("run_hooks").notNull(),
    /** The setting edits as JSON, encrypted with APP_SECRET_KEY. */
    payloadEnc: text("payload_enc").notNull(),
    /** active, paused (Free), done or missed. */
    state: text("state").notNull(),
    nextRunAt: text("next_run_at"),
    revertDueAt: text("revert_due_at"),
    /** The values the revert writes back, encrypted like the payload. */
    revertEnc: text("revert_enc"),
    lastRunAt: text("last_run_at"),
    lastResult: text("last_result"),
    lastChangeSetId: text("last_change_set_id"),
    lastRevertAt: text("last_revert_at"),
    lastRevertResult: text("last_revert_result"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("schedules_server").on(table.serverId, table.createdAt),
    index("schedules_next_run").on(table.nextRunAt),
    check("schedules_kind", sql`${table.kind} IN ('once', 'cron')`),
  ],
);

/** The background drift check of one server (P9-A, Paid). */
export const driftChecks = sqliteTable("drift_checks", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull(),
  intervalMinutes: integer("interval_minutes").notNull(),
  lastCheckedAt: text("last_checked_at"),
  /** clean, drift or error. */
  lastResult: text("last_result"),
  lastError: text("last_error"),
  lastChangeSetId: text("last_change_set_id"),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** One notification channel (P9-B, Paid). */
export const notificationChannels = sqliteTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** in_app, webhook, discord or smtp. */
    kind: text("kind").notNull(),
    enabled: integer("enabled").notNull(),
    /** The C6 activity types it receives, as a JSON array. */
    types: text("types").notNull(),
    /** The settings that are not secret, as JSON. */
    config: text("config").notNull(),
    /** URL, signing secret or SMTP password as JSON, encrypted. */
    secretEnc: text("secret_enc"),
    lastDeliveryAt: text("last_delivery_at"),
    /** ok or failed. */
    lastResult: text("last_result"),
    /** A code (for example http_500), never a server answer. */
    lastError: text("last_error"),
    failures: integer("failures").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "notification_channels_kind",
      sql`${table.kind} IN ('in_app', 'webhook', 'discord', 'smtp')`,
    ),
  ],
);

/** What the in-app channel shows (P9-B). */
export const notificationInbox = sqliteTable(
  "notification_inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    eventId: integer("event_id").notNull(),
    type: text("type").notNull(),
    serverId: text("server_id"),
    at: text("at").notNull(),
    title: text("title").notNull(),
    /** The message lines as a JSON array. */
    lines: text("lines").notNull(),
  },
  (table) => [index("notification_inbox_server").on(table.serverId)],
);

/** How far each user has read the in-app notifications (P9-B). */
export const notificationReads = sqliteTable("notification_reads", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastReadId: integer("last_read_id").notNull(),
});

export const schema = {
  users,
  recoveryCodes,
  sessions,
  settings,
  licence,
  activityEvents,
  instanceSshKey,
  knownHosts,
  servers,
  serverFiles,
  serverHooks,
  changeSets,
  snapshots,
  snapshotBlobs,
  presets,
  userGrants,
  invitations,
  passwordResets,
  apiTokens,
  auditActors,
  auditEvents,
  schedules,
  driftChecks,
  notificationChannels,
  notificationInbox,
  notificationReads,
};
