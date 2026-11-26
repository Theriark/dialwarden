// Scheduled changes (dev-work-plan P9-A step 3, Paid feature schedules). A
// schedule holds setting edits for one server and runs them once at a set
// time (run-at) or on a cron pattern in a time zone. Each run makes its own
// change set of cause schedule, made on the files as they are then, and
// applies it with the schedule's hook mode (contract C5), acting as the user
// who made the schedule; that user must still hold write access on the
// server when it runs. An optional revert writes the values the run found
// back: at a set time for a run-at schedule, a number of minutes after each
// run for a cron schedule. A cron run while an earlier run's revert is still
// due leaves that revert as it was, so the values from before the first run
// are the ones written back.
//
// The scheduler is one croner job that calls tick() every 30 seconds; tick()
// is also what runs at start, so missed runs after a restart follow the same
// rule as every other run: a run or revert that fell due less than an hour
// ago (GRACE_MS) runs once, an older one is marked missed. Every run and
// revert, and every miss, writes schedule.run or schedule.reverted (contract
// C6).
//
// On Free every schedule is paused (state paused, reason paid): tick() runs
// and reverts nothing, and when Paid returns the schedules are active again
// and anything that fell due meanwhile follows the grace rule.
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import {
  SECRET_MASK,
  type JsonValue,
  type SettingEdit,
} from "@dialwarden/packs-schema";
import { Cron } from "croner";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ActivityService } from "../activity/service.js";
import type { ChangeSetService } from "../changes/service.js";
import type { RunHooks } from "../changes/types.js";
import { ConnectorError } from "../connectors/types.js";
import { ControlError } from "../control/types.js";
import type { Aead } from "../crypto/aead.js";
import { schedules, users } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError } from "../http/errors.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import { actorLabels } from "../team/labels.js";
import { serverLevel } from "../team/roles.js";
import type { TeamService } from "../team/service.js";

/** The AEAD contexts of the schedule columns (ENCRYPTED_COLUMNS). */
export const PAYLOAD_CONTEXT = "schedules.payload";
export const REVERT_CONTEXT = "schedules.revert";

/** A run or revert due longer ago than this is missed, not run (P9-A). */
export const GRACE_MS = 60 * 60 * 1000;

/** How often the scheduler looks for due runs and reverts. */
export const TICK_PATTERN = "*/30 * * * * *";

/** A cron schedule runs at most this often. */
export const MIN_CRON_GAP_MS = 5 * 60 * 1000;

/** The longest revert delay of a cron schedule: one week. */
export const MAX_REVERT_MINUTES = 7 * 24 * 60;

/** How many cron occurrences a catch-up walks before it gives up. */
const CATCH_UP_LIMIT = 10_000;

export type ScheduleKind = "once" | "cron";

/** paused is the Free plan; done and missed are final for a run-at one. */
export type ScheduleState = "active" | "paused" | "done" | "missed";

/**
 * What a run or revert did: the status of its change set, no_change when
 * the files already held the values, missed when it fell due outside the
 * grace window, or failed when it could not be made or applied.
 */
export type RunResult =
  "applied" | "pending" | "conflict" | "failed" | "no_change" | "missed";

export interface ScheduleEdit {
  readonly settingKey: string;
  /** The value; the secret mask for a secret setting. */
  readonly value: JsonValue;
}

