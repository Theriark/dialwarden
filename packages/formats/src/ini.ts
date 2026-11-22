// INI adapters. Plain INI: key=value lines, ; and # comment lines, names
// compared exactly. UE INI (Unreal Engine): names compared without case, the
// array operations +Key, -Key, .Key and !Key, and struct values such as
// Palworld's one-line OptionSettings=(Difficulty=None,ServerName="A, B").
//
// Only whole lines are comments: a ; inside a value is part of the value. A
// value is read without the spaces around it, and a value wholly inside
// double quotes is read without the quotes (\" and \\ are its escapes).

import { appendLines, indentOf, removeLines, verified } from "./edits.js";
import {
  applySplices,
  hasLineBreak,
  own,
  Source,
  sortedIssues,
  writable,
  wrongLocator,
  type Line,
} from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type IniLocator,
  type ParsedDoc,
  type Splice,
  type StructLocator,
  type Value,
} from "./types.js";
import {
  booleanText,
  checkFinite,
  escapeQuoted,
  isRecord,
  numberText,
  unescapeQuoted,
} from "./values.js";

const OPS = "+-.!";

interface Section {
  readonly name: string;
  readonly line: Line;
  readonly entries: Entry[];
}

interface Entry {
  readonly section: Section | null;
  /** "", "+", "-", "." or "!". */
  readonly op: string;
  readonly key: string;
  readonly line: Line;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quoted: boolean;
  readonly struct: StructNode | undefined;
}

interface StructNode {
  readonly kind: "struct";
  /** Offset of the opening parenthesis. */
  readonly start: number;
  /** Offset after the closing parenthesis. */
  readonly end: number;
  readonly items: StructItem[];
}

interface StructItem {
  readonly name: string | undefined;
  readonly start: number;
  readonly end: number;
  /** Offset of the comma after the item, or -1. */
  readonly comma: number;
  readonly value: StructValue;
}

interface StructScalar {
  readonly kind: "quoted" | "bare";
  readonly start: number;
  readonly end: number;
}

type StructValue = StructNode | StructScalar;

interface IniDoc extends ParsedDoc {
  readonly source: Source;
  readonly sections: readonly Section[];
  readonly top: readonly Entry[];
}

interface Dialect {
  readonly id: string;
  /** UE INI: array operations, structs, names without case, True/False. */
  readonly unreal: boolean;
}

class ParseFail extends Error {
  readonly offset: number;
  readonly code: string;

  constructor(offset: number, code: string) {
    super(code);
    this.offset = offset;
    this.code = code;
  }
}

const FAIL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["unclosed-struct", "the struct opened here has no closing parenthesis"],
  ["unclosed-string", "the quoted text opened here is not closed"],
  ["struct-syntax", "unexpected character; expected a value, a comma or )"],
]);

function same(dialect: Dialect, a: string, b: string): boolean {
  return dialect.unreal ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Parsing -------------------------------------------------------------------

function isNameChar(code: number): boolean {
  const digit = code >= 48 && code <= 57;
  const upper = code >= 65 && code <= 90;
  const lower = code >= 97 && code <= 122;
  return digit || upper || lower || code === 95 || code === 91 || code === 93;
}

function scanName(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && isNameChar(text.charCodeAt(i))) i++;
  return i;
}

function isName(text: string): boolean {
  return text.length > 0 && scanName(text, 0, text.length) === text.length;
}

