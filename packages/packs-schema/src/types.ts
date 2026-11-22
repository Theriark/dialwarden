// Interface contract C3 (dev-work-plan-2): the shape of packs/GAME/pack.json.
// Field names are exact; a change needs an R&D Lead task first. The JSON
// Schema in pack.schema.json says the same thing for the validator.
import type { AdapterId, Locator } from "@dialwarden/formats";

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

export type Os = "linux" | "windows";

export type Severity = "error" | "warning" | "info";

/** A JSON value as pack.json and the settings API carry it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A file the pack edits; paths are relative to the server root. */
export interface PackFile {
  readonly id: string;
  readonly paths: {
    readonly linux?: readonly string[];
    readonly windows?: readonly string[];
  };
  readonly adapter: AdapterId;
  readonly encoding: "utf-8";
  readonly applyPolicy: "anytime" | "stopped-only";
}

export interface EnumOption {
  readonly value: string | number;
  readonly label: string;
}

/**
 * One setting. min and max bound the value of a number (int, float,
 * duration), the length of a string and the number of items of a list.
 */
export interface Setting {
  readonly key: string;
  readonly label?: string;
  readonly file: string;
  readonly locator: Locator;
  readonly type: SettingType;
  readonly default?: JsonValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly enum?: readonly EnumOption[];
  readonly group?: string;
  readonly tags?: readonly string[];
  /** Our own words, 20 to 300 characters (Legal). */
  readonly description: string;
  readonly restartRequired?: boolean;
  readonly secret?: boolean;
  readonly since?: string;
  readonly removedIn?: string;
  readonly panelManaged?: boolean;
  readonly liveReloadable?: boolean;
  readonly overrideNote?: string;
}

/**
 * A JSONLogic rule: when the logic is true for the current values (defaults
 * overlaid with the edited values), each listed setting gets an issue with
 * the rule's severity and message.
 */
export interface Rule {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
  readonly settings: readonly string[];
  readonly when: { readonly [operator: string]: JsonValue };
}

export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly values: { readonly [key: string]: JsonValue };
}

export interface Marker {
  readonly path: string;
  readonly os?: readonly Os[];
}

export interface DetectionWarning extends Marker {
  readonly message: string;
}

/** A status probe (contract C7); P6 adds the fields of each kind. */
export interface Probe {
  readonly kind:
    | "palworldRest"
    | "sourceRcon"
    | "rustWebRcon"
    | "telnet7dtd"
    | "sshCommand"
    | "dockerProxy";
  readonly [field: string]: JsonValue;
}

export interface Pack {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly steamAppId: number;
  readonly builds: { readonly from: number; readonly to?: number | null };
  readonly os: readonly Os[];
  readonly detection: {
    readonly markers: readonly Marker[];
    readonly warnings?: readonly DetectionWarning[];
  };
  readonly files: readonly PackFile[];
  readonly settings: readonly Setting[];
  readonly rules: readonly Rule[];
  readonly presets: readonly Preset[];
  readonly probes: readonly Probe[];
  readonly hooksSupported: readonly ("save" | "stop" | "start" | "restart")[];
  readonly sources: readonly string[];
}

/** One finding of validate(pack, values) (contract C3). */
export interface ValidationIssue {
  readonly key: string;
  readonly severity: Severity;
  readonly message: string;
}
