// The registry test (dev-work-plan P1 Acceptance, contract C1). Every route with
// config.entitlement answers 402 with its feature name on Free, is never
// public, and works on Paid; every Paid route the registry lists declares its
// feature. P1 has no Paid route yet, so a probe route stands in for them.
import { FEATURES, type FeatureKey } from "@dialwarden/entitlement";
import { customerLicence } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  testApp,
  type TestApp,
} from "../../test/helpers.js";

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
      const key = `${route.method} ${route.url}`;
      expect(listed.get(key), key).toBe(route.entitlement);
    }
  });
});
