// Licences and the Free fallback (dev-work-plan P1-A steps 6 and 7, contract
// C1): the environment licence, the UI licence and their precedence, the
// owner's Free switch, an invalid environment licence, and the editable-server
// choice.
/* eslint-disable security/detect-non-literal-fs-filename -- the test's own data folder */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Entitlement } from "@dialwarden/entitlement";
import {
  customerLicence,
  customerPayload,
  devLicence,
  signPayload,
  testKeys,
} from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  testApp,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** The payload and signature parts: neither may ever leave the app. */
const tokenParts = (token: string): string[] => token.split(".").slice(1);

async function entitlementOf(
  app: FastifyInstance,
  owner: SignedIn,
): Promise<Entitlement> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/entitlement",
    headers: headersOf(owner),
  });
  expect(response.statusCode).toBe(200);
  return response.json<Entitlement>();
}

function putLicence(app: FastifyInstance, owner: SignedIn, token: string) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/licence",
    headers: headersOf(owner),
    payload: { token },
  });
}

describe("environment licence (DIALWARDEN_LICENCE)", () => {
  it("gives Paid from the environment and never shows the token", async () => {
    const token = customerLicence();
    current = await testApp({ extraEnv: { DIALWARDEN_LICENCE: token } });
    const { app } = current;
    const owner = await setupOwner(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/entitlement",
      headers: headersOf(owner),
    });
    const body = response.json<Entitlement>();
    expect(body).toMatchObject({
      plan: "paid",
      state: "active",
      source: "environment",
      envLicence: { present: true, state: "active", ignored: false },
    });
    expect(body.limits.servers).toBe(25);
    expect(body.licence).toMatchObject({
      customerName: "Test Customer",
      kind: "customer",
      last6: token.slice(-6),
    });
    for (const part of tokenParts(token)) {
      expect(response.body).not.toContain(part);
    }
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({ plan: "paid" });
    expect(health.body).not.toContain("Test Customer");
  });

  it("keeps the environment token out of the database and the logs", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        done: (error?: Error | null) => void,
      ) {
        lines.push(chunk.toString());
        done();
      },
    });
    const token = customerLicence();
    current = await testApp({
      logStream: stream,
      extraEnv: { DIALWARDEN_LICENCE: token, LOG_LEVEL: "info" },
    });
    const { app, dataDir } = current;
    const owner = await setupOwner(app);
    const body = await entitlementOf(app, owner);
    app.ctx.store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const database = await readFile(join(dataDir, "dialwarden.db"));
    const logs = lines.join("");
    for (const part of tokenParts(token)) {
      expect(database.includes(part)).toBe(false);
      expect(logs).not.toContain(part);
    }
    expect(logs).toContain(body.licence?.lidHash8 ?? "no lid hash");
  });

  it("an invalid environment licence starts on Free and shows why", async () => {
    current = await testApp({
      extraEnv: { DIALWARDEN_LICENCE: "DW1.not-a-licence.x" },
    });
    const { app } = current;
    const owner = await setupOwner(app);
    expect(await entitlementOf(app, owner)).toMatchObject({
      plan: "free",
      state: "malformed",
      source: "environment",
      envLicence: { present: true, state: "malformed" },
    });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ plan: "free" });
  });

  it("a licence signed by an unknown key starts on Free", async () => {
    const stranger = signPayload(
      customerPayload(),
      testKeys.stranger.privateKey,
    );
    current = await testApp({ extraEnv: { DIALWARDEN_LICENCE: stranger } });
    const owner = await setupOwner(current.app);
    expect(await entitlementOf(current.app, owner)).toMatchObject({
      plan: "free",
      state: "invalid_signature",
    });
  });
});

