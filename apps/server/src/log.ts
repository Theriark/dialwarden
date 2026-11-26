// pino options (dev-work-plan P1-A step 1): request ids, and redaction of
// authorization, cookies, passwords, tokens, licences and every secret field.
// Request bodies are never logged; the redaction also covers objects the code
// logs on purpose, up to three levels deep. Logged errors keep their name,
// code and stack, but database query parameters are cut from the message.
import type { FastifyRequest, FastifyServerOptions } from "fastify";

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
  "setupToken",
  "signingSecret",
  "secretEnc",
  "secret_enc",
  "webhookUrl",
  // P10-A G4.8: the OIDC credential, the instance SSH key, the hook command
  // and the encrypted column names. Not url: req.url is the request line of
  // every access log; no call site logs a hook or proxy URL.
  "clientSecret",
  "privateKey",
  "command",
  "passwordEnc",
  "password_enc",
  "clientSecretEnc",
  "privateKeyEnc",
  "private_key_enc",
  "payloadEnc",
  "payload_enc",
  "revertEnc",
  "revert_enc",
  "DEV_SEED_OWNER_PASSWORD",
  "key",
];

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'req.headers["x-dialwarden-passphrase"]',
  'req.headers["x-dialwarden-setup-token"]',
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

/** The OIDC callback carries the code and state in its query (L9). */
const QUERY_HIDDEN = ["/api/v1/auth/oidc/callback"];

/** A request URL as logged: no query on the paths that carry a secret. */
export function loggedUrl(url: string): string {
  const mark = url.indexOf("?");
  if (mark < 0) return url;
  const path = url.slice(0, mark);
  return QUERY_HIDDEN.includes(path) ? `${path}?[redacted]` : url;
}

/** Fastify's default req serializer, with the URL of loggedUrl. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: loggedUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort ?? 0,
  };
}

/** Logger options; stream is for tests that read the log lines. */
export function loggerOptions(
  level: string,
  stream?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      // Fastify's logger type wants a string stack on every serialized error.
      err: (error: Error) => {
        const out = serializeError(error);
        return { ...out, stack: out.stack ?? "" };
      },
      req: serializeRequest,
    },
    ...(stream === undefined ? {} : { stream }),
  };
}
