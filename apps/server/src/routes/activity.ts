// GET /api/v1/activity (contract C6), newest first, paged with before=.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVITY_TYPES } from "../activity/service.js";
import type { ZodTypeProvider } from "../http/zod.js";

const eventSchema = z.object({
  id: z.number().int(),
  type: z.enum(ACTIVITY_TYPES),
  serverId: z.string().nullable(),
  at: z.string(),
  actor: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export function activityRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/activity",
    {
      schema: {
        tags: ["activity"],
        querystring: z.object({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          type: z.enum(ACTIVITY_TYPES).optional(),
          serverId: z.string().max(64).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(eventSchema),
            nextBefore: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { before, limit, type, serverId } = request.query;
      return app.ctx.activity.list({
        limit,
        ...(before === undefined ? {} : { before }),
        ...(type === undefined ? {} : { type }),
        ...(serverId === undefined ? {} : { serverId }),
      });
    },
  );
}
