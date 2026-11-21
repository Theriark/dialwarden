#!/usr/bin/env node
// The dialwarden command (node dist/cli.js), it-input-1 3.1:
//   dialwarden backup                       take a backup of DATA_DIR now
//   dialwarden backup verify DIR            hashes, integrity, row counts (exit 0 or 1)
//   dialwarden restore DIR --data TARGET    verify, then restore into an empty TARGET
// It may run next to the app: the backup API of SQLite copies a live database
// consistently. It never runs migrations.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBuildInfo } from "@dialwarden/entitlement";
import Database from "better-sqlite3";
import {
  pruneBackups,
  restoreBackup,
  runBackup,
  verifyBackup,
} from "./backup/engine.js";
import { loadConfig } from "./config.js";
import { DB_FILE } from "./db/store.js";
import { VERSION } from "./version.js";

const USAGE = `usage:
  dialwarden backup
  dialwarden backup verify DIR
  dialwarden restore DIR --data TARGET`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): number {
  process.stderr.write(`dialwarden: ${message}\n`);
  return 1;
}

const INSERT_ACTIVITY =
  "INSERT INTO activity_events (type, server_id, at, actor, data) VALUES (?, NULL, ?, 'cli', ?)";

/** Writes backup.done or backup.failed (C6) when the table exists. */
function recordActivity(
  sqlite: Database.Database,
  type: "backup.done" | "backup.failed",
  data: Record<string, unknown>,
): void {
  try {
    const at = new Date().toISOString();
    sqlite.prepare(INSERT_ACTIVITY).run(type, at, JSON.stringify(data));
  } catch {
    // A database without the activity table (never started) has no log.
  }
}

async function backup(): Promise<number> {
  const config = loadConfig(process.env);
  const path = join(config.dataDir, DB_FILE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the configured data folder
  if (!existsSync(path)) {
    return fail(`no database at ${path}`);
  }
  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma("busy_timeout = 5000");
  try {
    const result = await runBackup({
      sqlite,
      dataDir: config.dataDir,
      appVersion: VERSION,
      revision: readBuildInfo(process.env).revision,
      now: new Date(),
    });
    const pruned = await pruneBackups(config.dataDir, new Date());
    recordActivity(sqlite, "backup.done", {
      id: result.id,
      sizeBytes: result.manifest.database.size,
      pruned,
    });
    print({ id: result.id, dir: result.dir, pruned });
    return 0;
  } catch (error) {
    const reason = (error as Error).message.slice(0, 300);
    recordActivity(sqlite, "backup.failed", { reason });
    return fail(`backup failed: ${reason}`);
  } finally {
    sqlite.close();
  }
}

export async function main(args: readonly string[]): Promise<number> {
  const [command, first, second, third] = args;
  if (command === "backup" && first === undefined) {
    return backup();
  }
  if (command === "backup" && first === "verify" && second !== undefined) {
    const report = await verifyBackup(second);
    print(report);
    return report.ok ? 0 : 1;
  }
  if (
    command === "restore" &&
    first !== undefined &&
    second === "--data" &&
    third !== undefined
  ) {
    try {
      await restoreBackup(first, third);
    } catch (error) {
      return fail((error as Error).message);
    }
    print({ restored: first, data: third });
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// Run only as the program, not when a test imports main().
if (process.argv[1] !== undefined && import.meta.url.endsWith("/cli.js")) {
  process.exitCode = await main(process.argv.slice(2));
}
