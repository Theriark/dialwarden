// Settings marked secret are always masked in API output (dev-work-plan P3-A
// step 2): their defaults, and their values in presets.
import type { JsonValue, Pack, Preset, Setting } from "./types.js";

/** What the API shows instead of the value of a secret setting. */
export const SECRET_MASK = "********";

/** A value as the API may show it: masked when the setting is secret. */
export function maskValue(
  setting: Setting | undefined,
  value: JsonValue,
): JsonValue {
  return setting?.secret === true ? SECRET_MASK : value;
}

function maskSetting(setting: Setting): Setting {
  if (setting.secret !== true || setting.default === undefined) {
    return setting;
  }
  return { ...setting, default: SECRET_MASK };
}

function maskPreset(preset: Preset, secrets: ReadonlySet<string>): Preset {
  const values = new Map<string, JsonValue>();
  for (const [key, value] of Object.entries(preset.values)) {
    values.set(key, secrets.has(key) ? SECRET_MASK : value);
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
