// Test helpers for packages/packs-schema. Outside src/, so never built.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pack, Setting } from "../src/types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the package's own test files and temporary test folders */

/** The packs folder that holds the synthetic test pack. */
export const TEST_PACKS = fileURLToPath(new URL("./packs/", import.meta.url));

/** The synthetic test pack folder. */
export const TEST_PACK_DIR = join(TEST_PACKS, "testpack");

/** A fresh copy of the synthetic test pack (tests may change the copy). */
export function testPack(): Pack {
  const file = join(TEST_PACK_DIR, "pack.json");
  return JSON.parse(readFileSync(file, "utf8")) as Pack;
}

/** A setting of a pack by key; throws when it is missing. */
export function settingOf(pack: Pack, key: string): Setting {
  const found = pack.settings.find((setting) => setting.key === key);
  if (found === undefined) throw new Error(`no setting ${key}`);
  return found;
}

/** The pack with one setting replaced by a changed copy. */
export function withSetting(
  pack: Pack,
  key: string,
  change: Partial<Setting>,
): Pack {
  const settings = pack.settings.map((setting) => {
    return setting.key === key ? { ...setting, ...change } : setting;
  });
  return { ...pack, settings };
}

/** A synthetic ACF fixture (fixtures/acf). */
export function acf(name: string): Uint8Array {
  return readFileSync(new URL(`../fixtures/acf/${name}`, import.meta.url));
}

/** A fixture of the test pack. */
export function packFixture(name: string): Uint8Array {
  return readFileSync(join(TEST_PACK_DIR, "fixtures", name));
}

/**
 * Copies the test pack into root/folder with a changed pack.json and,
 * optionally, changed fixtures (name to text; null removes the file).
 */
export function writeTestPack(
  root: string,
  folder: string,
  data: unknown,
  fixtures: Record<string, string | null> = {},
): string {
  const dir = join(root, folder);
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify(data, null, 2));
  const names = ["Game.ini", "Engine.ini", "launch.txt", "testserver.cfg"];
  const changed = new Map(Object.entries(fixtures));
  for (const name of [...names, "SYNTHETIC.md"]) {
    const text = changed.get(name);
    if (text === null) continue;
    const bytes = text ?? readFileSync(join(TEST_PACK_DIR, "fixtures", name));
    writeFileSync(join(dir, "fixtures", name), bytes);
  }
  return dir;
}
