import { describe, expect, it } from "vitest";
import { settingOf, testPack, withSetting } from "../test/kit.js";
import { checkPack, referenceProblems, safeRelativePath } from "./check.js";
import type { Pack } from "./types.js";

const pack = testPack();

describe("pack checks beyond the schema", () => {
  it("passes the synthetic test pack", () => {
    expect(checkPack(pack)).toEqual({ pack, problems: [] });
  });

  it("stops at the schema when the schema fails", () => {
    const result = checkPack({ ...pack, id: "Bad Id" });
    expect(result.pack).toBeNull();
    expect(result.problems).toHaveLength(1);
  });

  it("finds duplicate keys, files and presets", () => {
    const twice: Pack = {
      ...pack,
      settings: [...pack.settings, settingOf(pack, "PvP")],
      files: [...pack.files, ...pack.files.slice(0, 1)],
      presets: [...pack.presets, ...pack.presets.slice(0, 1)],
    };
    expect(referenceProblems(twice)).toEqual([
      "setting PvP is listed twice",
      "file game is listed twice",
      "preset casual is listed twice",
    ]);
    expect(checkPack(twice).pack).toBeNull();
  });

  it("refuses a key that also starts another key", () => {
    const options = { ...settingOf(pack, "PvP"), key: "Options" };
    const problems = referenceProblems({
      ...pack,
      settings: [...pack.settings, options],
    });
    expect(problems).toEqual([
      "setting Options is also the start of another key",
    ]);
  });

  it("checks files, locators and reserved names of settings", () => {
    const noFile = withSetting(pack, "PvP", { file: "missing" });
    const json = { kind: "json" as const, pointer: "/port" };
    const broken = withSetting(noFile, "Port", { locator: json });
    const reserved = { ...settingOf(pack, "Mode"), key: "a.__proto__" };
    const settings = [...broken.settings, reserved];
    expect(referenceProblems({ ...broken, settings })).toEqual([
      "setting PvP: file missing is not a file of the pack",
      "setting Port: a json locator does not fit launch",
      "setting a.__proto__: the key uses a reserved name",
    ]);
    const codec = withSetting(pack, "Port", {
      locator: { kind: "codec", setting: "port" },
    });
    expect(referenceProblems(codec)).toEqual([]);
  });

  it("checks choices, ranges and defaults", () => {
    const mode = settingOf(pack, "Mode");
    const again = { value: "Normal", label: "Again" };
    const choices = [...(mode.enum ?? []), again];
    const range = { min: 10, max: 5, default: 3 };
    let changed = withSetting(pack, "Mode", { enum: choices });
    changed = withSetting(changed, "PvP", { enum: choices.slice(0, 1) });
    changed = withSetting(changed, "MaxPlayers", range);
    const problems = referenceProblems(changed);
    expect(problems).toEqual([
      "setting MaxPlayers: min is greater than max",
      "setting MaxPlayers: the default is invalid: Must be at least 10.",
      "setting PvP: only an enum setting lists choices",
      "setting Mode: choice Normal is listed twice",
    ]);
  });

  it("checks item choices of list settings and their defaults", () => {
    const steam = { value: "Steam", label: "Steam" };
    const xbox = { value: "Xbox", label: "Xbox" };
    const list = { type: "list" as const, itemEnum: [steam, xbox] };
    const ok = withSetting(pack, "ServerName", { ...list, default: ["Xbox"] });
    expect(referenceProblems(ok)).toEqual([]);
    let changed = withSetting(pack, "ServerName", {
      ...list,
      itemEnum: [steam, xbox, { value: "Steam", label: "Again" }],
      default: ["Steam", "Switch"],
    });
    changed = withSetting(changed, "PvP", { itemEnum: [steam] });
    expect(referenceProblems(changed)).toEqual([
      "setting PvP: only a list setting lists item choices",
      "setting ServerName: item choice Steam is listed twice",
      "setting ServerName: the default is invalid: Every item must be one of the listed choices.",
    ]);
  });

  it("refuses a preset item outside the item choices", () => {
    const list = withSetting(pack, "ServerName", {
      type: "list",
      itemEnum: [{ value: "Steam", label: "Steam" }],
      default: ["Steam"],
    });
    const presets = [
      { id: "consoles", label: "Consoles", values: { ServerName: ["PS5"] } },
    ];
    expect(referenceProblems({ ...list, presets })).toEqual([
      "preset consoles: ServerName: Every item must be one of the listed choices.",
    ]);
  });

  it("checks builds, operating systems, paths and markers", () => {
    const files = pack.files.map((file) => ({
      ...file,
      paths: { linux: ["../outside.ini"] },
    }));
    const problems = referenceProblems({
      ...pack,
      os: ["windows"],
      builds: { from: 10, to: 5 },
      files: files.slice(0, 1),
      detection: { markers: [{ path: "a//b" }] },
    });
    expect(problems.slice(0, 4)).toEqual([
      "builds.to is before builds.from",
      "file game: linux is not an os of the pack",
      "file game: ../outside.ini leaves the server folder",
      "detection: a//b leaves the server folder",
    ]);
  });

  it("checks rules and presets against the settings", () => {
    const problems = referenceProblems({
      ...pack,
      rules: [
        {
          id: "bad",
          severity: "error",
          message: "Uses an operator outside the list.",
          settings: ["PvP"],
          when: { method: [{ var: "PvP" }, "valueOf"] },
        },
      ],
      presets: [
        {
          id: "odd",
          label: "Odd",
          values: { Ghost: 1, MaxPlayers: 500 },
        },
      ],
    });
    expect(problems).toEqual([
      "rule bad: operator method is not allowed",
      "preset odd: Ghost is not a setting",
      "preset odd: MaxPlayers: Must be at most 64.",
    ]);
  });

  it("knows which relative paths stay inside the server folder", () => {
    expect(safeRelativePath("Pal/Saved/Config/Game.ini")).toBe(true);
    expect(safeRelativePath("/etc/passwd")).toBe(false);
    expect(safeRelativePath("a\\b.ini")).toBe(false);
    expect(safeRelativePath("a/../../b.ini")).toBe(false);
    expect(safeRelativePath("a/")).toBe(false);
  });
});

