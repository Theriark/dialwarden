// The run-now button of the demo drift job (P10 correction, Risks 20). DEMO
// ONLY: without DEMO_SEED it answers 404 demo_seed_off and changes nothing.
// Owner only, and under /api/v1/system/, so no API token reaches it. It lets
// the Test Engineer see one simulated outside edit on Development at once
// instead of waiting for the daily job.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import { connectorFailure } from "./connectors.js";

export function demoRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    "/api/v1/system/demo-drift/run",
    {
      config: { auth: "owner" },
      schema: {
        tags: ["system"],
        response: {
          200: z.object({
            serverId: z.string(),
            changeSetId: z.string().nullable(),
            line: z.string(),
          }),
        },
      },
    },
    async () => {
      try {
        return await app.ctx.demoDrift.run();
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );
}
