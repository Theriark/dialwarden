// Shared HTTP reading for the control clients (contract C7): the response
// body as text, refused when it is larger than the bound, so a control
// endpoint can never make the app read an unbounded stream.
import { ControlError } from "./types.js";

/** The response body, refused when it is larger than maxBytes. */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ControlError("Protocol", "the response is too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ControlError("Protocol", "the response has no body");
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ControlError("Protocol", "the response is too large");
    }
    parts.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(joined);
}
