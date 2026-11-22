import { describe, expect, it } from "vitest";
import { bytes, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import {
  ADAPTER_IDS,
  applySplices,
  detectNewline,
  FormatError,
  getAdapter,
  iniAdapter,
  isFormatId,
  type Splice,
} from "./index.js";
import {
  booleanText,
  checkFinite,
  escapeQuoted,
  numberText,
  sameValue,
  unescapeQuoted,
} from "./values.js";

describe("formats package", () => {
  it("knows the locator kinds of contract C2", () => {
    expect(isFormatId("ini")).toBe(true);
    expect(isFormatId("codec")).toBe(true);
    expect(isFormatId("yaml")).toBe(false);
  });

  it("keeps the line ending of a synthetic fixture", () => {
    const sample = text(fixture("sample.ini"));
    expect(sample).toContain("[Server]");
    expect(detectNewline(sample)).toBe("\n");
    expect(detectNewline(sample.replaceAll("\n", "\r\n"))).toBe("\r\n");
    // Mixed endings follow the first line, as Source.newline does.
    expect(detectNewline("a=1\nb=2\r\n")).toBe("\n");
    expect(detectNewline("a=1\r\nb=2\n")).toBe("\r\n");
  });

  it("has an adapter for every adapter id", () => {
    for (const id of ADAPTER_IDS) {
      expect(getAdapter(id)?.id).toBe(id);
    }
    expect(getAdapter("yaml")).toBeUndefined();
  });
});

describe("applySplices", () => {
  const data = bytes("abcdef");
  const apply = (splices: Splice[]) => text(applySplices(data, splices));

  it("applies splices in any order and copies the rest", () => {
    const splices = [
      { start: 4, end: 5, text: "E" },
      { start: 0, end: 1, text: "A" },
      { start: 2, end: 2, text: "+" },
      { start: 2, end: 2, text: "é" },
    ];
    expect(apply(splices)).toBe("Ab+écdEf");
    expect(apply([])).toBe("abcdef");
    expect(apply([{ start: 6, end: 6, text: "!" }])).toBe("abcdef!");
  });

  it("refuses overlapping and out-of-range splices", () => {
    const code = (splices: Splice[]) =>
      errorCode(() => applySplices(data, splices));
    const overlap = [
      { start: 1, end: 3, text: "" },
      { start: 2, end: 4, text: "" },
    ];
    expect(code(overlap)).toBe("invalid-splice");
    expect(code([{ start: 5, end: 9, text: "" }])).toBe("invalid-splice");
    expect(code([{ start: 3, end: 2, text: "" }])).toBe("invalid-splice");
    expect(code([{ start: 1.5, end: 2, text: "" }])).toBe("invalid-splice");
    const notText = [{ start: 1, end: 2, text: 5 }] as unknown as Splice[];
    expect(code(notText)).toBe("invalid-splice");
  });
});

describe("value helpers", () => {
  it("escapes only quotes and the backslashes that need it", () => {
    expect(escapeQuoted('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeQuoted("C:\\Games")).toBe("C:\\Games");
    expect(escapeQuoted("end\\")).toBe("end\\\\");
    expect(unescapeQuoted('say \\"hi\\" C:\\Games \\\\')).toBe(
      'say "hi" C:\\Games \\',
    );
    for (const sample of ['a\\"b', "\\\\", "x\\", 'q"\\', "plain"]) {
      expect(unescapeQuoted(escapeQuoted(sample))).toBe(sample);
    }
  });

  it("keeps the style of booleans and decimals", () => {
    expect(booleanText(true, "FALSE", "lower")).toBe("TRUE");
    expect(booleanText(false, "true", "Title")).toBe("false");
    expect(booleanText(true, "False", "lower")).toBe("True");
    expect(booleanText(true, "0", "Title")).toBe("True");
    expect(booleanText(false, undefined, "lower")).toBe("false");
    expect(numberText(2, "1.500000")).toBe("2.000000");
    expect(numberText(0.1234567, "1.50")).toBe("0.1234567");
    expect(numberText(3, "7")).toBe("3");
    expect(errorCode(() => numberText(Infinity, undefined))).toBe(
      "invalid-value",
    );
  });

  it("compares values deeply and refuses non-finite numbers", () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameValue([1, 2], [1])).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(errorCode(() => checkFinite({ a: [1, Number.NaN] }))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => checkFinite({ a: [1, "x", null] }))).toBe("none");
  });
});

describe("encodings and documents", () => {
  it("refuses UTF-16 and warns about invalid UTF-8", () => {
    const utf16 = iniAdapter.parse(new Uint8Array([255, 254, 65, 0]));
    expect(iniAdapter.lint(utf16).map((i) => i.code)).toContain(
      "unsupported-encoding",
    );
    const latin1 = iniAdapter.parse(new Uint8Array([91, 65, 93, 10, 233, 61]));
    expect(iniAdapter.lint(latin1)).toMatchObject([
      { code: "invalid-utf8", severity: "warning" },
    ]);
  });

  it("names its errors", () => {
    const error = new FormatError("not-found", "missing");
    expect(error.name).toBe("FormatError");
    expect(error.code).toBe("not-found");
    expect(error).toBeInstanceOf(Error);
  });
});
