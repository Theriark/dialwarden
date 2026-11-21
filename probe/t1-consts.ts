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

export { z, ULID, ISO_INSTANT, ISO_DATE, BASE64URL };
