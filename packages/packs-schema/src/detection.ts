// Game detection (dev-work-plan P3-A step 1). SteamCMD writes
// steamapps/appmanifest_APPID.acf, a Valve KeyValues text file, next to every
// app it installs; it names the app id and the installed build id. A pack
// also lists marker files. Detection reads through a small probe interface,
// so P4 runs it over a local folder or SFTP and the tests over fixtures.
import type { Os, Pack } from "./types.js";

/** A KeyValues block: keys in file order, values text or nested blocks. */
export type KeyValues = Map<string, string | KeyValues>;

/** The largest manifest the parser reads (real ones are about 1 KiB). */
export const MAX_ACF_BYTES = 256 * 1024;
const MAX_DEPTH = 16;

export class AcfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcfError";
  }
}

type Token =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["\\", "\\"],
  ['"', '"'],
]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "/" && text.charAt(i + 1) === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === "{" || ch === "}") {
      tokens.push({ kind: ch === "{" ? "open" : "close" });
      i += 1;
    } else if (ch === '"') {
      let value = "";
      i += 1;
      for (;;) {
        if (i >= text.length) throw new AcfError("unclosed quoted string");
        const c = text.charAt(i);
        if (c === '"') break;
        if (c === "\\") {
          const next = text.charAt(i + 1);
          value += ESCAPES.get(next) ?? `\\${next}`;
          i += 2;
        } else {
          value += c;
          i += 1;
        }
      }
      tokens.push({ kind: "text", value });
      i += 1;
    } else {
      // An unquoted word ends at white space, a brace or a quote.
      let end = i;
      while (end < text.length && !/[\s{}"]/.test(text.charAt(end))) end += 1;
      tokens.push({ kind: "text", value: text.slice(i, end) });
      i = end;
    }
  }
  return tokens;
}

/**
 * Parses a KeyValues text (the .acf and .vdf files of Steam). Keys are kept
 * as written; a repeated key keeps its first value. Throws AcfError.
 */
export function parseKeyValues(text: string): KeyValues {
  if (text.length > MAX_ACF_BYTES) throw new AcfError("the file is too large");
  const tokens = tokenize(text);
  let at = 0;
  const block = (depth: number, closed: boolean): KeyValues => {
    if (depth > MAX_DEPTH) throw new AcfError("blocks are nested too deeply");
    const out: KeyValues = new Map();
    for (;;) {
      const token = tokens.at(at);
      if (token === undefined) {
        if (closed) throw new AcfError("a block is not closed");
        return out;
      }
      at += 1;
      if (token.kind === "close") {
        if (!closed) throw new AcfError("a closing brace has no block");
        return out;
      }
      if (token.kind === "open") throw new AcfError("a block has no key");
      const value = tokens.at(at);
      if (value === undefined) {
        throw new AcfError(`${token.value} has no value`);
      }
      at += 1;
      let parsed: string | KeyValues;
      if (value.kind === "open") parsed = block(depth + 1, true);
      else if (value.kind === "text") parsed = value.value;
      else throw new AcfError(`${token.value} has no value`);
      if (!out.has(token.value)) out.set(token.value, parsed);
    }
  };
  return block(0, false);
}

/** A field of a block, matched without case as Steam does. */
function field(block: KeyValues, name: string): string | KeyValues | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of block) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function whole(value: string | KeyValues | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

export interface AppManifest {
  readonly appId: number;
  /** The installed build; null when the manifest has none. */
  readonly buildId: number | null;
  readonly name: string | null;
  readonly installDir: string | null;
}

/** Reads the app id and build id of an appmanifest_APPID.acf file. */
export function parseAppManifest(input: string | Uint8Array): AppManifest {
  const text =
    typeof input === "string" ? input : new TextDecoder().decode(input);
  const root = parseKeyValues(text);
  const state = field(root, "AppState");
  if (!(state instanceof Map)) {
    throw new AcfError("the file has no AppState block");
  }
  const appId = whole(field(state, "appid"));
  if (appId === null) throw new AcfError("AppState has no numeric appid");
  const name = field(state, "name");
  const installDir = field(state, "installdir");
  return {
    appId,
    buildId: whole(field(state, "buildid")),
    name: typeof name === "string" ? name : null,
    installDir: typeof installDir === "string" ? installDir : null,
  };
}

/** The manifest path of an app, relative to the server root. */
export function appManifestPath(appId: number): string {
  return `steamapps/appmanifest_${appId}.acf`;
}

/** How detection looks at a server folder; paths are relative to its root. */
export interface DetectionProbe {
  exists(path: string): Promise<boolean>;
  /** The file's bytes, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
}

export interface Detection {
  readonly packId: string;
  readonly by: "appmanifest" | "markers";
  /** The operating system whose markers matched, when markers decided. */
  readonly os: Os | null;
  readonly buildId: number | null;
  /** False when the build is outside the pack's builds range. */
  readonly buildSupported: boolean;
  /** Messages of the pack's detection warnings whose files exist. */
  readonly warnings: readonly string[];
}

/** True when a build id is inside the pack's builds range. */
export function buildSupported(pack: Pack, buildId: number | null): boolean {
  if (buildId === null) return true;
  const to = pack.builds.to ?? null;
  return buildId >= pack.builds.from && (to === null || buildId <= to);
}

function forOs(os: Os, list?: readonly Os[]): boolean {
  return list === undefined || list.includes(os);
}

async function markersMatch(
  pack: Pack,
  os: Os,
  probe: DetectionProbe,
): Promise<boolean> {
  const markers = pack.detection.markers.filter((m) => forOs(os, m.os));
  if (markers.length === 0) return false;
  for (const marker of markers) {
    if (!(await probe.exists(marker.path))) return false;
  }
  return true;
}

async function warningsOf(
  pack: Pack,
  os: Os | null,
  probe: DetectionProbe,
): Promise<string[]> {
  const out: string[] = [];
  for (const warning of pack.detection.warnings ?? []) {
    if (os !== null && !forOs(os, warning.os)) continue;
    if (await probe.exists(warning.path)) out.push(warning.message);
  }
  return out;
}

async function manifestOf(
  pack: Pack,
  probe: DetectionProbe,
): Promise<AppManifest | null> {
  const bytes = await probe.read(appManifestPath(pack.steamAppId));
  if (bytes === null) return null;
  try {
    const manifest = parseAppManifest(bytes);
    return manifest.appId === pack.steamAppId ? manifest : null;
  } catch (error) {
    if (error instanceof AcfError) return null;
    throw error;
  }
}

/**
 * Detects which pack a server folder holds. The app manifest decides first
 * (it also gives the build); otherwise every marker of the pack for one
 * operating system must exist. Returns one result per matching pack.
 */
export async function detectGames(
  packs: readonly Pack[],
  probe: DetectionProbe,
): Promise<Detection[]> {
  const found: Detection[] = [];
  for (const pack of packs) {
    const manifest = await manifestOf(pack, probe);
    if (manifest !== null) {
      found.push({
        packId: pack.id,
        by: "appmanifest",
        os: null,
        buildId: manifest.buildId,
        buildSupported: buildSupported(pack, manifest.buildId),
        warnings: await warningsOf(pack, null, probe),
      });
      continue;
    }
    for (const os of pack.os) {
      if (!(await markersMatch(pack, os, probe))) continue;
      found.push({
        packId: pack.id,
        by: "markers",
        os,
        buildId: null,
        buildSupported: true,
        warnings: await warningsOf(pack, os, probe),
      });
      break;
    }
  }
  return found;
}
