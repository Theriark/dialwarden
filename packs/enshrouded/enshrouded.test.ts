// Enshrouded pack (dev-work-plan P3-B): the synthetic fixture validates
// clean, the custom difficulty values warn unless the preset is Custom, the
// role passwords are secret, and every other rule fires and clears.
import {
  applyPreset,
  maskSecrets,
  SECRET_MASK,
  SHELL_ADAPTERS,
  validate,
  type JsonValue,
  type ValidationIssue,
} from "@dialwarden/packs-schema";
import { describe, expect, it } from "vitest";
import { fixtureValues, loadPack, otherValue, ruleOf } from "../kit.js";

const pack = loadPack("enshrouded");
const fixture = fixtureValues(pack);
const CUSTOM_RULE = ruleOf(pack, "custom-values-need-custom-preset");
const CUSTOM = "gameSettings.";
const CUSTOM_KEYS = pack.settings.filter((s) => s.key.startsWith(CUSTOM));
const CUSTOM_CASES = CUSTOM_KEYS.map((s) => [s.key, s] as const);

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
    "custom-values-need-custom-preset",
    { "gameSettings.threatBonus": 2 },
    { gameSettingsPreset: "Custom" },
  ],
  [
    "role-without-password",
    { "userGroups.slot2.password": "" },
    { "userGroups.slot2.password": "friend-secret" },
  ],
  [
    "role-names-repeat",
    { "userGroups.slot3.name": "Friend" },
    { "userGroups.slot3.name": "Guest" },
  ],
  [
    "reserved-seats-over-slots",
    {
      "userGroups.slot1.reservedSlots": 10,
      "userGroups.slot2.reservedSlots": 8,
    },
    { "userGroups.slot2.reservedSlots": 6 },
  ],
  [
    "voice-range-without-voice",
    { voiceChatMode: "Global" },
    { enableVoiceChat: true },
  ],
  [
    "starving-time-without-hunger",
    { "gameSettings.fromHungerToStarving": 900000000000 },
    { "gameSettings.enableStarvingDebuff": true },
  ],
];

describe("Enshrouded pack", () => {
  it("edits enshrouded_server.json only while the server is stopped", () => {
    expect(pack.files).toEqual([
      expect.objectContaining({ adapter: "json", applyPolicy: "stopped-only" }),
    ]);
    expect(pack.settings.length).toBeGreaterThanOrEqual(30);
    expect(CUSTOM_KEYS).toHaveLength(38);
  });

  it("finds no issue in its synthetic fixture", () => {
    expect(validate(pack, fixture)).toEqual([]);
  });

  it("has a fire and clear case for every rule", () => {
    const ids = RULES.map(([id]) => id).sort();
    expect(ids).toEqual(pack.rules.map((rule) => rule.id).sort());
  });

  it.each(RULES)("rule %s fires and clears", (id, fire, clear) => {
    expect(fires(id, fire)).toBe(true);
    expect(fires(id, { ...fire, ...clear })).toBe(false);
  });

  it("keeps the role passwords secret, with no value in the pack", () => {
    const secrets = pack.settings.filter((s) => s.secret === true);
    expect(secrets.map((s) => s.key)).toEqual([
      "userGroups.slot1.password",
      "userGroups.slot2.password",
      "userGroups.slot3.password",
      "userGroups.slot4.password",
    ]);
    for (const secret of secrets) expect(secret.default).toBeUndefined();
    const masked = JSON.stringify(maskSecrets(pack));
    expect(masked).not.toContain("synthetic-admin-pass");
    expect(masked).not.toContain(SECRET_MASK);
  });

  it("warns, not errors, about an empty role password", () => {
    // An open role is a valid game setup, so the operator gets a warning
    // on every password field, never a refusal.
    const { severity, message } = ruleOf(pack, "role-without-password");
    expect(severity).toBe("warning");
    const fields = [1, 2, 3, 4].map((n) => `userGroups.slot${n}.password`);
    expect(issuesWith({ "userGroups.slot4.password": "" })).toEqual(
      fields.map((key) => ({ key, severity, message })),
    );
  });

  it("stays quiet about role slots the file does not have", () => {
    // The game can write a single role; slots 2 to 4 then read as absent,
    // and no rule may count two absent slots as a repeat.
    const single = new Map(
      [...fixture].filter(([key]) => !/^userGroups\.slot[2-4]\./.test(key)),
    );
    expect(validate(pack, single)).toEqual([]);
  });

  it("refuses a browser tag the game does not know as an error", () => {
    // An unknown tag stops the server at start, so it never reaches the file.
    expect(issuesWith({ tags: ["English", "Roleplay"] })).toEqual([]);
    expect(issuesWith({ tags: ["English", "Pirates"] })).toEqual([
      {
        key: "tags",
        severity: "error",
        message: "Every item must be one of the listed choices.",
      },
    ]);
  });

  it("reads no file through a shell, so the X1 check never applies", () => {
    const shellRead = pack.files.some((f) => SHELL_ADAPTERS.has(f.adapter));
    expect(shellRead).toBe(false);
    expect(issuesWith({ name: "Den; of thieves" })).toEqual([]);
  });

  it.each(pack.presets.map((preset) => preset.id))("applies %s", (id) => {
    const { values } = applyPreset(pack, fixture, id);
    const issues = validate(pack, values);
    expect(issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  });

  it("applies every preset after every other preset without a warning", () => {
    // Default resets the custom difficulty values too, so switching from
    // one preset to another never leaves the custom-preset warning behind.
    for (const before of pack.presets) {
      const first = applyPreset(pack, fixture, before.id).values;
      for (const after of pack.presets) {
        const { values } = applyPreset(pack, first, after.id);
        const issues = validate(pack, values).filter(
          (issue) => issue.severity !== "info",
        );
        expect(issues, `${before.id} then ${after.id}`).toEqual([]);
      }
    }
  });
});

describe("the Custom preset rule", () => {
  const warning = {
    key: "gameSettingsPreset",
    severity: "warning",
    message: CUSTOM_RULE.message,
  };

  it("shows its message on the preset setting in the editor", () => {
    expect(CUSTOM_RULE.settings).toEqual(["gameSettingsPreset"]);
    const issues = issuesWith({ "gameSettings.playerHealthFactor": 2 });
    expect(issues).toEqual([warning]);
  });

  it.each(CUSTOM_CASES)("fires on %s with built-in presets", (key, setting) => {
    const value = otherValue(setting, fixture.get(key) ?? null);
    for (const preset of ["Default", "Relaxed", "Hard", "Survival"]) {
      const changes: Changes = Object.fromEntries([
        ["gameSettingsPreset", preset],
        [key, value],
      ]);
      expect(fires(CUSTOM_RULE.id, changes), preset).toBe(true);
    }
  });

  it("clears when the preset becomes Custom", () => {
    const changes = { "gameSettings.playerHealthFactor": 2 };
    const custom = { ...changes, gameSettingsPreset: "Custom" };
    expect(issuesWith(custom)).toEqual([]);
  });

  it("clears when the value is back at its default", () => {
    const changes = { "gameSettings.playerHealthFactor": 1 };
    expect(issuesWith(changes)).toEqual([]);
  });

  it("does not fire for a preset alone", () => {
    for (const preset of ["Relaxed", "Hard", "Survival", "Custom"]) {
      expect(issuesWith({ gameSettingsPreset: preset })).toEqual([]);
    }
  });
});
