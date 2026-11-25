// Privacy retention (dev-work-plan P8-A step 7), on every plan (contract C1):
// the owner chooses how long snapshots are kept — all of them within the 1 GB
// meter (the default), the newest N versions of every file, or the last N
// days — and how long the audit log is kept (the audit settings). A daily job
// (croner, after the backup job; RETENTION_SCHEDULE and RETENTION_TZ) prunes
// what the settings name; the audit service moves its own chain start forward
// with a checkpoint, and this service never removes a snapshot a pending
// change set or a draft restore still refers to, nor a blob another kept
// snapshot shares. The app backup folder is never touched.
import { unlink } from "node:fs/promises";
import { Cron } from "croner";
import { eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuditService } from "../audit/service.js";
import type { Settings } from "../db/settings.js";
import { changeSets, snapshotBlobs, snapshots } from "../db/schema.js";
import type { Store } from "../db/store.js";
import type { SnapshotStore } from "../snapshots/store.js";

const DAY_MS = 86_400_000;
const SNAPSHOT_KEY = "snapshots.retention";

export const RETENTION_MODES = ["all", "days", "versions"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export const DEFAULT_RETENTION: SnapshotRetention = {
  mode: "all",
  days: null,
  versions: null,
};

export interface SnapshotRetention {
  mode: RetentionMode;
  /** Snapshots older than this many days are removed (mode days). */
  days: number | null;
  /** The newest snapshots per file that stay (mode versions). */
  versions: number | null;
}

export interface RetentionReport {
  /** Audit rows the audit retention removed (checkpoints aside). */
  auditRows: number;
  /** Snapshot rows removed. */
  snapshots: number;
  /** Blob files removed because no snapshot row names them any more. */
  blobs: number;
}

export interface RetentionServiceOptions {
  store: Store;
  settings: Settings;
  snapshots: SnapshotStore;
  audit: AuditService;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export class RetentionService {
  readonly #store: Store;
  readonly #settings: Settings;
  readonly #blobs: SnapshotStore;
  readonly #audit: AuditService;
  readonly #log: RetentionServiceOptions["log"];
  readonly #now: () => Date;
  #job: Cron | null = null;

  constructor(options: RetentionServiceOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#blobs = options.snapshots;
    this.#audit = options.audit;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  /** The snapshot retention setting, with the mode's own fields normalised. */
  snapshotRetention(): SnapshotRetention {
    const value = this.#settings.get(SNAPSHOT_KEY);
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_RETENTION };
    }
    const { mode, days, versions } = value as Partial<SnapshotRetention>;
    const kept: SnapshotRetention =
      mode === "days" || mode === "versions"
        ? { mode, days: null, versions: null }
        : { ...DEFAULT_RETENTION };
    if (kept.mode === "days") {
      if (typeof days === "number" && days > 0) {
        kept.days = days;
      }
    }
    if (kept.mode === "versions") {
      if (typeof versions === "number" && versions > 0) {
        kept.versions = versions;
      }
    }
    return kept;
  }

  setSnapshotRetention(change: Partial<SnapshotRetention>): SnapshotRetention {
    const next = { ...this.snapshotRetention(), ...change };
    if (next.mode !== "days") next.days = null;
    if (next.mode !== "versions") next.versions = null;
    this.#settings.set(SNAPSHOT_KEY, next);
    return this.snapshotRetention();
  }

  /**
   * Snapshots a pending change set or a draft restore still needs: the target
   * of the rollback, and everything a not-yet-applied change set recorded.
   */
  #inUse(): Set<string> {
    const db = this.#store.db;
    const kept = new Set<string>();
    const open = db
      .select({ restoreOf: changeSets.restoreOf, id: changeSets.id })
      .from(changeSets)
      .where(inArray(changeSets.status, ["pending", "draft"]))
      .all();
    const ids: string[] = [];
    for (const row of open) {
      if (row.restoreOf !== null) kept.add(row.restoreOf);
      ids.push(row.id);
    }
    if (ids.length > 0) {
      const rows = db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(inArray(snapshots.changeSetId, ids))
        .all();
      for (const row of rows) {
        kept.add(row.id);
      }
    }
    return kept;
  }

  /**
   * The snapshot rows the current settings remove, never the in-use ones and
   * never the newest snapshot of a file, so every file keeps the one version
   * a rollback needs (p8-threat-specs P-08).
   */
  #staleRetention(inUse: ReadonlySet<string>): Set<string> {
    const retention = this.snapshotRetention();
    const stale = new Set<string>();
    if (retention.mode === "days" && retention.days !== null) {
      const since = this.#now().getTime() - retention.days * DAY_MS;
      const cutoff = new Date(since).toISOString();
      const rows = this.#store.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(lt(snapshots.at, cutoff))
        .all();
      for (const row of rows) {
        stale.add(row.id);
      }
    }
    if (retention.mode === "versions" && retention.versions !== null) {
      // The newest N snapshots of every file stay, whatever their age.
      const rows = this.#store.db
        .select()
        .from(snapshots)
        .orderBy(sql`${snapshots.at} desc`, sql`rowid desc`)
        .all();
      const seen = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.serverId} ${row.fileId}`;
        const held = seen.get(key) ?? 0;
        seen.set(key, held + 1);
        if (held >= retention.versions) stale.add(row.id);
      }
    }
    for (const id of inUse) {
      stale.delete(id);
    }
    if (stale.size > 0) {
      for (const id of this.#newestOfEveryFile()) {
        stale.delete(id);
      }
    }
    return stale;
  }

  /**
   * The newest snapshot of every file, whatever the retention says. Rows of
   * the same time keep their write order (rowid), as in mode versions.
   */
  #newestOfEveryFile(): Set<string> {
    const rows = this.#store.db
      .select({
        id: snapshots.id,
        serverId: snapshots.serverId,
        fileId: snapshots.fileId,
      })
      .from(snapshots)
      .orderBy(sql`${snapshots.at} desc`, sql`rowid desc`)
      .all();
    const newest = new Set<string>();
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.serverId} ${row.fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newest.add(row.id);
    }
    return newest;
  }

  /**
   * Removes the snapshots the settings name and every blob no snapshot row
   * refers to any more. Returns how many rows and blob files went.
   */
  async pruneSnapshots(): Promise<{ rows: number; blobs: number }> {
    const stale = this.#staleRetention(this.#inUse());
    if (stale.size === 0) return { rows: 0, blobs: 0 };
    const removed = this.#store.db
      .delete(snapshots)
      .where(inArray(snapshots.id, [...stale]))
      .run();
    const blobs = await this.#forgetBlobs();
    return { rows: removed.changes, blobs };
  }

  /** Blob files (and meter rows) no snapshot names any more. */
  async #forgetBlobs(): Promise<number> {
    const db = this.#store.db;
    const orphans = db
      .select({ sha256: snapshotBlobs.sha256 })
      .from(snapshotBlobs)
      .leftJoin(snapshots, eq(snapshots.sha256, snapshotBlobs.sha256))
      .where(isNull(snapshots.sha256))
      .all();
    if (orphans.length === 0) return 0;
    const names = orphans.map((row) => row.sha256);
    const gone = inArray(snapshotBlobs.sha256, names);
    db.delete(snapshotBlobs).where(gone).run();
    let removed = 0;
    for (const sha256 of names) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a blob path the snapshot store builds from a SHA-256
        await unlink(this.#blobs.pathOf(sha256));
        removed += 1;
      } catch {
        // A blob that is already gone leaves the meter consistent anyway.
      }
    }
    return removed;
  }

  /** One run of the daily job: audit retention, then snapshot retention. */
  async run(): Promise<RetentionReport> {
    const auditRows = this.#audit.prune();
    const pruned = await this.pruneSnapshots();
    if (auditRows > 0 || pruned.rows > 0) {
      this.#log.info(
        {
          auditRows,
          snapshotRows: pruned.rows,
          blobs: pruned.blobs,
        },
        "retention pruned",
      );
    }
    return { auditRows, snapshots: pruned.rows, blobs: pruned.blobs };
  }

  /** Starts the daily job. An invalid schedule falls back to the default. */
  start(schedule: string, timezone: string): void {
    const run = async () => {
      try {
        await this.run();
      } catch (error) {
        this.#log.warn({ err: error }, "retention run failed");
      }
    };
    try {
      this.#job = new Cron(schedule, { timezone, protect: true }, run);
    } catch (error) {
      this.#log.warn(
        { err: error, schedule, timezone },
        "invalid RETENTION_SCHEDULE or RETENTION_TZ; using the default schedule",
      );
      this.#job = new Cron(
        DEFAULT_SCHEDULE,
        { timezone: DEFAULT_TIMEZONE, protect: true },
        run,
      );
    }
  }

  /** Runs the daily job once now (tests: the job takes no other path). */
  async runScheduledNow(): Promise<void> {
    await this.#job?.trigger();
  }

  /** Stops the job. A running prune ends on its own. */
  stop(): void {
    this.#job?.stop();
    this.#job = null;
  }
}

/** The default job runs after the backup job (03:30), never with it. */
export const DEFAULT_SCHEDULE = "50 3 * * *";
export const DEFAULT_TIMEZONE = "Europe/Lisbon";
