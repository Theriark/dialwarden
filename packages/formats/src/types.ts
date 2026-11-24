// Interface contract C2 (dev-work-plan-2): the shapes every format adapter
// shares. Field names are exact; a change needs an R&D Lead task first.

/** A value read from or written to a configuration file. */
export type Value =
  | string
  | number
  | boolean
  | null
  | readonly Value[]
  | { readonly [key: string]: Value };

/**
 * One replacement in the original bytes: the bytes from start (inclusive) to
 * end (exclusive) are replaced by text, encoded as UTF-8. Offsets are byte
 * offsets in the original file; start equal to end is an insertion.
 */
export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  readonly code: string;
  readonly severity: Severity;
  /** 1-based line. */
  readonly line: number;
  /** 1-based column in characters (a UTF-8 BOM is not counted). */
  readonly column: number;
  readonly message: string;
  readonly locator?: Locator;
}

/** A key in an INI section; section null is a key before the first section. */
export interface IniLocator {
  readonly kind: "ini";
  readonly section: string | null;
  /** UE INI: +Key or -Key selects only that array operation. */
  readonly key: string;
  /** 0-based occurrence when the key appears more than once. */
  readonly index?: number;
}

/**
 * A field of an Unreal struct value such as Palworld's one-line
 * OptionSettings=(...). key is the INI key; field is the field name, with dots
 * for a field of a nested struct (Outer.Inner).
 */
export interface StructLocator {
  readonly kind: "struct";
  readonly key: string;
  readonly field: string;
}

/** An RFC 6901 JSON pointer, for example /gameSettings/playerHealthFactor. */
export interface JsonLocator {
  readonly kind: "json";
  readonly pointer: string;
}

/** The value attribute of <property name="..." value="..."/>. */
export interface XmlLocator {
  readonly kind: "xml";
  readonly property: string;
}

/**
 * A field in a Lua table constructor. Strings are field names, numbers are
 * 1-based positions. The first element is the global name of an assignment
 * chunk; in a return { ... } chunk the path starts inside the table.
 */
export interface LuaLocator {
  readonly kind: "lua";
  readonly path: readonly (string | number)[];
}

/** A console command or convar such as hostname or server.hostname. */
export interface CfgLocator {
  readonly kind: "cfg";
  readonly command: string;
}

/** A variable of a shell variable file (LinuxGSM cfg, .env, EnvironmentFile). */
export interface ShellVarLocator {
  readonly kind: "shellvar";
  readonly name: string;
}

/**
 * A launch argument, named with its sigil: -port (dash flag), +maxplayers
 * (plus convar) or ?SessionName (an option of an ARK question-mark chain).
 */
export interface LaunchLocator {
  readonly kind: "launch";
  readonly flag: string;
  /**
   * The key word of a repeated flag family (P6: Valheim writes
   * -modifier combat veryhard and -setkey nomap, where the word after the
   * flag names the key and the value follows it). Without a key the flag is
   * matched by name alone.
   */
  readonly key?: string;
  /**
   * Flags this one must stay in front of when it is added (P6: a game may
   * wipe earlier arguments, as Valheim's -preset does to the -modifier and
   * -setkey flags that follow it). Without the field the argument goes to
   * the end of the line, the usual order.
   */
  readonly before?: readonly string[];
}

/**
 * A plain-text list file (P6: the Valheim admin, ban and permit lists): the
 * values are the non-comment lines of the whole file, one list entry each;
 * lines starting with // are comments and blank lines are kept as they are.
 */
export interface TextListLocator {
  readonly kind: "textlist";
}

/** A setting whose value is encoded (decoded by a ValueCodec, from P7). */
export interface CodecLocator {
  readonly kind: "codec";
  readonly setting: string;
}

export type Locator =
  | IniLocator
  | StructLocator
  | JsonLocator
  | XmlLocator
  | LuaLocator
  | CfgLocator
  | ShellVarLocator
  | LaunchLocator
  | TextListLocator
  | CodecLocator;

/** What parse returns. Each adapter keeps its own parse tree behind it. */
export interface ParsedDoc {
  /** The adapter that parsed the document. */
  readonly adapter: string;
  /** The original bytes; never modified. */
  readonly bytes: Uint8Array;
  /** Line ending of the file (the first one found; LF when there is none). */
  readonly newline: "\n" | "\r\n";
  /** True when the file starts with a UTF-8 byte order mark. */
  readonly bom: boolean;
  /** Syntax and structure issues found while parsing. */
  readonly issues: readonly LintIssue[];
}

/**
 * One adapter per format. parse never throws: a syntax error becomes a
 * LintIssue with severity error, and set, insert and remove then refuse with
 * FormatError code parse-error, so a broken file never produces a write.
 * get throws only for a wrong locator or document, or an ambiguous one.
 */
export interface FormatAdapter<L extends Locator = Locator> {
  readonly id: string;
  parse(bytes: Uint8Array): ParsedDoc;
  /** The value, or undefined when the locator does not exist. */
  get(doc: ParsedDoc, locator: L): Value | undefined;
  /** Replaces an existing value. */
  set(doc: ParsedDoc, locator: L, value: Value): Splice[];
  /** Adds a value that does not exist yet. */
  insert(doc: ParsedDoc, locator: L, value: Value): Splice[];
  /** Removes a value with its key; no splices when it does not exist. */
  remove(doc: ParsedDoc, locator: L): Splice[];
  lint(doc: ParsedDoc): LintIssue[];
  /** New bytes; only the spliced ranges change. */
  apply(bytes: Uint8Array, splices: readonly Splice[]): Uint8Array;
}

/**
 * Encoded-value codec hook (interface only in 27.0.0; 7 Days to Die uses it
 * in P7). A codec turns the raw text an adapter reads into a Value and back.
 */
export interface ValueCodec {
  readonly id: string;
  decode(raw: string, locator: CodecLocator): Value;
  encode(value: Value, locator: CodecLocator): string;
}

export type FormatErrorCode =
  | "parse-error"
  | "not-found"
  | "exists"
  | "ambiguous"
  | "invalid-value"
  | "invalid-locator"
  | "invalid-splice"
  | "wrong-document";

/** Thrown by set, insert, remove and apply when an edit cannot be made. */
export class FormatError extends Error {
  readonly code: FormatErrorCode;

  constructor(code: FormatErrorCode, message: string) {
    super(message);
    this.name = "FormatError";
    this.code = code;
  }
}
