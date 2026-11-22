// Settings marked secret are masked in API output (dev-work-plan P3-A
// step 2): their defaults, and their values in presets. An empty value
// stays empty instead: it reveals nothing, and the rules that read a
// secret (is it empty?) must see the same answer in the browser and on
// the server (contract C3, code review THE-2352 M2).
import type { JsonValue, Pack, Preset, Setting } from "./types.js";

/**
 * What the API shows instead of a non-empty value of a secret setting; an
 * empty value stays empty.
 */
export const SECRET_MASK = "********";

/** A value as the API may show it: masked when the setting is secret. */
export function maskValue(
  setting: Setting | undefined,
  value: JsonValue,
): JsonValue {
  if (setting?.secret === true && value !== "") return SECRET_MASK;
  return value;
}

function maskSetting(setting: Setting): Setting {
  if (setting.secret !== true || setting.default === undefined) {
    return setting;
  }
  if (setting.default === "") return setting;
  return { ...setting, default: SECRET_MASK };
}

function maskPreset(preset: Preset, secrets: ReadonlySet<string>): Preset {
  const values = new Map<string, JsonValue>();
  for (const [key, value] of Object.entries(preset.values)) {
    values.set(key, secrets.has(key) && value !== "" ? SECRET_MASK : value);
  }
  return { ...preset, values: Object.fromEntries(values) };
}

/** A copy of the pack with every secret setting's value masked. */
export function maskSecrets(pack: Pack): Pack {
  const secrets = new Set<string>();
  for (const setting of pack.settings) {
    if (setting.secret === true) secrets.add(setting.key);
  }
  return {
    ...pack,
    settings: pack.settings.map(maskSetting),
    presets: pack.presets.map((preset) => maskPreset(preset, secrets)),
  };
}
