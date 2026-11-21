// Backup engine (dev-work-plan P1-A step 12, P1 Acceptance): integrity check,
// manifest, hard-linked blobs, retention, verify, restore round trip, refusal
// of a non-empty or locked target, the restore drill, the CLI, the daily job,
// and the passphrase export with the first-run import.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  customerLicence,
  testKeyRing,
} from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_ENV,
  headersOf,
  setupOwner,
  tempDir,
  testApp,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import { buildApp } from "../app.js";
import { main } from "../cli.js";
import { createAead } from "../crypto/aead.js";
import { DB_FILE, LOCK_FILE } from "../db/store.js";
import {
  backupsDir,
  drillBackup,
  listBackups,
  MANIFEST_FILE,
  pruneBackups,
  readManifest,
  restoreBackup,
  runBackup,
  sha256File,
  verifyBackup,
} from "./engine.js";

const DAY_MS = 86_400_000;
let current: TestApp | undefined;
const folders: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await current?.close();
  current = undefined;
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const folder = await tempDir("dialwarden-backup-test-");
  folders.push(folder);
  return folder;
}

/** An app with an owner and a stored (encrypted) UI licence. */
async function seeded(extraEnv: Record<string, string> = {}) {
  const instance = await testApp({ extraEnv });
  current = instance;
  const owner = await setupOwner(instance.app);
  const licence = await instance.app.inject({
    method: "PUT",
    url: "/api/v1/licence",
    headers: headersOf(owner),
    payload: { token: customerLicence() },
  });
  expect(licence.statusCode).toBe(200);
  return { app: instance.app, dataDir: instance.dataDir, owner };
}

async function backupNow(
  app: FastifyInstance,
  owner: SignedIn,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/system/backups",
    headers: headersOf(owner),
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

/** Runs the dialwarden CLI with its output silenced. */
async function cli(args: string[]): Promise<number> {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await main(args);
  } finally {
    vi.restoreAllMocks();
  }
}

