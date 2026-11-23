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
  writeFileValues,
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

/** The diff shown instead when a secret in the file cannot be located. */
export const HIDDEN_DIFF_LINE =
  "diff hidden: the file holds secret settings and does not parse";

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
 * The text of a version with the value of every secret setting replaced by
 * the mask where the file holds it (by position, through the format adapter,
 * so an escaped value is masked too). Null when a secret cannot be located:
 * the file does not parse, or a secret's text does not fit its type.
 */
function maskedText(
  pack: Pack,
  fileId: string,
  secrets: readonly Setting[],
  bytes: Uint8Array | null,
  values: FileValues,
): string | null {
  if (bytes === null) return "";
  if (secrets.some((setting) => values.invalid.includes(setting.key))) {
    return null;
  }
  try {
    const broken = lintFile(pack, fileId, bytes).some(
      (issue) => issue.severity === "error",
    );
    if (broken) return null;
    const edits: SettingEdit[] = [];
    for (const setting of secrets) {
      const value = values.values.get(setting.key);
      if (value === undefined || value === null || value === "") continue;
      edits.push({ key: setting.key, value: SECRET_MASK });
    }
    return decodeText(writeFileValues(pack, fileId, bytes, edits));
  } catch {
    return null;
  }
}

/**
 * The unified diff of two versions of a file with every value of a secret
 * setting masked: by position in each version, then by value as a second
 * guard. A file with secret settings whose secrets cannot be located in
 * either version gets a fixed line instead of its diff.
 */
export function maskedDiff(
  pack: Pack,
  fileId: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
): string {
  const then = valuesIn(pack, fileId, before);
  const now = valuesIn(pack, fileId, after);
  const secrets = settingsOfFile(pack, fileId).filter(
    (setting) => setting.secret === true,
  );
  let oldText = decodeText(before);
  let newText = decodeText(after);
  if (secrets.length > 0) {
    const maskedOld = maskedText(pack, fileId, secrets, before, then);
    const maskedNew = maskedText(pack, fileId, secrets, after, now);
    if (maskedOld === null || maskedNew === null) {
      if (oldText === newText) return "";
      return `--- a/${fileId}\n+++ b/${fileId}\n${HIDDEN_DIFF_LINE}\n`;
    }
    oldText = maskedOld;
    newText = maskedNew;
  }
  let diff = unifiedDiff(fileId, oldText, newText);
  for (const secret of secretTexts(pack, fileId, [then, now])) {
    diff = diff.replaceAll(secret, SECRET_MASK);
    diff = diff.replaceAll(JSON.stringify(secret).slice(1, -1), SECRET_MASK);
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

/** Whether the file already holds the edit's value (null: not set). */
function holdsEdit(edit: SettingEdit, file: FileValues): boolean {
  if (file.invalid.includes(edit.key)) return false;
  const current = file.values.get(edit.key);
  if (edit.value === null) return current === undefined;
  return current !== undefined && sameJson(current, edit.value);
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
 * spans only (the automatic three-way merge of rnd-report-1 2.7). An edit
 * whose value the file already holds is no conflict: both sides made the
 * same change, as when a failed apply wrote part of a change set.
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
    if (holdsEdit(edit, now)) continue;
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
