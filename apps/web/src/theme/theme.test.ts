import { describe, expect, it } from "vitest";
import { isThemePreference, resolveTheme } from "./theme";

describe("theme", () => {
  it("resolves system to the operating system choice", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("accepts only the three preferences", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
