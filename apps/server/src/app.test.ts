import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health stub", () => {
  it("reports version, revision, build date and baseline", async () => {
    app = buildApp({
      LOG_LEVEL: "silent",
      DIALWARDEN_REVISION: sha,
      DIALWARDEN_BUILD_EPOCH: "1795244400",
      DIALWARDEN_FEATURE_BASELINE_EPOCH: "1795244400",
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      version: "27.0.0",
      revision: sha,
      buildDate: "2026-11-21T07:00:00Z",
      featureBaseline: "2026-11-21T07:00:00Z",
    });
  });

  it("answers readiness", async () => {
    app = buildApp({ LOG_LEVEL: "silent" });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});
