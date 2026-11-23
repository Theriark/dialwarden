// The snapshot store (dev-work-plan P4-B step 3, rnd-report-1 2.7): every
// version of a server file the app saw, as a gzip blob named by the SHA-256 of
// its content under DATA_DIR/snapshots/AB/SHA256.gz. A blob is written once
// (temp file, fsync, rename) and never changed, so the hard links the app
// backup makes stay valid. The snapshots table names which file of which
// server a blob was, when, and why (import, external, before or after a
// change set). snapshot_blobs records each blob once with its size on disk
// for the 1 GB meter; nothing is pruned automatically (privacy controls in P8
// add owner-chosen pruning).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { eq, inArray, sql } from "drizzle-orm";
import { SNAPSHOTS_DIR } from "../backup/engine.js";
import { sha256Hex } from "../connectors/local.js";
import { LIMITS } from "../connectors/types.js";
import { snapshotBlobs, snapshots } from "../db/schema.js";
import type { Store } from "../db/store.js";

/* eslint-disable security/detect-non-literal-fs-filename -- blob paths are built from the data folder and a checked SHA-256 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The default cap the meter compares with (rnd-report-1 2.7). */
export const SNAPSHOT_CAP_BYTES = 1024 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

export type SnapshotKind = "import" | "external" | "before" | "after";

export interface SnapshotRecord {
  readonly id: string;
  readonly serverId: string;
  readonly changeSetId: string | null;
  readonly fileId: string;
  readonly path: string;
  readonly kind: SnapshotKind;
  readonly sha256: string;
  readonly size: number;
  readonly at: string;
}

export interface NewSnapshot {
  readonly serverId: string;
  readonly changeSetId: string | null;
  readonly fileId: string;
  readonly path: string;
  readonly kind: SnapshotKind;
  readonly bytes: Uint8Array;
}

export interface SnapshotMeter {
  /** Bytes the blobs take on disk (gzip). */
  readonly usedBytes: number;
  readonly capBytes: number;
  readonly blobs: number;
  /** True past the cap; nothing is refused, the owner is told. */
  readonly overCap: boolean;
}

/** A blob that is missing, unreadable or does not match its name. */
export class SnapshotBlobError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SnapshotBlobError";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

type SnapshotRow = typeof snapshots.$inferSelect;

function recordOf(row: SnapshotRow): SnapshotRecord {
  return { ...row, kind: row.kind as SnapshotKind };
}

export class SnapshotStore {
  readonly #store: Store;
  readonly #root: string;
  readonly #now: () => Date;
  readonly #cap: number;

  constructor(
    store: Store,
    dataDir: string,
    now: () => Date = () => new Date(),
    capBytes: number = SNAPSHOT_CAP_BYTES,
  ) {
    this.#store = store;
    this.#root = join(dataDir, SNAPSHOTS_DIR);
    this.#now = now;
    this.#cap = capBytes;
  }

  /** DATA_DIR/snapshots/AB/SHA256.gz of a content hash. */
  pathOf(sha256: string): string {
    if (!SHA256.test(sha256)) {
      throw new SnapshotBlobError("not a SHA-256 blob name");
    }
    return join(this.#root, sha256.slice(0, 2), `${sha256}.gz`);
  }

  /** Stores the bytes once; returns their SHA-256. */
  async put(bytes: Uint8Array): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const path = this.pathOf(sha256);
    if (!(await exists(path))) {
      const packed = await gzipAsync(bytes);
      await mkdir(dirname(path), { recursive: true, mode: 0o750 });
      const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      const handle = await open(temp, "wx", 0o640);
      try {
        await handle.writeFile(packed);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    const size = (await stat(path)).size;
    this.#store.db
      .insert(snapshotBlobs)
      .values({
        sha256,
        size: bytes.length,
        stored: size,
        createdAt: this.#now().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    return sha256;
  }

  /** The bytes of a blob, checked against its name. */
  async get(sha256: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      const packed = await readFile(this.pathOf(sha256));
      const options = { maxOutputLength: LIMITS.maxFileBytes };
      bytes = new Uint8Array(await gunzipAsync(packed, options));
    } catch (error) {
      throw new SnapshotBlobError(`blob ${sha256} is unreadable`, error);
    }
    if (sha256Hex(bytes) !== sha256) {
      throw new SnapshotBlobError(`blob ${sha256} does not match its name`);
    }
    return bytes;
  }

  /** Stores the bytes and records the snapshot. */
  async record(input: NewSnapshot): Promise<SnapshotRecord> {
    const sha256 = await this.put(input.bytes);
    const row: SnapshotRow = {
      id: randomUUID(),
      serverId: input.serverId,
      changeSetId: input.changeSetId,
      fileId: input.fileId,
      path: input.path,
      kind: input.kind,
      sha256,
      size: input.bytes.length,
      at: this.#now().toISOString(),
    };
    this.#store.db.insert(snapshots).values(row).run();
    return recordOf(row);
  }

  find(id: string): SnapshotRecord | null {
    const row = this.#store.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, id))
      .get();
    return row === undefined ? null : recordOf(row);
  }

  /** The snapshots of some change sets, oldest first. */
  ofChangeSets(ids: readonly string[]): SnapshotRecord[] {
    if (ids.length === 0) return [];
    const rows = this.#store.db
      .select()
      .from(snapshots)
      .where(inArray(snapshots.changeSetId, [...ids]))
      .orderBy(snapshots.at)
      .all();
    return rows.map(recordOf);
  }

  /** The size meter of the store against its cap. */
  meter(): SnapshotMeter {
    const row = this.#store.db
      .select({
        used: sql<number>`coalesce(sum(${snapshotBlobs.stored}), 0)`,
        blobs: sql<number>`count(*)`,
      })
      .from(snapshotBlobs)
      .get();
    const usedBytes = Number(row?.used ?? 0);
    return {
      usedBytes,
      capBytes: this.#cap,
      blobs: Number(row?.blobs ?? 0),
      overCap: usedBytes > this.#cap,
    };
  }
}
