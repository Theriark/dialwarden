// Host key fingerprints in the OpenSSH form, and the confirmed host keys
// (dev-work-plan P4-A step 2).
import { afterEach, describe, expect, it } from "vitest";
import { testApp, type TestApp } from "../../test/helpers.js";
import {
  algorithmOf,
  FINGERPRINT,
  fingerprintOf,
  hostKeyId,
  publicKeyFingerprint,
} from "./host-key.js";

// An ssh-ed25519 key blob with the bytes 0 to 31 as its key; the fingerprint
// was computed apart from this code (SHA-256, base64 without padding).
const BLOB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";
const EXPECTED = "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA";

describe("host key fingerprints", () => {
  it("match the OpenSSH SHA256 form", () => {
    const blob = Buffer.from(BLOB, "base64");
    expect(fingerprintOf(blob)).toBe(EXPECTED);
    expect(FINGERPRINT.test(EXPECTED)).toBe(true);
    expect(hostKeyId(blob)).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: EXPECTED,
    });
    expect(publicKeyFingerprint(`ssh-ed25519 ${BLOB} comment`)).toBe(EXPECTED);
  });

  it("name an unknown algorithm for a blob they cannot read", () => {
    expect(algorithmOf(new Uint8Array([0, 0]))).toBe("unknown");
    expect(algorithmOf(new Uint8Array([0, 0, 0, 200, 65]))).toBe("unknown");
    expect(algorithmOf(new Uint8Array([0, 0, 0, 2, 0x22, 0x3b]))).toBe(
      "unknown",
    );
  });

  it("refuse other fingerprint forms", () => {
    expect(FINGERPRINT.test("MD5:aa:bb")).toBe(false);
    expect(FINGERPRINT.test(`${EXPECTED}=`)).toBe(false);
    expect(FINGERPRINT.test(`SHA256:${"A".repeat(42)}`)).toBe(false);
  });
});

describe("confirmed host keys", () => {
  let current: TestApp | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("pin one key per host and port, and replace it", async () => {
    current = await testApp();
    const hosts = current.app.ctx.connectors.knownHosts;
    expect(hosts.get("game.example", 22)).toBeNull();
    const first = { algorithm: "ssh-ed25519", fingerprint: EXPECTED };
    hosts.pin("game.example", 22, first, "owner@dialwarden.test");
    expect(hosts.get("game.example", 22)).toMatchObject({
      ...first,
      confirmedBy: "owner@dialwarden.test",
    });
    expect(hosts.get("game.example", 2022)).toBeNull();
    const second = {
      algorithm: "ssh-rsa",
      fingerprint: `SHA256:${"B".repeat(43)}`,
    };
    hosts.pin("game.example", 22, second, null);
    expect(hosts.get("game.example", 22)).toMatchObject({
      ...second,
      confirmedBy: null,
    });
    const rows = current.app.ctx.store.sqlite
      .prepare("SELECT COUNT(*) AS n FROM known_hosts")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
