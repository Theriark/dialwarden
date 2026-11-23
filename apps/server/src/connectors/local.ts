// The Local connector (contract C4, dev-work-plan P4-A step 1): a server
// folder on the file system of the Dialwarden container, for example a
// bind-mounted game folder or /demo-servers/GAME.
//
// Confinement: the root is resolved once with realpath, and every path is
// checked as text (paths.ts) and again after realpath, so a symbolic link
// that leads out of the root is refused with PathEscape. O_NOFOLLOW on the
// final open covers only the last part of the path: a folder swapped for a
// link between the check and the open is caught by checking the file the
// open descriptor reached (assertOpenedInside), and a write checks the real
// path of its target again after the rename. Reads open with O_NONBLOCK, so
// a FIFO in a server folder cannot hang the request (security review
// THE-2398). The root may not be / and may not overlap a denied folder (the
// data folder, which holds the app secret key and the database).
//
// Writes: a temp file in the same folder (created exclusively, mode 0600),
// the bytes, the owner and group, the mode, fsync, rename over the target,
// then fsync of the folder. The owner, group and mode of the existing file
// are kept; when the process may not give the file its owner (EPERM), the
// write is refused and the target is left untouched rather than silently
// changing who owns it.
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { insideRoot, relativeParts, tempName } from "./paths.js";
import {
  ConnectorError,
  LIMITS,
  type Connector,
  type ConnectorTestResult,
  type FileStat,
  type ListEntry,
  type ReadResult,
  type WriteOptions,
} from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- every path is the server root or a path checked to stay inside it (paths.ts and the realpath checks below) */

export interface LocalOptions {
  /** The absolute path of the server folder. */
  readonly root: string;
  /** Folders the root may not be, contain or sit inside (the data folder). */
  readonly deny?: readonly string[];
  /**
   * Tests only: runs after a write resolved its target and before it opens
   * the temp file (the folder swap threat test).
   */
  readonly beforeTempOpen?: () => Promise<void>;
  /**
   * Tests only: runs right after a write renamed its temp file over the
   * target (the post-rename folder swap test, finding N1 of THE-2420).
   */
  readonly afterRename?: () => Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Maps a file system error to a C4 error; messages name the path only. */
export function fsError(error: unknown, rel: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const code = errnoOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ConnectorError("NotFound", `${rel || "."} does not exist`);
  }
  if (code === "ELOOP") {
    return new ConnectorError(
      "PathEscape",
      `${rel || "."} is a symbolic link where a file was expected`,
    );
  }
  return new ConnectorError(
    "Connection",
    `${rel || "."}: ${code ?? "file system error"}`,
    error,
  );
}

