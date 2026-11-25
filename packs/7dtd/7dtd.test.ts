// The 7 Days to Die pack (dev-work-plan P7 step 3): the V3 property list
// of serverconfig.xml, the pre-V3 keys this game version ignores, and the
// SandboxCode result of the decode spike: the string splits into a version
// letter and three-letter groups (two letters pick the option, one the
// value), but the option tables change between game builds while the
// version letter stays, so a typed editor would decode differently per
// build and the tables in the wild are extracted from game code. The pack
// ships SandboxCode as an opaque string pasted from the game's Sandbox
// screen, with a shape rule (Risk 11: either result ships).
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

const pack = loadPack("7dtd");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const serverconfig = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/serverconfig.xml`));
const serveradmin = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/serveradmin.xml`));

/** The 31 pre-V3 keys the fixture carries (30 stock rows plus the mod-era
 * LootTimer the draft flagged). */
const PRE_V3 = [
  "GameDifficulty",
  "BlockDamagePlayer",
  "BlockDamageAI",
  "BlockDamageAIBM",
  "XPMultiplier",
  "DayNightLength",
  "DayLightLength",
  "BiomeProgression",
  "StormFreq",
  "DeathPenalty",
  "DropOnDeath",
  "DropOnQuit",
  "JarRefund",
  "EnemySpawnMode",
  "EnemyDifficulty",
  "ZombieFeralSense",
  "ZombieMove",
  "ZombieMoveNight",
  "ZombieFeralMove",
  "ZombieBMMove",
  "AISmellMode",
  "BloodMoonFrequency",
  "BloodMoonRange",
  "BloodMoonWarning",
  "BloodMoonEnemyCount",
  "LootAbundance",
  "LootRespawnDays",
  "AirDropFrequency",
  "AirDropMarker",
  "QuestProgressionDailyLimit",
  "LootTimer",
];

