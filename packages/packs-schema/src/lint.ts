// Wrong-file and wrong-section lint (dev-work-plan P3-A step 4), driven by the
// pack: a setting the pack places in another file, or in another section of
// this file, is found where it has no effect. ARK uses it in P7 for Game.ini
// keys written into GameUserSettings.ini.
import {
  FormatError,
  getAdapter,
  type FormatAdapter,
  type LintIssue,
  type Locator,
  type ParsedDoc,
} from "@dialwarden/formats";
import type { Pack, PackFile, Setting } from "./types.js";

const INI_FAMILY = new Set(["ini", "ueini"]);

/** Adapters that read each other's locators (plain and Unreal INI). */
function family(adapter: string): string {
  return INI_FAMILY.has(adapter) ? "ini" : adapter;
}

/** The sections the pack's INI settings name; null is before any section. */
function knownSections(pack: Pack): (string | null)[] {
  const sections = new Set<string | null>([null]);
  for (const setting of pack.settings) {
    if (setting.locator.kind === "ini") sections.add(setting.locator.section);
  }
  return [...sections];
}

/** The places a setting's key could be written in a document. */
function candidates(setting: Setting, sections: (string | null)[]) {
  const locator = setting.locator;
  if (locator.kind !== "ini") return [locator];
  const out: Locator[] = [];
  for (const section of sections) {
    out.push({ kind: "ini", section, key: locator.key });
  }
  return out;
}

function present(
  adapter: FormatAdapter,
  doc: ParsedDoc,
  locator: Locator,
): boolean {
  try {
    return adapter.get(doc, locator) !== undefined;
  } catch (error) {
    if (error instanceof FormatError) return error.code === "ambiguous";
    throw error;
  }
}

/** 1-based line and column of a byte offset (a UTF-8 BOM is not counted). */
function position(doc: ParsedDoc, offset: number) {
  const from = doc.bom ? 3 : 0;
  const before = doc.bytes.subarray(from, Math.max(from, offset));
  const lines = new TextDecoder().decode(before).split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/** Where a value starts: the first byte its removal would change. */
function where(adapter: FormatAdapter, doc: ParsedDoc, locator: Locator) {
  try {
    const starts = adapter.remove(doc, locator).map((splice) => splice.start);
    return position(doc, starts.length > 0 ? Math.min(...starts) : 0);
  } catch {
    return { line: 1, column: 1 };
  }
}

/** The name of a file as the user sees it: the last part of its first path. */
function fileName(file: PackFile): string {
  const path = file.paths.linux?.at(0) ?? file.paths.windows?.at(0) ?? file.id;
  return path.split("/").at(-1) ?? path;
}

function sectionName(section: string | null): string {
  return section === null ? "before the first section" : `[${section}]`;
}

function wrongFile(setting: Setting, home: PackFile): string {
  const name = fileName(home);
  return `${setting.key} belongs in ${name}; it has no effect in this file.`;
}

function wrongSection(setting: Setting, found: string | null): string {
  const locator = setting.locator;
  const wanted = sectionName(locator.kind === "ini" ? locator.section : null);
  const was = sectionName(found);
  return `${setting.key} belongs in section ${wanted}, not ${was}.`;
}

/** A key for comparing locators (array index aside). */
function locatorKey(locator: Locator): string {
  if (locator.kind === "ini") {
    return JSON.stringify([locator.kind, locator.section, locator.key]);
  }
  return JSON.stringify(locator);
}

/**
 * Wrong-file and wrong-section warnings for one file of a pack. A key that a
 * setting of this file also uses where it was found is never reported.
 */
export function lintPackFile(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array,
): LintIssue[] {
  const files = new Map(pack.files.map((file) => [file.id, file]));
  const file = files.get(fileId);
  const adapter = file && getAdapter(file.adapter);
  if (file === undefined || adapter === undefined) {
    throw new Error(`pack ${pack.id} has no file ${fileId}`);
  }
  const doc = adapter.parse(bytes);
  const sections = knownSections(pack);
  const own = new Set<string>();
  for (const setting of pack.settings) {
    if (setting.file === fileId) own.add(locatorKey(setting.locator));
  }
  const issues = new Map<string, LintIssue>();
  for (const setting of pack.settings) {
    const home = files.get(setting.file);
    if (home === undefined) continue;
    if (family(home.adapter) !== family(file.adapter)) continue;
    for (const locator of candidates(setting, sections)) {
      if (own.has(locatorKey(locator))) continue;
      if (!present(adapter, doc, locator)) continue;
      const elsewhere = setting.file !== fileId;
      const found = locator.kind === "ini" ? locator.section : null;
      const message = elsewhere
        ? wrongFile(setting, home)
        : wrongSection(setting, found);
      const code = elsewhere ? "wrong-file" : "wrong-section";
      const at = where(adapter, doc, locator);
      const key = `${code}:${at.line}:${at.column}:${setting.key}`;
      issues.set(key, { code, severity: "warning", ...at, message, locator });
    }
  }
  const sorted = [...issues.values()];
  sorted.sort((a, b) => a.line - b.line || a.column - b.column);
  return sorted;
}
