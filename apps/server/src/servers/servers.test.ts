// The servers API (dev-work-plan P4-B step 1) and the server limits of
// contract C1 (step 4): CRUD with slugs as ids, connection test and game
// detection, and the limit tests on Free, on Paid and after the licence is
// removed, where only the editable three can be changed.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { customerLicence } from "@dialwarden/entitlement/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import {
  addServer,
  apiOf,
  change,
  palworldFolder,
  type Api,
} from "../../test/servers.js";
import { slugFrom } from "../routes/servers.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

let current: TestApp | undefined;
let base: string;

beforeEach(async () => {
  base = await tempDir("dialwarden-servers-");
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  await rm(base, { recursive: true, force: true });
});

async function owner(extraEnv: Record<string, string> = {}): Promise<Api> {
  current = await testApp({ extraEnv });
  return apiOf(current.app, await setupOwner(current.app));
}

/** Adds Palworld servers from fresh folders; returns their slugs. */
async function addMany(api: Api, names: string[]): Promise<string[]> {
  const slugs: string[] = [];
  for (const name of names) {
    const root = await palworldFolder(base, name);
    slugs.push(await addServer(api, name, root));
  }
  return slugs;
}

interface ServerBody {
  id: string;
  editable: boolean;
  packId: string;
  os: string;
  name: string;
}

async function listed(api: Api): Promise<ServerBody[]> {
  const response = await api.get("/api/v1/servers");
  return response.json<{ items: ServerBody[] }>().items;
}

describe("servers API", () => {
  it("adds a Local server, detects its game and imports its files", async () => {
    const api = await owner();
    expect(await listed(api)).toEqual([]);
    const root = await palworldFolder(base);
    const response = await api.post("/api/v1/servers", {
      name: "Lighthouse Keepers (EU)",
      connector: { kind: "local", root },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "lighthouse-keepers-eu",
      name: "Lighthouse Keepers (EU)",
      packId: "palworld",
      displayName: "Palworld",
      os: "linux",
      connector: { kind: "local", root },
      hasPassword: false,
      demo: false,
      editable: true,
      lastEditedAt: null,
    });
    const one = await api.get("/api/v1/servers/lighthouse-keepers-eu");
    expect(one.statusCode).toBe(200);
    const test = await api.post("/api/v1/servers/lighthouse-keepers-eu/test");
    expect(test.json()).toMatchObject({ ok: true });
    const detect = await api.post(
      "/api/v1/servers/lighthouse-keepers-eu/detect",
    );
    const items = detect.json<{ items: { packId: string }[] }>().items;
    expect(items.map((item) => item.packId)).toEqual(["palworld"]);
  });

  it("takes a given slug, refuses a taken or malformed one", async () => {
    const api = await owner();
    const root = await palworldFolder(base);
    const connector = { kind: "local", root };
    const body = { id: "eu-1", name: "One", connector };
    expect((await api.post("/api/v1/servers", body)).statusCode).toBe(201);
    const again = await api.post("/api/v1/servers", body);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "server_exists" });
    const bad = { ...body, id: "Not A Slug" };
    expect((await api.post("/api/v1/servers", bad)).statusCode).toBe(400);
    const named = await api.post("/api/v1/servers", { name: "One", connector });
    expect(named.json()).toMatchObject({ id: "one" });
    const twin = await api.post("/api/v1/servers", { name: "One", connector });
    expect(twin.json()).toMatchObject({ id: "one-2" });
  });

  it("refuses a folder without a game, a missing one and the data folder", async () => {
    const api = await owner();
    const empty = join(base, "empty");
    await mkdir(empty);
    const add = (root: string) =>
      api.post("/api/v1/servers", {
        name: "X",
        connector: { kind: "local", root },
      });
    const none = await add(empty);
    expect(none.statusCode).toBe(422);
    expect(none.json()).toEqual({ error: "game_not_detected" });
    const missing = await add(join(base, "missing"));
    expect(missing.json()).toMatchObject({
      error: "connection_failed",
      code: "NotFound",
    });
    const data = await add(current?.dataDir ?? "/");
    expect(data.json()).toMatchObject({
      error: "connection_failed",
      code: "PathEscape",
    });
    expect(await listed(api)).toEqual([]);
  });

  it("renames, re-points and removes a server", async () => {
    const api = await owner();
    const [slug] = await addMany(api, ["alpha"]);
    const url = `/api/v1/servers/${slug}`;
    const renamed = await api.patch(url, { name: "Alpha Prime" });
    expect(renamed.json()).toMatchObject({ id: "alpha", name: "Alpha Prime" });
    const moved = await palworldFolder(base, "moved");
    const repointed = await api.patch(url, {
      connector: { kind: "local", root: moved },
    });
    expect(repointed.json()).toMatchObject({
      connector: { kind: "local", root: moved },
    });
    const broken = await api.patch(url, {
      connector: { kind: "local", root: join(base, "missing") },
    });
    expect(broken.statusCode).toBe(422);
    expect((await api.delete(url)).statusCode).toBe(204);
    const gone = await api.get(url);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: "server_not_found" });
  });

  it("makes slugs from names", () => {
    expect(slugFrom("Lighthouse Keepers, (EU)")).toBe("lighthouse-keepers-eu");
    expect(slugFrom("  ---  ")).toBe("server");
    expect(slugFrom("A".repeat(80))).toHaveLength(56);
  });
});

