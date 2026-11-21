export type LicencePayload = z.infer<typeof licencePayloadSchema>;
export type LicenceKind = LicencePayload["kind"];

export interface ParsedToken {
  payload: LicencePayload;
  /** The exact signed bytes. */
  payloadBytes: Buffer;
  signature: Buffer;
}

export type ParseResult =
  | { ok: true; token: ParsedToken }
  | { ok: false; reason: string };
