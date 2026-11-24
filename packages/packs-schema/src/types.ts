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
  /**
   * The launch sources of a launch file (P6): where its argument line may
   * live instead of the file itself. The args source is always available.
   */
  readonly launchSources?: readonly LaunchSource[];
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
  /**
   * The words each item of a list setting must be (list only, THE-2362);
   * without it the items are free text.
   */
  readonly itemEnum?: readonly EnumOption[];
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
  /**
   * Only the server runs this rule, on the real stored values; the browser
   * sees only masked secrets and skips it (THE-2361). A rule that reads a
   * secret beyond an emptiness or presence test needs it.
   */
  readonly serverEvaluated?: boolean;
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

/**
 * A status probe (contract C7). P6 adds the fields of each kind: the
 * protocol probes name the settings that hold their port and password and
 * the allow-listed commands their hooks map to (palworldRest reads its own
 * REST API: enabledSetting, portSetting, passwordSetting, user, host,
 * scheme, infoPath; sourceRcon, rustWebRcon and telnet7dtd add portSetting,
 * passwordSetting, host, port, allow, saveCommand and stopCommand; a2s adds
 * portSetting, host, port and players). sshCommand and dockerProxy are
 * per-server hook configurations and hold no pack fields.
 */
export interface Probe {
  readonly kind:
    | "palworldRest"
    | "sourceRcon"
    | "rustWebRcon"
    | "telnet7dtd"
    | "a2s"
    | "sshCommand"
    | "dockerProxy";
  readonly [field: string]: JsonValue;
}

/**
 * Where the argument line of a launch file lives (dev-work-plan P6-A step 5):
 * the app-managed dialwarden-args.txt, a LinuxGSM instance cfg, a container
 * env file, or a panel-managed file the app can only read. The args source
 * is the file itself; the others name their own paths and hold the launch
 * line inside shell variables, one value word per flag.
 */
export type LaunchSource =
  | { readonly kind: "args" }
  | {
      readonly kind: "linuxgsm";
      /** The instance cfg (only the instance file is ever written). */
      readonly paths: {
        readonly linux?: readonly string[];
        readonly windows?: readonly string[];
      };
      /** Flags mapped to their own shell variable (-port to port). */
      readonly flagVars?: { readonly [flag: string]: string };
      /** The variable holding the -preset, -modifier and -setkey flags. */
      readonly modifiersVar?: string;
      /** The variable holding every other flag (LinuxGSM startparameters). */
      readonly argsVar?: string;
    }
  | {
      readonly kind: "env";
      /** The container env file (KEY=value, one line each). */
      readonly paths: {
        readonly linux?: readonly string[];
        readonly windows?: readonly string[];
      };
      /** Flags mapped to their own env variable (-name to SERVER_NAME). */
      readonly flagVars?: { readonly [flag: string]: string };
      /** The variable holding every other flag (SERVER_ARGS). */
      readonly argsVar?: string;
    }
  | {
      readonly kind: "panel";
      /** The file the panel reads today; shown, never written. */
      readonly paths: {
        readonly linux?: readonly string[];
        readonly windows?: readonly string[];
      };
    };

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
