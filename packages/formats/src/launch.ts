// Launch arguments: a command line as a start script or a launch option field
// holds it. Words are split and unquoted as the shell does ('...', "..." and
// \ escapes). Three kinds of argument are recognised, named with their sigil:
//   -port=8211, -port 8211 or -log     dash flags
//   +maxplayers 16                     plus convars
//   TheIsland?listen?SessionName=X     ARK question-mark chains (?listen)
// Order is kept: a new chain option goes to the end of its chain and a new
// flag to the end of the line. Names are compared without case.

import { verified } from "./edits.js";
import {
  applySplices,
  decodeUtf8,
  own,
  Source,
  sortedIssues,
  writable,
  wrongLocator,
} from "./source.js";
import {
  FormatError,
  type FormatAdapter,
  type LaunchLocator,
  type LintIssue,
  type ParsedDoc,
  type Splice,
  type Value,
} from "./types.js";
import { booleanText, numberText } from "./values.js";

/** Quoting of a decoded byte: 0 unquoted, 1 "...", 2 '...'. */
type Context = 0 | 1 | 2;

interface Char {
  readonly byte: number;
  /** Raw range of the byte, its escape included. */
  readonly from: number;
  readonly to: number;
  readonly context: Context;
  /** Quoted segment the byte belongs to; -1 when unquoted. */
  readonly segment: number;
}

