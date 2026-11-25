// Entitlement and licence endpoints (contract C1), the feature registry for the
// About page, and the Free fallback choice of editable servers.
import {
  ALWAYS_FREE,
  FEATURES,
  LIMITS,
  MAX_TOKEN_LENGTH,
} from "@dialwarden/entitlement";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import { entitlementSchema } from "../http/schemas.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";

/** Who acts: the internal user id (D7); the row keeps it, views show the label. */
const actorOf = (request: FastifyRequest) =>
  request.principal?.userId ?? "system";

const editableSchema = z.object({
  /** The servers editable on Free right now. */
  servers: z.array(z.string()),
  /** The owner's own choice (empty: the most recently edited apply). */
  chosen: z.array(z.string()),
  max: z.number().int(),
});

export function licenceRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/entitlement",
    {
      schema: {
        tags: ["licence"],
        response: { 200: entitlementSchema },
      },
    },
    async () => app.ctx.entitlement.getEntitlement(),
  );

  api.put(
    "/api/v1/licence",
    {
      config: { auth: "owner" },
      schema: {
        tags: ["licence"],
        body: z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) }),
        response: { 200: entitlementSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const result = app.ctx.licences.setUiLicence(request.body.token, actor);
      if (
        result.state === "malformed" ||
        result.state === "invalid_signature"
      ) {
        throw new ApiError(422, "invalid_licence", {
          reason: result.reason ?? result.state,
        });
      }
      return app.ctx.entitlement.getEntitlement();
    },
  );

  api.delete(
    "/api/v1/licence",
    {
      config: { auth: "owner" },
      schema: {
        tags: ["licence"],
        response: { 200: entitlementSchema },
      },
    },
    async (request) => {
      app.ctx.licences.removeUiLicence(actorOf(request));
      return app.ctx.entitlement.getEntitlement();
    },
  );

  api.put(
    "/api/v1/licence/environment",
    {
      config: { auth: "owner" },
      schema: {
        tags: ["licence"],
        body: z.object({ ignored: z.boolean() }),
        response: { 200: entitlementSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      app.ctx.licences.setEnvIgnored(request.body.ignored, actor);
      return app.ctx.entitlement.getEntitlement();
    },
  );

  api.get(
    "/api/v1/plan/registry",
    {
      schema: {
        tags: ["licence"],
        response: {
          200: z.object({
            features: z.array(
              z.object({
                key: z.string(),
                label: z.string(),
                available: z.boolean(),
              }),
            ),
            limits: z.array(
              z.object({
                key: z.string(),
                label: z.string(),
                free: z.number(),
                paid: z.union([z.number(), z.null(), z.literal("licence")]),
              }),
            ),
            alwaysFree: z.array(z.string()),
          }),
        },
      },
    },
    async () => ({
      features: FEATURES.map(({ key, label, available }) => ({
        key,
        label,
        available,
      })),
      limits: [...LIMITS],
      alwaysFree: [...ALWAYS_FREE],
    }),
  );

  api.get(
    "/api/v1/plan/editable-servers",
    {
      schema: {
        tags: ["licence"],
        response: { 200: editableSchema },
      },
    },
    async (request) => {
      // Only the servers this user may see (D25).
      const visible = app.ctx.team.visibleServers(request.principal);
      const mine = (ids: string[]) => ids.filter((id) => visible(id));
      return {
        servers: mine(app.ctx.editable.effective()),
        chosen: mine(app.ctx.editable.chosen()),
        max: app.ctx.editable.max,
      };
    },
  );

  api.put(
    "/api/v1/plan/editable-servers",
    {
      config: { auth: "owner" },
      schema: {
        tags: ["licence"],
        body: z.object({
          servers: z.array(z.string().regex(SERVER_ID)).max(10),
        }),
        response: { 200: editableSchema },
      },
    },
    async (request) => {
      const servers = app.ctx.editable.set(request.body.servers);
      return {
        servers,
        chosen: app.ctx.editable.chosen(),
        max: app.ctx.editable.max,
      };
    },
  );
}
