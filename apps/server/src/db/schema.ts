// Drizzle schema of the P1 and P4 tables. The SQL that creates them is in
// migrations.ts; schema.test.ts fails when the two disagree. Later phases add
// their tables here and a new migration (never an edit of an applied one).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpPendingEnc: text("totp_pending_enc"),
  totpLastStep: integer("totp_last_step"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** HMAC key of the recovery codes, encrypted (migration 0002). */
  recoveryKeyEnc: text("recovery_key_enc"),
});

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
  changeSets,
  snapshots,
  snapshotBlobs,
  presets,
};
