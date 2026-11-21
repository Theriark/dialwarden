// /healthz (container health: version, build dates and the plan, never licence
// detail) and /readyz (the database answers).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";

/** The plan; Free while the database is closed (first-run import). */
function currentPlan(app: FastifyInstance): "free" | "paid" {
  if (!app.ctx.store.isOpen) {
    return "free";
  }
  return app.ctx.entitlement.getEntitlement().plan;
}

export function healthRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/healthz",
    {
      config: { auth: "public" },
      schema: {
        tags: ["health"],
        response: {
          200: z.object({
            status: z.literal("ok"),
            version: z.string(),
            revision: z.string(),
            buildDate: z.string().nullable(),
            featureBaseline: z.string().nullable(),
            plan: z.enum(["free", "paid"]),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      version: app.ctx.version,
      revision: app.ctx.build.revision,
      buildDate: app.ctx.build.buildDate,
      featureBaseline: app.ctx.build.featureBaseline,
      plan: currentPlan(app),
    }),
  );

  api.get(
    "/readyz",
    {
      config: { auth: "public" },
      schema: {
        tags: ["health"],
        response: {
          200: z.object({ status: z.literal("ready") }),
          503: z.object({ status: z.literal("not_ready") }),
        },
      },
    },
    async (_request, reply) => {
      const ctx = app.ctx;
      const ready = !ctx.maintenance && ctx.store.isOpen && ctx.store.ping();
      if (ready) {
        return { status: "ready" as const };
      }
      return reply.code(503).send({ status: "not_ready" as const });
    },
  );
}
