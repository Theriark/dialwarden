// The built web app and the security headers (contract C8): the P1-D tests 1
// to 12 of web-serving-decision (THE-2195) and the threat tests T1 to T9 of
// its security review (THE-2250). Every test writes its own dist folder, with
// files next to it and links out of it that are never served.
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { loadConfig } from "../config.js";

/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */

const HTML_TYPE = "text/html; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
const IMMUTABLE = "public, max-age=31536000, immutable";
const LOCKED = "default-src 'none'; frame-ancestors 'none'";
const NO_WEB = "/nonexistent/dialwarden-web";
const THEME = "\n  document.documentElement.dataset.theme = 'dark';\n";
const SECOND = "window.dwSecond = true;";
const MODULE_TAG = '<script type="module" src="/assets/app-abc.js"></script>';
const PARENT_MARKER = "PARENT-MARKER-5c1d";
const BUILD_MARKER = "BUILD-INFO-MARKER-77e0";
const DOT_MARKER = "DOT-MARKER-91ab";
const OUTSIDE_MARKER = "OUTSIDE-MARKER-3f2e";
const APP_JS = "export const answer = 42;\n".repeat(100);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PERMISSIONS = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
].join(", ");

const COMMON_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
  "permissions-policy": PERMISSIONS,
};

const HEALTH_KEYS = [
  "buildDate",
  "featureBaseline",
  "plan",
  "revision",
  "status",
  "version",
];

const API_MISSES = [
  ["GET", "/api"],
  ["GET", "/api/"],
  ["GET", "/api/v1/nope"],
  ["POST", "/login"],
  ["POST", "/"],
] as const;

const STATIC_WRITES = [
  ["POST", "/assets/app-abc.js"],
  ["PUT", "/index.html"],
  ["DELETE", "/"],
] as const;

const TRAVERSALS = [
  "/..%2fpackage.json",
  "/%2e%2e/package.json",
  "/%2e%2e/%2e%2e/etc/passwd",
  "/..%2f..%2fbuild-info.json",
  "/assets/..%2f..%2fbuild-info.json",
  "/.env",
  "/%2eenv",
  "/assets/.hidden.js",
];

interface Fixture {
  dist: string;
  html: string;
}

const roots: string[] = [];
let current: TestApp | undefined;
let reference: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  await reference?.close();
  current = undefined;
  reference = undefined;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** The page policy, written out here independently of the server. */
function pagePolicy(scriptSources: string): string {
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
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

function hashOf(body: string): string {
  const digest = createHash("sha256").update(body).digest("base64");
  return `'sha256-${digest}'`;
}

/** An index.html like the Vite build, with these inline scripts. */
function page(scripts: readonly string[]): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<!-- <script>commented()</script> -->",
    ...scripts.map((body) => `<script>${body}</script>`),
    MODULE_TAG,
    "</head>",
    "<body></body>",
    "</html>",
  ].join("\n");
}

/** A dist folder like the Vite build, with traps next to it and inside it. */
async function fixture(inline = [THEME]): Promise<Fixture> {
  const root = await tempDir("dialwarden-web-");
  roots.push(root);
  const dist = join(root, "dist");
  const outside = join(root, "outside");
  const html = page(inline);
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(join(dist, "brand"));
  mkdirSync(outside);
  writeFileSync(join(root, "package.json"), PARENT_MARKER);
  writeFileSync(join(root, "build-info.json"), BUILD_MARKER);
  writeFileSync(join(outside, "secret.txt"), OUTSIDE_MARKER);
  writeFileSync(join(dist, "index.html"), html);
  writeFileSync(join(dist, "assets", "app-abc.js"), APP_JS);
  writeFileSync(join(dist, "assets", ".hidden.js"), DOT_MARKER);
  writeFileSync(join(dist, "brand", "logo.png"), PNG);
  writeFileSync(join(dist, "site.webmanifest"), '{"name":"Dialwarden"}');
  writeFileSync(join(dist, ".env"), DOT_MARKER);
  symlinkSync(join(outside, "secret.txt"), join(dist, "linked.txt"));
  symlinkSync(outside, join(dist, "linked-dir"));
  return { dist, html };
}

