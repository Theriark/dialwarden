import { describe, expect, it } from "vitest";
import { SETTING_TYPES, isPackId } from "./index.js";

describe("packs-schema skeleton", () => {
  it("lists the setting types of contract C3", () => {
    expect(SETTING_TYPES).toContain("duration");
    expect(SETTING_TYPES).toHaveLength(8);
  });

  it("accepts folder-style pack ids only", () => {
    expect(isPackId("palworld")).toBe(true);
    expect(isPackId("7-days-to-die")).toBe(true);
    expect(isPackId("Palworld")).toBe(false);
    expect(isPackId("../etc")).toBe(false);
  });
});
