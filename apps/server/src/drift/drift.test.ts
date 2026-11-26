// Background drift detection on Local servers (dev-work-plan P9-A step 4,
// Paid feature drift.background), on a fake clock: the tests call tick()
// where the croner job would. An edit made outside the app becomes its own
// history entry of cause external with an external snapshot and the event
// drift.detected (via background); each server has its own interval
// (default 15 minutes, at least 5); a server that cannot be read is an error
// result and the others are still checked. On Free the job checks nothing,
// while the outside-edit detection on open stays Always Free (contract C1).
// The SFTP side runs in drift.integration.test.ts.
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityOf,
  apiOf,
  editOutside,
  history,
  PALWORLD_SETTINGS,
} from "../../test/servers.js";
import {
  call,
  teamFixture,
  toFree,
  toPaid,
  type TeamFixture,
} from "../../test/team.js";
import { DEFAULT_INTERVAL_MINUTES } from "./service.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const START = Date.parse("2026-12-01T10:00:00.000Z");
const MINUTE = 60_000;

let clock = START;
let t: TeamFixture;

const iso = (minutes: number) =>
  new Date(START + minutes * MINUTE).toISOString();

async function tickAt(minutes: number): Promise<void> {
  clock = START + minutes * MINUTE;
  await t.app.ctx.drift.tick();
}

interface DriftBody {
  serverId: string;
  enabled: boolean;
  intervalMinutes: number;
  lastCheckedAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastChangeSetId: string | null;
  nextCheckAt: string | null;
}

const viewOf = (serverId: string) => t.app.ctx.drift.get(serverId) as DriftBody;

const outsideEdit = (root: string, to: string) =>
  editOutside(root, PALWORLD_SETTINGS, "ServerPlayerMaxNum=32", to);

async function driftEvents(slug: string) {
  const rows = await activityOf(apiOf(t.app, t.owner), slug);
  return rows.filter((row) => row.type === "drift.detected");
}

beforeEach(async () => {
  clock = START;
  t = await teamFixture({ now: () => new Date(clock) });
});

afterEach(async () => {
  await t.current.close();
});

