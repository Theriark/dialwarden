// The saved user presets (screen 7 of dev-work-plan P5): list, create from
// a server's current values or a selection of them, remove, and apply to
// one server of the same game as a draft change set of cause preset that
// the normal apply path writes (contract C5). Free holds three presets
// (limit presets of contract C1): the fourth creation answers the 402 body
// the upgrade hint renders; Paid is unlimited, and after the licence is
// removed the Free limit applies again while the saved presets stay.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
  apply,
  change,
  history,
  palworldFolder,
  type Api,
  type ChangeSetBody,
} from "../../test/servers.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

interface PresetBody {
  id: string;
  name: string;
  description: string;
  packId: string;
  createdAt: string;
  values: Record<string, unknown>;
}

interface SettingsBody {
  packId: string;
  values: Record<string, unknown>;
}

let current: TestApp | undefined;
let base: string;

beforeEach(async () => {
  base = await tempDir("dialwarden-presets-");
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  await rm(base, { recursive: true, force: true });
});

interface Setup {
  api: Api;
  first: string;
  second: string;
}

/** A test app with a signed-in owner and two Palworld servers. */
async function twoServers(): Promise<Setup> {
  current = await testApp();
  const api = apiOf(current.app, await setupOwner(current.app));
  const first = await addServer(
    api,
    "Lighthouse",
    await palworldFolder(base, "one"),
  );
  const second = await addServer(
    api,
    "Beacon",
    await palworldFolder(base, "two"),
  );
  return { api, first, second };
}

/** A test app with a signed-in owner, on the given environment. */
async function ownerApp(extraEnv: Record<string, string> = {}): Promise<Api> {
  current = await testApp({ extraEnv });
  return apiOf(current.app, await setupOwner(current.app));
}

const make = (api: Api, name: string, values: Record<string, unknown> = {}) =>
  api.post("/api/v1/presets", {
    name,
    description: "",
    packId: "palworld",
    values,
  });

async function presets(api: Api): Promise<PresetBody[]> {
  const response = await api.get("/api/v1/presets");
  expect(response.statusCode).toBe(200);
  return response.json<{ items: PresetBody[] }>().items;
}

/** The typed values and pack of a server, as the editor reads them. */
async function settings(api: Api, slug: string): Promise<SettingsBody> {
  const response = await api.get(`/api/v1/servers/${slug}/settings`);
  expect(response.statusCode).toBe(200);
  return response.json<SettingsBody>();
}