/** A schedule as the API answers it. */
export interface ScheduleView {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  /** The display label of who made it (D7). */
  readonly author: string;
  readonly kind: ScheduleKind;
  readonly runAt: string | null;
  readonly cron: string | null;
  readonly timezone: string;
  readonly revertAt: string | null;
  readonly revertAfterMinutes: number | null;
  readonly runHooks: RunHooks;
  readonly edits: ScheduleEdit[];
  readonly state: ScheduleState;
  /** paid while the Free plan pauses it, else null. */
  readonly pausedReason: "paid" | null;
  readonly nextRunAt: string | null;
  readonly revertDueAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastResult: RunResult | null;
  readonly lastChangeSetId: string | null;
  readonly lastRevertAt: string | null;
  readonly lastRevertResult: RunResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The body of POST /api/v1/schedules, checked by the route schema. */
export interface NewSchedule {
  readonly server: string;
  readonly name: string;
  readonly edits: readonly ScheduleEdit[];
  readonly runHooks: RunHooks;
  readonly runAt?: string | undefined;
  readonly cron?: string | undefined;
  readonly timezone?: string | undefined;
  readonly revertAt?: string | undefined;
  readonly revertAfterMinutes?: number | undefined;
}

export interface ScheduleServiceOptions {
  readonly store: Store;
  readonly aead: Aead;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly team: TeamService;
  readonly activity: ActivityService;
  readonly entitlement: EntitlementGate;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

/** The time zone of a schedule that names none (the web app sends one). */
export const DEFAULT_TIMEZONE = "UTC";

type ScheduleRow = typeof schedules.$inferSelect;

/** One run or revert of a schedule, as tick() found it due. */
interface Due {
  readonly row: ScheduleRow;
  readonly at: Date;
}

const invalid = (path: string, message: string) =>
  new ApiError(400, "validation", { issues: [{ path, message }] });

/** True for an IANA time zone name this runtime knows. */
export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A cron pattern that is not running, only asked for its next times. */
function patternOf(cron: string, timezone: string): Cron {
  return new Cron(cron, { timezone, paused: true });
}

/** The next occurrence of a cron pattern after a time, or null. */
export function nextOccurrence(
  cron: string,
  timezone: string,
  after: Date,
): Date | null {
  return patternOf(cron, timezone).nextRun(after);
}

/**
 * Checks a cron pattern: croner must read it, it must run again, and two
 * runs must be at least MIN_CRON_GAP_MS apart.
 */
function checkCron(cron: string, timezone: string, now: Date): void {
  let runs: Date[];
  try {
    runs = patternOf(cron, timezone).nextRuns(3, now);
  } catch {
    throw invalid("cron", "not a cron pattern");
  }
  if (runs.length === 0) throw invalid("cron", "the pattern never runs");
  const times = runs.map((run) => run.getTime());
  const gap = (time: number, index: number) => time - (times.at(index) ?? 0);
  const gaps = times.slice(1).map(gap);
  if (gaps.some((each) => each < MIN_CRON_GAP_MS)) {
    throw invalid("cron", "a schedule runs at most every 5 minutes");
  }
}

const asResult = (value: string | null): RunResult | null =>
  value as RunResult | null;

export class ScheduleService {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #servers: ServerService;
  readonly #changes: ChangeSetService;
  readonly #team: TeamService;
  readonly #activity: ActivityService;
  readonly #entitlement: EntitlementGate;
  readonly #log: FastifyBaseLogger;
  readonly #now: () => Date;
  #job: Cron | null = null;
  #ticking: Promise<void> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#servers = options.servers;
    this.#changes = options.changes;
    this.#team = options.team;
    this.#activity = options.activity;
    this.#entitlement = options.entitlement;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  #row(id: string): ScheduleRow | null {
    const row = this.#store.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .get();
    return row ?? null;
  }

  /** The schedule, or 404 schedule_not_found. */
  #require(id: string): ScheduleRow {
    const row = this.#row(id);
    if (row === null) throw new ApiError(404, "schedule_not_found");
    return row;
  }

