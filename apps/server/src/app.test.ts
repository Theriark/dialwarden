// Server core (dev-work-plan P1-A steps 1, 3 and 10): health and readiness, the
// OpenAPI document, the generated APP_SECRET_KEY and log redaction.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { testKeyRing } from "@dialwarden/entitlement/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BUILD_ENV,
  discard,
  headersOf,
  setupOwner,
  testApp,
  type TestApp,
} from "../test/helpers.js";
import { buildApp } from "./app.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the test's own data folder */

const sha = "0123456789abcdef0123456789abcdef01234567";
let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

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

describe("health", () => {
  it("reports version, revision, build dates and the plan", async () => {
    current = await testApp({ extraEnv: { DIALWARDEN_REVISION: sha } });
    const res = await current.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      version: "27.0.0",
      revision: sha,
      buildDate: "2026-11-21T07:00:00Z",
      featureBaseline: "2026-11-21T07:00:00Z",
      plan: "free",
    });
  });

  it("answers readiness after a database check", async () => {
    current = await testApp();
    const res = await current.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("is not ready while the database is closed", async () => {
    current = await testApp();
    current.app.ctx.store.close();
    const res = await current.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready" });
  });
});

describe("OpenAPI", () => {
  it("serves an OpenAPI 3.1 document of the API", async () => {
    current = await testApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe("3.1.0");
    const paths = Object.keys(doc.paths);
    const expected = [
      "/api/v1/setup",
      "/api/v1/auth/login",
      "/api/v1/auth/totp/enrol",
      "/api/v1/entitlement",
      "/api/v1/licence",
      "/api/v1/plan/editable-servers",
      "/api/v1/activity",
      "/api/v1/system/backups",
    ];
    for (const path of expected) {
      expect(paths).toContain(path);
    }
    expect(paths).not.toContain("/api/v1/openapi.json");
  });
});

describe("APP_SECRET_KEY", () => {
  it("is generated once into the data folder, mode 0600, with a banner", async () => {
    current = await testApp({ extraEnv: { APP_SECRET_KEY: "" } });
    const { app, dataDir } = current;
    const info = await stat(join(dataDir, "app-secret.key"));
    expect(info.mode & 0o777).toBe(0o600);
    expect(app.ctx.appKey).toMatchObject({ source: "file", generated: true });

    const owner = await setupOwner(app);
    const status = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/system/status",
        headers: headersOf(owner),
      });
    expect((await status()).json()).toMatchObject({
      appSecret: { source: "file", showBackupBanner: true },
    });
    const ack = await app.inject({
      method: "POST",
      url: "/api/v1/system/app-secret/acknowledge",
      headers: headersOf(owner),
    });
    expect(ack.statusCode).toBe(204);
    expect((await status()).json()).toMatchObject({
      appSecret: { backupAcknowledged: true, showBackupBanner: false },
    });
  });

  it("reuses the generated key on the next start", async () => {
    const first = await testApp({ extraEnv: { APP_SECRET_KEY: "" } });
    const kid = first.app.ctx.aead.kid;
    await first.app.close();
    try {
      const second = await buildApp({
        keys: testKeyRing,
        env: { LOG_LEVEL: "silent", DATA_DIR: first.dataDir, ...BUILD_ENV },
        out: discard(),
      });
      try {
        expect(second.ctx.aead.kid).toBe(kid);
        expect(second.ctx.appKey.generated).toBe(false);
      } finally {
        await second.close();
      }
    } finally {
      await rm(first.dataDir, { recursive: true, force: true });
    }
  });
});

describe("logs", () => {
  it("never carry passwords, tokens or session values", async () => {
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
    });
    const { app } = current;
    const owner = await setupOwner(app);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: owner.email, password: owner.password },
    });
    app.log.info(
      { password: owner.password, nested: { token: "probe-token-value" } },
      "redaction probe",
    );
    const text = log.text();
    expect(text).toContain("redaction probe");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(owner.password);
    expect(text).not.toContain("probe-token-value");
    expect(text).not.toContain(owner.csrf);
    expect(text).not.toContain(owner.cookie.slice("dw_session=".length));
  });

  // Threat test T9 (THE-2134 L5): a database error logs its name and stack,
  // never the query parameters its message carries.
  it("cut query parameters from logged server errors", async () => {
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
      extend: (app) => {
        const config = { auth: "public" as const };
        app.get("/api/v1/test-throw", { config }, async () => {
          throw new Error(
            "Failed query: insert into sessions\nparams: MARKER-7f3a,other",
          );
        });
      },
    });
    const response = await current.app.inject({
      method: "GET",
      url: "/api/v1/test-throw",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal" });
    const text = log.text();
    expect(text).toContain("request failed");
    expect(text).toContain("Failed query: insert into sessions");
    expect(text).not.toContain("MARKER-7f3a");
  });

  it("redact secret fields three levels deep and keep error codes", async () => {
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
    });
    const error = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    current.app.log.info(
      {
        a: { b: { passwordHash: "probe-hash-value" } },
        row: { totp_secret_enc: "probe-enc-value" },
        err: error,
      },
      "redaction probe",
    );
    const text = log.text();
    expect(text).not.toContain("probe-hash-value");
    expect(text).not.toContain("probe-enc-value");
    expect(text).toContain("SQLITE_BUSY");
  });

  it("G4.8 redact the OIDC secret, SSH key, hook command and Enc fields", async () => {
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
    });
    const fields = [
      "clientSecret",
      "privateKey",
      "command",
      "passwordEnc",
      "password_enc",
      "privateKeyEnc",
      "payloadEnc",
      "revertEnc",
      "secretEnc",
    ];
    const probe = Object.fromEntries(
      fields.map((field) => [field, `probe-${field}-value`]),
    );
    current.app.log.info(
      { top: probe, a: { b: { c: probe } } },
      "redaction probe",
    );
    const text = log.text();
    expect(text).toContain("redaction probe");
    for (const field of fields) {
      expect(text).not.toContain(`probe-${field}-value`);
    }
  });

  // Code review M4: a handler that returns the wrong shape is a server bug.
  it("answer a response that breaks its schema with a logged 500", async () => {
    const log = logCapture();
    current = await testApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
      extend: (app) => {
        app.get(
          "/api/v1/test-bad-response",
          {
            config: { auth: "public" },
            schema: { response: { 200: z.object({ ok: z.boolean() }) } },
          },
          async () => ({ ok: "not a boolean" }),
        );
      },
    });
    const response = await current.app.inject({
      method: "GET",
      url: "/api/v1/test-bad-response",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal" });
    expect(log.text()).toContain("response serialization failed");
  });
});
