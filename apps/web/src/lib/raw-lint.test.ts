import { describe, expect, it } from "vitest";
import type { Pack } from "@dialwarden/packs-schema";
import { draftLint, lintMarkers } from "./raw-lint";

const PACK = {
  id: "test",
  version: "1",
  displayName: "Test",
  steamAppId: 0,
  builds: { from: 1 },
  os: ["linux"],
  detection: { markers: [] },
  files: [
    {
      id: "game",
      paths: { linux: ["Game.ini"] },
      adapter: "ueini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
  ],
  settings: [],
  rules: [],
  presets: [],
  probes: [],
  hooksSupported: [],
  sources: [],
} as unknown as Pack;

const BROKEN =
  "[ServerSettings]\nMaxPlayers=16\nthis line has no key value pair\n";

describe("draftLint", () => {
  it("reports the malformed line with its line number", () => {
    const issues = draftLint(PACK, "game", BROKEN);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(issues.some((issue) => issue.line === 3)).toBe(true);
  });

  it("finds no error in a well-formed file", () => {
    const issues = draftLint(PACK, "game", "[ServerSettings]\nMaxPlayers=16\n");
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("stays empty for a file the pack does not describe", () => {
    expect(draftLint(PACK, "nope", "x=1\n")).toEqual([]);
  });
});

describe("lintMarkers", () => {
  it("spans the named line so the squiggle shows", () => {
    const markers = lintMarkers(BROKEN, draftLint(PACK, "game", BROKEN));
    expect(markers.length).toBeGreaterThan(0);
    const first = markers[0];
    if (first === undefined) throw new Error("no marker");
    expect(first.line).toBe(3);
    expect(first.endLine).toBe(3);
    expect(first.column).toBe(1);
    expect(first.endColumn).toBe(32);
    expect(first.severity).toBe("error");
  });
});
