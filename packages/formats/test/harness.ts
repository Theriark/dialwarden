// Shared checks for the property tests and the fuzzing of every adapter.
// checkDocument states the contract of one adapter on one file: parse and
// lint never throw, a broken file is never written, and every write changes
// only its splices, leaves a file the adapter reads without error and reads
// back the value that was written.

import * as fc from "fast-check";
import {
  FormatError,
  type FormatAdapter,
  type FormatErrorCode,
  type Locator,
  type ParsedDoc,
  type Splice,
  type Value,
} from "../src/index.js";

export interface Kit {
  readonly name: string;
  readonly adapter: FormatAdapter;
  /** Locators that exist in the document. */
  readonly locators: (doc: ParsedDoc) => Locator[];
  /** Locators that are probably new, for insert. */
  readonly fresh: (doc: ParsedDoc) => Locator[];
  readonly values: fc.Arbitrary<Value>;
  /** True when got is what reading back value should give. */
  readonly matches: (value: Value, got: unknown, before: unknown) => boolean;
  /** True when a removed locator must read undefined afterwards. */
  readonly cleared: (locator: Locator) => boolean;
  readonly seeds: readonly Uint8Array[];
  readonly alphabet: readonly string[];
}

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** UTF-8 text of bytes; a BOM stays as U+FEFF so tests can see it. */
export function text(data: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
}

/** Parses input, applies the splices change returns and gives the text. */
export function edited(
  adapter: FormatAdapter,
  input: string | Uint8Array,
  change: (doc: ParsedDoc) => Splice[],
): string {
  const data = typeof input === "string" ? bytes(input) : input;
  return text(adapter.apply(data, change(adapter.parse(data))));
}

/** The code of the FormatError fn throws, or "none". */
export function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FormatError) return error.code;
    throw error;
  }
  return "none";
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? text(value) : value;
}

function fail(kit: Kit, message: string, detail: unknown): never {
  const shown = JSON.stringify(detail, replacer);
  throw new Error(`${kit.name}: ${message}: ${shown}`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b.at(i));
}

/** Text values as INI, XML, cfg, shell and launch adapters read them back. */
export function textMatches(value: Value, got: unknown): boolean {
  if (typeof value === "string") return got === value;
  if (typeof got !== "string") return false;
  if (typeof value === "number") return Number(got) === value;
  const word = got.toLowerCase();
  if (typeof value === "boolean") {
    const truthy = word === "true" || word === "1";
    const falsy = word === "false" || word === "0";
    return value ? truthy : falsy;
  }
  return false;
}

/** Bytes outside the splices must be the original bytes, in order. */
export function changedOnlySplices(
  original: Uint8Array,
  out: Uint8Array,
  splices: readonly Splice[],
): boolean {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  let from = 0;
  let at = 0;
  for (const splice of sorted) {
    const kept = original.subarray(from, splice.start);
    if (!sameBytes(kept, out.subarray(at, at + kept.length))) return false;
    at += kept.length + encoder.encode(splice.text).length;
    from = splice.end;
  }
  const rest = original.subarray(from);
  return at + rest.length === out.length && sameBytes(rest, out.subarray(at));
}

/** Runs an edit; a FormatError with an allowed code gives undefined. */
function attempt(
  kit: Kit,
  fn: () => Splice[],
  allowed: readonly FormatErrorCode[],
): Splice[] | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FormatError && allowed.includes(error.code)) {
      return undefined;
    }
    return fail(kit, "unexpected error", String(error));
  }
}

function written(kit: Kit, doc: ParsedDoc, splices: Splice[]): ParsedDoc {
  const out = kit.adapter.apply(doc.bytes, splices);
  if (!changedOnlySplices(doc.bytes, out, splices)) {
    fail(kit, "bytes outside the splices changed", { doc: doc.bytes, splices });
  }
  const after = kit.adapter.parse(out);
  if (after.issues.some((issue) => issue.severity === "error")) {
    fail(kit, "a write left an error", { out, issues: after.issues });
  }
  return after;
}

