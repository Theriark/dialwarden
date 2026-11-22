// The request guard (security review THE-2134 H1, threat tests T1; code
// review H1). The auth level comes from the matched route, never from the raw
// URL: Fastify routes on the decoded path, so /%61pi/v1/activity reaches the
// /api/v1/activity handler and must be refused like the plain path.
import { connect, type AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { setupOwner, testApp, type TestApp } from "../../test/helpers.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Routes anybody may call. */
const PUBLIC_ROUTES = new Set([
  "GET /api/v1/setup",
  "POST /api/v1/setup",
  "POST /api/v1/setup/import",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/login/totp",
  "POST /api/v1/auth/logout",
  "GET /api/v1/openapi.json",
  "HEAD /api/v1/setup",
  "HEAD /api/v1/openapi.json",
]);

/** The a of api percent-encoded: decodes to the same route. */
const encoded = (url: string): string => url.replace(/^\/api\//, "/%61pi/");

/** A concrete URL: every path parameter gets a backup-id-shaped value. */
const concrete = (url: string): string =>
  url.replace(/:[^/]+/g, "20261121-0330");

function send(app: FastifyInstance, method: string, url: string) {
  return app.inject({ method: method as "GET", url });
}

/** One raw HTTP/1.1 request on a socket; resolves with the status line. */
function rawStatusLine(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      resolve(data.split("\r\n")[0] ?? "");
    });
    socket.write(request);
  });
}

describe("request guard", () => {
  it("refuses encoded paths to signed-in routes without a session", async () => {
    current = await testApp();
    const { app } = current;
    await setupOwner(app);
    const urls = [
      "/%61pi/v1/activity",
      "/ap%69/v1/entitlement",
      "/%61pi/v1/plan/editable-servers",
      "/%61pi/v1/plan/registry",
    ];
    for (const url of urls) {
      const response = await send(app, "GET", url);
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toEqual({ error: "unauthenticated" });
    }
  });

  it("refuses an absolute-form request target without a session", async () => {
    current = await testApp();
    const { app } = current;
    await setupOwner(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request =
      "GET http://127.0.0.1/api/v1/activity HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\nConnection: close\r\n\r\n";
    const status = await rawStatusLine(port, request);
    expect(status).toBe("HTTP/1.1 401 Unauthorized");
  });

  it("protects every non-public API route, plain and encoded", async () => {
    current = await testApp();
    const { app } = current;
    await setupOwner(app);
    const routes = app.ctx.routes.filter(
      (route) =>
        route.url.startsWith("/api/") &&
        !PUBLIC_ROUTES.has(`${route.method} ${route.url}`),
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const name = `${route.method} ${route.url}`;
      for (const url of [concrete(route.url), encoded(concrete(route.url))]) {
        const response = await send(app, route.method, url);
        expect(response.statusCode, `${name} as ${url}`).toBe(401);
      }
    }
  });

  it("denies a route that does not say auth public by default", async () => {
    current = await testApp({
      extend: (app) => {
        app.get("/internal/probe", async () => ({ ok: true }));
      },
    });
    const response = await send(current.app, "GET", "/internal/probe");
    expect(response.statusCode).toBe(401);
    const missing = await send(current.app, "GET", "/no/such/route");
    expect(missing.statusCode).toBe(404);
  });

  it("answers 503 on encoded API paths during a first-run import", async () => {
    current = await testApp();
    const { app } = current;
    app.ctx.maintenance = true;
    try {
      for (const url of ["/api/v1/setup", "/%61pi/v1/setup"]) {
        const response = await send(app, "GET", url);
        expect(response.statusCode, url).toBe(503);
        expect(response.json(), url).toEqual({ error: "maintenance" });
      }
      const health = await send(app, "GET", "/healthz");
      expect(health.statusCode).toBe(200);
    } finally {
      app.ctx.maintenance = false;
    }
  });
});
