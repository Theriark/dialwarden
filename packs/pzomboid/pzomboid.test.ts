// The Project Zomboid pack (dev-work-plan P7 step 4): the Build 42 server
// ini with the keys the remote console reloads live, the nested SandboxVars
// table, and the rules of the pack draft. The save action of the pack maps
// to the remote console command reloadoptions, the live-reload action of
// the plan.
import { lintFile, validate, writeFileValues } from "@dialwarden/packs-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureOf, fixtureValues, loadPack, settingOf } from "../kit.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the fixtures folder of this pack */

const pack = loadPack("pzomboid");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const serverIni = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/servertest.ini`));
const sandboxLua = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/servertest_SandboxVars.lua`));

/** The ini keys the console reloads without a restart. */
const LIVE = [
  "MaxPlayers",
  "Password",
  "PVP",
  "SafetySystem",
  "GlobalChat",
  "PauseEmpty",
  "NoFire",
  "Faction",
  "SaveWorldEveryMinutes",
  "BackupsCount",
  "BackupsPeriod",
];

/** Keys that need a restart: ports and the mod lists. */
const RESTART = [
  "DefaultPort",
  "UDPPort",
  "RCONPort",
  "Mods",
  "WorkshopItems",
  "Map",
  "Seed",
  "ResetID",
];

/** Build 41 keys a Build 42 file may still carry; kept, never created. */
const B41 = [
  "AutoCreateUserInWhiteList",
  "AntiCheatProtectionType1",
  "SandboxVars.XpMultiplier",
  "SandboxVars.FoodLoot",
  "SandboxVars.LootRespawn",
];

