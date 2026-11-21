// The backup engine (dev-work-plan P1-A step 12, it-input-1 3.1). One engine for
// the CLI, the daily job and the API.
// - A consistent copy through the SQLite backup API into
//   DATA_DIR/backups/YYYYMMDD-HHMM/dialwarden.db, never a file copy.
// - Snapshot blobs the copy references are hard-linked under snapshots/
//   (copied when a link fails), so pruning snapshots never breaks a backup.
// - PRAGMA integrity_check must answer ok; otherwise the folder is deleted.
// - manifest.json records what verify, restore and the drill check.
// - Retention: the backups of the last 3 days, never fewer than the last 3.
import { createHash, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { ENCRYPTED_COLUMNS, type Aead } from "../crypto/aead.js";
import { latestMigration } from "../db/migrate.js";
import { DB_FILE, LOCK_FILE } from "../db/store.js";

/* eslint-disable security/detect-non-literal-fs-filename -- every path is built from the data folder, a validated backup id, or a SHA-256 blob name */

export const BACKUPS_DIR = "backups";
export const SNAPSHOTS_DIR = "snapshots";
export const MANIFEST_FILE = "manifest.json";
export const BACKUP_ID = /^\d{8}-\d{4}(-\d{1,3})?$/;
export const RETENTION_DAYS = 3;
export const RETENTION_MIN = 3;
const SHA256 = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

/** Tables whose row counts the manifest records (null until a phase adds it). */
export const COUNTED_TABLES = [
  "users",
  "servers",
  "change_sets",
  "audit_events",
  "snapshots",
] as const;

const blobSchema = z.object({
  path: z.string().regex(/^snapshots\/[0-9a-f]{2}\/[0-9a-f]{64}\.gz$/),
  sha256: z.string().regex(SHA256),
  size: z.number().int().min(0),
});

export const manifestSchema = z.object({
  format: z.literal(1),
  createdAt: z.string(),
  appVersion: z.string(),
  revision: z.string(),
  migrationId: z.string().nullable(),
  database: z.object({
    file: z.literal(DB_FILE),
    sha256: z.string().regex(SHA256),
    size: z.number().int().min(0),
  }),
  rowCounts: z.record(z.string(), z.number().int().nullable()),
  blobs: z.array(blobSchema),
  missingBlobs: z.array(z.string().regex(SHA256)),
  integrity: z.literal("ok"),
});

export type Manifest = z.infer<typeof manifestSchema>;

export interface BackupResult {
  id: string;
  dir: string;
  manifest: Manifest;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  checks: Check[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export function backupsDir(dataDir: string): string {
  return join(dataDir, BACKUPS_DIR);
}

/** UTC folder name for a backup: 20261121-0330. */
export function backupStamp(date: Date): string {
  const iso = date.toISOString();
  const day = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 16).replace(":", "");
  return `${day}-${time}`;
}

function blobRelative(sha: string): string {
  return `${SNAPSHOTS_DIR}/${sha.slice(0, 2)}/${sha}.gz`;
}

const TABLE_SQL =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?";

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(TABLE_SQL).get(table) !== undefined;
}

type CountRow = { n: number } | undefined;

/** Row counts of COUNTED_TABLES; null for a table that does not exist yet. */
export function rowCounts(
  db: Database.Database,
): Record<string, number | null> {
  const counts = new Map<string, number | null>();
  for (const table of COUNTED_TABLES) {
    if (!tableExists(db, table)) {
      counts.set(table, null);
      continue;
    }
    // The table name comes from the constant list above, never from input.
    const sql = `SELECT count(*) AS n FROM "${table}"`;
    const row = db.prepare(sql).get() as CountRow;
    counts.set(table, row?.n ?? 0);
  }
  return Object.fromEntries(counts);
}

/**
 * SHA-256 names of the snapshot blobs the database references. The snapshots
 * table and its sha256 column arrive in P4; until then there are none.
 */
export function referencedBlobs(db: Database.Database): string[] {
  if (!tableExists(db, "snapshots")) {
    return [];
  }
  const info = db.prepare("PRAGMA table_info(snapshots)").all();
  const columns = info as { name: string }[];
  if (!columns.some((column) => column.name === "sha256")) {
    return [];
  }
  const select = db.prepare("SELECT DISTINCT sha256 FROM snapshots");
  const shas: string[] = [];
  for (const row of select.all() as { sha256: unknown }[]) {
    if (typeof row.sha256 === "string" && SHA256.test(row.sha256)) {
      shas.push(row.sha256);
    }
  }
  return shas;
}

function integrity(db: Database.Database): string {
  const result: unknown = db.pragma("integrity_check", { simple: true });
  return String(result);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function freeBackupDir(root: string, stamp: string): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const id = attempt === 1 ? stamp : `${stamp}-${attempt}`;
    if (!(await exists(join(root, id)))) {
      return id;
    }
  }
  throw new BackupError("no free backup folder name");
}

