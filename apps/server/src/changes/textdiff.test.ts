// Line diffs of the change sets: the unified diff, the changed line count and
// the three-way merge that keeps every outside edit (rnd-report-1 2.7).
import { describe, expect, it } from "vitest";
import {
  changedLineCount,
  diffLines,
  MAX_EDIT_DISTANCE,
  merge3,
  splitLines,
  unifiedDiff,
} from "./textdiff.js";

const lines = (...items: string[]) => items.map((i) => `${i}\n`).join("");

describe("splitLines", () => {
  it("keeps every line break, so joining gives the text back", () => {
    for (const text of ["", "a", "a\n", "a\r\nb", "\n\n", "a\nb\n"]) {
      expect(splitLines(text).join("")).toBe(text);
    }
    expect(splitLines("a\r\nb")).toEqual(["a\r\n", "b"]);
  });
});

describe("diffLines", () => {
  it("finds the changed blocks between equal lines", () => {
    const a = splitLines(lines("a", "b", "c", "d", "e"));
    const b = splitLines(lines("a", "B", "c", "d", "e", "f"));
    expect(diffLines(a, b)).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 5, aEnd: 5, bStart: 5, bEnd: 6 },
    ]);
  });

  it("finds nothing in equal texts", () => {
    const a = splitLines(lines("a", "b"));
    expect(diffLines(a, [...a])).toEqual([]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("aligns moved and repeated lines on the shortest script", () => {
    const a = splitLines(lines("x", "a", "b", "x", "c"));
    const b = splitLines(lines("a", "b", "x", "c", "x"));
    const hunks = diffLines(a, b);
    const removed = hunks.reduce((n, h) => n + h.aEnd - h.aStart, 0);
    const added = hunks.reduce((n, h) => n + h.bEnd - h.bStart, 0);
    expect(removed + added).toBe(2);
  });

  it("treats a middle past the edit bound as one block", () => {
    const count = MAX_EDIT_DISTANCE;
    const a = Array.from({ length: count }, (_, i) => `a${i}\n`);
    const b = Array.from({ length: count }, (_, i) => `b${i}\n`);
    const head = ["same\n"];
    const before = [...head, ...a, ...head];
    const after = [...head, ...b, ...head];
    const hunks = diffLines(before, after);
    expect(hunks).toEqual([
      { aStart: 1, aEnd: count + 1, bStart: 1, bEnd: count + 1 },
    ]);
  });
});

describe("unifiedDiff", () => {
  it("writes the diff -u layout with three lines of context", () => {
    const before = lines("1", "2", "3", "4", "5", "6", "7", "8", "9");
    const after = lines("1", "2", "3", "4", "five", "6", "7", "8", "9");
    expect(unifiedDiff("settings", before, after)).toBe(
      [
        "--- a/settings",
        "+++ b/settings",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
  });

  it("joins nearby changes and splits distant ones", () => {
    const before = lines(...Array.from({ length: 20 }, (_, i) => `${i}`));
    const after = before.replace("2\n", "two\n").replace("5\n", "five\n");
    const near = unifiedDiff("f", before, after);
    expect(near.match(/^@@/gm)).toHaveLength(1);
    const far = before.replace("2\n", "two\n").replace("17\n", "x\n");
    expect(unifiedDiff("f", before, far).match(/^@@/gm)).toHaveLength(2);
  });

  it("marks a last line without a line break", () => {
    const expected = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-x",
      "\\ No newline at end of file",
      "+y",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(unifiedDiff("f", "x", "y")).toBe(expected);
  });

  it("starts an empty file at line 0 and is empty for equal texts", () => {
    expect(unifiedDiff("f", "", "a\n")).toBe(
      "--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+a\n",
    );
    expect(unifiedDiff("f", "same\n", "same\n")).toBe("");
  });
});

describe("changedLineCount", () => {
  it("counts the larger side of every changed block", () => {
    expect(changedLineCount(lines("a", "b"), lines("a", "B", "C"))).toBe(2);
    expect(changedLineCount("", lines("a", "b", "c"))).toBe(3);
    expect(changedLineCount("same", "same")).toBe(0);
  });
});

describe("merge3", () => {
  const base = lines("1", "2", "3", "4", "5", "6");

  it("takes changes on lines apart from both sides", () => {
    const ours = base.replace("2\n", "two\n");
    const theirs = base.replace("5\n", "five\n");
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: lines("1", "two", "3", "4", "five", "6"),
    });
  });

  it("takes a change only one side made", () => {
    const ours = base.replace("3\n", "three\n");
    expect(merge3(base, ours, base)).toEqual({ ok: true, text: ours });
    expect(merge3(base, base, ours)).toEqual({ ok: true, text: ours });
  });

  it("takes the same change once", () => {
    const both = base.replace("4\n", "four\n");
    expect(merge3(base, both, both)).toEqual({ ok: true, text: both });
  });

  it("merges inserts at both ends", () => {
    const ours = `0\n${base}`;
    const theirs = `${base}7\n`;
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: `0\n${base}7\n`,
    });
  });

  it("refuses changes on the same line and on touching lines", () => {
    const ours = base.replace("3\n", "three\n");
    expect(merge3(base, ours, base.replace("3\n", "THREE\n"))).toEqual({
      ok: false,
      conflicts: 1,
    });
    expect(merge3(base, ours, base.replace("4\n", "four\n"))).toEqual({
      ok: false,
      conflicts: 1,
    });
  });

  it("counts every conflicting block", () => {
    const ours = base.replace("1\n", "a\n").replace("6\n", "b\n");
    const theirs = base.replace("1\n", "c\n").replace("6\n", "d\n");
    expect(merge3(base, ours, theirs)).toEqual({ ok: false, conflicts: 2 });
  });
});
