// JSON adapters built on jsonc-parser. "json" is strict, as Enshrouded reads
// it: a comment or a trailing comma is an error, so a file with one is never
// written. "jsonc" accepts both. Neither ever writes a comment or a trailing
// comma: new values are JSON.stringify output.
//
// set uses jsonc-parser's modify. insert and remove build their own edits:
// modify with formatting rewrites the whole lines around an insert or a
// remove, which would drop trailing spaces, move comments and expand
// one-line objects. A member on its own lines is added or removed as whole
// lines; anything else is edited inline, next to its neighbour.
//
// jsonc-parser works on JavaScript strings, so the file is decoded as UTF-8
// and every string offset is mapped back to a byte offset of the original.

import * as jsoncModule from "jsonc-parser";
import type {
  Edit,
  FormattingOptions,
  ModificationOptions,
  Node as JsonNode,
  ParseError,
} from "jsonc-parser";
import { verified } from "./edits.js";
import {
  applySplices,
  isValidUtf8,
  own,
  Source,
  sortedIssues,
  writable,
  wrongLocator,
} from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type JsonLocator,
  type ParsedDoc,
  type Splice,
  type Value,
} from "./types.js";
import { checkFinite } from "./values.js";

// The package is CommonJS (UMD): Node gives its exports as the default.
type Jsonc = typeof jsoncModule;
const loaded = jsoncModule as Jsonc & { default?: Jsonc };
const jsonc: Jsonc = loaded.default ?? loaded;

interface JsonDoc extends ParsedDoc {
  readonly text: string;
  /** Byte offset of every UTF-16 index of text, and of its end. */
  readonly offsets: readonly number[];
  readonly root: JsonNode | undefined;
  /** Indentation of the file; undefined for a one-line file. */
  readonly formatting: FormattingOptions | undefined;
}

interface JsonOptions {
  readonly id: string;
  readonly strict: boolean;
}

type Segment = string | number;

function utf8Length(codePoint: number): number {
  if (codePoint < 128) return 1;
  if (codePoint < 2048) return 2;
  return codePoint < 65536 ? 3 : 4;
}

function byteOffsets(text: string, base: number): number[] {
  const out: number[] = [];
  let offset = base;
  for (const ch of text) {
    out.push(offset);
    if (ch.length === 2) out.push(offset);
    offset += utf8Length(ch.codePointAt(0) ?? 0);
  }
  out.push(offset);
  return out;
}

function detectFormatting(
  text: string,
  eol: string,
): FormattingOptions | undefined {
  if (!text.includes("\n")) return undefined;
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  if (indent.startsWith("\t")) {
    return { insertSpaces: false, tabSize: 4, eol };
  }
  return { insertSpaces: true, tabSize: indent.length, eol };
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function lintNode(src: Source, doc: JsonDoc, node: JsonNode, at: string) {
  const children = node.children ?? [];
  if (node.type === "array") {
    children.forEach((child, i) => lintNode(src, doc, child, `${at}/${i}`));
  }
  if (node.type !== "object") return;
  const seen = new Set<string>();
  for (const property of children) {
    const [key, value] = property.children ?? [];
    if (key === undefined || typeof key.value !== "string") continue;
    const pointer = `${at}/${escapePointer(key.value)}`;
    if (seen.has(key.value)) {
      const offset = doc.offsets.at(property.offset) ?? 0;
      const message = `the key ${key.value} appears more than once`;
      const locator: JsonLocator = { kind: "json", pointer };
      src.issue(offset, "duplicate-key", "warning", message, locator);
    }
    seen.add(key.value);
    if (value !== undefined) lintNode(src, doc, value, pointer);
  }
}

function parse(options: JsonOptions, bytes: Uint8Array): JsonDoc {
  const src = new Source(bytes);
  const eol = src.newline;
  const valid = isValidUtf8(bytes.subarray(src.begin));
  const text = valid ? src.slice(src.begin, src.length) : "";
  const offsets = byteOffsets(text, src.begin);
  const errors: ParseError[] = [];
  const parseOptions = {
    disallowComments: options.strict,
    allowTrailingComma: !options.strict,
    allowEmptyContent: false,
  };
  const root = valid ? jsonc.parseTree(text, errors, parseOptions) : undefined;
  if (!valid) {
    src.issue(src.begin, "invalid-utf8", "error", "JSON must be UTF-8");
  }
  for (const error of errors) {
    const offset = offsets.at(error.offset) ?? src.length;
    const message = jsonc.printParseErrorCode(error.error);
    src.issue(offset, "syntax", "error", message);
  }
  const doc: JsonDoc = {
    ...src.doc(options.id),
    text,
    offsets,
    root,
    formatting: detectFormatting(text, eol),
  };
  if (root !== undefined) lintNode(src, doc, root, "");
  return doc;
}

function segments(id: string, locator: JsonLocator): string[] {
  const { pointer } = locator;
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new FormatError(
      "invalid-locator",
      `${id}: a JSON pointer is empty or starts with /`,
    );
  }
  const parts = pointer.slice(1).split("/");
  return parts.map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
}