describe("server limits (contract C1)", () => {
  it("allows 3 servers on Free and answers 402 for a fourth", async () => {
    const api = await owner();
    await addMany(api, ["one", "two", "three"]);
    const root = await palworldFolder(base, "four");
    const fourth = await api.post("/api/v1/servers", {
      name: "four",
      connector: { kind: "local", root },
    });
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "servers",
      current: 3,
      max: 3,
    });
  });

  it("allows the licence maxServers on Paid, all editable", async () => {
    const licence = customerLicence({ maxServers: 4 });
    const api = await owner({ DIALWARDEN_LICENCE: licence });
    await addMany(api, ["one", "two", "three", "four"]);
    expect((await listed(api)).every((server) => server.editable)).toBe(true);
    const root = await palworldFolder(base, "five");
    const fifth = await api.post("/api/v1/servers", {
      name: "five",
      connector: { kind: "local", root },
    });
    expect(fifth.statusCode).toBe(409);
    expect(fifth.json()).toEqual({ error: "server_limit_reached", max: 4 });
  });

  it("keeps the editable three after the licence is removed", async () => {
    const api = await owner();
    const token = customerLicence({ maxServers: 5 });
    expect((await api.put("/api/v1/licence", { token })).statusCode).toBe(200);
    const [a, b, c, d] = await addMany(api, ["a", "b", "c", "d"]);
    for (const slug of [b, c, d]) {
      await change(api, slug ?? "", { ExpRate: 2 });
    }
    const removed = await api.delete("/api/v1/licence");
    expect(removed.json()).toMatchObject({ plan: "free" });

    const editable = (await listed(api)).filter((server) => server.editable);
    const ids = editable.map((server) => server.id).sort();
    expect(ids).toEqual(["b", "c", "d"]);
    const blocked = await api.post(`/api/v1/servers/${a}/change-sets`, {
      edits: [{ settingKey: "ExpRate", value: 3 }],
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ limit: "servers", max: 3 });
    // Read-only, not hidden: the settings and history still answer.
    const settings = await api.get(`/api/v1/servers/${a}/settings`);
    expect(settings.statusCode).toBe(200);
    const past = await api.get(`/api/v1/servers/${a}/history`);
    expect(past.statusCode).toBe(200);

    const chosen = await api.put("/api/v1/plan/editable-servers", {
      servers: [a, b, c],
    });
    expect(chosen.json()).toMatchObject({ servers: [a, b, c] });
    const now = (await listed(api)).filter((server) => server.editable);
    expect(now.map((server) => server.id).sort()).toEqual(["a", "b", "c"]);
    const allowed = await change(api, a ?? "", { ExpRate: 3 });
    expect(allowed.status).toBe("applied");
    const refused = await api.post(`/api/v1/servers/${d}/change-sets`, {
      edits: [{ settingKey: "ExpRate", value: 4 }],
    });
    expect(refused.statusCode).toBe(402);
  });
});
