// Interface contract C4 (dev-work-plan-2): how the server reaches the files of
// a game server. Every path a caller passes is relative to the server root;
// a connector never touches anything outside that root. P4-B (change sets,
// snapshots, the servers API) uses connectors only through this interface.

export type ConnectorKind = "local" | "sftp";

/** The typed error codes of contract C4. */
export type ConnectorErrorCode =
  "PathEscape" | "HostKeyChanged" | "HashMismatch" | "Connection" | "NotFound";

/**
 * Every connector failure. Connection covers each I/O failure that is not one
 * of the other four codes (refused, timed out, permission denied, a full
 * disk); its cause names the underlying error. Messages never hold file
 * contents or credentials.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConnectorError";
    this.code = code;
  }
}

export function isConnectorError(
  error: unknown,
  code?: ConnectorErrorCode,
): error is ConnectorError {
  return (
    error instanceof ConnectorError &&
    (code === undefined || error.code === code)
  );
}

export interface FileStat {
  readonly size: number;
  /** Permission bits only (for example 0o644), without the file type. */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtime: Date;
  readonly type: "file" | "directory" | "other";
}

export interface ReadResult {
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of the bytes. */
  readonly sha256: string;
}

export interface WriteOptions {
  /**
   * The SHA-256 the file must still have: the write is refused with
   * HashMismatch when it differs. null means the file must not exist yet;
   * undefined skips the check.
   */
  readonly expectedSha256?: string | null;
  /** Permission bits for the file; default: the current file's, else 0o644. */
  readonly mode?: number;
  /** Owner and group; default: the current file's. */
  readonly uid?: number;
  readonly gid?: number;
}

export interface ListEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
}

/** How the host key of an SFTP server compares with the pinned one. */
export type HostKeyStatus = "pinned" | "unpinned" | "changed";

export interface HostKeyInfo {
  /** The key algorithm, for example ssh-ed25519. */
  readonly algorithm: string;
  /** OpenSSH style: SHA256: and the unpadded base64 digest of the key blob. */
  readonly fingerprint: string;
  readonly status: HostKeyStatus;
}

export interface ConnectorTestResult {
  /** True when the root could be opened and listed. */
  readonly ok: boolean;
  /** The root as the connector resolved it (null when it failed). */
  readonly root: string | null;
  /** SFTP only: the host key the server presented. */
  readonly hostKey?: HostKeyInfo;
  /** The C4 code of the failure, when ok is false. */
  readonly error?: ConnectorErrorCode;
  /** A short reason that is safe to show (no secrets, no file contents). */
  readonly message?: string;
}

export interface Connector {
  readonly kind: ConnectorKind;
  /** Connects, checks the root and the host key; never throws. */
  test(): Promise<ConnectorTestResult>;
  /** The real absolute path of rel; PathEscape when it leaves the root. */
  realpath(rel: string): Promise<string>;
  stat(rel: string): Promise<FileStat>;
  read(rel: string): Promise<ReadResult>;
  /** Writes through a temp file in the same folder; returns the new SHA-256. */
  writeAtomic(
    rel: string,
    bytes: Uint8Array,
    options?: WriteOptions,
  ): Promise<string>;
  /** The entries of a folder ("" is the root), sorted by name. */
  list(rel: string): Promise<ListEntry[]>;
  close(): Promise<void>;
}

/** Bounds every connector keeps. */
export const LIMITS = {
  /** The largest file read or written (config files are a few KiB). */
  maxFileBytes: 16 * 1024 * 1024,
  /** The most entries list() returns. */
  maxListEntries: 10_000,
  /** The longest relative path accepted. */
  maxPathLength: 4096,
} as const;
