// The SFTP connector (contract C4, dev-work-plan P4-A step 2), built on ssh2
// and ssh2-sftp-client.
//
// Authentication: the instance Ed25519 key (keys.ts) for a normal SSH
// server, or a password for panel SFTP (game panels that offer no keys).
// Only the one configured method is tried.
//
// Host key: the key the server presents is compared with the pinned
// fingerprint before any credential is sent. Unpinned, the connection stops
// there and test() returns the fingerprint for the owner to confirm. A key
// that differs from the pinned one refuses the connection with
// HostKeyChanged, so nothing is read or written until the owner confirms the
// new key.
//
// Confinement: the root is resolved with the server's realpath, every path is
// checked as text (paths.ts) and its realpath must stay under the root.
// A server whose realpath does not resolve symbolic links is not trusted
// with them: a link where a file is expected is refused.
//
// Writes: a temp file next to the target (created exclusively, 0600), the
// bytes, the owner and group, the mode, fsync when the server offers
// fsync@openssh.com, then posix-rename@openssh.com over the target. Without
// posix-rename (plain SFTP rename refuses an existing target), the target is
// renamed aside, the temp file takes its name and the old file is removed;
// if the second rename fails, the old file is put back.
//
// Time and size bounds: the handshake has readyTimeout, every request has an
// operation timeout after which the connection is dropped, files are at most
// LIMITS.maxFileBytes. A dropped connection is opened again on the next call;
// reads (stat, read, list, realpath) are retried once after a drop, writes
// never.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { ConnectConfig, SFTPWrapper, Stats } from "ssh2";
import SftpClient from "ssh2-sftp-client";
import { hostKeyId } from "./host-key.js";
import { sha256Hex } from "./local.js";
import { asideName, insideRoot, relativeParts, tempName } from "./paths.js";
import {
  ConnectorError,
  LIMITS,
  type Connector,
  type ConnectorTestResult,
  type FileStat,
  type HostKeyInfo,
  type ListEntry,
  type ReadResult,
  type WriteOptions,
} from "./types.js";

export type SftpAuth =
  | { readonly method: "key"; readonly privateKey: string }
  | { readonly method: "password"; readonly password: string };

export interface SftpOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** The server root: an absolute path, or "" for the login folder. */
  readonly root: string;
  readonly auth: SftpAuth;
  /** The pinned host key fingerprint, or null before the owner confirmed one. */
  readonly pinnedFingerprint: string | null;
  /** Handshake bound (default 10 s). */
  readonly readyTimeoutMs?: number;
  /** Bound of every request (default 30 s). */
  readonly operationTimeoutMs?: number;
  /** false never uses posix-rename (tests of the plain-rename fallback). */
  readonly posixRename?: boolean;
}

/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const CHUNK = 32 * 1024;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function typeOfMode(mode: number): FileStat["type"] {
  const kind = mode & S_IFMT;
  if (kind === S_IFREG) return "file";
  if (kind === S_IFDIR) return "directory";
  return "other";
}

function statusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

/** Maps an SFTP or SSH error to a C4 error; messages name the path only. */
function sftpError(error: unknown, rel: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const status = statusOf(error);
  const where = rel || ".";
  if (status === NO_SUCH_FILE) {
    return new ConnectorError("NotFound", `${where} does not exist`);
  }
  if (status === PERMISSION_DENIED) {
    return new ConnectorError(
      "Connection",
      `${where}: permission denied`,
      error,
    );
  }
  return new ConnectorError(
    "Connection",
    `${where}: the SFTP request failed`,
    error,
  );
}

/** True when the error means the connection itself is gone. */
function dropped(error: unknown): boolean {
  return (
    error instanceof ConnectorError &&
    error.code === "Connection" &&
    error.message.endsWith("the connection was lost")
  );
}

export class SftpConnector implements Connector {
  readonly kind = "sftp" as const;
  readonly #options: SftpOptions;
  #client: SftpClient | null = null;
  #sftp: SFTPWrapper | null = null;
  #connecting: Promise<SFTPWrapper> | null = null;
  #root: string | null = null;
  #hostKey: HostKeyInfo | null = null;

