// The API contract of P9-A for the web client of P9-C: every route of the
// Paid fleet layer is in /api/v1/openapi.json with its tag and the shape of
// its answer, and every Paid one names its feature in config.entitlement.
import { FEATURES } from "@dialwarden/entitlement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp, type TestApp } from "../../test/helpers.js";

interface Operation {
  tags?: string[];
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

type Paths = Record<string, Record<string, Operation>>;

const ROUTES: readonly [string, string, string, string][] = [
  ["post", "/api/v1/presets/{id}/bulk-drafts", "presets", "200"],
  ["post", "/api/v1/presets/bulk-apply", "presets", "200"],
  ["get", "/api/v1/schedules", "schedules", "200"],
  ["post", "/api/v1/schedules", "schedules", "201"],
  ["get", "/api/v1/schedules/{id}", "schedules", "200"],
  ["delete", "/api/v1/schedules/{id}", "schedules", "204"],
  ["get", "/api/v1/drift", "drift", "200"],
  ["put", "/api/v1/servers/{slug}/drift", "drift", "200"],
  ["post", "/api/v1/servers/{slug}/drift/check", "drift", "200"],
  ["get", "/api/v1/fleet/matrix", "fleet", "200"],
  ["get", "/api/v1/reports/changes", "reports", "200"],
  ["get", "/api/v1/reports/changes/print", "reports", "200"],
  ["post", "/api/v1/system/demo-drift/run", "system", "200"],
];

let current: TestApp;
let paths: Paths;

beforeAll(async () => {
  current = await testApp();
  const response = await current.app.inject({ url: "/api/v1/openapi.json" });
  paths = response.json<{ paths: Paths }>().paths;
});

afterAll(async () => {
  await current.close();
});

describe("the P9-A API contract", () => {
  it("documents every fleet route with its tag and answer", () => {
    const byPath = new Map(Object.entries(paths));
    for (const [method, path, tag, status] of ROUTES) {
      const operations = new Map(Object.entries(byPath.get(path) ?? {}));
      const operation = operations.get(method);
      expect(operation, `${method} ${path}`).toBeDefined();
      expect(operation?.tags, `${method} ${path}`).toContain(tag);
      if (status !== "204") {
        const responses = new Map(Object.entries(operation?.responses ?? {}));
        expect(
          responses.get(status)?.content,
          `${method} ${path} ${status}`,
        ).toBeDefined();
      }
    }
  });

  it("declares config.entitlement on every Paid route of P9-A", () => {
    const keys = [
      "presets.bulk",
      "schedules",
      "drift.background",
      "fleet.matrix",
      "reports",
    ];
    for (const feature of FEATURES.filter((item) => keys.includes(item.key))) {
      expect(feature.routes.length, feature.key).toBeGreaterThan(0);
      for (const key of feature.routes) {
        const route = current.app.ctx.routes.find(
          (item) => `${item.method} ${item.url}` === key,
        );
        expect(route?.entitlement, key).toBe(feature.key);
      }
    }
  });
});
