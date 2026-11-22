// GET /api/v1/games and GET /api/v1/games/ID/settings-meta (dev-work-plan P3-A
// step 2), served from the synthetic test pack of packages/packs-schema.
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "@dialwarden/entitlement";
import { SECRET_MASK } from "@dialwarden/packs-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const TEST_PACKS = fileURLToPath(
  new URL("../../../../packages/packs-schema/test/packs/", import.meta.url),
);
const GAMES = "/api/v1/games";
const META = "/api/v1/games/testpack/settings-meta";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(packsDir = TEST_PACKS) {
  current = await testApp({ config: { packsDir } });
  const owner = await setupOwner(current.app);
  return { app: current.app, headers: headersOf(owner) };
}

interface SettingsMeta {
  id: string;
  settings: { key: string; default?: unknown; secret?: boolean }[];
  presets: { id: string; values: Record<string, unknown> }[];
  rules: unknown[];
  files: unknown[];
}

describe("game packs API", () => {
  it("lists the loaded packs with id, name and version", async () => {
    const { app, headers } = await signedIn();
    const response = await app.inject({ url: GAMES, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: "testpack",
          displayName: "Synthetic test game",
          version: "1.0.0",
        },
      ],
    });
  });

  it("answers the settings metadata with secrets masked", async () => {
    const { app, headers } = await signedIn();
    const response = await app.inject({ url: META, headers });
    expect(response.statusCode).toBe(200);
    const body = response.json<SettingsMeta>();
    expect(body.id).toBe("testpack");
    expect(body.settings).toHaveLength(14);
    expect(body.rules).toHaveLength(3);
    expect(body.files).toHaveLength(4);
    const secret = body.settings.find((s) => s.key === "AdminPassword");
    expect(secret).toMatchObject({ secret: true, default: SECRET_MASK });
    const hardcore = body.presets.find((p) => p.id === "hardcore");
    expect(hardcore?.values["AdminPassword"]).toBe(SECRET_MASK);
    expect(response.body).not.toContain('"AdminPassword":"hardcore"');
    expect(response.body).not.toContain("detection");
  });

  it("answers 404 for an unknown pack and 400 for a bad id", async () => {
    const { app, headers } = await signedIn();
    const unknown = await app.inject({
      url: "/api/v1/games/nope/settings-meta",
      headers,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "game_not_found" });
    const bad = await app.inject({
      url: "/api/v1/games/Bad%20Id/settings-meta",
      headers,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("needs a signed-in session", async () => {
    current = await testApp({ config: { packsDir: TEST_PACKS } });
    for (const url of [GAMES, META]) {
      const response = await current.app.inject({ url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("is Free: no entitlement and nothing in the registry", async () => {
    current = await testApp({ config: { packsDir: TEST_PACKS } });
    const isGames = (url: string) => url.startsWith(GAMES);
    const routes = current.app.ctx.routes.filter((r) => isGames(r.url));
    const names = routes.map((route) => `${route.method} ${route.url}`);
    expect(names).toContain("GET /api/v1/games");
    expect(names).toContain("GET /api/v1/games/:id/settings-meta");
    for (const route of routes) {
      expect(route.entitlement, route.url).toBeNull();
      if (route.method === "GET") expect(route.auth, route.url).toBe("user");
    }
    const paid = FEATURES.flatMap((feature) => feature.routes);
    expect(paid.filter((route) => route.includes("/games"))).toEqual([]);
  });

  it("starts and lists no game when the only pack is broken", async () => {
    const root = await tempDir("dialwarden-packs-");
    try {
      mkdirSync(join(root, "broken"));
      writeFileSync(join(root, "broken", "pack.json"), "{ not json");
      const { app, headers } = await signedIn(root);
      const response = await app.inject({ url: GAMES, headers });
      expect(response.json()).toEqual({ items: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
