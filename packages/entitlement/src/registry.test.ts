import { describe, expect, it } from "vitest";
import {
  ALWAYS_FREE,
  FEATURE_KEYS,
  FEATURES,
  FREE_LIMITS,
  LIMIT_KEYS,
  LIMITS,
  featureMap,
} from "./registry.js";

describe("feature registry (contract C1)", () => {
  it("registers every FeatureKey exactly once", () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual([...FEATURE_KEYS]);
  });

  it("registers every LimitKey with the C1 values", () => {
    expect(LIMITS.map((limit) => limit.key)).toEqual([...LIMIT_KEYS]);
    expect(FREE_LIMITS).toEqual({
      servers: 3,
      users: 1,
      historyVisible: 5,
      presets: 3,
    });
  });

  it("keeps the assistant off in 27.0.0", () => {
    expect(featureMap(true).assistant).toBe(false);
    expect(featureMap(false).assistant).toBe(false);
  });

  it("lists no Always-Free item as a Paid feature", () => {
    const labels = FEATURES.map((feature) => feature.label.toLowerCase());
    for (const item of ALWAYS_FREE) {
      expect(labels).not.toContain(item.toLowerCase());
    }
  });

  it("writes Paid routes as METHOD /api/v1/path", () => {
    for (const feature of FEATURES) {
      for (const route of feature.routes) {
        expect(route).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
      }
    }
  });
});
