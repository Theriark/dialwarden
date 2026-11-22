import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import { isThemePreference, resolveTheme, THEME_KEY } from "./theme";

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

  it("reads the same key as the inline script of index.html", () => {
    // The script runs before the first paint (contract C8); it must read the
    // key the store writes, or the page flashes the wrong theme.
    expect(indexHtml).toContain(`localStorage.getItem("${THEME_KEY}")`);
    expect(indexHtml).toContain('setAttribute("data-theme", theme)');
  });
});
