// Interface contract C7 (dev-work-plan-2): how the server reaches a game's
// control plane. A GameControl probes the game (running, stopped or unknown,
// with the player count when the protocol reports one) and may save, stop,
// start or restart it. The implementations are palworldRest, sourceRcon,
// rustWebRcon, telnet7dtd, sshCommand and dockerProxy. Commands come only from
// the pack allow-list or the fixed per-server string; there is never free text
// from the UI (dev-work-plan P6-A).
//
// probe() never throws for connectivity: a refused port is the game being
// down (stopped), a timeout or anything unreadable is unknown. The actions
// throw ControlError; authentication failures are configuration blockers and
// are never retried (the caller shows them as such).
import { isIP } from "node:net";
import type { JsonValue } from "@dialwarden/packs-schema";

/** The six control kinds of contract C7. */
export type ControlKind =
  | "palworldRest"
  | "sourceRcon"
  | "rustWebRcon"
  | "telnet7dtd"
  | "sshCommand"
  | "dockerProxy";

/** What a probe reports about the game. */
export type ControlState = "running" | "stopped" | "unknown";

export interface ProbeResult {
  readonly state: ControlState;
  /** Connected players, when the protocol reports it. */
  readonly players?: number;
}

/** The hook actions a change set can ask for (contract C5 runHooks). */
export type ControlAction = "save" | "stop" | "start" | "restart";

/** Every GameControl failure. Messages never hold credentials. */
export type ControlErrorCode =
  | "Connection"
  | "Timeout"
  | "Auth"
  | "Protocol"
  | "HostKey"
  | "Refused"
  | "Failed"
  | "Unsupported";

export class ControlError extends Error {
  readonly code: ControlErrorCode;

  constructor(code: ControlErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlError";
    this.code = code;
  }
}

export function isControlError(
  error: unknown,
  code?: ControlErrorCode,
): error is ControlError {
  return (
    error instanceof ControlError && (code === undefined || error.code === code)
  );
}

/**
 * Whether an error (or one of its causes) means the port is closed. fetch
 * wraps the socket error in its cause, sometimes inside an AggregateError,
 * so the walk follows causes and aggregated errors a few levels deep.
 */
export function refused(error: unknown, depth = 0): boolean {
  if (depth > 5 || error === null || typeof error !== "object") return false;
  const { code, cause, errors } = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
    return true;
  }
  // Some wrappers keep only the text of the socket error.
  if (error instanceof Error && /\bECONNREFUSED\b/.test(error.message)) {
    return true;
  }
  if (Array.isArray(errors) && errors.some((e) => refused(e, depth + 1))) {
    return true;
  }
  return refused(cause, depth + 1);
}

/**
 * The bound of every control operation. Actions must finish well inside the
 * change-set request bound; a probe that cannot answer within its timeouts
 * reports unknown instead of failing.
 */
export const LIMITS = {
  /** Connect bound of every client (default connectMs). */
  connectMs: 5_000,
  /** Read bound of every client (default readMs). */
  readMs: 10_000,
  /** The largest RCON packet body the protocol allows. */
  maxRconBody: 4_096,
  /** The largest telnet line accepted from the game. */
  maxTelnetLine: 8_192,
  /** The largest WebRCON frame accepted from the game. */
  maxWebRconFrame: 1_048_576,
  /** The largest HTTP response body read from a control endpoint. */
  maxHttpBytes: 1_048_576,
  /** The largest A2S reply accepted from the game. */
  maxA2sBytes: 1_400,
  /** The longest allow-list command a pack may declare. */
  maxCommandLength: 128,
  /** The longest per-server SSH command string (sshCommand). */
  maxSshCommandLength: 2_000,
  /** The longest announce message sent to a game. */
  maxAnnounceLength: 256,
} as const;

export interface ControlTimeouts {
  readonly connectMs?: number;
  readonly readMs?: number;
}

/**
 * A pack command allow-list: a command is allowed when it equals one entry.
 * The allow-list is the only source of protocol commands; entries come from
 * pack.json (probes[]), never from the UI.
 */
export type AllowList = readonly string[];

const HOST_LABEL = /^[A-Za-z0-9-]{1,63}$/;

/**
 * A control host: an IP address or a DNS name, nothing else (no scheme,
 * port, user, brackets or path), the rule the SFTP connector applies
 * (routes/connectors.ts isHost). A host like evil.example/x? would otherwise
 * move a request, credentials included, to another address.
 */
export function usableHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  if (value === "" || value.length > 253) return false;
  return value
    .split(".")
    .every(
      (label) =>
        HOST_LABEL.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    );
}

/** A TCP or UDP port: an integer from 1 to 65535. */
export function usablePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** NUL, CR and LF end a console line or a C string. */
const LINE_BREAK = /[\0\r\n]/;

/**
 * Whether a value can go out as one console line: a password or a command
 * holding NUL, CR or LF would let a second line through, past the allow-list.
 */
export function lineSafe(value: string): boolean {
  return !LINE_BREAK.test(value);
}

/** Refuses a password that is not one line; the message never holds it. */
export function checkLineSafePassword(password: string): void {
  if (!lineSafe(password)) {
    throw new ControlError(
      "Refused",
      "the control password holds a line break or a zero byte",
    );
  }
}

/** Refuses a command that is not on the allow-list (never free text). */
export function allowedCommand(
  allow: AllowList,
  command: string,
): string | undefined {
  const found = allow.find((entry) => entry === command);
  if (found === undefined) return undefined;
  if (found.length > LIMITS.maxCommandLength || !lineSafe(found)) {
    return undefined;
  }
  return found;
}

/**
 * The live setting values of a server, read from its files by the caller
 * (P6-B): a probe declaration names the settings that hold its port and
 * password, and this reads their current values.
 */
export type SettingValue = (
  key: string,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

/** A password of a control endpoint, resolved when the client is built. */
export type PasswordSource =
  { readonly fromSetting: string } | { readonly encrypted: string };

/** The per-server control configuration P6-B stores (owner or admin only). */
export type ControlConfig =
  | { readonly kind: "sshCommand"; readonly command: string }
  | {
      readonly kind: "dockerProxy";
      /** The docker-socket-proxy base URL the user set. */
      readonly url: string;
      /** Only containers carrying this label are ever touched. */
      readonly containerLabel: string;
    };

/** Probe and hook configuration overrides a server may hold per kind. */
export interface ProbeOverride {
  readonly host?: string;
  readonly port?: number;
  /** A password stored encrypted (context control.password), when set. */
  readonly passwordEnc?: string;
}

/**
 * Contract C7 GameControl. probe() maps every failure to a state; the
 * optional actions are only present when the kind (and the pack, through its
 * allow-list) supports them.
 */
export interface GameControl {
  readonly kind: ControlKind;
  probe(): Promise<ProbeResult>;
  save?(): Promise<void>;
  stop?(): Promise<void>;
  start?(): Promise<void>;
  restart?(): Promise<void>;
}
