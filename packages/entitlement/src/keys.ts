// Public keys that verify licence signatures (dev-work-plan P1-A step 4).
//
// Slots, read from packages/entitlement/keys/ (shipped in the image with the
// package):
// - production.pub: the production key. A placeholder until Ruben posts the
//   production public key (people dependency 5); a placeholder verifies nothing.
// - development-current.pub and development-next.pub: the development keys of
//   the setup broker (empty until D5, people dependency 4; P1-C commits the key).
//
// A slot file holds one Ed25519 public key in SPKI PEM form. Lines starting
// with # are comments (the fingerprint goes there). A file with no PEM block is
// an empty slot. Test keys never come from here: tests build their own KeyRing
// and pass it in (vitest setup), so no test key reaches the image.
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export interface KeyRing {
  /** Keys that verify customer licences. */
  production: readonly KeyObject[];
  /** Keys that verify internal-dev licences. */
  development: readonly KeyObject[];
}

export const KEY_SLOTS = {
  production: ["production.pub"],
  development: ["development-current.pub", "development-next.pub"],
} as const;

const PEM_BLOCK =
  /-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/;

/**
 * Parses one slot file. Returns null for an empty slot (comments only) and
 * throws when the file holds something that is not an Ed25519 public key.
 */
export function parseSlot(text: string): KeyObject | null {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const match = PEM_BLOCK.exec(body);
  if (match === null) {
    if (body.trim() !== "") {
      throw new Error("key slot holds text that is not a public key block");
    }
    return null;
  }
  const key = createPublicKey({ key: match[0], format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("key slot holds a key that is not Ed25519");
  }
  return key;
}

/** SHA-256 of the SPKI DER encoding, hex, as written in the slot comments. */
export function keyFingerprint(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

function readSlot(dir: URL, name: string): KeyObject | null {
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed slot names in the package folder
    text = readFileSync(new URL(name, dir), "utf8");
  } catch {
    return null;
  }
  return parseSlot(text);
}

/** The compiled-in key ring of this build. */
export function loadKeyRing(
  dir: URL = new URL("../keys/", import.meta.url),
): KeyRing {
  const load = (names: readonly string[]) =>
    names
      .map((name) => readSlot(dir, name))
      .filter((key): key is KeyObject => key !== null);
  return {
    production: load(KEY_SLOTS.production),
    development: load(KEY_SLOTS.development),
  };
}

/** A key ring with no keys: every signature is invalid. */
export const EMPTY_KEY_RING: KeyRing = { production: [], development: [] };
