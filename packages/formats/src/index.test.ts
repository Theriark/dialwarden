import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectNewline, isFormatId } from "./index.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture inside the package
  return readFileSync(url, "utf8");
}

describe("formats skeleton", () => {
  it("knows the adapter ids of contract C2", () => {
    expect(isFormatId("ini")).toBe(true);
    expect(isFormatId("yaml")).toBe(false);
  });

  it("keeps the line ending of a synthetic fixture", () => {
    const text = fixture("sample.ini");
    expect(text).toContain("[Server]");
    expect(detectNewline(text)).toBe("\n");
    expect(detectNewline(text.replaceAll("\n", "\r\n"))).toBe("\r\n");
  });
});
