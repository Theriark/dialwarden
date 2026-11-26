// GET /api/v1/activity (contract C6), newest first, paged with before=.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVITY_TYPES } from "../activity/service.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { actorLabels } from "../team/labels.js";
import { atLeast } from "../team/roles.js";

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
      const principal = request.principal;
      // Editors and viewers see the events of their servers only; user and
      // licence events, which carry e-mail addresses, stay with the owner
      // and admins (D23). An admin's viewer-scoped API token sees the
      // servers its creator sees, as the inbox does (P10-A G7.5).
      const limited = principal !== null && !atLeast(principal.role, "admin");
      const visible = app.ctx.team.visibleServers(principal);
      const onlyServers = limited
        ? app.ctx.servers
            .list()
            .map((server) => server.id)
            .filter(visible)
        : [];
      const page = app.ctx.activity.list({
        limit,
        ...(before === undefined ? {} : { before }),
        ...(type === undefined ? {} : { type }),
        ...(serverId === undefined ? {} : { serverId }),
        ...(limited ? { onlyServers } : {}),
      });
      // The actor ids of the page as their display labels (D7).
      const labels = actorLabels(
        app.ctx.store,
        page.items.map((item) => item.actor),
      );
      return {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          actor: labels.get(item.actor) ?? item.actor,
        })),
      };
    },
  );
}
