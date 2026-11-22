// File values to typed values. Text formats (INI, shell variables, launch
// arguments) read every value as text; the setting's type says what the text
// means. JSON values keep their type.
import type { Value } from "@dialwarden/formats";
import { sameJson } from "./presets.js";
import type { EnumOption, JsonValue, Setting } from "./types.js";

const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0"]);

function toText(value: Value): string | undefined {
  // null, lists and structs have no text form.
  if (typeof value === "object") return undefined;
  return String(value);
}

function toNumber(value: Value): number | undefined {
  if (typeof value === "number") return value;
  const text = toText(value)?.trim() ?? "";
  if (typeof value === "boolean" || text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBool(value: Value): boolean | undefined {
  if (typeof value === "boolean") return value;
  const word = toText(value)?.trim().toLowerCase() ?? "";
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

function enumMatches(option: EnumOption, value: Value): boolean {
  if (typeof option.value === "number") return option.value === toNumber(value);
  return option.value === toText(value);
}

function toEnum(setting: Setting, value: Value): JsonValue | undefined {
  const options = setting.enum ?? [];
  return options.find((option) => enumMatches(option, value))?.value;
}

/**
 * The typed value of a file value for a setting, or undefined when the text
 * does not fit the type (the editor then shows the value as invalid).
 */
export function fromFileValue(
  setting: Setting,
  value: Value,
): JsonValue | undefined {
  switch (setting.type) {
    case "bool":
      return toBool(value);
    case "int":
    case "float":
    case "duration":
      return toNumber(value);
    case "enum":
      return toEnum(setting, value);
    case "string":
      return toText(value);
    case "list":
      return Array.isArray(value) ? value : [value];
    case "struct":
      return typeof value === "object" && value !== null ? value : undefined;
  }
}

/** True when a file value equals a pack default (numbers within 1e-9). */
export function sameAsDefault(
  setting: Setting,
  fileValue: Value,
  fallback: JsonValue,
): boolean {
  const typed = fromFileValue(setting, fileValue);
  if (typeof typed === "number" && typeof fallback === "number") {
    const scale = Math.max(1, Math.abs(typed), Math.abs(fallback));
    return Math.abs(typed - fallback) <= 1e-9 * scale;
  }
  return sameJson(typed, fallback);
}
