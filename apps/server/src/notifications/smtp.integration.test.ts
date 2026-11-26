// The SMTP e-mail channel (dev-work-plan P9-B) against a Mailpit container
// started from the test code (no ci.yml change). Mailpit requires STARTTLS
// with a certificate made here for mail.dialwarden.test, so a delivered
// message proves the upgrade happened; its API shows what arrived. The
// channel trusts that certificate only through the test-only
// BuildOptions.notificationTls seam, and reaches the container through the
// test-only resolver, so the same certificate also shows that a wrong CA or
// a wrong host name is refused (TLS verification stays on).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  tempDir,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import { paidApp } from "../../test/team.js";
import type { ChannelView } from "./channels.js";

const IMAGE = "axllent/mailpit:v1.33.1";
const SMTP_PORT = 1025;
const API_PORT = 8025;
const MAIL_HOST = "mail.dialwarden.test";
const CHANNELS = "/api/v1/notifications/channels";

const dockerAvailable =
  existsSync("/var/run/docker.sock") ||
  (process.env["DOCKER_HOST"] ?? "") !== "" ||
  process.env["CI"] === "true";

let container: StartedTestContainer | undefined;
let certDir = "";
let certificate = "";
let address = "";
let apiBase = "";
let smtpPort = 0;
const apps: TestApp[] = [];

interface MailpitSummary {
  ID: string;
  Subject: string;
  From: { Address: string };
  To: { Address: string }[];
}

async function messages(): Promise<MailpitSummary[]> {
  const answer = await fetch(`${apiBase}/api/v1/messages`);
  const body = (await answer.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

async function messageText(id: string): Promise<string> {
  const answer = await fetch(`${apiBase}/api/v1/message/${id}`);
  return ((await answer.json()) as { Text: string }).Text;
}

/** A Paid app whose SMTP channel reaches the container; the owner. */
async function appWith(
  trustCertificate: boolean,
): Promise<{ current: TestApp; owner: SignedIn }> {
  const current = await paidApp({
    notificationNetwork: {
      allowLoopback: true,
      resolve: async () => [address],
    },
    ...(trustCertificate ? { notificationTls: { ca: certificate } } : {}),
  });
  apps.push(current);
  return { current, owner: await setupOwner(current.app) };
}

async function smtpChannel(
  current: TestApp,
  owner: SignedIn,
  host = MAIL_HOST,
): Promise<ChannelView> {
  const response = await current.app.inject({
    method: "POST",
    url: CHANNELS,
    headers: headersOf(owner),
    payload: {
      name: "Mail",
      enabled: true,
      types: ["backup.done"],
      settings: {
        kind: "smtp",
        host,
        port: smtpPort,
        security: "starttls",
        username: "dialwarden",
        password: randomBytes(18).toString("base64url"),
        from: "dialwarden@dialwarden.test",
        to: ["ops@dialwarden.test"],
        // The container may sit on a private Docker address.
        allowPrivateHost: true,
      },
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`channel: ${response.statusCode} ${response.body}`);
  }
  return response.json<ChannelView>();
}

async function sendTest(
  current: TestApp,
  owner: SignedIn,
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const response = await current.app.inject({
    method: "POST",
    url: `${CHANNELS}/${id}/test`,
    headers: headersOf(owner),
  });
  return response.json();
}

describe.skipIf(!dockerAvailable)("SMTP channel against Mailpit", () => {
  beforeAll(async () => {
    certDir = await tempDir("dialwarden-smtp-");
    const key = join(certDir, "key.pem");
    const cert = join(certDir, "cert.pem");
    // A throwaway self-signed certificate, made for this run only.
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${MAIL_HOST}`,
      "-addext",
      `subjectAltName=DNS:${MAIL_HOST}`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temporary folder
    certificate = readFileSync(cert, "utf8");
    const { GenericContainer, Wait } = await import("testcontainers");
    container = await new GenericContainer(IMAGE)
      .withCopyContentToContainer([
        { content: certificate, target: "/certs/cert.pem", mode: 0o644 },
        {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temporary folder
          content: readFileSync(key, "utf8"),
          target: "/certs/key.pem",
          mode: 0o644,
        },
      ])
      .withEnvironment({
        MP_SMTP_TLS_CERT: "/certs/cert.pem",
        MP_SMTP_TLS_KEY: "/certs/key.pem",
        MP_SMTP_REQUIRE_STARTTLS: "true",
        MP_SMTP_AUTH_ACCEPT_ANY: "true",
      })
      .withExposedPorts(SMTP_PORT, API_PORT)
      .withWaitStrategy(Wait.forHttp("/readyz", API_PORT))
      .withStartupTimeout(180_000)
      .start();
    const host = container.getHost();
    address = host === "localhost" ? "127.0.0.1" : host;
    smtpPort = container.getMappedPort(SMTP_PORT);
    apiBase = `http://${address}:${String(container.getMappedPort(API_PORT))}`;
  }, 240_000);

  afterAll(async () => {
    for (const current of apps) await current.close();
    await container?.stop();
    await rm(certDir, { recursive: true, force: true });
  }, 60_000);

  it("delivers a C6 row as a plain-text e-mail over STARTTLS", async () => {
    const { current, owner } = await appWith(true);
    const channel = await smtpChannel(current, owner);
    expect(channel.settings).toMatchObject({
      kind: "smtp",
      host: MAIL_HOST,
      hasPassword: true,
    });
    expect(JSON.stringify(channel)).not.toMatch(/"password"/);
    current.app.ctx.activity.record("backup.done", {
      data: { id: "20261126-0330", sizeBytes: 1024 },
    });
    await current.app.ctx.notifications.idle();
    const found = (await messages()).find(
      (m) => m.Subject === "[Dialwarden] App backup done",
    );
    expect(found).toBeDefined();
    expect(found?.From.Address).toBe("dialwarden@dialwarden.test");
    expect(found?.To.map((to) => to.Address)).toEqual(["ops@dialwarden.test"]);
    const text = await messageText(found?.ID ?? "");
    expect(text).toContain("App backup done");
    expect(text).toContain("By system, ");
    const view = current.app.ctx.channels.get(channel.id);
    expect(view.lastResult).toBe("ok");
  }, 60_000);

  it("answers the send test", async () => {
    const { current, owner } = await appWith(true);
    const channel = await smtpChannel(current, owner);
    expect(await sendTest(current, owner, channel.id)).toEqual({
      ok: true,
      error: null,
    });
    const subjects = (await messages()).map((m) => m.Subject);
    expect(subjects).toContain("[Dialwarden] Test message from Dialwarden");
  }, 60_000);

  it("refuses a certificate it does not trust", async () => {
    const { current, owner } = await appWith(false);
    const channel = await smtpChannel(current, owner);
    expect(await sendTest(current, owner, channel.id)).toEqual({
      ok: false,
      error: "tls_failed",
    });
  }, 60_000);

  it("refuses a certificate for another host name", async () => {
    const { current, owner } = await appWith(true);
    const channel = await smtpChannel(current, owner, "other.dialwarden.test");
    expect(await sendTest(current, owner, channel.id)).toEqual({
      ok: false,
      error: "tls_failed",
    });
  }, 60_000);
});
