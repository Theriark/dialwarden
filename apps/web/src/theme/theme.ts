// Theme preference (light, dark or system) stored as dw.theme; the resolved
// theme is written to html[data-theme] and colour-scheme follows it, so
// native controls and scrollbars match (design-direction-1 part 2.1).
import { readStored, writeStored } from "../lib/storage";

export const THEME_KEY = "dw.theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
  const stored = readStored(THEME_KEY);
  return isThemePreference(stored) ? stored : "system";
}

export function writeThemePreference(value: ThemePreference): void {
  writeStored(THEME_KEY, value);
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemDark ? "dark" : "light";
  }
  return preference;
}

export function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
}
