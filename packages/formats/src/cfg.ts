// Console cfg files (Source server.cfg, Rust server.cfg): one command per
// statement, such as hostname "My server" or server.hostname "x". Statements
// end at a line break or a ; outside quotes, and // starts a comment. Names
// are compared without case. As in the games, the last statement of a
// command wins: get and set use it, remove removes every statement.

import { appendLines, lineRange, mergeRanges, verified } from "./edits.js";
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
  type CfgLocator,
  type FormatAdapter,
  type ParsedDoc,
  type Splice,
  type Value,
} from "./types.js";
import { booleanText, numberText } from "./values.js";

interface Word {
  readonly start: number;
  readonly end: number;
  readonly quoted: boolean;
}

interface Statement {
  readonly command: string;
  readonly line: Line;
  readonly start: number;
  readonly end: number;
  readonly commandEnd: number;
  readonly args: readonly Word[];
  /** Offset of the ; after the statement, or -1. */
  readonly sep: number;
}

interface CfgDoc extends ParsedDoc {
  readonly source: Source;
  readonly statements: readonly Statement[];
}

function words(src: Source, from: number, to: number): Word[] | number {
  const text = src.text;
  const out: Word[] = [];
  let i = src.skipBlank(from, to);
  while (i < to) {
    if (text.charAt(i) === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0 || close >= to) return i;
      out.push({ start: i, end: close + 1, quoted: true });
      i = close + 1;
    } else {
      let j = i;
      while (j < to && !/[ \t"]/.test(text.charAt(j))) j++;
      out.push({ start: i, end: j, quoted: false });
      i = j;
    }
    i = src.skipBlank(i, to);
  }
  return out;
}

/** Statement ends on a line: [start, end) pairs and the ; after each. */
function split(src: Source, line: Line): { end: number; sep: number }[] {
  const text = src.text;
  const out: { end: number; sep: number }[] = [];
  let quoted = false;
  for (let i = line.start; i < line.end; i++) {
    const ch = text.charAt(i);
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ";") out.push({ end: i, sep: i });
    else if (!quoted && text.startsWith("//", i)) {
      out.push({ end: i, sep: -1 });
      return out;
    }
  }
  out.push({ end: line.end, sep: -1 });
  return out;
}

