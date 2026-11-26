// Security headers (contract C8), one onSend hook for every response. HTML
// (index.html, direct or as the SPA fallback) gets the page policy, with the
// sha256 of each inline script of the built index.html computed at start and
// no nonce, so the page stays the same bytes with a stable ETag. Every other
// answer (API, health, assets, 404) gets a policy that allows nothing, and an
// answer under /api/ is never stored unless its route says otherwise.
// Strict-Transport-Security only when BASE_URL starts with https (P10-A
// L19): then the app knows it is reached over TLS. On plain http on a LAN
// the header would be wrong, so without an https BASE_URL it stays off and
// HSTS is left to the proxy that terminates TLS.
import type { FastifyInstance, FastifyRequest } from "fastify";

const PERMISSIONS = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
].join(", ");

const COMMON_HEADERS = new Map([
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  ["x-robots-tag", "noindex, nofollow"],
  ["permissions-policy", PERMISSIONS],
]);

/** One year; no includeSubDomains, the app knows only its own host. */
export const HSTS = "max-age=31536000";

/** Every answer that is not HTML loads nothing and is never framed. */
const LOCKED = "default-src 'none'; frame-ancestors 'none'";

/** The Content-Security-Policy of the web app page. */
export function htmlPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptHashes].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Under /api/, by the matched route or by the decoded request path. */
function isApi(request: FastifyRequest): boolean {
  if (request.routeOptions.url?.startsWith("/api/") === true) {
    return true;
  }
  const raw = request.url.split("?")[0] ?? "";
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // A malformed escape: the raw path decides.
  }
  return path === "/api" || path.startsWith("/api/");
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  scriptHashes: readonly string[],
  baseUrl: string | null = null,
): void {
  const pagePolicy = htmlPolicy(scriptHashes);
  const hsts = baseUrl?.startsWith("https://") === true;
  app.addHook("onSend", async (request, reply, payload) => {
    for (const [name, value] of COMMON_HEADERS) {
      void reply.header(name, value);
    }
    if (hsts) void reply.header("strict-transport-security", HSTS);
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/html")) {
      void reply.header("content-security-policy", pagePolicy);
      void reply.header("x-frame-options", "DENY");
      return payload;
    }
    void reply.header("content-security-policy", LOCKED);
    if (isApi(request) && !reply.hasHeader("cache-control")) {
      void reply.header("cache-control", "no-store");
    }
    return payload;
  });
}
