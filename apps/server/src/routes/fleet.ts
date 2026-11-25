// The comparison matrix (dev-work-plan P9-A step 5, Paid feature
// fleet.matrix): the settings of one game by its servers, differences
// flagged, filtered by settings group and by servers. Any signed-in user may
// ask; the columns are only the servers that user may read.
import { isPackId } from "@dialwarden/packs-schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";

const matrixSchema = z.object({
  packId: z.string(),
  displayName: z.string(),
  groups: z.array(z.string()),
  group: z.string().nullable(),
  servers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      editable: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      group: z.string().nullable(),
      secret: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      differs: z.boolean(),
    }),
  ),
  differing: z.number().int(),
});

const slug = z.string().max(63).regex(SERVER_ID, "not a server id");

/** A comma list of server slugs, at most 200. */
export const slugList = z
  .string()
  .max(13_000)
  .transform((text) => text.split(",").filter((item) => item !== ""))
  .pipe(z.array(slug).max(200));

const matrixQuery = z.object({
  game: z.string().max(40).refine(isPackId, "not a game pack id"),
  group: z.string().min(1).max(80).optional(),
  servers: slugList.optional(),
});

export function fleetRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/fleet/matrix",
    {
      config: { auth: "user", entitlement: "fleet.matrix" },
      schema: {
        tags: ["fleet"],
        querystring: matrixQuery,
        response: { 200: matrixSchema },
      },
    },
    async (request) => {
      const visible = app.ctx.team.visibleServers(request.principal);
      const { game, group, servers } = request.query;
      return app.ctx.matrix.build({ packId: game, group, servers }, visible);
    },
  );
}
