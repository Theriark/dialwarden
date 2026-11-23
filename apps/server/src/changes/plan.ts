// What a change does, worked out without any I/O (contract C5): the semantic
// chips and text diffs between two versions of a file with secrets masked,
// the lint and validation issues of the files after the change, the issues
// that stop a write, and the settings an outside edit changed under an edit.
import {
  effectiveValues,
  lintFile,
  maskValue,
  readFileValues,
  ruleData,
  ruleFires,
  sameJson,
  SECRET_MASK,
  settingsOfFile,
  validate,
  type FileValues,
  type JsonValue,
  type Pack,
  type Setting,
  type SettingEdit,
} from "@dialwarden/packs-schema";
import { changedLineCount, unifiedDiff } from "./textdiff.js";
import type { Chip, ChipKind, ConflictSetting, LintEntry } from "./types.js";

/** Bytes as text, keeping a UTF-8 byte order mark as U+FEFF. */
export function decodeText(bytes: Uint8Array | null): string {
  if (bytes === null) return "";
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

const NO_VALUES: FileValues = { values: new Map(), invalid: [] };

function valuesIn(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array | null,
): FileValues {
  return bytes === null ? NO_VALUES : readFileValues(pack, fileId, bytes);
}

/** A value as the API may show it; "not set" stays null. */
export function shown(setting: Setting, value: JsonValue | undefined) {
  if (value === undefined || value === null) return null;
  return maskValue(setting, value);
}

function chipKind(
  setting: Setting,
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): ChipKind {
  if (setting.secret === true) return "masked";
  if (from === undefined) return "added";
  if (to === undefined) return "removed";
  return "changed";
}

/** The settings whose value differs between two versions of a file. */
export function semanticChips(
  pack: Pack,
  fileId: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
): Chip[] {
  const old = valuesIn(pack, fileId, before);
  const now = valuesIn(pack, fileId, after);
  const chips: Chip[] = [];
  for (const setting of settingsOfFile(pack, fileId)) {
    const from = old.values.get(setting.key);
    const to = now.values.get(setting.key);
    if (from === undefined && to === undefined) continue;
    if (from !== undefined && to !== undefined && sameJson(from, to)) continue;
    chips.push({
      kind: chipKind(setting, from, to),
      fileId,
      settingKey: setting.key,
      label: setting.label ?? setting.key,
      from: shown(setting, from),
      to: shown(setting, to),
      restartRequired: setting.restartRequired === true,
    });
  }
  return chips;
}

/** A chip for a file whose text changed without a known setting changing. */
export function lineChip(
  kind: "lines" | "external" | "import",
  fileId: string,
  before: string,
  after: string,
): Chip {
  const count = changedLineCount(before, after);
  const lines = `${count} ${count === 1 ? "line" : "lines"}`;
  const to = kind === "import" ? lines : `${lines} changed`;
  return {
    kind,
    fileId,
    settingKey: null,
    label: fileId,
    from: null,
    to,
    restartRequired: false,
  };
}

/** The non-empty values of the file's secret settings, longest first. */
function secretTexts(pack: Pack, fileId: string, versions: FileValues[]) {
  const found = new Set<string>();
  for (const setting of settingsOfFile(pack, fileId)) {
    if (setting.secret !== true) continue;
    for (const version of versions) {
      const value = version.values.get(setting.key);
      if (typeof value === "string" || typeof value === "number") {
        if (String(value) !== "") found.add(String(value));
      }
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * The unified diff of two versions of a file with every value of a secret
 * setting (as read from either version) replaced by the mask.
 */
export function maskedDiff(
  pack: Pack,
  fileId: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
): string {
  const versions = [
    valuesIn(pack, fileId, before),
    valuesIn(pack, fileId, after),
  ];
  let diff = unifiedDiff(fileId, decodeText(before), decodeText(after));
  for (const secret of secretTexts(pack, fileId, versions)) {
    diff = diff.replaceAll(secret, SECRET_MASK);
  }
  return diff;
}

/** The pack file a setting lives in, or null for an unknown key. */
function fileOfSetting(pack: Pack, key: string): string | null {
  return pack.settings.find((setting) => setting.key === key)?.file ?? null;
}

/** Every setting value of the given files, as the files hold them. */
export function allValues(
  pack: Pack,
  files: ReadonlyMap<string, Uint8Array | null>,
): Map<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  for (const [fileId, bytes] of files) {
    for (const [key, value] of valuesIn(pack, fileId, bytes).values) {
      values.set(key, value);
    }
  }
  return values;
}

/**
 * The lint of the given files (syntax, structure, wrong file or section) and
 * the validation issues of every setting value across all files. Rules
 * marked serverEvaluated run here on the real stored values and come back
 * marked, so the browser shows them without running them (THE-2361).
 */
export function lintEntries(
  pack: Pack,
  files: ReadonlyMap<string, Uint8Array | null>,
  linted: Iterable<string>,
): LintEntry[] {
  const entries: LintEntry[] = [];
  for (const fileId of linted) {
    const bytes = files.get(fileId);
    if (bytes === undefined || bytes === null) continue;
    for (const issue of lintFile(pack, fileId, bytes)) {
      entries.push({
        fileId,
        settingKey: null,
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        line: issue.line,
        column: issue.column,
        serverEvaluated: false,
      });
    }
  }
  const values = allValues(pack, files);
  const options = { includeServerEvaluated: false };
  for (const issue of validate(pack, values, options)) {
    entries.push({
      fileId: fileOfSetting(pack, issue.key),
      settingKey: issue.key,
      code: "validation",
      severity: issue.severity,
      message: issue.message,
      line: null,
      column: null,
      serverEvaluated: false,
    });
  }
  const data = ruleData(effectiveValues(pack, values));
  for (const rule of pack.rules) {
    if (rule.serverEvaluated !== true || !ruleFires(rule, data)) continue;
    for (const key of rule.settings) {
      entries.push({
        fileId: fileOfSetting(pack, key),
        settingKey: key,
        code: `rule:${rule.id}`,
        severity: rule.severity,
        message: rule.message,
        line: null,
        column: null,
        serverEvaluated: true,
      });
    }
  }
  return entries;
}

/**
 * The errors that stop a write: a syntax error in a file the change writes,
 * and an error on a setting whose value the change sets.
 */
export function blockingIssues(
  lint: readonly LintEntry[],
  changedKeys: ReadonlySet<string>,
  writtenFiles: ReadonlySet<string>,
): LintEntry[] {
  return lint.filter((entry) => {
    if (entry.severity !== "error") return false;
    if (entry.settingKey !== null) return changedKeys.has(entry.settingKey);
    return entry.fileId !== null && writtenFiles.has(entry.fileId);
  });
}

function sameValue(key: string, a: FileValues, b: FileValues): boolean {
  if (a.invalid.includes(key) !== b.invalid.includes(key)) return false;
  const left = a.values.get(key);
  const right = b.values.get(key);
  if (left === undefined || right === undefined) return left === right;
  return sameJson(left, right);
}

/**
 * The edited settings whose value an outside edit changed since the change
 * was made (base is the file then, current the file now). None means the
 * edits can be made again on the current file: the outside edit touched other
 * spans only (the automatic three-way merge of rnd-report-1 2.7).
 */
export function editConflicts(
  pack: Pack,
  fileId: string,
  base: Uint8Array | null,
  current: Uint8Array | null,
  edits: readonly SettingEdit[],
): ConflictSetting[] {
  const then = valuesIn(pack, fileId, base);
  const now = valuesIn(pack, fileId, current);
  const settings = new Map(pack.settings.map((s) => [s.key, s]));
  const conflicts: ConflictSetting[] = [];
  for (const edit of edits) {
    const setting = settings.get(edit.key);
    if (setting === undefined || sameValue(edit.key, then, now)) continue;
    conflicts.push({
      settingKey: setting.key,
      label: setting.label ?? setting.key,
      base: shown(setting, then.values.get(setting.key)),
      ours: shown(setting, edit.value),
      theirs: shown(setting, now.values.get(setting.key)),
    });
  }
  return conflicts;
}
