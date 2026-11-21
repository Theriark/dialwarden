// The backup service of the running app: one backup at a time, the activity
// events backup.done and backup.failed, retention after every backup, the
// daily job (croner, default 03:30 Europe/Lisbon; BACKUP_SCHEDULE and
// BACKUP_TZ change it), the restore drill and the passphrase export. Backups
// are Free: no entitlement check.
import { join } from "node:path";
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";
import type { ActivityService } from "../activity/service.js";
import type { Aead } from "../crypto/aead.js";
import type { Store } from "../db/store.js";
import { ApiError } from "../http/errors.js";
import { exportArchive } from "./archive.js";
import {
  BACKUP_ID,
  backupsDir,
  drillBackup,
  listBackups,
  pruneBackups,
  runBackup,
  type BackupListItem,
  type BackupResult,
  type DrillReport,
} from "./engine.js";

export const DEFAULT_SCHEDULE = "30 3 * * *";
export const DEFAULT_TIMEZONE = "Europe/Lisbon";

export interface BackupServiceOptions {
  store: Store;
  activity: ActivityService;
  aead: Aead;
  appKey: Buffer;
  log: FastifyBaseLogger;
  appVersion: string;
  revision: string;
  now?: () => Date;
}

export class BackupService {
  readonly #options: BackupServiceOptions;
  readonly #now: () => Date;
  #running: Promise<BackupResult> | null = null;
  #job: Cron | null = null;

  constructor(options: BackupServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get dataDir(): string {
    return this.#options.store.dataDir;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Runs one backup; refuses with 409 while another one runs. */
  async run(actor: string): Promise<BackupResult> {
    if (this.#running !== null) {
      throw new ApiError(409, "backup_running");
    }
    this.#running = this.#run(actor);
    try {
      return await this.#running;
    } finally {
      this.#running = null;
    }
  }

  async #run(actor: string): Promise<BackupResult> {
    const { activity, log } = this.#options;
    try {
      const result = await runBackup({
        sqlite: this.#options.store.sqlite,
        dataDir: this.dataDir,
        appVersion: this.#options.appVersion,
        revision: this.#options.revision,
        now: this.#now(),
      });
      const deleted = await pruneBackups(this.dataDir, this.#now());
      const sizeBytes = result.manifest.database.size;
      activity.record("backup.done", {
        actor,
        data: { id: result.id, sizeBytes, pruned: deleted },
      });
      log.info({ backup: result.id, pruned: deleted }, "backup done");
      return result;
    } catch (error) {
      const reason = (error as Error).message.slice(0, 300);
      activity.record("backup.failed", { actor, data: { reason } });
      log.error({ err: error }, "backup failed");
      throw new ApiError(500, "backup_failed", { reason });
    }
  }

  list(): Promise<BackupListItem[]> {
    return listBackups(this.dataDir);
  }

  folder(id: string): string {
    if (!BACKUP_ID.test(id)) {
      throw new ApiError(404, "backup_not_found");
    }
    return join(backupsDir(this.dataDir), id);
  }

  async drill(id: string): Promise<DrillReport> {
    const items = await this.list();
    const item = items.find((entry) => entry.id === id);
    if (item === undefined || item.integrity !== "ok") {
      throw new ApiError(404, "backup_not_found");
    }
    const report = await drillBackup(
      this.folder(id),
      id,
      this.#options.aead,
      this.#now,
    );
    this.#options.log.info(
      { backup: id, ok: report.ok, durationMs: report.durationMs },
      "restore drill",
    );
    return report;
  }

  /** A fresh backup, then its encrypted tar.gz as a stream of chunks. */
  async export(
    actor: string,
    passphrase: string,
  ): Promise<{ id: string; stream: AsyncGenerator<Buffer> }> {
    const result = await this.run(actor);
    const stream = exportArchive(result.dir, this.#options.appKey, passphrase);
    return { id: result.id, stream };
  }

  /** Starts the daily job. An invalid schedule falls back to the default. */
  start(schedule: string, timezone: string): void {
    const run = async () => {
      try {
        await this.run("system");
      } catch {
        // Logged and recorded as backup.failed (or another one is running).
      }
    };
    try {
      this.#job = new Cron(schedule, { timezone, protect: true }, run);
    } catch (error) {
      this.#options.log.error(
        { err: error, schedule, timezone },
        "invalid BACKUP_SCHEDULE or BACKUP_TZ; using the default schedule",
      );
      this.#job = new Cron(
        DEFAULT_SCHEDULE,
        { timezone: DEFAULT_TIMEZONE, protect: true },
        run,
      );
    }
    const next = this.#job.nextRun();
    this.#options.log.info(
      { next: next?.toISOString() ?? null },
      "backup schedule started",
    );
  }

  /** Stops the job and waits for a running backup to end. */
  async stop(): Promise<void> {
    this.#job?.stop();
    this.#job = null;
    if (this.#running !== null) {
      try {
        await this.#running;
      } catch {
        // Already recorded.
      }
    }
  }
}