function parseStruct(src: Source, open: number, limit: number): StructNode {
  const text = src.text;
  const items: StructItem[] = [];
  let i = open + 1;
  for (;;) {
    i = src.skipBlank(i, limit);
    if (i >= limit) throw new ParseFail(open, "unclosed-struct");
    if (text.charAt(i) === ")") {
      return { kind: "struct", start: open, end: i + 1, items };
    }
    const start = i;
    let name: string | undefined;
    const nameEnd = scanName(text, i, limit);
    const afterName = src.skipBlank(nameEnd, limit);
    if (nameEnd > i && text.charAt(afterName) === "=") {
      name = src.slice(i, nameEnd);
      i = src.skipBlank(afterName + 1, limit);
    }
    const value = parseStructValue(src, i, limit);
    i = src.skipBlank(value.end, limit);
    if (i >= limit) throw new ParseFail(open, "unclosed-struct");
    let comma = -1;
    if (text.charAt(i) === ",") {
      comma = i;
      i++;
    } else if (text.charAt(i) !== ")") {
      throw new ParseFail(i, "struct-syntax");
    }
    items.push({ name, start, end: value.end, comma, value });
  }
}

function parseStructValue(src: Source, at: number, limit: number): StructValue {
  const text = src.text;
  const first = text.charAt(at);
  if (first === "(") return parseStruct(src, at, limit);
  if (first === '"') {
    let j = at + 1;
    while (j < limit) {
      const c = text.charAt(j);
      if (c === '"') return { kind: "quoted", start: at, end: j + 1 };
      j += c === "\\" ? 2 : 1;
    }
    throw new ParseFail(at, "unclosed-string");
  }
  let j = at;
  while (j < limit) {
    const c = text.charAt(j);
    if (c === "," || c === ")") break;
    if (c === "(" || c === '"') throw new ParseFail(j, "struct-syntax");
    j++;
  }
  return { kind: "bare", start: at, end: src.trimEnd(at, j) };
}

/** True when [start, end) is one double-quoted string. */
function isQuotedSpan(text: string, start: number, end: number): boolean {
  if (end - start < 2) return false;
  if (text.charAt(start) !== '"' || text.charAt(end - 1) !== '"') return false;
  for (let i = start + 1; i < end - 1; i++) {
    const c = text.charAt(i);
    if (c === "\\" && i + 1 < end - 1) i++;
    else if (c === '"') return false;
  }
  return true;
}

function parseLine(
  dialect: Dialect,
  src: Source,
  line: Line,
  section: Section | null,
): Entry | Section | undefined {
  const text = src.text;
  const p = src.skipBlank(line.start, line.end);
  const first = text.charAt(p);
  if (p === line.end || first === ";" || first === "#") return undefined;
  if (first === "[") {
    const close = text.indexOf("]", p);
    if (close < 0 || close >= line.end) {
      src.issue(p, "unclosed-section", "error", "the [section] has no ]");
      return undefined;
    }
    const rest = src.skipBlank(close + 1, line.end);
    const after = text.charAt(rest);
    if (rest < line.end && after !== ";" && after !== "#") {
      src.issue(rest, "syntax", "warning", "text after the ] is ignored");
    }
    const name = src.slice(p + 1, close).trim();
    return { name, line, entries: [] };
  }
  const eq = text.indexOf("=", p);
  if (eq < 0 || eq >= line.end) {
    src.issue(p, "syntax", "error", "expected key=value, [section] or comment");
    return undefined;
  }
  const op = dialect.unreal && OPS.includes(first) ? first : "";
  const keyStart = p + op.length;
  const keyEnd = src.trimEnd(keyStart, eq);
  if (keyEnd === keyStart) {
    src.issue(p, "syntax", "error", "the key name is empty");
    return undefined;
  }
  const valueStart = src.skipBlank(eq + 1, line.end);
  const valueEnd = src.trimEnd(valueStart, line.end);
  let struct: StructNode | undefined;
  if (dialect.unreal && text.charAt(valueStart) === "(") {
    struct = parseEntryStruct(dialect, src, valueStart, valueEnd);
  }
  return {
    section,
    op,
    key: src.slice(keyStart, keyEnd),
    line,
    valueStart,
    valueEnd,
    quoted: struct === undefined && isQuotedSpan(text, valueStart, valueEnd),
    struct,
  };
}

