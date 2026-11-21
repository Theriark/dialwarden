// pino options (dev-work-plan P1-A step 1): request ids, and redaction of
// authorization, cookies, passwords, tokens, licences and every secret field.
// Request bodies are never logged; the redaction also covers objects the code
// logs on purpose, one and two levels deep.
import type { FastifyServerOptions } from "fastify";

const SECRET_FIELDS = [
  "password",
  "currentPassword",
  "newPassword",
  "token",
  "licence",
  "passphrase",
  "secret",
  "code",
  "recoveryCode",
  "recoveryCodes",
  "csrfToken",
  "challenge",
  "appSecretKey",
  "sessionSecret",
  "envLicence",
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
];

/** Logger options; stream is for tests that read the log lines. */
export function loggerOptions(
  level: string,
  stream?: NodeJS.WritableStream,
): FastifyServerOptions["logger"] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(stream === undefined ? {} : { stream }),
  };
}
