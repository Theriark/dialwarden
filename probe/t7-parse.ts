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
