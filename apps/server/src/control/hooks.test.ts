// The hooks of P6-B (contracts C5, C6 and C7): the stopped-only policy of
// the apply step (a change to a stopped-only file on a running server
// becomes pending, is written after the stop hook or when the server is seen
// stopped, and the start hook runs after the write), the pack live-reload
// action that replaces a restart, the hook run API with its roles, and the
// activity events change.pending, hook.run and change.applied in order.
//
// SIMULATED: the Theriark Mock Server has no Palworld REST scenario (checked
// in THE-2582), so the game here is a local stub that speaks the Palworld
// REST shape and a docker-socket-proxy shape over its own loopback ports.
// No live game is ever contacted.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customerLicence } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/hashing.js";
import {
  randomPassword,
  sessionCookie,
  setupOwner,
  tempDir,
  testApp,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import {
  activityOf,
  addServer,
  apiOf,
  apply,
  applyHooks,
  draft,
  fileText,
  hooksOf,
  pendingOf,
  putHooks,
  runHook,
  statusOf,
  type Api,
  type ChangeSetBody,
} from "../../test/servers.js";
import { userGrants, users } from "../db/schema.js";

/** A Paid instance: roles beyond the owner act only on Paid (P8-A). */
const PAID = { DIALWARDEN_LICENCE: customerLicence() };

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

/** The synthetic pack of these tests: one stopped-only world file, an
 * any-time settings file whose Motd is live-reloadable, and a Palworld REST
 * probe that reads its switch, port and password from that file. */
const PACK = {
  id: "hookgame",
  version: "1.0.0",
  displayName: "Synthetic hook game",
  steamAppId: 4000002,
  builds: { from: 100, to: null },
  os: ["linux"],
  detection: { markers: [{ path: "Game.sh" }] },
  files: [
    {
      id: "cfg",
      paths: { linux: ["Config/Server.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
    {
      id: "world",
      paths: { linux: ["World/World.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "stopped-only",
    },
  ],
  settings: [
    {
      key: "ApiEnabled",
      file: "cfg",
      locator: { kind: "ini", section: "Server", key: "ApiEnabled" },
      type: "bool",
      default: true,
      group: "API",
      description:
        "Whether the synthetic game serves its own REST API on the admin port.",
    },
    {
      key: "ApiPort",
      file: "cfg",
      locator: { kind: "ini", section: "Server", key: "ApiPort" },
      type: "int",
      default: 8212,
      min: 1024,
      max: 65535,
      group: "API",
      description: "The TCP port the synthetic game listens on for its API.",
    },
    {
      key: "AdminPassword",
      file: "cfg",
      locator: { kind: "ini", section: "Server", key: "AdminPassword" },
      type: "string",
      default: "",
      secret: true,
      group: "API",
      description:
        "The admin password of the synthetic REST API; empty means none.",
    },
    {
      key: "Motd",
      file: "cfg",
      locator: { kind: "ini", section: "Server", key: "Motd" },
      type: "string",
      default: "Welcome",
      max: 64,
      liveReloadable: true,
      group: "Gameplay",
      description:
        "The message of the day; the synthetic game reloads it from its own REST save without a restart.",
    },
    {
      key: "Slots",
      file: "cfg",
      locator: { kind: "ini", section: "Server", key: "Slots" },
      type: "int",
      default: 32,
      min: 1,
      max: 128,
      group: "Server",
      description:
        "How many players can be connected to the synthetic game at once.",
    },
    {
      key: "WorldSize",
      file: "world",
      locator: { kind: "ini", section: "World", key: "WorldSize" },
      type: "int",
      default: 1,
      min: 1,
      max: 5,
      group: "World",
      description:
        "The size class of the synthetic world; the game reads it only at start.",
    },
    {
      key: "Difficulty",
      file: "world",
      locator: { kind: "ini", section: "World", key: "Difficulty" },
      type: "int",
      default: 1,
      min: 1,
      max: 3,
      group: "World",
      description:
        "The difficulty of the synthetic world; the game reads it only at start.",
    },
  ],
  rules: [],
  presets: [],
  probes: [
    {
      kind: "palworldRest",
      enabledSetting: "ApiEnabled",
      portSetting: "ApiPort",
      passwordSetting: "AdminPassword",
      user: "admin",
      infoPath: "/v1/api/info",
    },
  ],
  hooksSupported: ["save", "stop"],
  sources: ["https://example.com/dialwarden/hookgame"],
};

const CFG = [
  "[Server]",
  "ApiEnabled=True",
  "ApiPort=8212",
  "AdminPassword=",
  "Motd=Welcome",
  "Slots=32",
].join("\n");
const WORLD = ["[World]", "WorldSize=1", "Difficulty=1"].join("\n");

const CONTAINER = "ab".repeat(32);
const VERBS = /^\/containers\/[0-9a-f]{64}\/(start|stop|restart)$/;

/**
 * One simulated game server (labelled simulated): its own REST API on one
 * loopback port, and the container a docker-socket-proxy would see on
 * another. The two share one running state: the game goes down with the
 * container and comes back with it.
 */
class SimGame {
  readonly restCalls: { path: string; auth: string | null }[] = [];
  /** The container verbs asked for; the label lookups are not recorded. */
  readonly dockerCalls: string[] = [];
  readonly #rest;
  readonly #docker;
  #restPort = 0;
  #dockerPort = 0;
  #running = true;
  #obeysShutdown = true;
  /** When set, the REST save answers this instead of 200 (G2.8). */
  saveAnswer: { readonly status: number; readonly body: string } | null = null;

  constructor() {
    this.#rest = createServer((request, response) => {
      response.setHeader("connection", "close");
      const url = request.url ?? "";
      const auth = request.headers.authorization ?? null;
      const record = (path: string) => {
        this.restCalls.push({ path, auth });
      };
      const answer = (status: number, body: string) => {
        response.statusCode = status;
        response.end(body);
      };
      if (request.method === "GET" && url === "/v1/api/info") {
        record("info");
        answer(200, '{"servername":"hookgame"}');
      } else if (request.method === "POST" && url === "/v1/api/save") {
        record("save");
        const forced = this.saveAnswer;
        if (forced === null) answer(200, "{}");
        else answer(forced.status, forced.body);
      } else if (request.method === "POST" && url === "/v1/api/shutdown") {
        record("shutdown");
        answer(200, "{}");
        if (this.#obeysShutdown) this.takeDown();
      } else {
        answer(404, "{}");
      }
    });
    this.#docker = createServer((request, response) => {
      response.setHeader("connection", "close");
      const url = request.url ?? "";
      const answer = (status: number, body: string) => {
        response.statusCode = status;
        response.end(body);
      };
      if (request.method === "GET" && url.startsWith("/containers/json")) {
        answer(
          200,
          JSON.stringify([
            {
              Id: CONTAINER,
              State: this.#running ? "running" : "stopped",
              Labels: { "com.example.game": "hookgame" },
            },
          ]),
        );
      } else if (request.method === "POST" && VERBS.test(url)) {
        const verb = url.split("/").at(-1) ?? "";
        this.dockerCalls.push(verb);
        answer(204, "");
        if (verb === "stop") this.takeDown();
        else this.bringUp();
      } else {
        answer(404, "{}");
      }
    });
  }

  get restPort(): number {
    return this.#restPort;
  }

  get dockerPort(): number {
    return this.#dockerPort;
  }

  async start(): Promise<void> {
    await new Promise<void>((ready) => {
      this.#rest.listen(0, "127.0.0.1", () => ready());
    });
    this.#restPort = (this.#rest.address() as AddressInfo).port;
    await new Promise<void>((ready) => {
      this.#docker.listen(0, "127.0.0.1", () => ready());
    });
    this.#dockerPort = (this.#docker.address() as AddressInfo).port;
  }

  /** The game goes down; its REST API stops listening. */
  takeDown(): void {
    this.#running = false;
    this.#rest.close();
  }

  /** Some games acknowledge a shutdown and stay up; this one will too. */
  ignoreShutdown(): void {
    this.#obeysShutdown = false;
  }

  /** The container starts; the game comes back up on the same port. */
  bringUp(): void {
    if (this.#running) return;
    this.#running = true;
    this.#rest.listen(this.#restPort, "127.0.0.1");
  }

  close(): void {
    this.#rest.close();
    this.#docker.close();
  }
}

let base: string;
let current: TestApp | undefined;
let sim: SimGame | undefined;

/** The simulated game of the running test (setup starts it). */
function game(): SimGame {
  if (sim === undefined) throw new Error("no simulated game is running");
  return sim;
}

beforeEach(async () => {
  base = await tempDir("dialwarden-hooks-");
  const packDir = join(base, "packs", "hookgame");
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, "pack.json"),
    JSON.stringify(PACK, undefined, 2),
  );
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  sim?.close();
  sim = undefined;
  await rm(base, { recursive: true, force: true });
});

/** A signed-in user of the given role, with a grant on the server (write
 * for an editor, read for a viewer; P8-A grants). The session is a real
 * signed-in one: the cookie the app sets and its CSRF token, taken from the
 * login route. Roles act as stored only on Paid (see PAID). */
async function roleUser(
  app: FastifyInstance,
  role: string,
  slug: string,
): Promise<SignedIn> {
  const id = randomUUID();
  const email = `${role}-${id.slice(0, 8)}@dialwarden.test`;
  const password = randomPassword();
  const at = new Date().toISOString();
  app.ctx.store.db
    .insert(users)
    .values({
      id,
      email,
      name: role,
      role,
      passwordHash: await hashPassword(password),
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const level = role === "viewer" ? "read" : "write";
  app.ctx.store.db
    .insert(userGrants)
    .values({ userId: id, serverId: slug, level })
    .run();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ csrfToken: string }>();
  return {
    cookie: sessionCookie(response),
    csrf: body.csrfToken,
    userId: id,
  };
}

interface Setup {
  app: FastifyInstance;
  api: Api;
  root: string;
  slug: string;
}

/** A running test server: the app, its owner, the API, the game folder and
 * the simulated game, with the probe pointing at the stub. */
async function setup(extraEnv: Record<string, string> = {}): Promise<Setup> {
  current = await testApp({
    config: { packsDir: join(base, "packs") },
    extraEnv,
  });
  const { app } = current;
  sim = new SimGame();
  await sim.start();
  const root = join(base, "server");
  await mkdir(join(root, "Config"), { recursive: true });
  await mkdir(join(root, "World"), { recursive: true });
  await writeFile(join(root, "Game.sh"), "");
  await writeFile(join(root, "Config", "Server.ini"), `${CFG}\n`);
  await writeFile(join(root, "World", "World.ini"), `${WORLD}\n`);
  const owner = await setupOwner(app);
  const api = apiOf(app, owner);
  const slug = await addServer(api, "Lighthouse", root);
  await putHooks(api, slug, {
    probes: {
      palworldRest: {
        host: "127.0.0.1",
        port: sim.restPort,
        password: "override-secret",
      },
    },
  });
  return { app, api, root, slug };
}

/** The docker hook of the simulated game, as the owner sets it. */
function dockerHook(sim: SimGame): object {
  return {
    hook: {
      kind: "dockerProxy",
      url: `http://127.0.0.1:${sim.dockerPort}`,
      containerLabel: "com.example.game=hookgame",
    },
  };
}

const WORLD_PATH = "World/World.ini";

describe("the stopped-only policy of the apply step (contract C5)", () => {
  it("parks a stopped-only change on a running server as pending", async () => {
    const { api, root, slug } = await setup();
    const made = await draft(api, slug, { WorldSize: 3 });
    const parked = await apply(api, made.id);
    expect(parked.status).toBe("pending");
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=1");
    const pending = await pendingOf(api, slug);
    expect(pending.map((item) => item.id)).toEqual([made.id]);
    const status = await statusOf(api, slug);
    expect(status).toMatchObject({ state: "running", pending: 1 });
  });

  it("writes a stopped-only change while the server is down", async () => {
    const { api, root, slug } = await setup();
    sim?.takeDown();
    const made = await draft(api, slug, { WorldSize: 4 });
    const written = await apply(api, made.id);
    expect(written.status).toBe("applied");
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=4");
  });

  it("runs the whole sequence: pending, stop, write, start", async () => {
    const { app, api, root, slug } = await setup(PAID);
    // A stopped-only change on a running server waits as pending, even with
    // a restart asked for.
    const made = await draft(api, slug, { WorldSize: 2 });
    const parked = await applyHooks(api, made.id, "restart");
    expect(parked.json<ChangeSetBody>().status).toBe("pending");
    expect(await pendingOf(api, slug)).toHaveLength(1);
    // The owner adds the docker hook while the change waits.
    const set = await putHooks(api, slug, dockerHook(game()));
    expect(set.statusCode).toBe(200);
    // An editor stops the server: the pack's own REST shutdown runs, the
    // pending change is written while the server is down, and the start
    // hook the change asked for brings it back.
    const editor = await roleUser(app, "editor", slug);
    const run = await runHook(apiOf(app, editor), slug, "stop");
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      action: "stop",
      source: "palworldRest",
      stopped: true,
      flushed: 1,
    });
    expect(sim?.restCalls.map((call) => call.path)).toContain("shutdown");
    expect(sim?.dockerCalls).toEqual(["start"]);
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=2");
    const after = await statusOf(api, slug);
    expect(after).toMatchObject({ state: "running", pending: 0 });
    const view = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(view.json<ChangeSetBody>().status).toBe("applied");
  });

  it("records change.pending, hook.run, change.applied in order", async () => {
    const { app, api, root, slug } = await setup(PAID);
    await putHooks(api, slug, dockerHook(game()));
    const made = await draft(api, slug, { WorldSize: 5 });
    await applyHooks(api, made.id, "restart");
    const runner = await roleUser(app, "editor", slug);
    await runHook(apiOf(app, runner), slug, "stop");
    const events = (await activityOf(api, slug)).map((row) => row.type);
    const pending = events.indexOf("change.pending");
    const stop = events.indexOf("hook.run");
    const applied = events.indexOf("change.applied");
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(pending);
    expect(applied).toBeGreaterThan(stop);
    // The start hook after the write is the last event of the cycle.
    expect(events.at(-1)).toBe("hook.run");
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=5");
  });

  it("writes a pending change when the probe sees it stopped", async () => {
    const { api, root, slug } = await setup();
    const made = await draft(api, slug, { WorldSize: 3 });
    await apply(api, made.id);
    // Someone stops the server outside the app; the next status read sees
    // it stopped and the app completes the pending change itself.
    sim?.takeDown();
    const status = await statusOf(api, slug);
    expect(status).toMatchObject({ state: "stopped", pending: 0 });
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=3");
    const events = await activityOf(api, slug);
    const applied = events.find((row) => row.type === "change.applied");
    expect(applied?.actor).toBe("system");
  });

  it("keeps a change parked as save-only down after a stop", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const made = await draft(api, slug, { WorldSize: 4 });
    await apply(api, made.id);
    const run = await runHook(api, slug, "stop");
    expect(run.json()).toMatchObject({ stopped: true, flushed: 1 });
    // No start hook was asked for, so the server stays down.
    expect(sim?.dockerCalls).toEqual([]);
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=4");
  });

  it("stops, writes and starts in one stop-start apply", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const made = await draft(api, slug, { WorldSize: 5 });
    const answer = await applyHooks(api, made.id, "stop-start");
    expect(answer.json<ChangeSetBody>().status).toBe("applied");
    expect(sim?.restCalls.map((call) => call.path)).toContain("shutdown");
    expect(sim?.dockerCalls).toEqual(["start"]);
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=5");
  });

  it("writes every pending change, then starts the server once", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    // Two stopped-only changes wait while the server runs.
    const first = await draft(api, slug, { WorldSize: 2 });
    const second = await draft(api, slug, { Difficulty: 3 });
    for (const made of [first, second]) {
      const parked = await applyHooks(api, made.id, "restart");
      expect(parked.json<ChangeSetBody>().status).toBe("pending");
    }
    const run = await runHook(api, slug, "stop");
    expect(run.json()).toMatchObject({ stopped: true, flushed: 2 });
    // Both are written while the server is down; one start comes after.
    expect(sim?.dockerCalls).toEqual(["start"]);
    const world = await fileText(root, WORLD_PATH);
    expect(world).toContain("WorldSize=2");
    expect(world).toContain("Difficulty=3");
    expect(await pendingOf(api, slug)).toHaveLength(0);
  });

  it("writes the older pending changes first in a stop-start", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const older = await draft(api, slug, { WorldSize: 4 });
    const parked = await applyHooks(api, older.id, "restart");
    expect(parked.json<ChangeSetBody>().status).toBe("pending");
    // A newer change asks for stop-start: the stop window writes the older
    // pending change first, then the newer one, and starts once.
    const newer = await draft(api, slug, { Difficulty: 2 });
    const answer = await applyHooks(api, newer.id, "stop-start");
    expect(answer.json<ChangeSetBody>().status).toBe("applied");
    expect(sim?.dockerCalls).toEqual(["start"]);
    const world = await fileText(root, WORLD_PATH);
    expect(world).toContain("WorldSize=4");
    expect(world).toContain("Difficulty=2");
    const view = await api.get(`/api/v1/change-sets/${older.id}`);
    expect(view.json<ChangeSetBody>().status).toBe("applied");
    const applied = (await activityOf(api, slug))
      .filter((row) => row.type === "change.applied")
      .map((row) => (row.data as { changeSetId?: string }).changeSetId);
    expect(applied).toEqual([older.id, newer.id]);
  });

  it("parks a stop-start apply when the stop never takes effect", async () => {
    // A short wait bound (HOOK_WAIT_MS), so the probe gives up quickly.
    const { api, root, slug } = await setup({ HOOK_WAIT_MS: "150" });
    await putHooks(api, slug, dockerHook(game()));
    // The game acknowledges the shutdown and stays up, as games that ignore
    // the request do; the probe never sees the server stopped.
    sim?.ignoreShutdown();
    const made = await draft(api, slug, { WorldSize: 2 });
    const answer = await applyHooks(api, made.id, "stop-start");
    expect(answer.json<ChangeSetBody>().status).toBe("pending");
    expect(sim?.restCalls.map((call) => call.path)).toContain("shutdown");
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=1");
  });
});