describe("saved user presets (P5 screen 7)", () => {
  it("need a session on every route", async () => {
    current = await testApp();
    const anonymous = current.app.inject({
      method: "GET",
      url: "/api/v1/presets",
    });
    expect((await anonymous).statusCode).toBe(401);
  });

  it("list the saved presets, oldest first, with their values", async () => {
    const api = await ownerApp();
    expect(await presets(api)).toEqual([]);
    await make(api, "First", { ExpRate: 2 });
    await make(api, "Second", { ServerPlayerMaxNum: 40 });
    const items = await presets(api);
    expect(items.map((preset) => preset.name)).toEqual(["First", "Second"]);
    expect(items[0]).toMatchObject({
      packId: "palworld",
      values: { ExpRate: 2 },
    });
  });

  it("create a preset from a server's current values", async () => {
    const { api, first } = await twoServers();
    const read = await settings(api, first);
    const created = await api.post("/api/v1/presets", {
      name: "As running",
      description: "Lighthouse as it runs now",
      packId: read.packId,
      values: read.values,
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json<PresetBody>();
    expect(preset).toMatchObject({
      name: "As running",
      description: "Lighthouse as it runs now",
      packId: "palworld",
    });
    // The values round-trip exactly as the settings read masked them.
    expect(preset.values).toEqual(read.values);
    expect(await presets(api)).toEqual([preset]);
  });

  it("create a preset from a selection of settings", async () => {
    const { api, first } = await twoServers();
    const read = await settings(api, first);
    const selection = {
      ExpRate: read.values["ExpRate"],
      ServerPlayerMaxNum: read.values["ServerPlayerMaxNum"],
    };
    const created = await make(api, "Just the rates", selection);
    expect(created.statusCode).toBe(201);
    expect(created.json<PresetBody>().values).toEqual(selection);
  });

  it("refuse an unknown game, an unknown setting and a blank name", async () => {
    const api = await ownerApp();
    const unknownGame = await api.post("/api/v1/presets", {
      name: "No such game",
      description: "",
      packId: "no-such-game",
      values: {},
    });
    expect(unknownGame.statusCode).toBe(422);
    expect(unknownGame.json()).toEqual({
      error: "unknown_game",
      id: "no-such-game",
    });
    const unknownSetting = await make(api, "Bad key", { NotASetting: true });
    expect(unknownSetting.statusCode).toBe(422);
    expect(unknownSetting.json()).toEqual({
      error: "unknown_setting",
      keys: ["NotASetting"],
    });
    const blank = await make(api, "  ");
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ error: "validation" });
  });

  it("hold three on Free: the fourth answers the 402 upgrade body", async () => {
    const api = await ownerApp();
    for (const name of ["One", "Two", "Three"]) {
      expect((await make(api, name)).statusCode).toBe(201);
    }
    const fourth = await make(api, "Over the limit");
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "presets",
      current: 3,
      max: 3,
    });
    // Removing one frees the slot again.
    const saved = await presets(api);
    const removed = await api.delete(`/api/v1/presets/${saved[0]?.id}`);
    expect(removed.statusCode).toBe(204);
    expect((await make(api, "Fits again")).statusCode).toBe(201);
  });

  it("hold unlimited presets on Paid", async () => {
    const api = await ownerApp({ DIALWARDEN_LICENCE: customerLicence() });
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      expect((await make(api, name)).statusCode).toBe(201);
    }
    expect((await presets(api)).map((preset) => preset.name)).toHaveLength(5);
  });

  it("fall back to the Free limit after the licence is removed", async () => {
    const api = await ownerApp();
    const token = customerLicence();
    expect((await api.put("/api/v1/licence", { token })).statusCode).toBe(200);
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      expect((await make(api, name)).statusCode).toBe(201);
    }
    const removed = await api.delete("/api/v1/licence");
    expect(removed.json()).toMatchObject({ plan: "free" });
    const sixth = await make(api, "Sixth");
    expect(sixth.statusCode).toBe(402);
    expect(sixth.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "presets",
      current: 5,
      max: 3,
    });
    // The saved ones stay; only new ones are refused.
    expect(await presets(api)).toHaveLength(5);
  });

  it("remove a preset, and answer 404 once it is gone", async () => {
    const api = await ownerApp();
    const created = await make(api, "Disposable", { ExpRate: 3 });
    const preset = created.json<PresetBody>();
    const removed = await api.delete(`/api/v1/presets/${preset.id}`);
    expect(removed.statusCode).toBe(204);
    expect(await presets(api)).toEqual([]);
    const again = await api.delete(`/api/v1/presets/${preset.id}`);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "preset_not_found" });
  });

  it("apply a preset as a change set of cause preset, with its diff and history", async () => {
    const { api, first, second } = await twoServers();
    // The preset takes the first server's current values, after a change
    // makes them differ from the second server's identical fixture.
    await change(api, first, { ExpRate: 2 });
    const read = await settings(api, first);
    const created = await api.post("/api/v1/presets", {
      name: "Tuned",
      description: "Lighthouse as we like it",
      packId: read.packId,
      values: read.values,
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json<PresetBody>();

    const applied = await api.post(`/api/v1/presets/${preset.id}/apply`, {
      server: second,
    });
    expect(applied.statusCode).toBe(200);
    const changeSet = applied.json<ChangeSetBody & { serverId: string }>();
    expect(changeSet).toMatchObject({
      serverId: second,
      status: "draft",
      cause: "preset",
      conflict: null,
      error: null,
    });
    expect(changeSet.diff.semantic).toContainEqual({
      kind: "changed",
      fileId: "settings",
      settingKey: "ExpRate",
      label: "Experience rate",
      from: 1,
      to: 2,
      restartRequired: true,
    });

    // The normal change-set apply path writes it; the history says preset.
    const done = await apply(api, changeSet.id);
    expect(done.status).toBe("applied");
    expect(await settings(api, second)).toMatchObject({
      values: { ExpRate: 2 },
    });
    const past = await history(api, second);
    expect(past.entries[0]).toMatchObject({
      cause: "preset",
      status: "applied",
    });

    // Removing the preset afterwards changes nothing on the server.
    const gone = await api.delete(`/api/v1/presets/${preset.id}`);
    expect(gone.statusCode).toBe(204);
    expect(await settings(api, second)).toMatchObject({
      values: { ExpRate: 2 },
    });
  });

  it("answer no_change for a server that already holds the preset's values", async () => {
    const { api, first } = await twoServers();
    const read = await settings(api, first);
    const created = await make(api, "As running", read.values);
    const preset = created.json<PresetBody>();
    const applied = await api.post(`/api/v1/presets/${preset.id}/apply`, {
      server: first,
    });
    expect(applied.statusCode).toBe(422);
    expect(applied.json()).toEqual({ error: "no_change" });
  });

  it("refuse to apply a preset to a server of another game", async () => {
    const { api, first } = await twoServers();
    const other = await api.post("/api/v1/presets", {
      name: "Other game",
      description: "",
      packId: "enshrouded",
      values: {},
    });
    const preset = other.json<PresetBody>();
    const applied = await api.post(`/api/v1/presets/${preset.id}/apply`, {
      server: first,
    });
    expect(applied.statusCode).toBe(422);
    expect(applied.json()).toEqual({
      error: "pack_mismatch",
      preset: "enshrouded",
      server: "palworld",
    });
  });

  it("answer 404 for an unknown preset or an unknown server", async () => {
    const { api } = await twoServers();
    const applied = await api.post(`/api/v1/presets/${randomUUID()}/apply`, {
      server: "lighthouse",
    });
    expect(applied.statusCode).toBe(404);
    expect(applied.json()).toEqual({ error: "preset_not_found" });
    const created = await make(api, "Orphan");
    const preset = created.json<PresetBody>();
    const toNothing = await api.post(`/api/v1/presets/${preset.id}/apply`, {
      server: "no-such-server",
    });
    expect(toNothing.statusCode).toBe(404);
    expect(toNothing.json()).toEqual({ error: "server_not_found" });
  });
});
