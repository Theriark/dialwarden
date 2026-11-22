// Lua table constructors, the subset game settings use (Project Zomboid's
// SandboxVars = { ... }, Don't Starve Together's return { ... }): global
// assignments or one return statement, nested tables, -- comments, numbers,
// strings, booleans and nil. Anything else is reported and never written.

import {
  appendLines,
  indentOf,
  lineRange,
  mergeRanges,
  verified,
} from "./edits.js";
import {
  applySplices,
  own,
  Source,
  sortedIssues,
  writable,
  wrongLocator,
} from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type LuaLocator,
  type ParsedDoc,
  type Splice,
  type Value,
} from "./types.js";
import { checkFinite, isRecord, numberText } from "./values.js";

type Key = string | number;

interface LuaScalar {
  readonly kind: "number" | "string" | "boolean" | "nil";
  readonly start: number;
  readonly end: number;
}

interface LuaTable {
  readonly kind: "table";
  readonly start: number;
  readonly end: number;
  readonly fields: LuaField[];
}

type LuaNode = LuaScalar | LuaTable;

interface LuaField {
  readonly key: Key;
  readonly positional: boolean;
  readonly start: number;
  readonly end: number;
  /** Offset of the , or ; after the field, or -1. */
  sep: number;
  readonly value: LuaNode;
}

interface Assignment {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly value: LuaNode;
}

interface LuaDoc extends ParsedDoc {
  readonly source: Source;
  readonly assignments: readonly Assignment[];
  readonly returned: LuaTable | undefined;
}

interface Token {
  readonly type: "name" | "number" | "string" | "symbol" | "eof";
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

class ParseFail extends Error {
  readonly offset: number;
  readonly code: string;

  constructor(offset: number, code: string, message: string) {
    super(message);
    this.offset = offset;
    this.code = code;
  }
}

const KEYWORDS_A = "and break do else elseif end false for function goto if";
const KEYWORDS_B = "in local nil not or repeat return then true until while";
const RESERVED = new Set(`${KEYWORDS_A} ${KEYWORDS_B}`.split(" "));

function isIdentifier(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && !RESERVED.has(text);
}

// Lexer ---------------------------------------------------------------------

/** Length of a long bracket opener [[ or [==[ at i, or 0. */
function longBracket(text: string, i: number): number {
  if (text.charAt(i) !== "[") return 0;
  let j = i + 1;
  while (text.charAt(j) === "=") j++;
  return text.charAt(j) === "[" ? j - i + 1 : 0;
}

function skipLong(text: string, open: number, length: number): number {
  const close = `]${"=".repeat(length - 2)}]`;
  const end = text.indexOf(close, open + length);
  if (end < 0) {
    throw new ParseFail(open, "unclosed-long", "the [[ is not closed");
  }
  return end + close.length;
}

class Lexer {
  readonly text: string;
  pos: number;

  constructor(src: Source) {
    this.text = src.text;
    this.pos = src.begin;
  }

  private skip(): void {
    const text = this.text;
    for (;;) {
      const ch = text.charAt(this.pos);
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.pos++;
      } else if (ch === "\f" || ch === "\v") {
        this.pos++;
      } else if (text.startsWith("--", this.pos)) {
        const long = longBracket(text, this.pos + 2);
        if (long > 0) {
          this.pos = skipLong(text, this.pos + 2, long);
        } else {
          const nl = text.indexOf("\n", this.pos);
          this.pos = nl < 0 ? text.length : nl;
        }
      } else {
        return;
      }
    }
  }

  next(): Token {
    this.skip();
    const text = this.text;
    const start = this.pos;
    const ch = text.charAt(start);
    if (ch === "") return { type: "eof", start, end: start, text: "" };
    if (/[A-Za-z_]/.test(ch)) {
      let j = start + 1;
      while (/[A-Za-z0-9_]/.test(text.charAt(j))) j++;
      return this.token("name", start, j);
    }
    const digit = /[0-9]/.test(ch);
    const dot = ch === "." && /[0-9]/.test(text.charAt(start + 1));
    if (digit || dot) return this.number(start);
    if (ch === '"' || ch === "'") return this.shortString(start, ch);
    const long = longBracket(text, start);
    if (long > 0) {
      const end = skipLong(text, start, long);
      return this.token("string", start, end);
    }
    return this.token("symbol", start, start + 1);
  }

  private token(type: Token["type"], start: number, end: number): Token {
    this.pos = end;
    return { type, start, end, text: this.text.slice(start, end) };
  }

