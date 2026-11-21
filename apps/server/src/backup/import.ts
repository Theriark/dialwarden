// Import of an app backup export (it-input-1 3.1). Only on an empty instance,
// during first run: no user exists yet. The upload goes to a staging folder in
// the data folder, is decrypted, unpacked and verified, then replaces the empty
// database while the API answers 503. When the export came from an instance
// with another APP_SECRET_KEY, its encrypted columns are re-encrypted with this
// instance's key first; this instance's key never changes.
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { createAead, ENCRYPTED_COLUMNS, type Aead } from "../crypto/aead.js";
import { DB_FILE } from "../db/store.js";
import type { AppContext } from "../http/context.js";
import { ApiError } from "../http/errors.js";
import {
  ArchiveError,
  byteLimit,
  importArchive,
  MAX_ARCHIVE_BYTES,
} from "./archive.js";
import { readManifest, verifyBackup } from "./engine.js";

/* eslint-disable security/detect-non-literal-fs-filename -- staging folder inside the data folder and names from a verified manifest */

const HEX64 = /^[0-9a-f]{64}$/;
const TABLE_SQL = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?";

/** Re-encrypts every registered column from one key to another. */
export function reencrypt(path: string, from: Aead, to: Aead): number {
  const db = new Database(path);
  let changed = 0;
  try {
    db.transaction(() => {
      for (const entry of ENCRYPTED_COLUMNS) {
        if (db.prepare(TABLE_SQL).get(entry.table) === undefined) {
          continue;
        }
        // Table and column names come from ENCRYPTED_COLUMNS, never input.
        const column = `"${entry.column}"`;
        const table = `"${entry.table}"`;
        const select = db.prepare(
          `SELECT rowid AS id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`,
        );
        const update = db.prepare(
          `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
        );
        for (const row of select.all() as { id: number; v: string }[]) {
          const plain = from.decrypt(row.v, entry.context);
          update.run(to.encrypt(plain, entry.context), row.id);
          changed += 1;
        }
      }
    })();
  } finally {
    db.close();
  }
  return changed;
}

export interface ImportResult {
  /** createdAt of the imported backup. */
  createdAt: string;
  /** Encrypted values moved to this instance's key. */
  reencrypted: number;
}

export async function importFirstRun(
  ctx: AppContext,
  body: Readable,
  passphrase: string,
): Promise<ImportResult> {
  if (!ctx.auth.setupRequired()) {
    throw new ApiError(409, "setup_done");
  }
  if (ctx.maintenance) {
    throw new ApiError(409, "import_running");
  }
  const dataDir = ctx.store.dataDir;
  const staging = await mkdtemp(join(dataDir, ".import-"));
  try {
    const upload = join(staging, "upload.dwbx");
    await pipeline(
      body,
      byteLimit(MAX_ARCHIVE_BYTES),
      createWriteStream(upload, { mode: 0o600 }),
    );
    let appKeyHex: string | null;
    try {
      ({ appKeyHex } = await importArchive(upload, passphrase, staging));
    } catch (error) {
      if (error instanceof ArchiveError) {
        throw new ApiError(422, "import_failed", { reason: error.message });
      }
      throw error;
    }
    const folder = join(staging, "backup");
    const report = await verifyBackup(folder);
    if (!report.ok) {
      const failed = report.checks.filter((check) => !check.ok);
      const checks = failed.map((check) => check.name);
      throw new ApiError(422, "import_failed", { reason: "verify", checks });
    }
    const manifest = await readManifest(folder);
    let reencrypted = 0;
    if (appKeyHex !== null && HEX64.test(appKeyHex)) {
      const old = createAead(Buffer.from(appKeyHex, "hex"));
      if (old.kid !== ctx.aead.kid) {
        reencrypted = reencrypt(join(folder, DB_FILE), old, ctx.aead);
      }
    }
    await swapDatabase(ctx, folder, manifest.blobs);
    return { createdAt: manifest.createdAt, reencrypted };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function swapDatabase(
  ctx: AppContext,
  folder: string,
  blobs: { path: string }[],
): Promise<void> {
  const dataDir = ctx.store.dataDir;
  ctx.maintenance = true;
  try {
    if (!ctx.auth.setupRequired()) {
      throw new ApiError(409, "setup_done");
    }
    ctx.store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(dataDir, `${DB_FILE}${suffix}`), { force: true });
    }
    await copyFile(join(folder, DB_FILE), join(dataDir, DB_FILE));
    for (const blob of blobs) {
      const parts = blob.path.split("/");
      await mkdir(join(dataDir, ...parts.slice(0, -1)), {
        recursive: true,
        mode: 0o750,
      });
      await copyFile(join(folder, ...parts), join(dataDir, ...parts));
    }
  } finally {
    try {
      if (!ctx.store.isOpen) {
        await ctx.store.open();
      }
      ctx.licences.reload();
    } finally {
      ctx.maintenance = false;
    }
  }
}
