import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_PACKS, testPack, writeTestPack } from "../test/kit.js";
import { loadPacks, MAX_PACK_BYTES, type PackLogger } from "./node.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const folders: string[] = [];

afterEach(() => {
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dialwarden-packs-"));
  folders.push(dir);
  return dir;
}

interface LogLine {
  level: string;
  data: object;
  message: string;
}

function logger(): PackLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (data: object, message: string) => {
    lines.push({ level, data, message });
  };
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

describe("pack loader (server start)", () => {
  it("loads the packs with their id and version, frozen", () => {
    const log = logger();
    const { packs, refused } = loadPacks(TEST_PACKS, log);
    expect([...packs.keys()]).toEqual(["testpack"]);
    expect(packs.get("testpack")?.version).toBe("1.0.0");
    expect(Object.isFrozen(packs.get("testpack")?.settings.at(0))).toBe(true);
    expect(refused).toEqual([]);
    expect(log.lines).toEqual([
      {
        level: "info",
        data: { packs: ["testpack@1.0.0"], refused: 0 },
        message: "game packs loaded",
      },
    ]);
  });

  it("refuses a broken pack with one log line and keeps the others", () => {
    const root = tempRoot();
    writeTestPack(root, "testpack", testPack());
    writeTestPack(root, "no-sources", {
      ...testPack(),
      id: "no-sources",
      sources: [],
    });
    writeTestPack(root, "renamed", testPack());
    mkdirSync(join(root, "broken-json"));
    writeFileSync(join(root, "broken-json", "pack.json"), "{ not json");
    mkdirSync(join(root, "huge"));
    const huge = " ".repeat(MAX_PACK_BYTES + 1);
    writeFileSync(join(root, "huge", "pack.json"), huge);
    mkdirSync(join(root, "unreadable", "pack.json"), { recursive: true });
    mkdirSync(join(root, "no-pack-file"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "README.md"), "Not a pack folder.");

    const log = logger();
    const { packs, refused } = loadPacks(root, log);
    expect([...packs.keys()]).toEqual(["testpack"]);
    const first = new Map(refused.map((r) => [r.folder, r.problems.at(0)]));
    expect([...first.keys()]).toEqual([
      "broken-json",
      "huge",
      "no-sources",
      "renamed",
      "unreadable",
    ]);
    expect(first.get("broken-json")).toMatch(/^pack.json is not valid JSON/);
    expect(first.get("huge")).toBe("pack.json is larger than 2 MiB");
    expect(first.get("no-sources")).toBe(
      "/sources: must NOT have fewer than 1 items",
    );
    expect(first.get("renamed")).toBe(
      "the folder renamed must be named like the pack id",
    );
    expect(first.get("unreadable")).toMatch(/^pack.json cannot be read/);

    const errors = log.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(5);
    expect(errors.at(0)).toEqual({
      level: "error",
      data: { pack: "broken-json", problems: [first.get("broken-json")] },
      message: "game pack refused",
    });
    expect(log.lines.at(-1)?.data).toEqual({
      packs: ["testpack@1.0.0"],
      refused: 5,
    });
  });

  it("warns and loads nothing when the packs folder is missing", () => {
    const log = logger();
    const missing = join(tempRoot(), "nope");
    expect(loadPacks(missing, log).packs.size).toBe(0);
    expect(log.lines.at(0)?.message).toBe(
      "game packs folder not found; no packs loaded",
    );
    expect(loadPacks(missing).refused).toEqual([]);
  });
});
