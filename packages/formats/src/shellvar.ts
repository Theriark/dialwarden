// Shell variable files. "shellvar" follows the shell (LinuxGSM cfg files and
// .env files): NAME=value with an optional export, '...' literal, "..." with
// \ escapes for \ " $ and `, and # comments. "shellvar-systemd" follows a
// systemd EnvironmentFile: one NAME=value per line, # and ; comment lines,
// and an unquoted value that runs to the end of the line.
//
// Nothing is expanded: a value with $NAME is read and written as text. As in
// the shell, the last assignment wins: get and set use it, remove removes all.

import { appendLines, lineRange, mergeRanges, verified } from "./edits.js";
import {
  applySplices,
  hasLineBreak,
  own,
  Source,
  sortedIssues,
  writable,
  wrongLocator,
} from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type ParsedDoc,
  type ShellVarLocator,
  type Value,
} from "./types.js";
import { booleanText, numberText } from "./values.js";

type Style = "bare" | "double" | "single" | "mixed";

interface Assignment {
  readonly name: string;
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: string;
  readonly style: Style;
  /** True when the value uses an unescaped $ or ` (shell expansion). */
  readonly expands: boolean;
}

interface ShellDoc extends ParsedDoc {
  readonly source: Source;
  readonly assignments: readonly Assignment[];
}

interface Dialect {
  readonly id: string;
  readonly systemd: boolean;
}