interface Found {
  readonly node: JsonNode | undefined;
  readonly path: Segment[];
}

const INDEX = /^(0|[1-9][0-9]*)$/;

/** Follows the pointer; with write, a duplicated key is an error. */
function resolve(doc: JsonDoc, parts: readonly string[], write: boolean) {
  let node = doc.root;
  const path: Segment[] = [];
  for (const part of parts) {
    if (node?.type === "array" && INDEX.test(part)) {
      const index = Number(part);
      path.push(index);
      node = node.children?.at(index);
    } else if (node?.type === "object") {
      const matches = (node.children ?? []).filter(
        (property) => property.children?.at(0)?.value === part,
      );
      if (write && matches.length > 1) {
        throw new FormatError("ambiguous", `the key ${part} appears twice`);
      }
      path.push(part);
      node = matches.at(-1)?.children?.at(1);
    } else {
      path.push(part);
      node = undefined;
    }
  }
  const found: Found = { node, path };
  return found;
}

function toSplices(doc: JsonDoc, edits: Edit[]): Splice[] {
  return edits.map((edit) => {
    const start = doc.offsets.at(edit.offset) ?? doc.bytes.length;
    const stop = doc.offsets.at(edit.offset + edit.length);
    return { start, end: stop ?? doc.bytes.length, text: edit.content };
  });
}

function replaceValue(doc: JsonDoc, path: Segment[], value: Value): Splice[] {
  const formattingOptions = doc.formatting;
  const options: ModificationOptions = formattingOptions
    ? { formattingOptions }
    : {};
  return toSplices(doc, jsonc.modify(doc.text, path, value, options));
}

function lineStart(text: string, at: number): number {
  return at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
}

/** True when only spaces and tabs come before the offset on its line. */
function startsLine(text: string, at: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, at), at));
}

/** Skips whitespace and comments, line breaks included. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    if (/[ \t\r\n]/.test(text.charAt(i))) {
      i++;
    } else if (text.startsWith("//", i)) {
      const lf = text.indexOf("\n", i);
      i = lf < 0 ? text.length : lf;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      return i;
    }
  }
}

/** Skips spaces, tabs and block comments that end on the same line. */
function skipInline(text: string, from: number): number {
  let i = from;
  for (;;) {
    if (/[ \t]/.test(text.charAt(i))) {
      i++;
      continue;
    }
    if (!text.startsWith("/*", i)) return i;
    const close = text.indexOf("*/", i + 2);
    if (close < 0 || /[\r\n]/.test(text.slice(i, close))) return i;
    i = close + 2;
  }
}

interface LineTail {
  /** Offset of a comma after the member on its line. */
  readonly comma: number | undefined;
  /** Offset of the line break, or of the end of the text. */
  readonly end: number;
  /** Offset after the line break. */
  readonly next: number;
  /** The line break itself; empty on the last line of the file. */
  readonly eol: string;
}

/**
 * What follows a member on its line: an optional comma, then only blanks and
 * comments up to the line break. undefined when anything else follows.
 */
function lineTail(text: string, from: number): LineTail | undefined {
  let i = skipInline(text, from);
  let comma: number | undefined;
  if (text.charAt(i) === ",") {
    comma = i;
    i = skipInline(text, i + 1);
  }
  const lf = text.indexOf("\n", i);
  const stop = lf < 0 ? text.length : lf;
  const end = lf > 0 && text.charAt(lf - 1) === "\r" ? lf - 1 : stop;
  if (i > end || (i < end && !text.startsWith("//", i))) return undefined;
  const next = lf < 0 ? text.length : lf + 1;
  return { comma, end, next, eol: text.slice(end, next) };
}

