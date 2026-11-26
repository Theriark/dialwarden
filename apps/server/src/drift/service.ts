// Background drift detection (dev-work-plan P9-A step 4, Paid feature
// drift.background). Every server's files are read through its connector at
// an interval of its own (default 15 minutes, at least 5), the way an open of
// the editor reads them: an edit made outside the app becomes its own history
// entry with cause external and a snapshot of kind external, and writes the
// activity event drift.detected (contract C6) with via background.
//
// One croner job looks every minute for servers whose interval has passed and
// checks them one after the other. On Free the job checks nothing; the
// outside-edit detection on open stays Always Free (contract C1), and the
// settings stay stored, so the checks go on when Paid returns.
import type { EntitlementGate } from "@dialwarden/entitlement";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ChangeSetService } from "../changes/service.js";
import { ConnectorError } from "../connectors/types.js";
import { driftChecks } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError } from "../http/errors.js";
import type { ServerRecord, ServerService } from "../servers/service.js";

export const DEFAULT_INTERVAL_MINUTES = 15;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/** How often the job looks for servers that are due. */
export const DRIFT_TICK_PATTERN = "0 * * * * *";

export type DriftResult = "clean" | "drift" | "error";

/** The drift check of one server as the API answers it. */
export interface DriftView {
  readonly serverId: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly lastCheckedAt: string | null;
  readonly lastResult: DriftResult | null;
  /** The connector or app error code of a failed check. */
  readonly lastError: string | null;
  /** The history entry of the last outside edit found, if any. */
  readonly lastChangeSetId: string | null;
  readonly nextCheckAt: string | null;
}

export interface DriftSettings {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

export interface DriftServiceOptions {
  readonly store: Store;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly entitlement: EntitlementGate;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

type DriftRow = typeof driftChecks.$inferSelect;

export class DriftService {
  readonly #store: Store;
  readonly #servers: ServerService;
  readonly #changes: ChangeSetService;
  readonly #entitlement: EntitlementGate;
  readonly #log: FastifyBaseLogger;
  readonly #now: () => Date;
  #job: Cron | null = null;
  #ticking: Promise<void> | null = null;

  constructor(options: DriftServiceOptions) {
    this.#store = options.store;
    this.#servers = options.servers;
    this.#changes = options.changes;
    this.#entitlement = options.entitlement;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  #row(serverId: string): DriftRow | null {
    const row = this.#store.db
      .select()
      .from(driftChecks)
      .where(eq(driftChecks.serverId, serverId))
      .get();
    return row ?? null;
  }

  #view(serverId: string): DriftView {
    const row = this.#row(serverId);
    const enabled = row === null ? true : row.enabled === 1;
    const intervalMinutes = row?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    const last = row?.lastCheckedAt ?? null;
    let nextCheckAt: string | null = null;
    if (enabled) {
      const base = last === null ? this.#now().getTime() : Date.parse(last);
      nextCheckAt = new Date(base + intervalMinutes * 60_000).toISOString();
    }
    return {
      serverId,
      enabled,
      intervalMinutes,
      lastCheckedAt: last,
      lastResult: (row?.lastResult ?? null) as DriftResult | null,
      lastError: row?.lastError ?? null,
      lastChangeSetId: row?.lastChangeSetId ?? null,
      nextCheckAt,
    };
  }

  /** GET /api/v1/drift: the checks of the servers the caller may see. */
  list(visible: (serverId: string) => boolean): DriftView[] {
    return this.#servers
      .list()
      .filter((server) => visible(server.id))
      .map((server) => this.#view(server.id));
  }

  /** The check of one server (the guard checked the grant). */
  get(serverId: string): DriftView {
    this.#servers.require(serverId);
    return this.#view(serverId);
  }

  /** PUT /api/v1/servers/SLUG/drift: on or off, and the interval. */
  set(serverId: string, settings: DriftSettings, actor: string): DriftView {
    this.#servers.require(serverId);
    const minutes = settings.intervalMinutes;
    if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new ApiError(400, "validation", {
        issues: [{ path: "intervalMinutes", message: "5 to 1440 minutes" }],
      });
    }
    const updatedAt = this.#now().toISOString();
    const values = {
      enabled: settings.enabled ? 1 : 0,
      intervalMinutes: minutes,
      updatedAt,
      updatedBy: actor,
    };
    this.#store.db
      .insert(driftChecks)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: driftChecks.serverId, set: values })
      .run();
    return this.#view(serverId);
  }

  #record(
    serverId: string,
    result: DriftResult,
    error: string | null,
    changeSetId: string | null,
  ): void {
    const at = this.#now().toISOString();
    const found = changeSetId === null ? {} : { lastChangeSetId: changeSetId };
    const values = {
      lastCheckedAt: at,
      lastResult: result,
      lastError: error,
      ...found,
    };
    this.#store.db
      .insert(driftChecks)
      .values({
        serverId,
        enabled: 1,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        updatedAt: at,
        updatedBy: null,
        ...values,
      })
      .onConflictDoUpdate({ target: driftChecks.serverId, set: values })
      .run();
  }

  /**
   * Checks one server now (POST .../drift/check and the job). A failure is a
   * result, never an exception: it is stored as error with its code
   * (internal for an unexpected one), so one unreachable host never stops
   * the checks of the others and is checked again at its interval.
   */
  async check(server: ServerRecord): Promise<DriftView> {
    try {
      const origin = { via: "background" as const };
      const found = await this.#changes.checkDrift(server, origin);
      const result = found === null ? "clean" : "drift";
      this.#record(server.id, result, null, found);
    } catch (error) {
      if (error instanceof ConnectorError) {
        this.#record(server.id, "error", error.code, null);
      } else if (error instanceof ApiError) {
        this.#record(server.id, "error", error.code, null);
      } else {
        // Recorded too, so the server waits its interval like any other.
        this.#log.error(
          { err: error, server: server.id },
          "drift check failed",
        );
        this.#record(server.id, "error", "internal", null);
      }
    }
    return this.#view(server.id);
  }

  /** The servers whose interval has passed, oldest check first. */
  #due(): ServerRecord[] {
    const now = this.#now().getTime();
    const due: { server: ServerRecord; last: number }[] = [];
    for (const server of this.#servers.list()) {
      const view = this.#view(server.id);
      if (!view.enabled) continue;
      const last =
        view.lastCheckedAt === null ? 0 : Date.parse(view.lastCheckedAt);
      if (now - last >= view.intervalMinutes * 60_000) {
        due.push({ server, last });
      }
    }
    return due.sort((a, b) => a.last - b.last).map((item) => item.server);
  }

  /** One pass of the job: every due server, one at a time. */
  async tick(): Promise<void> {
    if (this.#ticking !== null) {
      await this.#ticking;
      return;
    }
    this.#ticking = this.#tick();
    try {
      await this.#ticking;
    } finally {
      this.#ticking = null;
    }
  }

  async #tick(): Promise<void> {
    if (!this.#entitlement.can("drift.background")) return;
    for (const server of this.#due()) {
      try {
        await this.check(server);
      } catch (error) {
        this.#log.error(
          { err: error, server: server.id },
          "background drift check failed",
        );
      }
    }
  }

  start(): void {
    const run = async () => {
      await this.tick();
    };
    this.#job = new Cron(DRIFT_TICK_PATTERN, { protect: true }, run);
  }

  async stop(): Promise<void> {
    this.#job?.stop();
    this.#job = null;
    if (this.#ticking !== null) await this.#ticking;
  }
}
