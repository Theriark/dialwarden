// The request guard, one onRequest hook for every route, in this order:
// 1. reads the session from the signed cookie, except on the web route
//    (static files only, contract C8), and builds the principal (who acts and
//    with which role; the role is read from the users row on every request);
//    without a session, an "Authorization: Bearer" API token (P8-A step 6)
//    builds it instead, and a token that is not valid answers 401;
// 2. refuses API calls with 503 while a first-run import runs;
// 3. checks the CSRF header on every state-changing request with a session;
// 4. enforces config.auth (authentication first). Every matched route
//    defaults to "user", so a route that forgets the setting is protected,
//    not open. The level comes from the matched route, never from
//    request.url: Fastify routes on the decoded path, so /%61pi/v1/activity
//    reaches the /api/v1/activity handler;
// 5. answers 402 (contract C1) for a route whose config.entitlement feature
//    the current plan does not include, before any role check;
// 6. refuses an API token on an identity route (403 token_not_allowed, D15);
// 7. checks the role the route needs (403 forbidden).
// A preValidation hook then checks config.server (P8-A, one shared check for
// every server-scoped route): the route's game server is found from the
// slug, the change set, the snapshot, the schedule (P9-A) or the body, and
// a principal without a grant there gets exactly the answer of a missing
// object (404), so the API never tells which servers exist. A read grant on
// a write route is 403.
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SESSION_COOKIE,
  sessionCookieName,
  type NewSession,
} from "../auth/sessions.js";
import { changeSets, schedules, snapshots } from "../db/schema.js";
import { SERVER_ID } from "../plan/editable.js";
import { atLeast, serverLevel, type Principal } from "../team/roles.js";
import type { AuthLevel, ServerScope, ServerSource } from "./context.js";
import { ApiError, featureRequired } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The header of the role-matrix test seam (BuildOptions.authProbe). */
export const AUTH_PROBE_HEADER = "x-dialwarden-auth-probe";

export interface GuardOptions {
  /** Tests only: requests with AUTH_PROBE_HEADER stop after the checks. */
  authProbe?: boolean;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSession(app: FastifyInstance, request: FastifyRequest): void {
  const name = sessionCookieName(app.ctx.config.baseUrl);
  const raw =
    name === SESSION_COOKIE
      ? request.cookies.dw_session
      : request.cookies["__Host-dw_session"];
  if (raw === undefined || raw === "") {
    return;
  }
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) {
    return;
  }
  request.session = app.ctx.sessions.resolve(unsigned.value);
  if (request.session !== null) {
    request.principal = app.ctx.team.principalOf(request.session.user);
  }
}

/** An API token from the Authorization header, when there is no session. */
function readBearer(app: FastifyInstance, request: FastifyRequest): void {
  const header = request.headers.authorization;
  if (header === undefined) return;
  const value = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (value === "") throw new ApiError(401, "invalid_token");
  const principal = app.ctx.tokens.resolve(value, app.ctx.team.teamRoles);
  if (principal === null) throw new ApiError(401, "invalid_token");
  request.principal = principal;
}

/**
 * Paths no API token reaches, whatever the route says (D15): the account and
 * its sign-in, setup, the licence, users, invitations, the own-data export,
 * tokens themselves, the audit settings and the system page.
 */
const TOKEN_DENIED_PREFIXES = [
  "/api/v1/auth/",
  "/api/v1/setup",
  "/api/v1/licence",
  "/api/v1/users",
  "/api/v1/invitations",
  "/api/v1/me/",
  "/api/v1/tokens",
  "/api/v1/settings/",
  "/api/v1/system/",
];

/** Whether an API token may call the matched route. */
export function tokenAllowed(
  url: string,
  tokens: boolean | undefined,
): boolean {
  if (tokens === false) return false;
  return !TOKEN_DENIED_PREFIXES.some((prefix) => url.startsWith(prefix));
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

/** The answer for an object that does not exist, per kind of object. */
function missing(from: ServerSource): ApiError {
  if (from === "changeSet") return new ApiError(404, "change_set_not_found");
  if (from === "snapshot") return new ApiError(404, "snapshot_not_found");
  if (from === "schedule") return new ApiError(404, "schedule_not_found");
  return new ApiError(404, "server_not_found");
}

function textField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found: unknown = new Map(Object.entries(value)).get(field);
  return typeof found === "string" ? found : null;
}

/**
 * The game server a scoped route acts on: a slug, the server of a change set
 * or snapshot, or null when there is none. A value that is not even shaped
 * like an id is "malformed" and answers like a missing object (P10-A I5).
 */