  #edits(row: ScheduleRow): SettingEdit[] {
    const text = this.#aead.decryptText(row.payloadEnc, PAYLOAD_CONTEXT);
    return JSON.parse(text) as SettingEdit[];
  }

  #encrypt(edits: readonly SettingEdit[], context: string): string {
    return this.#aead.encrypt(JSON.stringify(edits), context);
  }

  /**
   * The edits as the API shows them: a secret setting's value masked. When
   * the pack is unknown (no server, or a pack this image no longer ships),
   * which settings are secret is unknown too, so every value is masked.
   */
  #shownEdits(row: ScheduleRow): ScheduleEdit[] {
    const server = this.#servers.get(row.serverId);
    const pack = server === null ? undefined : this.#packOf(server);
    const secrets = new Set(
      (pack?.settings ?? [])
        .filter((setting) => setting.secret === true)
        .map((setting) => setting.key),
    );
    const masked = (key: string) => pack === undefined || secrets.has(key);
    return this.#edits(row).map((edit) => ({
      settingKey: edit.key,
      value: masked(edit.key) ? SECRET_MASK : edit.value,
    }));
  }

  #packOf(server: ServerRecord) {
    try {
      return this.#servers.pack(server);
    } catch {
      return undefined;
    }
  }

  #view(row: ScheduleRow, labels: ReadonlyMap<string, string>): ScheduleView {
    return {
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      author: labels.get(row.author) ?? row.author,
      kind: row.kind === "cron" ? "cron" : "once",
      runAt: row.runAt,
      cron: row.cron,
      timezone: row.timezone,
      revertAt: row.revertAt,
      revertAfterMinutes: row.revertAfterMinutes,
      runHooks: row.runHooks as RunHooks,
      edits: this.#shownEdits(row),
      state: row.state as ScheduleState,
      pausedReason: row.state === "paused" ? "paid" : null,
      nextRunAt: row.nextRunAt,
      revertDueAt: row.revertDueAt,
      lastRunAt: row.lastRunAt,
      lastResult: asResult(row.lastResult),
      lastChangeSetId: row.lastChangeSetId,
      lastRevertAt: row.lastRevertAt,
      lastRevertResult: asResult(row.lastRevertResult),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #views(rows: readonly ScheduleRow[]): ScheduleView[] {
    const labels = actorLabels(
      this.#store,
      rows.map((row) => row.author),
    );
    return rows.map((row) => this.#view(row, labels));
  }

  /**
   * GET /api/v1/schedules: the schedules of the servers the caller may see,
   * oldest first, optionally of one server.
   */
  list(
    visible: (serverId: string) => boolean,
    server?: string,
  ): ScheduleView[] {
    const where =
      server === undefined ? undefined : eq(schedules.serverId, server);
    const rows = this.#store.db
      .select()
      .from(schedules)
      .where(where)
      .orderBy(asc(schedules.createdAt), asc(schedules.id))
      .all();
    return this.#views(rows.filter((row) => visible(row.serverId)));
  }

  /** GET /api/v1/schedules/ID (the guard checked the server grant). */
  get(id: string): ScheduleView {
    return this.#views([this.#require(id)]).at(0) as ScheduleView;
  }

  /** DELETE /api/v1/schedules/ID: a revert that is still due is dropped. */
  remove(id: string): void {
    this.#require(id);
    this.#store.db.delete(schedules).where(eq(schedules.id, id)).run();
  }

  /**
   * POST /api/v1/schedules: checks the time or pattern and the edits, then
   * stores the schedule. Nothing is read from the server yet: each run reads
   * the files as they are when it runs.
   */
  create(input: NewSchedule, author: string): ScheduleView {
    const server = this.#servers.require(input.server);
    this.#servers.assertEditable(server.id);
    const now = this.#now();
    const once = input.runAt !== undefined;
    if (once === (input.cron !== undefined)) {
      throw invalid("runAt", "give either runAt or cron");
    }
    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    if (!isTimezone(timezone)) throw invalid("timezone", "unknown time zone");
    let nextRunAt: Date;
    if (input.runAt !== undefined) {
      if (input.revertAfterMinutes !== undefined) {
        throw invalid("revertAfterMinutes", "only for a cron schedule");
      }
      nextRunAt = new Date(input.runAt);
      if (nextRunAt.getTime() <= now.getTime()) {
        throw invalid("runAt", "must be in the future");
      }
      const revertAt = input.revertAt;
      const runTime = nextRunAt.getTime();
      if (revertAt !== undefined && Date.parse(revertAt) <= runTime) {
        throw invalid("revertAt", "must be after runAt");
      }
    } else {
      if (input.revertAt !== undefined) {
        throw invalid("revertAt", "only for a run-at schedule");
      }
      const cron = input.cron ?? "";
      checkCron(cron, timezone, now);
      nextRunAt = nextOccurrence(cron, timezone, now) ?? now;
    }
    const kept = this.#changes.checkEdits(
      server,
      input.edits.map((edit) => ({ key: edit.settingKey, value: edit.value })),
    );
    const at = now.toISOString();
    const row: ScheduleRow = {
      id: randomUUID(),
      serverId: server.id,
      name: input.name,
      author,
      kind: once ? "once" : "cron",
      runAt: input.runAt === undefined ? null : nextRunAt.toISOString(),
      cron: input.cron ?? null,
      timezone,
      revertAt:
        input.revertAt === undefined
          ? null
          : new Date(input.revertAt).toISOString(),
      revertAfterMinutes: input.revertAfterMinutes ?? null,
      runHooks: input.runHooks,
      payloadEnc: this.#encrypt(kept, PAYLOAD_CONTEXT),
      state: this.#entitlement.can("schedules") ? "active" : "paused",
      nextRunAt: nextRunAt.toISOString(),
      revertDueAt: null,
      revertEnc: null,
      lastRunAt: null,
      lastResult: null,
      lastChangeSetId: null,
      lastRevertAt: null,
      lastRevertResult: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#store.db.insert(schedules).values(row).run();
    return this.get(row.id);
  }

  #update(id: string, values: Partial<ScheduleRow>): void {
    const updatedAt = this.#now().toISOString();
    this.#store.db
      .update(schedules)
      .set({ ...values, updatedAt })
      .where(eq(schedules.id, id))
      .run();
  }

  /**
   * The Free pause and its end: on Free every active schedule becomes
   * paused; on Paid every paused one is active again.
   */
  #syncPlan(paid: boolean): void {
    const from = paid ? "paused" : "active";
    const to = paid ? "active" : "paused";
    const updatedAt = this.#now().toISOString();
    this.#store.db
      .update(schedules)
      .set({ state: to, updatedAt })
      .where(eq(schedules.state, from))
      .run();
  }

  /**
   * Runs what is due: first the reverts, then the runs, each at most once
   * per tick. One tick at a time; a tick that starts while another runs
   * waits for it and returns.
   */
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
    const paid = this.#entitlement.can("schedules");
    this.#syncPlan(paid);
    if (!paid) return;
    const nowIso = this.#now().toISOString();
    const rows = this.#store.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.state, "active"),
          or(isNotNull(schedules.nextRunAt), isNotNull(schedules.revertDueAt)),
        ),
      )
      .orderBy(asc(schedules.createdAt))
      .all();
    for (const first of rows) {
      if (first.revertDueAt !== null && first.revertDueAt <= nowIso) {
        await this.#guarded(first.id, (row) =>
          this.#dueRevert({ row, at: new Date(first.revertDueAt ?? nowIso) }),
        );
      }
      const row = this.#row(first.id);
      if (row?.state !== "active") continue;
      if (row.nextRunAt !== null && row.nextRunAt <= nowIso) {
        const at = this.#latestDue(row);
        const run = (fresh: ScheduleRow) => this.#dueRun({ row: fresh, at });
        await this.#guarded(row.id, run);
      }
    }
  }

  /** Runs one step on the current row; an unexpected error is logged. */
  async #guarded(
    id: string,
    step: (row: ScheduleRow) => Promise<void>,
  ): Promise<void> {
    const row = this.#row(id);
    if (row === null) return;
    try {
      await step(row);
    } catch (error) {
      this.#log.error({ err: error, schedule: id }, "schedule step failed");
    }
  }

  /**
   * The occurrence a due run stands for: next_run_at for a run-at schedule;
   * for a cron schedule the latest occurrence up to now, so a server that
   * was down for a week runs (or misses) once, not once per occurrence.
   */
  #latestDue(row: ScheduleRow): Date {
    const now = this.#now();
    let due = new Date(row.nextRunAt ?? now.toISOString());
    if (row.kind !== "cron" || row.cron === null) return due;
    for (let step = 0; step < CATCH_UP_LIMIT; step += 1) {
      const next = nextOccurrence(row.cron, row.timezone, due);
      if (next === null || next.getTime() > now.getTime()) break;
      due = next;
    }
    return due;
  }

  /** The next run after a due one: none for run-at, the next occurrence. */
  #nextAfter(row: ScheduleRow): string | null {
    if (row.kind !== "cron" || row.cron === null) return null;
    const next = nextOccurrence(row.cron, row.timezone, this.#now());
    return next?.toISOString() ?? null;
  }

  #missed(at: Date): boolean {
    return this.#now().getTime() - at.getTime() > GRACE_MS;
  }

  async #dueRun(due: Due): Promise<void> {
    const { row, at } = due;
    const nextRunAt = this.#nextAfter(row);
    if (this.#missed(at)) {
      this.#activity.record("schedule.run", {
        serverId: row.serverId,
        actor: "system",
        data: {
          scheduleId: row.id,
          changeSetId: null,
          result: "missed",
          due: at.toISOString(),
        },
      });
      const done = row.kind === "once" ? { state: "missed" } : {};
      this.#update(row.id, {
        nextRunAt,
        lastRunAt: at.toISOString(),
        lastResult: "missed",
        lastChangeSetId: null,
        ...done,
      });
      return;
    }
    // A revert still owed by an earlier run (a cron revert longer than the
    // period) keeps its time and the values it writes back: those are the
    // values from before the first run, and this run must not drop them.
    const owed = row.revertDueAt !== null && row.revertEnc !== null;
    const outcome = await this.#write(row, this.#edits(row), !owed);
    const revertDue = this.#revertDue(row, at, outcome.result);
    const previous = outcome.previous ?? [];
    const revertEnc =
      revertDue === null || previous.length === 0
        ? null
        : this.#encrypt(previous, REVERT_CONTEXT);
    const finished =
      row.kind === "once" && (revertDue === null || revertEnc === null);
    const revert = owed
      ? {}
      : { revertDueAt: revertEnc === null ? null : revertDue, revertEnc };
    this.#update(row.id, {
      nextRunAt,
      lastRunAt: at.toISOString(),
      lastResult: outcome.result,
      lastChangeSetId: outcome.changeSetId,
      ...revert,
      ...(finished ? { state: "done" } : {}),
    });
    this.#activity.record("schedule.run", {
      serverId: row.serverId,
      actor: row.author,
      data: {
        scheduleId: row.id,
        changeSetId: outcome.changeSetId,
        result: outcome.result,
        due: at.toISOString(),
        ...(outcome.error === null ? {} : { error: outcome.error }),
      },
    });
  }

  /** When the revert of a run is due, or null when there is none. */
  #revertDue(row: ScheduleRow, at: Date, result: RunResult): string | null {
    // Only a change that was written, or that waits for a stop, is undone.
    if (result !== "applied" && result !== "pending") return null;
    if (row.revertAt !== null) return row.revertAt;
    if (row.revertAfterMinutes === null) return null;
    const minutes = row.revertAfterMinutes * 60 * 1000;
    return new Date(at.getTime() + minutes).toISOString();
  }

  async #dueRevert(due: Due): Promise<void> {
    const { row, at } = due;
    const finished = row.kind === "once" ? { state: "done" } : {};
    let result: RunResult = "missed";
    let changeSetId: string | null = null;
    let error: string | null = null;
    if (!this.#missed(at) && row.revertEnc !== null) {
      const text = this.#aead.decryptText(row.revertEnc, REVERT_CONTEXT);
      const outcome = await this.#write(
        row,
        JSON.parse(text) as SettingEdit[],
        false,
      );
      ({ result, changeSetId, error } = outcome);
    }
    this.#update(row.id, {
      revertDueAt: null,
      revertEnc: null,
      lastRevertAt: at.toISOString(),
      lastRevertResult: result,
      ...finished,
    });
    this.#activity.record("schedule.reverted", {
      serverId: row.serverId,
      actor: result === "missed" ? "system" : row.author,
      data: {
        scheduleId: row.id,
        changeSetId,
        result,
        due: at.toISOString(),
        ...(error === null ? {} : { error }),
      },
    });
  }

  /**
   * True while the author may still write on the server: the user exists
   * and holds write access there with the role of the moment (a user who
   * lost the grant, or acts as a viewer, no longer changes the server).
   */
  #authorCanWrite(row: ScheduleRow): boolean {
    const user = this.#store.db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, row.author))
      .get();
    if (user === undefined) return false;
    const principal = this.#team.principalOf(user);
    const grant = this.#team.grantLevel(user.id, row.serverId);
    return serverLevel(principal, grant) === "write";
  }

  /**
   * Makes and applies one change set of cause schedule. With remember, the
   * values the files hold now for the edited settings are returned, so the
   * revert can write them back; a setting the files do not hold has no value
   * to go back to and is left out.
   */
  async #write(
    row: ScheduleRow,
    edits: readonly SettingEdit[],
    remember: boolean,
  ): Promise<{
    result: RunResult;
    changeSetId: string | null;
    error: string | null;
    previous: SettingEdit[] | null;
  }> {
    const failed = (error: string) => ({
      result: "failed" as const,
      changeSetId: null,
      error,
      previous: null,
    });
    if (!this.#authorCanWrite(row)) return failed("author_cannot_write");
    const server = this.#servers.get(row.serverId);
    if (server === null) return failed("server_not_found");
    let previous: SettingEdit[] | null = null;
    let changeSetId: string | null = null;
    const reverts = row.revertAt !== null || row.revertAfterMinutes !== null;
    try {
      if (remember && reverts) {
        const values = await this.#changes.controlValues(server);
        previous = [];
        for (const edit of edits) {
          const value = await values(edit.key);
          if (value !== undefined) previous.push({ key: edit.key, value });
        }
      }
      const draft = await this.#changes.create(
        server,
        { edits },
        row.author,
        "schedule",
      );
      changeSetId = draft.id;
      const runHooks = row.runHooks as RunHooks;
      const applied = await this.#changes.apply(draft.id, row.author, runHooks);
      const status = applied.status;
      const result: RunResult =
        status === "applied" || status === "pending" || status === "conflict"
          ? status
          : "failed";
      const error = applied.error?.code ?? null;
      return { result, changeSetId, error, previous };
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "no_change") {
          const result = "no_change" as const;
          return { result, changeSetId, error: null, previous: null };
        }
        return { ...failed(error.code), changeSetId };
      }
      if (error instanceof ConnectorError || error instanceof ControlError) {
        return { ...failed(error.code), changeSetId };
      }
      // Anything else is still a result: recorded as failed, so the run
      // moves on to its next time instead of retrying every tick.
      this.#log.error({ err: error, schedule: row.id }, "schedule run failed");
      return { ...failed("internal"), changeSetId };
    }
  }

  /** Starts the scheduler job and runs one tick at once (missed runs). */
  start(): void {
    const run = async () => {
      await this.tick();
    };
    this.#job = new Cron(TICK_PATTERN, { protect: true }, run);
    void run();
  }

  /** Stops the job and waits for a running tick. */
  async stop(): Promise<void> {
    this.#job?.stop();
    this.#job = null;
    if (this.#ticking !== null) await this.#ticking;
  }
}
