// First-run setup, sign-in, sign-out, profile, password and TOTP
// (dev-work-plan P1-A step 3). P1-B builds the screens against these.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PublicUser } from "../auth/service.js";
import { importFirstRun } from "../backup/import.js";
import { MIN_PASSPHRASE_LENGTH } from "../backup/archive.js";
import { ApiError } from "../http/errors.js";
import { clearSessionCookie, setSessionCookie } from "../http/guard.js";
import {
  emailSchema,
  newPasswordSchema,
  passwordSchema,
  signedInSchema,
  userSchema,
} from "../http/schemas.js";
import type { ZodTypeProvider } from "../http/zod.js";

const passphraseSchema = z.string().min(MIN_PASSPHRASE_LENGTH).max(1024);

const secondFactor = z.object({
  code: z.string().max(16).optional(),
  recoveryCode: z.string().max(32).optional(),
});

function startSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  user: PublicUser,
) {
  // A new sign-in never keeps the old session (no session fixation).
  if (request.session !== null) {
    app.ctx.sessions.destroy(request.session.id);
  }
  const session = app.ctx.sessions.create(user.id, {
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
  });
  setSessionCookie(app, reply, session);
  return { status: "ok" as const, user, csrfToken: session.csrfToken };
}

function answer(body: z.infer<typeof secondFactor>) {
  const out: { code?: string; recoveryCode?: string } = {};
  if (body.code !== undefined) {
    out.code = body.code;
  }
  if (body.recoveryCode !== undefined) {
    out.recoveryCode = body.recoveryCode;
  }
  return out;
}

export function authRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/setup",
    {
      config: { auth: "public" },
      schema: {
        tags: ["setup"],
        response: { 200: z.object({ required: z.boolean() }) },
      },
    },
    async () => ({ required: app.ctx.auth.setupRequired() }),
  );

  api.post(
    "/api/v1/setup",
    {
      config: { auth: "public" },
      schema: {
        tags: ["setup"],
        body: z.object({
          email: emailSchema,
          password: newPasswordSchema,
          name: z.string().trim().min(1).max(100),
        }),
        response: { 201: signedInSchema },
      },
    },
    async (request, reply) => {
      const user = await app.ctx.auth.setup(request.body);
      void reply.code(201);
      return startSession(app, request, reply, user);
    },
  );

  // The body is the raw export file; the passphrase comes in a header so the
  // file can stream to disk without being held in memory.
  api.post(
    "/api/v1/setup/import",
    {
      config: { auth: "public" },
      schema: {
        tags: ["setup", "backup"],
        headers: z
          .object({ "x-dialwarden-passphrase": passphraseSchema })
          .loose(),
        response: {
          200: z.object({
            status: z.literal("imported"),
            createdAt: z.string(),
            reencrypted: z.number().int(),
          }),
        },
      },
    },
    async (request) => {
      const body: unknown = request.body;
      if (!(body instanceof Readable)) {
        throw new ApiError(415, "octet_stream_required");
      }
      const passphrase = request.headers["x-dialwarden-passphrase"];
      const result = await importFirstRun(app.ctx, body, passphrase);
      request.log.info({ createdAt: result.createdAt }, "backup imported");
      return { status: "imported" as const, ...result };
    },
  );

  api.get(
    "/api/v1/auth/session",
    {
      schema: {
        tags: ["auth"],
        response: { 200: signedInSchema },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) {
        throw new ApiError(401, "unauthenticated");
      }
      return {
        status: "ok" as const,
        user: session.user,
        csrfToken: session.csrfToken,
      };
    },
  );

  api.post(
    "/api/v1/auth/login",
    {
      config: { auth: "public" },
      schema: {
        tags: ["auth"],
        body: z.object({
          email: z.string().max(254),
          password: passwordSchema,
        }),
        response: {
          200: z.discriminatedUnion("status", [
            signedInSchema,
            z.object({
              status: z.literal("totp_required"),
              challenge: z.string(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const result = await app.ctx.auth.login(email, password, request.ip);
      if (result.status === "totp_required") {
        return result;
      }
      return startSession(app, request, reply, result.user);
    },
  );

  api.post(
    "/api/v1/auth/login/totp",
    {
      config: { auth: "public" },
      schema: {
        tags: ["auth"],
        body: secondFactor.extend({ challenge: z.string().max(100) }),
        response: { 200: signedInSchema },
      },
    },
    async (request, reply) => {
      const user = app.ctx.auth.loginSecondFactor(
        request.body.challenge,
        answer(request.body),
        request.ip,
      );
      return startSession(app, request, reply, user);
    },
  );

  api.post(
    "/api/v1/auth/logout",
    { schema: { tags: ["auth"] } },
    async (request, reply) => {
      if (request.session !== null) {
        app.ctx.sessions.destroy(request.session.id);
      }
      clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  api.patch(
    "/api/v1/auth/profile",
    {
      schema: {
        tags: ["auth"],
        body: z.object({ name: z.string().trim().min(1).max(100) }),
        response: { 200: z.object({ user: userSchema }) },
      },
    },
    async (request) => {
      const userId = request.session?.user.id ?? "";
      return { user: app.ctx.auth.updateProfile(userId, request.body.name) };
    },
  );

  api.post(
    "/api/v1/auth/password",
    {
      schema: {
        tags: ["auth"],
        body: z.object({
          currentPassword: passwordSchema,
          newPassword: newPasswordSchema,
        }),
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) {
        throw new ApiError(401, "unauthenticated");
      }
      const { currentPassword, newPassword } = request.body;
      await app.ctx.auth.changePassword(
        session.user.id,
        currentPassword,
        newPassword,
      );
      // Every other session of this user ends; this one stays.
      app.ctx.sessions.destroyForUser(session.user.id, session.id);
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/auth/totp/enrol",
    {
      schema: {
        tags: ["auth"],
        body: z.object({ password: passwordSchema }),
        response: {
          200: z.object({ secret: z.string(), otpauthUri: z.string() }),
        },
      },
    },
    async (request) => {
      const userId = request.session?.user.id ?? "";
      return app.ctx.auth.totpEnrol(userId, request.body.password);
    },
  );

  api.post(
    "/api/v1/auth/totp/enable",
    {
      schema: {
        tags: ["auth"],
        body: z.object({ code: z.string().max(16) }),
        response: {
          200: z.object({ recoveryCodes: z.array(z.string()).length(10) }),
        },
      },
    },
    async (request) => {
      const userId = request.session?.user.id ?? "";
      const codes = app.ctx.auth.totpEnable(userId, request.body.code);
      return { recoveryCodes: codes };
    },
  );

  api.post(
    "/api/v1/auth/totp/disable",
    {
      schema: {
        tags: ["auth"],
        body: secondFactor.extend({ password: passwordSchema }),
      },
    },
    async (request, reply) => {
      const userId = request.session?.user.id ?? "";
      await app.ctx.auth.totpDisable(
        userId,
        request.body.password,
        answer(request.body),
      );
      return reply.code(204).send();
    },
  );
}