interface Word {
  readonly start: number;
  readonly end: number;
  readonly chars: readonly Char[];
  /** Decoded bytes, one character per byte. */
  readonly text: string;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

interface Arg {
  readonly name: string;
  readonly word: Word;
  /** A separate value word (-port 8211). */
  readonly valueWord: Word | undefined;
  /**
   * A second value word, the shape of a keyed argument: -modifier combat
   * veryhard names its key with the first word (combat) and holds the value
   * in the second (veryhard).
   */
  readonly extraWord: Word | undefined;
  /** Decoded range of an inline value (-port=8211, ?Name=X). */
  readonly inline: Range | undefined;
  /** Decoded range of a chain option, from its ? to its end. */
  readonly option: Range | undefined;
}

interface LaunchDoc extends ParsedDoc {
  readonly source: Source;
  readonly words: readonly Word[];
  readonly args: readonly Arg[];
}

class ParseFail extends Error {
  readonly offset: number;

  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

const SPACE = /[ \t\n\r\f\v]/;
const SAFE = /^[A-Za-z0-9_./:@%+,=-]*$/;

function decode(chars: readonly Char[]): string {
  return decodeUtf8(new Uint8Array(chars.map((c) => c.byte)));
}

// Words ---------------------------------------------------------------------

function quoted(
  text: string,
  open: number,
  segment: number,
  chars: Char[],
): number {
  const quote = text.charAt(open);
  const context: Context = quote === '"' ? 1 : 2;
  let i = open + 1;
  for (;;) {
    const c = text.charAt(i);
    if (c === "") throw new ParseFail(open, `the ${quote} is not closed`);
    if (c === quote) return i + 1;
    const next = text.charAt(i + 1);
    if (context === 1 && c === "\\" && /[\\"$`]/.test(next)) {
      const byte = text.charCodeAt(i + 1);
      chars.push({ byte, from: i, to: i + 2, context, segment });
      i += 2;
    } else if (context === 1 && c === "\\" && next === "\n") {
      i += 2;
    } else {
      const byte = text.charCodeAt(i);
      chars.push({ byte, from: i, to: i + 1, context, segment });
      i++;
    }
  }
}

function readWord(text: string, start: number, first: number): Word {
  const chars: Char[] = [];
  let segment = first;
  let i = start;
  for (;;) {
    const c = text.charAt(i);
    if (c === "" || SPACE.test(c)) break;
    if (c === '"' || c === "'") {
      i = quoted(text, i, segment++, chars);
    } else if (c === "\\" && text.charAt(i + 1) === "\n") {
      i += 2;
    } else if (c === "\\" && text.charAt(i + 1) !== "") {
      const byte = text.charCodeAt(i + 1);
      chars.push({ byte, from: i, to: i + 2, context: 0, segment: -1 });
      i += 2;
    } else {
      const byte = text.charCodeAt(i);
      chars.push({ byte, from: i, to: i + 1, context: 0, segment: -1 });
      i++;
    }
  }
  const decoded = String.fromCharCode(...chars.map((ch) => ch.byte));
  return { start, end: i, chars, text: decoded };
}

function readWords(src: Source): Word[] {
  const text = src.text;
  const words: Word[] = [];
  let segment = 0;
  let i = src.begin;
  for (;;) {
    while (SPACE.test(text.charAt(i))) i++;
    if (text.startsWith("\\\n", i)) {
      i += 2;
      continue;
    }
    if (i >= text.length) return words;
    if (text.charAt(i) === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    const word = readWord(text, i, segment);
    segment += word.chars.length + 1;
    words.push(word);
    i = word.end;
  }
}

// Arguments -----------------------------------------------------------------

/** A word that can be the value of the flag before it. */
function isValueWord(text: string): boolean {
  if (text.startsWith("-") || text.startsWith("+")) return false;
  return !text.includes("?") && !/^[A-Za-z_][A-Za-z0-9_.]*=/.test(text);
}

function chainOptions(word: Word): Arg[] {
  const out: Arg[] = [];
  const text = word.text;
  let mark = text.indexOf("?");
  while (mark >= 0) {
    const next = text.indexOf("?", mark + 1);
    const end = next < 0 ? text.length : next;
    const eq = text.indexOf("=", mark);
    const hasValue = eq >= 0 && eq < end;
    const nameEnd = hasValue ? eq : end;
    const name = `?${decode(word.chars.slice(mark + 1, nameEnd))}`;
    const inline = hasValue ? { start: eq + 1, end } : undefined;
    const option = { start: mark, end };
    out.push({
      name,
      word,
      valueWord: undefined,
      extraWord: undefined,
      inline,
      option,
    });
    mark = next;
  }
  return out;
}

function classify(words: readonly Word[]): Arg[] {
  const args: Arg[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words.at(i);
    if (word === undefined) break;
    const text = word.text;
    const sigil = text.charAt(0);
    if ((sigil === "-" || sigil === "+") && text.length > 1) {
      const eq = text.indexOf("=");
      const next = words.at(i + 1);
      const end = eq > 0 ? eq : text.length;
      const name = decode(word.chars.slice(0, end));
      const inline = eq > 0 ? { start: eq + 1, end: text.length } : undefined;
      const takesNext = eq < 0 && next !== undefined && isValueWord(next.text);
      const valueWord = takesNext ? next : undefined;
      let extraWord: Word | undefined;
      if (takesNext) {
        i++;
        const second = words.at(i + 1);
        extraWord =
          second !== undefined && isValueWord(second.text) ? second : undefined;
        if (extraWord !== undefined) i++;
      }
      args.push({
        name,
        word,
        valueWord,
        extraWord,
        inline,
        option: undefined,
      });
    } else if (text.includes("?")) {
      args.push(...chainOptions(word));
    }
  }
  return args;
}

/** Characters the shell acts on outside quotes. */
const SHELL_UNQUOTED = new Set([";", "&", "|", "`", "$", "(", ")", "<", ">"]);
/** Characters the shell still acts on inside double quotes. */
const SHELL_DOUBLE = new Set(["`", "$"]);

/**
 * Shell characters in a launch line that is run through eval. The start
 * snippets of the app-managed args file hand it to eval (packs-schema
 * launchsources.ts launchSnippets), so that file is shell text: a command
 * substitution, an operator or a line break between words would run as code
 * at the next game start. Single quotes keep everything literal; the writer
 * never emits any of these (it double-quotes words and the validator refuses
 * shell characters in values), so only hand-edited or raw-patched text can
 * hold them. A line break after the last word is fine. Not part of the
 * adapter lint: a start script the user owns may use the shell on purpose;
 * the pack lint applies this to the args file only.
 *
 * The words are read by this module's parser, so the bytes where the parser
 * and the shell disagree are refused first (THE-2605 N1): the parser takes
 * CR, FF and VT for blanks and skips a BOM, where sh and bash read them as
 * word bytes, so a # after one of them would be a comment to the parser
 * only. Every control byte but tab and LF is refused, CR too unless it ends
 * a CRLF line, and so is a BOM.
 */
export function launchShellIssues(bytes: Uint8Array): LintIssue[] {
  const src = new Source(bytes);
  const flag = shellFlag(src);
  controlBytes(src, flag);
  let words: Word[] | undefined;
  try {
    words = readWords(src);
  } catch (fail) {
    // An unclosed quote is already an error of the adapter lint.
    if (!(fail instanceof ParseFail)) throw fail;
  }
  if (words !== undefined) shellIssues(src, words, flag);
  return sortedIssues(src.doc("launch")).filter(
    (issue) => issue.code === "shell-character",
  );
}

function shellFlag(src: Source): (at: number) => void {
  const message =
    "the launch line holds a shell character the start script would run";
  return (at) => {
    src.issue(at, "shell-character", "error", message);
  };
}

/** Bytes the shell reads as part of a word where the parser sees a blank. */
function controlBytes(src: Source, flag: (at: number) => void): void {
  if (src.bom) flag(0);
  const text = src.text;
  for (let i = src.begin; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a) continue;
    if (code === 0x0d && text.charAt(i + 1) === "\n") continue;
    if (code < 0x20 || code === 0x7f) flag(i);
  }
}

/**
 * The first line break in the text between two words that ends the command
 * under eval: one outside a comment that no backslash continues, or the one
 * that ends a comment (a backslash in a comment continues nothing).
 */
function commandBreak(gap: string): number {
  let comment = false;
  for (let i = 0; i < gap.length; i++) {
    const c = gap.charAt(i);
    if (c === "#") comment = true;
    else if (c === "\n" && (comment || gap.charAt(i - 1) !== "\\")) return i;
  }
  return -1;
}

function shellIssues(
  src: Source,
  words: readonly Word[],
  flag: (at: number) => void,
): void {
  for (const word of words) {
    for (const char of word.chars) {
      const text = String.fromCharCode(char.byte);
      if (char.context === 0 && SHELL_UNQUOTED.has(text)) flag(char.from);
      else if (char.context === 1 && SHELL_DOUBLE.has(text)) flag(char.from);
      else if (char.context === 0 && char.to - char.from === 2) {
        // An unquoted backslash escape: the writer never emits one.
        flag(char.from);
      }
    }
  }
  // A line break between words (or before the first) ends the command under
  // eval, so the next word would run as a command of its own.
  const text = src.text;
  let from = src.begin;
  for (const word of words) {
    // A backslash line continuation joins the lines and is fine.
    const at = commandBreak(text.slice(from, word.start));
    if (at >= 0) flag(from + at);
    from = word.end;
  }
}

/**
 * The unquoted words of a launch line, for tests: on a line the shell lint
 * accepts they are the arguments the start snippet hands the game.
 */
export function launchWords(bytes: Uint8Array): string[] {
  return readWords(new Source(bytes)).map((word) => decode(word.chars));
}

function parse(bytes: Uint8Array): LaunchDoc {
  const src = new Source(bytes);
  let words: Word[] = [];
  try {
    words = readWords(src);
  } catch (fail) {
    if (!(fail instanceof ParseFail)) throw fail;
    src.issue(fail.offset, "unclosed-quote", "error", fail.message);
  }
  const args = classify(words);
  const seen = new Set<string>();
  for (const arg of args) {
    const key = arg.name.toLowerCase();
    if (seen.has(key)) {
      const message = `${arg.name} is given more than once`;
      const locator: LaunchLocator = { kind: "launch", flag: arg.name };
      const at = arg.word.start;
      src.issue(at, "duplicate-key", "warning", message, locator);
    }
    seen.add(key);
  }
  return { ...src.doc("launch"), source: src, words, args };
}

// Writing -------------------------------------------------------------------

function doubleQuoted(text: string): string {
  return text.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

/** A whole word that the shell reads back as text. */
function encodeWord(text: string): string {
  return text !== "" && SAFE.test(text) ? text : `"${doubleQuoted(text)}"`;
}

/** Raw text that reads back as text at a position with this context. */
function encodeIn(context: Context, text: string): string {
  if (context === 1) return doubleQuoted(text);
  if (context === 2) {
    return text.includes("'") ? `'"${doubleQuoted(text)}"'` : text;
  }
  return SAFE.test(text) ? text : `"${doubleQuoted(text)}"`;
}

/** Replaces the decoded range [start, end) of a word with text. */
function replaceIn(word: Word, start: number, end: number, text: string) {
  const chars = word.chars.slice(start, end);
  const first = chars.at(0);
  const segments = new Set(chars.map((c) => c.segment));
  if (first !== undefined && segments.size === 1) {
    const last = chars.at(-1) ?? first;
    const raw = encodeIn(first.context, text);
    return { start: first.from, end: last.to, text: raw };
  }
  const before = start > 0 ? word.chars.at(start - 1) : undefined;
  if (first === undefined && before !== undefined) {
    const raw = encodeIn(before.context, text);
    return { start: before.to, end: before.to, text: raw };
  }
  const head = decode(word.chars.slice(0, start));
  const tail = decode(word.chars.slice(end));
  const whole = encodeWord(head + text + tail);
  return { start: word.start, end: word.end, text: whole };
}

/** Deletes whole words with the space before them (or after the first). */
function removeWords(doc: LaunchDoc, first: Word, last: Word): Splice {
  const index = doc.words.indexOf(first);
  const previous = index > 0 ? doc.words.at(index - 1) : undefined;
  if (previous) return { start: previous.end, end: last.end, text: "" };
  const next = doc.words.at(doc.words.indexOf(last) + 1);
  return { start: first.start, end: next ? next.start : last.end, text: "" };
}

function removeArg(doc: LaunchDoc, arg: Arg): Splice {
  const { option, word } = arg;
  if (option === undefined) {
    return removeWords(doc, word, arg.extraWord ?? arg.valueWord ?? word);
  }
  return replaceIn(word, option.start, option.end, "");
}

/** set of a keyed argument: the second word holds the value, or is added. */
function setKeyed(launch: LaunchDoc, arg: Arg, value: Value): Splice[] {
  const { word, valueWord, extraWord } = arg;
  if (extraWord === undefined) {
    // The group holds only its key word: true keeps it, false removes it,
    // and a value adds the second word after the key.
    if (value === true) return [];
    if (value === false) {
      return [removeWords(launch, word, valueWord ?? word)];
    }
    if (valueWord === undefined) {
      throw new FormatError("invalid-value", "the key word is missing");
    }
    const text = scalar(value, undefined);
    if (!isValueWord(text)) {
      throw new FormatError("invalid-value", `${text} would read as a flag`);
    }
    const at = valueWord.end;
    return [{ start: at, end: at, text: ` ${encodeWord(text)}` }];
  }
  // The group holds its value word: every write replaces that word, the
  // same way a plain flag with a value is rewritten.
  const text = scalar(value, undefined);
  if (!isValueWord(text)) {
    throw new FormatError("invalid-value", `${text} would read as a flag`);
  }
  return [
    {
      start: extraWord.start,
      end: extraWord.end,
      text: encodeWord(text),
    },
  ];
}

function scalar(value: Value, previous: string | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberText(value, previous);
  if (typeof value === "boolean") return booleanText(value, previous, "lower");
  throw new FormatError("invalid-value", "use text, a number or a boolean");
}

function argValue(arg: Arg): string | true {
  if (arg.valueWord) return decode(arg.valueWord.chars);
  const { inline } = arg;
  if (inline) return decode(arg.word.chars.slice(inline.start, inline.end));
  return true;
}

function setArg(doc: LaunchDoc, arg: Arg, value: Value): Splice[] {
  const previous = argValue(arg);
  if (previous === true) {
    if (value === true) return [];
    if (value === false) return [removeArg(doc, arg)];
    throw new FormatError("invalid-value", `${arg.name} takes no value`);
  }
  const text = scalar(value, previous);
  if (arg.option && text.includes("?")) {
    throw new FormatError("invalid-value", "a ? chain value cannot hold ?");
  }
  const { valueWord, inline, word } = arg;
  if (valueWord) {
    if (!isValueWord(text)) {
      throw new FormatError("invalid-value", `${text} would read as a flag`);
    }
    const splice = { start: valueWord.start, end: valueWord.end };
    return [{ ...splice, text: encodeWord(text) }];
  }
  const range = inline ?? { start: word.text.length, end: word.text.length };
  return [replaceIn(word, range.start, range.end, text)];
}

/**
 * A lone \ at the end of the file is literal, but text written right after
 * it would be escaped by it, so it is rewritten as \\ (the same text) first.
 */
function isLoneBackslash(char: Char): boolean {
  return char.byte === 92 && char.to - char.from === 1 && char.context === 0;
}

function insertArg(
  doc: LaunchDoc,
  flag: string,
  value: Value,
  before?: readonly string[],
): Splice[] {
  if (value === false) return [];
  const text = value === true ? undefined : scalar(value, undefined);
  if (flag.startsWith("?")) {
    const chain = doc.args.find((a) => a.option !== undefined)?.word;
    if (chain === undefined) {
      throw new FormatError("not-found", "there is no ? chain to add to");
    }
    if (text?.includes("?")) {
      throw new FormatError("invalid-value", "a ? chain value cannot hold ?");
    }
    const option = text === undefined ? flag : `${flag}=${text}`;
    // A chain option that must stay in front of named others goes in
    // front of the first of them, not to the chain end: a game may read
    // everything after an option as part of it, as ARK does with
    // ?ServerAdminPassword, so an option added behind it would be lost.
    if (before !== undefined && before.length > 0) {
      const wanted = new Set(before.map((name) => name.toLowerCase()));
      const chainArgs = doc.args.filter(
        (arg) => arg.word === chain && arg.option !== undefined,
      );
      const ahead = chainArgs.find((arg) => wanted.has(arg.name.toLowerCase()));
      const char =
        ahead?.option === undefined
          ? undefined
          : chain.chars[ahead.option.start];
      if (ahead !== undefined && char !== undefined) {
        // Same rule as the chain end below: inside the word the option is
        // written raw when the chain is unquoted, escaped inside quotes.
        if (char.context === 0 && !/^[^\s"'\\]*$/.test(option)) {
          throw new FormatError(
            "invalid-value",
            "the chain is not quoted, so it cannot hold this option text",
          );
        }
        const raw =
          char.context === 0 ? option : encodeIn(char.context, option);
        return [{ start: char.from, end: char.from, text: raw }];
      }
    }
    const last = chain.chars.at(-1);
    if (last !== undefined && isLoneBackslash(last)) {
      const raw = `\\\\${encodeIn(0, option)}`;
      return [{ start: last.from, end: last.to, text: raw }];
    }
    const context = last?.context ?? 0;
    const inside = context !== 0 && last !== undefined;
    const at = inside ? last.to : chain.end;
    // An unquoted chain is one word: the option is appended raw, because a
    // quote would end the word and split the chain. Only text that cannot
    // live inside one word (a space, a quote, a backslash) is refused.
    if (!inside) {
      if (!/^[^\s"'\\]*$/.test(option)) {
        throw new FormatError(
          "invalid-value",
          "the chain is not quoted, so it cannot hold this option text",
        );
      }
      return [{ start: at, end: at, text: option }];
    }
    return [{ start: at, end: at, text: encodeIn(context, option) }];
  }
  const equals = doc.args.some((a) => a.inline !== undefined && !a.option);
  let token = flag;
  if (text !== undefined && flag.startsWith("-") && equals) {
    token = `${flag}=${encodeIn(0, text)}`;
  } else if (text !== undefined) {
    if (!isValueWord(text)) {
      throw new FormatError("invalid-value", `${text} would read as a flag`);
    }
    token = `${flag} ${encodeWord(text)}`;
  }
  return placeToken(doc, token, before);
}

/** insert of a keyed argument: the flag, its key word, and the value word. */
function insertKeyed(
  doc: LaunchDoc,
  locator: LaunchLocator,
  value: Value,
): Splice[] {
  if (value === false) return [];
  const key = encodeWord(locator.key ?? "");
  if (value === true) {
    return placeToken(doc, `${locator.flag} ${key}`, locator.before);
  }
  const text = scalar(value, undefined);
  if (!isValueWord(text)) {
    throw new FormatError("invalid-value", `${text} would read as a flag`);
  }
  return placeToken(
    doc,
    `${locator.flag} ${key} ${encodeWord(text)}`,
    locator.before,
  );
}

/** Places one composed token: in front of a before-flag, else at the end. */
function placeToken(
  doc: LaunchDoc,
  token: string,
  before?: readonly string[],
): Splice[] {
  const last = doc.words.at(-1);
  if (last === undefined) {
    const at = doc.source.begin;
    const text = at < doc.source.length ? `${token} ` : token;
    return [{ start: at, end: at, text }];
  }
  // A flag that must precede named others (LaunchLocator.before) is placed
  // right in front of the first of them instead of the end of the line, so
  // a game that wipes earlier arguments cannot wipe them (Valheim's -preset
  // eats the -modifier and -setkey flags that follow it).
  if (before !== undefined && before.length > 0) {
    const wanted = new Set(before.map((name) => name.toLowerCase()));
    const found = doc.args.find((arg) => wanted.has(arg.name.toLowerCase()));
    if (found !== undefined) {
      const at = found.word.start;
      return [{ start: at, end: at, text: `${token} ` }];
    }
  }
  const tail = last.chars.at(-1);
  if (tail !== undefined && isLoneBackslash(tail)) {
    return [{ start: tail.from, end: tail.to, text: `\\\\ ${token}` }];
  }
  return [{ start: last.end, end: last.end, text: ` ${token}` }];
}

const FLAG = /^[-+?][^\s=?]+$/;
const KEY = /^\S+$/;

/** The key word of a keyed argument, as text. */
function keyOf(arg: Arg): string | undefined {
  return arg.valueWord === undefined ? undefined : decode(arg.valueWord.chars);
}

function find(doc: LaunchDoc, locator: LaunchLocator): Arg[] {
  if (locator.kind !== "launch") throw wrongLocator("launch", locator);
  const { flag, key } = locator;
  if (typeof flag !== "string" || !FLAG.test(flag)) {
    throw new FormatError(
      "invalid-locator",
      "launch: a flag starts with -, + or ? and has a name",
    );
  }
  if (key !== undefined && (typeof key !== "string" || !KEY.test(key))) {
    throw new FormatError(
      "invalid-locator",
      "launch: a key is one word without spaces",
    );
  }
  // Keys compare without case like flags: LinuxGSM documents the Valheim
  // key as deathPenalty while the game's own examples write deathpenalty.
  const name = flag.toLowerCase();
  const keyName = key?.toLowerCase();
  return doc.args.filter(
    (arg) =>
      arg.name.toLowerCase() === name &&
      (keyName === undefined || keyOf(arg)?.toLowerCase() === keyName),
  );
}

/** Launch argument adapter (dash flags, plus convars, ARK ? chains). */
export const launchAdapter: FormatAdapter<LaunchLocator> = {
  id: "launch",
  parse,
  get(doc, locator) {
    const arg = find(own<LaunchDoc>(doc, "launch"), locator).at(-1);
    if (arg === undefined) return undefined;
    if (locator.key !== undefined) {
      return arg.extraWord === undefined ? true : decode(arg.extraWord.chars);
    }
    return argValue(arg);
  },
  set(doc, locator, value) {
    const launch = own<LaunchDoc>(doc, "launch");
    writable(launch);
    const found = find(launch, locator);
    if (found.length > 1) {
      throw new FormatError("ambiguous", `${locator.flag} is given twice`);
    }
    const arg = found.at(0);
    if (arg === undefined) {
      throw new FormatError("not-found", `${locator.flag} is not given`);
    }
    const splices =
      locator.key === undefined
        ? setArg(launch, arg, value)
        : setKeyed(launch, arg, value);
    return verified(launchAdapter, launch, splices);
  },
  insert(doc, locator, value) {
    const launch = own<LaunchDoc>(doc, "launch");
    writable(launch);
    if (find(launch, locator).length > 0) {
      throw new FormatError("exists", `${locator.flag} is already given`);
    }
    const splices =
      locator.key === undefined
        ? insertArg(launch, locator.flag, value, locator.before)
        : insertKeyed(launch, locator, value);
    return verified(launchAdapter, launch, splices);
  },
  remove(doc, locator) {
    const launch = own<LaunchDoc>(doc, "launch");
    writable(launch);
    const found = find(launch, locator);
    if (found.length > 1) {
      throw new FormatError("ambiguous", `${locator.flag} is given twice`);
    }
    const arg = found.at(0);
    if (arg === undefined) return [];
    const splices =
      locator.key === undefined
        ? [removeArg(launch, arg)]
        : [
            removeWords(
              launch,
              arg.word,
              arg.extraWord ?? arg.valueWord ?? arg.word,
            ),
          ];
    return verified(launchAdapter, launch, splices);
  },
  lint: (doc) => sortedIssues(own<LaunchDoc>(doc, "launch")),
  apply: (bytes, splices) => applySplices(bytes, splices),
};

/** Every flag locator of a parsed launch line, for tests and fuzzing. */
export function launchLocators(doc: ParsedDoc): LaunchLocator[] {
  const plain = new Map<string, LaunchLocator>();
  const keyed = new Map<string, LaunchLocator>();
  for (const arg of (doc as LaunchDoc).args) {
    if (!FLAG.test(arg.name)) continue;
    const name = arg.name.toLowerCase();
    const key = keyOf(arg);
    if (arg.extraWord !== undefined && key !== undefined && KEY.test(key)) {
      const by = `${name} ${key}`;
      keyed.set(by, { kind: "launch", flag: arg.name, key });
    } else {
      plain.set(name, { kind: "launch", flag: arg.name });
    }
  }
  return [...plain.values(), ...keyed.values()];
}
