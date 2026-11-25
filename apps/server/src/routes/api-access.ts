// API tokens (dev-work-plan P8-A step 6). Every signed-in user lists, makes
// and revokes their own tokens; making one is Paid (apiTokens), listing and
// revoking work on every plan. The value is in the answer of the POST only.
// No token reaches these routes: a token never makes or revokes a token.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import { ASSIGNABLE_ROLES } from "../team/roles.js";
import { principalOf } from "./users.js";

const tokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ASSIGNABLE_ROLES),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const idParams = z.object({ id: z.uuid() });

export function apiAccessRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const tokens = () => app.ctx.tokens;
  const own = { auth: "user" as const, tokens: false };

  api.get(
    "/api/v1/tokens",
    {
      config: own,
      schema: {
        tags: ["tokens"],
        response: { 200: z.object({ items: z.array(tokenViewSchema) }) },
      },
    },
    async (request) => ({
      items: tokens().list(principalOf(request).userId),
    }),
  );

  api.post(
    "/api/v1/tokens",
    {
      config: { ...own, entitlement: "apiTokens" },
      schema: {
        tags: ["tokens"],
        body: z.object({
          name: z.string().trim().min(1).max(100),
          role: z.enum(ASSIGNABLE_ROLES),
        }),
        response: { 201: tokenViewSchema.extend({ token: z.string() }) },
      },
    },
    async (request, reply) => {
      const made = tokens().create(principalOf(request), request.body);
      void reply.code(201);
      void reply.header("cache-control", "no-store");
      return made;
    },
  );

  api.delete(
    "/api/v1/tokens/:id",
    {
      config: own,
      schema: { tags: ["tokens"], params: idParams },
    },
    async (request, reply) => {
      tokens().revoke(principalOf(request), request.params.id);
      return reply.code(204).send();
    },
  );
}
