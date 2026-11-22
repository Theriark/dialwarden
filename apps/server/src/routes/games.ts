// Game packs (dev-work-plan P3-A step 2, contract C3). Both routes need a
// signed-in session (auth "user") and are Free: every game pack is Always Free
// in contract C1, so neither route declares config.entitlement and the
// registry lists neither. Secret settings are masked in every answer.
import { isPackId, maskSecrets } from "@dialwarden/packs-schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import type { ZodTypeProvider } from "../http/zod.js";

const gameSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
});

const entries = z.array(z.record(z.string(), z.unknown()));

const settingsMetaSchema = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  steamAppId: z.number().int(),
  os: z.array(z.enum(["linux", "windows"])),
  files: entries,
  settings: entries,
  rules: entries,
  presets: entries,
  hooksSupported: z.array(z.string()),
  sources: z.array(z.string()),
});

const idParams = z.object({
  id: z.string().max(40).refine(isPackId, "not a game pack id"),
});

export function gameRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const user = { auth: "user" as const };

  api.get(
    "/api/v1/games",
    {
      config: user,
      schema: {
        tags: ["games"],
        response: { 200: z.object({ items: z.array(gameSchema) }) },
      },
    },
    async () => {
      const items = [...app.ctx.packs.values()].map((pack) => ({
        id: pack.id,
        displayName: pack.displayName,
        version: pack.version,
      }));
      return { items };
    },
  );

  api.get(
    "/api/v1/games/:id/settings-meta",
    {
      config: user,
      schema: {
        tags: ["games"],
        params: idParams,
        response: { 200: settingsMetaSchema },
      },
    },
    async (request) => {
      const pack = app.ctx.packs.get(request.params.id);
      if (pack === undefined) {
        throw new ApiError(404, "game_not_found");
      }
      const masked = maskSecrets(pack);
      return {
        id: masked.id,
        version: masked.version,
        displayName: masked.displayName,
        steamAppId: masked.steamAppId,
        os: [...masked.os],
        files: masked.files.map((file) => ({ ...file })),
        settings: masked.settings.map((setting) => ({ ...setting })),
        rules: masked.rules.map((rule) => ({ ...rule })),
        presets: masked.presets.map((preset) => ({ ...preset })),
        hooksSupported: [...masked.hooksSupported],
        sources: [...masked.sources],
      };
    },
  );
}
