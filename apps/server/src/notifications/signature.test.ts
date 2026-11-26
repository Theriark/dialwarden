// The webhook HMAC signature (P9-B): t=<seconds>,v1=<hex HMAC-SHA256 of
// "<t>.<body>">; the receiver's check refuses a changed body, another
// secret, a time outside 5 minutes and a malformed header.
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE_TOLERANCE_S,
  signatureHeader,
  verifySignature,
} from "./signature.js";

const secret = () => randomBytes(24).toString("base64url");
const BODY = JSON.stringify({ version: 1, title: "Change applied" });
const T = 1_795_244_400;

describe("webhook signature", () => {
  it("is the HMAC-SHA256 of t.body in hex", () => {
    const key = secret();
    const header = signatureHeader(key, BODY, T);
    const expected = createHmac("sha256", key)
      .update(`${String(T)}.${BODY}`)
      .digest("hex");
    expect(header).toBe(`t=${String(T)},v1=${expected}`);
  });

  it("verifies its own header within the tolerance", () => {
    const key = secret();
    const header = signatureHeader(key, BODY, T);
    expect(verifySignature(key, BODY, header, T)).toBe(true);
    expect(verifySignature(key, BODY, header, T + SIGNATURE_TOLERANCE_S)).toBe(
      true,
    );
    expect(verifySignature(key, BODY, header, T - SIGNATURE_TOLERANCE_S)).toBe(
      true,
    );
  });

  it("refuses a changed body, another secret and an old or future time", () => {
    const key = secret();
    const header = signatureHeader(key, BODY, T);
    expect(verifySignature(key, `${BODY} `, header, T)).toBe(false);
    expect(verifySignature(secret(), BODY, header, T)).toBe(false);
    const late = T + SIGNATURE_TOLERANCE_S + 1;
    expect(verifySignature(key, BODY, header, late)).toBe(false);
    const early = T - SIGNATURE_TOLERANCE_S - 1;
    expect(verifySignature(key, BODY, header, early)).toBe(false);
  });

  it("refuses malformed headers", () => {
    const key = secret();
    const good = signatureHeader(key, BODY, T);
    const malformed = [
      "",
      "v1=abc",
      good.toUpperCase(),
      good.replace("t=", "t= "),
      `${good},v0=00`,
      good.slice(0, -2),
    ];
    for (const header of malformed) {
      expect(verifySignature(key, BODY, header, T), header).toBe(false);
    }
  });
});