describe("background drift checks", () => {
  it("lists every visible server, on and every 15 minutes by default", async () => {
    const owner = await call(t.app, t.owner, "GET", "/api/v1/drift");
    expect(owner.statusCode).toBe(200);
    const items = owner.json<{ items: DriftBody[] }>().items;
    expect(items.map((item) => item.serverId)).toEqual([
      t.servers.a,
      t.servers.b,
    ]);
    expect(items[0]).toEqual({
      serverId: t.servers.a,
      enabled: true,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      lastCheckedAt: null,
      lastResult: null,
      lastError: null,
      lastChangeSetId: null,
      nextCheckAt: iso(15),
    });
    const editor = await call(t.app, t.editor, "GET", "/api/v1/drift");
    expect(
      editor.json<{ items: DriftBody[] }>().items.map((item) => item.serverId),
    ).toEqual([t.servers.a]);
    const loner = await call(t.app, t.loner, "GET", "/api/v1/drift");
    expect(loner.json<{ items: DriftBody[] }>().items).toEqual([]);
  });

  it("records an outside edit as an external history entry and event", async () => {
    await tickAt(0);
    expect(viewOf(t.servers.a)).toMatchObject({
      lastCheckedAt: iso(0),
      lastResult: "clean",
    });
    await outsideEdit(t.servers.rootA, "ServerPlayerMaxNum=12");
    // Not due yet: the last check was 10 minutes ago.
    await tickAt(10);
    expect(await driftEvents(t.servers.a)).toEqual([]);

    await tickAt(15);
    const view = viewOf(t.servers.a);
    expect(view).toMatchObject({ lastCheckedAt: iso(15), lastResult: "drift" });
    const events = await driftEvents(t.servers.a);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      changeSetId: view.lastChangeSetId,
      files: ["settings"],
      via: "background",
    });
    const entries = (await history(apiOf(t.app, t.owner), t.servers.a)).entries;
    const entry = entries.find(
      (item) => item.changeSetId === view.lastChangeSetId,
    );
    expect(entry).toMatchObject({
      cause: "external",
      author: "outside the app",
    });
    expect(entry?.snapshots.map((snapshot) => snapshot.kind)).toContain(
      "external",
    );

    // The same files again: clean, and no second entry.
    await tickAt(30);
    expect(viewOf(t.servers.a)).toMatchObject({
      lastResult: "clean",
      lastChangeSetId: view.lastChangeSetId,
    });
    expect(await driftEvents(t.servers.a)).toHaveLength(1);
  });

  it("follows each server's own interval and skips a server turned off", async () => {
    const api = apiOf(t.app, t.owner);
    const tooShort = await api.put(`/api/v1/servers/${t.servers.a}/drift`, {
      enabled: true,
      intervalMinutes: 4,
    });
    expect(tooShort.statusCode).toBe(400);
    const five = await api.put(`/api/v1/servers/${t.servers.a}/drift`, {
      enabled: true,
      intervalMinutes: 5,
    });
    expect(five.statusCode).toBe(200);
    expect(five.json()).toMatchObject({ enabled: true, intervalMinutes: 5 });
    const off = await api.put(`/api/v1/servers/${t.servers.b}/drift`, {
      enabled: false,
      intervalMinutes: 15,
    });
    expect(off.json()).toMatchObject({ enabled: false, nextCheckAt: null });

    await tickAt(0);
    await outsideEdit(t.servers.rootA, "ServerPlayerMaxNum=13");
    await outsideEdit(t.servers.rootB, "ServerPlayerMaxNum=14");
    await tickAt(5);
    expect(viewOf(t.servers.a).lastResult).toBe("drift");
    expect(viewOf(t.servers.b)).toMatchObject({
      enabled: false,
      lastCheckedAt: null,
    });
    await tickAt(60);
    expect(await driftEvents(t.servers.b)).toEqual([]);
  });

  it("stores a connector failure as an error and checks the others", async () => {
    // demo-b's settings folder cannot be read: the connector fails.
    const folder = join(t.servers.rootB, dirname(PALWORLD_SETTINGS));
    await chmod(folder, 0o000);
    try {
      await outsideEdit(t.servers.rootA, "ServerPlayerMaxNum=15");
      await tickAt(0);
      expect(viewOf(t.servers.b)).toMatchObject({ lastResult: "error" });
      expect(viewOf(t.servers.b).lastError).toEqual(expect.any(String));
      expect(viewOf(t.servers.a).lastResult).toBe("drift");
    } finally {
      await chmod(folder, 0o755);
    }
  });

  it("checks one server now through the API", async () => {
    await outsideEdit(t.servers.rootA, "ServerPlayerMaxNum=16");
    const response = await call(
      t.app,
      t.viewer,
      "POST",
      `/api/v1/servers/${t.servers.a}/drift/check`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      serverId: t.servers.a,
      lastResult: "drift",
      lastCheckedAt: iso(0),
    });
  });
});

describe("drift checks on the Free plan", () => {
  it("checks nothing on Free, keeps detection on open, resumes on Paid", async () => {
    const api = apiOf(t.app, t.owner);
    await api.put(`/api/v1/servers/${t.servers.a}/drift`, {
      enabled: true,
      intervalMinutes: 30,
    });
    await toFree(t.app, t.owner);
    await outsideEdit(t.servers.rootA, "ServerPlayerMaxNum=17");
    await tickAt(60);
    expect(viewOf(t.servers.a).lastCheckedAt).toBeNull();
    expect(await driftEvents(t.servers.a)).toEqual([]);
    const refused = await api.get("/api/v1/drift");
    expect(refused.statusCode).toBe(402);

    // Opening the editor still finds the outside edit (Always Free).
    const settings = await api.get(`/api/v1/servers/${t.servers.a}/settings`);
    expect(settings.statusCode).toBe(200);
    const events = await driftEvents(t.servers.a);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).not.toHaveProperty("via");

    await toPaid(t.app, t.owner);
    await editOutside(
      t.servers.rootA,
      PALWORLD_SETTINGS,
      "ServerPlayerMaxNum=17",
      "ServerPlayerMaxNum=18",
    );
    await tickAt(61);
    // The interval set before the Free period is kept.
    expect(viewOf(t.servers.a)).toMatchObject({
      intervalMinutes: 30,
      lastResult: "drift",
    });
  });
});
