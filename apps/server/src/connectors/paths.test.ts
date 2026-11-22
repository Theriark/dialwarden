// The text check of connector paths (contract C4): what is refused before a
// connector asks the file system anything.
import { describe, expect, it } from "vitest";
import {
  asideName,
  insideRoot,
  joinUnder,
  relativeParts,
  tempName,
} from "./paths.js";
import { ConnectorError, LIMITS } from "./types.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.code : "other";
  }
}

describe("relativeParts", () => {
  it.each([
    "../secret",
    "a/../../secret",
    "a/b/../../..",
    "..",
    "/etc/passwd",
    "//server/share",
    "C:/Windows/win.ini",
    "c:secret",
    "a\\..\\..\\secret",
    "a\x00b",
    "a\nb",
    "x".repeat(LIMITS.maxPathLength + 1),
  ])("refuses %j with PathEscape", (rel) => {
    expect(codeOf(() => relativeParts(rel))).toBe("PathEscape");
  });

  it("refuses a .. part even when it would stay inside the root", () => {
    expect(codeOf(() => relativeParts("a/../b"))).toBe("PathEscape");
  });

  it.each([
    ["", []],
    [".", []],
    ["./", []],
    ["Pal/Saved/Config", ["Pal", "Saved", "Config"]],
    ["a//b/./c/", ["a", "b", "c"]],
    ["..hidden/.x", ["..hidden", ".x"]],
  ])("splits %j", (rel, parts) => {
    expect(relativeParts(rel)).toEqual(parts);
  });
});

describe("insideRoot and joinUnder", () => {
  it("keeps a path under the root and refuses a sibling with the same prefix", () => {
    expect(insideRoot("/srv/game", "/srv/game")).toBe(true);
    expect(insideRoot("/srv/game", "/srv/game/a/b")).toBe(true);
    expect(insideRoot("/srv/game", "/srv/game2/a")).toBe(false);
    expect(insideRoot("/srv/game", "/srv")).toBe(false);
    expect(insideRoot("/", "/anything")).toBe(true);
  });

  it("joins a checked path under the root", () => {
    expect(joinUnder("/srv/game", "a/b.ini")).toBe("/srv/game/a/b.ini");
    expect(joinUnder("/srv/game", "")).toBe("/srv/game");
    expect(codeOf(() => joinUnder("/srv/game", "../x"))).toBe("PathEscape");
  });

  it("names temp and aside files next to the target, hidden", () => {
    expect(tempName("/srv/game/a.ini", "t1")).toBe(
      "/srv/game/.a.ini.dialwarden-t1.tmp",
    );
    expect(asideName("/srv/game/a.ini", "t1")).toBe(
      "/srv/game/.a.ini.dialwarden-t1.old",
    );
  });
});
