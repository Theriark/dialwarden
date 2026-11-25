// Users, roles and grants (dev-work-plan P8-A step 2) and the privacy
// controls on users (step 7). Role and grant changes are Paid (team.roles);
// listing, deleting, anonymising and exporting users are privacy controls
// and work on every plan (contract C1). The owner and admins manage users:
// an admin only editors and viewers (D3); nobody changes their own role or
// the owner. No route here takes an API token (D15).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import { newPasswordSchema, signedInSchema } from "../http/schemas.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { startSession } from "./auth.js";
import { SERVER_ID } from "../plan/editable.js";
import { GRANT_LEVELS, ROLES, type Principal } from "../team/roles.js";

const grantSchema = z.object({
  server: z.string().max(63).regex(SERVER_ID, "not a server id"),
  level: z.enum(GRANT_LEVELS),
});

export const grantsSchema = z.array(grantSchema).max(500);

export const userViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  effectiveRole: z.enum(ROLES),
  totpEnabled: z.boolean(),
  sso: z.boolean(),
  localPassword: z.boolean(),
  createdAt: z.string(),
  grants: grantsSchema,
});

export const linkSchema = z.object({
  token: z.string(),
  link: z.string(),
  expiresAt: z.string(),
});

const idParams = z.object({ id: z.uuid() });

/** The principal of a signed-in route (the guard already refused others). */
export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === null) {
    throw new ApiError(401, "unauthenticated");
  }
  return request.principal;
}

export function userRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const team = () => app.ctx.team;
  const admin = { auth: "admin" as const, tokens: false };

  api.get(
    "/api/v1/users",
    {
      config: admin,
      schema: {
        tags: ["users"],
        response: { 200: z.object({ items: z.array(userViewSchema) }) },
      },
    },
    async () => ({ items: team().list() }),
  );

  api.get(
    "/api/v1/users/:id",
    {
      config: admin,
      schema: {
        tags: ["users"],
        params: idParams,
        response: { 200: userViewSchema },
      },
    },
    async (request) => team().get(request.params.id),
  );

  api.put(
    "/api/v1/users/:id/role",
    {
      config: { ...admin, entitlement: "team.roles" },
      schema: {
        tags: ["users"],
        params: idParams,
        // The owner role is refused in the service, after the own-role and
        // owner checks, so each refusal keeps its own code.
        body: z.object({ role: z.enum(ROLES) }),
        response: { 200: userViewSchema },
      },
    },
    async (request) =>
      team().setRole(
        principalOf(request),
        request.params.id,
        request.body.role,
      ),
  );

  api.put(
    "/api/v1/users/:id/grants",
    {
      config: { ...admin, entitlement: "team.roles" },
      schema: {
        tags: ["users"],
        params: idParams,
        body: z.object({ servers: grantsSchema }),
        response: { 200: userViewSchema },
      },
    },
    async (request) =>
      team().setGrants(
        principalOf(request),
        request.params.id,
        request.body.servers,
      ),
  );

  api.delete(
    "/api/v1/users/:id",
    {
      config: admin,
      schema: { tags: ["users", "privacy"], params: idParams },
    },
    async (request, reply) => {
      team().remove(principalOf(request), request.params.id);
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/users/:id/anonymise",
    {
      config: admin,
      schema: {
        tags: ["users", "privacy"],
        params: idParams,
        response: { 200: userViewSchema },
      },
    },
    async (request) =>
      team().anonymise(principalOf(request), request.params.id),
  );

  api.post(
    "/api/v1/users/:id/password-reset",
    {
      config: admin,
      schema: {
        tags: ["users"],
        params: idParams,
        response: { 201: linkSchema },
      },
    },
    async (request, reply) => {
      const link = team().createReset(principalOf(request), request.params.id);
      void reply.code(201);
      return link;
    },
  );

  // The owner answers access requests as the controller (D24); everybody
  // else exports only their own data, at /api/v1/me/export.
  api.get(
    "/api/v1/users/:id/export",
    {
      config: admin,
      schema: { tags: ["users", "privacy"], params: idParams },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      const target = team().require(request.params.id);
      if (target.role === "owner" && actor.storedRole !== "owner") {
        throw new ApiError(403, "cannot_change_owner");
      }
      if (actor.role !== "owner") throw new ApiError(403, "forbidden");
      return sendExport(reply, team().exportOf(target.id));
    },
  );

  api.get(
    "/api/v1/me/export",
    {
      config: { auth: "user", tokens: false },
      schema: { tags: ["privacy"] },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      return sendExport(reply, team().exportOf(actor.userId));
    },
  );

  // A reset link made by the owner (D21): public, the value is the proof.
  // The use signs the user in, like a login does (S-05).
  api.post(
    "/api/v1/auth/password-reset",
    {
      config: { auth: "public", tokens: false },
      schema: {
        tags: ["auth"],
        body: z.object({
          token: z.string().min(1).max(200),
          password: newPasswordSchema,
        }),
        response: { 200: signedInSchema },
      },
    },
    async (request, reply) => {
      const user = await team().useReset(request.body, request.ip);
      return startSession(app, request, reply, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        totpEnabled: user.totpSecretEnc !== null,
      });
    },
  );
}

/** A JSON download that no cache keeps. */
function sendExport(reply: FastifyReply, data: Record<string, unknown>) {
  void reply.header("content-type", "application/json; charset=utf-8");
  void reply.header(
    "content-disposition",
    'attachment; filename="dialwarden-export.json"',
  );
  void reply.header("cache-control", "no-store");
  return reply.send(JSON.stringify(data, null, 2));
}
