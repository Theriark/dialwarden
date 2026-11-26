// The demo seed (dev-work-plan P4-B step 5, the P7 rule): with DEMO_SEED
// true, every start adds any demo-GAME server still missing: a pack gets
// DEMO_SERVERS_DIR/GAME from its synthetic fixtures, registered as the Local
// server demo-GAME with 3 history entries, one of them an outside edit. A
// server that already exists (demo or not) is never touched, and DEMO_SEED
// false seeds nothing. P10 (THE-2855) adds demo-valheim-2 and demo-valheim-3
// with their own launch values and the import entry only.
import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { customerLicence, testKeyRing } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  BUILD_ENV,
  discard,
  NO_BUILD_INFO_FILE,
  setupOwner,
  tempDir,
} from "../../test/helpers.js";
import {
  addServer,
  apiOf,
  history,
  palworldFolder,
  PALWORLD_SETTINGS,
  type Api,
} from "../../test/servers.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

let base: string;
let dataDir: string;
let demoDir: string;
let appKey: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  base = await tempDir("dialwarden-demo-");
  dataDir = join(base, "data");
  demoDir = join(base, "demo-servers");
  appKey = randomBytes(32).toString("hex");
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(base, { recursive: true, force: true });
});

/** Starts the app on the test's data folder (kept between starts). */
async function start(
  demoSeed: boolean,
  extraEnv: Record<string, string> = {},
): Promise<FastifyInstance> {
  await app?.close();
  app = await buildApp({
    keys: testKeyRing,
    out: discard(),
    buildInfoFile: NO_BUILD_INFO_FILE,
    env: {
      LOG_LEVEL: "silent",
      DATA_DIR: dataDir,
      APP_SECRET_KEY: appKey,
      DEMO_SEED: demoSeed ? "true" : "false",
      DEMO_SERVERS_DIR: demoDir,
      ...BUILD_ENV,
      ...extraEnv,
    },
  });
  return app;
}

const EXTRA = ["demo-valheim-2", "demo-valheim-3"];

async function serverIds(api: Api): Promise<string[]> {
  const response = await api.get("/api/v1/servers");
  const items = response.json<{ items: { id: string }[] }>().items;
  return items.map((item) => item.id).sort();
}