function parseEntryStruct(
  dialect: Dialect,
  src: Source,
  start: number,
  end: number,
): StructNode | undefined {
  try {
    const node = parseStruct(src, start, end);
    if (node.end < end) {
      src.issue(node.end, "syntax", "error", "unexpected text after the )");
    }
    lintStruct(dialect, src, node);
    return node;
  } catch (fail) {
    if (!(fail instanceof ParseFail)) throw fail;
    const message = FAIL_MESSAGES.get(fail.code) ?? fail.code;
    src.issue(fail.offset, fail.code, "error", message);
    return undefined;
  }
}

function parse(dialect: Dialect, bytes: Uint8Array): IniDoc {
  const src = new Source(bytes);
  const sections: Section[] = [];
  const top: Entry[] = [];
  let current: Section | null = null;
  for (const line of src.lines) {
    const parsed = parseLine(dialect, src, line, current);
    if (parsed === undefined) continue;
    if ("entries" in parsed) {
      current = parsed;
      sections.push(parsed);
    } else if (current) {
      current.entries.push(parsed);
    } else {
      top.push(parsed);
      const locator: IniLocator = {
        kind: "ini",
        section: null,
        key: parsed.key,
      };
      const message = `${parsed.key} is outside any section`;
      src.issue(line.start, "key-outside-section", "warning", message, locator);
    }
  }
  lintDuplicates(dialect, src, sections, top);
  return { ...src.doc(dialect.id), source: src, sections, top };
}

function lintStruct(dialect: Dialect, src: Source, node: StructNode): void {
  const seen: string[] = [];
  for (const item of node.items) {
    const name = item.name;
    if (name !== undefined) {
      if (seen.some((n) => same(dialect, n, name))) {
        const message = `the field ${name} appears more than once`;
        src.issue(item.start, "duplicate-field", "warning", message);
      }
      seen.push(name);
    }
    if (item.value.kind === "struct") lintStruct(dialect, src, item.value);
  }
}

interface Group {
  readonly name: string | null;
  readonly entries: Entry[];
}

function lintDuplicates(
  dialect: Dialect,
  src: Source,
  sections: readonly Section[],
  top: readonly Entry[],
): void {
  const groups: Group[] = [{ name: null, entries: [...top] }];
  for (const section of sections) {
    const group = groups.find(
      (g) => g.name !== null && same(dialect, g.name, section.name),
    );
    if (group) {
      const message = `the section [${section.name}] appears more than once`;
      src.issue(section.line.start, "duplicate-section", "warning", message);
      group.entries.push(...section.entries);
    } else {
      groups.push({ name: section.name, entries: [...section.entries] });
    }
  }
  for (const group of groups) {
    const seen: string[] = [];
    for (const entry of group.entries) {
      if (entry.op !== "") continue;
      if (seen.some((key) => same(dialect, key, entry.key))) {
        const message = `the key ${entry.key} appears more than once`;
        const locator: IniLocator = {
          kind: "ini",
          section: group.name,
          key: entry.key,
        };
        const at = entry.line.start;
        src.issue(at, "duplicate-key", "warning", message, locator);
      }
      seen.push(entry.key);
    }
  }
}

// Reading -------------------------------------------------------------------