function parse(bytes: Uint8Array): CfgDoc {
  const src = new Source(bytes);
  const statements: Statement[] = [];
  for (const line of src.lines) {
    let from = line.start;
    for (const { end, sep } of split(src, line)) {
      const found = words(src, from, end);
      from = sep + 1;
      if (typeof found === "number") {
        src.issue(found, "unclosed-string", "error", "the quote is not closed");
        break;
      }
      const [first, ...args] = found;
      if (first === undefined) continue;
      const command = src.slice(first.start, first.end).replace(/"/g, "");
      const stop = args.at(-1)?.end ?? first.end;
      const statement = { command, line, start: first.start, end: stop };
      statements.push({ ...statement, commandEnd: first.end, args, sep });
    }
  }
  const seen = new Set<string>();
  for (const statement of statements) {
    const name = statement.command.toLowerCase();
    if (seen.has(name)) {
      const message = `${statement.command} is set more than once; the last wins`;
      const locator: CfgLocator = { kind: "cfg", command: statement.command };
      const at = statement.start;
      src.issue(at, "duplicate-key", "warning", message, locator);
    }
    seen.add(name);
  }
  return { ...src.doc("cfg"), source: src, statements };
}

function find(doc: CfgDoc, locator: CfgLocator): Statement[] {
  if (locator.kind !== "cfg") throw wrongLocator("cfg", locator);
  const { command } = locator;
  if (typeof command !== "string" || command === "") {
    throw new FormatError("invalid-locator", "cfg: the command is empty");
  }
  const name = command.toLowerCase();
  return doc.statements.filter((s) => s.command.toLowerCase() === name);
}

function argsValue(doc: CfgDoc, statement: Statement): string {
  const { args } = statement;
  const first = args.at(0);
  if (first === undefined) return "";
  if (args.length === 1 && first.quoted) {
    return doc.source.slice(first.start + 1, first.end - 1);
  }
  return doc.source.slice(first.start, statement.end);
}

function needsQuotes(text: string): boolean {
  // A final / could start a // comment that follows the value directly.
  const slash = text.includes("//") || text.endsWith("/");
  return text === "" || /[\s;]/.test(text) || slash;
}

function valueText(value: Value, previous: string | undefined): string {
  if (typeof value === "string") {
    if (value.includes('"') || hasLineBreak(value)) {
      throw new FormatError(
        "invalid-value",
        "quotes and line breaks cannot be written to a cfg value",
      );
    }
    return value;
  }
  if (typeof value === "number") return numberText(value, previous);
  if (typeof value !== "boolean") {
    throw new FormatError("invalid-value", "use text, a number or a boolean");
  }
  const digit = previous === undefined || /^[01]$/.test(previous);
  if (digit) return value ? "1" : "0";
  return booleanText(value, previous, "lower");
}

function setStatement(doc: CfgDoc, statement: Statement, value: Value): Splice {
  const first = statement.args.at(0);
  const previous = first && argsValue(doc, statement);
  const text = valueText(value, previous);
  const quoted = first?.quoted === true && statement.args.length === 1;
  const final = quoted || needsQuotes(text) ? `"${text}"` : text;
  if (first === undefined) {
    const at = statement.commandEnd;
    return { start: at, end: at, text: ` ${final}` };
  }
  // hostname"x": a bare value right after the command would join its word.
  const joined = first.start === statement.commandEnd && !final.startsWith('"');
  const gap = joined ? " " : "";
  return { start: first.start, end: statement.end, text: gap + final };
}

function statementRange(doc: CfgDoc, statement: Statement) {
  const src = doc.source;
  const { line, sep } = statement;
  const onLine = doc.statements.filter((s) => s.line === line);
  const rest = src.skipBlank(sep >= 0 ? sep + 1 : statement.end, line.end);
  const before = src.blank(line.start, statement.start);
  if (onLine.length === 1 && before && rest >= line.end) {
    return lineRange(src, line, line);
  }
  if (sep >= 0) return { start: statement.start, end: rest };
  const index = onLine.indexOf(statement);
  const previous = index > 0 ? onLine.at(index - 1) : undefined;
  if (previous) return { start: previous.sep, end: statement.end };
  return { start: statement.start, end: statement.end };
}

/** Console cfg adapter (hostname "x", server.hostname "x"). */
export const cfgAdapter: FormatAdapter<CfgLocator> = {
  id: "cfg",
  parse,
  get(doc, locator) {
    const cfg = own<CfgDoc>(doc, "cfg");
    const statement = find(cfg, locator).at(-1);
    return statement && argsValue(cfg, statement);
  },
  set(doc, locator, value) {
    const cfg = own<CfgDoc>(doc, "cfg");
    writable(cfg);
    const statement = find(cfg, locator).at(-1);
    if (statement === undefined) {
      throw new FormatError("not-found", `${locator.command} does not exist`);
    }
    return verified(cfgAdapter, cfg, [setStatement(cfg, statement, value)]);
  },
  insert(doc, locator, value) {
    const cfg = own<CfgDoc>(doc, "cfg");
    writable(cfg);
    if (find(cfg, locator).length > 0) {
      throw new FormatError("exists", `${locator.command} already exists`);
    }
    const { command } = locator;
    if (/[\s";]/.test(command) || command.includes("//")) {
      throw new FormatError("invalid-locator", `${command} is not a command`);
    }
    const text = valueText(value, undefined);
    const quoted = typeof value === "string" ? `"${text}"` : text;
    const line = `${command} ${quoted}`;
    return verified(cfgAdapter, cfg, [appendLines(cfg.source, [line])]);
  },
  remove(doc, locator) {
    const cfg = own<CfgDoc>(doc, "cfg");
    writable(cfg);
    const ranges = find(cfg, locator).map((s) => statementRange(cfg, s));
    return verified(cfgAdapter, cfg, mergeRanges(ranges));
  },
  lint: (doc) => sortedIssues(own<CfgDoc>(doc, "cfg")),
  apply: (bytes, splices) => applySplices(bytes, splices),
};

/** Every command locator of a parsed cfg document, for tests and fuzzing. */
export function cfgLocators(doc: ParsedDoc): CfgLocator[] {
  const all = (doc as CfgDoc).statements.map((s) => s.command);
  const names = all.filter((name) => name !== "");
  const lower = names.map((n) => n.toLowerCase());
  const unique = names.filter((n, i) => lower.indexOf(n.toLowerCase()) === i);
  return unique.map((command): CfgLocator => ({ kind: "cfg", command }));
}
