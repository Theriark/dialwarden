// Threat tests T6 and T7 (security review THE-2598) of the SSH command hook,
// against an in-process ssh2 server: only exit status 0 is success, the
// command is one bounded line, and a server that floods the channel and
// never exits is bounded.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { afterAll, describe, expect, it } from "vitest";
import { hostKeyPair } from "../../test/ssh-server.js";
import { SshCommand } from "./ssh-command.js";
import { isControlError } from "./types.js";

const COMMAND = "/usr/local/bin/restart-game";
const SECRET = `pw-${randomBytes(18).toString("base64url")}`;
const servers: ssh2.Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

type Exec = (stream: ssh2.ServerChannel) => void;

/** An in-process SSH server whose exec handler is the given function. */
async function execServer(
  onExec: Exec,
): Promise<{ port: number; fingerprint: string }> {
  const key = hostKeyPair();
  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, (client) => {
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.password === SECRET) {
        context.accept();
      } else {
        context.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec) => onExec(acceptExec()));
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint: key.fingerprint,
  };
}

const hookOn = (
  target: { port: number; fingerprint: string },
  readMs = 5_000,
) =>
  new SshCommand({
    host: "127.0.0.1",
    port: target.port,
    username: "dw",
    auth: { method: "password", password: SECRET },
    pinnedFingerprint: target.fingerprint,
    command: COMMAND,
    readMs,
  });

describe("SSH command hook in process (exit status and bounds)", () => {
  it("reports a command killed by a signal as a failure", async () => {
    const target = await execServer((stream) => {
      stream.exit("KILL");
      stream.end();
    });
    await expect(hookOn(target).restart()).rejects.toMatchObject({
      code: "Failed",
    });
  });

  it("reports a channel closed without an exit status as a failure", async () => {
    const target = await execServer((stream) => {
      stream.end();
    });
    await expect(hookOn(target).restart()).rejects.toMatchObject({
      code: "Failed",
    });
  });

  it("bounds a command that floods the channel and never exits", async () => {
    const target = await execServer((stream) => {
      stream.write(Buffer.alloc(128 * 1024, 0x61));
    });
    const began = Date.now();
    await expect(hookOn(target, 1_500).restart()).rejects.toSatisfy(
      (error: unknown) => isControlError(error),
    );
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it.each(["a\rb", "a\0b", "a\nb"])(
    "refuses the command %j at construction",
    (command) => {
      expect(
        () =>
          new SshCommand({
            host: "127.0.0.1",
            port: 22,
            username: "dw",
            auth: { method: "password", password: SECRET },
            pinnedFingerprint: null,
            command,
          }),
      ).toThrowError(/one line/);
    },
  );
});