export interface RunBackupOptions {
  sqlite: Database.Database;
  dataDir: string;
  appVersion: string;
  revision: string;
  now: Date;
}

/** Takes one backup. Deletes the folder and throws when the copy is not ok. */
export async function runBackup(
  options: RunBackupOptions,
): Promise<BackupResult> {
  const root = backupsDir(options.dataDir);
  await mkdir(root, { recursive: true, mode: 0o750 });
  const id = await freeBackupDir(root, backupStamp(options.now));
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o750 });
  try {
    const dbPath = join(dir, DB_FILE);
    await options.sqlite.backup(dbPath);
    const copy = new Database(dbPath);
    let check: string;
    let counts: Record<string, number | null>;
    let shas: string[];
    let migrationId: string | null;
    try {
      // A self-contained file: no -wal or -shm next to it.
      copy.pragma("journal_mode = DELETE");
      check = integrity(copy);
      counts = rowCounts(copy);
      shas = referencedBlobs(copy);
      migrationId = tableExists(copy, "schema_migrations")
        ? latestMigration(copy)
        : null;
    } finally {
      copy.close();
    }
    if (check !== "ok") {
      throw new BackupError(`integrity_check: ${check.slice(0, 200)}`);
    }
    const blobs: Manifest["blobs"] = [];
    const missingBlobs: string[] = [];
    for (const sha of shas) {
      const relative = blobRelative(sha);
      const source = join(options.dataDir, ...relative.split("/"));
      const target = join(dir, ...relative.split("/"));
      if (!(await exists(source))) {
        missingBlobs.push(sha);
        continue;
      }
      await mkdir(join(dir, SNAPSHOTS_DIR, sha.slice(0, 2)), {
        recursive: true,
        mode: 0o750,
      });
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
      const info = await stat(target);
      blobs.push({
        path: relative,
        sha256: await sha256File(target),
        size: info.size,
      });
    }
    const dbInfo = await stat(dbPath);
    const manifest: Manifest = {
      format: 1,
      createdAt: options.now.toISOString(),
      appVersion: options.appVersion,
      revision: options.revision,
      migrationId,
      database: {
        file: DB_FILE,
        sha256: await sha256File(dbPath),
        size: dbInfo.size,
      },
      rowCounts: counts,
      blobs,
      missingBlobs,
      integrity: "ok",
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(dir, MANIFEST_FILE), text, { mode: 0o640 });
    return { id, dir, manifest };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function readManifest(dir: string): Promise<Manifest> {
  const text = await readFile(join(dir, MANIFEST_FILE), "utf8");
  return manifestSchema.parse(JSON.parse(text));
}

function sameCounts(
  expected: Record<string, number | null>,
  found: Record<string, number | null>,
): boolean {
  const left = JSON.stringify(Object.entries(expected).sort());
  const right = JSON.stringify(Object.entries(found).sort());
  return left === right;
}

/** dialwarden backup verify DIR: hashes, integrity and row counts. */
export async function verifyBackup(dir: string): Promise<CheckReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };
  let manifest: Manifest;
  try {
    manifest = await readManifest(dir);
  } catch (error) {
    add("manifest", false, (error as Error).message.slice(0, 200));
    return { ok: false, checks };
  }
  add("manifest", true, `format ${manifest.format}`);
  const dbPath = join(dir, DB_FILE);
  if (!(await exists(dbPath))) {
    add("database", false, "dialwarden.db is missing");
    return { ok: false, checks };
  }
  const sha = await sha256File(dbPath);
  add("database sha256", sha === manifest.database.sha256, sha);
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const check = integrity(db);
    add("integrity", check === "ok", check.slice(0, 200));
    const counts = rowCounts(db);
    add(
      "row counts",
      sameCounts(manifest.rowCounts, counts),
      JSON.stringify(counts),
    );
  } catch (error) {
    // A damaged file can fail before integrity_check answers.
    add("integrity", false, (error as Error).message.slice(0, 200));
  } finally {
    db?.close();
  }
  let blobProblems = 0;
  for (const blob of manifest.blobs) {
    const path = join(dir, ...blob.path.split("/"));
    const ok =
      (await exists(path)) &&
      (await stat(path)).size === blob.size &&
      (await sha256File(path)) === blob.sha256;
    if (!ok) {
      blobProblems += 1;
    }
  }
  const blobCount = manifest.blobs.length;
  add(
    "blobs",
    blobProblems === 0,
    `${blobCount - blobProblems} of ${blobCount} match`,
  );
  return { ok: checks.every((check) => check.ok), checks };
}

