// pino options (dev-work-plan P1-A step 1): request ids, and redaction of
// authorization, cookies, passwords, tokens, licences and every secret field.
// Request bodies are never logged; the redaction also covers objects the code
// logs on purpose, up to three levels deep. Logged errors keep their name,
// code and stack, but database query parameters are cut from the message.
import type { FastifyServerOptions } from "fastify";

const SECRET_FIELDS = [
  "authorization",
  "cookie",
  "password",
  "currentPassword",
  "newPassword",
  "passwordHash",
  "password_hash",
  "token",
  "tokenEnc",
  "token_enc",
  "licence",
  "envLicence",
  "passphrase",
  "secret",
  "totpSecret",
  "totpSecretEnc",
  "totp_secret_enc",
  "totpPendingEnc",
  "totp_pending_enc",
  "recoveryKeyEnc",
  "recovery_key_enc",
  "recoveryCode",
  "recoveryCodes",
  "csrfToken",
  "csrf_token",
  "challenge",
  "appKey",
  "appSecretKey",
  "sessionSecret",
  "key",
];

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'req.headers["x-dialwarden-passphrase"]',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
  ...SECRET_FIELDS.map((field) => `*.*.${field}`),
  ...SECRET_FIELDS.map((field) => `*.*.*.${field}`),
];

/** Database errors put the query parameters after "params:". */
const QUERY_PARAMS = /params:[^\n]*/g;

const scrub = (text: string): string =>
  text.replace(QUERY_PARAMS, "params: [redacted]");

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedError;
}

/** The err serializer: no query parameters in the message or the stack. */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: "non-error value thrown" };
  }
  const out: SerializedError = {
    type: error.name,
    message: scrub(error.message),
  };
  if (error.stack !== undefined) {
    out.stack = scrub(error.stack);
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string") {
    out.code = code;
  }
  if (error.cause !== undefined && depth < 3) {
    out.cause = serializeError(error.cause, depth + 1);
  }
  return out;
}

/** Logger options; stream is for tests that read the log lines. */
export function loggerOptions(
  level: string,
  stream?: NodeJS.WritableStream,
): FastifyServerOptions["logger"] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { err: serializeError },
    ...(stream === undefined ? {} : { stream }),
  };
}
