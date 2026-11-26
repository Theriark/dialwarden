// The HMAC signature of the generic webhook channel (P9-B). With a signing
// secret set on the channel, every request carries
//   X-Dialwarden-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
// where the HMAC is over "<t>.<raw body>" with the secret as the key. The
// receiver recomputes it over the exact bytes it received, compares in
// constant time and refuses a time more than 5 minutes away from its clock,
// so a captured request cannot be replayed later. verifySignature is the
// reference check (and what the tests use).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-dialwarden-signature";
/** The receiver's window for t, either side of its clock. */
export const SIGNATURE_TOLERANCE_S = 300;

const HEADER = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

function hmacOf(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${String(timestamp)}.`, "utf8")
    .update(body, "utf8")
    .digest("hex");
}

/** The header value for a body sent at the given unix time (seconds). */
export function signatureHeader(
  secret: string,
  body: string,
  timestamp: number,
): string {
  return `t=${String(timestamp)},v1=${hmacOf(secret, timestamp, body)}`;
}

/**
 * True when the header is a valid signature of the body under the secret
 * and its time is within the tolerance of now (unix seconds).
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  now: number,
  tolerance = SIGNATURE_TOLERANCE_S,
): boolean {
  const match = HEADER.exec(header);
  if (match === null) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = Buffer.from(hmacOf(secret, timestamp, body), "hex");
  const given = Buffer.from(match[2] ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
