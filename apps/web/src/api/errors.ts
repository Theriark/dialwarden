// Error codes of the server, in plain words. Unknown codes fall back to the
// status and the code, so nothing is ever silent.
import { ApiError } from "./client";

const MESSAGES = new Map<string, string>([
  ["network", "The server could not be reached. Check the connection."],
  ["invalid_credentials", "The e-mail address or password is wrong."],
  ["unauthenticated", "Sign in to continue."],
  ["forbidden", "Only the owner can do this."],
  ["csrf", "The page is out of date. Reload it and try again."],
  ["challenge_expired", "The sign-in step expired. Start again."],
  ["invalid_code", "The code is wrong or was already used."],
  ["setup_done", "Setup is already done. Sign in instead."],
  ["setup_token_required", "Enter the setup token from the server log."],
  ["setup_token_invalid", "The setup token does not match."],
  ["import_running", "An import is already running. Wait for it to finish."],
  ["octet_stream_required", "Choose a backup export file first."],
  ["too_large", "The file is larger than the server accepts."],
  ["invalid_licence", "The licence key was not accepted."],
  ["totp_already_enabled", "Two-factor sign-in is already on."],
  ["totp_not_enrolling", "Start the enrolment again."],
  ["totp_not_enabled", "Two-factor sign-in is not on."],
  ["maintenance", "The server is busy with a restore. Try again shortly."],
  ["payment_required", "This needs the Paid plan."],
  ["no_change", "This server already holds these values."],
  ["internal", "The server hit an error. Check its log."],
  ["validation", "Some fields are not valid."],
  ["server_not_found", "This server no longer exists."],
  ["hook_not_configured", "No hook can run this action on this server."],
  ["invalid_state", "This change set was already applied or closed."],
  ["control_error", "The game server could not be reached."],
  ["connector_error", "The server files could not be reached."],
]);

/** The fields the P1 screens send, as the subject of a sentence. */
const FIELD_WORDS = new Map<string, string>([
  ["email", "The e-mail address"],
  ["name", "The name"],
  ["password", "The password"],
  ["currentPassword", "The current password"],
  ["newPassword", "The new password"],
  ["passphrase", "The passphrase"],
  ["x-dialwarden-passphrase", "The passphrase"],
  ["x-dialwarden-setup-token", "The setup token"],
  ["token", "The licence key"],
  ["code", "The code"],
  ["recoveryCode", "The recovery code"],
  ["challenge", "The sign-in step"],
]);

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * One plain sentence for a validation issue. The server's own text (zod) names
 * sizes and formats in its own words; the common ones become sentences and
 * the rest keep the server's text after the field name.
 */
export function issueSentence(issue: ValidationIssue): string {
  const subject =
    FIELD_WORDS.get(issue.path) ??
    (issue.path === "" ? "The input" : `The field ${issue.path}`);
  const text = issue.message;
  if (/^too small/i.test(text)) {
    return `${subject} is too short.`;
  }
  if (/^too big/i.test(text)) {
    return `${subject} is too long.`;
  }
  if (/printable ascii/i.test(text)) {
    return `${subject} may use only letters, digits, spaces and the punctuation of a US keyboard.`;
  }
  if (/^invalid email/i.test(text)) {
    return `${subject} is not valid.`;
  }
  return `${subject} is not valid: ${text}.`;
}

function retryText(seconds: number): string {
  if (seconds >= 120) {
    return `${Math.ceil(seconds / 60)} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** One sentence for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "rate_limited") {
      const wait = error.body?.retryAfter;
      if (typeof wait === "number" && wait > 0) {
        return `Too many attempts. Try again in ${retryText(wait)}.`;
      }
      return "Too many attempts. Wait a moment and try again.";
    }
    if (error.code === "invalid_licence") {
      const reason = error.body?.reason;
      const base = MESSAGES.get("invalid_licence") ?? "";
      return typeof reason === "string" ? `${base} (${reason})` : base;
    }
    if (error.code === "validation") {
      const issues = error.body?.issues ?? [];
      const first = issues.at(0);
      if (first !== undefined) {
        return issueSentence(first);
      }
    }
    const known = MESSAGES.get(error.code);
    if (known !== undefined) {
      return known;
    }
    return `The server answered ${error.status} (${error.code}).`;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "Something went wrong.";
}

/** Field errors of a 400 validation answer, keyed by the field path. */
export function fieldErrors(error: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (error instanceof ApiError && error.code === "validation") {
    for (const issue of error.body?.issues ?? []) {
      if (!out.has(issue.path)) {
        out.set(issue.path, issueSentence(issue));
      }
    }
  }
  return out;
}
