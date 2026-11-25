// The ARK: Survival Ascended pack (dev-work-plan P7 step 2): the two Unreal
// INI files, the travel chain with the admin password that must stay last,
// the dash form of the game port, and the misplaced-key lint of the pack
// draft (Game.ini keys found in GameUserSettings.ini and the other way
// round). Every file is stopped-only: the server rewrites
// GameUserSettings.ini at shutdown.
import { getAdapter } from "@dialwarden/formats";
import { lintFile, validate, writeFileValues } from "@dialwarden/packs-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fixtureOf,
  fixtureValues,
  loadPack,
  ruleOf,
  settingOf,
} from "../kit.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the fixtures folder of this pack */

const pack = loadPack("ark-sa");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (line: string) => new TextEncoder().encode(line);

const gusBytes = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/GameUserSettings.ini`));
const gameBytes = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/Game.ini`));
const argsBytes = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/dialwarden-args.txt`));

describe("ARK: Survival Ascended pack", () => {
  it("declares both INI files stopped-only and the launch file anytime", () => {
    expect(pack.files.map((file) => [file.id, file.adapter, file.applyPolicy]))
      .toEqual([
        ["gus", "ueini", "stopped-only"],
        ["game", "ueini", "stopped-only"],
        ["launch", "launch", "anytime"],
      ]);
    expect(pack.probes).toEqual([
      {
        kind: "sourceRcon",
        portSetting: "RCONPort",
        passwordSetting: "ServerAdminPassword",
        host: "127.0.0.1",
        allow: ["SaveWorld", "ServerChat", "Broadcast", "DoExit"],
        saveCommand: "SaveWorld",
        stopCommand: "DoExit",
      },
    ]);
    // The server answers no Steam query, so the pack ships no a2s probe.
    expect(pack.hooksSupported).toEqual(["save", "stop"]);
  });

  it("reads the Unreal style: byte order mark, CRLF, True and False", () => {
    const { adapter, doc, bytes } = fixtureOf(pack, "gus");
    expect(bytes[0]).toBe(0xef);
    expect(doc.bom).toBe(true);
    expect(doc.newline).toBe("\r\n");
    expect(
      adapter.get(doc, {
        kind: "ini",
        section: "ServerSettings",
        key: "RCONEnabled",
      }),
    ).toBe("False");
    expect(
      adapter.get(doc, {
        kind: "ini",
        section: "ServerSettings",
        key: "XPMultiplier",
      }),
    ).toBe("1.000000");
  });

  it("writes a float in the six-decimal style of the file", () => {
    const { adapter, bytes } = fixtureOf(pack, "gus");
    const written = writeFileValues(pack, "gus", bytes, [
      { key: "XPMultiplier", value: 2 },
    ]);
    const reread = adapter.parse(written);
    expect(
      adapter.get(reread, {
        kind: "ini",
        section: "ServerSettings",
        key: "XPMultiplier",
      }),
    ).toBe("2.000000");
  });

  it("lints the Game.ini keys found in GameUserSettings.ini", () => {
    const issues = lintFile(pack, "gus", gusBytes());
    const misplaced = issues.filter((issue) => issue.code === "wrong-file");
    expect(misplaced.map((issue) => issue.message.split(" ")[0])).toEqual([
      "BabyMatureSpeedMultiplier",
      "MatingIntervalMultiplier",
      "bAllowUnlimitedRespecs",
      "bAutoUnlockAllEngrams",
      "PerLevelStatsMultiplier_Player.0",
      "bUseSingleplayerSettings",
    ]);
    for (const issue of misplaced) {
      expect(issue.severity).toBe("warning");
      expect(issue.message).toContain("belongs in Game.ini");
    }
    // The wrong-section copies: the session name and the slot limit sit in
    // [ServerSettings] where the game does not read them.
    const sections = issues.filter((issue) => issue.code === "wrong-section");
    expect(sections.map((issue) => issue.message.split(" ")[0])).toEqual([
      "SessionName",
      "ini.MaxPlayers",
    ]);
    // The second [ServerSettings] block is kept and reported once.
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "duplicate-section" }),
    );
  });

  it("lints the GameUserSettings keys found in Game.ini", () => {
    const issues = lintFile(pack, "game", gameBytes());
    const misplaced = issues.filter((issue) => issue.code === "wrong-file");
    expect(misplaced.map((issue) => issue.message.split(" ")[0])).toEqual([
      "XPMultiplier",
      "TamingSpeedMultiplier",
      "serverPVE",
      "DifficultyOffset",
      "MaxTamedDinos",
    ]);
    for (const issue of misplaced) {
      expect(issue.message).toContain("belongs in GameUserSettings.ini");
    }
    // The array-operation line and the repeated unknown key are kept.
    const kept = text(gameBytes());
    expect(kept).toContain("+ConfigOverrideItemMaxQuantity=");
    expect(kept).toContain("SomeModKey=7");
  });

  it("warns when the admin password is not the last chain option", () => {
    const issues = lintFile(pack, "launch", argsBytes());
    // The fixture holds the trap: the password sits in the middle, and
    // everything after it is read as part of it.
    expect(issues).toEqual([
      {
        code: "launch-order",
        severity: "warning",
        line: 1,
        column: 99,
        message: expect.stringContaining(
          "?RCONEnabled comes after ?ServerAdminPassword",
        ),
        locator: settingOf(pack, "cli.RCONEnabled").locator,
      },
    ]);
  });

  it("places a new chain option in front of the admin password", () => {
    const line = bytesOf(
      '"TheIsland_WP?listen?ServerAdminPassword=late-demo" -Port=7777',
    );
    const launch = getAdapter("launch");
    if (launch === undefined) throw new Error("no launch adapter");
    const written = writeFileValues(pack, "launch", line, [
      { key: "cli.RCONEnabled", value: true },
    ]);
    expect(text(written)).toContain(
      '"TheIsland_WP?listen?RCONEnabled?ServerAdminPassword=late-demo"',
    );
  });

  it("keeps the whole chain quoted when the session name has a space", () => {
    const { adapter, doc } = fixtureOf(pack, "launch");
    expect(
      adapter.get(doc, { kind: "launch", flag: "?SessionName" }),
    ).toBe("Dialwarden demo");
    expect(
      adapter.get(doc, { kind: "launch", flag: "?ServerAdminPassword" }),
    ).toBe("mid-chain-demo");
    // Both port forms are on the fixture line; the rule flags the
    // question-mark one.
    expect(adapter.get(doc, { kind: "launch", flag: "-Port" })).toBe("7777");
    expect(adapter.get(doc, { kind: "launch", flag: "?Port" })).toBe("7778");
  });

  it("flags the question-mark port form on the fixture line", () => {
    const issues = validate(pack, fixtureValues(pack));
    expect(issues).toEqual([
      {
        key: "cli.Port",
        severity: "warning",
        message: expect.stringContaining("write it as -Port="),
      },
    ]);
  });

  it("checks the remote console and chain secrets on the server only", () => {
    const rcon = ruleOf(pack, "rcon-no-password");
    expect(rcon.serverEvaluated).toBe(true);
    const values = fixtureValues(pack);
    values.set("RCONEnabled", true);
    values.set("ServerAdminPassword", "");
    expect(validate(pack, values)).toContainEqual({
      key: "ServerAdminPassword",
      severity: "error",
      message: expect.stringContaining("no admin password"),
    });
    expect(
      validate(pack, values, { includeServerEvaluated: false }),
    ).toEqual([
      {
        key: "cli.Port",
        severity: "warning",
        message: expect.stringContaining("write it as -Port="),
      },
    ]);
    const unsafe = fixtureValues(pack);
    unsafe.set("cli.SessionName", "Bad?Name");
    expect(validate(pack, unsafe)).toContainEqual({
      key: "cli.SessionName",
      severity: "error",
      message: expect.stringContaining("question mark"),
    });
  });

  it("flags PvE servers that still set PvP options", () => {
    const values = fixtureValues(pack);
    values.set("serverPVE", true);
    values.set("PreventOfflinePvP", true);
    expect(validate(pack, values)).toContainEqual({
      key: "PreventOfflinePvP",
      severity: "warning",
      message: expect.stringContaining("only matter on PvP servers"),
    });
  });

  it("notes a slot limit that lives only in the INI", () => {
    const values = fixtureValues(pack);
    // The fixture keeps its INI slot limit in the wrong section, where the
    // pack does not read it, so the value the rule needs is set here.
    values.set("ini.MaxPlayers", 70);
    values.delete("MaxPlayers");
    expect(validate(pack, values)).toContainEqual({
      key: "ini.MaxPlayers",
      severity: "info",
      message: expect.stringContaining("add the launch flag"),
    });
  });

  it("flags the default cluster id and a difficulty conflict", () => {
    const values = fixtureValues(pack);
    values.set("clusterid", "default");
    expect(validate(pack, values)).toContainEqual({
      key: "clusterid",
      severity: "info",
      message: expect.stringContaining("unrelated servers may appear"),
    });
    const conflict = fixtureValues(pack);
    conflict.set("OverrideOfficialDifficulty", 5);
    conflict.set("DifficultyOffset", 1.5);
    expect(validate(pack, conflict)).toContainEqual({
      key: "DifficultyOffset",
      severity: "warning",
      message: expect.stringContaining("older difficulty offset"),
    });
  });
});
