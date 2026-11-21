// The migration runner (dev-work-plan P1-A step 2). Before it applies anything
// to a database that already has data, it takes a consistent copy (the SQLite
// backup API) into DATA_DIR/backups/pre-migration/ and keeps the last 3.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

export const PRE_MIGRATION_DIR = join("backups", "pre-migration");
export const PRE_MIGRATION_KEEP = 3;

export interface MigrationResult {
  applied: string[];
  preMigrationCopy: string | null;
  latest: string | null;
}

export interface MigrateOptions {
  dataDir: string;
  now: () => Date;
  migrations?: readonly Migration[];
}

interface AppliedRow {
  id: string;
  checksum: string;
}

const checksum = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex");

/** UTC stamp for file names: 20261121-083015. */
export function fileStamp(date: Date): string {
  const iso = date.toISOString();
  const day = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `${day}-${time}`;
}

/* eslint-disable security/detect-non-literal-fs-filename -- folders inside the data folder */
function prunePreMigration(dir: string): void {
  const names = readdirSync(dir).filter((name) => name.endsWith(".db"));
  names.sort();
  for (const name of names.slice(0, -PRE_MIGRATION_KEEP)) {
    rmSync(join(dir, name), { force: true });
  }
}

async function preMigrationCopy(
  sqlite: BetterSqlite3.Database,
  options: MigrateOptions,
  before: string,
): Promise<string> {
  const dir = join(options.dataDir, PRE_MIGRATION_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const name = `${fileStamp(options.now())}-before-${before}.db`;
  const path = join(dir, name);
  await sqlite.backup(path);
  prunePreMigration(dir);
  return path;
}
/* eslint-enable security/detect-non-literal-fs-filename */

export async function migrate(
  sqlite: BetterSqlite3.Database,
  options: MigrateOptions,
): Promise<MigrationResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const select = sqlite.prepare(
    "SELECT id, checksum FROM schema_migrations ORDER BY id",
  );
  const applied = select.all() as AppliedRow[];
  for (const row of applied) {
    const known = migrations.find((migration) => migration.id === row.id);
    if (known === undefined) {
      throw new Error(
        `the database has migration ${row.id}, which this build does not know: a newer Dialwarden wrote it`,
      );
    }
    if (checksum(known.sql) !== row.checksum) {
      throw new Error(`migration ${row.id} changed after it was applied`);
    }
  }
  const done = new Set(applied.map((row) => row.id));
  const pending = migrations.filter((migration) => !done.has(migration.id));
  const first = pending[0];
  let copy: string | null = null;
  if (first !== undefined && applied.length > 0) {
    copy = await preMigrationCopy(sqlite, options, first.id);
  }
  const record = sqlite.prepare(
    "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of pending) {
    const appliedAt = options.now().toISOString();
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      record.run(migration.id, checksum(migration.sql), appliedAt);
    })();
  }
  return {
    applied: pending.map((migration) => migration.id),
    preMigrationCopy: copy,
    latest: latestMigration(sqlite),
  };
}

export function latestMigration(
  sqlite: BetterSqlite3.Database,
): string | null {
  const select = sqlite.prepare(
    "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
  );
  const row = select.get() as { id: string } | undefined;
  return row?.id ?? null;
}