describe("Project Zomboid pack", () => {
  it("declares its files, probes and the reloadoptions hook", () => {
    expect(
      pack.files.map((file) => [file.id, file.adapter, file.applyPolicy]),
    ).toEqual([
      ["serverini", "ini", "anytime"],
      ["sandbox", "lua", "stopped-only"],
      ["launch", "launch", "stopped-only"],
    ]);
    // The live-reload action of the plan: the save hook runs reloadoptions,
    // so liveReloadable ini keys apply without a restart.
    expect(pack.probes).toEqual([
      {
        kind: "sourceRcon",
        portSetting: "RCONPort",
        passwordSetting: "RCONPassword",
        host: "127.0.0.1",
        allow: ["reloadoptions", "quit"],
        saveCommand: "reloadoptions",
        stopCommand: "quit",
      },
    ]);
    expect(pack.hooksSupported).toEqual(["save", "stop"]);
  });

  it("marks the reloadable ini keys live and the rest restarts", () => {
    const byKey = new Map(pack.settings.map((s) => [s.key, s]));
    for (const key of LIVE) {
      expect(byKey.get(key)?.liveReloadable, key).toBe(true);
      expect(byKey.get(key)?.restartRequired, key).toBeUndefined();
    }
    for (const key of RESTART) {
      expect(byKey.get(key)?.restartRequired, key).toBe(true);
      expect(byKey.get(key)?.liveReloadable, key).toBeUndefined();
    }
  });

  it("reads the flat ini with its empty passwords and mod lists", () => {
    const { adapter, doc } = fixtureOf(pack, "serverini");
    expect(doc.newline).toBe("\n");
    expect(
      adapter.get(doc, { kind: "ini", section: null, key: "RCONPassword" }),
    ).toBe("");
    expect(adapter.get(doc, { kind: "ini", section: null, key: "Mods" })).toBe(
      "",
    );
    expect(adapter.get(doc, { kind: "ini", section: null, key: "Map" })).toBe(
      "Muldraugh, KY",
    );
    // A semicolon list value is part of the value, not a comment.
    expect(
      adapter.get(doc, {
        kind: "ini",
        section: null,
        key: "ChatStreams",
      }),
    ).toBe("s,r,a,w,y,sh,f,all");
  });

  it("writes a mod list without breaking the file", () => {
    const { adapter, bytes } = fixtureOf(pack, "serverini");
    const written = writeFileValues(pack, "serverini", bytes, [
      { key: "Mods", value: "Some Mod;Other Mod" },
    ]);
    const reread = adapter.parse(written);
    expect(
      adapter.get(reread, { kind: "ini", section: null, key: "Mods" }),
    ).toBe("Some Mod;Other Mod");
    // The rest of the line survives; the semicolon is kept as written.
    expect(text(written)).toContain("Mods=Some Mod;Other Mod");
  });

  it("reads the nested SandboxVars table with repeated names", () => {
    const { adapter, doc } = fixtureOf(pack, "sandbox");
    // The same field name at two depths: lore strength and skill strength.
    expect(
      adapter.get(doc, {
        kind: "lua",
        path: ["SandboxVars", "ZombieLore", "Strength"],
      }),
    ).toBe(2);
    expect(
      adapter.get(doc, {
        kind: "lua",
        path: ["SandboxVars", "MultiplierConfig", "Strength"],
      }),
    ).toBe(1);
    expect(
      adapter.get(doc, {
        kind: "lua",
        path: ["SandboxVars", "Basement", "SpawnFrequency"],
      }),
    ).toBe(4);
    expect(
      adapter.get(doc, {
        kind: "lua",
        path: ["SandboxVars", "ZombieConfig", "PopulationMultiplier"],
      }),
    ).toBe(0.65);
    // VERSION is preserved and not offered for editing.
    expect(
      adapter.get(doc, { kind: "lua", path: ["SandboxVars", "VERSION"] }),
    ).toBe(6);
    const luaPaths: string[] = [];
    for (const { locator } of pack.settings) {
      if (locator.kind === "lua") luaPaths.push(locator.path.join("."));
    }
    expect(luaPaths).not.toContain("SandboxVars.VERSION");
  });

  it("edits a deep table entry and keeps the mod table untouched", () => {
    const { adapter, bytes } = fixtureOf(pack, "sandbox");
    const written = writeFileValues(pack, "sandbox", bytes, [
      { key: "SandboxVars.ZombieLore.Speed", value: 2 },
    ]);
    const reread = adapter.parse(written);
    expect(
      adapter.get(reread, {
        kind: "lua",
        path: ["SandboxVars", "ZombieLore", "Speed"],
      }),
    ).toBe(2);
    // The mod table sits inside SandboxVars, after the Build 41 keys.
    expect(
      adapter.get(reread, {
        kind: "lua",
        path: ["SandboxVars", "SomeModOptions", "TweakLevel"],
      }),
    ).toBe(2);
    expect(text(written)).toContain("TweakLevel = 2");
  });

  it("flags the empty console password and the colliding ports", () => {
    const issues = validate(pack, fixtureValues(pack));
    // The stock ini ships the console password empty, so the hooks rule
    // fires on the demo server until a password is set.
    expect(issues).toContainEqual({
      key: "RCONPassword",
      severity: "error",
      message: expect.stringContaining("stays off"),
    });
    const clash = fixtureValues(pack);
    clash.set("UDPPort", 16261);
    expect(validate(pack, clash)).toContainEqual({
      key: "UDPPort",
      severity: "error",
      message: expect.stringContaining("must all differ"),
    });
  });

  it("notes the Build 41 keys the Build 42 file still carries", () => {
    const issues = validate(pack, fixtureValues(pack));
    for (const key of B41) {
      expect(issues).toContainEqual({
        key,
        severity: "info",
        message: expect.stringContaining("Build 41 key in a Build 42 file"),
      });
      expect(settingOf(pack, key).removedIn).toBe("42");
    }
    // The ini issues on the fixture are exactly the password error and
    // the two ini keys of the Build 41 set.
    expect(
      issues.filter((issue) => !issue.key.startsWith("SandboxVars.")),
    ).toHaveLength(3);
  });

  it("checks the sleep, sprinter and public-without-password rules", () => {
    const sleepy = fixtureValues(pack);
    sleepy.set("SleepNeeded", true);
    expect(validate(pack, sleepy)).toContainEqual({
      key: "SleepNeeded",
      severity: "warning",
      message: expect.stringContaining("beds are not allowed"),
    });
    // A sprinter share counts only with random movement, the fixture's
    // setting; with fast shamblers the share is ignored and said so.
    const sprinters = fixtureValues(pack);
    sprinters.set("SandboxVars.ZombieLore.SprinterPercentage", 10);
    expect(
      validate(pack, sprinters).some(
        (issue) => issue.key === "SandboxVars.ZombieLore.SprinterPercentage",
      ),
    ).toBe(false);
    sprinters.set("SandboxVars.ZombieLore.Speed", 2);
    expect(validate(pack, sprinters)).toContainEqual({
      key: "SandboxVars.ZombieLore.SprinterPercentage",
      severity: "info",
      message: expect.stringContaining("only applies when"),
    });
    const open = fixtureValues(pack);
    open.set("Public", true);
    expect(validate(pack, open)).toContainEqual({
      key: "Public",
      severity: "info",
      message: expect.stringContaining("listed publicly"),
    });
  });

  it("flags Workshop items without activated mods", () => {
    const values = fixtureValues(pack);
    values.set("WorkshopItems", "514427485;513111049");
    expect(validate(pack, values)).toContainEqual({
      key: "WorkshopItems",
      severity: "warning",
      message: expect.stringContaining("no mod ID is activated"),
    });
    const local = fixtureValues(pack);
    local.set("Mods", "Some Mod");
    expect(validate(pack, local)).toContainEqual({
      key: "Mods",
      severity: "info",
      message: expect.stringContaining("no Workshop items listed"),
    });
  });

  it("shows no error lint in its fixtures", () => {
    expect(
      lintFile(pack, "serverini", serverIni()).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    expect(
      lintFile(pack, "sandbox", sandboxLua()).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
  });
});
