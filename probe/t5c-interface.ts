export interface ParsedToken {
  payload: LicencePayload;
  /** The exact signed bytes. */
  payloadBytes: Buffer;
  signature: Buffer;
}
