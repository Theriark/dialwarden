// Scheduled changes (dev-work-plan P9-A step 3, Paid feature schedules), on
// a fake clock: the app's now() is a variable the tests move, and the tests
// call tick() where the croner job would. A run-at schedule runs once and
// reverts at its revert time; a cron schedule runs on its pattern and
// reverts some minutes after each run; a run missed while the app was down
// runs once inside the one-hour grace window and is marked missed outside
// it; on Free every schedule is paused (nothing runs or reverts) and Paid
// resumes them. Each run is a change set of cause schedule and writes
// schedule.run, each revert schedule.reverted (contract C6).
import { SECRET_MASK } from "@dialwarden/packs-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityOf,
  apiOf,
  editOutside,
  fileText,
  PALWORLD_SETTINGS,
} from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  toFree,
  toPaid,
  type TeamFixture,
} from "../../test/team.js";
import { GRACE_MS } from "./service.js";

const START = Date.parse("2026-12-01T10:00:00.000Z");
const MINUTE = 60_000;

let clock = START;
let t: TeamFixture;

const at = (minutes: number) => new Date(START + minutes * MINUTE);
const iso = (minutes: number) => at(minutes).toISOString();

/** Moves the clock to START plus minutes and runs one scheduler tick. */
async function tickAt(minutes: number): Promise<void> {
  clock = START + minutes * MINUTE;
  await t.app.ctx.schedules.tick();
}

interface ScheduleBody {
  id: string;
  kind: string;
  state: string;
  pausedReason: string | null;
  nextRunAt: string | null;
  revertDueAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  lastChangeSetId: string | null;
  lastRevertResult: string | null;
  edits: { settingKey: string; value: unknown }[];
}

/** POST /api/v1/schedules as the owner; fails the test unless 201. */
async function schedule(body: Record<string, unknown>): Promise<ScheduleBody> {
  const response = await apiOf(t.app, t.owner).post("/api/v1/schedules", {
    server: t.servers.a,
    name: "evening",
    edits: [{ settingKey: INT_SETTING, value: 7 }],
    ...body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`schedule: ${response.statusCode} ${response.body}`);
  }
  return response.json<ScheduleBody>();
}

/** The schedule as the service holds it (works on Free too). */
const stateOf = (id: string) =>
  t.app.ctx.schedules.get(id) as unknown as ScheduleBody;

const maxPlayers = async () => {
  const text = await fileText(t.servers.rootA, PALWORLD_SETTINGS);
  return /ServerPlayerMaxNum=(\d+)/.exec(text)?.[1];
};

/** The change sets of cause schedule on demo-a. */
function scheduleChangeSets(): number {
  const row = t.app.ctx.store.sqlite
    .prepare(
      "SELECT count(*) AS n FROM change_sets WHERE cause = 'schedule' AND server_id = ?",
    )
    .get(t.servers.a) as { n: number };
  return row.n;
}

async function scheduleEvents() {
  const rows = await activityOf(apiOf(t.app, t.owner), t.servers.a);
  return rows.filter((row) => row.type.startsWith("schedule."));
}

beforeEach(async () => {
  clock = START;
  t = await teamFixture({ now: () => new Date(clock) });
});

afterEach(async () => {
  await t.current.close();
});

describe("run-at schedules", () => {
  it("runs at its time as a change set of cause schedule and reverts", async () => {
    const made = await schedule({ runAt: iso(10), revertAt: iso(70) });
    expect(made).toMatchObject({
      kind: "once",
      state: "active",
      pausedReason: null,
      nextRunAt: iso(10),
    });
    await tickAt(5);
    expect(await maxPlayers()).toBe("32");
    expect(scheduleChangeSets()).toBe(0);

    await tickAt(10.5);
    expect(await maxPlayers()).toBe("7");
    const ran = stateOf(made.id);
    expect(ran).toMatchObject({
      state: "active",
      nextRunAt: null,
      lastRunAt: iso(10),
      lastResult: "applied",
      revertDueAt: iso(70),
    });
    const changeSet = await apiOf(t.app, t.owner).get(
      `/api/v1/change-sets/${ran.lastChangeSetId ?? ""}`,
    );
    expect(changeSet.json<{ cause: string }>().cause).toBe("schedule");

    await tickAt(71);
    expect(await maxPlayers()).toBe("32");
    expect(stateOf(made.id)).toMatchObject({
      state: "done",
      revertDueAt: null,
      lastRevertResult: "applied",
    });
    const events = await scheduleEvents();
    expect(events.map((row) => row.type)).toEqual([
      "schedule.run",
      "schedule.reverted",
    ]);
    // The run acts as its author; the activity API shows the author's label.
    expect(events[0]?.actor).toBe(t.owner.email);
    expect(events[0]?.data).toMatchObject({
      scheduleId: made.id,
      result: "applied",
      due: iso(10),
    });
    expect(events[1]?.data).toMatchObject({
      scheduleId: made.id,
      result: "applied",
    });
    expect(scheduleChangeSets()).toBe(2);
  });

  it("runs once without a revert and is done", async () => {
    const made = await schedule({ runAt: iso(10) });
    await tickAt(11);
    await tickAt(12);
    expect(stateOf(made.id)).toMatchObject({
      state: "done",
      lastResult: "applied",
      revertDueAt: null,
    });
    expect(scheduleChangeSets()).toBe(1);
    expect(await maxPlayers()).toBe("7");
  });

  it("records no_change when the files already hold the values", async () => {
    const made = await schedule({
      runAt: iso(10),
      revertAt: iso(20),
      edits: [{ settingKey: INT_SETTING, value: 32 }],
    });
    await tickAt(11);
    expect(stateOf(made.id)).toMatchObject({
      state: "done",
      lastResult: "no_change",
      revertDueAt: null,
    });
  });
});

