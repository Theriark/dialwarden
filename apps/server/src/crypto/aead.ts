// Encryption of secrets at rest (dev-work-plan P1-A step 3): AES-256-GCM with
// a key id. Text form: dwenc1.KID.IV.CIPHERTEXT.TAG (base64url parts), where KID
// is 8 hex characters derived from the key. The associated data names the
// column (for example "licence.token"), so a value copied into another column
// does not decrypt.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = "dwenc1";

export class KeyMismatchError extends Error {
  constructor(readonly expected: string, readonly found: string) {
    super(`value was encrypted with key ${found}, not ${expected}`);
    this.name = "KeyMismatchError";
  }
}

export function keyId(key: Buffer): string {
  return createHash("sha256")
    .update("dialwarden-key-id:")
    .update(key)
    .digest("hex")
    .slice(0, 8);
}

export interface Aead {
  readonly kid: string;
  encrypt(plaintext: string | Buffer, context: string): string;
  decrypt(value: string, context: string): Buffer;
  decryptText(value: string, context: string): string;
}

export function createAead(key: Buffer): Aead {
  if (key.length !== 32) {
    throw new Error("the encryption key must be 32 bytes");
  }
  const kid = keyId(key);
  const decrypt = (value: string, context: string): Buffer => {
    const parts = value.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new Error("not an encrypted value");
    }
    const [, found = "", iv = "", data = "", tag = ""] = parts;
    if (
      found.length !== kid.length ||
      !timingSafeEqual(Buffer.from(found), Buffer.from(kid))
    ) {
      throw new KeyMismatchError(kid, found);
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]);
  };
  return {
    kid,
    encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [
        VERSION,
        kid,
        iv.toString("base64url"),
        data.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    decrypt,
    decryptText(value, context) {
      return decrypt(value, context).toString("utf8");
    },
  };
}

/** The key id an encrypted value names, or null when it is not one. */
export function encryptedKeyId(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    return null;
  }
  return parts[1] ?? null;
}

/**
 * Every encrypted column, with its associated data. Later phases add theirs
 * (for example the SFTP key pair in P4). The import of an app backup re-encrypts
 * these columns when the backup came from an instance with another key, and the
 * restore drill decrypts one of them.
 */
export const ENCRYPTED_COLUMNS = [
  { table: "licence", column: "token_enc", context: "licence.token" },
  { table: "users", column: "totp_secret_enc", context: "users.totp_secret" },
  { table: "users", column: "totp_pending_enc", context: "users.totp_pending" },
] as const;
