// The presets engine: a preset is a set of setting values; applying it to
// the current values says which settings change, from what, to what.
import type { JsonValue, Pack } from "./types.js";
import { settingsByKey, valueMap, type Values } from "./validate.js";

export interface PresetChange {
  readonly key: string;
  /** The current value, or the pack default when the value is not set. */
  readonly from: JsonValue | undefined;
  readonly to: JsonValue;
}

export interface PresetResult {
  /** The values with the preset applied. */
  readonly values: Map<string, JsonValue>;
  /** The settings whose value changes, in pack order. */
  readonly changes: readonly PresetChange[];
}

/** Deep equality of two JSON values (object key order does not matter). */
export function sameJson(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const right: readonly JsonValue[] = b;
    return (
      a.length === right.length &&
      a.every((item: JsonValue, i: number) => sameJson(item, right.at(i)))
    );
  }
  const left = new Map(Object.entries(a as { [key: string]: JsonValue }));
  const right = new Map(Object.entries(b as { [key: string]: JsonValue }));
  if (left.size !== right.size) return false;
  for (const [key, item] of left) {
    if (!right.has(key) || !sameJson(item, right.get(key))) return false;
  }
  return true;
}

/**
 * Applies the preset with the given id to the values. Keys of the preset
 * that are not settings of the pack are ignored (the pack check refuses
 * them); throws when the pack has no such preset.
 */
export function applyPreset(
  pack: Pack,
  values: Values,
  presetId: string,
): PresetResult {
  const preset = pack.presets.find((candidate) => candidate.id === presetId);
  if (preset === undefined) {
    throw new Error(`pack ${pack.id} has no preset ${presetId}`);
  }
  const settings = settingsByKey(pack);
  const next = valueMap(values);
  const wanted = new Map(Object.entries(preset.values));
  const changes: PresetChange[] = [];
  for (const [key, setting] of settings) {
    const to = wanted.get(key);
    if (to === undefined) continue;
    const from = next.has(key) ? next.get(key) : setting.default;
    next.set(key, to);
    if (!sameJson(from, to)) changes.push({ key, from, to });
  }
  return { values: next, changes };
}