  private number(start: number): Token {
    const text = this.text;
    let j = start;
    for (;;) {
      const c = text.charAt(j);
      const exponent = /[eEpP]/.test(text.charAt(j - 1)) && /[+-]/.test(c);
      if (!/[0-9A-Za-z_.]/.test(c) && !exponent) break;
      j++;
    }
    const raw = text.slice(start, j);
    const invalid = Number.isNaN(Number(raw)) || /^0[bBoO]/.test(raw);
    if (invalid || raw.includes("_")) {
      throw new ParseFail(start, "syntax", `${raw} is not a number`);
    }
    return this.token("number", start, j);
  }

  private shortString(start: number, quote: string): Token {
    const text = this.text;
    let j = start + 1;
    for (;;) {
      const c = text.charAt(j);
      if (c === "" || c === "\n" || c === "\r") {
        throw new ParseFail(start, "unclosed-string", "unclosed string");
      }
      if (c === quote) return this.token("string", start, j + 1);
      let step = c === "\\" ? 2 : 1;
      if (c === "\\" && text.startsWith("\r\n", j + 1)) step = 3;
      j += step;
    }
  }
}

// Parser --------------------------------------------------------------------

class Parser {
  private readonly lexer: Lexer;
  private readonly src: Source;
  private current: Token;

  constructor(src: Source) {
    this.src = src;
    this.lexer = new Lexer(src);
    this.current = this.lexer.next();
  }

  private advance(): Token {
    const token = this.current;
    this.current = this.lexer.next();
    return token;
  }

  private is(text: string): boolean {
    const { type } = this.current;
    return (type === "symbol" || type === "name") && this.current.text === text;
  }

  private expect(text: string): Token {
    if (!this.is(text)) {
      const message = `expected ${text}`;
      throw new ParseFail(this.current.start, "syntax", message);
    }
    return this.advance();
  }

  chunk(): { assignments: Assignment[]; returned: LuaTable | undefined } {
    const assignments: Assignment[] = [];
    while (this.current.type !== "eof") {
      if (this.is("return")) {
        this.advance();
        const value = this.expression();
        if (this.is(";")) this.advance();
        if (value.kind !== "table" || this.current.type !== "eof") {
          const message = "only return { ... } at the end is supported";
          throw new ParseFail(value.start, "unsupported", message);
        }
        return { assignments, returned: value };
      }
      assignments.push(this.assignment());
    }
    return { assignments, returned: undefined };
  }

  private assignment(): Assignment {
    const start = this.current.start;
    if (this.is("local")) this.advance();
    const name = this.current;
    if (name.type !== "name" || RESERVED.has(name.text)) {
      const message = "only name = value statements are supported";
      throw new ParseFail(name.start, "unsupported", message);
    }
    this.advance();
    this.expect("=");
    const value = this.expression();
    const end = this.is(";") ? this.advance().end : value.end;
    return { name: name.text, start, end, value };
  }

  private expression(): LuaNode {
    const token = this.current;
    if (this.is("{")) return this.table();
    if (this.is("-")) {
      this.advance();
      const number = this.current;
      const gap = this.src.text.slice(token.end, number.start);
      if (number.type !== "number" || !/^[ \t\r\n]*$/.test(gap)) {
        throw new ParseFail(token.start, "unsupported", "- needs a number");
      }
      this.advance();
      return { kind: "number", start: token.start, end: number.end };
    }
    this.advance();
    const { start, end } = token;
    if (token.type === "number") return { kind: "number", start, end };
    if (token.type === "string") return { kind: "string", start, end };
    if (token.type === "name" && token.text === "nil") {
      return { kind: "nil", start, end };
    }
    if (token.text === "true" || token.text === "false") {
      if (token.type === "name") return { kind: "boolean", start, end };
    }
    const message = "expected a number, a string, true, false, nil or {";
    throw new ParseFail(token.start, "unsupported", message);
  }

  private table(): LuaTable {
    const open = this.expect("{");
    const fields: LuaField[] = [];
    let position = 0;
    while (!this.is("}")) {
      if (this.current.type === "eof") {
        throw new ParseFail(open.start, "unclosed-table", "{ is not closed");
      }
      const field = this.field(position + 1);
      if (field.positional) position++;
      fields.push(field);
      if (this.is(",") || this.is(";")) field.sep = this.advance().start;
      else if (!this.is("}")) this.expect("}");
    }
    const close = this.advance();
    return { kind: "table", start: open.start, end: close.end, fields };
  }

