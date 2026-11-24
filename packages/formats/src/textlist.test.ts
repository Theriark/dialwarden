// The plain-text list adapter (dev-work-plan P6-A: the Valheim admin, ban
// and permit lists). The whole file is one list: get returns the value lines,
// set rewrites them in place, and everything else (comment lines, blank
// lines, the BOM, CRLF, spaces around ids, a missing final break) is kept
// byte for byte. The fixtures are the quirk set of pack-draft-valheim.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { textListAdapter } from "./textlist.js";
import type { ParsedDoc, TextListLocator, Value } from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the fixtures folder of this package */

const FIXTURES = fileURLToPath(
  new URL("../fixtures/textlist/", import.meta.url),
);
const read = (name: string) =>
  new Uint8Array(readFileSync(`${FIXTURES}/${name}`));
// The BOM stays visible as U+FEFF, so a test can see that it is kept.
const text = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const locator: TextListLocator = { kind: "textlist" };
const BOM = String.fromCharCode(0xfeff);

const parse = (name: string): ParsedDoc => textListAdapter.parse(read(name));
const valuesOf = (doc: ParsedDoc) => textListAdapter.get(doc, locator);
const afterSet = (doc: ParsedDoc, value: unknown) => {
  const splices = textListAdapter.set(doc, locator, value as Value);
  return textListAdapter.apply(doc.bytes, splices);
};
const afterInsert = (doc: ParsedDoc, value: unknown) => {
  const splices = textListAdapter.insert(doc, locator, value as Value);
  return textListAdapter.apply(doc.bytes, splices);
};
const afterRemove = (doc: ParsedDoc) => {
  const splices = textListAdapter.remove(doc, locator);
  return textListAdapter.apply(doc.bytes, splices);
};

describe("text list", () => {
  it("reads the value lines and nothing else", () => {
    expect(valuesOf(parse("adminlist-like.txt"))).toEqual([
      "76561198000000001",
      "V_76561198000000002",
      "Steam_76561198000000003",
    ]);
    expect(textListAdapter.lint(parse("adminlist-like.txt"))).toEqual([]);
  });

  it("keeps comments, blank lines, spaces and the missing final break", () => {
    const doc = parse("adminlist-like.txt");
    const next = afterSet(doc, [
      "76561198000000001",
      "V_76561198000000002",
      "Steam_76561198000000003",
      "76561198000000009",
    ]);
    expect(text(next)).toBe(
      "// Server admin list: one id per line.\n" +
        "76561198000000001\n" +
        "\n" +
        "  V_76561198000000002  \n" +
        "// a comment between ids\n" +
        "Steam_76561198000000003\n" +
        "76561198000000009",
    );
  });

  it("shrinks the list without touching the lines around it", () => {
    const doc = parse("adminlist-like.txt");
    const next = afterSet(doc, ["76561198000000001"]);
    // The last value line carries no final break, so the break before it
    // goes with it; every other line is untouched.
    expect(text(next)).toBe(
      "// Server admin list: one id per line.\n" +
        "76561198000000001\n" +
        "\n" +
        "// a comment between ids",
    );
  });

  it("removes every value line and keeps the header", () => {
    const next = afterRemove(parse("adminlist-like.txt"));
    expect(text(next)).toBe(
      "// Server admin list: one id per line.\n\n// a comment between ids",
    );
  });

  it("adds to a list with a BOM and CRLF, in the line style of the file", () => {
    const doc = parse("crlf-bom.txt");
    const next = afterSet(doc, [
      "76561198000000004",
      "76561198000000005",
      "76561198000000006",
    ]);
    expect(text(next)).toBe(
      BOM +
        "// Header line.\r\n76561198000000004\r\n76561198000000005\r\n76561198000000006",
    );
    const reread = textListAdapter.parse(next);
    expect(valuesOf(reread)).toEqual([
      "76561198000000004",
      "76561198000000005",
      "76561198000000006",
    ]);
    expect(reread.bom).toBe(true);
    expect(reread.newline).toBe("\r\n");
  });

  it("inserts like set, because the locator is the whole file", () => {
    const doc = parse("adminlist-like.txt");
    const inserted = afterInsert(doc, ["76561198000000007"]);
    expect(valuesOf(textListAdapter.parse(inserted))).toEqual([
      "76561198000000007",
    ]);
  });

  it("refuses items it could not read back", () => {
    const doc = parse("adminlist-like.txt");
    expect(() => afterSet(doc, ["// looks like a comment"])).toThrowError(
      /comment/,
    );
    expect(() => afterSet(doc, ["one\r\nline"])).toThrowError(/break/);
    expect(() => afterSet(doc, [" padded "])).toThrowError(/spaces/);
    expect(() => afterSet(doc, [""])).toThrowError(/spaces/);
    expect(() => afterSet(doc, [["nested"]])).toThrowError(/text/);
    expect(() => afterSet(doc, "one-id")).toThrowError(/list/);
  });

  it("adds ids to a file that holds only a header", () => {
    const header = new TextEncoder().encode(
      "// Dialwarden synthetic adminlist header.\n",
    );
    const doc = textListAdapter.parse(header);
    const next = afterSet(doc, ["76561198000000008", "V_76561198000000009"]);
    expect(text(next)).toBe(
      "// Dialwarden synthetic adminlist header.\n76561198000000008\nV_76561198000000009\n",
    );
  });

  it("writes the first list into an empty file", () => {
    const doc = textListAdapter.parse(new Uint8Array(0));
    const next = afterSet(doc, ["76561198000000010"]);
    expect(text(next)).toBe("76561198000000010");
  });
});
