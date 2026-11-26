// First-run setup token and the Development owner bootstrap (security review
// THE-2134 M3, threat tests T4.1 to T4.4; R&D decision THE-2141, tests T4.7 to
// T4.11). T4.5 (one import at a time) is in backup/backup.test.ts.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { testKeyRing } from "@dialwarden/entitlement/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_ENV,
  randomPassword,
  setupHeaders,
  setupOwner,
  setupTokenOf,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { buildApp } from "../app.js";
import { SETUP_TOKEN_FILE } from "./first-run.js";

let current: TestApp | undefined;
const apps: FastifyInstance[] = [];
const folders: string[] = [];

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

/** A stream that keeps what is written to it. */
function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** An app on a data folder the test keeps across starts. */
async function startOn(
  dataDir: string,
  extraEnv: Record<string, string> = {},
  streams: { out?: Writable; log?: Writable } = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    keys: testKeyRing,
    env: { LOG_LEVEL: "info", DATA_DIR: dataDir, ...BUILD_ENV, ...extraEnv },
    out: streams.out ?? capture().stream,
    logStream: streams.log ?? capture().stream,
  });
  apps.push(app);
  return app;
}

async function keptFolder(): Promise<string> {
  const folder = await tempDir("dialwarden-setup-test-");
  folders.push(folder);
  return folder;
}

const ownerBody = () => ({
  email: "owner@dialwarden.test",
  password: randomPassword(),
  name: "Owner",
});

function postSetup(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/setup",
    headers,
    payload: ownerBody(),
  });
}

describe("first-run setup token", () => {
  it("is required, checked exactly, and deleted once the owner exists", async () => {
    current = await testApp();
    const { app, dataDir } = current;
    const token = setupTokenOf(app);
    const file = join(dataDir, SETUP_TOKEN_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // T4.1: no header.
    const missing = await postSetup(app, {});
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: "setup_token_required" });
    const still = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(still.json()).toEqual({ required: true });

    // T4.2: one character changed, same length.
    const last = token.endsWith("0") ? "1" : "0";
    const changed = `${token.slice(0, -1)}${last}`;
    const header = "x-dialwarden-setup-token";
    const wrong = await postSetup(app, { [header]: changed });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: "setup_token_invalid" });
    const malformed = await postSetup(app, { [header]: "not-a-token" });
    expect(malformed.json()).toEqual({ error: "setup_token_invalid" });

    // T4.3: the right token creates the owner; the file is gone after.
    const created = await postSetup(app, { [header]: token });
    expect(created.statusCode).toBe(201);
    expect(existsSync(file)).toBe(false);
    const again = await postSetup(app, { [header]: token });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "setup_done" });
  });

  it("refuses an import without the token before storing anything", async () => {
    // T4.4
    current = await testApp();
    const { app, dataDir } = current;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/import",
      headers: {
        "content-type": "application/octet-stream",
        "x-dialwarden-passphrase": "synthetic-passphrase-1234",
      },
      payload: randomBytes(1024),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "setup_token_required" });
    const staging = (await readdir(dataDir)).filter((name) =>
      name.startsWith(".import-"),
    );
    expect(staging).toEqual([]);
  });

  // P10-A G5.5: once the owner exists the old setup token opens no import.
  it("G5.5 refuses an import after the owner exists, even with the old token", async () => {
    current = await testApp();
    const { app, dataDir } = current;
    const headers = setupHeaders(app);
    const created = await postSetup(app, headers);
    expect(created.statusCode).toBe(201);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/import",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-dialwarden-passphrase": "synthetic-passphrase-1234",
      },
      payload: randomBytes(1024),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "setup_done" });
    const staging = (await readdir(dataDir)).filter((name) =>
      name.startsWith(".import-"),
    );
    expect(staging).toEqual([]);
  });

  it("keeps the token after a failed import, so the next import is accepted", async () => {
    // T4.11
    current = await testApp();
    const { app, dataDir } = current;
    const importOnce = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/setup/import",
        headers: {
          ...setupHeaders(app),
          "content-type": "application/octet-stream",
          "x-dialwarden-passphrase": "synthetic-passphrase-1234",
        },
        payload: randomBytes(1024),
      });
    const first = await importOnce();
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ error: "import_failed" });
    expect(existsSync(join(dataDir, SETUP_TOKEN_FILE))).toBe(true);
    const second = await importOnce();
    expect(second.statusCode).toBe(422);
  });

  it("is the same across restarts and printed with the setup link", async () => {
    // T4.10
    const dataDir = await keptFolder();
    const env = {
      APP_SECRET_KEY: randomBytes(32).toString("hex"),
      BASE_URL: "https://dialwarden.example.test/",
    };
    const firstOut = capture();
    const first = await startOn(dataDir, env, { out: firstOut.stream });
    const token = setupTokenOf(first);
    await first.close();
    apps.splice(0);
    const secondOut = capture();
    const second = await startOn(dataDir, env, { out: secondOut.stream });
    expect(setupTokenOf(second)).toBe(token);
    const link = `https://dialwarden.example.test/setup#token=${token}`;
    expect(firstOut.text()).toContain(link);
    expect(secondOut.text()).toContain(link);
  });

  it("is not created once an owner exists, and an old file is deleted", async () => {
    const dataDir = await keptFolder();
    const env = { APP_SECRET_KEY: randomBytes(32).toString("hex") };
    const first = await startOn(dataDir, env);
    await setupOwner(first);
    await first.close();
    apps.splice(0);
    const out = capture();
    await startOn(dataDir, env, { out: out.stream });
    expect(existsSync(join(dataDir, SETUP_TOKEN_FILE))).toBe(false);
    expect(out.text()).not.toContain("first-run setup");
  });
});

