// The settings of one pack file (contract C3 over the C2 adapters): the typed
// values a file holds, the bytes after a list of edits, and the lint of a
// file. The server's change sets (P4-B) and the editor previews read and
// write files through these, so both see a file the same way.
import {
  FormatError,
  getAdapter,
  launchShellIssues,
  type FormatAdapter,
  type LintIssue,
  type ParsedDoc,
  type Splice,
  type Value,
} from "@dialwarden/formats";
import { fromFileValue } from "./coerce.js";
import { lintPackFile, withoutKeyedDuplicates } from "./lint.js";
import type { JsonValue, Pack, PackFile, Setting } from "./types.js";

/** One edit of a setting value; null removes the value from the file. */
export interface SettingEdit {
  readonly key: string;
  readonly value: JsonValue;
}

export interface FileValues {
  /** The typed values by setting key, for the settings the file holds. */
  readonly values: Map<string, JsonValue>;
  /** Keys whose text in the file does not fit the setting's type. */
  readonly invalid: string[];
}

/** The app-managed launch file the start snippets hand to eval. */
export const APP_ARGS_FILE = "dialwarden-args.txt";

/**
 * Whether a pack file is an app-managed args file: its text is run through
 * eval at game start, so a shell character anywhere in it is an error that
 * blocks the write, raw patches and restores included. A file that lists the
 * args launch source is one whatever its name (THE-2605 L5); a launch file
 * without launchSources is one by its name, since a start script the user
 * owns (a comment line, then the command) is a launch file too.
 */
function evaluatedArgsFile(file: PackFile): boolean {
  if (file.adapter !== "launch") return false;
  if (file.launchSources?.some((source) => source.kind === "args")) {
    return true;
  }
  const paths = [...(file.paths.linux ?? []), ...(file.paths.windows ?? [])];
  return paths.some((path) => path.split("/").at(-1) === APP_ARGS_FILE);
}

/** A file of a pack by id; throws when the pack has no such file. */
export function packFileOf(pack: Pack, fileId: string): PackFile {
  const file = pack.files.find((candidate) => candidate.id === fileId);
  if (file === undefined) {
    throw new Error(`pack ${pack.id} has no file ${fileId}`);
  }
  return file;
}

function adapterOf(file: PackFile): FormatAdapter {
  const adapter = getAdapter(file.adapter);
  if (adapter === undefined) {
    throw new Error(`no format adapter ${file.adapter}`);
  }
  return adapter;
}

/** A bool launch flag: on when it is given, off when it is left out. */
function bareFlag(adapter: FormatAdapter, setting: Setting): boolean {
  return adapter.id === "launch" && setting.type === "bool";
}

/** The settings of a pack file, in pack order. */
export function settingsOfFile(pack: Pack, fileId: string): Setting[] {
  return pack.settings.filter((setting) => setting.file === fileId);
}

/** The file value at a locator, or undefined; a wrong locator is invalid. */
function rawValue(
  adapter: FormatAdapter,
  doc: ParsedDoc,
  setting: Setting,
): Value | undefined | FormatError {
  try {
    return adapter.get(doc, setting.locator);
  } catch (error) {
    if (error instanceof FormatError) return error;
    throw error;
  }
}

/**
 * The typed values of every setting a file holds. A value whose text does not
 * fit its setting's type is listed in invalid instead; a setting the file does
 * not hold is left out (a bare launch flag that is not given reads as off).
 */
export function readFileValues(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array,
): FileValues {
  const adapter = adapterOf(packFileOf(pack, fileId));
  const doc = adapter.parse(bytes);
  const values = new Map<string, JsonValue>();
  const invalid: string[] = [];
  for (const setting of settingsOfFile(pack, fileId)) {
    const raw = rawValue(adapter, doc, setting);
    if (raw instanceof FormatError) {
      invalid.push(setting.key);
      continue;
    }
    if (raw === undefined) {
      if (bareFlag(adapter, setting)) values.set(setting.key, false);
      continue;
    }
    const typed = fromFileValue(setting, raw);
    if (typed === undefined) invalid.push(setting.key);
    else values.set(setting.key, typed);
  }
  return { values, invalid };
}

function editSplices(
  adapter: FormatAdapter,
  doc: ParsedDoc,
  setting: Setting,
  value: JsonValue,
): Splice[] {
  const locator = setting.locator;
  if (value === null) return adapter.remove(doc, locator);
  const exists = adapter.get(doc, locator) !== undefined;
  if (!exists && value === false && bareFlag(adapter, setting)) return [];
  const fileValue = value as Value;
  if (exists) return adapter.set(doc, locator, fileValue);
  return adapter.insert(doc, locator, fileValue);
}

/**
 * The bytes of a file after the edits. Each edit is made on the bytes the one
 * before it wrote: set when the value is there, insert when it is not, remove
 * for null. Only the bytes of the edited values change. Throws FormatError
 * when an edit cannot be made, for example in a file that does not parse, so
 * a broken file never produces a write.
 */
export function writeFileValues(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array,
  edits: readonly SettingEdit[],
): Uint8Array {
  const adapter = adapterOf(packFileOf(pack, fileId));
  const own = settingsOfFile(pack, fileId);
  const settings = new Map(own.map((setting) => [setting.key, setting]));
  let current = bytes;
  for (const edit of edits) {
    const setting = settings.get(edit.key);
    if (setting === undefined) {
      const message = `${edit.key} is not a setting of file ${fileId}`;
      throw new FormatError("invalid-locator", message);
    }
    const doc = adapter.parse(current);
    const splices = editSplices(adapter, doc, setting, edit.value);
    current = adapter.apply(current, splices);
  }
  return current;
}

/**
 * The lint of a file: the adapter's syntax and structure issues, then the
 * pack's wrong-file and wrong-section warnings when the file parses.
 */
export function lintFile(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array,
): LintIssue[] {
  const file = packFileOf(pack, fileId);
  const adapter = adapterOf(file);
  const parsed = [
    ...adapter.lint(adapter.parse(bytes)),
    ...(evaluatedArgsFile(file) ? launchShellIssues(bytes) : []),
  ];
  if (parsed.some((issue) => issue.severity === "error")) return parsed;
  const issues = withoutKeyedDuplicates(pack, fileId, parsed);
  return [...issues, ...lintPackFile(pack, fileId, bytes)];
}
