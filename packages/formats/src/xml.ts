// XML property lists such as <property name="ServerName" value="My host"/>
// (7 Days to Die's serverconfig.xml). A tokenizer keeps the byte position of
// every tag and attribute, so an edit replaces one attribute value and leaves
// comments, attribute order, quotes and spacing as they were.

import { indentOf, lineRange, mergeRanges, verified } from "./edits.js";
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
  type ParsedDoc,
  type Splice,
  type Value,
  type XmlLocator,
} from "./types.js";
import { booleanText, numberText } from "./values.js";

interface Attribute {
  readonly name: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: string;
}

interface Element {
  readonly name: string;
  readonly start: number;
  /** Offset after the > of the start tag. */
  readonly tagEnd: number;
  readonly attributes: readonly Attribute[];
  readonly selfClosing: boolean;
  /** Offset after the whole element (its end tag when it has one). */
  end: number;
  /** Offset of the end tag, or -1. */
  endTag: number;
}

interface Property {
  readonly name: string;
  readonly element: Element;
  readonly value: Attribute | undefined;
  readonly nameAttribute: Attribute;
}

interface XmlDoc extends ParsedDoc {
  readonly source: Source;
  readonly root: Element | undefined;
  readonly properties: readonly Property[];
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

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isNameChar(ch: string): boolean {
  if (ch === "") return false;
  const code = ch.charCodeAt(0);
  if (code >= 128) return true;
  return /[A-Za-z0-9_:.-]/.test(ch);
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charAt(i))) i++;
  return i;
}

function scanName(text: string, from: number): number {
  let i = from;
  while (i < text.length && isNameChar(text.charAt(i))) i++;
  return i;
}

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeEntity(whole: string, body: string): string {
  if (!body.startsWith("#")) return ENTITIES.get(body) ?? whole;
  const hex = body.startsWith("#x") || body.startsWith("#X");
  const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  try {
    return String.fromCodePoint(code);
  } catch {
    return whole;
  }
}

const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g;

/** An attribute value as an XML reader sees it. */
export function decodeAttribute(raw: string): string {
  const normalised = raw.replace(/\r\n?/g, "\n").replace(/[\t\n]/g, " ");
  return normalised.replace(ENTITY, decodeEntity);
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
  ["\t", "&#9;"],
  ["\n", "&#10;"],
  ["\r", "&#13;"],
]);

/** Text for an attribute value inside the given quote character. */
export function encodeAttribute(text: string, quote: string): string {
  let out = "";
  for (const ch of text) {
    const other = (ch === '"' || ch === "'") && ch !== quote;
    const escaped = ESCAPES.get(ch) ?? ch;
    out += other ? ch : escaped;
  }
  return out;
}

function parseTag(src: Source, start: number): Element {
  const text = src.text;
  const nameEnd = scanName(text, start + 1);
  if (nameEnd === start + 1) {
    throw new ParseFail(start, "syntax", "< is not followed by a tag name");
  }
  const attributes: Attribute[] = [];
  let i = nameEnd;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) {
      throw new ParseFail(start, "unclosed-tag", "the tag is not closed");
    }
    const selfClosing = text.startsWith("/>", i);
    if (selfClosing || text.charAt(i) === ">") {
      const tagEnd = i + (selfClosing ? 2 : 1);
      const name = src.slice(start + 1, nameEnd);
      const end = tagEnd;
      return { name, start, tagEnd, attributes, selfClosing, end, endTag: -1 };
    }
    attributes.push(parseAttribute(src, start, i));
    i = (attributes.at(-1)?.valueEnd ?? i) + 1;
  }
}

function parseAttribute(src: Source, tag: number, at: number): Attribute {
  const text = src.text;
  const nameEnd = scanName(text, at);
  if (nameEnd === at) {
    throw new ParseFail(at, "syntax", "expected an attribute name, > or />");
  }
  const eq = skipSpace(text, nameEnd);
  if (text.charAt(eq) !== "=") {
    throw new ParseFail(eq, "syntax", "the attribute has no = value");
  }
  const open = skipSpace(text, eq + 1);
  const quote = text.charAt(open);
  if (quote !== '"' && quote !== "'") {
    throw new ParseFail(open, "syntax", "the attribute value has no quotes");
  }
  const close = text.indexOf(quote, open + 1);
  if (close < 0) {
    throw new ParseFail(tag, "unclosed-tag", "the tag is not closed");
  }
  const lt = text.indexOf("<", open + 1);
  if (lt >= 0 && lt < close) {
    throw new ParseFail(lt, "syntax", "< is not allowed in an attribute value");
  }
  const name = src.slice(at, nameEnd);
  return { name, valueStart: open + 1, valueEnd: close, quote };
}

