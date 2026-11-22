// Encryption at rest (security review THE-2134 L3, threat tests T7; code
// review M6; test review F12): fixed IV and tag lengths, the column name as
// associated data, and the key id.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAead, KeyMismatchError } from "./aead.js";

const CONTEXT = "users.totp_secret";

/** Replaces one dot-separated part of an encrypted value. */
function withPart(value: string, index: number, part: Buffer): string {
  const parts = value.split(".");
  parts.splice(index, 1, part.toString("base64url"));
  return parts.join(".");
}

describe("aead", () => {
  it("round-trips a value under its context", () => {
    const aead = createAead(randomBytes(32));
    const value = aead.encrypt("synthetic secret", CONTEXT);
    expect(value.startsWith(`dwenc1.${aead.kid}.`)).toBe(true);
    expect(aead.decryptText(value, CONTEXT)).toBe("synthetic secret");
  });

  it("refuses a value whose GCM tag was cut to 4 bytes", () => {
    const aead = createAead(randomBytes(32));
    const value = aead.encrypt("synthetic secret", CONTEXT);
    const tag = Buffer.from(value.split(".")[4] ?? "", "base64url");
    const short = withPart(value, 4, tag.subarray(0, 4));
    expect(() => aead.decrypt(short, CONTEXT)).toThrow();
  });

  it("refuses an IV that is not 12 bytes", () => {
    const aead = createAead(randomBytes(32));
    const value = aead.encrypt("synthetic secret", CONTEXT);
    const long = withPart(value, 2, randomBytes(16));
    expect(() => aead.decrypt(long, CONTEXT)).toThrow();
  });

  it("does not decrypt under another column's context", () => {
    const aead = createAead(randomBytes(32));
    const value = aead.encrypt("synthetic secret", CONTEXT);
    expect(() => aead.decrypt(value, "licence.token")).toThrow();
  });

  it("names the key: another key gives KeyMismatchError", () => {
    const value = createAead(randomBytes(32)).encrypt("x", CONTEXT);
    const other = createAead(randomBytes(32));
    expect(() => other.decrypt(value, CONTEXT)).toThrow(KeyMismatchError);
    // A key id of 8 characters but more bytes is refused cleanly.
    const parts = value.split(".");
    parts[1] = "é".repeat(8);
    const multiByte = parts.join(".");
    expect(() => other.decrypt(multiByte, CONTEXT)).toThrow(
      /not an encrypted value/,
    );
  });
});
