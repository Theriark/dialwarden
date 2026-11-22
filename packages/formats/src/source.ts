// Byte-exact view of a file. Adapters parse a "binary string": one character
// per byte (codes 0 to 255), so string offsets are byte offsets and no byte
// can change by being decoded and encoded again. Values are decoded from
// their byte range as UTF-8 only when they are read.

import {
  FormatError,
  type LintIssue,
  type Locator,
  type ParsedDoc,
  type Severity,
  type Splice,
} from "./types.js";

// ignoreBOM keeps a U+FEFF inside the file as text; the file's own BOM is
// never part of a slice (begin skips it).
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** One line: content is [start, end); next is the start of the next line. */
export interface Line {
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

/** UTF-8 text of bytes, a leading U+FEFF kept as text. */
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export function toBinary(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8Strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

export class Source {
  readonly bytes: Uint8Array;
  /** One character per byte. */
  readonly text: string;
  readonly bom: boolean;
  /** First byte after the BOM. */
  readonly begin: number;
  readonly newline: "\n" | "\r\n";
  readonly lines: readonly Line[];
  readonly issues: LintIssue[] = [];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.text = toBinary(bytes);
    this.bom = this.text.startsWith("\xEF\xBB\xBF");
    this.begin = this.bom ? 3 : 0;
    const lf = this.text.indexOf("\n");
    const crlf = lf > 0 && this.text.charAt(lf - 1) === "\r";
    this.newline = crlf ? "\r\n" : "\n";
    const lines: Line[] = [];
    let start = this.begin;
    for (;;) {
      const nl = this.text.indexOf("\n", start);
      if (nl < 0) {
        lines.push({ start, end: this.text.length, next: this.text.length });
        break;
      }
      const cr = nl > start && this.text.charAt(nl - 1) === "\r";
      lines.push({ start, end: cr ? nl - 1 : nl, next: nl + 1 });
      start = nl + 1;
    }
    this.lines = lines;
    if (this.text.startsWith("\xFF\xFE") || this.text.startsWith("\xFE\xFF")) {
      this.issue(0, "unsupported-encoding", "error", "UTF-16 is not supported");
    } else if (!isValidUtf8(bytes)) {
      this.issue(this.begin, "invalid-utf8", "warning", "not valid UTF-8");
    }
  }

  get length(): number {
    return this.text.length;
  }

  /** UTF-8 text of a byte range. */
  slice(start: number, end: number): string {
    return utf8.decode(this.bytes.subarray(start, end));
  }

  /** Index of the line that contains offset. */
  lineIndex(offset: number): number {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const line = this.lines.at(mid);
      if (line !== undefined && line.start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The line that contains offset. */
  lineAt(offset: number): Line {
    const line = this.lines.at(this.lineIndex(offset));
    return line ?? { start: 0, end: 0, next: 0 };
  }

  /** 1-based line and character column of a byte offset. */
  position(offset: number): { line: number; column: number } {
    const index = this.lineIndex(offset);
    const start = this.lines.at(index)?.start ?? 0;
    let column = 1;
    for (let i = start; i < offset && i < this.text.length; i++) {
      // Count characters, not bytes: UTF-8 continuation bytes are skipped.
      if ((this.text.charCodeAt(i) & 192) !== 128) column++;
    }
    return { line: index + 1, column };
  }

  issue(
    offset: number,
    code: string,
    severity: Severity,
    message: string,
    locator?: Locator,
  ): void {
    const { line, column } = this.position(offset);
    const issue: LintIssue = { code, severity, line, column, message };
    this.issues.push(locator ? { ...issue, locator } : issue);
  }

  /** True when the file is empty (after the BOM) or ends with a line break. */
  endsWithNewline(): boolean {
    return this.length === this.begin || this.text.endsWith("\n");
  }

  /** First offset in [from, to) that is not a space or tab, or to. */
  skipBlank(from: number, to: number): number {
    let i = from;
    while (i < to && isBlank(this.text.charCodeAt(i))) i++;
    return i;
  }

  /** End of [from, to) without trailing spaces and tabs. */
  trimEnd(from: number, to: number): number {
    let i = to;
    while (i > from && isBlank(this.text.charCodeAt(i - 1))) i--;
    return i;
  }

  /** True when [from, to) holds only spaces and tabs. */
  blank(from: number, to: number): boolean {
    return this.skipBlank(from, to) >= to;
  }

  doc(adapter: string): ParsedDoc {
    return {
      adapter,
      bytes: this.bytes,
      newline: this.newline,
      bom: this.bom,
      issues: this.issues,
    };
  }
}

interface Ordered {
  readonly splice: Splice;
  readonly order: number;
}

function byPosition(a: Ordered, b: Ordered): number {
  return (
    a.splice.start - b.splice.start ||
    a.splice.end - b.splice.end ||
    a.order - b.order
  );
}

/**
 * Applies splices to the original bytes. Splices must not overlap; their
 * order does not matter, except that insertions at the same offset keep their
 * order. Bytes outside the splices are copied unchanged.
 */
export function applySplices(
  bytes: Uint8Array,
  splices: readonly Splice[],
): Uint8Array {
  const sorted = splices.map((splice, order) => ({ splice, order }));
  sorted.sort(byPosition);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const { splice } of sorted) {
    const { start, end, text } = splice;
    const valid =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end >= start &&
      end <= bytes.length;
    if (!valid) {
      throw new FormatError(
        "invalid-splice",
        `splice ${start}..${end} is outside the file (0..${bytes.length})`,
      );
    }
    if (start < cursor) {
      throw new FormatError(
        "invalid-splice",
        `splice ${start}..${end} overlaps the previous splice`,
      );
    }
    if (typeof text !== "string") {
      throw new FormatError("invalid-splice", "splice text must be a string");
    }
    parts.push(bytes.subarray(cursor, start), encodeUtf8(text));
    cursor = end;
  }
  parts.push(bytes.subarray(cursor));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Throws unless doc was parsed by this adapter. */
export function own<D extends ParsedDoc>(doc: ParsedDoc, adapter: string): D {
  if (doc.adapter !== adapter) {
    throw new FormatError(
      "wrong-document",
      `the document was parsed by ${doc.adapter}, not ${adapter}`,
    );
  }
  return doc as D;
}

/** Writes are refused while the document has an error. */
export function writable(doc: ParsedDoc): void {
  const error = doc.issues.find((issue) => issue.severity === "error");
  if (error) {
    const where = `line ${error.line}, column ${error.column}`;
    throw new FormatError(
      "parse-error",
      `the file has an error at ${where} (${error.message}); nothing is written`,
    );
  }
}

/** Copy of the issues, sorted by line and column. */
export function sortedIssues(doc: ParsedDoc): LintIssue[] {
  const issues = [...doc.issues];
  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function wrongLocator(adapter: string, locator: Locator): FormatError {
  return new FormatError(
    "invalid-locator",
    `${adapter} does not accept a ${String(locator.kind)} locator`,
  );
}

/** True when the text holds a line break (refused in one-line values). */
export function hasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}