function indentUnit(doc: JsonDoc): string {
  const f = doc.formatting;
  if (f === undefined) return "  ";
  return f.insertSpaces ? " ".repeat(f.tabSize ?? 2) : "\t";
}

interface Layout {
  readonly unit: string;
  readonly indent: string;
  readonly eol: string;
}

/** A new member as JSON.stringify output, indented to its line by a layout. */
function memberText(
  key: string | undefined,
  value: Value,
  layout?: Layout,
): string {
  let json = JSON.stringify(value);
  if (layout) {
    const lines = JSON.stringify(value, null, layout.unit);
    json = lines.replaceAll("\n", layout.eol + layout.indent);
  }
  return key === undefined ? json : `${JSON.stringify(key)}: ${json}`;
}

function isMultiLine(text: string, node: JsonNode): boolean {
  return text.slice(node.offset, node.offset + node.length).includes("\n");
}

/** Edits that insert a member (with a key in an object) at index k. */
function insertMember(
  doc: JsonDoc,
  parent: JsonNode,
  k: number,
  key: string | undefined,
  value: Value,
): Edit[] {
  const text = doc.text;
  const children = parent.children ?? [];
  const next = children.at(k);
  const prev = k > 0 ? children.at(k - 1) : undefined;
  const multi = isMultiLine(text, parent);
  const unit = indentUnit(doc);
  if (multi && next !== undefined && startsLine(text, next.offset)) {
    // A new line before the member that is now at k.
    const at = lineStart(text, next.offset);
    const indent = text.slice(at, next.offset);
    const eol = text.charAt(at - 2) === "\r" ? "\r\n" : "\n";
    const member = memberText(key, value, { unit, indent, eol });
    return [{ offset: at, length: 0, content: `${indent}${member},${eol}` }];
  }
  if (multi && next === undefined && prev !== undefined) {
    // A new line after the last member, its comma and its comment.
    const prevEnd = prev.offset + prev.length;
    const tail = lineTail(text, prevEnd);
    if (startsLine(text, prev.offset) && tail !== undefined && tail.eol) {
      const indent = text.slice(lineStart(text, prev.offset), prev.offset);
      const layout = { unit, indent, eol: tail.eol };
      const line = `${tail.eol}${indent}${memberText(key, value, layout)}`;
      if (tail.comma !== undefined) {
        return [{ offset: tail.end, length: 0, content: line }];
      }
      if (tail.end === prevEnd) {
        return [{ offset: prevEnd, length: 0, content: `,${line}` }];
      }
      return [
        { offset: prevEnd, length: 0, content: "," },
        { offset: tail.end, length: 0, content: line },
      ];
    }
  }
  const member = memberText(key, value);
  if (prev !== undefined) {
    const offset = prev.offset + prev.length;
    return [{ offset, length: 0, content: `,${member}` }];
  }
  if (next !== undefined) {
    return [{ offset: next.offset, length: 0, content: `${member},` }];
  }
  return [{ offset: parent.offset + 1, length: 0, content: member }];
}

/** Edits that remove a member: a property or an array item. */
function removeMember(doc: JsonDoc, member: JsonNode): Edit[] {
  const text = doc.text;
  const children = member.parent?.children ?? [];
  const k = children.indexOf(member);
  const start = member.offset;
  const end = member.offset + member.length;
  const after = skipTrivia(text, end);
  const hasComma = text.charAt(after) === ",";
  const prev = k > 0 ? children.at(k - 1) : undefined;
  const next = children.at(k + 1);
  const tail = lineTail(text, end);
  const commaOnLine = tail?.comma !== undefined;
  if (startsLine(text, start) && tail?.eol && commaOnLine === hasComma) {
    // The member has its own lines: remove them, its comment included.
    const offset = lineStart(text, start);
    const lines = { offset, length: tail.next - offset, content: "" };
    if (hasComma || prev === undefined) return [lines];
    // It was the last member: the comma before it goes too.
    const comma = skipTrivia(text, prev.offset + prev.length);
    return [{ offset: comma, length: 1, content: "" }, lines];
  }
  if (prev !== undefined) {
    const offset = prev.offset + prev.length;
    return [{ offset, length: end - offset, content: "" }];
  }
  if (next !== undefined) {
    return [{ offset: start, length: next.offset - start, content: "" }];
  }
  const stop = hasComma ? after + 1 : end;
  return [{ offset: start, length: stop - start, content: "" }];
}

