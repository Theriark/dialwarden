// Test helpers for apps/server. Outside src/, so never built into the image.
// Every credential here is generated when the test runs.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { testKeyRing } from "@dialwarden/entitlement/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp, type BuildOptions } from "../src/app.js";
import { SETUP_TOKEN_FILE } from "../src/auth/first-run.js";

/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */

/**
 * The image build variables every test app runs with (2026-11-21T07:00:00Z),
 * so licence dates in the tests never depend on the clock.
 */
export const BUILD_ENV = {
  DIALWARDEN_BUILD_EPOCH: "1795244400",
  DIALWARDEN_FEATURE_BASELINE_EPOCH: "1795244400",
};

export interface TestApp {
  app: FastifyInstance;
  dataDir: string;
  close: () => Promise<void>;
}

export async function tempDir(prefix = "dialwarden-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function testApp(
  options: BuildOptions & { extraEnv?: Record<string, string> } = {},
): Promise<TestApp> {
  const dataDir = await tempDir();
  const { extraEnv, ...build } = options;
  const env = {
    LOG_LEVEL: "silent",
    DATA_DIR: dataDir,
    APP_SECRET_KEY: randomBytes(32).toString("hex"),
    ...BUILD_ENV,
    ...extraEnv,
  };
  const app = await buildApp({
    keys: testKeyRing,
    out: discard(),
    ...build,
    env,
  });
  return {
    app,
    dataDir,
    close: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A stream that drops what is written (the first-run setup line). */
export function discard(): Writable {
  return new Writable({
    write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) {
      done();
    },
  });
}

/** The first-run setup token of a test app (DATA_DIR/setup-token). */
export function setupTokenOf(app: FastifyInstance): string {
  const file = join(app.ctx.store.dataDir, SETUP_TOKEN_FILE);
  return readFileSync(file, "utf8").trim();
}

/** The header first-run setup and import need. */
export function setupHeaders(app: FastifyInstance): Record<string, string> {
  return { "x-dialwarden-setup-token": setupTokenOf(app) };
}

export const randomPassword = (): string =>
  `pw-${randomBytes(18).toString("base64url")}`;

export interface Credentials {
  email: string;
  password: string;
}

export function ownerCredentials(): Credentials {
  return { email: "owner@dialwarden.test", password: randomPassword() };
}

export interface SignedIn {
  cookie: string;
  csrf: string;
  userId: string;
}

/** The dw_session cookie pair (name=value) from a response. */
export function sessionCookie(response: LightMyRequestResponse): string {
  const found = response.cookies.find(
    (cookie) => cookie.name === "dw_session",
  );
  if (found === undefined) {
    throw new Error("no session cookie in the response");
  }
  return `dw_session=${found.value}`;
}

export async function setupOwner(
  app: FastifyInstance,
  credentials: Credentials = ownerCredentials(),
): Promise<SignedIn & Credentials> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    headers: setupHeaders(app),
    payload: { ...credentials, name: "Owner" },
  });
  if (response.statusCode !== 201) {
    throw new Error(`setup failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  return {
    ...credentials,
    cookie: sessionCookie(response),
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}

/** Headers of a signed-in, CSRF-protected request. */
export function headersOf(user: SignedIn): Record<string, string> {
  return { cookie: user.cookie, "x-csrf-token": user.csrf };
}
