// Test helpers for the game pack tests. A plain file, not a folder: every
// folder of packs/ is a pack. The image never holds it, because the packs
// package ships only pack.json files and fixtures (package.json "files").
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAdapter,
  type FormatAdapter,
  type Locator,
  type ParsedDoc,
  type Value,
} from "@dialwarden/formats";
import {
  checkValue,
  fromFileValue,
  type JsonValue,
  type Pack,
  type Rule,
  type Setting,
} from "@dialwarden/packs-schema";
import { fixtureName, readPack } from "@dialwarden/packs-schema/node";

/* eslint-disable security/detect-non-literal-fs-filename -- the pack folders of this repository */

/** The packs folder of the repository. */
export const PACKS_DIR = fileURLToPath(new URL("./", import.meta.url));

/** A pack of this folder, checked as the server loader checks it. */
export function loadPack(id: string): Pack {
  const check = readPack(join(PACKS_DIR, id), id);
  if (check.pack === null) {
    throw new Error(`${id}: ${check.problems.join("; ")}`);
  }
  return check.pack;
}

/** A setting of a pack by key; throws when it is missing. */
export function settingOf(pack: Pack, key: string): Setting {
  const found = pack.settings.find((setting) => setting.key === key);
  if (found === undefined) throw new Error(`${pack.id} has no setting ${key}`);
  return found;
}

/** A rule of a pack by id; throws when it is missing. */
export function ruleOf(pack: Pack, id: string): Rule {
  const found = pack.rules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`${pack.id} has no rule ${id}`);
  return found;
}

export interface Fixture {
  readonly adapter: FormatAdapter;
  readonly bytes: Uint8Array;
  readonly doc: ParsedDoc;
}

/** The synthetic fixture of a file of a pack, parsed by the file's adapter. */
export function fixtureOf(pack: Pack, fileId: string): Fixture {
  const file = pack.files.find((candidate) => candidate.id === fileId);
  if (file === undefined) throw new Error(`${pack.id} has no file ${fileId}`);
  const adapter = getAdapter(file.adapter);
  if (adapter === undefined) throw new Error(`no adapter ${file.adapter}`);
  const path = join(PACKS_DIR, pack.id, "fixtures", fixtureName(file));
  const bytes = new Uint8Array(readFileSync(path));
  return { adapter, bytes, doc: adapter.parse(bytes) };
}

/**
 * The typed value of a setting in a parsed file. A bare launch flag that is
 * not given reads as off, since leaving it out is how it is turned off.
 */
export function readSetting(
  adapter: FormatAdapter,
  doc: ParsedDoc,
  setting: Setting,
): JsonValue | undefined {
  const value = adapter.get(doc, setting.locator);
  if (value === undefined) {
    const bareFlag = adapter.id === "launch" && setting.type === "bool";
    return bareFlag ? false : undefined;
  }
  return fromFileValue(setting, value);
}

/** The bytes after writing a value: set when it is there, insert when not. */
export function writeSetting(
  adapter: FormatAdapter,
  doc: ParsedDoc,
  locator: Locator,
  value: JsonValue,
): Uint8Array {
  const fileValue = value as Value;
  const exists = adapter.get(doc, locator) !== undefined;
  const splices = exists
    ? adapter.set(doc, locator, fileValue)
    : adapter.insert(doc, locator, fileValue);
  return adapter.apply(doc.bytes, splices);
}

/** Every setting value of a pack as its synthetic fixtures hold it. */
export function fixtureValues(pack: Pack): Map<string, JsonValue> {
  const fixtures = new Map<string, Fixture>();
  const values = new Map<string, JsonValue>();
  for (const setting of pack.settings) {
    const fixture = fixtures.get(setting.file) ?? fixtureOf(pack, setting.file);
    fixtures.set(setting.file, fixture);
    const value = readSetting(fixture.adapter, fixture.doc, setting);
    if (value !== undefined) values.set(setting.key, value);
  }
  return values;
}

/** A valid value of a setting that differs from the given one. */
export function otherValue(setting: Setting, current: JsonValue): JsonValue {
  switch (setting.type) {
    case "bool":
      return current !== true;
    case "enum": {
      const options = setting.enum ?? [];
      const other = options.find((option) => option.value !== current);
      if (other === undefined) throw new Error(`${setting.key}: one choice`);
      return other.value;
    }
    case "int":
    case "float":
    case "duration": {
      const step = setting.type === "duration" ? 60_000_000_000 : 1;
      const numbers = [setting.max, setting.min, Number(current) + step];
      for (const n of numbers) {
        if (n === undefined || n === current) continue;
        if (checkValue(setting, n) === undefined) return n;
      }
      throw new Error(`${setting.key}: no other valid number`);
    }
    case "string":
      return current === "dialwarden-a" ? "dialwarden-b" : "dialwarden-a";
    case "list": {
      const items: JsonValue[] = Array.isArray(current) ? [...current] : [];
      return items.length > 1 ? items.slice(0, 1) : [...items, "dialwarden-a"];
    }
    case "struct":
      throw new Error(`${setting.key}: no struct setting in these packs`);
  }
}
