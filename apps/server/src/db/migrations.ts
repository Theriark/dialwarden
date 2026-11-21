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

export const MIGRATIONS: readonly Migration[] = [
  { id: "0001_init", sql: init },
];
