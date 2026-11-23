import { describe, expect, it } from "vitest";
import { splitUnifiedDiff } from "./unified-diff";

const PALWORLD_DIFF = `--- a/PalWorldSettings.ini
+++ b/PalWorldSettings.ini
@@ -1,3 +1,3 @@
 OptionSettings=(Difficulty=None
-DifficultyHard=None
+DifficultyHard=Hard
 OptionSettings=(ServerName="Home")`;

describe("splitUnifiedDiff", () => {
  it("rebuilds both sides of a real unified diff", () => {
    const sides = splitUnifiedDiff(PALWORLD_DIFF);
    expect(sides.hunks).toBe(1);
    expect(sides.before).toContain("DifficultyHard=None");
    expect(sides.after).toContain("DifficultyHard=Hard");
    expect(sides.before).not.toContain("DifficultyHard=Hard");
    expect(sides.after).not.toContain("DifficultyHard=None");
    // Context lines stay on both sides.
    expect(sides.before).toContain('OptionSettings=(ServerName="Home")');
    expect(sides.after).toContain('OptionSettings=(ServerName="Home")');
  });

  it("keeps the file headers out of the sides", () => {
    const sides = splitUnifiedDiff(PALWORLD_DIFF);
    expect(
      sides.before.startsWith("a/") || sides.before.startsWith("---"),
    ).toBe(false);
  });

  it("handles several hunks and added or removed lines", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      " keep",
      "- gone",
      "+ new",
      " tail",
      "@@ -9,1 +10,1 @@",
      "- end",
      "+ end2",
    ].join("\n");
    const sides = splitUnifiedDiff(diff);
    expect(sides.hunks).toBe(2);
    // The first column is the marker; the rest is the line, blanks included.
    expect(sides.before).toBe("keep\n gone\ntail\n end");
    expect(sides.after).toBe("keep\n new\ntail\n end2");
  });

  it("returns empty sides for a diff without hunks", () => {
    const sides = splitUnifiedDiff("");
    expect(sides).toEqual({ before: "", after: "", hunks: 0 });
  });

  it("skips the no-newline marker and stray text", () => {
    const diff = "@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file";
    const sides = splitUnifiedDiff(diff);
    expect(sides.before).toBe("a");
    expect(sides.after).toBe("b");
  });
});
