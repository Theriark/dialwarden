// tools/licence (dev-work-plan P1-A step 8). Every key here is generated when
// the test runs; no real key is ever used.
/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  evaluateLicence,
  keyFingerprint,
  lidHash8 as appLidHash8,
  parseToken,
  revocationHash as appRevocationHash,
} from "@dialwarden/entitlement";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import {
  buildPayload,
  inspectLicence,
  lidHash8,
  newKeyPair,
  newLid,
  readPrivateKey,
  readPublicKey,
  revocationHash,
  signLicence,
} from "./lib.mjs";

const build = {
  buildDate: new Date("2026-11-21T07:00:00Z"),
  featureBaseline: new Date("2026-11-21T07:00:00Z"),
};
const folders = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

function payload(overrides = {}) {
  return buildPayload({
    kind: "customer",
    customerId: "cus-tool",
    customerName: "Tool Test",
    updatesUntil: "2027-11-30",
    issuedAt: "2026-11-21T08:00:00Z",
    ...overrides,
  });
}

function capture() {
  const chunks = [];
  const sink = {
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
  };
  return {
    stdout: sink,
    stderr: sink,
    stdin: Readable.from([]),
    text: () => chunks.join(""),
  };
}

describe("licence tool library", () => {
  it("issues a customer licence the app accepts with a production key only", () => {
    const pair = newKeyPair();
    const signed = payload({ maxServers: "25" });
    const token = signLicence(signed, readPrivateKey(pair.privatePem));
    expect(parseToken(token).ok).toBe(true);
    const key = readPublicKey(pair.publicPem);
    const production = { production: [key], development: [] };
    const active = evaluateLicence(token, { keys: production, build });
    expect(active.state).toBe("active");
    expect(active.payload?.maxServers).toBe(25);
    const development = { production: [], development: [key] };
    const wrong = evaluateLicence(token, { keys: development, build });
    expect(wrong.state).toBe("invalid_signature");
  });

  it("issues an internal-dev licence the app accepts with a development key", () => {
    const pair = newKeyPair();
    const signed = payload({
      kind: "internal-dev",
      customerId: "theriark-dev",
      customerName: "Theriark Development",
    });
    const token = signLicence(signed, readPrivateKey(pair.privatePem));
    const key = readPublicKey(pair.publicPem);
    const ring = { production: [], development: [key] };
    expect(evaluateLicence(token, { keys: ring, build }).state).toBe("active");
  });

  it("uses the app's fingerprint, lid hash and revocation hash", () => {
    const pair = newKeyPair();
    const key = readPublicKey(pair.publicPem);
    expect(pair.fingerprint).toBe(keyFingerprint(key));
    const lid = newLid();
    expect(lid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lidHash8(lid)).toBe(appLidHash8(lid));
    expect(revocationHash(lid)).toBe(appRevocationHash(lid));
    expect(newLid(1_000) < newLid(2_000)).toBe(true);
  });

  it("refuses a payload the app would refuse", () => {
    expect(() => payload({ kind: "trial" })).toThrow(/kind/);
    expect(() => payload({ customerName: "x".repeat(65) })).toThrow(
      /customer-name/,
    );
    expect(() => payload({ customerName: "bell\u0007" })).toThrow(
      /customer-name/,
    );
    expect(() => payload({ updatesUntil: "2027-02-30" })).toThrow(
      /updates-until/,
    );
    expect(() => payload({ maxServers: "0" })).toThrow(/max-servers/);
    expect(() => payload({ issuedAt: "yesterday" })).toThrow(/issued-at/);
  });

  it("inspect checks the signature and never shows the token or the lid", () => {
    const pair = newKeyPair();
    const signed = payload();
    const token = signLicence(signed, readPrivateKey(pair.privatePem));
    const key = readPublicKey(pair.publicPem);
    const summary = inspectLicence(token, key);
    expect(summary).toMatchObject({
      signature: "valid",
      kind: "customer",
      customerName: "Tool Test",
      lidHash8: lidHash8(signed.lid),
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain(signed.lid);
    expect(text).not.toContain(token.split(".")[1]);

    const [prefix, , signature] = token.split(".");
    const changed = { ...signed, customer: { id: "cus-tool", name: "Other" } };
    const body = Buffer.from(JSON.stringify(changed)).toString("base64url");
    const tampered = [prefix, body, signature].join(".");
    expect(inspectLicence(tampered, key).signature).toBe("invalid");
    const stranger = readPublicKey(newKeyPair().publicPem);
    expect(inspectLicence(token, stranger).signature).toBe("invalid");
    expect(inspectLicence("DW1.abc", key).signature).toBe("malformed");
  });
});

describe("licence CLI", () => {
  it("makes throwaway keys, issues to a file and verifies, printing no token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dialwarden-licence-"));
    folders.push(dir);
    const io = capture();
    const keys = join(dir, "keys");
    expect(await main(["test-keygen", "--out", keys], io)).toBe(0);
    const privateFile = join(keys, "test-private.pem");
    expect((await stat(privateFile)).mode & 0o777).toBe(0o600);

    const tokenFile = join(dir, "licence.txt");
    const issued = await main(
      [
        "issue",
        "--private-key",
        privateFile,
        "--kind",
        "internal-dev",
        "--customer-id",
        "theriark-dev",
        "--customer-name",
        "Theriark Development",
        "--updates-until",
        "2027-01-20",
        "--out",
        tokenFile,
      ],
      io,
    );
    expect(issued).toBe(0);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    const token = (await readFile(tokenFile, "utf8")).trim();
    expect(parseToken(token).ok).toBe(true);

    const publicFile = join(keys, "test-public.pem");
    const verify = ["verify", "--public-key", publicFile];
    expect(await main([...verify, "--token-file", tokenFile], io)).toBe(0);
    expect(io.text()).toContain('"signature": "valid"');
    expect(io.text()).not.toContain(token);
  });

  it("refuses to write test keys into the key slot folder", async () => {
    const io = capture();
    const slots = fileURLToPath(
      new URL("../../../packages/entitlement/keys", import.meta.url),
    );
    expect(await main(["test-keygen", "--out", slots], io)).toBe(2);
    expect(existsSync(join(slots, "test-private.pem"))).toBe(false);
    expect(io.text()).toContain("key slot folder");
  });

  it("prints usage for an unknown command or option", async () => {
    expect(await main(["sign"], capture())).toBe(2);
    expect(await main(["verify", "--token", "x"], capture())).toBe(2);
  });
});
