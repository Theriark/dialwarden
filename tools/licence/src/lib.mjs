// Licence tool library (dev-work-plan P1-A step 8). Plain JavaScript with no
// dependencies, so the operator runs it with node alone. It never ships in the
// image (tools/ is excluded), and the crew never runs issue with a real key.
// The token format and checks match packages/entitlement/src/token.ts.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const TOKEN_PREFIX = "DW1";
export const KINDS = ["customer", "internal-dev"];
export const REVOCATION_SALT = "dialwarden-revocation-v1";
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class LicenceToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "LicenceToolError";
  }
}

/** A new ULID: 48-bit time in milliseconds, then 80 random bits. */
export function newLid(now = Date.now()) {
  let time = "";
  let rest = now;
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  const random = [...randomBytes(16)]
    .map((byte) => ULID_ALPHABET.charAt(byte & 31))
    .join("");
  return time + random;
}

/** SHA-256 of the SPKI DER encoding, hex: the fingerprint in the slot comments. */
export function fingerprint(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

/** A throwaway Ed25519 key pair in PEM form. */
export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    fingerprint: fingerprint(publicKey),
  };
}

/** An Ed25519 public key from PEM text; # comment lines are ignored. */
export function readPublicKey(pem) {
  const body = pem
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const key = createPublicKey({ key: body, format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new LicenceToolError("the public key is not an Ed25519 key");
  }
  return key;
}

export function readPrivateKey(pem) {
  const key = createPrivateKey({ key: pem, format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new LicenceToolError("the private key is not an Ed25519 key");
  }
  return key;
}

/** True when the text has no control character (C0, DEL or C1). */
function printable(text) {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

/** A calendar date that exists (2026-02-30 is refused). */
function realDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function text64(name, value) {
  const ok =
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    printable(value);
  if (!ok) {
    throw new LicenceToolError(`${name} must be 1 to 64 printable characters`);
  }
  return value;
}

/**
 * Builds and checks a payload (contract C1, token.ts). The customer name is
 * chosen by the buyer, at most 64 characters, never a legal name or an e-mail
 * address collected without consent (legal-input-1 5).
 */
export function buildPayload(options) {
  if (!KINDS.includes(options.kind)) {
    throw new LicenceToolError("kind must be customer or internal-dev");
  }
  if (!realDate(options.updatesUntil)) {
    throw new LicenceToolError("updates-until must be a date like 2027-11-30");
  }
  const issuedAt =
    options.issuedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!ISO_INSTANT.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) {
    throw new LicenceToolError("issued-at must be an ISO instant in UTC");
  }
  const lid = options.lid ?? newLid();
  if (!ULID.test(lid)) {
    throw new LicenceToolError("lid must be a ULID");
  }
  const payload = { v: 1, lid, plan: "paid" };
  if (options.maxServers !== undefined) {
    const max = Number(options.maxServers);
    if (!Number.isInteger(max) || max < 1 || max > 10000) {
      throw new LicenceToolError("max-servers must be a whole number 1-10000");
    }
    payload.maxServers = max;
  }
  payload.customer = {
    id: text64("customer-id", options.customerId),
    name: text64("customer-name", options.customerName),
  };
  payload.issuedAt = issuedAt;
  payload.updatesUntil = options.updatesUntil;
  payload.kind = options.kind;
  return payload;
}

/** Signs a payload: Ed25519 over the exact JSON bytes, as token.ts expects. */
export function signLicence(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, bytes, privateKey);
  const parts = [bytes, signature].map((part) => part.toString("base64url"));
  return [TOKEN_PREFIX, ...parts].join(".");
}

export function revocationHash(lid) {
  return createHash("sha256")
    .update(`${REVOCATION_SALT}:${lid}`, "utf8")
    .digest("hex");
}

/** First 8 hex characters of sha256(lid): the only lid form ever printed. */
export function lidHash8(lid) {
  return createHash("sha256").update(lid, "utf8").digest("hex").slice(0, 8);
}

/**
 * Checks a token's signature with one public key. The summary never holds the
 * token or the licence id (only lidHash8). Dates and the CRA-safe rule are the
 * app's job; this checks the signature only.
 */
export function inspectLicence(token, publicKey) {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { signature: "malformed" };
  }
  const bytes = Buffer.from(parts[1] ?? "", "base64url");
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { signature: "malformed" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { signature: "malformed" };
  }
  let valid = false;
  try {
    valid = signature.length === 64 && verify(null, bytes, publicKey, signature);
  } catch {
    valid = false;
  }
  return {
    signature: valid ? "valid" : "invalid",
    kind: payload.kind ?? null,
    customerName: payload.customer?.name ?? null,
    issuedAt: payload.issuedAt ?? null,
    updatesUntil: payload.updatesUntil ?? null,
    maxServers: payload.maxServers ?? null,
    lidHash8: typeof payload.lid === "string" ? lidHash8(payload.lid) : null,
  };
}
