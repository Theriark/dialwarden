// What the audit log records (dev-work-plan P8-A step 3): every successful
// state-changing API request, with the route pattern as the action, the ids
// of its path as the target and the server it acted on, and every refused
// sign-in. Request bodies are never recorded: the data holds the answer
// status and the path ids only, so no name, e-mail address or secret value
// enters the chain.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Sign-in routes whose refusals are security events too. */
const SIGN_IN_ROUTES = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/login/totp",
  "/api/v1/invitations/accept",
  "/api/v1/auth/password-reset",
]);

const REFUSED_SIGN_IN = new Set([401, 403, 410, 429]);

/** The path parameters as plain strings (ids and slugs only). */
function paramsOf(request: FastifyRequest): Record<string, string> {
  const out = new Map<string, string>();
  const params: unknown = request.params;
  if (typeof params === "object" && params !== null) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") out.set(key, value.slice(0, 200));
    }
  }
  return Object.fromEntries(out);
}

/** The kind of object a route acts on: the first path segment after v1. */
function targetTypeOf(url: string): string | null {
  const segment = url.split("/").at(3);
  return segment === undefined || segment === "" ? null : segment;
}

function shouldRecord(request: FastifyRequest, reply: FastifyReply): boolean {
  const url = request.routeOptions.url;
  if (url === undefined || !url.startsWith("/api/")) return false;
  if (SAFE_METHODS.has(request.method)) return false;
  const status = reply.statusCode;
  if (status >= 200 && status < 300) return true;
  return SIGN_IN_ROUTES.has(url) && REFUSED_SIGN_IN.has(status);
}

export function registerAuditRecording(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (!app.ctx.store.isOpen || !shouldRecord(request, reply)) {
      return payload;
    }
    const url = request.routeOptions.url ?? "";
    const params = paramsOf(request);
    const principal = request.principal;
    const id = params.id ?? params.slug ?? null;
    // A request made with an API token names the token id, never its value.
    const tokenId = principal?.tokenId ?? null;
    const via = tokenId === null ? {} : { tokenId };
    try {
      app.ctx.audit.record({
        actorId: principal?.userId ?? "anonymous",
        ...(principal === null ? {} : { actorLabel: principal.email }),
        action: `${request.method} ${url}`,
        targetType: targetTypeOf(url),
        targetId: id,
        serverId: request.serverId,
        data: { status: reply.statusCode, params, ...via },
        ip: request.ip,
      });
    } catch (error) {
      // The answer is already decided; a failed record is logged loudly.
      request.log.error({ err: error }, "audit record failed");
    }
    return payload;
  });
}
