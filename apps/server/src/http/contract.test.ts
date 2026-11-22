// Contract C1 between the web tests and the server. The web page tests stub
// fetch with the answers in apps/web/src/test/fixtures.ts; this test parses
// those answers with the server's own schemas and compares their keys with
// what the running server answers, so a change on either side fails here.
import { afterEach, describe, expect, it } from "vitest";
import {
  backupItems,
  entitlement,
  health,
  OWNER,
  paidFromEnvironment,
  paidFromUi,
  registry,
  systemStatus,
} from "../../../web/src/test/fixtures.js";
import {
  headersOf,
  setupOwner,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { entitlementSchema, signedInSchema } from "./schemas.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** The sorted own keys of an object answer. */
function keysOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("an object answer was expected");
  }
  return Object.keys(value).sort();
}

/** The first element of an array answer. */
function firstOf(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("a non-empty array answer was expected");
  }
  return value[0];
}

function pick(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error(`no ${key} in a non-object answer`);
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

describe("web fixtures against the server (contract C1)", () => {
  it("parse with the server schemas", () => {
    expect(entitlementSchema.parse(entitlement())).toEqual(entitlement());
    expect(entitlementSchema.parse(paidFromEnvironment())).toEqual(
      paidFromEnvironment(),
    );
    expect(entitlementSchema.parse(paidFromUi())).toEqual(paidFromUi());
    expect(signedInSchema.parse(OWNER)).toEqual(OWNER);
  });

  it("carry the keys of the entitlement, session, health and registry answers", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: headersOf(owner),
    });
    expect(session.statusCode).toBe(200);
    expect(keysOf(session.json())).toEqual(keysOf(OWNER));
    expect(keysOf(pick(session.json(), "user"))).toEqual(keysOf(OWNER.user));

    const live = await app.inject({
      method: "GET",
      url: "/api/v1/entitlement",
      headers: headersOf(owner),
    });
    expect(live.statusCode).toBe(200);
    const fixture = entitlement();
    expect(keysOf(live.json())).toEqual(keysOf(fixture));
    for (const key of ["limits", "features", "envLicence"]) {
      expect(keysOf(pick(live.json(), key)), key).toEqual(
        keysOf(pick(fixture, key)),
      );
    }

    const healthz = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthz.statusCode).toBe(200);
    expect(keysOf(healthz.json())).toEqual(keysOf(health));

    const plans = await app.inject({
      method: "GET",
      url: "/api/v1/plan/registry",
      headers: headersOf(owner),
    });
    expect(plans.statusCode).toBe(200);
    expect(keysOf(plans.json())).toEqual(keysOf(registry));
    expect(keysOf(firstOf(pick(plans.json(), "features")))).toEqual(
      keysOf(firstOf(registry.features)),
    );
    expect(keysOf(firstOf(pick(plans.json(), "limits")))).toEqual(
      keysOf(firstOf(registry.limits)),
    );
  });

  it("carry the keys of the system status and a backup item", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/system/status",
      headers: headersOf(owner),
    });
    expect(status.statusCode).toBe(200);
    expect(keysOf(status.json())).toEqual(keysOf(systemStatus));
    for (const key of ["appSecret", "backups"]) {
      expect(keysOf(pick(status.json(), key)), key).toEqual(
        keysOf(pick(systemStatus, key)),
      );
    }

    const run = await app.inject({
      method: "POST",
      url: "/api/v1/system/backups",
      headers: headersOf(owner),
    });
    expect(run.statusCode).toBe(201);
    expect(keysOf(run.json())).toEqual(keysOf(firstOf(backupItems)));

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/system/backups",
      headers: headersOf(owner),
    });
    expect(list.statusCode).toBe(200);
    expect(keysOf(firstOf(pick(list.json(), "items")))).toEqual(
      keysOf(firstOf(backupItems)),
    );
  });
});
