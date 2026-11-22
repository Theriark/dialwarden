// Licence token format (dev-work-plan P1-A step 4): DW1.payload.signature, both
// parts base64url without padding. The signature is Ed25519 over the decoded
// payload bytes (the exact JSON the issuer signed), as the setup broker's
// development signer and tools/licence do.
import { z } from "zod";

export const TOKEN_PREFIX = "DW1";

/** Longest token accepted anywhere (the API, the environment, the CLI). */
export const MAX_TOKEN_LENGTH = 4096;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d|\.\d\d|\.\d\d\d)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** True when the text has no control character (C0, DEL or C1). */
function printable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function realInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/** A calendar date that exists (2026-02-30 is refused). */
function realDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(printable, { message: "control characters are not allowed" });

/**
 * The licence payload. The customer name is chosen by the buyer (at most 64
 * characters, legal-input-1 5); it is never a legal name or an e-mail address
 * collected without consent. Unknown fields are ignored (stripped).
 */
export const licencePayloadSchema = z.object({
  v: z.literal(1),
  lid: z.string().regex(ULID),
  plan: z.literal("paid"),
  maxServers: z.number().int().min(1).max(10000).optional(),
  customer: z.object({
    id: text(64),
    name: text(64),
  }),
  issuedAt: z.string().refine(realInstant, { message: "not an ISO instant" }),
  updatesUntil: z.string().refine(realDate, { message: "not a date" }),
  kind: z.enum(["customer", "internal-dev"]),
  features: z.array(text(64)).max(64).optional(),
});

export type LicencePayload = z.infer<typeof licencePayloadSchema>;
export type LicenceKind = LicencePayload["kind"];

export interface ParsedToken {
  payload: LicencePayload;
  /** The exact signed bytes. */
  payloadBytes: Buffer;
  signature: Buffer;
}

export interface ParseSuccess {
  ok: true;
  token: ParsedToken;
}

export interface ParseFailure {
  ok: false;
  reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Strict base64url: the text must re-encode to itself (no padding, no slack bits). */
function decodeBase64Url(part: string): Buffer | null {
  if (!BASE64URL.test(part)) {
    return null;
  }
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

/** Parses a token without checking its signature. Never throws. */
export function parseToken(input: string): ParseResult {
  const value = input.trim();
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "length" };
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "format" };
  }
  const [prefix, payloadPart, signaturePart] = parts;
  if (prefix !== TOKEN_PREFIX) {
    return { ok: false, reason: "prefix" };
  }
  const payloadBytes = decodeBase64Url(payloadPart ?? "");
  const signature = decodeBase64Url(signaturePart ?? "");
  if (payloadBytes === null || signature === null) {
    return { ok: false, reason: "encoding" };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: "signature_length" };
  }
  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "json" };
  }
  const parsed = licencePayloadSchema.safeParse(json);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "";
    return { ok: false, reason: field === "" ? "payload" : `payload.${field}` };
  }
  return { ok: true, token: { payload: parsed.data, payloadBytes, signature } };
}

/** The last 6 characters of the trimmed token, the only token text the API shows. */
export function tokenLast6(input: string): string {
  return input.trim().slice(-6);
}