async function isEmptyFolder(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.filter((name) => name !== "lost+found").length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

/**
 * dialwarden restore DIR --data TARGET: verifies the backup, then copies the
 * database and the blobs into an empty target. Refuses a target that a running
 * app holds (its lock file) and any non-empty target.
 */
export async function restoreBackup(
  dir: string,
  target: string,
): Promise<void> {
  if (await exists(join(target, LOCK_FILE))) {
    throw new BackupError("the target data folder is locked by a running app");
  }
  if (!(await isEmptyFolder(target))) {
    throw new BackupError("the target data folder is not empty");
  }
  const report = await verifyBackup(dir);
  if (!report.ok) {
    const failed = report.checks.filter((check) => !check.ok);
    const names = failed.map((check) => check.name).join(", ");
    throw new BackupError(`the backup does not verify: ${names}`);
  }
  const manifest = await readManifest(dir);
  await mkdir(target, { recursive: true, mode: 0o750 });
  await copyFile(join(dir, DB_FILE), join(target, DB_FILE));
  for (const blob of manifest.blobs) {
    const parts = blob.path.split("/");
    const destination = join(target, ...parts);
    await mkdir(join(target, ...parts.slice(0, -1)), {
      recursive: true,
      mode: 0o750,
    });
    await copyFile(join(dir, ...parts), destination);
  }
}

export interface BackupListItem {
  id: string;
  createdAt: string | null;
  sizeBytes: number;
  blobCount: number;
  appVersion: string | null;
  /** ok: the manifest is complete; incomplete: no or a broken manifest. */
  integrity: "ok" | "incomplete";
}

export async function listBackups(dataDir: string): Promise<BackupListItem[]> {
  const root = backupsDir(dataDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const items: BackupListItem[] = [];
  for (const id of names.filter((name) => BACKUP_ID.test(name))) {
    try {
      const manifest = await readManifest(join(root, id));
      const blobBytes = manifest.blobs.reduce((sum, b) => sum + b.size, 0);
      items.push({
        id,
        createdAt: manifest.createdAt,
        sizeBytes: manifest.database.size + blobBytes,
        blobCount: manifest.blobs.length,
        appVersion: manifest.appVersion,
        integrity: "ok",
      });
    } catch {
      items.push({
        id,
        createdAt: null,
        sizeBytes: 0,
        blobCount: 0,
        appVersion: null,
        integrity: "incomplete",
      });
    }
  }
  return items.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Keeps the backups of the last RETENTION_DAYS days and never fewer than the
 * last RETENTION_MIN complete ones. Deletes incomplete folders older than a
 * day (a crash during a backup). Returns the deleted ids.
 */
export async function pruneBackups(
  dataDir: string,
  now: Date,
): Promise<string[]> {
  const items = await listBackups(dataDir);
  const since = now.getTime() - RETENTION_DAYS * DAY_MS;
  const complete = items.filter((item) => item.integrity === "ok");
  const keep = new Set(complete.slice(0, RETENTION_MIN).map((item) => item.id));
  for (const item of complete) {
    if (Date.parse(item.createdAt ?? "") >= since) {
      keep.add(item.id);
    }
  }
  const deleted: string[] = [];
  for (const item of items) {
    const dir = join(backupsDir(dataDir), item.id);
    if (item.integrity === "incomplete") {
      const info = await stat(dir);
      if (info.mtime.getTime() >= now.getTime() - DAY_MS) {
        continue;
      }
    } else if (keep.has(item.id)) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    deleted.push(item.id);
  }
  return deleted;
}

export interface DrillReport extends CheckReport {
  backupId: string;
  startedAt: string;
  durationMs: number;
}

function pickRandom<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const [item] = pool.splice(randomInt(pool.length), 1);
    if (item !== undefined) {
      picked.push(item);
    }
  }
  return picked;
}

/** One encrypted value from the registered columns, with its context. */
function firstEncrypted(
  db: Database.Database,
): { value: string; context: string } | null {
  for (const entry of ENCRYPTED_COLUMNS) {
    if (!tableExists(db, entry.table)) {
      continue;
    }
    // Table and column names come from ENCRYPTED_COLUMNS, never from input.
    const sql = `SELECT "${entry.column}" AS v FROM "${entry.table}" WHERE "${entry.column}" IS NOT NULL LIMIT 1`;
    const row = db.prepare(sql).get() as { v: string } | undefined;
    if (row !== undefined) {
      return { value: row.v, context: entry.context };
    }
  }
  return null;
}

/**
 * The restore drill (it-input-1 3.5): restores into a scratch folder under /tmp,
 * checks integrity, row counts against the manifest, three random blobs, that
 * one encrypted secret decrypts with the current key, and that the owner row
 * exists. The scratch folder is always deleted.
 */
export async function drillBackup(
  dir: string,
  backupId: string,
  aead: Aead,
  now: () => Date = () => new Date(),
): Promise<DrillReport> {
  const started = now();
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };
  const scratch = await mkdtemp(join(tmpdir(), "dialwarden-drill-"));
  try {
    const target = join(scratch, "data");
    try {
      await restoreBackup(dir, target);
      add("restore", true, "restored into a scratch folder");
    } catch (error) {
      add("restore", false, (error as Error).message.slice(0, 200));
      throw error;
    }
    const manifest = await readManifest(dir);
    const db = new Database(join(target, DB_FILE), { readonly: true });
    try {
      const check = integrity(db);
      add("integrity", check === "ok", check.slice(0, 200));
      const counts = rowCounts(db);
      add(
        "row counts",
        sameCounts(manifest.rowCounts, counts),
        JSON.stringify(counts),
      );
      const sample = pickRandom(manifest.blobs, 3);
      let matching = 0;
      for (const blob of sample) {
        const path = join(target, ...blob.path.split("/"));
        if ((await sha256File(path)) === blob.sha256) {
          matching += 1;
        }
      }
      add(
        "blobs",
        matching === sample.length,
        sample.length === 0
          ? "no blobs in this backup"
          : `${matching} of ${sample.length} random blobs match`,
      );
      const encrypted = firstEncrypted(db);
      if (encrypted === null) {
        add("secret decrypts", true, "no encrypted value in this backup");
      } else {
        const name = encrypted.context;
        try {
          aead.decrypt(encrypted.value, name);
          add("secret decrypts", true, `${name} with key ${aead.kid}`);
        } catch {
          add("secret decrypts", false, `${name} does not decrypt`);
        }
      }
      const ownerSql = "SELECT count(*) AS n FROM users WHERE role = 'owner'";
      const owners = (db.prepare(ownerSql).get() as CountRow)?.n ?? 0;
      add("owner", owners > 0, `${owners} owner row(s)`);
    } finally {
      db.close();
    }
  } catch (error) {
    if (!checks.some((check) => !check.ok)) {
      add("drill", false, (error as Error).message.slice(0, 200));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return {
    backupId,
    startedAt: started.toISOString(),
    durationMs: now().getTime() - started.getTime(),
    ok: checks.length > 0 && checks.every((check) => check.ok),
    checks,
  };
}