/** GET url on the current test app. */
function get(url: string, headers: Record<string, string> = {}) {
  if (current === undefined) {
    throw new Error("no test app");
  }
  return current.app.inject({ method: "GET", url, headers });
}

/** A stream that keeps every log line the app writes. */
function logCapture(): { stream: Writable; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => lines.join("") };
}

describe("web app (contract C8)", () => {
  // Test 1.
  it("answers client routes with index.html and the page headers", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const policy = pagePolicy(`'self' ${hashOf(THEME)}`);
    const urls = ["/", "/login", "/settings/licence", "/servers/a.b/settings"];
    for (const url of urls) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toBe(HTML_TYPE);
      expect(response.body, url).toBe(html);
      expect(response.headers["cache-control"], url).toBe("no-cache");
      expect(response.headers["content-security-policy"], url).toBe(policy);
      expect(response.headers["x-frame-options"], url).toBe("DENY");
      expect(response.headers, url).toMatchObject(COMMON_HEADERS);
    }
  });

  // Test 2.
  it("hashes every inline script; none leaves script-src 'self'", async () => {
    const two = await fixture([THEME, SECOND]);
    current = await testApp({ extraEnv: { WEB_DIST: two.dist } });
    const both = `'self' ${hashOf(THEME)} ${hashOf(SECOND)}`;
    const first = await get("/");
    expect(first.headers["content-security-policy"]).toBe(pagePolicy(both));
    await current.close();
    current = undefined;

    const none = await fixture([]);
    current = await testApp({ extraEnv: { WEB_DIST: none.dist } });
    const expected = pagePolicy("'self'");
    const second = await get("/");
    expect(second.headers["content-security-policy"]).toBe(expected);
  });

  // Test 3.
  it("serves an asset with a strong ETag, 304, br and gzip", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const url = "/assets/app-abc.js";
    const plain = await get(url);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-type"]).toBe(JS_TYPE);
    expect(plain.headers["cache-control"]).toBe(IMMUTABLE);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toBe("Accept-Encoding");
    expect(plain.body).toBe(APP_JS);
    const etag = String(plain.headers.etag);
    expect(etag).toMatch(/^"[\w-]{22}"$/);

    const cached = await get(url, { "if-none-match": etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");

    const br = await get(url, { "accept-encoding": "gzip, deflate, br" });
    expect(br.statusCode).toBe(200);
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers.vary).toBe("Accept-Encoding");
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(APP_JS);
    const brEtag = String(br.headers.etag);
    expect(brEtag).toBe(`${etag.slice(0, -1)}-br"`);
    const brCached = await get(url, {
      "accept-encoding": "br",
      "if-none-match": brEtag,
    });
    expect(brCached.statusCode).toBe(304);

    const gzip = await get(url, { "accept-encoding": "gzip" });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers.etag).toBe(`${etag.slice(0, -1)}-gz"`);
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(APP_JS);

    const refused = await get(url, { "accept-encoding": "br;q=0, identity" });
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.body).toBe(APP_JS);
  });

  it("gives each file its content type and cache class", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const index = await get("/index.html");
    expect(index.headers["content-type"]).toBe(HTML_TYPE);
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.body).toBe(html);
    const manifest = await get("/site.webmanifest");
    expect(manifest.headers["content-type"]).toBe("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    const logo = await get("/brand/logo.png");
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["cache-control"]).toBe("no-cache");
    expect(logo.headers.vary).toBeUndefined();
    expect(logo.rawPayload.equals(PNG)).toBe(true);
    expect(logo.headers["content-security-policy"]).toBe(LOCKED);
  });

  // Test 4.
  it("answers HEAD / with the headers and no body", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const response = await current.app.inject({ method: "HEAD", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(HTML_TYPE);
    expect(response.body).toBe("");
  });

  // Test 5.
  it("answers a missing asset with the 404 JSON, never HTML", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    reference = await testApp({ extraEnv: { WEB_DIST: NO_WEB } });
    const urls = [
      "/assets/missing.js",
      "/brand/missing.png",
      "/missing.css",
      "/assets/no-extension",
    ];
    for (const url of urls) {
      const response = await get(url);
      const before = await reference.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual(before.json());
      expect(response.headers, url).toMatchObject(COMMON_HEADERS);
      expect(response.headers["content-security-policy"], url).toBe(LOCKED);
    }
  });

  // Test 6.
  it("keeps the 404 JSON for /api paths and for other methods", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    reference = await testApp({ extraEnv: { WEB_DIST: NO_WEB } });
    for (const [method, url] of API_MISSES) {
      const name = `${method} ${url}`;
      const response = await current.app.inject({ method, url });
      const before = await reference.app.inject({ method, url });
      expect(response.statusCode, name).toBe(404);
      expect(response.json(), name).toEqual(before.json());
    }
  });

  it("keeps serving the UI during a first-run import; /api answers 503", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    current.app.ctx.maintenance = true;
    try {
      const home = await get("/settings/licence");
      expect(home.statusCode).toBe(200);
      expect(home.body).toBe(html);
      for (const url of ["/api/v1/setup", "/api/v1/nope", "/%61pi/v1/nope"]) {
        const response = await get(url);
        expect(response.statusCode, url).toBe(503);
        expect(response.json(), url).toEqual({ error: "maintenance" });
      }
    } finally {
      current.app.ctx.maintenance = false;
    }
  });

  // Test 7.
  it("never serves a file outside the map, however the path is encoded", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    for (const url of TRAVERSALS) {
      const response = await get(url);
      for (const marker of [PARENT_MARKER, BUILD_MARKER, DOT_MARKER]) {
        expect(response.body, url).not.toContain(marker);
      }
      const status = response.statusCode;
      const ok = status === 404 || (status === 200 && response.body === html);
      expect(ok, `${url} answered ${status}`).toBe(true);
    }
  });

  // Test 8.
  it("never follows a symlink out of the dist folder", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    for (const url of ["/linked.txt", "/linked-dir/secret.txt"]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(OUTSIDE_MARKER);
    }
  });

  // Test 9.
  it("serves the API only, with one warning, when there is no web build", async () => {
    const empty = await tempDir("dialwarden-web-empty-");
    roots.push(empty);
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info", WEB_DIST: empty },
    });
    const response = await get("/");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404 });
    expect(log.text().split("no web UI at").length).toBe(2);
    const urls = current.app.ctx.routes.map((route) => route.url);
    expect(urls).not.toContain("/*");
  });

  it("finds the web build next to the server build unless WEB_DIST is set", () => {
    const fallback = fileURLToPath(new URL("../../public/", import.meta.url));
    expect(loadConfig({}).webDist).toBe(fallback);
    expect(loadConfig({ WEB_DIST: "/srv/web" }).webDist).toBe("/srv/web");
  });

  // Test 10.
  it("gives API answers nosniff, the no-content policy and no-store", async () => {
    const { dist } = await fixture();
    current = await testApp({
      extraEnv: { WEB_DIST: dist },
      extend: (app) => {
        const config = { auth: "public" as const };
        app.get("/api/v1/cached", { config }, async (_request, reply) => {
          void reply.header("cache-control", "private, max-age=5");
          return { ok: true };
        });
      },
    });
    for (const url of ["/api/v1/setup", "/api/v1/nope", "/%61pi/v1/setup"]) {
      const response = await get(url);
      expect(response.headers, url).toMatchObject(COMMON_HEADERS);
      expect(response.headers["content-security-policy"], url).toBe(LOCKED);
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(response.headers["x-frame-options"], url).toBeUndefined();
    }
    const cached = await get("/api/v1/cached");
    expect(cached.headers["cache-control"]).toBe("private, max-age=5");
    const health = await get("/healthz");
    expect(health.statusCode).toBe(200);
    expect(Object.keys(health.json()).sort()).toEqual(HEALTH_KEYS);
    expect(health.headers).toMatchObject(COMMON_HEADERS);
    expect(health.headers["content-security-policy"]).toBe(LOCKED);
    expect(health.headers["cache-control"]).toBeUndefined();
  });

  // Test 11.
  it("never resolves a session on the web route", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const owner = await setupOwner(current.app);
    const resolve = vi.spyOn(current.app.ctx.sessions, "resolve");
    const cookie = { cookie: owner.cookie };
    for (const url of ["/", "/settings/licence", "/assets/app-abc.js"]) {
      const response = await get(url, cookie);
      expect(response.statusCode, url).toBe(200);
    }
    expect(resolve).not.toHaveBeenCalled();
    const session = await get("/api/v1/auth/session", cookie);
    expect(session.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // Test 12.
  it("lists /* in the route registry as public, without a feature", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const web = current.app.ctx.routes.filter((route) => route.url === "/*");
    const methods = web.map((route) => route.method).sort();
    expect(methods).toEqual(["GET", "HEAD"]);
    for (const route of web) {
      expect(route).toMatchObject({ auth: "public", entitlement: null });
    }
  });
});

