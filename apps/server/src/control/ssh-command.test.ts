// The SSH command hook (dev-work-plan P6-A step 2): the fixed per-server
// command string runs over the server's own SSH access. Against the real
// OpenSSH of a testcontainer (the dev-work-plan P6 tests) the hook writes
// what it received to a log the test reads back, so the command is proven
// verbatim and nothing appended. The host key and exit status cases run
// against the in-process ssh2 server of the security review.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import ssh2 from "ssh2";
import type { StartedTestContainer } from "testcontainers";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprintOf } from "../connectors/host-key.js";
import { hostKeyPair, startSshServer } from "../../test/ssh-server.js";
import { SshCommand } from "./ssh-command.js";
import { isControlError } from "./types.js";

const IMAGE = "alpine:3.20";
const PORT = 2222;
const USER = "dw";
const COMMAND = "/usr/local/bin/restart-game";
const PASSWORD = `pw-${randomBytes(18).toString("base64url")}`;

const dockerAvailable =
  existsSync("/var/run/docker.sock") ||
  (process.env["DOCKER_HOST"] ?? "") !== "" ||
  process.env["CI"] === "true";

// Runs as root in the container: OpenSSH from the distribution, one user
// with the generated password, and two scripts the hook can be pointed at.
const SETUP = `
set -eu
apk add --no-cache openssh-server openssh-sftp-server >/dev/null
adduser -D -s /bin/sh ${USER}
echo "${USER}:${PASSWORD}" | chpasswd
printf '#!/bin/sh\\nprintf '%%s' "ran:$*" > /tmp/hook.log\\n' > /usr/local/bin/restart-game
printf '#!/bin/sh\\nprintf '%%s' "ran:$*" > /tmp/hook.log\\nexit 3\\n' > /usr/local/bin/failing-game
chmod +x /usr/local/bin/restart-game /usr/local/bin/failing-game
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e -p ${PORT} -o PasswordAuthentication=yes -o PermitRootLogin=no
`;

let container: StartedTestContainer | undefined;
let host = "127.0.0.1";
let port = 0;
let fingerprint = "";
const started: { close(): Promise<void> | void }[] = [];

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
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return false;
      },
    });
  });
}

afterAll(async () => {
  for (const server of started) await server.close();
});

const hook = (command: string, pinned: string | null = fingerprint) =>
  new SshCommand({
    host,
    port,
    username: USER,
    auth: { method: "password", password: PASSWORD },
    pinnedFingerprint: pinned,
    command,
  });

describe.skipIf(!dockerAvailable)(
  "SSH command hook against OpenSSH in a container",
  () => {
    beforeAll(async () => {
      // Loaded here, so a run without Docker never loads testcontainers.
      const { GenericContainer, Wait } = await import("testcontainers");
      container = await new GenericContainer(IMAGE)
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
      await container?.stop();
    }, 60_000);

    it("runs the fixed command and only the fixed command", async () => {
      await hook(COMMAND).restart();
      const log = await container?.exec(["cat", "/tmp/hook.log"]);
      expect(log?.output.trim()).toBe("ran:");
    });

    it("reports a non-zero exit status as a failure", async () => {
      const failing = hook("/usr/local/bin/failing-game");
      await expect(failing.restart()).rejects.toMatchObject({
        code: "Failed",
      });
      // The failing script also ran, so nothing was appended to it.
      const log = await container?.exec(["cat", "/tmp/hook.log"]);
      expect(log?.output.trim()).toBe("ran:");
    });

    it("refuses to connect without a confirmed host key", async () => {
      await expect(hook(COMMAND, null).restart()).rejects.toMatchObject({
        code: "Refused",
      });
    });
  },
);

describe("SSH command hook in process (shape and host key)", () => {
  const options = {
    host: "127.0.0.1",
    port: 22,
    username: "dw",
    auth: { method: "password" as const, password: PASSWORD },
    pinnedFingerprint: null,
  };

  it("refuses a command that is not one bounded line", () => {
    expect(() => new SshCommand({ ...options, command: "" })).toThrowError(
      /not usable/,
    );
    expect(
      () => new SshCommand({ ...options, command: "two\nlines" }),
    ).toThrowError(/one line/);
    expect(
      () => new SshCommand({ ...options, command: "x".repeat(3_000) }),
    ).toThrowError(/not usable/);
  });

  // P10-A G3.1: a CR or a NUL ends the line too; the refusal is one line.
  it.each(["restart\rrm -rf /", "restart\0rm -rf /"])(
    "G3.1 refuses %j as a ControlError Refused",
    (command) => {
      let caught: unknown;
      try {
        new SshCommand({ ...options, command });
      } catch (error) {
        caught = error;
      }
      expect(isControlError(caught)).toBe(true);
      expect(caught).toMatchObject({ code: "Refused" });
      expect((caught as Error).message).not.toMatch(/[\r\n\0]/);
      expect((caught as Error).message).not.toContain("rm -rf");
    },
  );

  it("says unknown for its probe, because it cannot see the game", async () => {
    const probe = new SshCommand({ ...options, command: COMMAND });
    expect(await probe.probe()).toEqual({ state: "unknown" });
  });

  it("refuses a changed host key", async () => {
    const first = hostKeyPair();
    const second = hostKeyPair();
    const server = await startSshServer({
      hostKey: first,
      password: PASSWORD,
    });
    started.push(server);
    const control = new SshCommand({
      host: "127.0.0.1",
      port: server.port,
      username: "dw",
      auth: { method: "password", password: PASSWORD },
      pinnedFingerprint: second.fingerprint,
      command: COMMAND,
    });
    try {
      await control.restart();
      throw new Error("the hook unexpectedly ran");
    } catch (error) {
      expect(isControlError(error, "HostKey")).toBe(true);
      expect((error as Error).message).not.toContain(PASSWORD);
    }
  });

  it("sends the fixed command verbatim to the channel", async () => {
    const key = hostKeyPair();
    let seen = "";
    const execServer = new ssh2.Server(
      { hostKeys: [key.privateKey] },
      (client) => {
        client.on("error", () => undefined);
        client.on("authentication", (context) => {
          if (context.method === "password" && context.password === PASSWORD) {
            context.accept();
          } else {
            context.reject(["password"]);
          }
        });
        client.on("ready", () => {
          client.on("session", (accept) => {
            const channel = accept();
            channel.on("exec", (acceptExec, _reject, info) => {
              seen = info.command;
              const stream = acceptExec();
              stream.exit(0);
              stream.end();
            });
          });
        });
      },
    );
    await new Promise<void>((resolve) => {
      execServer.listen(0, "127.0.0.1", () => resolve());
    });
    started.push({
      close: () => {
        execServer.close();
        return Promise.resolve();
      },
    });
    const address = execServer.address() as AddressInfo;
    const control = new SshCommand({
      host: "127.0.0.1",
      port: address.port,
      username: "dw",
      auth: { method: "password", password: PASSWORD },
      pinnedFingerprint: key.fingerprint,
      command: COMMAND,
    });
    await control.restart();
    expect(seen).toBe(COMMAND);
  });
});