const SKIPPED: readonly [string, string, string][] = [
  ["<!--", "-->", "unclosed-comment"],
  ["<![CDATA[", "]]>", "unclosed-cdata"],
  ["<?", "?>", "unclosed-declaration"],
  ["<!", ">", "unclosed-declaration"],
];

interface Tree {
  root: Element | undefined;
  readonly properties: Property[];
}

function closeTag(src: Source, at: number, stack: Element[]): number {
  const text = src.text;
  const nameEnd = scanName(text, at + 2);
  const gt = skipSpace(text, nameEnd);
  if (text.charAt(gt) !== ">") {
    throw new ParseFail(at, "unclosed-tag", "the end tag is not closed");
  }
  const name = src.slice(at + 2, nameEnd);
  const open = stack.pop();
  if (open === undefined || open.name !== name) {
    const message = `</${name}> does not close the open element`;
    throw new ParseFail(at, "mismatched-tag", message);
  }
  open.end = gt + 1;
  open.endTag = at;
  return gt + 1;
}

function openTag(src: Source, at: number, stack: Element[], tree: Tree) {
  const element = parseTag(src, at);
  if (stack.length === 0 && tree.root === undefined) tree.root = element;
  if (!element.selfClosing) stack.push(element);
  const seen = new Set<string>();
  for (const attribute of element.attributes) {
    if (seen.has(attribute.name)) {
      const message = `the attribute ${attribute.name} appears twice`;
      src.issue(attribute.valueStart, "duplicate-attribute", "error", message);
    }
    seen.add(attribute.name);
  }
  const named = (n: string) => element.attributes.find((a) => a.name === n);
  const nameAttribute = named("name");
  if (element.name === "property" && nameAttribute === undefined) {
    src.issue(at, "property-without-name", "warning", "no name attribute");
  }
  if (element.name === "property" && nameAttribute !== undefined) {
    const raw = src.slice(nameAttribute.valueStart, nameAttribute.valueEnd);
    const name = decodeAttribute(raw);
    const value = named("value");
    tree.properties.push({ name, element, value, nameAttribute });
  }
  return element.tagEnd;
}

function tokenize(src: Source, tree: Tree): void {
  const text = src.text;
  const stack: Element[] = [];
  let i = src.begin;
  try {
    for (;;) {
      const lt = text.indexOf("<", i);
      if (lt < 0) break;
      const skip = SKIPPED.find(([open]) => text.startsWith(open, lt));
      if (skip) {
        const [open, close, code] = skip;
        const end = text.indexOf(close, lt + open.length);
        if (end < 0) throw new ParseFail(lt, code, `${open} is not closed`);
        i = end + close.length;
      } else if (text.startsWith("</", lt)) {
        i = closeTag(src, lt, stack);
      } else {
        i = openTag(src, lt, stack, tree);
      }
    }
  } catch (fail) {
    if (!(fail instanceof ParseFail)) throw fail;
    src.issue(fail.offset, fail.code, "error", fail.message);
    return;
  }
  for (const open of stack) {
    const message = `<${open.name}> is never closed`;
    src.issue(open.start, "unclosed-element", "error", message);
  }
}

function parse(bytes: Uint8Array): XmlDoc {
  const src = new Source(bytes);
  const tree: Tree = { root: undefined, properties: [] };
  tokenize(src, tree);
  const seen = new Set<string>();
  for (const property of tree.properties) {
    if (seen.has(property.name)) {
      const message = `the property ${property.name} appears more than once`;
      const locator: XmlLocator = { kind: "xml", property: property.name };
      const at = property.element.start;
      src.issue(at, "duplicate-key", "warning", message, locator);
    }
    seen.add(property.name);
  }
  const { root, properties } = tree;
  return { ...src.doc("xml"), source: src, root, properties };
}

function find(doc: XmlDoc, locator: XmlLocator): Property[] {
  if (locator.kind !== "xml") throw wrongLocator("xml", locator);
  if (typeof locator.property !== "string") {
    throw new FormatError("invalid-locator", "xml: property must be text");
  }
  return doc.properties.filter((p) => p.name === locator.property);
}

function valueText(value: Value, previous: string | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberText(value, previous);
  if (typeof value === "boolean") return booleanText(value, previous, "lower");
  throw new FormatError("invalid-value", "use text, a number or a boolean");
}

function rawValue(doc: XmlDoc, attribute: Attribute | undefined): string {
  if (attribute === undefined) return "";
  return doc.source.slice(attribute.valueStart, attribute.valueEnd);
}

function setProperty(doc: XmlDoc, property: Property, value: Value): Splice {
  const previous = decodeAttribute(rawValue(doc, property.value));
  const text = valueText(value, previous);
  const attribute = property.value;
  if (attribute === undefined) {
    const at = property.nameAttribute.valueEnd + 1;
    const quote = property.nameAttribute.quote;
    const encoded = encodeAttribute(text, quote);
    return { start: at, end: at, text: ` value=${quote}${encoded}${quote}` };
  }
  const encoded = encodeAttribute(text, attribute.quote);
  const { valueStart: start, valueEnd: end } = attribute;
  return { start, end, text: encoded };
}