function serverOf(
  app: FastifyInstance,
  request: FastifyRequest,
  from: ServerSource,
): string | null | "malformed" {
  const db = app.ctx.store.db;
  if (from === "slug" || from === "bodyServer") {
    const slug =
      from === "slug"
        ? textField(request.params, "slug")
        : textField(request.body, "server");
    return slug !== null && SERVER_ID.test(slug) ? slug : "malformed";
  }
  const id = textField(request.params, "id") ?? "";
  if (!UUID.test(id)) return "malformed";
  if (from === "changeSet") {
    const row = db
      .select({ serverId: changeSets.serverId })
      .from(changeSets)
      .where(eq(changeSets.id, id))
      .get();
    return row?.serverId ?? null;
  }
  if (from === "schedule") {
    const row = db
      .select({ serverId: schedules.serverId })
      .from(schedules)
      .where(eq(schedules.id, id))
      .get();
    return row?.serverId ?? null;
  }
  const row = db
    .select({ serverId: snapshots.serverId })
    .from(snapshots)
    .where(eq(snapshots.id, id))
    .get();
  return row?.serverId ?? null;
}

/** The config.server check of one request (see the header). */
function checkServer(
  app: FastifyInstance,
  request: FastifyRequest,
  principal: Principal,
  scope: ServerScope,
): void {
  const serverId = serverOf(app, request, scope.from);
  // A malformed id answers like a missing object, before any route schema
  // (P10-A I5: the check fails closed even on a route without one).
  if (serverId === "malformed" || serverId === null) throw missing(scope.from);
  const grant = app.ctx.team.grantLevel(principal.userId, serverId);
  const level = serverLevel(principal, grant);
  if (level === null) throw missing(scope.from);
  request.serverLevel = level;
  request.serverId = serverId;
  const allowed =
    scope.access === "read" ||
    (scope.access === "write" && level === "write") ||
    (scope.access === "admin" && atLeast(principal.role, "admin")) ||
    (scope.access === "owner" && principal.role === "owner");
  if (!allowed) throw new ApiError(403, "forbidden");
}

export function registerGuard(
  app: FastifyInstance,
  options: GuardOptions = {},
): void {
  app.decorateRequest("session", null);
  app.decorateRequest("principal", null);
  app.decorateRequest("serverLevel", null);
  app.decorateRequest("serverId", null);
  app.addHook("onRequest", async (request) => {
    if (app.ctx.maintenance && routePath(request).startsWith("/api/")) {
      throw new ApiError(503, "maintenance");
    }
    // While a first-run import swaps the database the store is closed. The
    // web route serves static files that carry no user data: no cookie check
    // and no database lookup.
    if (app.ctx.store.isOpen && request.routeOptions.config.web !== true) {
      readSession(app, request);
      if (request.session === null) {
        readBearer(app, request);
      } else if (request.headers.authorization !== undefined) {
        // A session cookie and an Authorization header together are two
        // competing credentials; the request is refused before any check
        // runs, so a token cannot ride on a victim session (T-10, D15).
        throw new ApiError(400, "ambiguous_credentials");
      }
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
    const principal = request.principal;
    if (level !== "public" && principal === null) {
      throw new ApiError(401, "unauthenticated");
    }
    const feature = request.routeOptions.config.entitlement;
    if (feature !== undefined && !app.ctx.entitlement.can(feature)) {
      throw featureRequired(feature);
    }
    const config = request.routeOptions.config;
    if (
      principal?.via === "token" &&
      !tokenAllowed(routePath(request), config.tokens)
    ) {
      throw new ApiError(403, "token_not_allowed");
    }
    if (level === "public" || level === "user" || principal === null) {
      return;
    }
    if (!atLeast(principal.role, level)) {
      throw new ApiError(403, "forbidden");
    }
  });
  // Before the body is validated, so an ungranted server answers 404 for any
  // body and a refusal never depends on which fields were sent.
  app.addHook("preValidation", async (request) => {
    const scope = request.routeOptions.config.server;
    const principal = request.principal;
    if (scope === undefined || principal === null) return;
    checkServer(app, request, principal, scope);
  });
  if (options.authProbe === true) {
    // Test seam of the role matrix (never read from the environment): a
    // request that passed every check above answers 299 instead of running
    // its handler, so the matrix needs no valid body and changes nothing.
    app.addHook("preValidation", async (request, reply) => {
      if (request.headers["x-dialwarden-auth-probe"] !== "1") return;
      return reply.code(299).send({ allowed: true });
    });
  }
}

/**
 * Session cookie: HttpOnly, SameSite=Strict, signed, Path /. Behind https
 * it is Secure and named with the __Host- prefix, so no sibling host under
 * the same parent domain can set it (D17).
 */
export function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  session: NewSession,
): void {
  const baseUrl = app.ctx.config.baseUrl;
  const secure = baseUrl?.startsWith("https://") ?? false;
  void reply.setCookie(sessionCookieName(baseUrl), session.value, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    signed: true,
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
): void {
  const baseUrl = app.ctx.config.baseUrl;
  const secure = baseUrl?.startsWith("https://") ?? false;
  void reply.clearCookie(sessionCookieName(baseUrl), { path: "/", secure });
}
