// The registry test (dev-work-plan P1 Acceptance, contract C1). Every route with
// config.entitlement answers 402 with its feature name on Free, is never
// public, and works on Paid; every Paid route the registry lists declares its
// feature. P1 has no Paid route yet, so a probe route stands in for them.
import { randomUUID } from "node:crypto";
import {
  ALWAYS_FREE_ROUTES,
  FEATURES,
  type FeatureKey,
} from "@dialwarden/entitlement";
import { customerLicence } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  randomPassword,
  sessionCookie,
  setupOwner,
  testApp,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import { call, paidApp, toFree, toPaid } from "../../test/team.js";
import { hashPassword } from "../auth/hashing.js";
import { users } from "../db/schema.js";
import type { RouteInfo } from "./context.js";

const PROBE_URL = "/api/v1/test/paid-probe";
const PROBE_FEATURE: FeatureKey = "reports";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A Paid route that exists only in this test. */
function withProbe(app: FastifyInstance): void {
  const config = { entitlement: PROBE_FEATURE };
  app.get(PROBE_URL, { config }, async () => ({ ok: true }));
  app.post(PROBE_URL, { config }, async () => ({ ok: true }));
}

/** The URL of a route with every path parameter filled in. */
const concrete = (url: string): string => url.replace(/:[^/]+/g, "x");

/**
 * Every /api/v1 route must be listed exactly once: under the feature it
 * declares, or in ALWAYS_FREE_ROUTES without a declaration. HEAD routes
 * follow their GET route.
 */
function registryProblems(routes: readonly RouteInfo[]): string[] {
  const paid = new Map<string, FeatureKey>();
  for (const feature of FEATURES) {
    for (const key of feature.routes) paid.set(key, feature.key);
  }
  const free = new Set(ALWAYS_FREE_ROUTES);
  const problems: string[] = [];
  for (const route of routes) {
    if (route.method === "HEAD" || !route.url.startsWith("/api/v1/")) continue;
    const key = `${route.method} ${route.url}`;
    const feature = paid.get(key);
    if (feature !== undefined && free.has(key)) {
      problems.push(`${key} is in both lists`);
    } else if (feature !== undefined && route.entitlement !== feature) {
      problems.push(`${key} does not declare ${feature}`);
    } else if (free.has(key) && route.entitlement !== null) {
      problems.push(`${key} is Always Free but declares a feature`);
    } else if (feature === undefined && !free.has(key)) {
      problems.push(`${key} is in neither list`);
    }
  }
  return problems;
}