describe("pack checks: probes and launch sources (P6)", () => {
  it("checks the settings and allow-list of a probe declaration", () => {
    const withProbe: Pack = {
      ...pack,
      probes: [
        {
          kind: "sourceRcon",
          portSetting: "Nope",
          passwordSetting: "PvP",
          allow: ["sav"],
          saveCommand: "sav",
          stopCommand: "shutdown",
        },
      ],
    };
    expect(referenceProblems(withProbe)).toEqual([
      "probe sourceRcon: portSetting Nope is not a setting of the pack",
      "probe sourceRcon: stopCommand is not on the allow-list",
    ]);
  });

  it("refuses probe commands without an allow-list", () => {
    const bare: Pack = {
      ...pack,
      probes: [{ kind: "rustWebRcon", saveCommand: "server.write" }],
    };
    expect(referenceProblems(bare)).toEqual([
      "probe rustWebRcon: saveCommand is not on the allow-list",
    ]);
  });

  it("checks the paths of a launch source", () => {
    const escaped: Pack = {
      ...pack,
      files: [
        ...pack.files,
        {
          id: "launchline",
          paths: { linux: ["dialwarden-args.txt"] },
          adapter: "launch",
          encoding: "utf-8",
          applyPolicy: "stopped-only",
          launchSources: [
            { kind: "args" },
            {
              kind: "env",
              paths: { linux: ["../outside.env"] },
              argsVar: "SERVER_ARGS",
            },
          ],
        },
      ],
    };
    expect(referenceProblems(escaped)).toEqual([
      "file launchline: env path ../outside.env escapes",
    ]);
  });

  it("refuses the args source twice", () => {
    const twice: Pack = {
      ...pack,
      files: [
        ...pack.files,
        {
          id: "launchline",
          paths: { linux: ["dialwarden-args.txt"] },
          adapter: "launch",
          encoding: "utf-8",
          applyPolicy: "stopped-only",
          launchSources: [{ kind: "args" }, { kind: "args" }],
        },
      ],
    };
    expect(referenceProblems(twice)).toEqual([
      "file launchline: the args source is listed twice",
    ]);
  });
});