describe("demo seed", () => {
  it("seeds one demo server per pack, with 3 entries each", async () => {
    const started = await start(true);
    const api = apiOf(started, await setupOwner(started));
    // Every pack with a demo seeds its server; Valheim joined in P6 and
    // the other four games in P7 (dev-work-plan P7 step 7).
    expect(await serverIds(api)).toEqual([
      "demo-7dtd",
      "demo-ark-sa",
      "demo-enshrouded",
      "demo-palworld",
      "demo-pzomboid",
      "demo-rust",
      "demo-valheim",
      ...EXTRA,
    ]);
    const palworld = await api.get("/api/v1/servers/demo-palworld");
    expect(palworld.json()).toMatchObject({
      packId: "palworld",
      os: "linux",
      demo: true,
      connector: { kind: "local", root: join(demoDir, "palworld") },
    });
    const settings = join(demoDir, "palworld", PALWORLD_SETTINGS);
    expect((await stat(settings)).isFile()).toBe(true);
    expect(await readdir(join(demoDir, "enshrouded"))).toContain(
      "enshrouded_server.json",
    );
    // On Free the first three servers are editable: enshrouded, the third,
    // gets the app's change; palworld, the fourth, only the import and the
    // outside edit.
    for (const slug of ["demo-enshrouded", "demo-palworld"]) {
      const past = await history(api, slug);
      const causes = past.entries.map((entry) => entry.cause);
      const app = slug === "demo-enshrouded" ? ["app"] : [];
      expect(causes, slug).toEqual(["external", ...app, "import"]);
      const statuses = new Set(past.entries.map((entry) => entry.status));
      expect([...statuses], slug).toEqual(["applied"]);
      const [outside] = past.entries;
      expect(outside?.author).toBe("outside the app");
      expect(outside?.chips.length, slug).toBe(1);
    }
    const enshrouded = await history(api, "demo-enshrouded");
    expect(enshrouded.entries.at(1)?.author).toBe("Dialwarden demo");
  });

  it("adds missing demo servers next to a server that already exists", async () => {
    const first = await start(false);
    const owner = await setupOwner(first);
    const root = await palworldFolder(base);
    await addServer(apiOf(first, owner), "Own server", root);
    const again = await start(true);
    const servers = again.ctx.servers.list().map((server) => server.id);
    expect(servers.at(0)).toBe("own-server");
    expect(servers).toHaveLength(10);
    expect((await stat(demoDir)).isDirectory()).toBe(true);
  });

  it("does not touch demo servers that already exist", async () => {
    const first = await start(true);
    const seeded = first.ctx.servers.require("demo-enshrouded");
    const before = first.ctx.changes.history(seeded);
    const again = await start(true);
    expect(again.ctx.servers.count()).toBe(9);
    const kept = again.ctx.servers.require("demo-enshrouded");
    const after = again.ctx.changes.history(kept);
    expect(after.entries).toHaveLength(before.entries.length);
    expect(after.entries.map((entry) => entry.cause)).toEqual([
      "external",
      "app",
      "import",
    ]);
  });

  it("THE-2855 seeds two more Valheim servers with their own values", async () => {
    const paid = { DIALWARDEN_LICENCE: customerLicence() };
    const started = await start(true, paid);
    const api = apiOf(started, await setupOwner(started));
    const expected = new Map<string, Record<string, unknown>>([
      ["demo-valheim-2", { name: "Quarry Lane North", port: 2466 }],
      ["demo-valheim-3", { name: "Quarry Lane South", public: 0 }],
    ]);
    for (const slug of EXTRA) {
      const server = await api.get(`/api/v1/servers/${slug}`);
      expect(server.json()).toMatchObject({
        packId: "valheim",
        demo: true,
        lastEditedAt: null,
        connector: { kind: "local", root: join(demoDir, slug.slice(5)) },
      });
      const past = await history(api, slug);
      expect(
        past.entries.map((entry) => entry.cause),
        slug,
      ).toEqual(["import"]);
      const read = await api.get(`/api/v1/servers/${slug}/settings`);
      const settings = read.json<{
        values: Record<string, unknown>;
        lint: { severity: string; code: string }[];
      }>();
      expect(settings.values, slug).toMatchObject(expected.get(slug) ?? {});
      const errors = settings.lint.filter((item) => item.severity === "error");
      expect(errors, slug).toEqual([]);
    }
    const matrix = await api.get("/api/v1/fleet/matrix?game=valheim");
    expect(matrix.statusCode).toBe(200);
    const body = matrix.json<{
      servers: { id: string }[];
      rows: { key: string; differs: boolean }[];
    }>();
    expect(body.servers.map((server) => server.id).sort()).toEqual([
      "demo-valheim",
      ...EXTRA,
    ]);
    const differing = body.rows.filter((row) => row.differs);
    expect(differing.map((row) => row.key)).toEqual(
      expect.arrayContaining(["name", "port", "world"]),
    );
  });

  it("THE-2855 gives a database of the first 7 demo servers the 2 new ones", async () => {
    const first = await start(true);
    for (const slug of EXTRA) first.ctx.servers.remove(slug);
    expect(first.ctx.servers.count()).toBe(7);
    const seeded = first.ctx.servers.require("demo-valheim");
    const before = first.ctx.changes.history(seeded).entries.length;
    const again = await start(true);
    expect(again.ctx.servers.count()).toBe(9);
    for (const slug of EXTRA) {
      const server = again.ctx.servers.require(slug);
      expect(again.ctx.changes.history(server).entries).toHaveLength(1);
    }
    const kept = again.ctx.servers.require("demo-valheim");
    expect(again.ctx.changes.history(kept).entries).toHaveLength(before);
  });

  it("seeds one in-app notification channel once (phase-report-09 G3)", async () => {
    const inApp = (started: FastifyInstance) =>
      started.ctx.channels
        .list()
        .filter((channel) => channel.kind === "in_app");
    const first = await start(true);
    const made = inApp(first);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ enabled: true, name: "In-app (demo)" });
    expect(made[0]?.types).toContain("change.applied");
    const again = await start(true);
    expect(inApp(again)).toHaveLength(1);
    // The owner removes it: the next start does not make it again.
    again.ctx.channels.remove(made[0]?.id ?? "");
    const third = await start(true);
    expect(inApp(third)).toHaveLength(0);
  });

  // P10-A G1.6: the demo folder never lands in the data folder.
  it("G1.6 seeds nothing when DEMO_SERVERS_DIR is inside DATA_DIR", async () => {
    const inside = join(dataDir, "demo");
    const started = await start(true, { DEMO_SERVERS_DIR: inside });
    expect(started.ctx.servers.count()).toBe(0);
    expect(await readdir(dataDir)).not.toContain("demo");
  });

  it("seeds nothing without DEMO_SEED", async () => {
    const started = await start(false);
    expect(started.ctx.servers.count()).toBe(0);
    expect(started.ctx.channels.list()).toEqual([]);
    await expect(stat(demoDir)).rejects.toThrow();
  });
});