  private field(position: number): LuaField {
    const start = this.current.start;
    if (this.is("[")) {
      this.advance();
      const keyNode = this.expression();
      this.expect("]");
      this.expect("=");
      const value = this.expression();
      const key = this.keyOf(keyNode);
      return { key, positional: false, start, end: value.end, sep: -1, value };
    }
    const token = this.current;
    if (token.type === "name" && !RESERVED.has(token.text)) {
      this.advance();
      if (this.is("=")) {
        this.advance();
        const value = this.expression();
        const key = token.text;
        const end = value.end;
        return { key, positional: false, start, end, sep: -1, value };
      }
      throw new ParseFail(token.start, "unsupported", "expected =");
    }
    const value = this.expression();
    const end = value.end;
    return { key: position, positional: true, start, end, sep: -1, value };
  }

  private keyOf(node: LuaNode): Key {
    if (node.kind === "string") return luaString(this.src, node);
    if (node.kind === "number") {
      const raw = this.src.text.slice(node.start, node.end);
      return Number(raw.replace(/\s/g, ""));
    }
    throw new ParseFail(node.start, "unsupported", "keys are text or numbers");
  }
}

// Values --------------------------------------------------------------------

const ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ["\\", 92],
  ['"', 34],
  ["'", 39],
  ["\n", 10],
]);

function pushCodePoint(bytes: number[], code: number): void {
  try {
    bytes.push(...new TextEncoder().encode(String.fromCodePoint(code)));
  } catch {
    // Not a code point: Lua refuses it too; nothing is added.
  }
}