describe("feature registry on the server (contract C1)", () => {
  it("every Paid route answers 402 with its feature on Free", async () => {
    current = await testApp({ extend: withProbe });
    const { app } = current;
    const owner = await setupOwner(app);
    const paid = app.ctx.routes.filter((route) => route.entitlement !== null);
    expect(paid.map((route) => route.url)).toContain(PROBE_URL);
    for (const route of paid) {
      const name = `${route.method} ${route.url}`;
      const response = await app.inject({
        method: route.method as "GET",
        url: concrete(route.url),
        headers: headersOf(owner),
      });
      expect(response.statusCode, name).toBe(402);
      if (route.method !== "HEAD") {
        expect(response.json(), name).toEqual({
          error: "payment_required",
          plan: "free",
          feature: route.entitlement,
        });
      }
    }
  });

  it("Paid routes work on Paid and still need a session", async () => {
    current = await testApp({
      extend: withProbe,
      extraEnv: { DIALWARDEN_LICENCE: customerLicence() },
    });
    const { app } = current;
    const anonymous = await app.inject({ method: "GET", url: PROBE_URL });
    expect(anonymous.statusCode).toBe(401);
    const owner = await setupOwner(app);
    const response = await app.inject({
      method: "POST",
      url: PROBE_URL,
      headers: headersOf(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("every route the registry lists declares its feature and is not public", async () => {
    current = await testApp({ extend: withProbe });
    const routes = current.app.ctx.routes;
    const byKey = new Map(
      routes.map((route) => [`${route.method} ${route.url}`, route]),
    );
    for (const feature of FEATURES) {
      for (const key of feature.routes) {
        expect(byKey.get(key)?.entitlement, key).toBe(feature.key);
      }
    }
    for (const route of routes.filter((r) => r.entitlement !== null)) {
      expect(route.auth, `${route.method} ${route.url}`).not.toBe("public");
    }
  });

  it("every API route is Paid under one feature or listed as Always Free", async () => {
    // D1: a Paid route that forgets config.entitlement and is not listed
    // would otherwise pass silently. The probe is in neither list.
    current = await testApp({ extend: withProbe });
    const problems = registryProblems(current.app.ctx.routes);
    expect(problems).toEqual([
      `GET ${PROBE_URL} is in neither list`,
      `POST ${PROBE_URL} is in neither list`,
    ]);
  });

  it("finds an unlisted route that forgot its entitlement", async () => {
    const forgotten = "/api/v1/test/forgotten-paid-route";
    current = await testApp({
      extend: (app) => {
        app.post(forgotten, async () => ({ ok: true }));
      },
    });
    const problems = registryProblems(current.app.ctx.routes);
    expect(problems).toEqual([`POST ${forgotten} is in neither list`]);
  });

  it("every route with config.entitlement is listed under its feature", async () => {
    current = await testApp({ extend: withProbe });
    const listed = new Map<string, FeatureKey>();
    for (const feature of FEATURES) {
      for (const key of feature.routes) {
        listed.set(key, feature.key);
      }
    }
    const gated = current.app.ctx.routes.filter(
      (route) => route.entitlement !== null && route.url !== PROBE_URL,
    );
    for (const route of gated) {
      // A HEAD route is the GET route of the same path.
      const method = route.method === "HEAD" ? "GET" : route.method;
      const key = `${method} ${route.url}`;
      expect(listed.get(key), key).toBe(route.entitlement);
    }
  });

  // P10-A G6.1: a HEAD route is never a way around its GET's entitlement.
  it("G6.1 gives every HEAD route the entitlement of its GET", async () => {
    current = await testApp({ extend: withProbe });
    const routes = current.app.ctx.routes;
    const gets = new Map(
      routes
        .filter((route) => route.method === "GET")
        .map((route) => [route.url, route.entitlement]),
    );
    const heads = routes.filter((route) => route.method === "HEAD");
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(gets.has(head.url), head.url).toBe(true);
      expect(head.entitlement, head.url).toBe(gets.get(head.url));
    }
  });

  it("E-04 answers 402 before the role check, and 401 first", async () => {
    current = await paidApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const viewer = await plainUser(app, "viewer");
    await toFree(app, owner);
    const body = { email: "e04@dialwarden.test", role: "viewer" };
    // A viewer would answer 403 forbidden were the role checked first; the
    // entitlement comes before the role, so Free answers 402.
    const byViewer = await call(
      app,
      viewer,
      "POST",
      "/api/v1/invitations",
      body,
    );
    expect(byViewer.statusCode).toBe(402);
    expect(byViewer.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "team.users",
    });
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("E-06 reads the plan of the moment, never a cached one", async () => {
    current = await paidApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const token = await call(app, owner, "POST", "/api/v1/tokens", {
      name: "cached",
      role: "viewer",
    });
    expect(token.statusCode).toBe(201);
    const value = token.json<{ token: string }>().token;
    const bearer = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: { authorization: `Bearer ${value}` },
      });
    const session = () => call(app, owner, "GET", "/api/v1/tokens");
    await toFree(app, owner);
    expect((await bearer()).statusCode).toBe(402);
    expect((await session()).statusCode).toBe(200);
    await toPaid(app, owner);
    expect((await bearer()).statusCode).toBe(200);
    await toFree(app, owner);
    expect((await bearer()).statusCode).toBe(402);
  });
});

/** A signed-in user of the given role, made directly for the order checks. */
async function plainUser(
  app: FastifyInstance,
  role: string,
): Promise<SignedIn> {
  const id = randomUUID();
  const password = randomPassword();
  const at = new Date().toISOString();
  const hash = await hashPassword(password);
  app.ctx.store.db
    .insert(users)
    .values({
      id,
      email: `${role}-${id.slice(0, 8)}@dialwarden.test`,
      name: role,
      role,
      passwordHash: hash,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `${role}-${id.slice(0, 8)}@dialwarden.test`, password },
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
