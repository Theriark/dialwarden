// Invitation links (dev-work-plan P8-A step 2): single use, valid for 72
// hours, only the SHA-256 of the value stored. Making and listing
// invitations is Paid (team.users); revoking one works on every plan. The
// accept is public: the value is the proof, it travels in the body (the link
// keeps it in the URL fragment, which no server or Referer sees), and every
// refusal of it answers the same 410 invitation_invalid. The users limit of
// contract C1 is checked at the accept, when the user is added.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import {
  emailSchema,
  newPasswordSchema,
  signedInSchema,
} from "../http/schemas.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { ASSIGNABLE_ROLES } from "../team/roles.js";
import { startSession } from "./auth.js";
import { grantsSchema, principalOf } from "./users.js";

const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ASSIGNABLE_ROLES),
  grants: grantsSchema,
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const idParams = z.object({ id: z.uuid() });

export function invitationRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const team = () => app.ctx.team;
  const admin = { auth: "admin" as const, tokens: false };

  api.post(
    "/api/v1/invitations",
    {
      config: { ...admin, entitlement: "team.users" },
      schema: {
        tags: ["users"],
        body: z.object({
          email: emailSchema,
          role: z.enum(ASSIGNABLE_ROLES),
          grants: grantsSchema.default([]),
        }),
        response: {
          201: invitationSchema.extend({
            token: z.string(),
            link: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      // While OIDC is on, people join through the provider (L1, O-28).
      if (app.ctx.oidc.active()) throw new ApiError(409, "oidc_active");
      const made = team().invite(principalOf(request), request.body);
      void reply.code(201);
      return made;
    },
  );

  api.get(
    "/api/v1/invitations",
    {
      config: { ...admin, entitlement: "team.users" },
      schema: {
        tags: ["users"],
        response: { 200: z.object({ items: z.array(invitationSchema) }) },
      },
    },
    async () => ({ items: team().invitations() }),
  );

  api.delete(
    "/api/v1/invitations/:id",
    {
      config: admin,
      schema: { tags: ["users"], params: idParams },
    },
    async (request, reply) => {
      team().revokeInvitation(principalOf(request), request.params.id);
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/invitations/accept",
    {
      config: { auth: "public", tokens: false },
      schema: {
        tags: ["users"],
        body: z.object({
          token: z.string().min(1).max(200),
          name: z.string().trim().min(1).max(100),
          password: newPasswordSchema,
        }),
        response: { 201: signedInSchema },
      },
    },
    async (request, reply) => {
      // Only the owner signs in with a password while OIDC is on (O-28); an
      // invitation made before stays open for after OIDC is turned off.
      if (app.ctx.oidc.active()) throw new ApiError(403, "sso_required");
      const user = await team().accept(request.body, request.ip);
      void reply.code(201);
      return startSession(app, request, reply, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        totpEnabled: false,
      });
    },
  );
}
