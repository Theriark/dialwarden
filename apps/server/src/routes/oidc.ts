// OIDC sign-in and its settings (dev-work-plan P8-A step 5, Paid feature
// oidc). The settings routes declare the feature; the sign-in routes are
// public (a visitor has no session yet), so they check the plan in the service
// and answer the same C1 402 body (O-30).
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { CALLBACK_PATH } from "../oidc/service.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { startSession } from "./auth.js";

/** The transaction cookie of one sign-in (D12). */
export const OIDC_COOKIE = "dw_oidc";
const OIDC_COOKIE_PATH = "/api/v1/auth/oidc";

const ROLE_MAPPING_MAX = 100;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Space-separated scope tokens (RFC 6749 3.3), the first one openid. */
function scopeValid(value: string): boolean {
  const tokens = value.split(" ");
  return (
    tokens[0] === "openid" && tokens.every((item) => SCOPE_TOKEN.test(item))
  );
}

const viewSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  scope: z.string(),
  groupsClaim: z.string(),
  roleMapping: z.record(z.string(), z.string()),
  allowPrivateNetwork: z.boolean(),
  redirectUri: z.string().nullable(),
});

const inputSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().trim().min(1).max(2048),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().max(1024).optional(),
  scope: z.string().trim().max(500).refine(scopeValid).optional(),
  groupsClaim: z.string().trim().min(1).max(100).optional(),
  // The values are checked in the service, so a mapping to owner answers
  // 422 invalid_role_mapping instead of a schema 400 (O-18).
  roleMapping: z
    .record(z.string().min(1).max(200), z.string().max(20))
    .refine((value) => Object.keys(value).length <= ROLE_MAPPING_MAX),
  allowPrivateNetwork: z.boolean(),
});

/**
 * Signed, HttpOnly, SameSite Lax (the callback is a cross-site navigation
 * from the provider, so a Strict cookie would never arrive), limited to the
 * OIDC paths and to 10 minutes.
 */
function setTransactionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  state: string,
): void {
  const secure = app.ctx.config.baseUrl?.startsWith("https://") ?? false;
  void reply.setCookie(OIDC_COOKIE, state, {
    path: OIDC_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure,
    signed: true,
    maxAge: 600,
  });
}

function clearTransactionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
): void {
  const secure = app.ctx.config.baseUrl?.startsWith("https://") ?? false;
  void reply.clearCookie(OIDC_COOKIE, { path: OIDC_COOKIE_PATH, secure });
}

export function oidcRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/auth/oidc",
    {
      config: { auth: "public" },
      schema: {
        tags: ["auth"],
        response: { 200: z.object({ enabled: z.boolean() }) },
      },
    },
    async () => ({ enabled: app.ctx.oidc.active() }),
  );

  api.get(
    "/api/v1/auth/oidc/start",
    {
      config: { auth: "public" },
      schema: {
        tags: ["auth"],
        querystring: z.object({ returnTo: z.string().max(2048).optional() }),
      },
    },
    async (request, reply) => {
      const { url, state } = await app.ctx.oidc.start(
        request.query.returnTo,
        request.ip,
      );
      setTransactionCookie(app, reply, state);
      return reply.redirect(url, 302);
    },
  );

  api.get(
    CALLBACK_PATH,
    {
      config: { auth: "public" },
      schema: {
        tags: ["auth"],
        querystring: z.record(z.string(), z.string().max(4096)),
      },
    },
    async (request, reply) => {
      // The literal name of OIDC_COOKIE (a literal key for the lint).
      const raw = request.cookies.dw_oidc;
      const unsigned =
        raw === undefined ? null : request.unsignCookie(raw).value;
      clearTransactionCookie(app, reply);
      const { user, returnTo } = await app.ctx.oidc.callback(
        request.query,
        unsigned,
      );
      startSession(app, request, reply, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        totpEnabled: user.totpSecretEnc !== null,
      });
      return reply.redirect(returnTo, 302);
    },
  );

  api.get(
    "/api/v1/settings/oidc",
    {
      config: { auth: "owner", entitlement: "oidc", tokens: false },
      schema: { tags: ["settings"], response: { 200: viewSchema } },
    },
    async () => app.ctx.oidc.view(),
  );

  api.put(
    "/api/v1/settings/oidc",
    {
      config: { auth: "owner", entitlement: "oidc", tokens: false },
      schema: {
        tags: ["settings"],
        body: inputSchema,
        response: { 200: viewSchema },
      },
    },
    async (request) => app.ctx.oidc.configure(request.body),
  );
}
