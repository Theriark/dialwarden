export function b(parsed: P, payloadBytes: B, signature: B) {
  return { ok: true, token: { payload: parsed.data, payloadBytes, signature } };
}
