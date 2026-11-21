// P0 health stub (dev-work-plan P0 step 4), written by Platform as a recorded
// exception to one role per task. The Backend Developer replaces it in P1.
import { readFileSync } from "node:fs";
import { readBuildInfo } from "@dialwarden/entitlement";
import { fastify, type FastifyInstance } from "fastify";

// apps/server/package.json, next to src/ and dist/ (also in the image).
const pkg = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path in the package
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export function buildApp(
  env: NodeJS.ProcessEnv = process.env,
): FastifyInstance {
  const app = fastify({ logger: { level: env["LOG_LEVEL"] ?? "info" } });
  const build = readBuildInfo(env);
  app.get("/healthz", async () => ({
    status: "ok",
    version: pkg.version,
    revision: build.revision,
    buildDate: build.buildDate,
    featureBaseline: build.featureBaseline,
  }));
  app.get("/readyz", async () => ({ status: "ready" }));
  return app;
}
