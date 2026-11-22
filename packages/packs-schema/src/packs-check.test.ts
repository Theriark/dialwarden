// pnpm packs:check on the synthetic test pack (test/packs/testpack), so the
// check runs before the first real packs arrive in P3-B, and on broken copies
// of it, one problem at a time.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_PACK_DIR,
  TEST_PACKS,
  testPack,
  withSetting,
  writeTestPack,
} from "../test/kit.js";
import { checkPacksFolder, fixtureName } from "./node.js";
import type { Pack, Setting } from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const folders: string[] = [];

afterEach(() => {
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The packs:check problems of the test pack changed as given. */
function problemsOf(
  data: unknown,
  fixtures: Record<string, string | null> = {},
): readonly string[] {
  const root = mkdtempSync(join(tmpdir(), "dialwarden-packs-check-"));
  folders.push(root);
  writeTestPack(root, "testpack", data, fixtures);
  const [report] = checkPacksFolder(root);
  return report?.problems ?? ["no report"];
}

describe("pnpm packs:check", () => {
  it("passes the synthetic test pack", () => {
    expect(checkPacksFolder(TEST_PACKS)).toEqual([
      { folder: "testpack", problems: [] },
    ]);
  });

  it("fails a pack whose rule uses an operator outside the list", () => {
    const pack = testPack();
    const rule = {
      id: "calls-a-method",
      severity: "error",
      message: "Calls a method on a value.",
      settings: ["ServerName"],
      when: { method: [{ var: "ServerName" }, "toUpperCase"] },
    };
    expect(problemsOf({ ...pack, rules: [rule] })).toEqual([
      "rule calls-a-method: operator method is not allowed",
    ]);
  });

  it("fails a rule that reads a secret without serverEvaluated", () => {
    const pack = testPack();
    const rule = {
      id: "password-in-name",
      severity: "warning",
      message: "The admin password is part of the server name.",
      settings: ["AdminPassword", "ServerName"],
      when: { in: [{ var: "AdminPassword" }, { var: "ServerName" }] },
    };
    expect(problemsOf({ ...pack, rules: [rule] })).toEqual([
      "rule password-in-name: reads the secret AdminPassword beyond an emptiness or presence test, so it must be marked serverEvaluated",
    ]);
    const marked = { ...rule, serverEvaluated: true };
    expect(problemsOf({ ...pack, rules: [marked] })).toEqual([]);
    const empty = { ...rule, when: { "==": [{ var: "AdminPassword" }, ""] } };
    expect(problemsOf({ ...pack, rules: [empty] })).toEqual([]);
  });

  describe("a list setting with item choices", () => {
    // A Platforms list in the struct line of the Game.ini fixture.
    const GAME_INI = readFileSync(join(TEST_PACK_DIR, "fixtures", "Game.ini"))
      .toString("utf8")
      .replace("DeathPenalty=All)", "DeathPenalty=All,Platforms=(Steam,Xbox))");
    const platforms: Setting = {
      key: "Options.Platforms",
      label: "Platforms",
      file: "game",
      locator: { kind: "struct", key: "OptionSettings", field: "Platforms" },
      type: "list",
      default: ["Steam", "Xbox"],
      itemEnum: [
        { value: "Steam", label: "Steam" },
        { value: "Xbox", label: "Xbox" },
        { value: "PS5", label: "PlayStation 5" },
      ],
      description: "Client platforms that may join the synthetic server.",
    };

    function withPlatforms(
      change: Partial<Setting>,
      presets?: Pack["presets"],
    ) {
      const pack = testPack();
      const settings = [...pack.settings, { ...platforms, ...change }];
      return { ...pack, settings, presets: presets ?? pack.presets };
    }

    it("passes when the default and the presets use listed items", () => {
      const presets = [
        {
          id: "consoles",
          label: "Consoles",
          values: { "Options.Platforms": ["PS5"] },
        },
      ];
      const fixtures = { "Game.ini": GAME_INI };
      expect(problemsOf(withPlatforms({}, presets), fixtures)).toEqual([]);
    });

    it("fails a default item outside the item choices", () => {
      const steamOnly = { itemEnum: [{ value: "Steam", label: "Steam" }] };
      const fixtures = { "Game.ini": GAME_INI };
      expect(problemsOf(withPlatforms(steamOnly), fixtures)).toEqual([
        "setting Options.Platforms: the default is invalid: Every item must be one of the listed choices.",
      ]);
    });

    it("fails a preset item outside the item choices", () => {
      const presets = [
        {
          id: "handheld",
          label: "Handheld",
          values: { "Options.Platforms": ["Switch"] },
        },
      ];
      const fixtures = { "Game.ini": GAME_INI };
      expect(problemsOf(withPlatforms({}, presets), fixtures)).toEqual([
        "preset handheld: Options.Platforms: Every item must be one of the listed choices.",
      ]);
    });
  });

  it("fails a locator that does not resolve on its fixture", () => {
    const missing = withSetting(testPack(), "MaxPlayers", {
      locator: { kind: "ini", section: "ServerSettings", key: "MaxPlayerz" },
    });
    expect(problemsOf(missing)).toEqual([
      "setting MaxPlayers: the locator does not resolve on Game.ini",
    ]);
    const invalid = withSetting(testPack(), "Options.ExpRate", {
      locator: { kind: "struct", key: "OptionSettings", field: "a..b" },
    });
    const [problem] = problemsOf(invalid);
    expect(problem).toMatch(
      /^setting Options.ExpRate: the locator fails on Game.ini: /,
    );
  });

  it("fails a default that differs from the fixture", () => {
    const changed = withSetting(testPack(), "MaxPlayers", { default: 20 });
    expect(problemsOf(changed)).toEqual([
      "setting MaxPlayers: the default differs from Game.ini",
    ]);
  });

  it("fails missing, broken and unlisted fixtures", () => {
    const pack = testPack();
    expect(problemsOf(pack, { "Engine.ini": null })).toEqual([
      "file engine: fixtures/Engine.ini is missing",
    ]);
    expect(problemsOf(pack, { "SYNTHETIC.md": null })).toEqual([
      "fixtures/SYNTHETIC.md is missing",
    ]);
    const unlisted = { "SYNTHETIC.md": "Lists no file at all." };
    expect(problemsOf(pack, unlisted)).toEqual([
      "fixtures/Engine.ini is not listed in SYNTHETIC.md",
      "fixtures/Game.ini is not listed in SYNTHETIC.md",
      "fixtures/launch.txt is not listed in SYNTHETIC.md",
      "fixtures/testserver.cfg is not listed in SYNTHETIC.md",
    ]);
    const broken = { "Engine.ini": "[Net\nNetRate=30\n" };
    expect(problemsOf(pack, broken).at(0)).toMatch(/^fixtures\/Engine.ini:1:/);
  });

  it("fails schema problems: descriptions, sources and duplicate keys", () => {
    const short = withSetting(testPack(), "PvP", { description: "Too short." });
    expect(problemsOf(short).join("\n")).toContain("fewer than 20 characters");
    expect(problemsOf({ ...testPack(), sources: [] }).join("\n")).toContain(
      "/sources: must NOT have fewer than 1 items",
    );
    const pack = testPack();
    const twice: Pack = {
      ...pack,
      settings: [...pack.settings, ...pack.settings.slice(0, 1)],
    };
    expect(problemsOf(twice)).toEqual(["setting MaxPlayers is listed twice"]);
  });

  it("fails a folder without pack.json or without fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "dialwarden-packs-check-"));
    folders.push(root);
    mkdirSync(join(root, "empty"));
    const dir = join(root, "nofixtures");
    mkdirSync(dir);
    const pack = { ...testPack(), id: "nofixtures" };
    writeFileSync(join(dir, "pack.json"), JSON.stringify(pack));
    expect(checkPacksFolder(root)).toEqual([
      { folder: "empty", problems: ["pack.json is missing"] },
      { folder: "nofixtures", problems: ["the fixtures folder is missing"] },
    ]);
  });

  it("names the fixture of a file after its first path", () => {
    const files = testPack().files;
    expect(files.map((file) => fixtureName(file))).toEqual([
      "Game.ini",
      "Engine.ini",
      "launch.txt",
      "testserver.cfg",
    ]);
    const file = files.at(0);
    if (file === undefined) throw new Error("no file");
    const windows = { ...file, paths: { windows: ["W.ini"] } };
    expect(fixtureName(windows)).toBe("W.ini");
    expect(fixtureName({ ...file, paths: {} })).toBe("game");
  });
});
