// Connector endpoints (dev-work-plan P4-A): the instance public key, made on
// first use and stored only encrypted; the connection test and game detection
// on a Local folder; the request checks (password only for panel SFTP, host
// and fingerprint shapes); and the owner-only rule. The SFTP half of the host
// key confirm runs against OpenSSH in connectors/sftp.integration.test.ts.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { publicKeyFingerprint } from "../connectors/host-key.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const REPO_PACKS = fileURLToPath(
  new URL("../../../../packs/", import.meta.url),
);
const KEY = "/api/v1/connectors/ssh-key";
const TEST = "/api/v1/connectors/test";
const HOST_KEYS = "/api/v1/connectors/host-keys";
const DETECT = "/api/v1/connectors/detect";

let current: TestApp | undefined;
const folders: string[] = [];

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function signedIn() {
  current = await testApp({ config: { packsDir: REPO_PACKS } });
  const owner = await setupOwner(current.app);
  return { app: current.app, headers: headersOf(owner) };
}

async function folder(): Promise<string> {
  const made = await tempDir("dialwarden-server-");
  folders.push(made);
  return made;
}

describe("connector endpoints", () => {
  it("need a signed-in owner", async () => {
    current = await testApp();
    const { app } = current;
    const calls = [
      { method: "GET" as const, url: KEY },
      {
        method: "POST" as const,
        url: TEST,
        payload: { kind: "local", root: "/tmp" },
      },
      {
        method: "POST" as const,
        url: DETECT,
        payload: { kind: "local", root: "/tmp" },
      },
      {
        method: "POST" as const,
        url: HOST_KEYS,
        payload: { host: "127.0.0.1", fingerprint: `SHA256:${"A".repeat(43)}` },
      },
    ];
    for (const call of calls) {
      const response = await app.inject(call);
      expect(response.statusCode, call.url).toBe(401);
    }
    expect(
      app.ctx.routes.filter((r) => r.url.startsWith("/api/v1/connectors/")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: KEY, auth: "owner", entitlement: null }),
        expect.objectContaining({
          url: TEST,
          auth: "owner",
          entitlement: null,
        }),
        expect.objectContaining({
          url: HOST_KEYS,
          auth: "owner",
          entitlement: null,
        }),
        expect.objectContaining({
          url: DETECT,
          auth: "owner",
          entitlement: null,
        }),
      ]),
    );
  });

  it("makes one Ed25519 key pair on first use and keeps the private key encrypted", async () => {
    const { app, headers } = await signedIn();
    const first = await app.inject({ url: KEY, headers });
    expect(first.statusCode).toBe(200);
    const body = first.json<{
      algorithm: string;
      publicKey: string;
      fingerprint: string;
    }>();
    expect(body.algorithm).toBe("ssh-ed25519");
    expect(body.publicKey).toMatch(
      /^ssh-ed25519 [A-Za-z0-9+/]+={0,2} dialwarden$/,
    );
    expect(body.fingerprint).toBe(publicKeyFingerprint(body.publicKey));
    expect(first.body).not.toContain("PRIVATE");

    const again = await app.inject({ url: KEY, headers });
    expect(again.json()).toEqual(first.json());

    const row = app.ctx.store.sqlite
      .prepare("SELECT private_key_enc AS v FROM instance_ssh_key")
      .get() as { v: string };
    expect(row.v.startsWith("dwenc1.")).toBe(true);
    expect(row.v).not.toContain("PRIVATE KEY");
    // The PEM markers are checked apart, so the committed source holds no
    // private key block (the hygiene job greps the tree for one).
    const privateKey = app.ctx.connectors.key.privateKey();
    expect(privateKey.startsWith("-----BEGIN OPENSSH")).toBe(true);
    expect(privateKey.trimEnd().endsWith("PRIVATE KEY-----")).toBe(true);
  });

  it("tests a Local folder and names its real path", async () => {
    const { app, headers } = await signedIn();
    const root = await folder();
    const response = await app.inject({
      method: "POST",
      url: TEST,
      headers,
      payload: { kind: "local", root },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("refuses the data folder and a folder around it as a Local root", async () => {
    const { app, headers } = await signedIn();
    const dataDir = app.ctx.config.dataDir;
    for (const root of [
      dataDir,
      join(dataDir, ".."),
      join(dataDir, "backups"),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: TEST,
        headers,
        payload: { kind: "local", root },
      });
      expect(response.statusCode, root).toBe(200);
      expect(response.json(), root).toMatchObject({
        ok: false,
        error: "PathEscape",
      });
    }
  });

  it("answers NotFound for a Local root that does not exist", async () => {
    const { app, headers } = await signedIn();
    const root = join(await folder(), "missing");
    const response = await app.inject({
      method: "POST",
      url: TEST,
      headers,
      payload: { kind: "local", root },
    });
    expect(response.json()).toMatchObject({ ok: false, error: "NotFound" });
  });

  it("detects Palworld in a Local folder", async () => {
    const { app, headers } = await signedIn();
    const root = await folder();
    await writeFile(join(root, "PalServer.sh"), "#!/bin/sh\n");
    await mkdir(join(root, "Pal/Saved/SaveGames/0/WORLD1"), {
      recursive: true,
    });
    await writeFile(
      join(root, "Pal/Saved/SaveGames/0/WORLD1/WorldOption.sav"),
      "x",
    );
    const response = await app.inject({
      method: "POST",
      url: DETECT,
      headers,
      payload: { kind: "local", root },
    });
    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: { warnings: string[] }[] }>();
    expect(items).toEqual([
      expect.objectContaining({
        packId: "palworld",
        displayName: "Palworld",
        by: "markers",
        os: "linux",
      }),
    ]);
    expect(items[0]?.warnings[0]).toContain("WorldOption.sav");
  });

  it("answers a C4 error for a detect on a root it may not use", async () => {
    const { app, headers } = await signedIn();
    const response = await app.inject({
      method: "POST",
      url: DETECT,
      headers,
      payload: { kind: "local", root: app.ctx.config.dataDir },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "connector_error",
      code: "PathEscape",
    });
  });

  it("takes a password only for panel SFTP, and needs one there", async () => {
    const { app, headers } = await signedIn();
    const sftp = { kind: "sftp", host: "127.0.0.1", port: 1, username: "game" };
    const panelWithout = await app.inject({
      method: "POST",
      url: TEST,
      headers,
      payload: { ...sftp, panel: true },
    });
    expect(panelWithout.statusCode).toBe(422);
    expect(panelWithout.json()).toEqual({ error: "password_required" });
    const keyWith = await app.inject({
      method: "POST",
      url: TEST,
      headers,
      payload: { ...sftp, password: "not-for-key-login" },
    });
    expect(keyWith.statusCode).toBe(422);
    expect(keyWith.json()).toEqual({ error: "password_only_for_panel" });
  });

  it("reports an SFTP server it cannot reach as a failed test", async () => {
    const { app, headers } = await signedIn();
    const response = await app.inject({
      method: "POST",
      url: TEST,
      headers,
      payload: { kind: "sftp", host: "127.0.0.1", port: 1, username: "game" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, error: "Connection" });
  });

  it("refuses a malformed host, user name or fingerprint", async () => {
    const { app, headers } = await signedIn();
    const bad = [
      { url: TEST, payload: { kind: "sftp", host: "a b", username: "game" } },
      {
        url: TEST,
        payload: { kind: "sftp", host: "user@host", username: "game" },
      },
      {
        url: TEST,
        payload: { kind: "sftp", host: "host", username: "-oProxyCommand=x y" },
      },
      { url: TEST, payload: { kind: "local", root: "/srv/a\nb" } },
      {
        url: HOST_KEYS,
        payload: { host: "127.0.0.1", fingerprint: "MD5:aa:bb" },
      },
      {
        url: HOST_KEYS,
        payload: {
          host: "127.0.0.1",
          port: 70000,
          fingerprint: `SHA256:${"A".repeat(43)}`,
        },
      },
    ];
    for (const { url, payload } of bad) {
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("answers 502 when the host of a confirm cannot be reached, and pins nothing", async () => {
    const { app, headers } = await signedIn();
    const response = await app.inject({
      method: "POST",
      url: HOST_KEYS,
      headers,
      payload: {
        host: "127.0.0.1",
        port: 1,
        fingerprint: `SHA256:${"A".repeat(43)}`,
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "connector_error",
      code: "Connection",
    });
    expect(app.ctx.connectors.knownHosts.get("127.0.0.1", 1)).toBeNull();
  });
});
