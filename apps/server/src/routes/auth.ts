// First-run setup, sign-in, sign-out, profile, password and TOTP
// (dev-work-plan P1-A step 3). P1-B builds the screens against these.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PublicUser } from "../auth/service.js";
import { isSetupTokenShape, SETUP_TOKEN_HEADER } from "../auth/first-run.js";
import type { ActiveSession } from "../auth/sessions.js";
import { importFirstRun } from "../backup/import.js";
import { MAX_ARCHIVE_BYTES } from "../backup/archive.js";
import { ApiError } from "../http/errors.js";
import { clearSessionCookie, setSessionCookie } from "../http/guard.js";
import {
  emailSchema,
  newPasswordSchema,
  passphraseSchema,
  passwordSchema,
  signedInSchema,
  userSchema,
} from "../http/schemas.js";
import type { ZodTypeProvider } from "../http/zod.js";

/** First-run setup and import: the setup token (checked in onRequest). */
const setupHeaders = z
  .object({ [SETUP_TOKEN_HEADER]: z.string().max(128) })
  .loose();

const secondFactor = z.object({
  code: z.string().max(16).optional(),
  recoveryCode: z.string().max(32).optional(),
});

/**
 * The signed-in user as the API shows it, with the role the user acts with
 * now: viewer for every user but the owner on the Free fallback (P8-A step
 * 8); the stored role stays on the users row.
 */
export function userView(app: FastifyInstance, user: PublicUser) {
  const principal = app.ctx.team.principalOf(user);
  return { ...user, role: principal.role };
}

export function startSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  user: PublicUser,
) {
  // A new sign-in never keeps the old session (no session fixation).
  if (request.session !== null) {
    app.ctx.sessions.destroy(request.session.id);
  }
  // The session keeps the address as the audit IP setting says (D18).
  const session = app.ctx.sessions.create(user.id, {
    ip: app.ctx.audit.address(request.ip),
    userAgent: request.headers["user-agent"] ?? null,
  });
  setSessionCookie(app, reply, session);
  // From here the request acts as the new user (the audit log names them).
  request.principal = app.ctx.team.principalOf(user);
  return {
    status: "ok" as const,
    user: userView(app, user),
    csrfToken: session.csrfToken,
  };
}

/** The session of a signed-in route (the guard already refused anonymous). */
function signedIn(request: FastifyRequest): ActiveSession {
  if (request.session === null) {
    throw new ApiError(401, "unauthenticated");
  }
  return request.session;
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

/**
 * First-run setup and import need the one-time setup token (R&D decision
 * THE-2141). Checked in onRequest, before any body is read: a user exists
 * (409 setup_done), no header (403 setup_token_required), a wrong or
 * malformed token (403 setup_token_invalid).
 */
function requireSetupToken(app: FastifyInstance) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!app.ctx.auth.setupRequired()) {
      throw new ApiError(409, "setup_done");
    }
    // The literal name of SETUP_TOKEN_HEADER (a literal key for the lint).
    const header = request.headers["x-dialwarden-setup-token"];
    const sent = typeof header === "string" ? header.trim() : "";
    if (sent === "") {
      throw new ApiError(403, "setup_token_required");
    }
    if (!isSetupTokenShape(sent) || !app.ctx.setupToken.matches(sent)) {
      request.log.warn({ ip: request.ip }, "setup token refused");
      throw new ApiError(403, "setup_token_invalid");
    }
  };
}

/** Deletes the setup token once an owner exists; logs when it cannot. */
function closeFirstRunSetup(app: FastifyInstance, request: FastifyRequest) {
  try {
    app.ctx.setupToken.remove();
  } catch (error) {
    request.log.error({ err: error }, "could not delete DATA_DIR/setup-token");
  }
}

export function authRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const setupToken = requireSetupToken(app);

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
      onRequest: setupToken,
      schema: {
        tags: ["setup"],
        headers: setupHeaders,
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
      closeFirstRunSetup(app, request);
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
      onRequest: [
        setupToken,
        async () => {
          if (app.ctx.importing) {
            throw new ApiError(409, "import_running");
          }
        },
      ],
      schema: {
        tags: ["setup", "backup"],
        headers: setupHeaders
          .extend({ "x-dialwarden-passphrase": passphraseSchema })
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
      // Refused before a byte is stored; the stream is capped as well.
      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_ARCHIVE_BYTES) {
        body.resume();
        throw new ApiError(413, "too_large", { max: MAX_ARCHIVE_BYTES });
      }
      const passphrase = request.headers["x-dialwarden-passphrase"];
      const result = await importFirstRun(app.ctx, body, passphrase);
      closeFirstRunSetup(app, request);
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
        user: userView(app, session.user),
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

  // Public so an expired session still gets its cookie cleared; the guard
  // still checks the CSRF header whenever a session exists.
  api.post(
    "/api/v1/auth/logout",
    { config: { auth: "public" }, schema: { tags: ["auth"] } },
    async (request, reply) => {
      if (request.session !== null) {
        app.ctx.sessions.destroy(request.session.id);
      }
      clearSessionCookie(app, reply);
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
      const user = app.ctx.auth.updateProfile(userId, request.body.name);
      return { user: userView(app, user) };
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
      const session = signedIn(request);
      const codes = app.ctx.auth.totpEnable(session.user.id, request.body.code);
      // A session stolen before TOTP was on does not stay valid.
      app.ctx.sessions.destroyForUser(session.user.id, session.id);
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
      const session = signedIn(request);
      await app.ctx.auth.totpDisable(
        session.user.id,
        request.body.password,
        answer(request.body),
      );
      app.ctx.sessions.destroyForUser(session.user.id, session.id);
      return reply.code(204).send();
    },
  );
}
