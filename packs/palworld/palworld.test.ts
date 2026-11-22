// Palworld pack (dev-work-plan P3-B): the synthetic fixture validates clean,
// the launch flags go through the X1 shell check, every rule fires and
// clears, the presets apply, and detection warns about WorldOption.sav.
import {
  applyPreset,
  detectGames,
  validate,
  type DetectionProbe,
  type JsonValue,
  type ValidationIssue,
} from "@dialwarden/packs-schema";
import { describe, expect, it } from "vitest";
import { fixtureValues, loadPack, ruleOf } from "../kit.js";

const pack = loadPack("palworld");
const fixture = fixtureValues(pack);
const PRESET_IDS = pack.presets.map((preset) => preset.id);

type Changes = Record<string, JsonValue>;

/** The issues of the fixture values with some values changed. */
function issuesWith(changes: Changes): ValidationIssue[] {
  const values = new Map(fixture);
  for (const [key, value] of Object.entries(changes)) values.set(key, value);
  return validate(pack, values);
}

function fires(id: string, changes: Changes): boolean {
  const { message } = ruleOf(pack, id);
  return issuesWith(changes).some((issue) => issue.message === message);
}

/** Rule id, values that make it fire, extra values that clear it again. */
const RULES: readonly (readonly [string, Changes, Changes])[] = [
  [
    "rest-without-admin-password",
    { RESTAPIEnabled: true },
    { AdminPassword: "admin-secret" },
  ],
  [
    "rcon-without-admin-password",
    { RCONEnabled: true },
    { AdminPassword: "admin-secret" },
  ],
  [
    "rest-port-is-game-port",
    { RESTAPIEnabled: true, AdminPassword: "a-secret", RESTAPIPort: 8211 },
    { RESTAPIPort: 8212 },
  ],
  [
    "rcon-port-is-game-port",
    { RCONEnabled: true, RCONPort: 8211 },
    { RCONPort: 25575 },
  ],
  [
    "rest-port-is-rcon-port",
    { RESTAPIEnabled: true, RCONEnabled: true, RCONPort: 8212 },
    { RCONPort: 25575 },
  ],
  ["players-mismatch", { "Launch.Players": 16 }, { ServerPlayerMaxNum: 16 }],
  [
    "pvp-options-without-pvp",
    { bEnablePlayerToPlayerDamage: true },
    { bIsPvP: true },
  ],
  [
    "pvp-incomplete",
    { bIsPvP: true },
    { bEnablePlayerToPlayerDamage: true, bEnableDefenseOtherGuildPlayer: true },
  ],
  ["rcon-deprecated", { RCONEnabled: true }, { RCONEnabled: false }],
  [
    "recreate-without-hardcore",
    { bCharacterRecreateInHardcore: true },
    { bHardcore: true },
  ],
  [
    "base-travel-without-travel",
    { bEnableFastTravelOnlyBaseCamp: true, bEnableFastTravel: false },
    { bEnableFastTravel: true },
  ],
  [
    "voice-distance-order",
    { bEnableVoiceChat: true, VoiceChatMaxVolumeDistance: 20000 },
    { VoiceChatMaxVolumeDistance: 3000 },
  ],
  [
    "console-players-not-listed",
    { "Launch.PublicLobby": false },
    { CrossplayPlatforms: ["Steam", "Mac"] },
  ],
  [
    "quote-in-text",
    { ServerDescription: 'Say "hello"' },
    { ServerDescription: "Say hello" },
  ],
  [
    "seed-without-randomizer",
    { RandomizerSeed: "seed-1" },
    { RandomizerType: "Region" },
  ],
  [
    "guild-reset-time-unused",
    { AutoResetGuildTimeNoOnlinePlayers: 48 },
    { bAutoResetGuildNoOnlinePlayers: true },
  ],
  ["public-port-differs", { PublicPort: 9000 }, { PublicPort: 8211 }],
];

describe("Palworld pack", () => {
  it("edits the settings file and the launch line, both when stopped", () => {
    const files = pack.files.map((f) => [f.id, f.adapter, f.applyPolicy]);
    expect(files).toEqual([
      ["settings", "ueini", "stopped-only"],
      ["launch", "launch", "stopped-only"],
    ]);
    expect(pack.settings.length).toBeGreaterThanOrEqual(80);
    expect(PRESET_IDS).toEqual(["casual", "default", "hardcore"]);
  });

  it("declares the REST probe on the settings that configure it", () => {
    expect(pack.probes).toEqual([
      expect.objectContaining({
        kind: "palworldRest",
        enabledSetting: "RESTAPIEnabled",
        portSetting: "RESTAPIPort",
        passwordSetting: "AdminPassword",
      }),
    ]);
  });

  it("finds no issue in its synthetic fixture", () => {
    expect(validate(pack, fixture)).toEqual([]);
  });

  it("refuses a launch flag value with a semicolon (X1)", () => {
    const value = "Lighthouse; rm -rf /";
    expect(issuesWith({ "Launch.ServerName": value })).toEqual([
      {
        key: "Launch.ServerName",
        severity: "error",
        message: expect.stringContaining("passes this value to a shell"),
      },
    ]);
    // The settings file is read by the game, not a shell: no X1 issue there.
    expect(issuesWith({ ServerName: value })).toEqual([]);
  });

  it("has a fire and clear case for every rule", () => {
    const ids = RULES.map(([id]) => id).sort();
    expect(ids).toEqual(pack.rules.map((rule) => rule.id).sort());
  });

  it.each(RULES)("rule %s fires and clears", (id, fire, clear) => {
    expect(fires(id, fire)).toBe(true);
    expect(fires(id, { ...fire, ...clear })).toBe(false);
  });

  it.each(PRESET_IDS)("applies preset %s without an issue", (id) => {
    const { values, changes } = applyPreset(pack, fixture, id);
    expect(validate(pack, values)).toEqual([]);
    if (id !== "default") expect(changes.length).toBeGreaterThan(0);
  });

  it("applies every preset after every other preset without an error or warning", () => {
    // Default returns everything Casual and Hardcore change, so switching
    // between presets leaves no warning behind; an info may remain.
    for (const before of PRESET_IDS) {
      const first = applyPreset(pack, fixture, before).values;
      for (const after of PRESET_IDS) {
        const { values } = applyPreset(pack, first, after);
        const issues = validate(pack, values).filter(
          (issue) => issue.severity !== "info",
        );
        expect(issues, `${before} then ${after}`).toEqual([]);
      }
    }
  });
});

describe("WorldOption.sav detection", () => {
  const SAVES = "Pal/Saved/SaveGames/0";
  const WORLD = "0A1B2C3D4E5F60718293A4B5C6D7E8F9";

  function server(files: readonly string[]): DetectionProbe {
    const present = new Set(files);
    return {
      exists: async (path) => present.has(path),
      read: async () => null,
      list: async (path) => (path === SAVES ? [WORLD] : null),
    };
  }

  it("warns when a world folder holds WorldOption.sav", async () => {
    const sav = `${SAVES}/${WORLD}/WorldOption.sav`;
    const [found] = await detectGames([pack], server(["PalServer.sh", sav]));
    expect(found).toMatchObject({ packId: "palworld", os: "linux" });
    const message = pack.detection.warnings?.at(0)?.message;
    expect(message).toContain("WorldOption.sav");
    expect(found?.warnings).toEqual([message]);
  });

  it("does not warn without the file", async () => {
    const [found] = await detectGames([pack], server(["PalServer.exe"]));
    expect(found).toMatchObject({ packId: "palworld", os: "windows" });
    expect(found?.warnings).toEqual([]);
  });
});
