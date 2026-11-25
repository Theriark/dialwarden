// The demo seed (dev-work-plan P4-B step 5, the P7 rule): with DEMO_SEED
// true, every start adds any demo-GAME server still missing: a pack gets
// DEMO_SERVERS_DIR/GAME from its synthetic fixtures, registered as the Local
// server demo-GAME with 3 history entries, one of them an outside edit. A
// server that already exists (demo or not) is never touched, and DEMO_SEED
// false seeds nothing.
import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { testKeyRing } from "@dialwarden/entitlement/testing";
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
async function start(demoSeed: boolean): Promise<FastifyInstance> {
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
    },
  });
  return app;
}

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
    const expected = {
      "demo-enshrouded": ["external", "app", "import"],
      "demo-palworld": ["external", "import"],
    };
    for (const [slug, causes] of Object.entries(expected)) {
      const past = await history(api, slug);
      expect(past.entries.map((entry) => entry.cause), slug).toEqual(causes);
      const statuses = new Set(past.entries.map((entry) => entry.status));
      expect([...statuses], slug).toEqual(["applied"]);
      const [outside] = past.entries;
      expect(outside?.author).toBe("outside the app");
      expect(outside?.chips.length, slug).toBe(1);
    }
    const made = (await history(api, "demo-enshrouded")).entries.at(1);
    expect(made?.author).toBe("Dialwarden demo");
  });

  it("adds missing demo servers next to a server that already exists", async () => {
    const first = await start(false);
    const owner = await setupOwner(first);
    const root = await palworldFolder(base);
    await addServer(apiOf(first, owner), "Own server", root);
    const again = await start(true);
    const servers = again.ctx.servers.list().map((server) => server.id);
    expect(servers.at(0)).toBe("own-server");
    expect(servers).toHaveLength(8);
    expect((await stat(demoDir)).isDirectory()).toBe(true);
  });

  it("does not touch demo servers that already exist", async () => {
    const first = await start(true);
    const before = first.ctx.changes.history(
      first.ctx.servers.require("demo-enshrouded"),
    );
    const again = await start(true);
    expect(again.ctx.servers.count()).toBe(7);
    const after = again.ctx.changes.history(
      again.ctx.servers.require("demo-enshrouded"),
    );
    expect(after.entries).toHaveLength(before.entries.length);
    expect(after.entries.map((entry) => entry.cause)).toEqual([
      "external",
      "app",
      "import",
    ]);
  });

  it("seeds nothing without DEMO_SEED", async () => {
    const started = await start(false);
    expect(started.ctx.servers.count()).toBe(0);
    await expect(stat(demoDir)).rejects.toThrow();
  });
});