class ParseFail extends Error {
  readonly offset: number;

  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function scanName(text: string, from: number): number {
  let i = from;
  while (/[A-Za-z0-9_]/.test(text.charAt(i))) i++;
  return /[A-Za-z_]/.test(text.charAt(from)) ? i : from;
}

function decodeBytes(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// Shell dialect -------------------------------------------------------------

interface Word {
  readonly end: number;
  readonly value: string;
  readonly style: Style;
  readonly expands: boolean;
}

function shellWord(text: string, start: number): Word {
  const bytes: number[] = [];
  const parts: string[] = [];
  let expands = false;
  let i = start;
  for (;;) {
    const c = text.charAt(i);
    if (c === "" || /[ \t\n\r\f\v;&|<>()]/.test(c)) break;
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new ParseFail(i, "the ' is not closed");
      for (let j = i + 1; j < close; j++) bytes.push(text.charCodeAt(j));
      parts.push("single");
      i = close + 1;
    } else if (c === '"') {
      i = doubleQuoted(text, i, bytes, () => (expands = true));
      parts.push("double");
    } else if (c === "\\") {
      const next = text.charAt(i + 1);
      if (next !== "\n" && next !== "") bytes.push(text.charCodeAt(i + 1));
      parts.push("bare");
      i += next === "" ? 1 : 2;
    } else {
      if (c === "$" || c === "`") expands = true;
      bytes.push(text.charCodeAt(i));
      parts.push("bare");
      i++;
    }
  }
  const style = styleOf(parts);
  return { end: i, value: decodeBytes(bytes), style, expands };
}

function styleOf(parts: readonly string[]): Style {
  if (new Set(parts).size > 1) return "mixed";
  const only = parts.at(0);
  return only === "single" || only === "double" ? only : "bare";
}

function doubleQuoted(
  text: string,
  open: number,
  bytes: number[],
  expansion: () => void,
): number {
  let i = open + 1;
  for (;;) {
    const c = text.charAt(i);
    if (c === "") throw new ParseFail(open, 'the " is not closed');
    if (c === '"') return i + 1;
    const next = text.charAt(i + 1);
    if (c === "\\" && next === "\n") {
      i += 2;
    } else if (c === "\\" && /[\\"$`]/.test(next)) {
      bytes.push(text.charCodeAt(i + 1));
      i += 2;
    } else {
      if (c === "$" || c === "`") expansion();
      bytes.push(text.charCodeAt(i));
      i++;
    }
  }
}

function parseShell(src: Source): Assignment[] {
  const text = src.text;
  const out: Assignment[] = [];
  let i = src.begin;
  for (;;) {
    while (/[ \t\n\r\f\v]/.test(text.charAt(i))) i++;
    if (i >= text.length) return out;
    const line = src.lineAt(i);
    if (text.charAt(i) === "#") {
      i = line.next;
      continue;
    }
    const start = i;
    if (text.startsWith("export", i) && /[ \t]/.test(text.charAt(i + 6))) {
      i = src.skipBlank(i + 6, line.end);
    }
    const nameEnd = scanName(text, i);
    if (nameEnd === i || text.charAt(nameEnd) !== "=") {
      throw new ParseFail(start, "expected NAME=value or a # comment");
    }
    const word = shellWord(text, nameEnd + 1);
    const after = src.skipBlank(word.end, text.length);
    const rest = text.charAt(after);
    if (rest !== "" && rest !== "#" && rest !== "\n" && rest !== "\r") {
      throw new ParseFail(after, "only one NAME=value per line is supported");
    }
    if (word.expands) {
      const message = "the shell expands $ and `; shown as written";
      src.issue(nameEnd + 1, "expansion", "info", message);
    }
    out.push({
      name: src.slice(i, nameEnd),
      start,
      valueStart: nameEnd + 1,
      valueEnd: word.end,
      value: word.value,
      style: word.style,
      expands: word.expands,
    });
    i = src.lineAt(word.end).next;
  }
}

// systemd dialect -----------------------------------------------------------

function parseSystemd(src: Source): Assignment[] {
  const text = src.text;
  const out: Assignment[] = [];
  for (const line of src.lines) {
    const start = src.skipBlank(line.start, line.end);
    const first = text.charAt(start);
    if (start === line.end || first === "#" || first === ";") continue;
    const nameEnd = scanName(text, start);
    const eq = src.skipBlank(nameEnd, line.end);
    if (nameEnd === start || text.charAt(eq) !== "=") {
      throw new ParseFail(start, "expected NAME=value or a comment");
    }
    const valueStart = src.skipBlank(eq + 1, line.end);
    const valueEnd = src.trimEnd(valueStart, line.end);
    if (text.charAt(valueEnd - 1) === "\\" && valueEnd > valueStart) {
      throw new ParseFail(valueEnd - 1, "line continuations are not supported");
    }
    const raw = src.slice(valueStart, valueEnd);
    const { value, style } = systemdValue(raw, valueStart);
    const name = src.slice(start, nameEnd);
    const expands = false;
    out.push({ name, start, valueStart, valueEnd, value, style, expands });
  }
  return out;
}

interface Decoded {
  readonly value: string;
  readonly style: Style;
}

function systemdValue(raw: string, at: number): Decoded {
  const quote = raw.charAt(0);
  if (quote !== '"' && quote !== "'") return { value: raw, style: "bare" };
  if (raw.length < 2 || !raw.endsWith(quote)) {
    throw new ParseFail(at, `the ${quote} must close at the line end`);
  }
  const body = raw.slice(1, -1);
  if (quote === "'") {
    if (body.includes("'")) throw new ParseFail(at, "' inside '...'");
    return { value: body, style: "single" };
  }
  let value = "";
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    const next = body.charAt(i + 1);
    if (c === '"') throw new ParseFail(at, '" inside "..." needs a \\');
    if (c === "\\" && /[\\"$`]/.test(next)) {
      value += next;
      i++;
    } else {
      value += c;
    }
  }
  return { value, style: "double" };
}

// Adapter -------------------------------------------------------------------

function parse(dialect: Dialect, bytes: Uint8Array): ShellDoc {
  const src = new Source(bytes);
  let assignments: Assignment[] = [];
  try {
    assignments = dialect.systemd ? parseSystemd(src) : parseShell(src);
  } catch (fail) {
    if (!(fail instanceof ParseFail)) throw fail;
    src.issue(fail.offset, "syntax", "error", fail.message);
  }
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.name)) {
      const message = `${assignment.name} is set more than once; the last wins`;
      const name = assignment.name;
      const locator: ShellVarLocator = { kind: "shellvar", name };
      const at = assignment.start;
      src.issue(at, "duplicate-key", "warning", message, locator);
    }
    seen.add(assignment.name);
  }
  return { ...src.doc(dialect.id), source: src, assignments };
}

function scalar(value: Value, previous: string | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberText(value, previous);
  if (typeof value === "boolean") return booleanText(value, previous, "lower");
  throw new FormatError("invalid-value", "use text, a number or a boolean");
}

/**
 * A double-quoted shell value. $ and ` are escaped (kept as text) unless the
 * value being replaced already used expansions such as ${port}, so a value
 * read and written back keeps its meaning.
 */