describe("web app threat tests (security review THE-2250)", () => {
  // T1.
  it("keeps the API route auth for an encoded /api prefix", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const owner = await setupOwner(current.app);
    const resolve = vi.spyOn(current.app.ctx.sessions, "resolve");
    const url = "/%61pi/v1/system/status";
    const anonymous = await get(url);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: "unauthenticated" });
    expect(anonymous.headers["content-security-policy"]).toBe(LOCKED);
    expect(anonymous.headers["cache-control"]).toBe("no-store");
    expect(anonymous.body).not.toBe(html);
    const signed = await get(url, { cookie: owner.cookie });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toHaveProperty("version");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // T2.
  it("never reaches an API handler through an encoded slash", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    reference = await testApp({ extraEnv: { WEB_DIST: NO_WEB } });
    const owner = await setupOwner(current.app);
    const resolve = vi.spyOn(current.app.ctx.sessions, "resolve");
    const headers = { cookie: owner.cookie };
    for (const url of ["/api%2Fv1/auth/session", "/api%2fv1/system/status"]) {
      const response = await get(url, headers);
      const before = await reference.app.inject({ url, headers });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual(before.json());
      expect(response.body, url).not.toContain("csrfToken");
      expect(response.headers["content-security-policy"], url).toBe(LOCKED);
      expect(response.headers["cache-control"], url).toBe("no-store");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  // T3.
  it("never decodes a double-encoded path into a file", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const urls = [
      "/%252e%252e/package.json",
      "/assets/%252e%252e%252f%252e%252e%252fbuild-info.json",
      "/%252eenv",
    ];
    for (const url of urls) {
      const response = await get(url);
      for (const marker of [PARENT_MARKER, BUILD_MARKER, DOT_MARKER]) {
        expect(response.body, url).not.toContain(marker);
      }
      const status = response.statusCode;
      const ok = status === 404 || (status === 200 && response.body === html);
      expect(ok, `${url} answered ${status}`).toBe(true);
    }
  });

  // T4.
  it("answers asset-shaped misses with the 404 JSON", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    reference = await testApp({ extraEnv: { WEB_DIST: NO_WEB } });
    const urls = ["/assets/missing.js%3Fv=1", "/MISSING.JS", "/assets/Missing"];
    for (const url of urls) {
      const response = await get(url);
      const before = await reference.app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual(before.json());
      expect(response.headers["content-security-policy"], url).toBe(LOCKED);
      expect(response.headers["content-type"], url).not.toContain("text/html");
    }
    // Accepted (I1): an empty last segment is a client route, served as the
    // page with nosniff, so a browser never runs it as a script.
    const slash = await get("/missing.js/");
    const policy = pagePolicy(`'self' ${hashOf(THEME)}`);
    expect(slash.statusCode).toBe(200);
    expect(slash.headers["content-type"]).toBe(HTML_TYPE);
    expect(slash.headers["x-content-type-options"]).toBe("nosniff");
    expect(slash.headers["content-security-policy"]).toBe(policy);
  });

  // T5.
  it("answers non-canonical API spellings with the page only", async () => {
    const { dist, html } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const owner = await setupOwner(current.app);
    const resolve = vi.spyOn(current.app.ctx.sessions, "resolve");
    for (const url of ["//api/v1/auth/session", "/API/v1/auth/session"]) {
      const response = await get(url, { cookie: owner.cookie });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(html);
      expect(response.body, url).not.toContain("csrfToken");
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  // T6.
  it("never sets a cookie on the web route", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const owner = await setupOwner(current.app);
    for (const url of ["/", "/settings/licence", "/assets/app-abc.js"]) {
      const response = await get(url, { cookie: owner.cookie });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
  });

  // T7.
  it("keeps the page headers on a 304 for the page", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const first = await get("/");
    const etag = String(first.headers.etag);
    const cached = await get("/", { "if-none-match": etag });
    const policy = pagePolicy(`'self' ${hashOf(THEME)}`);
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");
    expect(cached.headers["content-security-policy"]).toBe(policy);
    expect(cached.headers["x-frame-options"]).toBe("DENY");
    expect(cached.headers).toMatchObject(COMMON_HEADERS);
  });

  // T8.
  it("hashes an inline script with CR LF as the browser does", async () => {
    const { dist } = await fixture();
    const html = page([THEME]).replace(/\n/g, "\r\n");
    writeFileSync(join(dist, "index.html"), html);
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const response = await get("/");
    expect(response.body).toBe(html);
    const policy = String(response.headers["content-security-policy"]);
    expect(policy).toBe(pagePolicy(`'self' ${hashOf(THEME)}`));
    expect(policy).not.toContain(hashOf(THEME.replace(/\n/g, "\r\n")));
  });

  // T9 (with the correction at the end of the review).
  it("answers other methods on static paths like the API-only server", async () => {
    const { dist } = await fixture();
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    reference = await testApp({ extraEnv: { WEB_DIST: NO_WEB } });
    const headers = { cookie: (await setupOwner(current.app)).cookie };
    const referenceOwner = await setupOwner(reference.app);
    const referenceHeaders = { cookie: referenceOwner.cookie };
    for (const [method, url] of STATIC_WRITES) {
      const name = `${method} ${url}`;
      // T9a: no session, the 404 JSON.
      const anonymous = await current.app.inject({ method, url });
      const before = await reference.app.inject({ method, url });
      expect(anonymous.statusCode, name).toBe(404);
      expect(anonymous.json(), name).toEqual(before.json());
      // T9b: a session without the CSRF header. No route matched, so the
      // guard reads the session and refuses first, as without a web build.
      const signed = await current.app.inject({ method, url, headers });
      const expected = await reference.app.inject({
        method,
        url,
        headers: referenceHeaders,
      });
      expect(signed.statusCode, name).toBe(403);
      expect(signed.statusCode, name).toBe(expected.statusCode);
      expect(signed.json(), name).toEqual({ error: "csrf" });
      expect(signed.json(), name).toEqual(expected.json());
      expect(signed.headers["content-type"], name).not.toContain("text/html");
    }
  });

  // P10-A G5.1: the page policy, directive by directive.
  it("G5.1 allows no eval, blob, outside source or outside font", async () => {
    const { dist } = await fixture([THEME, SECOND]);
    current = await testApp({ extraEnv: { WEB_DIST: dist } });
    const response = await get("/");
    const policy = String(response.headers["content-security-policy"]);
    const directives = new Map(
      policy.split("; ").map((part) => {
        const [name = "", ...sources] = part.split(" ");
        return [name, sources] as const;
      }),
    );
    expect([...directives.keys()]).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "worker-src",
      "manifest-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]);
    expect(directives.get("font-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual([
      "'self'",
      hashOf(THEME),
      hashOf(SECOND),
    ]);
    for (const [name, sources] of directives) {
      for (const source of sources) {
        expect(source, name).not.toBe("'unsafe-eval'");
        expect(source, name).not.toMatch(/^(blob|https?):/);
      }
    }
  });

  // P10-A L19: HSTS only when the app knows it is reached over https.
  it("L19 sends HSTS with an https BASE_URL, and none with http", async () => {
    const { dist } = await fixture();
    const extraEnv = { WEB_DIST: dist, BASE_URL: "https://dw.example" };
    current = await testApp({ extraEnv });
    for (const url of ["/", "/api/v1/setup", "/healthz"]) {
      const response = await get(url);
      expect(response.headers["strict-transport-security"], url).toBe(
        "max-age=31536000",
      );
    }
    await current.close();
    const plain = { WEB_DIST: dist, BASE_URL: "http://dw.lan:8080" };
    current = await testApp({ extraEnv: plain });
    for (const url of ["/", "/api/v1/setup"]) {
      const response = await get(url);
      expect(response.headers["strict-transport-security"], url).toBe(
        undefined,
      );
    }
  });
});
