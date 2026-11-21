// Game pack schema (interface contract C3). P3 adds the full schema, the
// loader and validate(pack, values); P0 fixes the setting types and pack ids.

export const SETTING_TYPES = [
  "bool",
  "int",
  "float",
  "enum",
  "string",
  "duration",
  "list",
  "struct",
] as const;

export type SettingType = (typeof SETTING_TYPES)[number];

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A pack id is the folder name under packs/: lower case, digits and dashes. */
export function isPackId(value: string): boolean {
  return PACK_ID.test(value);
}
