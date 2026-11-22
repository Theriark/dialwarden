import { describe, expect, it } from "vitest";
import { packFixture, testPack } from "../test/kit.js";
import { lintPackFile } from "./lint.js";

const pack = testPack();
const bytes = (text: string) => new TextEncoder().encode(text);

describe("wrong-file and wrong-section lint", () => {
  it("finds nothing in the pack's own fixtures", () => {
    expect(lintPackFile(pack, "game", packFixture("Game.ini"))).toEqual([]);
    expect(lintPackFile(pack, "engine", packFixture("Engine.ini"))).toEqual([]);
    expect(lintPackFile(pack, "launch", packFixture("launch.txt"))).toEqual([]);
  });

  it("finds a key of another file of the game", () => {
    const text = "[ServerSettings]\nMaxPlayers=16\n\n[Net]\nNetRate=60\n";
    expect(lintPackFile(pack, "game", bytes(text))).toEqual([
      {
        code: "wrong-file",
        severity: "warning",
        line: 5,
        column: 1,
        message: "NetRate belongs in Engine.ini; it has no effect in this file.",
        locator: { kind: "ini", section: "Net", key: "NetRate" },
      },
    ]);
    const engine = "[ServerSettings]\r\nMaxPlayers=16\r\n";
    const [found] = lintPackFile(pack, "engine", bytes(engine));
    expect(found?.code).toBe("wrong-file");
    expect(found?.message).toContain("belongs in Game.ini");
    expect(found?.line).toBe(2);
  });

  it("finds a key in the wrong section of its own file", () => {
    const text = "\u{FEFF}[Net]\nMode=Hardcore\nMaxPlayers=8\n";
    const issues = lintPackFile(pack, "game", bytes(text));
    expect(issues.map((issue) => [issue.code, issue.line])).toEqual([
      ["wrong-section", 2],
      ["wrong-section", 3],
    ]);
    expect(issues.at(0)?.message).toBe(
      "Mode belongs in section [ServerSettings], not [Net].",
    );
    const top = lintPackFile(pack, "game", bytes("PvP=True\n"));
    expect(top.at(0)?.message).toBe(
      "PvP belongs in section [ServerSettings], not before the first section.",
    );
  });

  it("refuses a file the pack does not have", () => {
    expect(() => lintPackFile(pack, "nope", bytes(""))).toThrow(
      "pack testpack has no file nope",
    );
  });
});