describe("the live-reload action of the pack (contract C5)", () => {
  it("replaces a restart with the pack save for live settings", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const made = await draft(api, slug, { Motd: "Hello again" });
    const answer = await applyHooks(api, made.id, "restart");
    expect(answer.json<ChangeSetBody>().status).toBe("applied");
    expect(await fileText(root, "Config/Server.ini")).toContain(
      "Motd=Hello again",
    );
    expect(sim?.restCalls.map((call) => call.path)).toContain("save");
    expect(sim?.dockerCalls).toEqual([]);
  });

  it("restarts for a setting that is not live-reloadable", async () => {
    const { api, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const made = await draft(api, slug, { Slots: 64 });
    const answer = await applyHooks(api, made.id, "restart");
    expect(answer.json<ChangeSetBody>().status).toBe("applied");
    expect(sim?.dockerCalls).toEqual(["restart"]);
  });

  it("refuses a restart with no hook, before the write", async () => {
    const { api, root, slug } = await setup();
    const made = await draft(api, slug, { Slots: 64 });
    const answer = await applyHooks(api, made.id, "restart");
    expect(answer.statusCode).toBe(409);
    expect(answer.json()).toMatchObject({ error: "hook_not_configured" });
    expect(await fileText(root, "Config/Server.ini")).toContain("Slots=32");
    // The change set is still a draft and can be applied as save-only.
    const saved = await apply(api, made.id);
    expect(saved.status).toBe("applied");
  });
});

