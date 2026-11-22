// The SFTP connector against a real OpenSSH server in a testcontainer
// (dev-work-plan P4 tests): key and password login, host key pinning and a
// changed host key that blocks writes, posix-rename and the plain-rename
// fallback, owner and mode kept, the hash check, confinement (.. paths,
// absolute paths, symbolic links out of the root), detection through list()
// (the Palworld WorldOption.sav warning), the host key confirm through the
// API with the instance key, and the reconnect after a drop.
//
// The container is Alpine with the distribution's OpenSSH, started from this
// test; every credential is generated when the test runs. Without Docker the
// suite is skipped locally; in CI (CI=true) it always runs.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPacks } from "@dialwarden/packs-schema/node";
import ssh2 from "ssh2";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headersOf, setupOwner, testApp } from "../../test/helpers.js";
import { detectServer } from "./detect.js";
import { fingerprintOf } from "./host-key.js";
import { SftpConnector, type SftpAuth, type SftpOptions } from "./sftp.js";
import { ConnectorError } from "./types.js";

const IMAGE = "alpine:3.20";
const PORT = 2222;
const USER = "dw";
const ROOT = "/srv/game";
const WORLD = "0A1B2C3D4E5F60718293A4B5C6D7E8F9";
const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const HOST_KEYS = "/api/v1/connectors/host-keys";

const dockerAvailable =
  existsSync("/var/run/docker.sock") ||
  (process.env["DOCKER_HOST"] ?? "") !== "" ||
  process.env["CI"] === "true";

// Runs as root in the container: OpenSSH from the distribution, one user
// with the generated password and public key, and a server folder with a
// file, a world save, and links that lead out of it.
const SETUP = `
set -eu
apk add --no-cache openssh-server openssh-sftp-server >/dev/null
adduser -D -s /bin/sh ${USER}
echo "${USER}:$DW_PASSWORD" | chpasswd
mkdir -p /home/${USER}/.ssh ${ROOT}/Config ${ROOT}/Pal/Saved/SaveGames/0/${WORLD} /srv/outside
cp /setup/authorized_keys /home/${USER}/.ssh/authorized_keys
printf '[Game]\nName=One\n' > ${ROOT}/Config/game.ini
printf '#!/bin/sh\n' > ${ROOT}/PalServer.sh
echo outside > /srv/outside/secret.txt
ln -s /srv/outside ${ROOT}/linked
ln -s /srv/outside/secret.txt ${ROOT}/link.txt
chown -R ${USER}:${USER} /home/${USER} ${ROOT}
chmod 700 /home/${USER}/.ssh
chmod 600 /home/${USER}/.ssh/authorized_keys
chmod 640 ${ROOT}/Config/game.ini
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e -p ${PORT} -o PasswordAuthentication=yes -o PermitRootLogin=no
`;

const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let container: StartedTestContainer;
let host: string;
let port: number;
let password: string;
let privateKey: string;
let fingerprint: string;
const open: SftpConnector[] = [];

/** The fingerprint the container's sshd presents now. */
function scan(): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seen: string | null = null;
    const done = () => {
      client.end();
      if (seen === null) reject(new Error("no host key seen"));
      else resolve(seen);
    };
    client.on("error", done);
    client.on("close", done);
    client.connect({
      host,
      port,
      username: "scan",
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return false;
      },
    });
  });
}

function connector(overrides: Partial<SftpOptions> = {}): SftpConnector {
  const auth: SftpAuth = { method: "key", privateKey };
  const made = new SftpConnector({
    host,
    port,
    username: USER,
    root: ROOT,
    auth,
    pinnedFingerprint: fingerprint,
    readyTimeoutMs: 15_000,
    operationTimeoutMs: 15_000,
    ...overrides,
  });
  open.push(made);
  return made;
}

async function shell(script: string): Promise<string> {
  const result = await container.exec(["sh", "-c", script]);
  if (result.exitCode !== 0) {
    throw new Error(`container command failed: ${result.output}`);
  }
  return result.output.trim();
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.code : String(error);
  }
}

