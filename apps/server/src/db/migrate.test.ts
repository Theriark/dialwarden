// The migration runner (dev-work-plan P1-A step 2; test review F4): forward
// only, checksums, a refusal of migrations this build does not know, and a
// pre-migration copy before each migration on a database with data, keeping
// the last 3. Synthetic migrations stand in for later phases.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { migrate, PRE_MIGRATION_DIR, PRE_MIGRATION_KEEP } from "./migrate.js";
import { LATEST_MIGRATION, MIGRATIONS, type Migration } from "./migrations.js";
import { openSqlite } from "./store.js";

const folders: string[] = [];
const open: Database.Database[] = [];

afterEach(async () => {
  for (const sqlite of open.splice(0)) {
    sqlite.close();
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function database() {
  const dataDir = await tempDir("dialwarden-migrate-test-");
  folders.push(dataDir);
  const sqlite = openSqlite(join(dataDir, "test.db"));
  open.push(sqlite);
  let at = Date.parse("2026-11-21T08:00:00Z");
  const now = () => {
    at += 1000;
    return new Date(at);
  };
  return { dataDir, sqlite, now };
}

const synthetic = (n: number): Migration => ({
  id: `000${n}_synthetic`,
  sql: `CREATE TABLE synthetic_${n} (id INTEGER PRIMARY KEY);`,
});

function appliedIds(sqlite: Database.Database): string[] {
  const select = sqlite.prepare("SELECT id FROM schema_migrations ORDER BY id");
  return (select.all() as { id: string }[]).map((row) => row.id);
}

describe("migrate", () => {
  it("applies every migration to a fresh database once, with checksums", async () => {
    const { dataDir, sqlite, now } = await database();
    const first = await migrate(sqlite, { dataDir, now });
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(first.preMigrationCopy).toBeNull();
    expect(first.latest).toBe(LATEST_MIGRATION);
    const select = sqlite.prepare("SELECT checksum FROM schema_migrations");
    for (const row of select.all() as { checksum: string }[]) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const second = await migrate(sqlite, { dataDir, now });
    expect(second.applied).toEqual([]);
    expect(second.preMigrationCopy).toBeNull();
  });

  it("copies the database before each migration and keeps the last 3", async () => {
    const { dataDir, sqlite, now } = await database();
    await migrate(sqlite, { dataDir, now, migrations: [synthetic(1)] });
    const migrations = [1, 2, 3, 4, 5].map(synthetic);
    const result = await migrate(sqlite, { dataDir, now, migrations });
    expect(result.applied).toEqual(migrations.slice(1).map((m) => m.id));
    expect(appliedIds(sqlite)).toEqual(migrations.map((m) => m.id));
    const copies = (await readdir(join(dataDir, PRE_MIGRATION_DIR))).sort();
    expect(copies).toHaveLength(PRE_MIGRATION_KEEP);
    expect(copies.map((name) => name.replace(/^\d{8}-\d{6}-/, ""))).toEqual([
      "before-0003_synthetic.db",
      "before-0004_synthetic.db",
      "before-0005_synthetic.db",
    ]);
    expect(result.preMigrationCopy).toBe(
      join(dataDir, PRE_MIGRATION_DIR, copies.at(-1) ?? ""),
    );
  });

  it("refuses a migration whose SQL changed after it was applied", async () => {
    const { dataDir, sqlite, now } = await database();
    await migrate(sqlite, { dataDir, now, migrations: [synthetic(1)] });
    const changed = { ...synthetic(1), sql: "CREATE TABLE other (id INT);" };
    await expect(
      migrate(sqlite, { dataDir, now, migrations: [changed] }),
    ).rejects.toThrow(/changed after it was applied/);
  });

  it("refuses a database a newer build migrated", async () => {
    const { dataDir, sqlite, now } = await database();
    const newer = [synthetic(1), synthetic(2)];
    await migrate(sqlite, { dataDir, now, migrations: newer });
    await expect(
      migrate(sqlite, { dataDir, now, migrations: [synthetic(1)] }),
    ).rejects.toThrow(/does not know/);
  });

  it("rolls a failing migration back and records nothing for it", async () => {
    const { dataDir, sqlite, now } = await database();
    const broken = { id: "0002_broken", sql: "CREATE TABLE (;" };
    await expect(
      migrate(sqlite, { dataDir, now, migrations: [synthetic(1), broken] }),
    ).rejects.toThrow();
    expect(appliedIds(sqlite)).toEqual(["0001_synthetic"]);
  });
});
