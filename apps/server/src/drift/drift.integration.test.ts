// Background drift detection on an SFTP server (dev-work-plan P9-A tests):
// a Palworld server folder on a real OpenSSH server in a testcontainer,
// added through the API with the instance key, and an edit made on that
// host outside the app. The background check finds it as its own history
// entry of cause external and writes drift.detected (via background).
//
// The container is Alpine with the distribution's OpenSSH, started from this
// test; every credential is generated when the test runs. Without Docker the
// suite is skipped locally; in CI (CI=true) it always runs.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headersOf, setupOwner } from "../../test/helpers.js";
import {
  activityOf,
  apiOf,
  history,
  PALWORLD_SETTINGS,
} from "../../test/servers.js";
import { paidApp } from "../../test/team.js";
import { fingerprintOf } from "../connectors/host-key.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the repository's pack fixtures */

const IMAGE = "alpine:3.20";
const PORT = 2222;
const USER = "dw";
const ROOT = "/srv/pal";
const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const FIXTURES = `${PACKS}palworld/fixtures/`;
const START = Date.parse("2026-12-01T10:00:00.000Z");
const MINUTE = 60_000;

const dockerAvailable =
  existsSync("/var/run/docker.sock") ||
  (process.env["DOCKER_HOST"] ?? "") !== "" ||
  process.env["CI"] === "true";

// Runs as root in the container: OpenSSH from the distribution, one user
// with a generated password (an Alpine account without one is locked, and
// sshd refuses even its keys; the app logs in with the instance key the test
// adds) and a Palworld server folder made from the pack's synthetic
// fixtures.
const SETUP = `
set -eu
apk add --no-cache openssh-server openssh-sftp-server >/dev/null
adduser -D -s /bin/sh ${USER}
echo "${USER}:$DW_PASSWORD" | chpasswd
mkdir -p /home/${USER}/.ssh ${ROOT}/Pal/Saved/Config/LinuxServer
touch /home/${USER}/.ssh/authorized_keys
cp /setup/PalWorldSettings.ini ${ROOT}/${PALWORLD_SETTINGS}
cp /setup/dialwarden-args.txt ${ROOT}/dialwarden-args.txt
printf '#!/bin/sh\\n' > ${ROOT}/PalServer.sh
chown -R ${USER}:${USER} /home/${USER} ${ROOT}
chmod 700 /home/${USER}/.ssh
chmod 600 /home/${USER}/.ssh/authorized_keys
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e -p ${PORT} -o PermitRootLogin=no
`;

let container: StartedTestContainer;
let host: string;
let port: number;
let fingerprint: string;

/** The fingerprint the container's sshd presents. */
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

async function shell(script: string): Promise<string> {
  const result = await container.exec(["sh", "-c", script]);
  if (result.exitCode !== 0) {
    throw new Error(`container command failed: ${result.output}`);
  }
  return result.output.trim();
}

describe.skipIf(!dockerAvailable)("background drift checks over SFTP", () => {
  beforeAll(async () => {
    const { GenericContainer, Wait } = await import("testcontainers");
    const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`);
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ DW_PASSWORD: randomBytes(18).toString("base64url") })
      .withCopyContentToContainer([
        {
          content: fixture("PalWorldSettings.ini"),
          target: "/setup/PalWorldSettings.ini",
        },
        {
          content: fixture("dialwarden-args.txt"),
          target: "/setup/dialwarden-args.txt",
        },
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
    await container?.stop();
  }, 60_000);

  it("finds an outside edit on the host as an external entry", async () => {
    let clock = START;
    const instance = await paidApp({
      config: { packsDir: PACKS },
      now: () => new Date(clock),
    });
    try {
      const { app } = instance;
      const owner = await setupOwner(app);
      const headers = headersOf(owner);
      const api = apiOf(app, owner);
      const key = await api.get("/api/v1/connectors/ssh-key");
      const { publicKey } = key.json<{ publicKey: string }>();
      await shell(`echo '${publicKey}' >> /home/${USER}/.ssh/authorized_keys`);
      const pinned = await app.inject({
        method: "POST",
        url: "/api/v1/connectors/host-keys",
        headers,
        payload: { host, port, fingerprint },
      });
      expect(pinned.statusCode).toBe(200);
      const connector = {
        kind: "sftp",
        host,
        port,
        username: USER,
        root: ROOT,
      };
      const added = await api.post("/api/v1/servers", {
        name: "SFTP Pal",
        packId: "palworld",
        os: "linux",
        connector,
      });
      expect(added.statusCode, added.body).toBe(201);
      const slug = added.json<{ id: string }>().id;

      await app.ctx.drift.tick();
      expect(app.ctx.drift.get(slug)).toMatchObject({ lastResult: "clean" });

      await shell(
        `sed -i 's/ServerPlayerMaxNum=32/ServerPlayerMaxNum=11/' ${ROOT}/${PALWORLD_SETTINGS}`,
      );
      clock = START + 15 * MINUTE;
      await app.ctx.drift.tick();
      const view = app.ctx.drift.get(slug);
      expect(view).toMatchObject({ lastResult: "drift", lastError: null });

      const events = (await activityOf(api, slug)).filter(
        (row) => row.type === "drift.detected",
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({
        changeSetId: view.lastChangeSetId,
        via: "background",
      });
      const entry = (await history(api, slug)).entries.find(
        (item) => item.changeSetId === view.lastChangeSetId,
      );
      expect(entry).toMatchObject({ cause: "external" });
      expect(entry?.snapshots.map((snapshot) => snapshot.kind)).toContain(
        "external",
      );
    } finally {
      await instance.close();
    }
  }, 120_000);
});
