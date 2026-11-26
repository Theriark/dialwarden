// Error codes of the server, in plain words. Unknown codes fall back to the
// status and the code, so nothing is ever silent.
import { ApiError } from "./client";

const MESSAGES = new Map<string, string>([
  ["network", "The server could not be reached. Check the connection."],
  ["invalid_credentials", "The e-mail address or password is wrong."],
  ["unauthenticated", "Sign in to continue."],
  ["forbidden", "Your role does not allow this."],
  ["raw_requires_admin", "Raw text edits need the owner or an admin."],
  [
    "shell_file_requires_admin",
    "Restoring a launch or shell file needs the owner or an admin.",
  ],
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
  ["user_not_found", "This user no longer exists."],
  ["cannot_change_own_role", "You cannot change your own role."],
  ["cannot_change_owner", "The owner cannot be changed or removed."],
  ["role_too_high", "Your role does not reach that high."],
  ["owner_required", "The owner account cannot be removed."],
  ["unknown_server", "One of the servers does not exist."],
  ["user_exists", "A user with this e-mail address exists already."],
  ["oidc_active", "No invitations while single sign-on is on."],
  ["sso_required", "This account signs in through single sign-on."],
  ["invitation_not_found", "This invitation no longer exists."],
  ["invitation_invalid", "This invitation is no longer valid."],
  ["reset_invalid", "This reset link is no longer valid."],
  ["token_limit", "You hold the most API tokens an account may have."],
  ["token_not_found", "This token no longer exists."],
  ["invalid_role_mapping", "A group maps to a role that cannot be given."],
  ["base_url_required", "Set BASE_URL on the server first."],
  ["oidc_url_refused", "The provider address is not allowed."],
  ["oidc_discovery_failed", "The provider's discovery document failed."],
  ["oidc_issuer_mismatch", "The provider names another issuer."],
  [
    "oidc_unsupported_algorithm",
    "The provider signs with no supported algorithm.",
  ],
  ["oidc_disabled", "Single sign-on is off."],
  ["oidc_no_role", "No group of this account maps to a role."],
  [
    "oidc_email_conflict",
    "The provider's e-mail address belongs to another account.",
  ],
  ["schedule_not_found", "This schedule no longer exists."],
  [
    "author_cannot_write",
    "The person who made this schedule no longer has write access.",
  ],
  ["preset_not_found", "This preset no longer exists."],
  ["unknown_game", "No game pack has this id."],
  ["unknown_group", "This pack has no settings group with that name."],
  ["channel_not_found", "This channel no longer exists."],
  ["url_required", "A webhook address is needed to create the channel."],
  ["url_refused", "The address is not allowed: https only, no credentials."],
  [
    "host_refused",
    "The host is not allowed: private and local addresses need the private host switch.",
  ],
  ["in_app_exists", "There is already an in-app channel."],
  ["channel_limit", "This instance holds the most channels it may have."],
  ["kind_immutable", "A channel keeps its kind; make a new one instead."],
  ["test_running", "A test is already running on this channel."],
  ["no_url", "This channel has no address to send to."],
  ["timeout", "The receiver did not answer in time."],
  ["connection", "The receiver could not be reached."],
  ["tls_failed", "The secure connection could not be made."],
  ["auth_failed", "The mail server refused the sign-in."],
  ["smtp_failed", "The mail server refused the message."],
  ["demo_seed_off", "The demo simulation is off on this instance."],
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
  ["role", "The role"],
  ["issuer", "The discovery URL"],
  ["clientId", "The client id"],
  ["clientSecret", "The client secret"],
  ["scope", "The scope"],
  ["groupsClaim", "The groups claim"],
  ["retentionDays", "The retention"],
  ["server", "The server"],
  ["edits", "The settings to change"],
  ["runAt", "The run time"],
  ["cron", "The cron pattern"],
  ["timezone", "The time zone"],
  ["revertAt", "The revert time"],
  ["revertAfterMinutes", "The revert delay"],
  ["intervalMinutes", "The check interval"],
  ["url", "The address"],
  ["signingSecret", "The signing secret"],
  ["host", "The host"],
  ["port", "The port"],
  ["username", "The user name"],
  ["from", "The sender address"],
  ["to", "The recipients"],
  ["types", "The event types"],
]);

/**
 * An error code on its own in words (a bulk item, a schedule result, a
 * notification delivery or send test): the same table as the API errors,
 * plus the http_NNN and smtp_NNN shapes the transports report.
 */
export function codeWords(code: string): string {
  const known = MESSAGES.get(code);
  if (known !== undefined) {
    return known;
  }
  const http = /^http_(\d{3})$/.exec(code);
  if (http !== null) {
    return `The receiver answered ${http[1] ?? ""}.`;
  }
  const smtp = /^smtp_(\d{3})$/.exec(code);
  if (smtp !== null) {
    return `The mail server answered ${smtp[1] ?? ""}.`;
  }
  return `The send failed (${code}).`;
}

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
