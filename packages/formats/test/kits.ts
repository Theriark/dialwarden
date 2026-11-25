/* eslint-disable security/detect-non-literal-fs-filename -- the package's own fixtures */
// One test kit per adapter: its fixtures, the characters its syntax uses, the
// values to write and how a written value reads back.

import { readdirSync, readFileSync } from "node:fs";
import { cfgLocators } from "../src/cfg.js";
import {
  cfgAdapter,
  iniAdapter,
  jsonAdapter,
  jsoncAdapter,
  launchAdapter,
  luaAdapter,
  shellVarAdapter,
  systemdEnvAdapter,
  ueIniAdapter,
  xmlAdapter,
  type FormatAdapter,
  type Locator,
  type ParsedDoc,
  type Value,
} from "../src/index.js";
import { iniLocators } from "../src/ini.js";
import { jsonLocators } from "../src/json.js";
import { launchLocators } from "../src/launch.js";
import { luaLocators } from "../src/lua.js";
import { shellVarLocators } from "../src/shellvar.js";
import { isRecord, sameValue } from "../src/values.js";
import { xmlLocators } from "../src/xml.js";
import {
  jsonValue,
  luaValue,
  scalarValue,
  textMatches,
  type Kit,
} from "./harness.js";

/** The fixture file names of one folder, SYNTHETIC.md left out. */
export function fixtureNames(folder: string): string[] {
  const dir = new URL(`../fixtures/${folder}/`, import.meta.url);
  const names = readdirSync(dir).filter((name) => name !== "SYNTHETIC.md");
  return names.sort();
}

/** The fixture files of one folder, SYNTHETIC.md left out. */
export function fixtures(folder: string): Uint8Array[] {
  return fixtureNames(folder).map((name) => fixture(`${folder}/${name}`));
}

export function fixture(path: string): Uint8Array {
  const url = new URL(`../fixtures/${path}`, import.meta.url);
  return new Uint8Array(readFileSync(url));
}

const LINES = ["\n", "\r\n", " ", "\t", "a", "Z", "1", "é", "﻿"];

function iniFresh(doc: ParsedDoc, unreal: boolean): Locator[] {
  const all = iniLocators(doc);
  const first = all.find((l) => l.kind === "ini");
  const section = first?.kind === "ini" ? first.section : "FuzzSection";
  const out: Locator[] = [{ kind: "ini", section, key: "FuzzKey" }];
  const struct = all.find((l) => l.kind === "struct");
  if (unreal && struct?.kind === "struct") {
    out.push({ kind: "struct", key: struct.key, field: "FuzzField" });
  }
  return out;
}

const INI = [...LINES, "[", "]", "=", ";", "#", '"', "\\", "(", ")", ","];

export const ueIniKit: Kit = {
  name: "ueini",
  adapter: ueIniAdapter,
  locators: iniLocators,
  fresh: (doc) => iniFresh(doc, true),
  values: scalarValue,
  matches: (value, got) => textMatches(value, got),
  cleared: (locator) => locator.kind === "struct",
  seeds: fixtures("ueini"),
  alphabet: [...INI, "+", "-", ".", "!", "OptionSettings="],
};

export const iniKit: Kit = {
  name: "ini",
  adapter: iniAdapter,
  locators: iniLocators,
  fresh: (doc) => iniFresh(doc, false),
  values: scalarValue,
  matches: (value, got) => textMatches(value, got),
  cleared: () => false,
  seeds: fixtures("ini"),
  alphabet: INI,
};

function jsonFresh(adapter: FormatAdapter): (doc: ParsedDoc) => Locator[] {
  return (doc) => {
    const root = adapter.get(doc, { kind: "json", pointer: "" });
    if (Array.isArray(root)) {
      return [{ kind: "json", pointer: `/${root.length}` }];
    }
    if (isRecord(root)) return [{ kind: "json", pointer: "/fuzzKey" }];
    return [];
  };
}

function jsonCleared(locator: Locator): boolean {
  return locator.kind === "json" && !/\/[0-9]+$/.test(locator.pointer);
}

const JSON_CHARS = [
  ...LINES,
  "{",
  "}",
  "[",
  "]",
  ":",
  ",",
  '"',
  "\\",
  "/",
  "*",
  "-",
  ".",
  "e",
  "true",
  "null",
];