describe("backup", () => {
  it("takes a consistent copy with an integrity check and a full manifest", async () => {
    const { app, dataDir, owner } = await seeded();
    const id = await backupNow(app, owner);
    expect(id).toMatch(/^\d{8}-\d{4}(-\d{1,3})?$/);
    const dir = join(backupsDir(dataDir), id);
    const manifest = await readManifest(dir);
    expect(manifest).toMatchObject({
      format: 1,
      appVersion: "27.0.0",
      integrity: "ok",
      blobs: [],
      missingBlobs: [],
      rowCounts: {
        users: 1,
        servers: null,
        change_sets: null,
        audit_events: null,
        snapshots: null,
      },
    });
    expect(manifest.migrationId).toEqual(expect.any(String));
    const dbPath = join(dir, DB_FILE);
    expect(manifest.database.sha256).toBe(await sha256File(dbPath));
    await expect(stat(`${dbPath}-wal`)).rejects.toThrow();
    const copy = new Database(dbPath, { readonly: true });
    try {
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      copy.close();
    }
    expect((await verifyBackup(dir)).ok).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/system/backups",
      headers: headersOf(owner),
    });
    const items = list.json<{ items: { id: string; integrity: string }[] }>();
    expect(items.items).toEqual([
      expect.objectContaining({ id, integrity: "ok" }),
    ]);
    const events = await app.inject({
      method: "GET",
      url: "/api/v1/activity?type=backup.done",
      headers: headersOf(owner),
    });
    const done = events.json<{ items: { data: { id?: string } }[] }>();
    expect(done.items.map((item) => item.data.id)).toEqual([id]);
  });

  it("is owner-only", async () => {
    current = await testApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/api/v1/system/backups",
    });
    expect(res.statusCode).toBe(401);
  });

  it("hard-links the referenced snapshot blobs and records missing ones", async () => {
    const dataDir = await scratch();
    const blob = Buffer.from("synthetic snapshot blob written by the test");
    const sha = createHash("sha256").update(blob).digest("hex");
    const missing = "f".repeat(64);
    const blobDir = join(dataDir, "snapshots", sha.slice(0, 2));
    const blobPath = join(blobDir, `${sha}.gz`);
    await mkdir(blobDir, { recursive: true });
    await writeFile(blobPath, blob);
    const sqlite = new Database(join(dataDir, DB_FILE));
    try {
      sqlite.exec("CREATE TABLE snapshots (sha256 TEXT NOT NULL)");
      const insert = sqlite.prepare("INSERT INTO snapshots (sha256) VALUES (?)");
      insert.run(sha);
      insert.run(missing);
      const result = await runBackup({
        sqlite,
        dataDir,
        appVersion: "27.0.0",
        revision: "unknown",
        now: new Date("2026-11-21T03:30:00Z"),
      });
      expect(result.id).toBe("20261121-0330");
      const relative = `snapshots/${sha.slice(0, 2)}/${sha}.gz`;
      expect(result.manifest.blobs).toEqual([
        { path: relative, sha256: sha, size: blob.length },
      ]);
      expect(result.manifest.missingBlobs).toEqual([missing]);
      expect(result.manifest.rowCounts).toMatchObject({
        snapshots: 2,
        users: null,
      });
      const original = await stat(blobPath);
      const linked = await stat(join(result.dir, ...relative.split("/")));
      expect(linked.ino).toBe(original.ino);

      // Pruning the live blob never breaks the backup.
      await unlink(blobPath);
      expect((await verifyBackup(result.dir)).ok).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("verify reports a changed database, a damaged file and a broken manifest", async () => {
    const { app, dataDir, owner } = await seeded();
    const id = await backupNow(app, owner);
    const dir = join(backupsDir(dataDir), id);
    expect(await cli(["backup", "verify", dir])).toBe(0);
    const copyOf = async () => {
      const target = join(await scratch(), id);
      await cp(dir, target, { recursive: true });
      return target;
    };

    const changed = await copyOf();
    const db = new Database(join(changed, DB_FILE));
    db.prepare("UPDATE users SET name = 'Changed'").run();
    db.close();
    const report = await verifyBackup(changed);
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "database sha256", ok: false }),
    );
    expect(await cli(["backup", "verify", changed])).toBe(1);

    const damaged = await copyOf();
    const bytes = await readFile(join(damaged, DB_FILE));
    await writeFile(join(damaged, DB_FILE), bytes.subarray(0, 100));
    expect((await verifyBackup(damaged)).ok).toBe(false);

    const broken = await copyOf();
    await writeFile(join(broken, MANIFEST_FILE), "{");
    expect(await verifyBackup(broken)).toMatchObject({
      ok: false,
      checks: [{ name: "manifest", ok: false }],
    });
    await expect(restoreBackup(broken, await scratch())).rejects.toThrow(
      /does not verify/,
    );
  });

  it("restores into an empty folder, and the restored data serves the owner", async () => {
    const key = randomBytes(32).toString("hex");
    const { app, dataDir, owner } = await seeded({ APP_SECRET_KEY: key });
    const dir = join(backupsDir(dataDir), await backupNow(app, owner));
    const target = join(await scratch(), "restored");
    expect(await cli(["restore", dir, "--data", target])).toBe(0);

    const restored = await buildApp({
      keys: testKeyRing,
      env: {
        LOG_LEVEL: "silent",
        DATA_DIR: target,
        APP_SECRET_KEY: key,
        ...BUILD_ENV,
      },
    });
    try {
      const login = await restored.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: owner.email, password: owner.password },
      });
      expect(login.statusCode).toBe(200);
      expect(restored.ctx.entitlement.getEntitlement()).toMatchObject({
        plan: "paid",
        source: "ui",
      });
    } finally {
      await restored.close();
    }
  });

  it("refuses a non-empty target, a locked target and the live data folder", async () => {
    const { app, dataDir, owner } = await seeded();
    const dir = join(backupsDir(dataDir), await backupNow(app, owner));

    const nonEmpty = await scratch();
    await writeFile(join(nonEmpty, "keep.txt"), "existing data");
    await expect(restoreBackup(dir, nonEmpty)).rejects.toThrow(/not empty/);
    expect(await readFile(join(nonEmpty, "keep.txt"), "utf8")).toBe(
      "existing data",
    );
    await expect(stat(join(nonEmpty, DB_FILE))).rejects.toThrow();
    expect(await cli(["restore", dir, "--data", nonEmpty])).toBe(1);

    const locked = await scratch();
    await writeFile(join(locked, LOCK_FILE), "{}\n");
    await expect(restoreBackup(dir, locked)).rejects.toThrow(/locked/);
    await expect(restoreBackup(dir, dataDir)).rejects.toThrow(/locked/);
  });

  it("keeps the last 3 days and never fewer than the last 3 backups", async () => {
    const dataDir = await scratch();
    const sqlite = new Database(join(dataDir, DB_FILE));
    const now = new Date("2026-11-21T04:00:00Z");
    const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const take = async (days: number) => {
      const options = { appVersion: "27.0.0", revision: "unknown" };
      const result = await runBackup({
        ...options,
        sqlite,
        dataDir,
        now: at(days),
      });
      return result.id;
    };
    const ids = async () =>
      (await listBackups(dataDir)).map((item) => item.id).sort();
    try {
      sqlite.exec("CREATE TABLE users (id TEXT)");
      const old: string[] = [];
      for (const days of [10, 9, 8, 7]) {
        old.push(await take(days));
      }
      const recent = [await take(2), await take(1)];

      // Two backups in the last 3 days, so the one of 7 days ago stays too.
      const deleted = await pruneBackups(dataDir, now);
      expect(deleted.sort()).toEqual(old.slice(0, 3).sort());
      expect(await ids()).toEqual([...old.slice(3), ...recent].sort());

      // An incomplete folder older than a day goes; a fresh one stays.
      const root = backupsDir(dataDir);
      await mkdir(join(root, "20261101-0000"));
      await utimes(join(root, "20261101-0000"), at(2), at(2));
      await mkdir(join(root, "20261121-0359"));
      expect(await pruneBackups(dataDir, now)).toEqual(["20261101-0000"]);
      await rm(join(root, "20261121-0359"), { recursive: true });

      // A month later, with no new backup, the last 3 are kept.
      const later = new Date(now.getTime() + 30 * DAY_MS);
      expect(await pruneBackups(dataDir, later)).toEqual([]);
      await take(0);
      expect(await pruneBackups(dataDir, later)).toEqual(old.slice(3));
    } finally {
      sqlite.close();
    }
  });

  it("runs the restore drill and reports every check", async () => {
    const { app, dataDir, owner } = await seeded();
    const id = await backupNow(app, owner);
    const drills = async () =>
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("dialwarden-drill-"),
      ).length;
    const before = await drills();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/system/backups/${id}/drill`,
      headers: headersOf(owner),
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<{
      backupId: string;
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    }>();
    expect(report.backupId).toBe(id);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      "restore",
      "integrity",
      "row counts",
      "blobs",
      "secret decrypts",
      "owner",
    ]);
    const secret = report.checks.find((c) => c.name === "secret decrypts");
    expect(secret?.detail).toContain("licence.token");
    expect(await drills()).toBe(before);

    // With another key the stored secret does not decrypt.
    const dir = join(backupsDir(dataDir), id);
    const other = await drillBackup(dir, id, createAead(randomBytes(32)));
    expect(other.ok).toBe(false);
    expect(other.checks).toContainEqual(
      expect.objectContaining({ name: "secret decrypts", ok: false }),
    );

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/system/backups/20000101-0000/drill",
      headers: headersOf(owner),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("starts the daily job and falls back to the default on a bad schedule", async () => {
    const instance = await testApp();
    current = instance;
    const backups = instance.app.ctx.backups;
    expect(() => backups.start("not a schedule", "Nowhere/Zone")).not.toThrow();
    await backups.stop();
    expect(() => backups.start("30 3 * * *", "Europe/Lisbon")).not.toThrow();
    await backups.stop();
  });

  it("exports with a passphrase and imports only into an empty instance", async () => {
    const { app, owner } = await seeded();
    const passphrase = `pp-${randomBytes(12).toString("hex")}`;
    const exported = await app.inject({
      method: "POST",
      url: "/api/v1/system/backup-export",
      headers: headersOf(owner),
      payload: { passphrase },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/octet-stream");
    const archive = exported.rawPayload;
    expect(archive.length).toBeGreaterThan(0);
    expect(archive.includes(Buffer.from("SQLite format 3"))).toBe(false);

    // Another instance with its own APP_SECRET_KEY.
    const fresh = await testApp();
    try {
      const upload = (secret: string) =>
        fresh.app.inject({
          method: "POST",
          url: "/api/v1/setup/import",
          headers: {
            "content-type": "application/octet-stream",
            "x-dialwarden-passphrase": secret,
          },
          payload: archive,
        });
      const wrong = await upload(`${passphrase}-wrong`);
      expect(wrong.statusCode).toBe(422);
      const setup = await fresh.app.inject({
        method: "GET",
        url: "/api/v1/setup",
      });
      expect(setup.json()).toEqual({ required: true });

      const imported = await upload(passphrase);
      expect(imported.statusCode).toBe(200);
      expect(imported.json()).toMatchObject({ status: "imported" });
      const login = await fresh.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: owner.email, password: owner.password },
      });
      expect(login.statusCode).toBe(200);
      expect(fresh.app.ctx.entitlement.getEntitlement()).toMatchObject({
        plan: "paid",
        source: "ui",
      });
      expect((await upload(passphrase)).statusCode).toBe(409);
    } finally {
      await fresh.close();
    }
  });
});
