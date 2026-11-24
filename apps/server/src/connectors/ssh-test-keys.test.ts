// The host keys of the test SSH server (test/ssh-server.ts). ssh2's Ed25519
// generator now and then wrote a private key its own parser refuses, which
// failed threat test T6 once (push CI run 45302896324, "Cannot parse
// privateKey: Malformed OpenSSH private key"). hostKeyPair returns only keys
// ssh2 parses back, and gives up after a few bad ones. Every key is made
// when the test runs.
import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";
import {
  HOST_KEY_ATTEMPTS,
  hostKeyPair,
  parsesBack,
  usablePair,
  type GeneratedPair,
} from "../../test/ssh-server.js";
import { FINGERPRINT } from "./host-key.js";

/** How many host keys the first test makes and parses back. */
const PAIRS = 2000;

/** A copy of a pair whose private key lost one line of its base64 body. */
function damaged(pair: GeneratedPair): GeneratedPair {
  const lines = pair.private.split("\n");
  lines.splice(2, 1);
  return { private: lines.join("\n"), public: pair.public };
}

describe("test SSH host keys", () => {
  it("are all accepted by ssh2.Server, each with its own fingerprint", () => {
    const seen = new Set<string>();
    for (let index = 0; index < PAIRS; index += 1) {
      const pair = hostKeyPair();
      const parsed = ssh2.utils.parseKey(pair.privateKey);
      if (parsed instanceof Error) throw parsed;
      expect(parsed.type).toBe("ssh-ed25519");
      expect(pair.fingerprint).toMatch(FINGERPRINT);
      // The call that threw in run 45302896324; it parses the host key
      // without listening.
      const start = () => new ssh2.Server({ hostKeys: [pair.privateKey] });
      expect(start).not.toThrow();
      seen.add(pair.fingerprint);
    }
    expect(seen.size).toBe(PAIRS);
  });

  it("makes a key again when ssh2 cannot parse one, a few times at most", () => {
    const good = usablePair();
    const broken = damaged(good);
    expect(parsesBack(good)).toBe(true);
    expect(parsesBack(broken)).toBe(false);

    const queue = [broken, broken, good];
    const pair = hostKeyPair(() => queue.shift() ?? broken);
    expect(queue).toEqual([]);
    expect(pair.privateKey).toBe(good.private);

    let calls = 0;
    const never = () => {
      calls += 1;
      return broken;
    };
    const message = `no usable host key in ${HOST_KEY_ATTEMPTS} attempts`;
    expect(() => hostKeyPair(never)).toThrow(message);
    expect(calls).toBe(HOST_KEY_ATTEMPTS);
  });

  it("refuses a private key that does not belong to its public key", () => {
    const one = usablePair();
    const other = usablePair();
    const mixed = { private: one.private, public: other.public };
    expect(parsesBack(mixed)).toBe(false);
  });
});