describe("missed runs after a restart (grace window)", () => {
  it("runs once when it fell due inside the grace window", async () => {
    const made = await schedule({ runAt: iso(10) });
    // The app was down from minute 5 to minute 55: 45 minutes late.
    await tickAt(55);
    await tickAt(56);
    expect(stateOf(made.id)).toMatchObject({
      state: "done",
      lastResult: "applied",
    });
    expect(scheduleChangeSets()).toBe(1);
    expect(await maxPlayers()).toBe("7");
  });

  it("marks a run missed outside the grace window and writes nothing", async () => {
    const made = await schedule({ runAt: iso(10), revertAt: iso(400) });
    await tickAt(10 + GRACE_MS / MINUTE + 1);
    expect(stateOf(made.id)).toMatchObject({
      state: "missed",
      lastResult: "missed",
      lastChangeSetId: null,
      revertDueAt: null,
    });
    expect(await maxPlayers()).toBe("32");
    expect(scheduleChangeSets()).toBe(0);
    const events = await scheduleEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "schedule.run", actor: "system" });
    expect(events[0]?.data).toMatchObject({ result: "missed", due: iso(10) });
  });

  it("marks a revert missed outside the grace window", async () => {
    const made = await schedule({ runAt: iso(10), revertAt: iso(20) });
    await tickAt(11);
    await tickAt(20 + GRACE_MS / MINUTE + 1);
    expect(stateOf(made.id)).toMatchObject({
      state: "done",
      lastRevertResult: "missed",
    });
    expect(await maxPlayers()).toBe("7");
  });
});

