// The upgrade test of P10-B (THE-2857): a database as phase P1 left it, with
// the synthetic rows of test/fixtures/p1-data.sql, is opened by the app of
// this build, which migrates it to the newest migration at start. Then the
// file passes SQLite's integrity_check, every P1 row is still there, the
// actor e-mail addresses of P1 became user ids (migration 0008), and the P1
// owner signs in with the password it had.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { testKeyRing } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/hashing.js";
import {
  BUILD_ENV,
  discard,
  NO_BUILD_INFO_FILE,
  randomPassword,
  tempDir,
} from "../../test/helpers.js";
import { migrate, latestMigration, PRE_MIGRATION_DIR } from "./migrate.js";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.js";
import { DB_FILE, openSqlite } from "./store.js";

/** The migrations phase P1 shipped. */
const P1_MIGRATIONS = MIGRATIONS.filter((migration) =>
  ["0001_init", "0002_recovery_key"].includes(migration.id),
);

const OWNER_ID = "4f3c2a10-0d8e-4c51-9a7b-2f6e1d0c9b8a";
const OWNER_EMAIL = "owner@p1.dialwarden.test";

let dataDir: string | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dataDir !== undefined)
    await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** A data folder with a P1 database holding the fixture rows. */
async function p1Database(password: string): Promise<string> {
  const folder = await tempDir("dialwarden-upgrade-");
  const sqlite = openSqlite(join(folder, DB_FILE));
  try {
    let at = Date.parse("2026-11-21T08:00:00Z");
    const now = () => new Date((at += 1000));
    await migrate(sqlite, { dataDir: folder, now, migrations: P1_MIGRATIONS });
    expect(latestMigration(sqlite)).toBe("0002_recovery_key");
    const fixture = new URL("../../test/fixtures/p1-data.sql", import.meta.url);
    const hash = await hashPassword(password);
    // A function as the replacement, so no $ in the hash is a pattern.
    const rows = (await readFile(fixture, "utf8")).replaceAll(
      "@OWNER_HASH@",
      () => hash,
    );
    sqlite.exec(rows);
  } finally {
    sqlite.close();
  }
  return folder;
}

const count = (started: FastifyInstance, table: string): number => {
  const sql = `SELECT count(*) AS n FROM "${table}"`;
  const row = started.ctx.store.sqlite.prepare(sql).get() as { n: number };
  return row.n;
};

describe("upgrade from the P1 schema", () => {
  it("migrates a P1 database to the head and keeps its data", async () => {
    const password = randomPassword();
    dataDir = await p1Database(password);
    app = await buildApp({
      keys: testKeyRing,
      out: discard(),
      buildInfoFile: NO_BUILD_INFO_FILE,
      env: {
        LOG_LEVEL: "silent",
        DATA_DIR: dataDir,
        APP_SECRET_KEY: randomBytes(32).toString("hex"),
        ...BUILD_ENV,
      },
    });
    const sqlite = app.ctx.store.sqlite;
    expect(latestMigration(sqlite)).toBe(LATEST_MIGRATION);
    expect(sqlite.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // Every P1 row is still there.
    expect(count(app, "users")).toBe(1);
    expect(count(app, "sessions")).toBe(1);
    expect(count(app, "settings")).toBeGreaterThanOrEqual(2);
    expect(count(app, "activity_events")).toBeGreaterThanOrEqual(3);
    // The tables of later phases exist and are empty.
    for (const table of ["servers", "change_sets", "schedules", "presets"]) {
      expect(count(app, table), table).toBe(0);
    }
    // P1 named actors by e-mail; 0008 made them ids, or unknown.
    const actors = sqlite
      .prepare("SELECT actor FROM activity_events ORDER BY id LIMIT 3")
      .all() as { actor: string }[];
    expect(actors.map((row) => row.actor)).toEqual([
      OWNER_ID,
      "system",
      "unknown",
    ]);
    // A copy of the database was kept before the first migration of P1+.
    const copies = await readdir(join(dataDir, PRE_MIGRATION_DIR));
    expect(copies.length).toBeGreaterThan(0);

    // The P1 owner signs in with the password it had.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: OWNER_EMAIL, password },
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json()).toMatchObject({
      status: "ok",
      user: { id: OWNER_ID, role: "owner", totpEnabled: false },
    });
    const health = await app.inject({ method: "GET", url: "/readyz" });
    expect(health.json()).toEqual({ status: "ready" });
  });
});
