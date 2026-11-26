// Forward-only migrations (dev-work-plan P1-A step 2). Each one runs once, in
// order, inside a transaction, and is recorded in schema_migrations with the
// SHA-256 of its SQL. An applied migration is never edited: the runner refuses
// to start when a checksum changed or when the database knows a migration this
// build does not (a newer Dialwarden wrote it).
//
// The SQL lives in TypeScript so it ships in dist/ with the server; drizzle-kit
// is not used to generate it (decision recorded in THE-2120). schema.test.ts
// checks that the Drizzle schema matches the migrated tables.

export interface Migration {
  id: string;
  sql: string;
}

const init = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  totp_last_step INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE UNIQUE INDEX recovery_codes_user_code
  ON recovery_codes (user_id, code_hash);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE licence (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  token_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  type TEXT NOT NULL,
  server_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX activity_events_type ON activity_events (type, id);
CREATE INDEX activity_events_server ON activity_events (server_id, id);
`;

// Recovery codes are hashed with a random key per user, kept encrypted with
// APP_SECRET_KEY (column users.recovery_key_enc). The first-run import
// re-encrypts it with the other columns, so the codes keep working after an
// import from an instance with another key.
const recoveryKey = `
ALTER TABLE users ADD COLUMN recovery_key_enc TEXT;
`;

// Connectors (P4-A, contract C4): the instance SSH key pair, its private key
// encrypted with APP_SECRET_KEY (one row, made on first use), and the host
// keys the owner confirmed, one per host and port.
const connectors = `
CREATE TABLE instance_ssh_key (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  private_key_enc TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE known_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT
);
CREATE UNIQUE INDEX known_hosts_host_port ON known_hosts (host, port);
`;

// Servers, change sets and snapshots (P4-B, contract C5). A server's slug is
// its id. server_files keeps the SHA-256 the app last saw per pack file, the
// base of outside-edit detection. change_sets.payload_enc holds the edits or
// patches, encrypted with APP_SECRET_KEY because they can carry passwords.
// snapshots names the content-addressed blobs under DATA_DIR/snapshots, and
// snapshot_blobs records each blob once with its size on disk (the meter).
const servers = `
CREATE TABLE servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  os TEXT NOT NULL,
  connector TEXT NOT NULL,
  password_enc TEXT,
  demo INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_edited_at TEXT
);

CREATE TABLE server_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  checked_at TEXT NOT NULL
);
CREATE UNIQUE INDEX server_files_server_file
  ON server_files (server_id, file_id);