function indentUnit(src: Source): string {
  const tabbed = src.lines.some((line) => src.text.charAt(line.start) === "\t");
  return tabbed ? "\t" : "  ";
}

/** True when text holds only spaces, tabs and complete comments. */
function onlyComments(text: string): boolean {
  let i = 0;
  for (;;) {
    while (text.charAt(i) === " " || text.charAt(i) === "\t") i++;
    if (i >= text.length) return true;
    if (!text.startsWith("<!--", i)) return false;
    const close = text.indexOf("-->", i + 4);
    if (close < 0) return false;
    i = close + 3;
  }
}

function insertProperty(doc: XmlDoc, name: string, value: Value): Splice {
  const src = doc.source;
  const anchor = doc.properties.at(-1)?.element;
  const close = anchor && src.text.slice(anchor.tagEnd - 3, anchor.tagEnd);
  const tail = close === " />" ? " />" : "/>";
  const encodedName = encodeAttribute(name, '"');
  const encodedValue = encodeAttribute(valueText(value, undefined), '"');
  const element = `<property name="${encodedName}" value="${encodedValue}"${tail}`;
  if (anchor) {
    const indent = indentOf(src, src.lineAt(anchor.start));
    const text = src.newline + indent + element;
    // After the end of the anchor's line when only blanks and comments follow
    // it there, so they stay with the property they follow.
    const end = src.lineAt(anchor.end - 1).end;
    const rest = src.text.slice(anchor.end, end);
    const at = onlyComments(rest) ? end : anchor.end;
    return { start: at, end: at, text };
  }
  const root = doc.root;
  if (root === undefined || root.endTag < 0) {
    throw new FormatError("not-found", "the file has no element to add to");
  }
  const line = src.lineAt(root.endTag);
  if (!src.blank(line.start, root.endTag)) {
    return { start: root.endTag, end: root.endTag, text: element };
  }
  const indent = indentOf(src, src.lineAt(root.start)) + indentUnit(src);
  const text = indent + element + src.newline;
  return { start: line.start, end: line.start, text };
}

function removeProperties(doc: XmlDoc, properties: Property[]): Splice[] {
  const src = doc.source;
  const ranges = properties.map(({ element }) => {
    const first = src.lineAt(element.start);
    const last = src.lineAt(element.end - 1);
    const before = src.blank(first.start, element.start);
    const after = src.blank(element.end, last.end);
    if (before && after) return lineRange(src, first, last);
    return { start: element.start, end: element.end };
  });
  return mergeRanges(ranges);
}

/** XML property list adapter (7 Days to Die serverconfig.xml). */
export const xmlAdapter: FormatAdapter<XmlLocator> = {
  id: "xml",
  parse,
  get(doc, locator) {
    const xml = own<XmlDoc>(doc, "xml");
    const property = find(xml, locator).at(-1);
    if (property === undefined) return undefined;
    return decodeAttribute(rawValue(xml, property.value));
  },
  set(doc, locator, value) {
    const xml = own<XmlDoc>(doc, "xml");
    writable(xml);
    const found = find(xml, locator);
    if (found.length > 1) {
      throw new FormatError("ambiguous", `${locator.property} appears twice`);
    }
    const property = found.at(0);
    if (property === undefined) {
      throw new FormatError("not-found", `${locator.property} does not exist`);
    }
    return verified(xmlAdapter, xml, [setProperty(xml, property, value)]);
  },
  insert(doc, locator, value) {
    const xml = own<XmlDoc>(doc, "xml");
    writable(xml);
    if (find(xml, locator).length > 0) {
      throw new FormatError("exists", `${locator.property} already exists`);
    }
    const splice = insertProperty(xml, locator.property, value);
    return verified(xmlAdapter, xml, [splice]);
  },
  remove(doc, locator) {
    const xml = own<XmlDoc>(doc, "xml");
    writable(xml);
    const splices = removeProperties(xml, find(xml, locator));
    return verified(xmlAdapter, xml, splices);
  },
  lint: (doc) => sortedIssues(own<XmlDoc>(doc, "xml")),
  apply: (bytes, splices) => applySplices(bytes, splices),
};

/** Every property locator of a parsed XML document, for tests and fuzzing. */
export function xmlLocators(doc: ParsedDoc): XmlLocator[] {
  const names = (doc as XmlDoc).properties.map((p) => p.name);
  const unique = names.filter((n, i) => names.indexOf(n) === i);
  return unique.map((property): XmlLocator => ({ kind: "xml", property }));
}