function createJsonAdapter(options: JsonOptions): FormatAdapter<JsonLocator> {
  const { id } = options;

  function locate(doc: ParsedDoc, locator: JsonLocator, write: boolean) {
    const json = own<JsonDoc>(doc, id);
    if (locator.kind !== "json") throw wrongLocator(id, locator);
    if (write) writable(json);
    const parts = segments(id, locator);
    return { json, parts, found: resolve(json, parts, write) };
  }

  function insertSplices(json: JsonDoc, parts: string[], value: Value) {
    const parent = resolve(json, parts.slice(0, -1), true);
    const last = parts.at(-1) ?? "";
    const node = parent.node;
    if (parts.length === 0 || node === undefined) {
      throw new FormatError("not-found", "the parent does not exist");
    }
    const length = node.children?.length ?? 0;
    if (node.type === "object") {
      if (resolve(json, parts, true).node !== undefined) {
        throw new FormatError("exists", `${last} already exists; use set`);
      }
      return toSplices(json, insertMember(json, node, length, last, value));
    }
    const index = last === "-" ? length : Number(last);
    const isIndex = last === "-" || INDEX.test(last);
    if (node.type !== "array" || !isIndex || index > length) {
      throw new FormatError("not-found", `cannot insert at ${last}`);
    }
    const edits = insertMember(json, node, index, undefined, value);
    return toSplices(json, edits);
  }

  const adapter: FormatAdapter<JsonLocator> = {
    id,
    parse: (bytes) => parse(options, bytes),
    get(doc, locator) {
      const { found } = locate(doc, locator, false);
      if (found.node === undefined) return undefined;
      return jsonc.getNodeValue(found.node) as Value;
    },
    set(doc, locator, value) {
      const { json, found } = locate(doc, locator, true);
      checkFinite(value);
      if (found.node === undefined) {
        throw new FormatError("not-found", `${locator.pointer} does not exist`);
      }
      return verified(adapter, json, replaceValue(json, found.path, value));
    },
    insert(doc, locator, value) {
      const { json, parts } = locate(doc, locator, true);
      checkFinite(value);
      return verified(adapter, json, insertSplices(json, parts, value));
    },
    remove(doc, locator) {
      const { json, parts, found } = locate(doc, locator, true);
      if (parts.length === 0) {
        throw new FormatError("invalid-locator", "the root cannot be removed");
      }
      const node = found.node;
      if (node === undefined) return [];
      const member = node.parent?.type === "property" ? node.parent : node;
      const splices = toSplices(json, removeMember(json, member));
      return verified(adapter, json, splices);
    },
    lint: (doc) => sortedIssues(own<JsonDoc>(doc, id)),
    apply: (bytes, splices) => applySplices(bytes, splices),
  };
  return adapter;
}

/** Strict JSON (Enshrouded): comments and trailing commas are errors. */
export const jsonAdapter = createJsonAdapter({ id: "json", strict: true });

/** JSON with comments and trailing commas allowed on read. */
export const jsoncAdapter = createJsonAdapter({ id: "jsonc", strict: false });

/** Every pointer of a parsed JSON document, for tests and fuzzing. */
export function jsonLocators(doc: ParsedDoc): JsonLocator[] {
  const json = doc as JsonDoc;
  const out: JsonLocator[] = [];
  const walk = (node: JsonNode, pointer: string): void => {
    out.push({ kind: "json", pointer });
    const children = node.children ?? [];
    if (node.type === "array") {
      children.forEach((child, i) => walk(child, `${pointer}/${i}`));
      return;
    }
    if (node.type !== "object") return;
    const keys = children.map((property) => property.children?.at(0)?.value);
    for (const property of children) {
      const [key, value] = property.children ?? [];
      const name = key?.value;
      const unique = keys.filter((k) => k === name).length === 1;
      if (typeof name === "string" && value !== undefined && unique) {
        walk(value, `${pointer}/${escapePointer(name)}`);
      }
    }
  };
  if (json.root !== undefined) walk(json.root, "");
  return out;
}
