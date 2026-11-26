// Background drift detection (dev-work-plan P9-A step 4, Paid feature
// drift.background): the check settings of the servers the caller may see,
// the interval of one server (owner and admin, like its hooks) and a check
// now. The outside-edit detection on every open stays Always Free (contract
// C1) and needs none of these routes.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
} from "../drift/service.js";
import { onSlug } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import { actorOf } from "./changes.js";
import { connectorFailure } from "./connectors.js";

const driftSchema = z.object({
  serverId: z.string(),
  enabled: z.boolean(),
  intervalMinutes: z.number().int(),
  lastCheckedAt: z.string().nullable(),
  lastResult: z.enum(["clean", "drift", "error"]).nullable(),
  lastError: z.string().nullable(),
  lastChangeSetId: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .min(MIN_INTERVAL_MINUTES)
    .max(MAX_INTERVAL_MINUTES),
});

const slugParams = z.object({
  slug: z.string().max(63).regex(SERVER_ID, "not a server id"),
});

export function driftRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const feature = { entitlement: "drift.background" as const };
  const service = () => app.ctx.drift;

  api.get(
    "/api/v1/drift",
    {
      config: { auth: "user", ...feature },
      schema: {
        tags: ["drift"],
        response: { 200: z.object({ items: z.array(driftSchema) }) },
      },
    },
    async (request) => {
      const visible = app.ctx.team.visibleServers(request.principal);
      return { items: service().list(visible) };
    },
  );

  api.put(
    "/api/v1/servers/:slug/drift",
    {
      config: { ...onSlug("admin"), ...feature },
      schema: {
        tags: ["drift"],
        params: slugParams,
        body: settingsSchema,
        response: { 200: driftSchema },
      },
    },
    async (request) =>
      service().set(request.params.slug, request.body, actorOf(request)),
  );

  api.post(
    "/api/v1/servers/:slug/drift/check",
    {
      config: { ...onSlug("read"), ...feature },
      schema: {
        tags: ["drift"],
        params: slugParams,
        response: { 200: driftSchema },
      },
    },
    async (request) => {
      const server = app.ctx.servers.require(request.params.slug);
      try {
        return await service().check(server);
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );
}