function structValue(src: Source, value: StructValue): Value {
  if (value.kind === "quoted") {
    return unescapeQuoted(src.slice(value.start + 1, value.end - 1));
  }
  if (value.kind !== "struct") return src.slice(value.start, value.end);
  if (value.items.every((item) => item.name === undefined)) {
    return value.items.map((item) => structValue(src, item.value));
  }
  const out: Record<string, Value> = {};
  value.items.forEach((item, i) => {
    Object.defineProperty(out, item.name ?? String(i), {
      value: structValue(src, item.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
}

function entryValue(doc: IniDoc, entry: Entry): Value {
  const src = doc.source;
  if (entry.struct) return structValue(src, entry.struct);
  if (entry.quoted) {
    return unescapeQuoted(src.slice(entry.valueStart + 1, entry.valueEnd - 1));
  }
  return src.slice(entry.valueStart, entry.valueEnd);
}

function checkIniLocator(id: string, locator: IniLocator): void {
  const { section, key, index } = locator;
  const validIndex =
    index === undefined || (Number.isInteger(index) && index >= 0);
  const validSection = section === null || typeof section === "string";
  if (!validSection || typeof key !== "string" || key === "" || !validIndex) {
    throw new FormatError(
      "invalid-locator",
      `${id}: an ini locator needs a section (or null), a key and an index >= 0`,
    );
  }
}

function keyMatcher(dialect: Dialect, key: string): (entry: Entry) => boolean {
  const first = key.charAt(0);
  if (dialect.unreal && key.length > 1 && OPS.includes(first)) {
    const bare = key.slice(1);
    return (entry) => entry.op === first && same(dialect, entry.key, bare);
  }
  return (entry) => same(dialect, entry.key, key);
}

function sectionsNamed(dialect: Dialect, doc: IniDoc, name: string): Section[] {
  return doc.sections.filter((section) => same(dialect, section.name, name));
}

function findEntries(
  dialect: Dialect,
  doc: IniDoc,
  locator: IniLocator,
): Entry[] {
  const { section } = locator;
  const entries =
    section === null
      ? doc.top
      : sectionsNamed(dialect, doc, section).flatMap((s) => s.entries);
  return entries.filter(keyMatcher(dialect, locator.key));
}

// Writing -------------------------------------------------------------------

function bareSafe(text: string): boolean {
  if (text === "" || text !== text.trim() || hasLineBreak(text)) return false;
  return ![",", "(", ")", '"', "="].some((c) => text.includes(c));
}

function quote(text: string): string {
  return `"${escapeQuoted(text)}"`;
}

function structText(value: Value): string {
  if (Array.isArray(value)) {
    const items = (value as readonly Value[]).map((item) => scalarText(item));
    return `(${items.join(",")})`;
  }
  if (!isRecord(value)) {
    throw new FormatError(
      "invalid-value",
      "a struct needs an object or a list",
    );
  }
  const fields = Object.entries(value).map(([name, item]) => {
    if (!isName(name)) {
      throw new FormatError("invalid-value", `${name} is not a field name`);
    }
    return `${name}=${scalarText(item)}`;
  });
  return `(${fields.join(",")})`;
}

/** A struct value; previous is the value it replaces. */
function scalarText(
  value: Value,
  previous?: StructScalar,
  raw?: string,
): string {
  if (typeof value === "string") {
    if (hasLineBreak(value)) {
      throw new FormatError(
        "invalid-value",
        "a value cannot hold a line break",
      );
    }
    const keepQuotes = previous?.kind === "quoted";
    return keepQuotes || !bareSafe(value) ? quote(value) : value;
  }
  if (typeof value === "number") return numberText(value, raw);
  if (typeof value === "boolean") return booleanText(value, raw, "Title");
  if (value === null) {
    throw new FormatError("invalid-value", "null cannot be written to INI");
  }
  return structText(value);
}

function valueText(
  dialect: Dialect,
  doc: IniDoc,
  entry: Entry | undefined,
  value: Value,
): string {
  checkFinite(value);
  const raw = entry && doc.source.slice(entry.valueStart, entry.valueEnd);
  if (typeof value === "string") {
    if (hasLineBreak(value)) {
      throw new FormatError(
        "invalid-value",
        "a value cannot hold a line break",
      );
    }
    const looksQuoted = isQuotedSpan(value, 0, value.length);
    const looksStruct = dialect.unreal && value.startsWith("(");
    const padded = value !== value.trim();
    const quoted = entry?.quoted || looksQuoted || looksStruct || padded;
    return quoted ? quote(value) : value;
  }
  if (typeof value === "number") return numberText(value, raw);
  if (typeof value === "boolean") {
    return booleanText(value, raw, dialect.unreal ? "Title" : "lower");
  }
  if (value === null || !dialect.unreal) {
    throw new FormatError("invalid-value", "use text, a number or a boolean");
  }
  return structText(value);
}

function checkKey(dialect: Dialect, key: string): void {
  const op = dialect.unreal && OPS.includes(key.charAt(0)) ? 1 : 0;
  const bare = key.slice(op);
  const first = bare.charAt(0);
  const bad =
    bare === "" ||
    bare !== bare.trim() ||
    bare.includes("=") ||
    hasLineBreak(bare) ||
    ["[", ";", "#"].includes(first) ||
    (dialect.unreal && OPS.includes(first));
  if (bad) {
    throw new FormatError("invalid-value", `${key} cannot be an INI key`);
  }
}

function checkSection(name: string): void {
  const bad =
    name === "" ||
    name !== name.trim() ||
    name.includes("]") ||
    hasLineBreak(name);
  if (bad) {
    throw new FormatError("invalid-value", `[${name}] cannot be a section`);
  }
}

function insertAfter(line: Line, text: string, src: Source): Splice[] {
  return [{ start: line.end, end: line.end, text: src.newline + text }];
}

function insertEntry(
  dialect: Dialect,
  doc: IniDoc,
  locator: IniLocator,
  value: Value,
): Splice[] {
  checkIniLocator(dialect.id, locator);
  checkKey(dialect, locator.key);
  const src = doc.source;
  const existing = findEntries(dialect, doc, locator);
  const append = dialect.unreal && /^[+.]/.test(locator.key);
  if (existing.length > 0 && locator.index === undefined && !append) {
    throw new FormatError(
      "exists",
      `${locator.key} exists; use set, or give an index to add another`,
    );
  }
  const text = `${locator.key}=${valueText(dialect, doc, undefined, value)}`;
  const at =
    locator.index === undefined ? undefined : existing.at(locator.index);
  if (at) {
    const line = indentOf(src, at.line) + text + src.newline;
    return [{ start: at.line.start, end: at.line.start, text: line }];
  }
  const sibling = existing.at(-1);
  if (sibling) {
    return insertAfter(sibling.line, indentOf(src, sibling.line) + text, src);
  }
  if (locator.section === null) {
    const anchor = doc.top.at(-1);
    if (anchor) return insertAfter(anchor.line, text, src);
    return [{ start: src.begin, end: src.begin, text: text + src.newline }];
  }
  const target = sectionsNamed(dialect, doc, locator.section).at(-1);
  if (target) {
    const anchor = target.entries.at(-1)?.line ?? target.line;
    return insertAfter(anchor, text, src);
  }
  checkSection(locator.section);
  return [appendLines(src, [`[${locator.section}]`, text])];
}

// Structs -------------------------------------------------------------------

function fieldPath(id: string, locator: StructLocator): string[] {
  const { key, field } = locator;
  const path = typeof field === "string" ? field.split(".") : [];
  if (typeof key !== "string" || key === "" || path.some((p) => p === "")) {
    throw new FormatError(
      "invalid-locator",
      `${id}: a struct locator needs a key and a field path`,
    );
  }
  return path;
}

function structEntry(
  dialect: Dialect,
  doc: IniDoc,
  key: string,
): Entry | undefined {
  const entries = [...doc.top, ...doc.sections.flatMap((s) => s.entries)];
  const found = entries.filter(
    (entry) => entry.struct !== undefined && same(dialect, entry.key, key),
  );
  if (found.length > 1) {
    throw new FormatError("ambiguous", `${key} holds more than one struct`);
  }
  return found.at(0);
}

function findItem(
  dialect: Dialect,
  node: StructNode,
  name: string,
): StructItem | undefined {
  const found = node.items.filter(
    (item) => item.name !== undefined && same(dialect, item.name, name),
  );
  if (found.length > 1) {
    throw new FormatError("ambiguous", `the field ${name} appears twice`);
  }
  return found.at(0);
}

interface FieldPlace {
  readonly node: StructNode;
  readonly item: StructItem | undefined;
  readonly name: string;
}

/** The struct that holds the field, and the field when it exists. */
function locateField(
  dialect: Dialect,
  doc: IniDoc,
  locator: StructLocator,
): FieldPlace | undefined {
  const path = fieldPath(dialect.id, locator);
  let node = structEntry(dialect, doc, locator.key)?.struct;
  for (const part of path.slice(0, -1)) {
    const value = node && findItem(dialect, node, part)?.value;
    node = value?.kind === "struct" ? value : undefined;
  }
  const name = path.at(-1) ?? "";
  if (node === undefined) return undefined;
  return { node, item: findItem(dialect, node, name), name };
}

function removeItem(node: StructNode, item: StructItem): Splice {
  const index = node.items.indexOf(item);
  const next = node.items.at(index + 1);
  if (next) return { start: item.start, end: next.start, text: "" };
  const previous = index > 0 ? node.items.at(index - 1) : undefined;
  if (previous) return { start: previous.comma, end: item.end, text: "" };
  const end = item.comma >= 0 ? item.comma + 1 : item.end;
  return { start: item.start, end, text: "" };
}

function insertItem(place: FieldPlace, value: Value): Splice {
  if (!isName(place.name)) {
    throw new FormatError("invalid-locator", `${place.name} is not a name`);
  }
  checkFinite(value);
  const text = `${place.name}=${scalarText(value)}`;
  const close = place.node.end - 1;
  const last = place.node.items.at(-1);
  if (last === undefined) return { start: close, end: close, text };
  if (last.comma >= 0) return { start: close, end: close, text: `${text},` };
  return { start: last.end, end: last.end, text: `,${text}` };
}

// Adapter -------------------------------------------------------------------

export type IniFamilyLocator = IniLocator | StructLocator;

function createIniAdapter(dialect: Dialect): FormatAdapter<IniFamilyLocator> {
  const { id } = dialect;

  function getEntryValue(doc: IniDoc, locator: IniLocator): Value | undefined {
    checkIniLocator(id, locator);
    const entries = findEntries(dialect, doc, locator);
    const values = entries.map((entry) => entryValue(doc, entry));
    if (locator.index !== undefined) return values.at(locator.index);
    return values.length > 1 ? values : values.at(0);
  }

  function setEntry(doc: IniDoc, locator: IniLocator, value: Value): Splice[] {
    checkIniLocator(id, locator);
    const entries = findEntries(dialect, doc, locator);
    if (locator.index === undefined && entries.length > 1) {
      throw new FormatError(
        "ambiguous",
        `${locator.key} appears ${entries.length} times; give an index`,
      );
    }
    const entry = entries.at(locator.index ?? 0);
    if (!entry) {
      throw new FormatError("not-found", `${locator.key} does not exist`);
    }
    const text = valueText(dialect, doc, entry, value);
    return [{ start: entry.valueStart, end: entry.valueEnd, text }];
  }

  function removeEntries(doc: IniDoc, locator: IniLocator): Splice[] {
    checkIniLocator(id, locator);
    const entries = findEntries(dialect, doc, locator);
    const { index } = locator;
    const targets =
      index === undefined ? entries : entries.slice(index, index + 1);
    const lines = targets.map((entry) => entry.line);
    return removeLines(doc.source, lines);
  }

  function setField(doc: IniDoc, locator: StructLocator, value: Value) {
    const item = locateField(dialect, doc, locator)?.item;
    if (!item) {
      const name = `${locator.key}.${locator.field}`;
      throw new FormatError("not-found", `${name} does not exist`);
    }
    checkFinite(value);
    const scalar = item.value.kind === "struct" ? undefined : item.value;
    const raw = doc.source.slice(item.value.start, item.value.end);
    const text = scalarText(value, scalar, raw);
    return [{ start: item.value.start, end: item.value.end, text }];
  }

  function insertField(doc: IniDoc, locator: StructLocator, value: Value) {
    const place = locateField(dialect, doc, locator);
    if (!place) {
      const name = `${locator.key}.${locator.field}`;
      throw new FormatError("not-found", `there is no struct for ${name}`);
    }
    if (place.item) {
      const name = `${locator.key}.${locator.field}`;
      throw new FormatError("exists", `${name} already exists`);
    }
    return [insertItem(place, value)];
  }

  function struct(locator: IniFamilyLocator): StructLocator | undefined {
    if (locator.kind === "struct" && dialect.unreal) return locator;
    if (locator.kind !== "ini") throw wrongLocator(id, locator);
    return undefined;
  }

  const adapter: FormatAdapter<IniFamilyLocator> = {
    id,
    parse: (bytes) => parse(dialect, bytes),
    get(doc, locator) {
      const ini = own<IniDoc>(doc, id);
      const field = struct(locator);
      if (field === undefined) {
        return getEntryValue(ini, locator as IniLocator);
      }
      const item = locateField(dialect, ini, field)?.item;
      return item && structValue(ini.source, item.value);
    },
    set(doc, locator, value) {
      const ini = own<IniDoc>(doc, id);
      writable(ini);
      const field = struct(locator);
      const splices = field
        ? setField(ini, field, value)
        : setEntry(ini, locator as IniLocator, value);
      return verified(adapter, ini, splices);
    },
    insert(doc, locator, value) {
      const ini = own<IniDoc>(doc, id);
      writable(ini);
      const field = struct(locator);
      const splices = field
        ? insertField(ini, field, value)
        : insertEntry(dialect, ini, locator as IniLocator, value);
      return verified(adapter, ini, splices);
    },
    remove(doc, locator) {
      const ini = own<IniDoc>(doc, id);
      writable(ini);
      const field = struct(locator);
      if (field === undefined) {
        const splices = removeEntries(ini, locator as IniLocator);
        return verified(adapter, ini, splices);
      }
      const place = locateField(dialect, ini, field);
      if (!place?.item) return [];
      return verified(adapter, ini, [removeItem(place.node, place.item)]);
    },
    lint: (doc) => sortedIssues(own<IniDoc>(doc, id)),
    apply: (bytes, splices) => applySplices(bytes, splices),
  };
  return adapter;
}

/** Plain INI: key=value, ; and # comment lines, exact names. */
export const iniAdapter = createIniAdapter({ id: "ini", unreal: false });

/** Unreal Engine INI with array operations and structs (Palworld, ARK). */
export const ueIniAdapter = createIniAdapter({ id: "ueini", unreal: true });

/** Every locator of a parsed INI document, for tests and fuzzing. */
export function iniLocators(doc: ParsedDoc): IniFamilyLocator[] {
  const ini = doc as IniDoc;
  const dialect: Dialect = { id: ini.adapter, unreal: ini.adapter === "ueini" };
  const out: IniFamilyLocator[] = [];
  const entries = [...ini.top, ...ini.sections.flatMap((s) => s.entries)];
  for (const entry of entries) {
    const section = entry.section?.name ?? null;
    const key = entry.op + entry.key;
    const base: IniLocator = { kind: "ini", section, key };
    const index = findEntries(dialect, ini, base).indexOf(entry);
    out.push({ ...base, index });
    const structs = entries.filter(
      (e) => e.struct !== undefined && same(dialect, e.key, entry.key),
    );
    if (entry.struct && structs.length === 1) {
      out.push(...fieldLocators(entry.key, entry.struct, ""));
    }
  }
  return out;
}

function fieldLocators(
  key: string,
  node: StructNode,
  prefix: string,
): StructLocator[] {
  const out: StructLocator[] = [];
  const names = node.items.map((item) => item.name?.toLowerCase());
  for (const item of node.items) {
    const name = item.name?.toLowerCase();
    const twins = names.filter((n) => n === name).length;
    if (item.name === undefined || twins > 1) continue;
    const field = prefix + item.name;
    out.push({ kind: "struct", key, field });
    if (item.value.kind === "struct") {
      out.push(...fieldLocators(key, item.value, `${field}.`));
    }
  }
  return out;
}