describe("removing a licence in the UI", () => {
  // Test review F6: the environment licence cannot be removed in the UI.
  it("leaves the environment licence in place when no UI licence exists", async () => {
    current = await testApp({
      extraEnv: { DIALWARDEN_LICENCE: customerLicence() },
    });
    const { app } = current;
    const owner = await setupOwner(app);
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/licence",
      headers: headersOf(owner),
    });
    expect(removed.statusCode).toBe(200);
    expect(await entitlementOf(app, owner)).toMatchObject({
      plan: "paid",
      source: "environment",
    });
    const events = await app.inject({
      method: "GET",
      url: "/api/v1/activity?type=licence.changed",
      headers: headersOf(owner),
    });
    expect(events.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe("UI licence", () => {
  it("decides over the environment; removing it falls back; the Free switch", async () => {
    const envToken = customerLicence({
      customer: { id: "cus-env", name: "Env Customer" },
    });
    current = await testApp({ extraEnv: { DIALWARDEN_LICENCE: envToken } });
    const { app } = current;
    const owner = await setupOwner(app);

    // A UI licence decides in whatever state, even over an active env one.
    const ended = customerLicence({ updatesUntil: "2026-01-31" });
    const setEnded = await putLicence(app, owner, ended);
    expect(setEnded.statusCode).toBe(200);
    expect(setEnded.json()).toMatchObject({
      plan: "free",
      source: "ui",
      state: "term_ended_for_this_version",
    });

    const active = customerLicence({
      customer: { id: "cus-ui", name: "UI Customer" },
    });
    const setActive = await putLicence(app, owner, active);
    expect(setActive.json()).toMatchObject({
      plan: "paid",
      source: "ui",
      licence: { customerName: "UI Customer" },
    });

    // Stored encrypted with APP_SECRET_KEY, never as the token.
    const row = app.ctx.store.sqlite
      .prepare("SELECT token_enc AS value FROM licence")
      .get() as { value: string };
    expect(row.value.startsWith("dwenc1.")).toBe(true);
    for (const part of tokenParts(active)) {
      expect(row.value).not.toContain(part);
    }

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/licence",
      headers: headersOf(owner),
    });
    expect(removed.json()).toMatchObject({
      plan: "paid",
      source: "environment",
      licence: { customerName: "Env Customer" },
    });

    const useEnvironment = (ignored: boolean) =>
      app.inject({
        method: "PUT",
        url: "/api/v1/licence/environment",
        headers: headersOf(owner),
        payload: { ignored },
      });
    expect((await useEnvironment(true)).json()).toMatchObject({
      plan: "free",
      source: "none",
      envLicence: { present: true, state: "active", ignored: true },
    });
    expect((await useEnvironment(false)).json()).toMatchObject({
      plan: "paid",
      source: "environment",
    });

    const events = await app.inject({
      method: "GET",
      url: "/api/v1/activity?type=licence.changed",
      headers: headersOf(owner),
    });
    const items = events.json<{ items: { data: { action: string } }[] }>();
    expect(items.items.map((item) => item.data.action)).toEqual([
      "environment_used",
      "environment_ignored",
      "removed",
      "set",
      "set",
    ]);
    for (const part of [...tokenParts(envToken), ...tokenParts(active)]) {
      expect(events.body).not.toContain(part);
    }
  });

  it("refuses a token that does not verify and stores nothing", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const stranger = signPayload(
      customerPayload(),
      testKeys.stranger.privateKey,
    );
    const refused = await putLicence(app, owner, stranger);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: "invalid_licence",
      reason: "invalid_signature",
    });
    const garbage = await putLicence(app, owner, "DW1.abc");
    expect(garbage.statusCode).toBe(422);
    expect(garbage.json()).toMatchObject({ reason: "format" });
    const count = app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM licence")
      .get() as { n: number };
    expect(count.n).toBe(0);
    expect((await entitlementOf(app, owner)).source).toBe("none");
  });

  it("an internal-dev licence gives Paid and is marked as a development licence", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const res = await putLicence(app, owner, devLicence());
    expect(res.json()).toMatchObject({
      plan: "paid",
      source: "ui",
      licence: { kind: "internal-dev" },
    });
  });

  it("only a signed-in owner with the CSRF header changes the licence", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const payload = { token: customerLicence() };
    const anonymous = await app.inject({
      method: "PUT",
      url: "/api/v1/licence",
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: "PUT",
      url: "/api/v1/licence",
      headers: { cookie: owner.cookie },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("Free fallback: editable servers", () => {
  it("lets the owner choose three, and Paid makes every server editable", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    app.ctx.editable.setProviders({
      recentlyEdited: () => ["r1", "r2", "r3", "r4"],
      exists: () => true,
    });
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/plan/editable-servers",
      headers: headersOf(owner),
    });
    expect(initial.json()).toEqual({
      servers: ["r1", "r2", "r3"],
      chosen: [],
      max: 3,
    });

    const put = (servers: string[]) =>
      app.inject({
        method: "PUT",
        url: "/api/v1/plan/editable-servers",
        headers: headersOf(owner),
        payload: { servers },
      });
    expect((await put(["a", "b", "c", "d"])).json()).toMatchObject({
      error: "too_many_servers",
      max: 3,
    });
    expect((await put(["alpha", "alpha"])).json()).toMatchObject({
      error: "duplicate_server",
    });
    expect((await put(["Not An Id"])).statusCode).toBe(400);
    const chosen = await put(["alpha", "beta", "gamma"]);
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toEqual({
      servers: ["alpha", "beta", "gamma"],
      chosen: ["alpha", "beta", "gamma"],
      max: 3,
    });

    const gate = app.ctx.entitlement;
    expect(gate.isServerEditable("beta")).toBe(true);
    expect(gate.isServerEditable("r1")).toBe(false);
    expect((await putLicence(app, owner, customerLicence())).statusCode).toBe(
      200,
    );
    expect(gate.isServerEditable("r1")).toBe(true);
    await app.inject({
      method: "DELETE",
      url: "/api/v1/licence",
      headers: headersOf(owner),
    });
    expect(gate.isServerEditable("r1")).toBe(false);
    expect(gate.isServerEditable("gamma")).toBe(true);
  });
});
