import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testKeys } from "../test/testing.js";
import { keyFingerprint, loadKeyRing, parseSlot } from "./keys.js";
import { lidHash8, revocationHash } from "./revocation.js";

const pem = (key: KeyObject) =>
  key.export({ format: "pem", type: "spki" }).toString();

// The setup broker's development key (D5), committed in P1-C. Same value as the
// comment in keys/development-current.pub.
const DEVELOPMENT_CURRENT_FINGERPRINT =
  "699a4e45ae9178f62b0b0666284a6534a04319163fdaaad492dfcf691094ad07";

describe("key slots", () => {
  it("the committed slots hold the development key only", () => {
    // Production waits for Ruben (people dependency 5). The development
    // current slot holds the broker key; the next slot stays empty.
    const ring = loadKeyRing();
    expect(ring.production).toHaveLength(0);
    for (const key of ring.development) {
      expect(key.asymmetricKeyType).toBe("ed25519");
    }
    expect(ring.development.map((key) => keyFingerprint(key))).toEqual([
      DEVELOPMENT_CURRENT_FINGERPRINT,
    ]);
  });

  it("a comment-only slot is empty", () => {
    expect(parseSlot("# placeholder\n# nothing here\n")).toBeNull();
  });

  it("reads an Ed25519 public key with a fingerprint comment", () => {
    const key = testKeys.development.publicKey;
    const text = `# fingerprint ${keyFingerprint(key)}\n${pem(key)}`;
    const parsed = parseSlot(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.equals(key)).toBe(true);
  });

  it("refuses a key that is not Ed25519", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => parseSlot(pem(publicKey))).toThrow(/not Ed25519/);
  });

  it("refuses text that is not a key", () => {
    expect(() => parseSlot("not a key")).toThrow(/not a public key/);
  });

  it("test keys are never in the committed slots", () => {
    const committed = loadKeyRing();
    const all = [...committed.production, ...committed.development];
    for (const pair of Object.values(testKeys)) {
      expect(all.some((key) => key.equals(pair.publicKey))).toBe(false);
    }
  });
});

describe("revocation hashes", () => {
  it("salts the licence id", () => {
    const lid = "01JD0000000000000000000001";
    expect(revocationHash(lid)).toMatch(/^[0-9a-f]{64}$/);
    expect(revocationHash(lid)).not.toBe(lidHash8(lid));
    expect(revocationHash(lid)).not.toContain(lid);
  });
});