describe.skipIf(!dockerAvailable)("SFTP connector against OpenSSH", () => {
  beforeAll(async () => {
    password = randomBytes(18).toString("base64url");
    const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "test" });
    privateKey = pair.private;
    // Loaded here, so a run without Docker never loads testcontainers.
    const { GenericContainer, Wait } = await import("testcontainers");
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ DW_PASSWORD: password })
      .withCopyContentToContainer([
        { content: `${pair.public}\n`, target: "/setup/authorized_keys" },
      ])
      .withCommand(["sh", "-c", SETUP])
      .withExposedPorts(PORT)
      .withWaitStrategy(Wait.forLogMessage(/Server listening on/))
      .withStartupTimeout(180_000)
      .start();
    host = container.getHost();
    port = container.getMappedPort(PORT);
    fingerprint = await scan();
  }, 240_000);

  afterAll(async () => {
    for (const made of open) await made.close();
    await container?.stop();
  }, 60_000);

  it("logs in with the key and reads a file inside the root", async () => {
    const sftp = connector();
    const result = await sftp.test();
    expect(result).toMatchObject({ ok: true, root: ROOT });
    expect(result.hostKey).toMatchObject({ fingerprint, status: "pinned" });
    expect(decode((await sftp.read("Config/game.ini")).bytes)).toBe(
      "[Game]\nName=One\n",
    );
    expect(await sftp.stat("Config/game.ini")).toMatchObject({
      size: 16,
      mode: 0o640,
      type: "file",
    });
  }, 60_000);

  it("logs in with a password for panel SFTP, and refuses a wrong one", async () => {
    const good = connector({ auth: { method: "password", password } });
    expect(await good.test()).toMatchObject({ ok: true });
    const bad = connector({
      auth: { method: "password", password: `${password}-wrong` },
    });
    const result = await bad.test();
    expect(result).toMatchObject({ ok: false, error: "Connection" });
    expect(result.message).not.toContain(password);
  }, 60_000);

  it("returns the fingerprint of an unpinned host and sends no credential", async () => {
    const sftp = connector({ pinnedFingerprint: null });
    const result = await sftp.test();
    expect(result).toMatchObject({
      ok: false,
      error: "Connection",
      hostKey: { fingerprint, status: "unpinned" },
    });
    expect(await codeOf(sftp.read("Config/game.ini"))).toBe("Connection");
  }, 60_000);

  it("writes through a temp file with posix-rename, keeping owner and mode", async () => {
    const sftp = connector();
    const before = await sftp.read("Config/game.ini");
    const owner = await shell(`stat -c '%u %g' ${ROOT}/Config/game.ini`);
    const hash = await sftp.writeAtomic(
      "Config/game.ini",
      text("[Game]\nName=Two\n"),
      {
        expectedSha256: before.sha256,
      },
    );
    expect(hash).toBe((await sftp.read("Config/game.ini")).sha256);
    expect(await shell(`cat ${ROOT}/Config/game.ini`)).toBe("[Game]\nName=Two");
    expect(await shell(`stat -c '%a' ${ROOT}/Config/game.ini`)).toBe("640");
    expect(await shell(`stat -c '%u %g' ${ROOT}/Config/game.ini`)).toBe(owner);
    expect(await shell(`ls -A ${ROOT}/Config`)).toBe("game.ini");
  }, 60_000);

  it("falls back to a plain rename when posix-rename is not used", async () => {
    const sftp = connector({ posixRename: false });
    await sftp.writeAtomic("Config/game.ini", text("[Game]\nName=Three\n"));
    expect(await shell(`cat ${ROOT}/Config/game.ini`)).toBe(
      "[Game]\nName=Three",
    );
    expect(await shell(`stat -c '%a' ${ROOT}/Config/game.ini`)).toBe("640");
    // Neither the temp file nor the old file is left behind.
    expect(await shell(`ls -A ${ROOT}/Config`)).toBe("game.ini");
    await sftp.writeAtomic("Config/fresh.ini", text("a=1\n"), {
      expectedSha256: null,
    });
    expect(await shell(`cat ${ROOT}/Config/fresh.ini`)).toBe("a=1");
  }, 60_000);

  it("refuses a write with HashMismatch when the file changed", async () => {
    const sftp = connector();
    const code = await codeOf(
      sftp.writeAtomic("Config/game.ini", text("lost edit"), {
        expectedSha256: "0".repeat(64),
      }),
    );
    expect(code).toBe("HashMismatch");
    expect(await shell(`cat ${ROOT}/Config/game.ini`)).not.toContain(
      "lost edit",
    );
  }, 60_000);

  it("refuses paths and links that leave the root", async () => {
    const sftp = connector();
    for (const rel of [
      "../outside/secret.txt",
      "/etc/passwd",
      "Config/../../outside/secret.txt",
    ]) {
      expect(await codeOf(sftp.read(rel)), rel).toBe("PathEscape");
      expect(await codeOf(sftp.writeAtomic(rel, text("x"))), rel).toBe(
        "PathEscape",
      );
    }
    expect(await codeOf(sftp.read("link.txt"))).toBe("PathEscape");
    expect(await codeOf(sftp.writeAtomic("link.txt", text("x")))).toBe(
      "PathEscape",
    );
    expect(await codeOf(sftp.read("linked/secret.txt"))).toBe("PathEscape");
    expect(await codeOf(sftp.list("linked"))).toBe("PathEscape");
    expect(await codeOf(sftp.writeAtomic("linked/new.txt", text("x")))).toBe(
      "PathEscape",
    );
    expect(await shell("ls -A /srv/outside")).toBe("secret.txt");
    expect(await shell("cat /srv/outside/secret.txt")).toBe("outside");
  }, 60_000);

  it("answers NotFound for a missing file", async () => {
    expect(await codeOf(connector().read("Config/missing.ini"))).toBe(
      "NotFound",
    );
  }, 60_000);

  it("detects Palworld and its WorldOption.sav warning through list()", async () => {
    const sftp = connector();
    const packs = loadPacks(PACKS).packs;
    const before = await detectServer(packs.values(), sftp);
    expect(before).toEqual([
      expect.objectContaining({
        packId: "palworld",
        os: "linux",
        warnings: [],
      }),
    ]);
    await shell(
      `touch ${ROOT}/Pal/Saved/SaveGames/0/${WORLD}/WorldOption.sav && chown -R ${USER} ${ROOT}/Pal`,
    );
    const [after] = await detectServer(packs.values(), sftp);
    expect(after?.warnings).toHaveLength(1);
    expect(after?.warnings[0]).toContain("WorldOption.sav");
  }, 60_000);

  it("pins the host key through the API, then logs in with the instance key", async () => {
    const instance = await testApp({ config: { packsDir: PACKS } });
    try {
      const { app } = instance;
      const headers = headersOf(await setupOwner(app));
      const key = await app.inject({
        url: "/api/v1/connectors/ssh-key",
        headers,
      });
      const { publicKey } = key.json<{ publicKey: string }>();
      await shell(`echo '${publicKey}' >> /home/${USER}/.ssh/authorized_keys`);
      const spec = { kind: "sftp", host, port, username: USER, root: ROOT };
      const post = (url: string, payload: object) =>
        app.inject({ method: "POST", url, headers, payload });

      // Unpinned: the test answers the fingerprint and logs nothing in.
      const first = await post("/api/v1/connectors/test", spec);
      expect(first.json()).toMatchObject({
        ok: false,
        error: "Connection",
        hostKey: { fingerprint, status: "unpinned" },
      });
      // A fingerprint the server does not present is never pinned.
      const other = `SHA256:${"A".repeat(43)}`;
      const wrong = await post(HOST_KEYS, { host, port, fingerprint: other });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({
        error: "host_key_mismatch",
        presented: { fingerprint },
      });
      expect(app.ctx.connectors.knownHosts.get(host, port)).toBeNull();

      const confirm = await post(HOST_KEYS, { host, port, fingerprint });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toMatchObject({ host, port, fingerprint });

      const second = await post("/api/v1/connectors/test", spec);
      expect(second.json()).toMatchObject({
        ok: true,
        root: ROOT,
        hostKey: { fingerprint, status: "pinned" },
      });
      const detect = await post("/api/v1/connectors/detect", spec);
      expect(detect.json()).toMatchObject({ items: [{ packId: "palworld" }] });

      // Another pinned key is replaced only on purpose.
      app.ctx.connectors.knownHosts.pin(
        host,
        port,
        { algorithm: "ssh-ed25519", fingerprint: other },
        null,
      );
      const kept = await post(HOST_KEYS, { host, port, fingerprint });
      expect(kept.statusCode).toBe(409);
      expect(kept.json()).toMatchObject({
        error: "host_key_pinned_differently",
      });
      const replaced = await post(HOST_KEYS, {
        host,
        port,
        fingerprint,
        replace: true,
      });
      expect(replaced.statusCode).toBe(200);
      expect(app.ctx.connectors.knownHosts.get(host, port)?.fingerprint).toBe(
        fingerprint,
      );
    } finally {
      await instance.close();
    }
  }, 60_000);

  it("connects again after the server drops the connection", async () => {
    const sftp = connector();
    await sftp.read("Config/game.ini");
    // Ends the per-login sshd processes, not the listener. The pattern is
    // written as a character class so the exec shell running pkill, whose
    // own command line holds the pattern text, does not match itself.
    await shell(`pkill -f 'sshd[: ] ${USER}' || true`);
    const deadline = Date.now() + 10_000;
    let read: string | null = null;
    while (read === null && Date.now() < deadline) {
      try {
        read = decode((await sftp.read("Config/game.ini")).bytes);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(read).toContain("[Game]");
  }, 60_000);

  it("reports a closed port as a Connection failure", async () => {
    const sftp = connector({ port: 1, readyTimeoutMs: 5_000 });
    expect(await sftp.test()).toMatchObject({ ok: false, error: "Connection" });
  }, 60_000);

  // Last: it replaces the container's host keys.
  it("blocks reads and writes with HostKeyChanged after the host key changes", async () => {
    const pinned = fingerprint;
    await shell(
      "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1",
    );
    const deadline = Date.now() + 15_000;
    let now = pinned;
    while (now === pinned && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      now = await scan().catch(() => pinned);
    }
    expect(now).not.toBe(pinned);
    const sftp = connector({ pinnedFingerprint: pinned });
    const before = await shell(`cat ${ROOT}/Config/game.ini`);
    expect(
      await codeOf(sftp.writeAtomic("Config/game.ini", text("evil"))),
    ).toBe("HostKeyChanged");
    expect(await codeOf(sftp.read("Config/game.ini"))).toBe("HostKeyChanged");
    expect(await sftp.test()).toMatchObject({
      ok: false,
      error: "HostKeyChanged",
      hostKey: { fingerprint: now, status: "changed" },
    });
    // The password is never sent to the changed host either.
    const panel = connector({
      pinnedFingerprint: pinned,
      auth: { method: "password", password },
    });
    expect(await codeOf(panel.read("Config/game.ini"))).toBe("HostKeyChanged");
    expect(await shell(`cat ${ROOT}/Config/game.ini`)).toBe(before);
  }, 60_000);
});
