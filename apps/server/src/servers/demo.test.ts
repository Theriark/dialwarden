// The demo seed (dev-work-plan P4-B step 5): with DEMO_SEED true and no
// server yet, every pack gets DEMO_SERVERS_DIR/GAME from its synthetic
// fixtures, registered as the Local server demo-GAME with 3 history entries,
// one of them an outside edit. A servers table that is not empty seeds
// nothing, and neither does DEMO_SEED false.
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
  it("seeds demo-palworld and demo-enshrouded with 3 entries each", async () => {
    const started = await start(true);
    const api = apiOf(started, await setupOwner(started));
    expect(await serverIds(api)).toEqual(["demo-enshrouded", "demo-palworld"]);
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
    for (const slug of ["demo-palworld", "demo-enshrouded"]) {
      const past = await history(api, slug);
      const causes = past.entries.map((entry) => entry.cause);
      expect(causes, slug).toEqual(["external", "app", "import"]);
      const statuses = new Set(past.entries.map((entry) => entry.status));
      expect([...statuses], slug).toEqual(["applied"]);
      const [outside, made] = past.entries;
      expect(outside?.author).toBe("outside the app");
      expect(made?.author).toBe("Dialwarden demo");
      expect(outside?.chips.length, slug).toBe(1);
    }
  });

  it("seeds nothing when a server exists", async () => {
    const first = await start(false);
    const owner = await setupOwner(first);
    const root = await palworldFolder(base);
    await addServer(apiOf(first, owner), "Own server", root);
    const again = await start(true);
    const servers = again.ctx.servers.list().map((server) => server.id);
    expect(servers).toEqual(["own-server"]);
    await expect(stat(demoDir)).rejects.toThrow();
  });

  it("seeds nothing without DEMO_SEED", async () => {
    const started = await start(false);
    expect(started.ctx.servers.count()).toBe(0);
    await expect(stat(demoDir)).rejects.toThrow();
  });
});
