// The file helpers of the change sets (P4-B): typed values read from a file,
// edits that change only their own bytes, and the lint of a file, on the
// synthetic test pack.
import { FormatError } from "@dialwarden/formats";
import { describe, expect, it } from "vitest";
import { packFixture, testPack, withSetting } from "../test/kit.js";
import {
  lintFile,
  packFileOf,
  readFileValues,
  settingsOfFile,
  writeFileValues,
} from "./files.js";
import type { Pack } from "./types.js";

const pack = testPack();
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

/** The lines of after that differ from the same line of before. */
function changedLines(before: Uint8Array, after: Uint8Array): string[] {
  const old = text(before).split("\n");
  const lines = text(after).split("\n");
  return lines.filter((line, index) => line !== old.at(index));
}

describe("readFileValues", () => {
  it("reads every setting of a file as its typed value", () => {
    const read = readFileValues(pack, "game", packFixture("Game.ini"));
    expect(Object.fromEntries(read.values)).toEqual({
      MaxPlayers: 16,
      Difficulty: 1,
      PvP: false,
      Mode: "Normal",
      ServerName: "Synthetic Test Server",
      AdminPassword: "",
      DayLength: 60,
      "Options.ExpRate": 1,
      "Options.DeathPenalty": "All",
    });
    expect(read.invalid).toEqual([]);
  });

  it("lists a value that does not fit its type as invalid", () => {
    const file = "[ServerSettings]\nMaxPlayers=lots\nMode=Normal\n";
    const read = readFileValues(pack, "game", bytes(file));
    expect(read.invalid).toEqual(["MaxPlayers"]);
    expect(read.values.get("Mode")).toBe("Normal");
    expect(read.values.has("Difficulty")).toBe(false);
  });

  it("lists a setting whose locator the adapter refuses as invalid", () => {
    const broken = withSetting(pack, "MaxPlayers", {
      locator: { kind: "ini", section: "ServerSettings", key: "" },
    });
    const read = readFileValues(broken, "game", packFixture("Game.ini"));
    expect(read.invalid).toEqual(["MaxPlayers"]);
  });

  it("reads a bare launch flag that is left out as off", () => {
    const file = bytes("./run.sh -port=7000\n");
    const read = readFileValues(pack, "launch", file);
    expect(read.values.get("Port")).toBe(7000);
    expect(read.values.get("Log")).toBe(false);
  });
});

describe("writeFileValues", () => {
  it("changes only the bytes of the edited value", () => {
    const fixture = packFixture("Game.ini");
    const edits = [{ key: "MaxPlayers", value: 32 }];
    const written = writeFileValues(pack, "game", fixture, edits);
    expect(changedLines(fixture, written)).toEqual(["MaxPlayers=32"]);
  });

  it("makes several edits in order, a struct field among them", () => {
    const fixture = packFixture("Game.ini");
    const written = writeFileValues(pack, "game", fixture, [
      { key: "Options.ExpRate", value: 2.5 },
      { key: "Mode", value: "Hardcore" },
    ]);
    const read = readFileValues(pack, "game", written);
    expect(read.values.get("Options.ExpRate")).toBe(2.5);
    expect(read.values.get("Mode")).toBe("Hardcore");
    expect(read.values.get("MaxPlayers")).toBe(16);
    expect(changedLines(fixture, written)).toHaveLength(2);
  });

  it("inserts a value the file does not hold yet", () => {
    const file = bytes("[ServerSettings]\nMaxPlayers=16\n");
    const edits = [{ key: "Mode", value: "Hardcore" }];
    const written = writeFileValues(pack, "game", file, edits);
    expect(readFileValues(pack, "game", written).values.get("Mode")).toBe(
      "Hardcore",
    );
  });

  it("removes a value for null", () => {
    const fixture = packFixture("Game.ini");
    const edits = [{ key: "ServerName", value: null }];
    const written = writeFileValues(pack, "game", fixture, edits);
    const read = readFileValues(pack, "game", written);
    expect(read.values.has("ServerName")).toBe(false);
    expect(text(written)).not.toContain("ServerName");
  });

  it("turns a bare launch flag off and on again", () => {
    const fixture = packFixture("launch.txt");
    const off = writeFileValues(pack, "launch", fixture, [
      { key: "Log", value: false },
    ]);
    expect(readFileValues(pack, "launch", off).values.get("Log")).toBe(false);
    const still = writeFileValues(pack, "launch", off, [
      { key: "Log", value: false },
    ]);
    expect(text(still)).toBe(text(off));
    const on = writeFileValues(pack, "launch", off, [
      { key: "Log", value: true },
    ]);
    expect(readFileValues(pack, "launch", on).values.get("Log")).toBe(true);
  });

  it("refuses a key that is not a setting of the file", () => {
    const fixture = packFixture("Game.ini");
    for (const key of ["Nope", "NetRate"]) {
      const write = () =>
        writeFileValues(pack, "game", fixture, [{ key, value: 1 }]);
      expect(write).toThrow(FormatError);
    }
  });

  it("never edits a file that does not parse", () => {
    const file = bytes("[ServerSettings]\nOptionSettings=(ExpRate=1.0\n");
    const write = () =>
      writeFileValues(pack, "game", file, [{ key: "MaxPlayers", value: 8 }]);
    expect(write).toThrow(FormatError);
  });
});

describe("lintFile", () => {
  it("finds nothing in the pack's own fixtures", () => {
    expect(lintFile(pack, "game", packFixture("Game.ini"))).toEqual([]);
    expect(lintFile(pack, "launch", packFixture("launch.txt"))).toEqual([]);
  });

  it("adds the pack's wrong-file warning to the adapter's lint", () => {
    const file = "[ServerSettings]\nMaxPlayers=16\n\n[Net]\nNetRate=60\n";
    const issues = lintFile(pack, "game", bytes(file));
    expect(issues.map((issue) => issue.code)).toEqual(["wrong-file"]);
  });

  it("gives only the syntax errors of a file that does not parse", () => {
    const file = "[Net]\nNetRate=60\nOptionSettings=(ExpRate=1.0\n";
    const issues = lintFile(pack, "game", bytes(file));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });
});

describe("pack files", () => {
  it("finds a file by id and its settings in pack order", () => {
    expect(packFileOf(pack, "engine").adapter).toBe("ueini");
    expect(settingsOfFile(pack, "engine").map((s) => s.key)).toEqual([
      "NetRate",
    ]);
    expect(() => packFileOf(pack, "missing")).toThrow("has no file missing");
  });

  it("refuses a file whose adapter does not exist", () => {
    const files = pack.files.map((file) => {
      const adapter: string = file.id === "engine" ? "nope" : file.adapter;
      return { ...file, adapter };
    });
    const broken = { ...pack, files } as Pack;
    const read = () => readFileValues(broken, "engine", bytes("[Net]\n"));
    expect(read).toThrow("no format adapter nope");
  });
});