/** The text of a string literal, escapes decoded. */
function luaString(src: Source, node: LuaScalar): string {
  const raw = src.text.slice(node.start, node.end);
  const long = longBracket(raw, 0);
  if (long > 0) {
    const body = raw.slice(long, raw.length - long);
    const content = body.replace(/^\r?\n/, "");
    return src.slice(node.end - long - content.length, node.end - long);
  }
  const bytes: number[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw.charAt(i);
    if (c !== "\\") {
      bytes.push(raw.charCodeAt(i));
      continue;
    }
    i++;
    const e = raw.charAt(i);
    const simple = ESCAPES.get(e);
    if (simple !== undefined) {
      bytes.push(simple);
    } else if (e === "x") {
      bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === "z") {
      while (/[ \t\n\r\f\v]/.test(raw.charAt(i + 1))) i++;
    } else if (e === "u") {
      const close = raw.indexOf("}", i);
      if (close < 0) break;
      pushCodePoint(bytes, Number.parseInt(raw.slice(i + 2, close), 16));
      i = close;
    } else if (/[0-9]/.test(e)) {
      const digits = /^[0-9]{1,3}/.exec(raw.slice(i))?.[0] ?? e;
      bytes.push(Number(digits) & 255);
      i += digits.length - 1;
    } else {
      bytes.push(raw.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function nodeValue(src: Source, node: LuaNode): Value {
  const raw = src.text.slice(node.start, node.end);
  switch (node.kind) {
    case "number":
      return Number(raw.replace(/\s/g, ""));
    case "string":
      return luaString(src, node);
    case "boolean":
      return raw === "true";
    case "nil":
      return null;
    case "table":
      return tableValue(src, node);
  }
}

function tableValue(src: Source, table: LuaTable): Value {
  const sequence = table.fields.every((f, i) => f.key === i + 1);
  if (sequence) return table.fields.map((f) => nodeValue(src, f.value));
  const out: Record<string, Value> = {};
  for (const field of table.fields) {
    Object.defineProperty(out, String(field.key), {
      value: nodeValue(src, field.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function quoteLua(text: string, quote: string): string {
  let out = quote;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code >= 32 && code !== 127) out += ch;
    else out += `\\${String(code).padStart(3, "0")}`;
  }
  return out + quote;
}

function keyText(key: string): string {
  return isIdentifier(key) ? key : `[${quoteLua(key, '"')}]`;
}

function literal(value: Value, previous?: { raw: string }): string {
  if (typeof value === "string") {
    const old = previous?.raw.charAt(0);
    return quoteLua(value, old === "'" ? "'" : '"');
  }
  if (typeof value === "number") {
    return numberText(value, previous?.raw.replace(/\s/g, ""));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "nil";
  if (Array.isArray(value)) {
    const items = (value as readonly Value[]).map((item) => literal(item));
    return items.length === 0 ? "{}" : `{ ${items.join(", ")} }`;
  }
  if (!isRecord(value)) return "nil";
  const fields = Object.entries(value).map(
    ([key, item]) => `${keyText(key)} = ${literal(item)}`,
  );
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

// Locating ------------------------------------------------------------------

function lintTable(src: Source, table: LuaTable): void {
  const seen = new Set<Key>();
  for (const field of table.fields) {
    if (seen.has(field.key)) {
      const message = `the key ${String(field.key)} appears more than once`;
      src.issue(field.start, "duplicate-key", "warning", message);
    }
    seen.add(field.key);
    if (field.value.kind === "table") lintTable(src, field.value);
  }
}

function parse(bytes: Uint8Array): LuaDoc {
  const src = new Source(bytes);
  let assignments: Assignment[] = [];
  let returned: LuaTable | undefined;
  try {
    ({ assignments, returned } = new Parser(src).chunk());
  } catch (fail) {
    if (!(fail instanceof ParseFail)) throw fail;
    src.issue(fail.offset, fail.code, "error", fail.message);
  }
  const names = new Set<string>();
  for (const assignment of assignments) {
    if (names.has(assignment.name)) {
      const message = `${assignment.name} is assigned more than once`;
      const locator: LuaLocator = { kind: "lua", path: [assignment.name] };
      const at = assignment.start;
      src.issue(at, "duplicate-key", "warning", message, locator);
    }
    names.add(assignment.name);
    if (assignment.value.kind === "table") lintTable(src, assignment.value);
  }
  if (returned) lintTable(src, returned);
  return { ...src.doc("lua"), source: src, assignments, returned };
}

function checkPath(locator: LuaLocator): readonly Key[] {
  if (locator.kind !== "lua") throw wrongLocator("lua", locator);
  const { path } = locator;
  const valid =
    Array.isArray(path) &&
    path.every((k) => typeof k === "string" || Number.isInteger(k));
  if (!valid) {
    throw new FormatError(
      "invalid-locator",
      "lua: a path holds names and whole numbers",
    );
  }
  return path;
}

interface Place {
  /** The table that holds the last key; undefined at the top level. */
  readonly table: LuaTable | undefined;
  readonly fields: readonly LuaField[];
  readonly assignments: readonly Assignment[];
}

function fieldsOf(table: LuaTable, key: Key): LuaField[] {
  return table.fields.filter((field) => field.key === key);
}

/** Finds where the last key of the path lives; write refuses duplicates. */
function locate(doc: LuaDoc, path: readonly Key[], write: boolean): Place {
  const pick = <T>(found: T[], key: Key): T | undefined => {
    if (write && found.length > 1) {
      throw new FormatError("ambiguous", `${String(key)} appears twice`);
    }
    return found.at(-1);
  };
  let table = doc.returned;
  let rest = path;
  if (table === undefined) {
    const first = path.at(0);
    const found = doc.assignments.filter((a) => a.name === first);
    if (path.length <= 1) return { table, fields: [], assignments: found };
    const value = pick(found, first ?? "")?.value;
    table = value?.kind === "table" ? value : undefined;
    rest = path.slice(1);
  }
  for (const key of rest.slice(0, -1)) {
    const value = table && pick(fieldsOf(table, key), key)?.value;
    table = value?.kind === "table" ? value : undefined;
  }
  const last = rest.at(-1);
  const fields = table && last !== undefined ? fieldsOf(table, last) : [];
  return { table, fields, assignments: [] };
}

// Writing -------------------------------------------------------------------

function restIsBlank(src: Source, from: number, to: number): boolean {
  const at = src.skipBlank(from, to);
  return at >= to || src.text.startsWith("--", at);
}

function fieldRange(src: Source, table: LuaTable, field: LuaField) {
  const stop = field.sep >= 0 ? field.sep + 1 : field.end;
  const first = src.lineAt(field.start);
  const last = src.lineAt(stop - 1);
  const opensLine = src.blank(first.start, field.start);
  if (opensLine && restIsBlank(src, stop, last.end)) {
    return lineRange(src, first, last);
  }
  const index = table.fields.indexOf(field);
  const next = table.fields.at(index + 1);
  if (next) return { start: field.start, end: next.start };
  const previous = index > 0 ? table.fields.at(index - 1) : undefined;
  if (previous && previous.sep >= 0) return { start: previous.sep, end: stop };
  return { start: field.start, end: stop };
}

function statementRange(src: Source, statement: Assignment) {
  const first = src.lineAt(statement.start);
  const last = src.lineAt(statement.end - 1);
  const opensLine = src.blank(first.start, statement.start);
  if (opensLine && restIsBlank(src, statement.end, last.end)) {
    return lineRange(src, first, last);
  }
  return { start: statement.start, end: statement.end };
}

function keyPrefix(table: LuaTable, key: Key): string {
  if (typeof key === "string") return `${keyText(key)} = `;
  const positional = table.fields.filter((f) => f.positional).length;
  return key === positional + 1 ? "" : `[${key}] = `;
}

function insertField(
  src: Source,
  table: LuaTable,
  key: Key,
  value: Value,
): Splice {
  const field = keyPrefix(table, key) + literal(value);
  const last = table.fields.at(-1);
  if (last === undefined) {
    const empty = table.end - table.start === 2;
    const text = empty ? ` ${field} ` : ` ${field}`;
    return { start: table.start + 1, end: table.start + 1, text };
  }
  const at = last.sep >= 0 ? last.sep + 1 : last.end;
  const multiline = src.lineIndex(table.start) !== src.lineIndex(last.start);
  if (multiline) {
    const indent = indentOf(src, src.lineAt(last.start));
    const line = src.newline + indent + field;
    const text = last.sep >= 0 ? `${line},` : `,${line}`;
    return { start: at, end: at, text };
  }
  const text = last.sep >= 0 ? ` ${field},` : `, ${field}`;
  return { start: at, end: at, text };
}

/** Lua table constructor adapter. */
export const luaAdapter: FormatAdapter<LuaLocator> = {
  id: "lua",
  parse,
  get(doc, locator) {
    const lua = own<LuaDoc>(doc, "lua");
    const place = locate(lua, checkPath(locator), false);
    const node = place.table
      ? place.fields.at(-1)?.value
      : place.assignments.at(-1)?.value;
    return node && nodeValue(lua.source, node);
  },
  set(doc, locator, value) {
    const lua = own<LuaDoc>(doc, "lua");
    writable(lua);
    checkFinite(value);
    const place = locate(lua, checkPath(locator), true);
    const targets = place.table ? place.fields : place.assignments;
    if (targets.length > 1) {
      throw new FormatError("ambiguous", "the key appears more than once");
    }
    const node = targets.at(0)?.value;
    if (node === undefined) {
      throw new FormatError("not-found", "the key does not exist");
    }
    const raw = lua.source.text.slice(node.start, node.end);
    const text = literal(value, { raw });
    const splice = { start: node.start, end: node.end, text };
    return verified(luaAdapter, lua, [splice]);
  },
  insert(doc, locator, value) {
    const lua = own<LuaDoc>(doc, "lua");
    writable(lua);
    checkFinite(value);
    const path = checkPath(locator);
    const place = locate(lua, path, true);
    const key = path.at(-1);
    if (key === undefined) {
      throw new FormatError("invalid-locator", "lua: the path is empty");
    }
    if (place.fields.length > 0 || place.assignments.length > 0) {
      throw new FormatError("exists", `${String(key)} already exists; use set`);
    }
    if (place.table) {
      const splice = insertField(lua.source, place.table, key, value);
      return verified(luaAdapter, lua, [splice]);
    }
    if (path.length > 1 || lua.returned || typeof key !== "string") {
      throw new FormatError("not-found", "the parent table does not exist");
    }
    if (!isIdentifier(key)) {
      throw new FormatError("invalid-locator", `${key} is not a Lua name`);
    }
    const line = `${key} = ${literal(value)}`;
    return verified(luaAdapter, lua, [appendLines(lua.source, [line])]);
  },
  remove(doc, locator) {
    const lua = own<LuaDoc>(doc, "lua");
    writable(lua);
    const src = lua.source;
    const place = locate(lua, checkPath(locator), true);
    const table = place.table;
    const ranges = table
      ? place.fields.map((field) => fieldRange(src, table, field))
      : place.assignments.map((statement) => statementRange(src, statement));
    return verified(luaAdapter, lua, mergeRanges(ranges));
  },
  lint: (doc) => sortedIssues(own<LuaDoc>(doc, "lua")),
  apply: (bytes, splices) => applySplices(bytes, splices),
};

/** Every locator of a parsed Lua document, for tests and fuzzing. */
export function luaLocators(doc: ParsedDoc): LuaLocator[] {
  const lua = doc as LuaDoc;
  const out: LuaLocator[] = [];
  const walk = (table: LuaTable, path: Key[]): void => {
    for (const field of table.fields) {
      const twins = table.fields.filter((f) => f.key === field.key);
      const { key } = field;
      const usable = typeof key === "string" || Number.isInteger(key);
      if (twins.length > 1 || !usable) continue;
      const next = [...path, field.key];
      out.push({ kind: "lua", path: next });
      if (field.value.kind === "table") walk(field.value, next);
    }
  };
  if (lua.returned) walk(lua.returned, []);
  for (const assignment of lua.assignments) {
    const count = lua.assignments.filter((a) => a.name === assignment.name);
    if (count.length > 1) continue;
    out.push({ kind: "lua", path: [assignment.name] });
    if (assignment.value.kind === "table") {
      walk(assignment.value, [assignment.name]);
    }
  }
  return out;
}
