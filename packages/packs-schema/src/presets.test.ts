import { describe, expect, it } from "vitest";
import { settingOf, testPack } from "../test/kit.js";
import { fromFileValue, sameAsDefault } from "./coerce.js";
import { maskSecrets, maskValue, SECRET_MASK } from "./mask.js";
import { applyPreset, sameJson } from "./presets.js";
import type { Setting } from "./types.js";

const pack = testPack();

describe("presets engine", () => {
  it("applies a preset and reports only the settings that change", () => {
    const result = applyPreset(pack, { Mode: "Casual" }, "casual");
    expect(result.changes).toEqual([{ key: "Difficulty", from: 1, to: 0.5 }]);
    expect(Object.fromEntries(result.values)).toEqual({
      Mode: "Casual",
      Difficulty: 0.5,
      PvP: false,
    });
  });

  it("compares against the defaults when a value is not set", () => {
    const result = applyPreset(pack, new Map(), "hardcore");
    expect(result.changes.map((change) => change.key)).toEqual([
      "Difficulty",
      "PvP",
      "Mode",
      "AdminPassword",
    ]);
  });

  it("refuses a preset the pack does not have", () => {
    expect(() => applyPreset(pack, {}, "nightmare")).toThrow(
      "pack testpack has no preset nightmare",
    );
  });

  it("ignores preset keys that are not settings", () => {
    const odd = {
      ...pack,
      presets: [{ id: "odd", label: "Odd", values: { Ghost: 1, PvP: true } }],
    };
    const result = applyPreset(odd, {}, "odd");
    expect(result.changes).toEqual([{ key: "PvP", from: false, to: true }]);
    expect(result.values.has("Ghost")).toBe(false);
  });

  it("compares JSON values deeply", () => {
    expect(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameJson([1, 2], [1, 3])).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson(1, "1")).toBe(false);
    expect(sameJson(undefined, undefined)).toBe(true);
  });
});

describe("secret masking", () => {
  it("masks secret defaults and preset values, nothing else", () => {
    const masked = maskSecrets(pack);
    expect(settingOf(masked, "AdminPassword").default).toBe(SECRET_MASK);
    expect(settingOf(masked, "ServerName").default).toBe(
      "Synthetic Test Server",
    );
    const hardcore = masked.presets.find((preset) => preset.id === "hardcore");
    expect(hardcore?.values).toEqual({
      Mode: "Hardcore",
      Difficulty: 3,
      PvP: true,
      AdminPassword: SECRET_MASK,
    });
    const text = JSON.stringify(masked);
    expect(text).not.toContain('"AdminPassword":"hardcore"');
    expect(settingOf(pack, "AdminPassword").default).toBe("");
  });

  it("masks one value of a secret setting", () => {
    const secret = settingOf(pack, "AdminPassword");
    expect(maskValue(secret, "letmein")).toBe(SECRET_MASK);
    expect(maskValue(settingOf(pack, "Mode"), "Casual")).toBe("Casual");
    expect(maskValue(undefined, 3)).toBe(3);
  });

  it("masks any secret default and keeps a secret without one as it is", () => {
    const port = { ...settingOf(pack, "Port"), secret: true };
    const bare: Setting = {
      key: "Token",
      file: "game",
      locator: { kind: "ini", section: "ServerSettings", key: "Token" },
      type: "string",
      secret: true,
      description: "A secret setting with no default value.",
    };
    const masked = maskSecrets({ ...pack, settings: [port, bare] });
    expect(masked.settings).toEqual([{ ...port, default: SECRET_MASK }, bare]);
  });
});

describe("file values to typed values", () => {
  it("reads on/off words, numbers and choices", () => {
    const pvp = settingOf(pack, "PvP");
    expect(fromFileValue(pvp, "False")).toBe(false);
    expect(fromFileValue(pvp, "ON")).toBe(true);
    expect(fromFileValue(pvp, 1)).toBe(true);
    expect(fromFileValue(pvp, true)).toBe(true);
    expect(fromFileValue(pvp, "maybe")).toBeUndefined();
    const players = settingOf(pack, "MaxPlayers");
    expect(fromFileValue(players, " 16 ")).toBe(16);
    expect(fromFileValue(players, 16)).toBe(16);
    expect(fromFileValue(players, "")).toBeUndefined();
    expect(fromFileValue(players, "sixteen")).toBeUndefined();
    expect(fromFileValue(players, true)).toBeUndefined();
    const mode = settingOf(pack, "Mode");
    expect(fromFileValue(mode, "Hardcore")).toBe("Hardcore");
    expect(fromFileValue(mode, "hardcore")).toBeUndefined();
    const levels = {
      ...mode,
      enum: [
        { value: 1, label: "One" },
        { value: 2, label: "Two" },
      ],
    };
    expect(fromFileValue(levels, "2.0")).toBe(2);
  });

  it("reads text, lists and groups", () => {
    const name = settingOf(pack, "ServerName");
    expect(fromFileValue(name, "Harbour")).toBe("Harbour");
    expect(fromFileValue(name, 12)).toBe("12");
    expect(fromFileValue(name, ["a"])).toBeUndefined();
    const list = { ...name, type: "list" as const };
    expect(fromFileValue(list, ["a", "b"])).toEqual(["a", "b"]);
    expect(fromFileValue(list, "a")).toEqual(["a"]);
    const group = { ...name, type: "struct" as const };
    expect(fromFileValue(group, { a: "1" })).toEqual({ a: "1" });
    expect(fromFileValue(group, "a")).toBeUndefined();
  });

  it("compares file values with defaults", () => {
    const difficulty = settingOf(pack, "Difficulty");
    expect(sameAsDefault(difficulty, "1.000000", 1)).toBe(true);
    expect(sameAsDefault(difficulty, "1.5", 1)).toBe(false);
    expect(sameAsDefault(settingOf(pack, "PvP"), "False", false)).toBe(true);
    expect(sameAsDefault(settingOf(pack, "PvP"), "x", false)).toBe(false);
  });
});
