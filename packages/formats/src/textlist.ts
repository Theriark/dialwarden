// Plain-text list files (dev-work-plan P6-A: the Valheim adminlist.txt,
// bannedlist.txt and permittedlist.txt). The game reads one player id per
// line and rewrites the files itself, so the adapter keeps everything else
// byte for byte: // comment lines, blank lines, a UTF-8 BOM, CRLF line
// endings, leading and trailing spaces and a missing final line break. The
// whole file is one list: get returns every value line, set rewrites them.
// A line with a value that would read back as a comment or that carries a
// line break is refused, because the game could not read it back.
import { removeLines, verified } from "./edits.js";
import {
  applySplices,
  decodeUtf8,
  isBlank,
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
  type ParsedDoc,
  type Splice,
  type TextListLocator,
  type Value,
} from "./types.js";
import { booleanText, numberText } from "./values.js";

interface Entry {
  /** The whole line the value sits on. */
  readonly line: Line;
  /** The trimmed span of the value inside the line. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface TextListDoc extends ParsedDoc {
  readonly source: Source;
  readonly entries: readonly Entry[];
}

/** The text of one list item, or a FormatError when it cannot be stored. */
function itemText(value: Value): string {
  if (typeof value === "string") {
    if (value.trim() === "" || value !== value.trim()) {
      throw new FormatError(
        "invalid-value",
        "a list item cannot hold leading or trailing spaces",
      );
    }
    return value;
  }
  if (typeof value === "number") {
    return numberText(value, undefined);
  }
  if (typeof value === "boolean") {
    return booleanText(value, undefined, "lower");
  }
  throw new FormatError("invalid-value", "a list item must be text");
}

/** Refuses an item the game could not read back. */
function checked(value: Value): string {
  const text = itemText(value);
  if (text.startsWith("//")) {
    throw new FormatError(
      "invalid-value",
      "a list item cannot start a comment line",
    );
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new FormatError("invalid-value", "a list item cannot hold a break");
  }
  return text;
}

function parse(bytes: Uint8Array): TextListDoc {
  const source = new Source(bytes);
  const entries: Entry[] = [];
  for (const line of source.lines) {
    let start = line.start;
    while (start < line.end && isBlank(source.text.charCodeAt(start))) {
      start += 1;
    }
    if (start >= line.end) continue;
    if (source.text.startsWith("//", start)) continue;
    let end = line.end;
    while (end > start && isBlank(source.text.charCodeAt(end - 1))) {
      end -= 1;
    }
    entries.push({ line, valueStart: start, valueEnd: end });
  }
  return { ...source.doc("textlist"), source, entries };
}

/**
 * Splices that add values as new lines after the given line. The line breaks
 * of the file are used; a file that ends without one keeps that style when
 * the values become the last content of the file.
 */
function insertAfter(
  source: Source,
  line: Line | undefined,
  values: readonly string[],
): Splice {
  const nl = source.newline;
  const body = values.join(nl);
  if (line === undefined || source.length === source.begin) {
    return { start: source.length, end: source.length, text: body };
  }
  if (line.start === source.length) {
    // The empty line after a final break: the values keep that break.
    return { start: source.length, end: source.length, text: `${body}${nl}` };
  }
  if (line.next > line.end) {
    return { start: line.next, end: line.next, text: `${body}${nl}` };
  }
  return { start: line.end, end: line.end, text: `${nl}${body}` };
}

/** The value a set writes: every item must be a usable list item. */
function listOf(value: Value): string[] {
  if (!Array.isArray(value)) {
    throw new FormatError("invalid-value", "a text list holds a list");
  }
  return value.map(checked);
}

function setSplices(doc: TextListDoc, values: readonly string[]): Splice[] {
  const source = doc.source;
  const entries = [...doc.entries];
  const splices: Splice[] = [];
  const shared = Math.min(entries.length, values.length);
  for (let index = 0; index < shared; index += 1) {
    const entry = entries.at(index);
    const next = values.at(index) ?? "";
    if (entry !== undefined && entry.valueStart !== entry.valueEnd) {
      splices.push({
        start: entry.valueStart,
        end: entry.valueEnd,
        text: next,
      });
    }
  }
  if (values.length > entries.length) {
    const extra = values.slice(entries.length);
    const after = entries.at(-1)?.line ?? source.lines.at(-1);
    splices.push(insertAfter(source, after, extra));
  } else if (values.length < entries.length) {
    const removed = entries.slice(values.length).map((entry) => entry.line);
    splices.push(...removeLines(source, removed));
  }
  return splices;
}

/** Plain-text list adapter: the whole file is one list of values. */
export const textListAdapter: FormatAdapter<TextListLocator> = {
  id: "textlist",
  parse,
  get(doc, locator) {
    checkLocator(locator);
    const list = own<TextListDoc>(doc, "textlist");
    return list.entries.map((entry) =>
      decodeUtf8(list.source.bytes.subarray(entry.valueStart, entry.valueEnd)),
    );
  },
  set(doc, locator, value) {
    checkLocator(locator);
    const list = own<TextListDoc>(doc, "textlist");
    writable(list);
    return verified(textListAdapter, list, setSplices(list, listOf(value)));
  },
  insert(doc, locator, value) {
    // The locator is the whole file: adding the list writes it the same way.
    return textListAdapter.set(doc, locator, value);
  },
  remove(doc, locator) {
    checkLocator(locator);
    const list = own<TextListDoc>(doc, "textlist");
    writable(list);
    const lines = list.entries.map((entry) => entry.line);
    return verified(textListAdapter, list, removeLines(list.source, lines));
  },
  lint: (doc) => sortedIssues(own<TextListDoc>(doc, "textlist")),
  apply: (bytes, splices) => applySplices(bytes, splices),
};

function checkLocator(locator: TextListLocator): void {
  if (locator.kind !== "textlist") throw wrongLocator("textlist", locator);
}