describe("the hook run API and its roles (contract C7)", () => {
  it("answers the hook view with its configuration and actions", async () => {
    const { api, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const view = (await hooksOf(api, slug)) as {
      packId: string;
      hooksSupported: string[];
      hook: { kind: string; url: string; containerLabel: string };
      probes: {
        kind: string;
        host: string | null;
        port: number | null;
        hasPassword: boolean;
      }[];
      available: Record<string, string | null>;
      updatedBy: string;
    };
    expect(view.packId).toBe("hookgame");
    expect(view.hooksSupported).toEqual(["save", "stop"]);
    expect(view.hook.kind).toBe("dockerProxy");
    expect(view.probes).toEqual([
      {
        kind: "palworldRest",
        host: "127.0.0.1",
        port: sim?.restPort ?? 0,
        hasPassword: true,
      },
    ]);
    expect(view.available).toEqual({
      save: "palworldRest",
      stop: "palworldRest",
      start: "dockerProxy",
      restart: "dockerProxy",
    });
    expect(view.updatedBy).toBe("owner@dialwarden.test");
  });

  it("sends the pack's own commands with the probe's credentials", async () => {
    const { api, slug } = await setup();
    const run = await runHook(api, slug, "save");
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      action: "save",
      source: "palworldRest",
    });
    const save = sim?.restCalls.find((call) => call.path === "save");
    const basic = Buffer.from("admin:override-secret").toString("base64");
    expect(save?.auth).toBe(`Basic ${basic}`);
  });

  it("runs the configured hook for what the pack cannot do", async () => {
    const { api, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const run = await runHook(api, slug, "restart");
    expect(run.json()).toMatchObject({
      action: "restart",
      source: "dockerProxy",
    });
    expect(sim?.dockerCalls).toEqual(["restart"]);
  });

  it("lets an editor trigger a hook and refuses a viewer", async () => {
    const { app, slug } = await setup(PAID);
    const editor = apiOf(app, await roleUser(app, "editor", slug));
    const viewer = apiOf(app, await roleUser(app, "viewer", slug));
    const allowed = await runHook(editor, slug, "save");
    expect(allowed.statusCode).toBe(200);
    const refused = await runHook(viewer, slug, "save");
    expect(refused.statusCode).toBe(403);
    // Reading the state and the configuration stays open to every user.
    const status = await viewer.get(`/api/v1/servers/${slug}/status`);
    expect(status.statusCode).toBe(200);
    const hooks = await viewer.get(`/api/v1/servers/${slug}/hooks`);
    expect(hooks.statusCode).toBe(200);
  });

  it("lets only the owner or an admin set the hook configuration", async () => {
    const { app, api, slug } = await setup(PAID);
    const editor = apiOf(app, await roleUser(app, "editor", slug));
    const admin = apiOf(app, await roleUser(app, "admin", slug));
    const refused = await putHooks(editor, slug, dockerHook(game()));
    expect(refused.statusCode).toBe(403);
    const allowed = await putHooks(admin, slug, dockerHook(game()));
    expect(allowed.statusCode).toBe(200);
    const change = await putHooks(api, slug, { hook: null });
    expect(change.statusCode).toBe(200);
    const view = (await hooksOf(api, slug)) as { hook: unknown };
    expect(view.hook).toBeNull();
  });

  it("refuses an SSH command hook on a server without SSH access", async () => {
    const { api, slug } = await setup();
    const answer = await putHooks(api, slug, {
      hook: { kind: "sshCommand", command: "systemctl restart hookgame" },
    });
    expect(answer.statusCode).toBe(422);
    expect(answer.json()).toMatchObject({ error: "hook_needs_sftp" });
  });

  it("refuses a hook or probe configuration it cannot use", async () => {
    const { api, slug } = await setup();
    const badHook = await putHooks(api, slug, {
      hook: {
        kind: "dockerProxy",
        url: "file:///var/run/docker.sock",
        containerLabel: "com.example.game",
      },
    });
    expect(badHook.statusCode).toBe(422);
    const badKind = await putHooks(api, slug, {
      probes: { sourceRcon: { host: "127.0.0.1" } },
    });
    expect(badKind.statusCode).toBe(422);
    expect(badKind.json()).toMatchObject({ error: "unknown_probe" });
    const badHost = await putHooks(api, slug, {
      probes: { palworldRest: { host: "game.example/x" } },
    });
    expect(badHost.statusCode).toBe(422);
    const badPassword = await putHooks(api, slug, {
      probes: { palworldRest: { password: "line\nbreak" } },
    });
    expect(badPassword.statusCode).toBe(422);
    expect(badPassword.json()).toMatchObject({
      error: "probe_password_not_usable",
    });
  });

  it("still answers the hook view when a probe port is not usable", async () => {
    const { api, root, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    // The override keeps only the host, so the port comes from the game
    // file, which someone edited by hand to a port out of range.
    await putHooks(api, slug, {
      probes: { palworldRest: { host: "127.0.0.1" } },
    });
    const cfg = CFG.replace("ApiPort=8212", "ApiPort=70000");
    await writeFile(join(root, "Config", "Server.ini"), `${cfg}\n`);
    const view = (await hooksOf(api, slug)) as {
      available: Record<string, string | null>;
    };
    // The broken probe stays silent, so the pack's own save and stop are
    // gone; the docker hook stays usable and takes the stop over.
    expect(view.available).toMatchObject({
      save: null,
      stop: "dockerProxy",
      start: "dockerProxy",
      restart: "dockerProxy",
    });
    const run = await runHook(api, slug, "restart");
    expect(run.statusCode).toBe(200);
  });

  it("refuses an unrunnable action and records a broken hook", async () => {
    const { api, slug } = await setup();
    const none = await runHook(api, slug, "restart");
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: "hook_not_configured" });
    // The docker hook points at a port nothing listens on: the run fails,
    // and the failure is recorded as a hook.run event.
    const dead = await putHooks(api, slug, {
      hook: {
        kind: "dockerProxy",
        url: "http://127.0.0.1:1",
        containerLabel: "com.example.game=hookgame",
      },
    });
    expect(dead.statusCode).toBe(200);
    const broken = await runHook(api, slug, "restart");
    // P6 O1: a 4xx, so a proxy in front never swaps the body for its page.
    expect(broken.statusCode).toBe(424);
    expect(broken.json()).toMatchObject({
      error: "control_error",
      code: "Connection",
    });
    const runs = (await activityOf(api, slug)).filter(
      (row) => row.type === "hook.run",
    );
    expect(runs.at(-1)?.data).toMatchObject({
      action: "restart",
      source: "dockerProxy",
      ok: false,
      error: "Connection",
    });
  });

  it("A-19 flushes pending changes for a writer only, never for a viewer", async () => {
    const { app, api, root, slug } = await setup(PAID);
    const viewer = apiOf(app, await roleUser(app, "viewer", slug));
    const made = await draft(api, slug, { WorldSize: 5 });
    await apply(api, made.id);
    // Someone stops the game outside the app; the next status read sees it.
    sim?.takeDown();
    const before = await fileText(root, WORLD_PATH);
    const status = await viewer.get(`/api/v1/servers/${slug}/status`);
    expect(status.statusCode).toBe(200);
    expect(status.json<{ pending: number }>().pending).toBe(1);
    expect(await fileText(root, WORLD_PATH)).toBe(before);
    // The owner holds a write grant everywhere: the read flushes.
    const flushed = await statusOf(api, slug);
    expect(flushed).toMatchObject({ state: "stopped", pending: 0 });
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=5");
  });

  // P10-A G2.8: a failing game answer comes back as a code, never quoted.
  it("G2.8 answers a failing save with control_error and no game text", async () => {
    const { api, slug } = await setup();
    game().saveAnswer = { status: 500, body: "LEAKME internal error" };
    const run = await runHook(api, slug, "save");
    expect(run.statusCode).toBe(424);
    expect(run.json()).toMatchObject({ error: "control_error" });
    expect(run.body).not.toContain("LEAKME");
    expect(run.body).not.toContain("override-secret");
  });

  // P10-A G3.2: the SSH command is checked when it is set; editors never
  // set one. The server only has to be an SFTP server for the check.
  it("G3.2 refuses an unusable SSH command and any from an editor", async () => {
    const { app, api } = await setup(PAID);
    app.ctx.servers.insert({
      id: "sftp-game",
      name: "SFTP game",
      packId: "hookgame",
      os: "linux",
      spec: {
        kind: "sftp",
        host: "127.0.0.1",
        port: 1,
        username: "game",
        root: "/srv/game",
        panel: false,
      },
      demo: false,
    });
    const command = (text: string) => ({
      hook: { kind: "sshCommand", command: text },
    });
    for (const text of ["a\nb", "a\rb", "a\0b", "", "x".repeat(2001)]) {
      const refused = await putHooks(api, "sftp-game", command(text));
      expect(refused.statusCode, JSON.stringify(text)).toBe(422);
      expect(refused.json()).toMatchObject({
        error: "hook_command_not_usable",
      });
    }
    const editor = apiOf(app, await roleUser(app, "editor", "sftp-game"));
    const byEditor = await putHooks(
      editor,
      "sftp-game",
      command("systemctl restart hookgame"),
    );
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual({ error: "forbidden" });
    const byOwner = await putHooks(
      api,
      "sftp-game",
      command("systemctl restart hookgame"),
    );
    expect(byOwner.statusCode).toBe(200);
  });

  // P10-A G3.3: a run takes an action, never a command: extra fields of the
  // body are dropped and the client runs only its fixed verb.
  it("G3.3 ignores a command sent with a hook run", async () => {
    const { api, slug } = await setup();
    await putHooks(api, slug, dockerHook(game()));
    const run = await api.post(`/api/v1/servers/${slug}/hooks/run`, {
      action: "restart",
      command: "rm -rf /",
    });
    expect(run.statusCode).toBe(200);
    expect(game().dockerCalls).toEqual(["restart"]);
  });

  it("L6 refuses link-local, metadata and other unusable control hosts", async () => {
    const { api, slug } = await setup();
    const metadata = await putHooks(api, slug, {
      hook: {
        kind: "dockerProxy",
        url: "http://169.254.169.254/",
        containerLabel: "com.example.game=hookgame",
      },
    });
    expect(metadata.statusCode).toBe(422);
    expect(metadata.json()).toMatchObject({ error: "hook_command_not_usable" });
    for (const host of ["169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1"]) {
      const probe = await putHooks(api, slug, {
        probes: { palworldRest: { host } },
      });
      expect(probe.statusCode, host).toBe(422);
      expect(probe.json(), host).toMatchObject({
        error: "probe_host_not_usable",
      });
    }
    for (const host of ["10.0.0.8", "127.0.0.1"]) {
      const probe = await putHooks(api, slug, {
        probes: { palworldRest: { host } },
      });
      expect(probe.statusCode, host).toBe(200);
    }
  });

  /** One more server of the synthetic pack, in its own folder. */
  async function extraServer(api: Api, name: string): Promise<string> {
    const root = join(base, name);
    await mkdir(join(root, "Config"), { recursive: true });
    await mkdir(join(root, "World"), { recursive: true });
    await writeFile(join(root, "Game.sh"), "");
    await writeFile(join(root, "Config", "Server.ini"), `${CFG}\n`);
    await writeFile(join(root, "World", "World.ini"), `${WORLD}\n`);
    return addServer(api, name, root);
  }

  const appliedOn = async (api: Api, slug: string) =>
    (await activityOf(api, slug)).filter(
      (row) => row.type === "change.applied",
    );

  it("L21 (A) keeps a pending change while its server is not editable", async () => {
    const { api, root, slug } = await setup(PAID);
    const made = await draft(api, slug, { WorldSize: 5 });
    expect((await apply(api, made.id)).status).toBe("pending");
    // Three more servers, each edited since: on Free they are the editable
    // three, and the never-edited first server is not editable any more.
    for (const name of ["Second", "Third", "Fourth"]) {
      const other = await extraServer(api, name);
      const edit = await draft(api, other, { Slots: 10 });
      expect((await apply(api, edit.id)).status).toBe("applied");
    }
    const environment = "/api/v1/licence/environment";
    expect((await api.put(environment, { ignored: true })).statusCode).toBe(
      200,
    );
    game().takeDown();
    const before = await fileText(root, WORLD_PATH);
    const status = await statusOf(api, slug);
    expect(status).toMatchObject({ state: "stopped", pending: 1 });
    expect(await fileText(root, WORLD_PATH)).toBe(before);
    expect(await appliedOn(api, slug)).toHaveLength(0);
    // Back on Paid, the next status read writes it.
    expect((await api.put(environment, { ignored: false })).statusCode).toBe(
      200,
    );
    const paid = await statusOf(api, slug);
    expect(paid).toMatchObject({ state: "stopped", pending: 0 });
    expect(await fileText(root, WORLD_PATH)).toContain("WorldSize=5");
  });

  it("L21 (B) never writes a parked change of a user who lost the grant", async () => {
    const { app, api, root, slug } = await setup(PAID);
    const user = await roleUser(app, "editor", slug);
    const editor = apiOf(app, user);
    const made = await draft(editor, slug, { WorldSize: 5 });
    expect((await apply(editor, made.id)).status).toBe("pending");
    const grants = `/api/v1/users/${user.userId}/grants`;
    expect((await api.put(grants, { servers: [] })).statusCode).toBe(200);
    game().takeDown();
    const status = await statusOf(api, slug);
    expect(status).toMatchObject({ state: "stopped", pending: 0 });
    expect(await fileText(root, WORLD_PATH)).not.toContain("WorldSize=5");
    const failed = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(failed.json()).toMatchObject({
      status: "failed",
      error: { code: "author_cannot_write" },
    });
    expect(await appliedOn(api, slug)).toHaveLength(0);
  });
});
