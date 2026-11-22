// Checks of a parsed pack.json: the JSON Schema first, then what a schema
// cannot say (references between settings, files, rules and presets). The
// server loader refuses a pack with any problem; pnpm packs:check adds the
// fixture checks on top (node.ts).
import { checkRules } from "./rules.js";
import { schemaProblems } from "./schema.js";
import type { Pack, Setting } from "./types.js";
import { checkValue } from "./validate.js";

/** Locator kinds each adapter reads (codec works with every adapter). */
const LOCATOR_KINDS = new Map<string, readonly string[]>([
  ["ueini", ["ini", "struct"]],
  ["ini", ["ini"]],
  ["json", ["json"]],
  ["jsonc", ["json"]],
  ["xml", ["xml"]],
  ["lua", ["lua"]],
  ["cfg", ["cfg"]],
  ["shellvar", ["shellvar"]],
  ["shellvar-systemd", ["shellvar"]],
  ["launch", ["launch"]],
]);

/** Key parts a rule could use to reach outside the values. */
const RESERVED_PARTS = new Set(["__proto__", "constructor", "prototype"]);

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return [...twice];
}

/** A relative path that stays inside the server root. */
export function safeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== ".." && part !== "");
}

function settingProblems(pack: Pack, setting: Setting): string[] {
  const problems: string[] = [];
  const at = `setting ${setting.key}`;
  const file = pack.files.find((candidate) => candidate.id === setting.file);
  if (file === undefined) {
    problems.push(`${at}: file ${setting.file} is not a file of the pack`);
  } else {
    const kinds = LOCATOR_KINDS.get(file.adapter) ?? [];
    const kind = setting.locator.kind;
    if (kind !== "codec" && !kinds.includes(kind)) {
      problems.push(`${at}: a ${kind} locator does not fit ${file.adapter}`);
    }
  }
  if (setting.key.split(".").some((part) => RESERVED_PARTS.has(part))) {
    problems.push(`${at}: the key uses a reserved name`);
  }
  if (setting.enum !== undefined && setting.type !== "enum") {
    problems.push(`${at}: only an enum setting lists choices`);
  }
  const values = (setting.enum ?? []).map((option) => String(option.value));
  for (const value of duplicates(values)) {
    problems.push(`${at}: choice ${value} is listed twice`);
  }
  if (setting.itemEnum !== undefined && setting.type !== "list") {
    problems.push(`${at}: only a list setting lists item choices`);
  }
  const items = (setting.itemEnum ?? []).map((option) => String(option.value));
  for (const value of duplicates(items)) {
    problems.push(`${at}: item choice ${value} is listed twice`);
  }
  const { min, max } = setting;
  if (min !== undefined && max !== undefined && min > max) {
    problems.push(`${at}: min is greater than max`);
  }
  if (setting.default !== undefined) {
    const problem = checkValue(setting, setting.default);
    if (problem !== undefined) {
      problems.push(`${at}: the default is invalid: ${problem}`);
    }
  }
  return problems;
}

/** Problems of the references inside a pack that matches the schema. */
export function referenceProblems(pack: Pack): string[] {
  const problems: string[] = [];
  const keys = pack.settings.map((setting) => setting.key);
  for (const key of duplicates(keys)) {
    problems.push(`setting ${key} is listed twice`);
  }
  for (const key of keys) {
    if (keys.some((other) => other.startsWith(`${key}.`))) {
      problems.push(`setting ${key} is also the start of another key`);
    }
  }
  for (const id of duplicates(pack.files.map((file) => file.id))) {
    problems.push(`file ${id} is listed twice`);
  }
  for (const id of duplicates(pack.presets.map((preset) => preset.id))) {
    problems.push(`preset ${id} is listed twice`);
  }
  const to = pack.builds.to ?? null;
  if (to !== null && to < pack.builds.from) {
    problems.push("builds.to is before builds.from");
  }
  for (const file of pack.files) {
    for (const [os, paths] of Object.entries(file.paths)) {
      if (!pack.os.some((name) => name === os)) {
        problems.push(`file ${file.id}: ${os} is not an os of the pack`);
      }
      for (const path of paths ?? []) {
        if (!safeRelativePath(path)) {
          problems.push(`file ${file.id}: ${path} leaves the server folder`);
        }
      }
    }
  }
  const markers = [
    ...pack.detection.markers,
    ...(pack.detection.warnings ?? []),
  ];
  for (const marker of markers) {
    if (!safeRelativePath(marker.path)) {
      problems.push(`detection: ${marker.path} leaves the server folder`);
    }
  }
  for (const setting of pack.settings) {
    problems.push(...settingProblems(pack, setting));
  }
  problems.push(...checkRules(pack));
  const settings = new Map(pack.settings.map((s) => [s.key, s]));
  for (const preset of pack.presets) {
    for (const [key, value] of Object.entries(preset.values)) {
      const setting = settings.get(key);
      if (setting === undefined) {
        problems.push(`preset ${preset.id}: ${key} is not a setting`);
        continue;
      }
      const problem = checkValue(setting, value);
      if (problem !== undefined) {
        problems.push(`preset ${preset.id}: ${key}: ${problem}`);
      }
    }
  }
  return problems;
}

export interface PackCheck {
  /** The pack, when it has no problem. */
  readonly pack: Pack | null;
  readonly problems: readonly string[];
}

/** Checks a parsed pack.json: the schema, then the references. */
export function checkPack(data: unknown): PackCheck {
  const fromSchema = schemaProblems(data);
  if (fromSchema.length > 0) return { pack: null, problems: fromSchema };
  const pack = data as Pack;
  const problems = referenceProblems(pack);
  return { pack: problems.length === 0 ? pack : null, problems };
}
