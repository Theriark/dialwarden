// TOTP (RFC 6238 with RFC 4226 HOTP): SHA-1, 6 digits, 30-second steps, one
// step of clock drift either way. A step that was used once is refused again
// (replay protection through users.totp_last_step).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_DRIFT_STEPS = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("not base32");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Checks a code. Returns the matched step, or null. Steps at or before
 * lastStep are refused, so one code works once.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return null;
  }
  const secret = base32Decode(secretBase32);
  const current = totpStep(now);
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    if (lastStep !== null && step <= lastStep) {
      continue;
    }
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits))) {
      return step;
    }
  }
  return null;
}

/** The otpauth URI an authenticator app reads (the web app draws the QR code). */
export function otpauthUri(
  secretBase32: string,
  account: string,
  issuer = "Dialwarden",
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten recovery codes such as k7d2q-9xw4m (50 bits each, no modulo bias). */
export function newRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz023456789";
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = [...bytes].map((byte) => alphabet.charAt(byte & 31));
    return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
  });
}

export function normaliseRecoveryCode(input: string): string {
  return input.trim().toLowerCase().replace(/\s/g, "");
}
