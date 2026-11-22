// Text forms of values shared by the adapters.

import { FormatError, type Value } from "./types.js";

/**
 * Backslash escaping for double-quoted values (UE INI, INI): only \" and \\
 * are escapes and any other backslash is literal, so a Windows path such as
 * C:\Games survives a read and a write unchanged.
 */
export function escapeQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '"') out += '\\"';
    else if (ch !== "\\") out += ch;
    else if (next === '"' || next === "\\" || next === "") out += "\\\\";
    else out += "\\";
  }
  return out;
}

export function unescapeQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === "\\" && (next === '"' || next === "\\")) {
      out += next;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** True, False; true, false; TRUE, FALSE: keeps the style the file uses. */
export function booleanText(
  value: boolean,
  previous: string | undefined,
  fallback: "Title" | "lower",
): string {
  const word = value ? "true" : "false";
  if (previous === undefined || !/^(true|false)$/i.test(previous)) {
    return fallback === "Title" ? capitalise(word) : word;
  }
  if (previous === previous.toUpperCase()) return word.toUpperCase();
  if (previous === previous.toLowerCase()) return word;
  return capitalise(word);
}

/** A number in the decimal style of the previous value (1.000000 stays). */
export function numberText(
  value: number,
  previous: string | undefined,
): string {
  if (!Number.isFinite(value)) {
    throw new FormatError("invalid-value", `${value} is not a finite number`);
  }
  const match = /^[+-]?\d+\.(\d+)$/.exec(previous?.trim() ?? "");
  const decimals = match?.[1]?.length;
  if (decimals !== undefined && decimals <= 20) {
    const fixed = value.toFixed(decimals);
    if (Number(fixed) === value) return fixed;
  }
  return String(value);
}

export function isRecord(
  value: Value | undefined,
): value is { readonly [key: string]: Value } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality of two values (object key order does not matter). */
export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item: Value, i: number) => sameValue(item, b.at(i)));
  }
  if (isRecord(a) && isRecord(b)) {
    const left = new Map(Object.entries(a));
    const right = new Map(Object.entries(b));
    if (left.size !== right.size) return false;
    for (const [key, item] of left) {
      if (!right.has(key) || !sameValue(item, right.get(key))) return false;
    }
    return true;
  }
  return false;
}

/** Refuses values a configuration file cannot hold (NaN, Infinity). */
export function checkFinite(value: Value): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new FormatError("invalid-value", `${value} is not a finite number`);
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly Value[]) checkFinite(item);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) checkFinite(item);
  }
}