  constructor(options: SftpOptions) {
    this.#options = options;
  }

  get #operationMs(): number {
    return this.#options.operationTimeoutMs ?? 30_000;
  }

  /** The host key seen at the last handshake (null before one). */
  get hostKey(): HostKeyInfo | null {
    return this.#hostKey;
  }

  async #session(): Promise<SFTPWrapper> {
    if (this.#sftp !== null) return this.#sftp;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #drop(): void {
    const client = this.#client;
    this.#client = null;
    this.#sftp = null;
    if (client !== null) void client.end().catch(() => undefined);
  }

  async #connect(): Promise<SFTPWrapper> {
    const options = this.#options;
    // A late event of an older connection must not drop the current one.
    const lost = () => {
      if (this.#client === client) this.#drop();
    };
    const client: SftpClient = new SftpClient("dialwarden", {
      error: lost,
      end: lost,
      close: lost,
    });
    this.#hostKey = null;
    const config: ConnectConfig = {
      host: options.host,
      port: options.port,
      username: options.username,
      readyTimeout: options.readyTimeoutMs ?? 10_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: false,
      // Runs before any credential is sent; false ends the handshake.
      hostVerifier: (key: Buffer): boolean => {
        const id = hostKeyId(key);
        const pinned = options.pinnedFingerprint;
        const status =
          pinned === null
            ? "unpinned"
            : pinned === id.fingerprint
              ? "pinned"
              : "changed";
        this.#hostKey = { ...id, status };
        return status === "pinned";
      },
      ...(options.auth.method === "key"
        ? { privateKey: options.auth.privateKey, authHandler: ["publickey"] }
        : { password: options.auth.password, authHandler: ["password"] }),
    };
    try {
      const sftp = await client.connect(config);
      this.#client = client;
      this.#sftp = sftp;
      return sftp;
    } catch (error) {
      void client.end().catch(() => undefined);
      // Set by hostVerifier during the handshake above.
      const seen = this.#hostKey as HostKeyInfo | null;
      if (seen?.status === "changed") {
        throw new ConnectorError(
          "HostKeyChanged",
          "the server presented a host key other than the confirmed one",
        );
      }
      if (seen?.status === "unpinned") {
        throw new ConnectorError(
          "Connection",
          "the host key is not confirmed yet",
        );
      }
      const reason =
        seen === null
          ? "could not reach the SSH server"
          : "the SSH server refused the login";
      throw new ConnectorError("Connection", reason, error);
    }
  }

  /** One SFTP request with the operation timeout; a timeout drops the link. */
  #request<T>(
    rel: string,
    start: (
      sftp: SFTPWrapper,
      done: (error: unknown, value?: T) => void,
    ) => void,
  ): (sftp: SFTPWrapper) => Promise<T> {
    return (sftp) =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.#drop();
          reject(
            new ConnectorError(
              "Connection",
              `${rel || "."}: the request timed out`,
            ),
          );
        }, this.#operationMs);
        const done = (error: unknown, value?: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined && error !== null) {
            reject(
              this.#sftp === sftp
                ? sftpError(error, rel)
                : new ConnectorError(
                    "Connection",
                    `${rel || "."}: the connection was lost`,
                    error,
                  ),
            );
          } else {
            resolve(value as T);
          }
        };
        try {
          start(sftp, done);
        } catch (error) {
          done(error);
        }
      });
  }

  /** Runs fn on a session; a read is tried again once after a drop. */
  async #run<T>(
    fn: (sftp: SFTPWrapper) => Promise<T>,
    idempotent: boolean,
  ): Promise<T> {
    try {
      return await fn(await this.#session());
    } catch (error) {
      if (!idempotent || !dropped(error)) throw error;
      this.#drop();
      return fn(await this.#session());
    }
  }

  #realpathOf(sftp: SFTPWrapper, path: string, rel: string): Promise<string> {
    return this.#request<string>(rel, (s, done) => {
      s.realpath(path, (error, absolute) => done(error, absolute));
    })(sftp);
  }

  #lstatOf(sftp: SFTPWrapper, path: string, rel: string): Promise<Stats> {
    return this.#request<Stats>(rel, (s, done) => {
      s.lstat(path, (error, stats) => done(error, stats));
    })(sftp);
  }

  async #rootOf(sftp: SFTPWrapper): Promise<string> {
    if (this.#root !== null) return this.#root;
    const given = this.#options.root;
    if (given !== "" && !given.startsWith("/")) {
      throw new ConnectorError(
        "PathEscape",
        "the server root must be absolute or empty",
      );
    }
    const root = await this.#realpathOf(
      sftp,
      given === "" ? "." : given,
      "the server root",
    );
    const stats = await this.#lstatOf(sftp, root, "the server root");
    if ((stats.mode & S_IFMT) !== S_IFDIR) {
      throw new ConnectorError("NotFound", "the server root is not a folder");
    }
    this.#root = root;
    return root;
  }

  /** The real path of an existing rel, inside the root. */
  async #existing(sftp: SFTPWrapper, rel: string): Promise<string> {
    const root = await this.#rootOf(sftp);
    const parts = relativeParts(rel);
    const path = parts.length === 0 ? root : posix.join(root, ...parts);
    const real = await this.#realpathOf(sftp, path, rel);
    if (!insideRoot(root, real)) {
      throw new ConnectorError(
        "PathEscape",
        `${rel} leads out of the server root`,
      );
    }
    // Some servers answer realpath without looking at the file system.
    const stats = await this.#lstatOf(sftp, real, rel);
    if ((stats.mode & S_IFMT) === S_IFLNK) {
      throw new ConnectorError(
        "PathEscape",
        `${rel} is a symbolic link the server did not resolve`,
      );
    }
    return real;
  }

  async #target(sftp: SFTPWrapper, rel: string): Promise<string> {
    const parts = relativeParts(rel);
    const name = parts.at(-1);
    if (name === undefined) {
      throw new ConnectorError("PathEscape", "the server root is not a file");
    }
    try {
      return await this.#existing(sftp, rel);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "NotFound") {
        throw error;
      }
    }
    const folder = await this.#existing(sftp, parts.slice(0, -1).join("/"));
    return posix.join(folder, name);
  }

  async test(): Promise<ConnectorTestResult> {
    try {
      const root = await this.#run(async (sftp) => {
        const found = await this.#rootOf(sftp);
        await this.#readdir(sftp, found, "the server root");
        return found;
      }, true);
      const result: ConnectorTestResult = { ok: true, root };
      return this.#hostKey === null
        ? result
        : { ...result, hostKey: this.#hostKey };
    } catch (error) {
      const failure = sftpError(error, "the server root");
      const result: ConnectorTestResult = {
        ok: false,
        root: null,
        error: failure.code,
        message: failure.message,
      };
      return this.#hostKey === null
        ? result
        : { ...result, hostKey: this.#hostKey };
    }
  }

  async realpath(rel: string): Promise<string> {
    return this.#run((sftp) => this.#existing(sftp, rel), true);
  }

  async stat(rel: string): Promise<FileStat> {
    return this.#run(async (sftp) => {
      const real = await this.#existing(sftp, rel);
      const stats = await this.#lstatOf(sftp, real, rel);
      return {
        size: stats.size,
        mode: stats.mode & 0o7777,
        uid: stats.uid,
        gid: stats.gid,
        mtime: new Date(stats.mtime * 1000),
        type: typeOfMode(stats.mode),
      };
    }, true);
  }

  async read(rel: string): Promise<ReadResult> {
    return this.#run(async (sftp) => {
      const real = await this.#existing(sftp, rel);
      return this.#readFile(sftp, real, rel);
    }, true);
  }

  async #readFile(
    sftp: SFTPWrapper,
    path: string,
    rel: string,
  ): Promise<ReadResult> {
    const handle = await this.#request<Buffer>(rel, (s, done) => {
      s.open(path, "r", (error, h) => done(error, h));
    })(sftp);
    try {
      const stats = await this.#request<Stats>(rel, (s, done) => {
        s.fstat(handle, (error, st) => done(error, st));
      })(sftp);
      if ((stats.mode & S_IFMT) !== S_IFREG) {
        throw new ConnectorError("NotFound", `${rel} is not a file`);
      }
      if (stats.size > LIMITS.maxFileBytes) {
        throw new ConnectorError("Connection", `${rel} is too large to read`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.alloc(CHUNK);
        const count = await this.#request<number>(rel, (s, done) => {
          s.read(handle, buffer, 0, CHUNK, total, (error, bytesRead) => {
            // ssh2 reports the end of the file as an EOF status error.
            if (
              error !== undefined &&
              error !== null &&
              statusOf(error) === 1
            ) {
              done(undefined, 0);
            } else {
              done(error, bytesRead);
            }
          });
        })(sftp);
        if (count === 0) break;
        chunks.push(buffer.subarray(0, count));
        total += count;
        if (total > LIMITS.maxFileBytes) {
          throw new ConnectorError("Connection", `${rel} is too large to read`);
        }
      }
      const bytes = new Uint8Array(Buffer.concat(chunks, total));
      return { bytes, sha256: sha256Hex(bytes) };
    } finally {
      await this.#close(sftp, handle, rel).catch(() => undefined);
    }
  }

  #close(sftp: SFTPWrapper, handle: Buffer, rel: string): Promise<void> {
    return this.#request<undefined>(rel, (s, done) => {
      s.close(handle, (error) => done(error));
    })(sftp);
  }

  #readdir(sftp: SFTPWrapper, path: string, rel: string) {
    return this.#request<{ filename: string; attrs: { mode: number } }[]>(
      rel,
      (s, done) => {
        s.readdir(path, (error, list) => done(error, list));
      },
    )(sftp);
  }

  #rename(
    sftp: SFTPWrapper,
    from: string,
    to: string,
    rel: string,
  ): Promise<void> {
    return this.#request<undefined>(rel, (s, done) => {
      s.rename(from, to, (error) => done(error));
    })(sftp);
  }

  #unlink(sftp: SFTPWrapper, path: string, rel: string): Promise<void> {
    return this.#request<undefined>(rel, (s, done) => {
      s.unlink(path, (error) => done(error));
    })(sftp);
  }

  /** posix-rename when the server offers it; false when it does not. */
  #posixRename(
    sftp: SFTPWrapper,
    from: string,
    to: string,
    rel: string,
  ): Promise<boolean> {
    if (this.#options.posixRename === false) return Promise.resolve(false);
    return this.#request<boolean>(rel, (s, done) => {
      try {
        s.ext_openssh_rename(from, to, (error) => done(error, true));
      } catch {
        // ssh2 throws at once when the server did not announce the extension.
        done(undefined, false);
      }
    })(sftp);
  }

  async writeAtomic(
    rel: string,
    bytes: Uint8Array,
    options: WriteOptions = {},
  ): Promise<string> {
    if (bytes.length > LIMITS.maxFileBytes) {
      throw new ConnectorError(
        "Connection",
        `${rel}: the new content is too large`,
      );
    }
    return this.#run(async (sftp) => {
      const target = await this.#target(sftp, rel);
      let current: Stats | null = null;
      try {
        current = await this.#lstatOf(sftp, target, rel);
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "NotFound")
          throw error;
      }
      if (current !== null && (current.mode & S_IFMT) === S_IFDIR) {
        throw new ConnectorError("NotFound", `${rel} is a folder, not a file`);
      }
      const existing =
        current !== null && (current.mode & S_IFMT) === S_IFREG
          ? current
          : null;
      if (options.expectedSha256 !== undefined) {
        const found =
          existing === null
            ? null
            : (await this.#readFile(sftp, target, rel)).sha256;
        if (found !== options.expectedSha256) {
          throw new ConnectorError(
            "HashMismatch",
            `${rel} changed since it was read`,
          );
        }
      }
      const mode = (options.mode ?? existing?.mode ?? 0o644) & 0o777;
      const uid = options.uid ?? existing?.uid;
      const gid = options.gid ?? existing?.gid;
      const token = randomBytes(6).toString("hex");
      const temp = tempName(target, token);
      await this.#writeTemp(sftp, temp, bytes, { mode, uid, gid }, rel);
      try {
        await this.#replace(sftp, temp, target, existing !== null, token, rel);
      } catch (error) {
        await this.#unlink(sftp, temp, rel).catch(() => undefined);
        throw error;
      }
      return sha256Hex(bytes);
    }, false);
  }

  async #writeTemp(
    sftp: SFTPWrapper,
    temp: string,
    bytes: Uint8Array,
    owner: { mode: number; uid: number | undefined; gid: number | undefined },
    rel: string,
  ): Promise<void> {
    const handle = await this.#request<Buffer>(rel, (s, done) => {
      s.open(temp, "wx", { mode: 0o600 }, (error, h) => done(error, h));
    })(sftp);
    let closed = false;
    try {
      const data = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      for (let at = 0; at < data.length; at += CHUNK) {
        const length = Math.min(CHUNK, data.length - at);
        await this.#request<undefined>(rel, (s, done) => {
          s.write(handle, data, at, length, at, (error) => done(error));
        })(sftp);
      }
      const made = await this.#request<Stats>(rel, (s, done) => {
        s.fstat(handle, (error, st) => done(error, st));
      })(sftp);
      const uid = owner.uid ?? made.uid;
      const gid = owner.gid ?? made.gid;
      if (uid !== made.uid || gid !== made.gid) {
        await this.#request<undefined>(rel, (s, done) => {
          s.fchown(handle, uid, gid, (error) => done(error));
        })(sftp);
      }
      await this.#request<undefined>(rel, (s, done) => {
        s.fchmod(handle, owner.mode, (error) => done(error));
      })(sftp);
      await this.#request<undefined>(rel, (s, done) => {
        try {
          s.ext_openssh_fsync(handle, (error) => done(error));
        } catch {
          // No fsync@openssh.com: the server writes on close.
          done(undefined);
        }
      })(sftp);
      closed = true;
      await this.#close(sftp, handle, rel);
    } catch (error) {
      if (!closed) await this.#close(sftp, handle, rel).catch(() => undefined);
      await this.#unlink(sftp, temp, rel).catch(() => undefined);
      throw error;
    }
  }

  async #replace(
    sftp: SFTPWrapper,
    temp: string,
    target: string,
    targetExists: boolean,
    token: string,
    rel: string,
  ): Promise<void> {
    if (await this.#posixRename(sftp, temp, target, rel)) return;
    if (!targetExists) {
      await this.#rename(sftp, temp, target, rel);
      return;
    }
    const aside = asideName(target, token);
    await this.#rename(sftp, target, aside, rel);
    try {
      await this.#rename(sftp, temp, target, rel);
    } catch (error) {
      await this.#rename(sftp, aside, target, rel).catch(() => undefined);
      throw error;
    }
    await this.#unlink(sftp, aside, rel).catch(() => undefined);
  }

  async list(rel: string): Promise<ListEntry[]> {
    return this.#run(async (sftp) => {
      const real = await this.#existing(sftp, rel);
      const entries = await this.#readdir(sftp, real, rel);
      return entries
        .filter((entry) => entry.filename !== "." && entry.filename !== "..")
        .map((entry) => ({
          name: entry.filename,
          type: typeOfMode(entry.attrs.mode),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, LIMITS.maxListEntries);
    }, true);
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#sftp = null;
    if (client !== null) await client.end().catch(() => undefined);
  }
}