function makeJsonKit(adapter: FormatAdapter): Kit {
  return {
    name: adapter.id,
    adapter,
    locators: jsonLocators,
    fresh: jsonFresh(adapter),
    values: jsonValue,
    matches: (value, got) => sameValue(value, got as Value | undefined),
    cleared: jsonCleared,
    seeds: fixtures("json"),
    alphabet: JSON_CHARS,
  };
}

export const jsonKit = makeJsonKit(jsonAdapter);
export const jsoncKit = makeJsonKit(jsoncAdapter);

export const xmlKit: Kit = {
  name: "xml",
  adapter: xmlAdapter,
  locators: xmlLocators,
  fresh: () => [{ kind: "xml", property: "FuzzProperty" }],
  values: scalarValue,
  matches: (value, got) => textMatches(value, got),
  cleared: () => true,
  seeds: fixtures("xml"),
  alphabet: [
    ...LINES,
    "<",
    ">",
    "/",
    "?",
    "!",
    "-",
    "=",
    '"',
    "'",
    "&",
    ";",
    "#",
    "property",
    "name",
    "value",
  ],
};

function luaFresh(doc: ParsedDoc): Locator[] {
  const out: Locator[] = [{ kind: "lua", path: ["FuzzVar"] }];
  const table = luaLocators(doc).find((locator) => {
    const value = luaAdapter.get(doc, locator);
    return Array.isArray(value) || isRecord(value);
  });
  if (table?.kind === "lua") {
    out.push({ kind: "lua", path: [...table.path, "fuzzKey"] });
  }
  return out;
}

export const luaKit: Kit = {
  name: "lua",
  adapter: luaAdapter,
  locators: luaLocators,
  fresh: luaFresh,
  values: luaValue,
  matches: (value, got) => sameValue(value, got as Value | undefined),
  cleared: (l) => l.kind === "lua" && typeof l.path.at(-1) === "string",
  seeds: fixtures("lua"),
  alphabet: [
    ...LINES,
    "{",
    "}",
    "[",
    "]",
    "=",
    ",",
    ";",
    "-",
    "--",
    '"',
    "'",
    "\\",
    ".",
    "return ",
    "true",
    "nil",
    "local ",
  ],
};

export const cfgKit: Kit = {
  name: "cfg",
  adapter: cfgAdapter,
  locators: cfgLocators,
  fresh: () => [{ kind: "cfg", command: "fuzz_command" }],
  values: scalarValue,
  matches: (value, got) => textMatches(value, got),
  cleared: () => true,
  seeds: fixtures("cfg"),
  alphabet: [...LINES, '"', ";", "//", "#", ".", "_"],
};

const SHELL = [...LINES, "=", '"', "'", "\\", "#", "_", "$", "`", ";"];

function shellKit(adapter: FormatAdapter, extra: readonly string[]): Kit {
  return {
    name: adapter.id,
    adapter,
    locators: shellVarLocators,
    fresh: () => [{ kind: "shellvar", name: "FUZZ_VAR" }],
    values: scalarValue,
    matches: (value, got) => textMatches(value, got),
    cleared: () => true,
    seeds: fixtures("shellvar"),
    alphabet: [...SHELL, ...extra],
  };
}

export const shellVarKit = shellKit(shellVarAdapter, ["export ", "(", "{"]);
export const systemdKit = shellKit(systemdEnvAdapter, []);

function launchMatches(value: Value, got: unknown, before: unknown): boolean {
  const bare = before === true || before === undefined;
  if (bare && value === true) return got === true;
  if (bare && value === false) return got === undefined;
  return textMatches(value, got);
}

export const launchKit: Kit = {
  name: "launch",
  adapter: launchAdapter,
  locators: launchLocators,
  fresh: () => [
    { kind: "launch", flag: "-fuzzflag" },
    { kind: "launch", flag: "?FuzzOption" },
  ],
  values: scalarValue,
  matches: launchMatches,
  cleared: () => true,
  seeds: fixtures("launch"),
  alphabet: [...LINES, "-", "+", "?", "=", '"', "'", "\\", "\\\n", "#", "$"],
};