function refusesBrokenFile(kit: Kit, doc: ParsedDoc, value: Value): void {
  const { adapter } = kit;
  const sample = [...kit.locators(doc).slice(0, 3), ...kit.fresh(doc)];
  for (const locator of sample) {
    const codes = [
      errorCode(() => adapter.set(doc, locator, value)),
      errorCode(() => adapter.insert(doc, locator, value)),
      errorCode(() => adapter.remove(doc, locator)),
    ];
    if (codes.some((code) => code !== "parse-error")) {
      fail(kit, "a broken file was not refused", { locator, codes });
    }
  }
}

const SET_ERRORS: readonly FormatErrorCode[] = ["invalid-value", "ambiguous"];
const REMOVE_ERRORS: readonly FormatErrorCode[] = [
  "invalid-value",
  "ambiguous",
  "invalid-locator",
];
const INSERT_ERRORS: readonly FormatErrorCode[] = [
  "exists",
  "not-found",
  "invalid-value",
  "ambiguous",
  "invalid-locator",
];

function checkLocator(
  kit: Kit,
  doc: ParsedDoc,
  locator: Locator,
  value: Value,
) {
  const { adapter } = kit;
  const before = adapter.get(doc, locator);
  const set = attempt(kit, () => adapter.set(doc, locator, value), SET_ERRORS);
  if (set) {
    const got = adapter.get(written(kit, doc, set), locator);
    if (!kit.matches(value, got, before)) {
      const detail = { doc: doc.bytes, locator, value, got };
      fail(kit, "set did not read back", detail);
    }
  }
  const removeIt = () => adapter.remove(doc, locator);
  const removed = attempt(kit, removeIt, REMOVE_ERRORS);
  if (removed) {
    const got = adapter.get(written(kit, doc, removed), locator);
    if (kit.cleared(locator) && got !== undefined) {
      fail(kit, "remove left the value", { doc: doc.bytes, locator, got });
    }
  }
}

/** The contract of one adapter on one file, for one value to write. */
export function checkDocument(
  kit: Kit,
  data: Uint8Array,
  value: Value,
  pick: number,
): void {
  const { adapter } = kit;
  const doc = adapter.parse(data);
  const issues = adapter.lint(doc);
  if (issues.some((issue) => !(issue.line >= 1 && issue.column >= 1))) {
    fail(kit, "an issue has no position", issues);
  }
  if (!sameBytes(adapter.apply(data, []), data)) {
    fail(kit, "apply without splices changed the file", data);
  }
  if (issues.some((issue) => issue.severity === "error")) {
    refusesBrokenFile(kit, doc, value);
    return;
  }
  const locators = kit.locators(doc);
  const start = locators.length > 0 ? pick % locators.length : 0;
  const order = [...locators.slice(start), ...locators.slice(0, start)];
  for (const locator of order.slice(0, 6)) {
    checkLocator(kit, doc, locator, value);
  }
  for (const locator of kit.fresh(doc)) {
    const insert = () => adapter.insert(doc, locator, value);
    const splices = attempt(kit, insert, INSERT_ERRORS);
    if (splices === undefined) continue;
    const got = adapter.get(written(kit, doc, splices), locator);
    if (!kit.matches(value, got, undefined)) {
      fail(kit, "insert did not read back", { data, locator, value, got });
    }
  }
}

// Inputs --------------------------------------------------------------------

/** Characters that make text values hard to quote. */
export const TRICKY = [
  "a",
  "Z",
  "0",
  "9",
  " ",
  "\t",
  "=",
  ";",
  "#",
  '"',
  "'",
  "\\",
  "(",
  ")",
  ",",
  "?",
  "$",
  "`",
  "-",
  "+",
  "/",
  ".",
  "&",
  "<",
  ">",
  "[",
  "]",
  "{",
  "}",
  "é",
  "€",
  "😀",
];

