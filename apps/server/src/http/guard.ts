// The request guard, one onRequest hook for every route:
// 1. reads the session from the signed cookie;
// 2. refuses API calls with 503 while a first-run import runs;
// 3. checks the CSRF header on every state-changing request with a session;
// 4. enforces config.auth. Every matched route defaults to "user", so a route
//    that forgets the setting is protected, not open. The level comes from the
//    matched route, never from request.url: Fastify routes on the decoded path,
//    so /%61pi/v1/activity reaches the /api/v1/activity handler;
// 5. answers 402 (contract C1) for a route whose config.entitlement feature the
//    current plan does not include.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, type NewSession } from "../auth/sessions.js";
import type { AuthLevel } from "./context.js";
import { ApiError, featureRequired } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSession(app: FastifyInstance, request: FastifyRequest): void {
  const raw = request.cookies.dw_session;
  if (raw === undefined || raw === "") {
    return;
  }
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) {
    return;
  }
  request.session = app.ctx.sessions.resolve(unsigned.value);
}

function authLevel(request: FastifyRequest): AuthLevel {
  // No matched route: the not-found handler answers 404 to everybody.
  if (request.routeOptions.url === undefined) {
    return "public";
  }
  return request.routeOptions.config.auth ?? "user";
}

/** The matched route pattern (decoded), or the raw URL when none matched. */
function routePath(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url;
}

export function registerGuard(app: FastifyInstance): void {
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    if (app.ctx.maintenance && routePath(request).startsWith("/api/")) {
      throw new ApiError(503, "maintenance");
    }
    // While a first-run import swaps the database the store is closed.
    if (app.ctx.store.isOpen) {
      readSession(app, request);
    }
    const session = request.session;
    if (session !== null && !SAFE_METHODS.has(request.method)) {
      const header = request.headers["x-csrf-token"];
      const sent = typeof header === "string" ? header : "";
      if (!sameText(sent, session.csrfToken)) {
        throw new ApiError(403, "csrf");
      }
    }
    const level = authLevel(request);
    if (level !== "public" && session === null) {
      throw new ApiError(401, "unauthenticated");
    }
    if (level === "owner" && session?.user.role !== "owner") {
      throw new ApiError(403, "forbidden");
    }
    const feature = request.routeOptions.config.entitlement;
    if (feature !== undefined && !app.ctx.entitlement.can(feature)) {
      throw featureRequired(feature);
    }
  });
}

/** Session cookie: HttpOnly, SameSite=Strict, signed, Secure behind https. */
export function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  session: NewSession,
): void {
  const secure = app.ctx.config.baseUrl?.startsWith("https://") ?? false;
  void reply.setCookie(SESSION_COOKIE, session.value, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    signed: true,
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