function doubleQuote(text: string, expands: boolean): string {
  const special = expands ? /[\\"]/g : /[\\"$`]/g;
  return `"${text.replace(special, (c) => `\\${c}`)}"`;
}

function valueText(
  dialect: Dialect,
  text: string,
  style: Style,
  expands: boolean,
): string {
  if (hasLineBreak(text)) {
    throw new FormatError("invalid-value", "a value cannot hold a line break");
  }
  if (style === "single" && !text.includes("'")) return `'${text}'`;
  if (dialect.systemd) {
    const padded = text !== text.trim() || /^["']/.test(text);
    if (style === "double" || padded) {
      return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    }
    return text;
  }
  const safe = /^[A-Za-z0-9_./:@%+,=-]*$/.test(text);
  return style === "bare" && safe ? text : doubleQuote(text, expands);
}

function statementRange(src: Source, assignment: Assignment) {
  const first = src.lineAt(assignment.start);
  const last = src.lineAt(assignment.valueEnd);
  const after = src.skipBlank(assignment.valueEnd, last.end);
  const tail = after >= last.end || src.text.charAt(after) === "#";
  if (src.blank(first.start, assignment.start) && tail) {
    return lineRange(src, first, last);
  }
  return { start: assignment.start, end: assignment.valueEnd };
}

function createShellVarAdapter(
  dialect: Dialect,
): FormatAdapter<ShellVarLocator> {
  const { id } = dialect;

  function find(doc: ShellDoc, locator: ShellVarLocator): Assignment[] {
    if (locator.kind !== "shellvar") throw wrongLocator(id, locator);
    if (typeof locator.name !== "string" || !NAME.test(locator.name)) {
      throw new FormatError("invalid-locator", `${id}: not a variable name`);
    }
    return doc.assignments.filter((a) => a.name === locator.name);
  }

  const adapter: FormatAdapter<ShellVarLocator> = {
    id,
    parse: (bytes) => parse(dialect, bytes),
    get(doc, locator) {
      return find(own<ShellDoc>(doc, id), locator).at(-1)?.value;
    },
    set(doc, locator, value) {
      const shell = own<ShellDoc>(doc, id);
      writable(shell);
      const target = find(shell, locator).at(-1);
      if (target === undefined) {
        throw new FormatError("not-found", `${locator.name} does not exist`);
      }
      const style = target.style === "mixed" ? "double" : target.style;
      const raw = scalar(value, target.value);
      const text = valueText(dialect, raw, style, target.expands);
      const splice = { start: target.valueStart, end: target.valueEnd, text };
      return verified(adapter, shell, [splice]);
    },
    insert(doc, locator, value) {
      const shell = own<ShellDoc>(doc, id);
      writable(shell);
      if (find(shell, locator).length > 0) {
        throw new FormatError("exists", `${locator.name} already exists`);
      }
      const style = dialect.systemd ? "bare" : "double";
      const text = valueText(dialect, scalar(value, undefined), style, false);
      const line = `${locator.name}=${text}`;
      return verified(adapter, shell, [appendLines(shell.source, [line])]);
    },
    remove(doc, locator) {
      const shell = own<ShellDoc>(doc, id);
      writable(shell);
      const found = find(shell, locator);
      const ranges = found.map((a) => statementRange(shell.source, a));
      return verified(adapter, shell, mergeRanges(ranges));
    },
    lint: (doc) => sortedIssues(own<ShellDoc>(doc, id)),
    apply: (bytes, splices) => applySplices(bytes, splices),
  };
  return adapter;
}

/** LinuxGSM cfg and .env files (shell quoting). */
export const shellVarAdapter = createShellVarAdapter({
  id: "shellvar",
  systemd: false,
});

/** systemd EnvironmentFile. */
export const systemdEnvAdapter = createShellVarAdapter({
  id: "shellvar-systemd",
  systemd: true,
});

/** Every variable locator of a parsed document, for tests and fuzzing. */
export function shellVarLocators(doc: ParsedDoc): ShellVarLocator[] {
  const names = (doc as ShellDoc).assignments.map((a) => a.name);
  const unique = names.filter((n, i) => names.indexOf(n) === i);
  return unique.map((name): ShellVarLocator => ({ kind: "shellvar", name }));
}
