// Format engine (interface contract C2): one adapter per configuration file
// format. Each adapter parses bytes, reads and edits values through locators,
// and returns splices, so a write changes only the bytes it must change.

import { cfgAdapter } from "./cfg.js";
import { iniAdapter, ueIniAdapter } from "./ini.js";
import { jsonAdapter, jsoncAdapter } from "./json.js";
import { launchAdapter, launchShellIssues, launchWords } from "./launch.js";
import { textListAdapter } from "./textlist.js";
import { luaAdapter } from "./lua.js";
import { shellVarAdapter, systemdEnvAdapter } from "./shellvar.js";
import type { FormatAdapter, Locator } from "./types.js";
import { xmlAdapter } from "./xml.js";

export * from "./types.js";
export { applySplices } from "./source.js";
export {
  cfgAdapter,
  iniAdapter,
  jsonAdapter,
  jsoncAdapter,
  launchAdapter,
  launchShellIssues,
  launchWords,
  luaAdapter,
  shellVarAdapter,
  systemdEnvAdapter,
  textListAdapter,
  ueIniAdapter,
  xmlAdapter,
};

/** Locator kinds of contract C2 (codec is an interface only in 27.0.0). */
export const FORMAT_IDS = [
  "ini",
  "struct",
  "json",
  "xml",
  "lua",
  "cfg",
  "shellvar",
  "launch",
  "codec",
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

export function isFormatId(value: string): value is FormatId {
  return (FORMAT_IDS as readonly string[]).includes(value);
}

/** Adapter ids, as a pack names them in files[].adapter (contract C3). */
export const ADAPTER_IDS = [
  "ueini",
  "ini",
  "json",
  "jsonc",
  "xml",
  "lua",
  "cfg",
  "shellvar",
  "shellvar-systemd",
  "launch",
  "textlist",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

const ADAPTERS = new Map<string, FormatAdapter>([
  ["ueini", ueIniAdapter],
  ["ini", iniAdapter],
  ["json", jsonAdapter],
  ["jsonc", jsoncAdapter],
  ["xml", xmlAdapter],
  ["lua", luaAdapter],
  ["cfg", cfgAdapter],
  ["shellvar", shellVarAdapter],
  ["shellvar-systemd", systemdEnvAdapter],
  ["launch", launchAdapter],
  ["textlist", textListAdapter],
]);

/** The adapter for an id, or undefined. */
export function getAdapter(id: string): FormatAdapter<Locator> | undefined {
  return ADAPTERS.get(id);
}

/**
 * The line ending a file already uses, so a write keeps it unchanged: that of
 * its first line, the same rule the adapters use for new lines.
 */
export function detectNewline(text: string): "\r\n" | "\n" {
  const lf = text.indexOf("\n");
  return lf > 0 && text.charAt(lf - 1) === "\r" ? "\r\n" : "\n";
}