describe("7 Days to Die pack", () => {
  it("declares its files, probes and hooks", () => {
    expect(
      pack.files.map((file) => [file.id, file.adapter, file.applyPolicy]),
    ).toEqual([
      ["serverconfig", "xml", "anytime"],
      ["serveradmin", "xml", "stopped-only"],
      ["launch", "launch", "anytime"],
    ]);
    // The admin file resolves inside the Saves folder of the data
    // directory; the demo keeps both inside the server root.
    expect(pack.files[1]?.paths.linux).toEqual([
      "UserData/Saves/serveradmin.xml",
    ]);
    expect(pack.probes).toEqual([
      {
        kind: "telnet7dtd",
        portSetting: "TelnetPort",
        passwordSetting: "TelnetPassword",
        host: "127.0.0.1",
        allow: ["saveworld", "shutdown"],
        saveCommand: "saveworld",
        stopCommand: "shutdown",
      },
      {
        kind: "a2s",
        portSetting: "ServerPort",
        host: "127.0.0.1",
        players: true,
      },
    ]);
  });

  it("reads the stock V3 shape: CRLF, tabs, declaration without encoding", () => {
    const { adapter, doc, bytes } = fixtureOf(pack, "serverconfig");
    expect(doc.newline).toBe("\r\n");
    expect(text(bytes)).toContain('<?xml version="1.0"?>');
    expect(adapter.get(doc, { kind: "xml", property: "ServerPort" })).toBe(
      "26900",
    );
    expect(adapter.get(doc, { kind: "xml", property: "SandboxCode" })).toBe(
      "AAAJABJACJADJARFBNC",
    );
    expect(adapter.get(doc, { kind: "xml", property: "UserDataFolder" })).toBe(
      "UserData",
    );
  });

  it("keeps the admin file raw: it parses, and no setting addresses it", () => {
    const { doc } = fixtureOf(pack, "serveradmin");
    expect(doc.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(
      pack.settings.filter((setting) => setting.file === "serveradmin"),
    ).toEqual([]);
    // The example entries stay comments; the command list stays live.
    expect(text(serveradmin())).toContain('platform="Steam"');
  });

  it("edits one property and keeps the alignment of the file", () => {
    const { adapter, bytes } = fixtureOf(pack, "serverconfig");
    const written = writeFileValues(pack, "serverconfig", bytes, [
      { key: "ServerMaxPlayerCount", value: 16 },
    ]);
    const reread = adapter.parse(written);
    expect(
      adapter.get(reread, { kind: "xml", property: "ServerMaxPlayerCount" }),
    ).toBe("16");
    expect(text(written)).toContain('name="ServerMaxPlayerCount"');
    expect(parsed(written).newline).toBe("\r\n");
  });

  it("flags every pre-V3 key the fixture still carries", () => {
    const issues = validate(pack, fixtureValues(pack));
    expect(issues).toHaveLength(PRE_V3.length + 2);
    for (const key of PRE_V3) {
      expect(issues).toContainEqual({
        key,
        severity: "warning",
        message: expect.stringContaining("ignored by the current game"),
      });
    }
    // The console ships without a password, so the loopback note fires
    // for both settings the rule names.
    for (const key of ["TelnetEnabled", "TelnetPassword"]) {
      expect(issues).toContainEqual({
        key,
        severity: "info",
        message: expect.stringContaining("loopback only"),
      });
    }
    // Every ignored key is marked gone, so the editor badges it.
    for (const key of PRE_V3) {
      expect(settingOf(pack, key).removedIn).toBe("3.0");
    }
  });

  it("keeps the pre-V3 lines and never creates them", () => {
    const { adapter, bytes } = fixtureOf(pack, "serverconfig");
    const written = writeFileValues(pack, "serverconfig", bytes, [
      { key: "ServerName", value: "Dialwarden demo" },
    ]);
    const reread = adapter.parse(written);
    for (const key of ["GameDifficulty", "XPMultiplier", "LootTimer"]) {
      expect(
        adapter.get(reread, { kind: "xml", property: key }),
        key,
      ).not.toBeUndefined();
    }
  });

  it("carries an active UserDataFolder the pack path matches", () => {
    // AdminFileName resolves inside UserDataFolder/Saves; the demo writes
    // both, so the admin fixture sits where the pack expects it.
    const values = fixtureValues(pack);
    expect(values.get("AdminFileName")).toBe("serveradmin.xml");
    expect(values.get("UserDataFolder")).toBe("UserData");
  });

  it("checks the console, port and world rules", () => {
    const clash = fixtureValues(pack);
    clash.set("TelnetPort", 26901);
    expect(validate(pack, clash)).toContainEqual({
      key: "TelnetPort",
      severity: "error",
      message: expect.stringContaining("overlaps the game ports"),
    });
    const off = fixtureValues(pack);
    off.set("TelnetEnabled", false);
    expect(validate(pack, off)).toContainEqual({
      key: "TelnetEnabled",
      severity: "warning",
      message: expect.stringContaining("fall back to a process signal"),
    });
    const rwg = fixtureValues(pack);
    rwg.set("GameWorld", "RWG");
    rwg.set("WorldGenSeed", "");
    expect(validate(pack, rwg)).toContainEqual({
      key: "GameWorld",
      severity: "error",
      message: expect.stringContaining("needs a seed"),
    });
  });

  it("checks the crossplay rules as one warning", () => {
    const values = fixtureValues(pack);
    values.set("ServerAllowCrossplay", true);
    values.set("ServerMaxPlayerCount", 16);
    expect(validate(pack, values)).toContainEqual({
      key: "ServerMaxPlayerCount",
      severity: "warning",
      message: expect.stringContaining("Console crossplay needs"),
    });
  });

  it("treats a commented-out property as absent (the V3 template trap)", () => {
    const adapter = getAdapter("xml");
    if (adapter === undefined) throw new Error("no xml adapter");
    const commented = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<ServerSettings>\n' +
        '<!-- <property name="UserDataFolder" value="elsewhere" /> -->\n' +
        '<property name="ServerName" value="Kept" />\n' +
        "</ServerSettings>\n",
    );
    const doc = adapter.parse(commented);
    expect(
      adapter.get(doc, { kind: "xml", property: "UserDataFolder" }),
    ).toBeUndefined();
    expect(adapter.get(doc, { kind: "xml", property: "ServerName" })).toBe(
      "Kept",
    );
  });

  it("explains SandboxCode: present, missing and malformed", () => {
    // The fixture holds the stock code: 1 version letter plus six
    // three-letter groups, so the shape rule stays quiet.
    const shape = ruleOf(pack, "sandboxcode-shape");
    expect(shape.severity).toBe("warning");
    const stock = fixtureValues(pack);
    expect(stock.get("SandboxCode")).toBe("AAAJABJACJADJARFBNC");
    const wrong = fixtureValues(pack);
    wrong.set("SandboxCode", "AAAJABJAC");
    expect(validate(pack, wrong)).toContainEqual({
      key: "SandboxCode",
      severity: "warning",
      message: expect.stringContaining("groups of three letters"),
    });
    const empty = fixtureValues(pack);
    empty.set("SandboxCode", "");
    expect(validate(pack, empty)).toContainEqual({
      key: "SandboxCode",
      severity: "info",
      message: expect.stringContaining("default ruleset"),
    });
  });

  it("round-trips SandboxCode exactly, whatever it holds", () => {
    const { adapter, bytes } = fixtureOf(pack, "serverconfig");
    for (const code of ["AAAJABJACJADJARFBNC", "AAA", "A", "AABx"]) {
      const written = writeFileValues(pack, "serverconfig", bytes, [
        { key: "SandboxCode", value: code },
      ]);
      const reread = adapter.parse(written);
      expect(
        adapter.get(reread, { kind: "xml", property: "SandboxCode" }),
        code,
      ).toBe(code);
    }
  });

  it("shows only the intended lint in its fixture", () => {
    const issues = lintFile(pack, "serverconfig", serverconfig());
    // The fixture is well-formed; unknown mod properties carry no error.
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});

/** The parsed document, for the CRLF check after a write. */
function parsed(written: Uint8Array) {
  const adapter = getAdapter("xml");
  if (adapter === undefined) throw new Error("no xml adapter");
  return adapter.parse(written);
}