CREATE TABLE change_sets (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  cause TEXT NOT NULL,
  author TEXT NOT NULL,
  payload_enc TEXT,
  base TEXT NOT NULL,
  diff TEXT NOT NULL,
  lint TEXT NOT NULL,
  conflict TEXT,
  error TEXT,
  restore_of TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX change_sets_server ON change_sets (server_id, created_at);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX snapshots_server ON snapshots (server_id, file_id, at);
CREATE INDEX snapshots_change_set ON snapshots (change_set_id);

CREATE TABLE snapshot_blobs (
  sha256 TEXT PRIMARY KEY NOT NULL,
  size INTEGER NOT NULL,
  stored INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

// The saved user presets (P5 screen 7): typed values by setting key as JSON,
// secrets as their mask (the settings read masks them and the write path
// drops a masked secret, so a preset never carries a real secret). The
// values column is quoted: VALUES is a keyword of SQL.
const presets = `
CREATE TABLE presets (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  "values" TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX presets_created ON presets (created_at);
`;

// The per-server hook configuration (P6-B, contract C7) and the hook mode a
// pending change set asked for. The hook column holds the ControlConfig as
// JSON (an ssh command string or a docker-socket-proxy), the overrides column
// one ProbeOverride per probe kind with any password already encrypted;
// run_hooks on a change set says what the flush should do after the write.
const serverHooks = `
CREATE TABLE server_hooks (
  server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  hook TEXT,
  overrides TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
ALTER TABLE change_sets ADD COLUMN run_hooks TEXT;
`;

// The team layer (P8-A): per-server grants, invitations, owner-made password
// reset links, API tokens, the hash-chained audit log with its actors table,
// and the OIDC identity of a user (issuer plus subject). Invitation, reset and
// token values are stored only as their SHA-256. The audit chain hashes ids,
// never names or e-mail addresses: names live in audit_actors and the client
// address sits outside the hash, so erasure and the IP setting never break
// the chain. The other tables still named the acting user by e-mail address
// here; migration 0008 moves them to user ids (D7).
const team = `
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX users_oidc_identity ON users (oidc_issuer, oidc_subject);

CREATE TABLE user_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('read', 'write'))
);
CREATE UNIQUE INDEX user_grants_user_server ON user_grants (user_id, server_id);
CREATE INDEX user_grants_server ON user_grants (server_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  grants TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

CREATE TABLE audit_actors (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  erased INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  server_id TEXT,
  data TEXT NOT NULL,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_events_at ON audit_events (at);
CREATE INDEX audit_events_actor ON audit_events (actor_id, id);
CREATE INDEX audit_events_server ON audit_events (server_id, id);
`;

// The actor columns hold user ids, not e-mail addresses (R&D decision Q4,
// D7). Old rows that name the acting user by e-mail are rewritten once, here:
// a value that matches a user becomes that user's id, every other e-mail
// becomes the one "unknown" actor, and values that are no e-mail ("system",
// the outside-edit author) stay as they are. Nothing is deleted, so the
// audit chain and the history keep verifying.
const actorIds = `
INSERT INTO audit_actors (id, label, erased)
  VALUES ('unknown', 'Unknown user', 0)
  ON CONFLICT (id) DO UPDATE SET label = 'Unknown user';

UPDATE activity_events
  SET actor = coalesce(
    (SELECT u.id FROM users u WHERE u.email = activity_events.actor),
    'unknown')
  WHERE actor LIKE '%@%';

UPDATE change_sets
  SET author = coalesce(
    (SELECT u.id FROM users u WHERE u.email = change_sets.author),
    'unknown')
  WHERE author LIKE '%@%';

UPDATE licence
  SET updated_by = coalesce(
    (SELECT u.id FROM users u WHERE u.email = licence.updated_by),
    'unknown')
  WHERE updated_by LIKE '%@%';

UPDATE known_hosts
  SET confirmed_by = coalesce(
    (SELECT u.id FROM users u WHERE u.email = known_hosts.confirmed_by),
    'unknown')
  WHERE confirmed_by LIKE '%@%';

UPDATE server_hooks
  SET updated_by = coalesce(
    (SELECT u.id FROM users u WHERE u.email = server_hooks.updated_by),
    'unknown')
  WHERE updated_by LIKE '%@%';
`;

// The Paid fleet layer (P9-A). schedules holds the scheduled changes: a
// run-at time or a cron pattern, the setting edits (encrypted, they can carry
// a password), the hook mode, the optional automatic revert and what the last
// run and revert did; next_run_at and revert_due_at are what the scheduler
// looks for. drift_checks holds the background drift check of each server
// that has its own settings (no row: on, every 15 minutes).
const fleet = `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
  run_at TEXT,
  cron TEXT,
  timezone TEXT NOT NULL,
  revert_at TEXT,
  revert_after_minutes INTEGER,
  run_hooks TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  state TEXT NOT NULL,
  next_run_at TEXT,
  revert_due_at TEXT,
  revert_enc TEXT,
  last_run_at TEXT,
  last_result TEXT,
  last_change_set_id TEXT,
  last_revert_at TEXT,
  last_revert_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_server ON schedules (server_id, created_at);
CREATE INDEX schedules_next_run ON schedules (next_run_at);

CREATE TABLE drift_checks (
  server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL,
  interval_minutes INTEGER NOT NULL,
  last_checked_at TEXT,
  last_result TEXT,
  last_error TEXT,
  last_change_set_id TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
`;

// Notification channels (P9-B). notification_channels holds each channel:
// its kind, the C6 types it receives, the settings that are not secret as
// JSON, and the secrets (webhook URL, signing secret, SMTP password) as one
// JSON value encrypted with APP_SECRET_KEY; the last delivery result keeps a
// code only, never a server answer. notification_inbox holds what the in-app
// channel shows, and notification_reads how far each user has read it.
const notifications = `
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in_app', 'webhook', 'discord', 'smtp')),
  enabled INTEGER NOT NULL,
  types TEXT NOT NULL,
  config TEXT NOT NULL,
  secret_enc TEXT,
  last_delivery_at TEXT,
  last_result TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  channel_id TEXT NOT NULL
    REFERENCES notification_channels(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  server_id TEXT,
  at TEXT NOT NULL,
  title TEXT NOT NULL,
  lines TEXT NOT NULL
);
CREATE INDEX notification_inbox_server ON notification_inbox (server_id);

CREATE TABLE notification_reads (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: "0001_init", sql: init },
  { id: "0002_recovery_key", sql: recoveryKey },
  { id: "0003_connectors", sql: connectors },
  { id: "0004_servers", sql: servers },
  { id: "0005_presets", sql: presets },
  { id: "0006_server_hooks", sql: serverHooks },
  { id: "0007_team", sql: team },
  { id: "0008_actor_ids", sql: actorIds },
  { id: "0009_fleet", sql: fleet },
  { id: "0010_notifications", sql: notifications },
];

/** The id of the newest migration this build knows. */
export const LATEST_MIGRATION = MIGRATIONS.at(-1)?.id ?? null;
