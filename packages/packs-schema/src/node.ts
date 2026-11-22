// The Node part of the pack package (@dialwarden/packs-schema/node): the loader
// the server runs at start, and the fixture checks of pnpm packs:check. The
// browser imports the package root and never this file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getAdapter,
  type FormatAdapter,
  type ParsedDoc,
} from "@dialwarden/formats";
import { checkPack, type PackCheck } from "./check.js";
import { sameAsDefault } from "./coerce.js";
import type { Pack, PackFile } from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- folders of the packs folder the server or the check is given, and fixed names inside them */

/** The largest pack.json the loader reads. */
export const MAX_PACK_BYTES = 2 * 1024 * 1024;

/** What the loader logs through (pino and Fastify's logger fit). */
export interface PackLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
}

export interface RefusedPack {
  readonly folder: string;
  readonly problems: readonly string[];
}

export interface LoadedPacks {
  /** The packs by id, in folder name order. Each pack is frozen. */
  readonly packs: ReadonlyMap<string, Pack>;
  readonly refused: readonly RefusedPack[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function refuse(problem: string): PackCheck {
  return { pack: null, problems: [problem] };
}

/** The pack folders under a packs folder (pnpm and hidden folders aside). */
export function packFolders(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "node_modules" && !name.startsWith("."))
    .sort();
}

/** Reads and checks folder/pack.json; the folder name must be the pack id. */
export function readPack(dir: string, folder: string): PackCheck {
  const file = join(dir, "pack.json");
  let text: string;
  try {
    if (statSync(file).size > MAX_PACK_BYTES) {
      return refuse("pack.json is larger than 2 MiB");
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse(`pack.json cannot be read: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return refuse(`pack.json is not valid JSON: ${(error as Error).message}`);
  }
  const check = checkPack(data);
  if (check.pack !== null && check.pack.id !== folder) {
    return refuse(`the folder ${folder} must be named like the pack id`);
  }
  return check;
}

/**
 * Loads every packs/GAME/pack.json at server start. A broken pack is refused
 * with one log line naming its problems; it never stops the server.
 */
export function loadPacks(root: string, log?: PackLogger): LoadedPacks {
  const packs = new Map<string, Pack>();
  const refused: RefusedPack[] = [];
  if (!existsSync(root)) {
    log?.warn({ dir: root }, "game packs folder not found; no packs loaded");
    return { packs, refused };
  }
  for (const folder of packFolders(root)) {
    const dir = join(root, folder);
    if (!existsSync(join(dir, "pack.json"))) continue;
    const check = readPack(dir, folder);
    if (check.pack === null) {
      const problems = check.problems.slice(0, 20);
      refused.push({ folder, problems: check.problems });
      log?.error({ pack: folder, problems }, "game pack refused");
      continue;
    }
    packs.set(check.pack.id, deepFreeze(check.pack));
  }
  const ids = [...packs.values()].map((p) => `${p.id}@${p.version}`);
  log?.info({ packs: ids, refused: refused.length }, "game packs loaded");
  return { packs, refused };
}

/** The fixture of a file: fixtures/ and the last part of its first path. */
export function fixtureName(file: PackFile): string {
  const path = file.paths.linux?.at(0) ?? file.paths.windows?.at(0) ?? file.id;
  return path.split("/").at(-1) ?? path;
}

interface Fixture {
  readonly name: string;
  readonly adapter: FormatAdapter;
  readonly doc: ParsedDoc;
}

function readFixtures(
  pack: Pack,
  dir: string,
  problems: string[],
): Map<string, Fixture> {
  const fixtures = new Map<string, Fixture>();
  for (const file of pack.files) {
    const name = fixtureName(file);
    const path = join(dir, "fixtures", name);
    const adapter = getAdapter(file.adapter);
    if (adapter === undefined || !existsSync(path)) {
      problems.push(`file ${file.id}: fixtures/${name} is missing`);
      continue;
    }
    const doc = adapter.parse(readFileSync(path));
    for (const issue of doc.issues.filter((i) => i.severity === "error")) {
      const at = `${issue.line}:${issue.column}`;
      problems.push(`fixtures/${name}:${at}: ${issue.message}`);
    }
    fixtures.set(file.id, { name, adapter, doc });
  }
  return fixtures;
}

function synthetic(dir: string, problems: string[]): void {
  const folder = join(dir, "fixtures");
  const list = join(folder, "SYNTHETIC.md");
  if (!existsSync(list)) {
    problems.push("fixtures/SYNTHETIC.md is missing");
    return;
  }
  const text = readFileSync(list, "utf8");
  for (const name of readdirSync(folder).sort()) {
    if (name !== "SYNTHETIC.md" && !text.includes(name)) {
      problems.push(`fixtures/${name} is not listed in SYNTHETIC.md`);
    }
  }
}

/**
 * The fixture checks of one pack: every file has a synthetic fixture that
 * parses, every setting locator resolves on its fixture, and every default
 * equals the fixture value where the fixture sets one.
 */
export function fixtureProblems(pack: Pack, dir: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(dir, "fixtures"))) {
    return ["the fixtures folder is missing"];
  }
  synthetic(dir, problems);
  const fixtures = readFixtures(pack, dir, problems);
  for (const setting of pack.settings) {
    const fixture = fixtures.get(setting.file);
    if (fixture === undefined) continue;
    const at = `setting ${setting.key}`;
    let value;
    try {
      value = fixture.adapter.get(fixture.doc, setting.locator);
    } catch (error) {
      const reason = (error as Error).message;
      problems.push(`${at}: the locator fails on ${fixture.name}: ${reason}`);
      continue;
    }
    if (value === undefined) {
      problems.push(`${at}: the locator does not resolve on ${fixture.name}`);
    } else if (
      setting.default !== undefined &&
      !sameAsDefault(setting, value, setting.default)
    ) {
      problems.push(`${at}: the default differs from ${fixture.name}`);
    }
  }
  return problems;
}

export interface PackReport {
  readonly folder: string;
  readonly problems: readonly string[];
}

/**
 * pnpm packs:check over a packs folder: every folder holds a pack.json that
 * passes the loader's checks and the fixture checks.
 */
export function checkPacksFolder(root: string): PackReport[] {
  const reports: PackReport[] = [];
  for (const folder of packFolders(root)) {
    const dir = join(root, folder);
    if (!existsSync(join(dir, "pack.json"))) {
      reports.push({ folder, problems: ["pack.json is missing"] });
      continue;
    }
    const check = readPack(dir, folder);
    const problems = [...check.problems];
    if (check.pack !== null) problems.push(...fixtureProblems(check.pack, dir));
    reports.push({ folder, problems });
  }
  return reports;
}
