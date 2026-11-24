// Threat test T5 of the security review (THE-2398): no credential reaches an
// SFTP server whose host key is not confirmed, or differs from the confirmed
// one. The server runs in the test process and counts authentication
// requests; the handshake must stop at the host key, before any of them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hostKeyPair,
  startSshServer,
  usablePair,
  type HostKeyPair,
  type SshServer,
} from "../../test/ssh-server.js";
import { randomPassword, testApp, type TestApp } from "../../test/helpers.js";
import { SftpConnector, type SftpAuth } from "./sftp.js";
import { ConnectorError } from "./types.js";

const PASSWORD = randomPassword();

let hostKey: HostKeyPair;
let server: SshServer;
let current: TestApp | undefined;

beforeEach(async () => {
  hostKey = hostKeyPair();
  server = await startSshServer({ hostKey, password: PASSWORD });
});

afterEach(async () => {
  await server.close();
  await current?.close();
  current = undefined;
});

function connector(auth: SftpAuth, pinned: string | null): SftpConnector {
  return new SftpConnector({
    host: "127.0.0.1",
    port: server.port,
    username: "game",
    root: "",
    auth,
    pinnedFingerprint: pinned,
    readyTimeoutMs: 5000,
    operationTimeoutMs: 5000,
  });
}

const panel: SftpAuth = { method: "password", password: PASSWORD };

/** The error of a call that must fail, with its fields as JSON text. */
async function failure(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error;
    const text = JSON.stringify({
      ...error,
      message: error.message,
      cause: String(error.cause),
    });
    return { code: error.code, text };
  }
  throw new Error("the call did not fail");
}

describe("SFTP host key before credentials (T5)", () => {
  it("returns the fingerprint of an unpinned server and sends no password", async () => {
    const sftp = connector(panel, null);
    try {
      const result = await sftp.test();
      expect(result).toMatchObject({
        ok: false,
        error: "Connection",
        hostKey: {
          algorithm: "ssh-ed25519",
          fingerprint: hostKey.fingerprint,
          status: "unpinned",
        },
      });
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    } finally {
      await sftp.close();
    }
    expect(server.authentications()).toBe(0);
  });

  it("refuses reads and writes with HostKeyChanged and sends no password", async () => {
    const other = hostKeyPair();
    const sftp = connector(panel, other.fingerprint);
    try {
      const calls = [
        () => sftp.read("a.ini"),
        () => sftp.list(""),
        () => sftp.writeAtomic("a.ini", new TextEncoder().encode("x")),
      ];
      for (const call of calls) {
        const failed = await failure(call());
        expect(failed.code).toBe("HostKeyChanged");
        expect(failed.text).not.toContain(PASSWORD);
      }
      const result = await sftp.test();
      expect(result).toMatchObject({
        ok: false,
        error: "HostKeyChanged",
        hostKey: { fingerprint: hostKey.fingerprint, status: "changed" },
      });
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    } finally {
      await sftp.close();
    }
    expect(server.authentications()).toBe(0);
  });

  it("never offers the instance key to an unpinned server", async () => {
    const pair = usablePair();
    const sftp = connector({ method: "key", privateKey: pair.private }, null);
    try {
      expect(await sftp.test()).toMatchObject({
        ok: false,
        hostKey: { status: "unpinned" },
      });
    } finally {
      await sftp.close();
    }
    expect(server.authentications()).toBe(0);
  });

  it("scans the host key without logging in", async () => {
    current = await testApp();
    const found = await current.app.ctx.connectors.scanHostKey(
      "127.0.0.1",
      server.port,
    );
    expect(found).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: hostKey.fingerprint,
    });
    expect(server.authentications()).toBe(0);
  });
});