function typeOf(stats: Stats): FileStat["type"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function fileStat(stats: Stats): FileStat {
  return {
    size: stats.size,
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
    mtime: stats.mtime,
    type: typeOf(stats),
  };
}

// O_NONBLOCK: opening a FIFO returns at once (then isFile() refuses it)
// instead of holding a thread pool thread until a writer appears.
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const TEMP_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

/**
 * Refuses with PathEscape when an open descriptor reached a file outside
 * root, for example through a folder swapped for a symbolic link after the
 * realpath check. Linux names the file of a descriptor in /proc/self/fd;
 * without /proc, the descriptor's device and inode must match those of the
 * checked path.
 */
export async function assertOpenedInside(
  handle: FileHandle,
  root: string,
  checked: string,
  rel: string,
): Promise<void> {
  let reached: string | null;
  try {
    reached = await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    reached = null;
  }
  if (reached !== null) {
    if (insideRoot(root, reached)) return;
  } else {
    const [opened, named] = await Promise.all([handle.stat(), lstat(checked)]);
    if (opened.dev === named.dev && opened.ino === named.ino) return;
  }
  throw new ConnectorError("PathEscape", `${rel} leads out of the server root`);
}

export class LocalConnector implements Connector {
  readonly kind = "local" as const;
  readonly #root: string;
  readonly #deny: readonly string[];
  readonly #beforeTempOpen: (() => Promise<void>) | undefined;
  readonly #afterRename: (() => Promise<void>) | undefined;
  #real: string | null = null;

  constructor(options: LocalOptions) {
    this.#root = options.root;
    this.#deny = options.deny ?? [];
    this.#beforeTempOpen = options.beforeTempOpen;
    this.#afterRename = options.afterRename;
  }

  /** The real path of the root, checked once. */
  async #rootReal(): Promise<string> {
    if (this.#real !== null) return this.#real;
    if (!isAbsolute(this.#root)) {
      throw new ConnectorError(
        "PathEscape",
        "the server root must be absolute",
      );
    }
    // Checked as written first, so a root inside the data folder is refused
    // even before it exists, then again after realpath.
    await this.#checkDenied(resolve(this.#root));
    let real: string;
    try {
      real = await realpath(this.#root);
      if (!(await lstat(real)).isDirectory()) {
        throw new ConnectorError("NotFound", "the server root is not a folder");
      }
    } catch (error) {
      throw fsError(error, "the server root");
    }
    await this.#checkDenied(real);
    this.#real = real;
    return real;
  }

  async #checkDenied(root: string): Promise<void> {
    if (root === "/") {
      throw new ConnectorError("PathEscape", "the server root may not be /");
    }
    for (const denied of this.#deny) {
      const forms = [resolve(denied)];
      try {
        forms.push(await realpath(denied));
      } catch {
        // A denied folder that does not exist yet is compared as written.
      }
      for (const form of forms) {
        if (insideRoot(root, form) || insideRoot(form, root)) {
          throw new ConnectorError(
            "PathEscape",
            "the server root overlaps a folder Dialwarden keeps to itself",
          );
        }
      }
    }
  }

  /** The real path of an existing rel, inside the root. */
  async #existing(rel: string): Promise<string> {
    const root = await this.#rootReal();
    const parts = relativeParts(rel);
    let real: string;
    try {
      real = await realpath(join(root, ...parts));
    } catch (error) {
      throw fsError(error, rel);
    }
    if (!insideRoot(root, real)) {
      throw new ConnectorError(
        "PathEscape",
        `${rel} leads out of the server root`,
      );
    }
    return real;
  }

  /**
   * The real path a write goes to: the target's real path when it exists,
   * else the real path of its folder plus the name. The folder must exist.
   */
  async #target(rel: string): Promise<string> {
    const parts = relativeParts(rel);
    const name = parts.at(-1);
    if (name === undefined) {
      throw new ConnectorError("PathEscape", "the server root is not a file");
    }
    try {
      return await this.#existing(rel);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "NotFound") {
        throw error;
      }
    }
    const folder = await this.#existing(parts.slice(0, -1).join("/"));
    return join(folder, name);
  }

  async test(): Promise<ConnectorTestResult> {
    try {
      const root = await this.#rootReal();
      await readdir(root);
      return { ok: true, root };
    } catch (error) {
      const failure = fsError(error, "the server root");
      return {
        ok: false,
        root: null,
        error: failure.code,
        message: failure.message,
      };
    }
  }

  async realpath(rel: string): Promise<string> {
    return this.#existing(rel);
  }

  async stat(rel: string): Promise<FileStat> {
    const real = await this.#existing(rel);
    try {
      return fileStat(await lstat(real));
    } catch (error) {
      throw fsError(error, rel);
    }
  }

  async read(rel: string): Promise<ReadResult> {
    const root = await this.#rootReal();
    const real = await this.#existing(rel);
    let handle: FileHandle;
    try {
      handle = await open(real, READ_FLAGS);
    } catch (error) {
      throw fsError(error, rel);
    }
    try {
      await assertOpenedInside(handle, root, real, rel);
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new ConnectorError("NotFound", `${rel} is not a file`);
      }
      if (stats.size > LIMITS.maxFileBytes) {
        throw new ConnectorError("Connection", `${rel} is too large to read`);
      }
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.length > LIMITS.maxFileBytes) {
        throw new ConnectorError("Connection", `${rel} is too large to read`);
      }
      return { bytes, sha256: sha256Hex(bytes) };
    } catch (error) {
      throw fsError(error, rel);
    } finally {
      await handle.close();
    }
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
    const root = await this.#rootReal();
    const target = await this.#target(rel);
    let current: Stats | null = null;
    try {
      current = await lstat(target);
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw fsError(error, rel);
    }
    if (current !== null && current.isDirectory()) {
      throw new ConnectorError("NotFound", `${rel} is a folder, not a file`);
    }
    const existing = current !== null && current.isFile() ? current : null;
    if (options.expectedSha256 !== undefined) {
      const found = existing === null ? null : (await this.read(rel)).sha256;
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

    await this.#beforeTempOpen?.();
    const temp = tempName(target, randomBytes(6).toString("hex"));
    let handle: FileHandle | null;
    try {
      handle = await open(temp, TEMP_FLAGS, 0o600);
    } catch (error) {
      throw fsError(error, rel);
    }
    try {
      await assertOpenedInside(handle, root, temp, rel);
      await handle.writeFile(bytes);
      const made = await handle.stat();
      if (
        (uid !== undefined && uid !== made.uid) ||
        (gid !== undefined && gid !== made.gid)
      ) {
        await handle.chown(uid ?? -1, gid ?? -1);
      }
      await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, target);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw fsError(error, rel);
    }
    await this.#afterRename?.();
    // The rename resolves both names through the same folder, so it cannot
    // put the temp file outside the root. A folder swapped right after it
    // makes the target's real path differ: the write is reported as escaped
    // and nothing is removed, because unlinking by path would follow the
    // swapped folder to a file outside the root (security review THE-2420,
    // finding N1).
    const landed = await realpath(target).catch(() => null);
    if (landed !== target) {
      throw new ConnectorError(
        "PathEscape",
        `${rel} leads out of the server root`,
      );
    }
    await syncFolder(dirname(target));
    return sha256Hex(bytes);
  }

  async list(rel: string): Promise<ListEntry[]> {
    const real = await this.#existing(rel);
    try {
      const entries = await readdir(real, { withFileTypes: true });
      return entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isFile()
            ? ("file" as const)
            : entry.isDirectory()
              ? ("directory" as const)
              : ("other" as const),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, LIMITS.maxListEntries);
    } catch (error) {
      throw fsError(error, rel);
    }
  }

  async close(): Promise<void> {
    // Nothing is held open between calls.
  }
}

/** fsync of a folder, so the rename itself survives a crash. */
async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await open(
      folder,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some file systems refuse fsync on a folder; the file itself is synced.
  }
}