export function textValue(maxLength = 12): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...TRICKY), maxLength });
}

const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

/** Text, numbers and booleans. */
export const scalarValue: fc.Arbitrary<Value> = fc.oneof(
  textValue(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  finite,
  fc.boolean(),
);

const key = fc.string({
  unit: fc.constantFrom("a", "b", "x", "Y", "_", "1"),
  minLength: 1,
  maxLength: 5,
});

const nil = fc.constant(null);
const jsonScalar: fc.Arbitrary<Value> = fc.oneof(scalarValue, nil);

/** JSON values without __proto__-like keys. */
export const jsonValue: fc.Arbitrary<Value> = fc.oneof(
  jsonScalar,
  fc.array(jsonScalar, { maxLength: 3 }),
  fc.dictionary(key, jsonScalar, { maxKeys: 3 }),
);

/** Lua values: scalars and nil. */
export const luaValue: fc.Arbitrary<Value> = jsonScalar;

type Edit = [number, number, string];

function mutate(seed: Uint8Array, edits: readonly Edit[]): Uint8Array {
  let data = seed;
  for (const [at, cut, insert] of edits) {
    const position = at % (data.length + 1);
    const end = Math.min(data.length, position + cut);
    const added = encoder.encode(insert);
    const next = new Uint8Array(position + added.length + data.length - end);
    next.set(data.subarray(0, position), 0);
    next.set(added, position);
    next.set(data.subarray(end), position + added.length);
    data = next;
  }
  return data;
}

/** Random files: mutated fixtures, random text of the format, random bytes. */
export function documents(kit: Kit): fc.Arbitrary<Uint8Array> {
  const unit = fc.constantFrom(...kit.alphabet);
  const edit = fc.tuple(
    fc.nat(),
    fc.nat({ max: 6 }),
    fc.string({ unit, maxLength: 4 }),
  );
  const seed = fc.constantFrom(...kit.seeds);
  const pairs = fc.tuple(seed, fc.array(edit, { maxLength: 4 }));
  const mutated = pairs.map(([data, edits]) => mutate(data, edits));
  const random = fc.string({ unit, maxLength: 160 }).map(bytes);
  return fc.oneof(
    { arbitrary: mutated, weight: 5 },
    { arbitrary: random, weight: 4 },
    { arbitrary: fc.uint8Array({ maxLength: 80 }), weight: 1 },
  );
}

// Fuzzing -------------------------------------------------------------------

function fuzzSeconds(): number {
  const fallback = process.env.CI === "true" ? 30 : 3;
  const value = Number(process.env.FORMATS_FUZZ_SECONDS ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Test timeout for one fuzz run, with room to shrink a failure. */
export function fuzzTimeout(): number {
  return (fuzzSeconds() + 120) * 1000;
}

export interface FuzzResult {
  readonly adapter: string;
  readonly iterations: number;
  readonly seconds: number;
  readonly seed: number;
}

/**
 * Runs checkDocument on random files for FORMATS_FUZZ_SECONDS (30 in CI)
 * with FORMATS_FUZZ_SEED (random when unset; printed for a replay).
 */
export function fuzz(kit: Kit): FuzzResult {
  const seconds = fuzzSeconds();
  const fixed = Number(process.env.FORMATS_FUZZ_SEED);
  const seed = Number.isInteger(fixed) ? fixed : Date.now() % 2_147_483_647;
  let iterations = 0;
  const property = fc.property(
    documents(kit),
    kit.values,
    fc.nat(),
    (data, value, pick) => {
      iterations++;
      checkDocument(kit, data, value, pick);
    },
  );
  fc.assert(property, {
    seed,
    numRuns: Number.MAX_SAFE_INTEGER,
    interruptAfterTimeLimit: seconds * 1000,
    markInterruptAsFailure: false,
  });
  const result = { adapter: kit.adapter.id, iterations, seconds, seed };
  console.log(`fuzz ${JSON.stringify(result)}`);
  return result;
}
