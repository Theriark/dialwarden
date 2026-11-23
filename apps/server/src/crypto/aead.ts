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
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ID = /^[0-9a-f]{8}$/;

export class KeyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly found: string,
  ) {
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
    const [, found = "", ivText = "", data = "", tagText = ""] = parts;
    if (!KEY_ID.test(found)) {
      throw new Error("not an encrypted value");
    }
    if (!timingSafeEqual(Buffer.from(found), Buffer.from(kid))) {
      throw new KeyMismatchError(kid, found);
    }
    // Fixed lengths: a short GCM tag would make a forgery far cheaper.
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error("not an encrypted value");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]);
  };
  return {
    kid,
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_LENGTH,
      });
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
  { table: "users", column: "recovery_key_enc", context: "users.recovery_key" },
  {
    table: "instance_ssh_key",
    column: "private_key_enc",
    context: "instance_ssh_key.private_key",
  },
  { table: "servers", column: "password_enc", context: "servers.password" },
  {
    table: "change_sets",
    column: "payload_enc",
    context: "change_sets.payload",
  },
] as const;
