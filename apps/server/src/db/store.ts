// The SQLite store: better-sqlite3 in WAL mode with Drizzle on top. Services
// read store.db at call time (never keep it), so the first-run import can close
// the database, put the imported one in place and open it again.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate, type MigrationResult } from "./migrate.js";
import { schema } from "./schema.js";

export const DB_FILE = "dialwarden.db";
/** Present while an app runs on the data folder; restore refuses such a target. */
export const LOCK_FILE = "dialwarden.lock";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export function openSqlite(path: string): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return sqlite;
}

export class Store {
  readonly dataDir: string;
  readonly #now: () => Date;
  #sqlite: Database.Database | null = null;
  #db: AppDatabase | null = null;
  #lastMigration: MigrationResult | null = null;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.dataDir = dataDir;
    this.#now = now;
  }

  get path(): string {
    return join(this.dataDir, DB_FILE);
  }

  get isOpen(): boolean {
    return this.#sqlite !== null;
  }

  /** Opens the database, runs pending migrations and takes the data lock. */
  async open(): Promise<MigrationResult> {
    if (this.#sqlite !== null) {
      throw new Error("the store is already open");
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the configured data folder
    mkdirSync(this.dataDir, { recursive: true, mode: 0o750 });
    const sqlite = openSqlite(this.path);
    try {
      this.#lastMigration = await migrate(sqlite, {
        dataDir: this.dataDir,
        now: this.#now,
      });
    } catch (error) {
      sqlite.close();
      throw error;
    }
    this.#sqlite = sqlite;
    this.#db = drizzle(sqlite, { schema });
    const lock = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      since: this.#now().toISOString(),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed name in the data folder
    writeFileSync(join(this.dataDir, LOCK_FILE), `${lock}\n`, { mode: 0o640 });
    return this.#lastMigration;
  }

  get sqlite(): Database.Database {
    if (this.#sqlite === null) {
      throw new Error("the database is closed");
    }
    return this.#sqlite;
  }

  get db(): AppDatabase {
    if (this.#db === null) {
      throw new Error("the database is closed");
    }
    return this.#db;
  }

  get lastMigration(): MigrationResult | null {
    return this.#lastMigration;
  }

  close(): void {
    if (this.#sqlite === null) {
      return;
    }
    this.#sqlite.close();
    this.#sqlite = null;
    this.#db = null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed name in the data folder
    rmSync(join(this.dataDir, LOCK_FILE), { force: true });
  }

  /** True when SELECT 1 answers (the readiness check). */
  ping(): boolean {
    try {
      const row: unknown = this.sqlite.prepare("SELECT 1 AS ok").get();
      return (row as { ok?: number } | undefined)?.ok === 1;
    } catch {
      return false;
    }
  }
}
