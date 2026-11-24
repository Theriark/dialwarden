import { describe, expect, it } from "vitest";
import { minimalEdit } from "./editor-sync";

function apply(before: string, after: string): string {
  const edit = minimalEdit(before, after);
  if (edit === null) {
    return before;
  }
  return before.slice(0, edit.start) + edit.text + before.slice(edit.end);
}

describe("minimalEdit", () => {
  it("is no edit for the same text", () => {
    expect(minimalEdit("a=1\n", "a=1\n")).toBeNull();
    expect(minimalEdit("", "")).toBeNull();
  });

  it("appends at the end without touching the start", () => {
    expect(minimalEdit("a=1\n", "a=1\nb=2\n")).toEqual({
      start: 4,
      end: 4,
      text: "b=2\n",
    });
  });

  it("replaces only the part that differs in the middle", () => {
    expect(minimalEdit("a=1\nb=2\nc=3\n", "a=1\nb=22\nc=3\n")).toEqual({
      start: 7,
      end: 7,
      text: "2",
    });
    expect(minimalEdit("a=1\nb=2\nc=3\n", "a=1\nc=3\n")).toEqual({
      start: 4,
      end: 8,
      text: "",
    });
  });

  it("replaces everything when nothing is shared", () => {
    expect(minimalEdit("abc", "xyz")).toEqual({
      start: 0,
      end: 3,
      text: "xyz",
    });
    expect(minimalEdit("abc", "")).toEqual({ start: 0, end: 3, text: "" });
    expect(minimalEdit("", "abc")).toEqual({ start: 0, end: 0, text: "abc" });
  });

  it("turns before into after for line ending and whitespace changes", () => {
    const cases: [string, string][] = [
      ["a=1\r\nb=2\r\n", "a=1\nb=2\n"],
      ["a=1\n", "a=1"],
      ["a = 1\n", "a=1\n"],
      ["aaaa", "aa"],
      ["aa", "aaaa"],
    ];
    for (const [before, after] of cases) {
      expect(apply(before, after)).toBe(after);
    }
  });

  it("never splits a surrogate pair", () => {
    const smile = "\u{1F600}";
    const grin = "\u{1F601}";
    const edit = minimalEdit(`a=${smile}`, `a=${grin}`);
    expect(edit).toEqual({ start: 2, end: 4, text: grin });
    expect(apply(`a=${smile}`, `a=${grin}`)).toBe(`a=${grin}`);
    // Pairs that share their low half still move as one character.
    expect(apply("😀", "🨀")).toBe("🨀");
    expect(minimalEdit("😀", "🨀")).toEqual({
      start: 0,
      end: 2,
      text: "🨀",
    });
  });
});