describe("owner from DEV_SEED_OWNER_EMAIL and DEV_SEED_OWNER_PASSWORD", () => {
  it("creates the owner before the server listens and closes setup", async () => {
    // T4.7
    const password = randomPassword();
    current = await testApp({
      extraEnv: {
        DEV_SEED_OWNER_EMAIL: "owner@dialwarden.test",
        DEV_SEED_OWNER_PASSWORD: password,
      },
    });
    const { app, dataDir } = current;
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "owner@dialwarden.test", password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { role: "owner" } });
    const setup = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(setup.json()).toEqual({ required: false });
    expect(existsSync(join(dataDir, SETUP_TOKEN_FILE))).toBe(false);
    const header = { "x-dialwarden-setup-token": "a".repeat(64) };
    const late = await postSetup(app, header);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: "setup_done" });
  });

  it("does nothing when a user exists and never logs the password", async () => {
    // T4.8
    const dataDir = await keptFolder();
    const env = { APP_SECRET_KEY: randomBytes(32).toString("hex") };
    const first = await startOn(dataDir, env);
    await setupOwner(first, {
      email: "first@dialwarden.test",
      password: randomPassword(),
    });
    await first.close();
    apps.splice(0);
    const password = randomPassword();
    const log = capture();
    const second = await startOn(
      dataDir,
      {
        ...env,
        DEV_SEED_OWNER_EMAIL: "seed@dialwarden.test",
        DEV_SEED_OWNER_PASSWORD: password,
      },
      { log: log.stream },
    );
    const users = second.ctx.store.sqlite
      .prepare("SELECT email FROM users")
      .all() as { email: string }[];
    expect(users).toEqual([{ email: "first@dialwarden.test" }]);
    expect(log.text()).toContain("DEV_SEED_OWNER_EMAIL");
    expect(log.text()).not.toContain(password);
  });

  it("refuses a short password, names the variable and keeps setup closed", async () => {
    // T4.9
    const dataDir = await keptFolder();
    const short = "eleven-char";
    expect(short).toHaveLength(11);
    const log = capture();
    const app = await startOn(
      dataDir,
      {
        APP_SECRET_KEY: randomBytes(32).toString("hex"),
        DEV_SEED_OWNER_EMAIL: "owner@dialwarden.test",
        DEV_SEED_OWNER_PASSWORD: short,
      },
      { log: log.stream },
    );
    expect(app.ctx.auth.setupRequired()).toBe(true);
    const file = join(dataDir, SETUP_TOKEN_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const errors = log
      .text()
      .split("\n")
      .filter((line) => line.includes("DEV_SEED_OWNER_PASSWORD"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(short);
  });
});