describe("cron schedules", () => {
  it("runs on its pattern and reverts minutes after each run", async () => {
    const made = await schedule({
      cron: "0 * * * *",
      timezone: "Europe/Lisbon",
      revertAfterMinutes: 30,
    });
    expect(made).toMatchObject({ kind: "cron", nextRunAt: iso(60) });
    await tickAt(60.5);
    expect(await maxPlayers()).toBe("7");
    expect(stateOf(made.id)).toMatchObject({
      state: "active",
      lastRunAt: iso(60),
      nextRunAt: iso(120),
      revertDueAt: iso(90),
    });
    await tickAt(91);
    expect(await maxPlayers()).toBe("32");
    expect(stateOf(made.id).lastRevertResult).toBe("applied");
    await tickAt(120.5);
    expect(await maxPlayers()).toBe("7");
    expect(scheduleChangeSets()).toBe(3);
  });

  it("keeps the revert a run still owes when the next run comes first", async () => {
    // Hourly with a 90-minute revert: the 12:00 run comes before the 12:30
    // revert of the 11:00 run, finds the values already there, and must
    // leave that revert and the values from before 11:00 as they are.
    const made = await schedule({ cron: "0 * * * *", revertAfterMinutes: 90 });
    await tickAt(60.5);
    expect(await maxPlayers()).toBe("7");
    expect(stateOf(made.id).revertDueAt).toBe(iso(150));
    await tickAt(120.5);
    expect(stateOf(made.id)).toMatchObject({
      lastRunAt: iso(120),
      lastResult: "no_change",
      revertDueAt: iso(150),
      nextRunAt: iso(180),
    });
    await tickAt(150.5);
    expect(await maxPlayers()).toBe("32");
    expect(stateOf(made.id)).toMatchObject({
      revertDueAt: null,
      lastRevertResult: "applied",
    });
    // The next run starts the cycle again with a revert of its own.
    await tickAt(180.5);
    expect(await maxPlayers()).toBe("7");
    expect(stateOf(made.id).revertDueAt).toBe(iso(270));
    const events = await scheduleEvents();
    expect(events.map((row) => row.type)).toEqual([
      "schedule.run",
      "schedule.run",
      "schedule.reverted",
      "schedule.run",
    ]);
  });

  it("writes back the values from before the first run, not a later run's", async () => {
    const made = await schedule({ cron: "0 * * * *", revertAfterMinutes: 90 });
    await tickAt(60.5);
    // Someone changes the value outside the app before the next run.
    const from = "ServerPlayerMaxNum=7";
    await editOutside(
      t.servers.rootA,
      PALWORLD_SETTINGS,
      from,
      "ServerPlayerMaxNum=20",
    );
    await tickAt(120.5);
    expect(await maxPlayers()).toBe("7");
    expect(stateOf(made.id)).toMatchObject({
      lastResult: "applied",
      revertDueAt: iso(150),
    });
    await tickAt(150.5);
    expect(await maxPlayers()).toBe("32");
  });

  it("records an unexpected error as failed and moves on to the next run", async () => {
    const made = await schedule({ cron: "0 * * * *" });
    const create = vi
      .spyOn(t.app.ctx.changes, "create")
      .mockRejectedValueOnce(new Error("unexpected"));
    await tickAt(60.5);
    expect(stateOf(made.id)).toMatchObject({
      state: "active",
      lastRunAt: iso(60),
      lastResult: "failed",
      nextRunAt: iso(120),
    });
    // Not retried at the next tick: it waits for its next occurrence.
    await tickAt(61);
    expect(create).toHaveBeenCalledTimes(1);
    const events = await scheduleEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      result: "failed",
      error: "internal",
    });
    create.mockRestore();
    await tickAt(120.5);
    expect(stateOf(made.id).lastResult).toBe("applied");
    expect(await maxPlayers()).toBe("7");
  });

  it("runs once for many occurrences missed while the app was down", async () => {
    const made = await schedule({ cron: "0 * * * *" });
    // Down for five hours: the 15:00 run is 10 minutes late, the rest older.
    await tickAt(310);
    expect(stateOf(made.id)).toMatchObject({
      state: "active",
      lastRunAt: iso(300),
      lastResult: "applied",
      nextRunAt: iso(360),
    });
    expect(scheduleChangeSets()).toBe(1);
  });

  it("refuses a pattern that runs more often than every 5 minutes", async () => {
    const api = apiOf(t.app, t.owner);
    const base = {
      server: t.servers.a,
      name: "too often",
      edits: [{ settingKey: INT_SETTING, value: 7 }],
    };
    const cases: Record<string, unknown>[] = [
      { cron: "* * * * *" },
      { cron: "not a pattern" },
      { cron: "0 * * * *", timezone: "Mars/Olympus" },
      { cron: "0 * * * *", revertAt: iso(90) },
      { runAt: iso(10), cron: "0 * * * *" },
      { runAt: iso(-10) },
      { runAt: iso(10), revertAt: iso(5) },
      { runAt: iso(10), revertAfterMinutes: 5 },
      {},
    ];
    for (const extra of cases) {
      const response = await api.post("/api/v1/schedules", {
        ...base,
        ...extra,
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    const unknown = await api.post("/api/v1/schedules", {
      ...base,
      runAt: iso(10),
      edits: [{ settingKey: "NoSuchSetting", value: 1 }],
    });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    expect(unknown.statusCode).toBeLessThan(500);
    const rows = t.app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM schedules")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("the Free plan pauses schedules", () => {
  it("neither runs nor reverts on Free and resumes when Paid returns", async () => {
    const reverting = await schedule({ runAt: iso(10), revertAt: iso(40) });
    await tickAt(11);
    expect(await maxPlayers()).toBe("7");
    const later = await schedule({
      runAt: iso(50),
      edits: [{ settingKey: INT_SETTING, value: 9 }],
    });

    await toFree(t.app, t.owner);
    await tickAt(45);
    expect(stateOf(reverting.id)).toMatchObject({
      state: "paused",
      pausedReason: "paid",
      revertDueAt: iso(40),
    });
    expect(stateOf(later.id).state).toBe("paused");
    expect(await maxPlayers()).toBe("7");
    const free = await call(t.app, t.owner, "GET", "/api/v1/schedules");
    expect(free.statusCode).toBe(402);

    await tickAt(55);
    expect(await maxPlayers()).toBe("7");

    await toPaid(t.app, t.owner);
    // Still inside the grace window: the revert of minute 40 and the run of
    // minute 50 both happen now, the revert first.
    await tickAt(58);
    expect(stateOf(reverting.id)).toMatchObject({
      state: "done",
      lastRevertResult: "applied",
    });
    expect(stateOf(later.id)).toMatchObject({
      state: "done",
      lastResult: "applied",
    });
    expect(await maxPlayers()).toBe("9");
  });

  it("marks a run missed when Paid returns after the grace window", async () => {
    const made = await schedule({ runAt: iso(10) });
    await toFree(t.app, t.owner);
    await tickAt(20);
    expect(stateOf(made.id).state).toBe("paused");
    await toPaid(t.app, t.owner);
    await tickAt(10 + GRACE_MS / MINUTE + 5);
    expect(stateOf(made.id)).toMatchObject({
      state: "missed",
      lastResult: "missed",
    });
    expect(await maxPlayers()).toBe("32");
  });
});

describe("who a schedule acts as", () => {
  it("fails a run whose author lost write access to the server", async () => {
    const response = await call(t.app, t.editor, "POST", "/api/v1/schedules", {
      server: t.servers.a,
      name: "editor's",
      edits: [{ settingKey: INT_SETTING, value: 7 }],
      runAt: iso(10),
    });
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    const grants = await call(
      t.app,
      t.owner,
      "PUT",
      `/api/v1/users/${t.editor.userId}/grants`,
      { servers: [] },
    );
    expect(grants.statusCode).toBe(200);
    await tickAt(11);
    expect(stateOf(id)).toMatchObject({
      state: "done",
      lastResult: "failed",
      lastChangeSetId: null,
    });
    expect(await maxPlayers()).toBe("32");
    const events = await scheduleEvents();
    expect(events[0]?.data).toMatchObject({
      result: "failed",
      error: "author_cannot_write",
    });
  });

  it("lists only the schedules of servers the caller may see", async () => {
    await schedule({ runAt: iso(10) });
    await schedule({ runAt: iso(10), server: t.servers.b });
    const list = async (who: typeof t.owner) => {
      const response = await call(t.app, who, "GET", "/api/v1/schedules");
      expect(response.statusCode).toBe(200);
      return response
        .json<{ items: { serverId: string }[] }>()
        .items.map((item) => item.serverId)
        .sort();
    };
    expect(await list(t.owner)).toEqual([t.servers.a, t.servers.b]);
    expect(await list(t.editor)).toEqual([t.servers.a]);
    expect(await list(t.viewer)).toEqual([t.servers.a]);
    expect(await list(t.loner)).toEqual([]);
  });

  it("masks the value of a secret setting in every answer", async () => {
    const made = await schedule({
      runAt: iso(10),
      edits: [{ settingKey: "AdminPassword", value: "hunter-2-secret" }],
    });
    expect(JSON.stringify(made)).not.toContain("hunter-2-secret");
    const one = await apiOf(t.app, t.owner).get(`/api/v1/schedules/${made.id}`);
    expect(one.body).not.toContain("hunter-2-secret");
    const stored = t.app.ctx.store.sqlite
      .prepare("SELECT payload_enc FROM schedules WHERE id = ?")
      .get(made.id) as { payload_enc: string };
    expect(stored.payload_enc).not.toContain("hunter-2-secret");
  });

  it("masks every value when the server's pack is no longer known", async () => {
    const made = await schedule({
      runAt: iso(10),
      edits: [
        { settingKey: "AdminPassword", value: "hunter-2-secret" },
        { settingKey: INT_SETTING, value: 7 },
      ],
    });
    // A pack id this image no longer ships: which settings are secret is
    // unknown, so nothing is shown in clear.
    t.app.ctx.store.sqlite
      .prepare("UPDATE servers SET pack_id = 'retired-pack' WHERE id = ?")
      .run(t.servers.a);
    const one = await apiOf(t.app, t.owner).get(`/api/v1/schedules/${made.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toContain("hunter-2-secret");
    expect(one.json<ScheduleBody>().edits).toEqual([
      { settingKey: "AdminPassword", value: SECRET_MASK },
      { settingKey: INT_SETTING, value: SECRET_MASK },
    ]);
  });

  it("removes a schedule, and a revert still due is dropped", async () => {
    const made = await schedule({ runAt: iso(10), revertAt: iso(40) });
    await tickAt(11);
    const removed = await apiOf(t.app, t.owner).delete(
      `/api/v1/schedules/${made.id}`,
    );
    expect(removed.statusCode).toBe(204);
    await tickAt(41);
    expect(await maxPlayers()).toBe("7");
    const again = await apiOf(t.app, t.owner).get(
      `/api/v1/schedules/${made.id}`,
    );
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "schedule_not_found" });
  });
});
