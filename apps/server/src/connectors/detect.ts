// Game auto-detect and the import of existing files (dev-work-plan P4-A
// step 3). Detection runs the P3 rules of packages/packs-schema (app manifest
// first, then marker files, then the pack's warnings) through a connector, so
// it works the same on a local folder and over SFTP, including the * part of
// a warning path (Palworld's WorldOption.sav sits in a world id folder that
// only list() can find).
//
// Import reads every file of the detected pack for one operating system and
// hands each one to a snapshot sink with cause "import": the snapshot store
// of P4-B keeps it as the first version, so later edits and outside edits
// have a base to compare with.
import {
  detectGames,
  type Detection,
  type DetectionProbe,
  type Os,
  type Pack,
  type PackFile,
} from "@dialwarden/packs-schema";
import { isConnectorError, type Connector, type ReadResult } from "./types.js";

/** The paths of a pack file on one operating system. */
function pathsFor(file: PackFile, os: Os): readonly string[] {
  return (os === "linux" ? file.paths.linux : file.paths.windows) ?? [];
}

/** Reads detection needs, over a connector; a missing path answers absent. */
export function connectorProbe(connector: Connector): DetectionProbe {
  const absent = (error: unknown): boolean =>
    isConnectorError(error, "NotFound") ||
    isConnectorError(error, "PathEscape");
  return {
    async exists(path) {
      try {
        await connector.stat(path);
        return true;
      } catch (error) {
        if (absent(error)) return false;
        throw error;
      }
    },
    async read(path) {
      try {
        return (await connector.read(path)).bytes;
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
    async list(path) {
      try {
        return (await connector.list(path)).map((entry) => entry.name);
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Every pack whose detection rules match the server folder. The root itself
 * is checked first, so a root the connector refuses (or cannot reach) is an
 * error, never an empty answer.
 */
export async function detectServer(
  packs: Iterable<Pack>,
  connector: Connector,
): Promise<Detection[]> {
  await connector.realpath("");
  return detectGames([...packs], connectorProbe(connector));
}

/**
 * The operating system of a detected server: the one whose markers matched,
 * otherwise (detected by app manifest) the first of the pack's systems whose
 * file paths exist on the server. Null when no file of any system exists.
 */
export async function serverOs(
  pack: Pack,
  detection: Detection,
  connector: Connector,
): Promise<Os | null> {
  if (detection.os !== null) return detection.os;
  const probe = connectorProbe(connector);
  for (const os of pack.os) {
    for (const file of pack.files) {
      for (const path of pathsFor(file, os)) {
        if (await probe.exists(path)) return os;
      }
    }
  }
  return null;
}

export interface ImportedFile {
  readonly fileId: string;
  /** The path relative to the server root. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly cause: "import";
}

/** Where imported files go: the P4-B snapshot store. */
export interface SnapshotSink {
  store(file: ImportedFile): Promise<void> | void;
}

export interface ImportResult {
  readonly os: Os;
  readonly files: readonly {
    readonly fileId: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  /** Pack files with none of their paths on the server (created on first save). */
  readonly missing: readonly {
    readonly fileId: string;
    readonly paths: readonly string[];
  }[];
}

/**
 * Reads every file of the pack for os (the first of its paths that exists)
 * and stores each in the sink with cause import. A file that exists but
 * cannot be read fails the import; nothing is skipped silently.
 */
export async function importFiles(
  pack: Pack,
  os: Os,
  connector: Connector,
  sink: SnapshotSink,
): Promise<ImportResult> {
  const files: ImportResult["files"][number][] = [];
  const missing: ImportResult["missing"][number][] = [];
  for (const file of pack.files) {
    const paths = pathsFor(file, os);
    let found = false;
    for (const path of paths) {
      let read: ReadResult;
      try {
        read = await connector.read(path);
      } catch (error) {
        if (isConnectorError(error, "NotFound")) continue;
        throw error;
      }
      await sink.store({
        fileId: file.id,
        path,
        bytes: read.bytes,
        sha256: read.sha256,
        cause: "import",
      });
      files.push({
        fileId: file.id,
        path,
        sha256: read.sha256,
        size: read.bytes.length,
      });
      found = true;
      break;
    }
    if (!found) missing.push({ fileId: file.id, paths: [...paths] });
  }
  return { os, files, missing };
}
