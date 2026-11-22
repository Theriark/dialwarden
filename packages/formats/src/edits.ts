// Helpers the adapters use to build splices safely.

import { applySplices, type Line, type Source } from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type ParsedDoc,
  type Splice,
} from "./types.js";

/**
 * Applies the splices to a copy and parses the result. An edit that would
 * leave an error in a file that had none is refused, so a write can never
 * produce a file the adapter itself cannot read.
 */
export function verified(
  adapter: Pick<FormatAdapter, "id" | "parse">,
  doc: ParsedDoc,
  splices: Splice[],
): Splice[] {
  if (splices.length === 0) return splices;
  const after = adapter.parse(applySplices(doc.bytes, splices));
  const error = after.issues.find((issue) => issue.severity === "error");
  if (error) {
    const where = `line ${error.line}, column ${error.column}`;
    throw new FormatError(
      "invalid-value",
      `${adapter.id}: the edit would cause an error at ${where} (${error.message})`,
    );
  }
  return splices;
}

interface Range {
  start: number;
  end: number;
}

/** Merges overlapping or touching deletions into single splices. */
export function mergeRanges(ranges: readonly Range[]): Splice[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ start: range.start, end: range.end });
    }
  }
  return out.map((range) => ({ start: range.start, end: range.end, text: "" }));
}

/** The range that deletes lines first to last, line breaks included. */
export function lineRange(source: Source, first: Line, last: Line): Range {
  if (last.next > last.end) return { start: first.start, end: last.next };
  // The last line of the file has no line break: take the one before it.
  const index = source.lines.indexOf(first);
  const previous = index > 0 ? source.lines.at(index - 1) : undefined;
  return { start: previous ? previous.end : first.start, end: last.end };
}

/** Splices that delete whole lines, merged when they touch. */
export function removeLines(source: Source, lines: readonly Line[]): Splice[] {
  return mergeRanges(lines.map((line) => lineRange(source, line, line)));
}

/** Leading spaces and tabs of a line. */
export function indentOf(source: Source, line: Line): string {
  return source.slice(line.start, source.skipBlank(line.start, line.end));
}

/** A splice that appends text as new lines at the end of the file. */
export function appendLines(source: Source, lines: readonly string[]): Splice {
  const nl = source.newline;
  const body = lines.join(nl);
  const at = source.length;
  if (source.endsWithNewline()) return { start: at, end: at, text: body + nl };
  return { start: at, end: at, text: nl + body };
}
