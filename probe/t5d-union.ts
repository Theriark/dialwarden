export type ParseResult =
  | { ok: true; token: ParsedToken }
  | { ok: false; reason: string };
