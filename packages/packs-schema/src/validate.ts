// validate(pack, values), contract C3: one function for the browser and the
// server, so the editor shows exactly the issues the server refuses with.
// Rules marked serverEvaluated are the one exception: only the server runs
// them, because the browser sees secrets masked (THE-2361).
import { ruleData, ruleFires } from "./rules.js";
import type { JsonValue, Pack, Setting, ValidationIssue } from "./types.js";

/** Adapters whose files a shell reads (LinuxGSM runs them through sh -c). */
const SHELL_ADAPTER_IDS = ["launch", "shellvar", "shellvar-systemd"];
export const SHELL_ADAPTERS: ReadonlySet<string> = new Set(SHELL_ADAPTER_IDS);

/**
 * Characters that let a value run a command when a shell reads it:
 * ; & | ` $ ( ) < > \ and line breaks (carry-over X1 from P2).
 */
const SHELL_CHARACTERS = /[;&|`$()<>\\\n\r]/;

/**
 * Plain $NAME and ${NAME} references, the grammar the P2 shellvar adapter
 * keeps live. A reference runs no command itself: it inserts another
 * variable, one LinuxGSM sets (such as port) or one of the same file, which
 * this check covers too. The LinuxGSM default startparameters use them, as
 * in -port=${port}. $(...), $((...)), $1, ${NAME:-...} and the other braced
 * forms with operators stay refused (code reviewer finding M1, THE-2333).
 */
const VARIABLE_REFERENCE = /\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*/g;

const SHELL_MESSAGE =
  "Must not contain ; & | ` ( ) < > \\, a line break or a $ other than a plain $NAME or ${NAME} reference: the server start script passes this value to a shell.";

/** Values by setting key; a plain object from JSON or a Map. */
export type Values =
  ReadonlyMap<string, JsonValue> | { readonly [key: string]: JsonValue };

export function valueMap(values: Values): Map<string, JsonValue> {
  if (values instanceof Map) return new Map(values);
  return new Map(Object.entries(values as { [key: string]: JsonValue }));
}

function issue(setting: Setting, message: string): ValidationIssue {
  return { key: setting.key, severity: "error", message };
}

function isRecord(value: JsonValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeNumber(setting: Setting): string {
  return setting.unit === undefined ? "" : ` ${setting.unit}`;
}

/** A step is met when (value - min) / step is a whole number. */
function onStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function checkNumber(setting: Setting, value: number): string | undefined {
  if (!Number.isFinite(value)) return "Must be a finite number.";
  if (setting.type === "int" && !Number.isInteger(value)) {
    return "Must be a whole number.";
  }
  const unit = describeNumber(setting);
  if (setting.min !== undefined && value < setting.min) {
    return `Must be at least ${setting.min}${unit}.`;
  }
  if (setting.max !== undefined && value > setting.max) {
    return `Must be at most ${setting.max}${unit}.`;
  }
  const step = setting.step;
  if (step !== undefined && !onStep(value, step, setting.min ?? 0)) {
    return `Must be a multiple of ${step}${unit}.`;
  }
  return undefined;
}

function isChoice(setting: Setting, value: JsonValue): boolean {
  const choices = setting.enum ?? [];
  return choices.some((option) => option.value === value);
}

/** True when every item is a listed item choice, or the list has none. */
function itemsAreChoices(
  setting: Setting,
  items: readonly JsonValue[],
): boolean {
  const choices = setting.itemEnum;
  if (choices === undefined) return true;
  return items.every((item) => {
    return choices.some((option) => option.value === item);
  });
}

function checkLength(setting: Setting, length: number, noun: string) {
  if (setting.min !== undefined && length < setting.min) {
    return `Needs at least ${setting.min} ${noun}.`;
  }
  if (setting.max !== undefined && length > setting.max) {
    return `Allows at most ${setting.max} ${noun}.`;
  }
  return undefined;
}

/**
 * What is wrong with one value of a setting (type, range, step, enum, list
 * item choices), or undefined. null means "not set" and is always accepted.
 */
export function checkValue(
  setting: Setting,
  value: JsonValue,
): string | undefined {
  if (value === null) return undefined;
  switch (setting.type) {
    case "bool":
      return typeof value === "boolean" ? undefined : "Must be on or off.";
    case "int":
    case "float":
    case "duration":
      if (typeof value !== "number") return "Must be a number.";
      return checkNumber(setting, value);
    case "enum":
      if (isChoice(setting, value)) return undefined;
      return "Must be one of the listed choices.";
    case "string":
      if (typeof value !== "string") return "Must be text.";
      return checkLength(setting, value.length, "characters");
    case "list":
      if (!Array.isArray(value)) return "Must be a list.";
      if (value.some((item: JsonValue) => !isScalar(item))) {
        return "List items must be text, numbers or on/off values.";
      }
      if (!itemsAreChoices(setting, value)) {
        return "Every item must be one of the listed choices.";
      }
      return checkLength(setting, value.length, "items");
    case "struct":
      return isRecord(value) ? undefined : "Must be a group of fields.";
  }
}

function isScalar(value: JsonValue): boolean {
  return value === null || typeof value !== "object";
}

/** Every string inside a value, for the shell character check. */
function strings(value: JsonValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item: JsonValue) => strings(item));
  }
  if (isRecord(value)) {
    const fields = Object.values(value as { [key: string]: JsonValue });
    return fields.flatMap((item) => strings(item));
  }
  return [];
}

/**
 * True when a value holds a character a shell would act on. Ordinary
 * arguments pass: dash flags, numbers, names in quotes with spaces, and plain
 * $NAME or ${NAME} references.
 */
export function hasShellCharacters(value: JsonValue): boolean {
  return strings(value).some((text) => {
    return SHELL_CHARACTERS.test(text.replace(VARIABLE_REFERENCE, ""));
  });
}

/** The settings of a pack by key. */
export function settingsByKey(pack: Pack): Map<string, Setting> {
  return new Map(pack.settings.map((setting) => [setting.key, setting]));
}

/** The defaults of a pack overlaid with the given values, by key. */
export function effectiveValues(
  pack: Pack,
  values: ReadonlyMap<string, JsonValue>,
): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  for (const setting of pack.settings) {
    const fallback = setting.default;
    const value = values.has(setting.key) ? values.get(setting.key) : fallback;
    if (value !== undefined) out.set(setting.key, value);
  }
  return out;
}

export interface ValidateOptions {
  /**
   * Whether the rules marked serverEvaluated run (default true). The browser
   * passes false: it holds only masked secrets, so those rules are judged by
   * the server and reach the editor through its responses (THE-2361).
   */
  readonly includeServerEvaluated?: boolean;
}

/**
 * The issues of a set of values against a pack: unknown keys, types, min,
 * max, step, enums, shell characters in files a shell reads, and the pack's
 * rules over the defaults overlaid with the values. With the same values the
 * browser and the server get the same issues for every rule not marked
 * serverEvaluated; the server call (no options) runs every rule. The order
 * follows the pack.
 */
export function validate(
  pack: Pack,
  values: Values,
  options: ValidateOptions = {},
): ValidationIssue[] {
  const withServerRules = options.includeServerEvaluated ?? true;
  const given = valueMap(values);
  const settings = settingsByKey(pack);
  const shellFiles = new Set<string>();
  for (const file of pack.files) {
    if (SHELL_ADAPTERS.has(file.adapter)) shellFiles.add(file.id);
  }
  const issues: ValidationIssue[] = [];
  for (const key of given.keys()) {
    if (!settings.has(key)) {
      issues.push({ key, severity: "error", message: "Unknown setting." });
    }
  }
  for (const setting of pack.settings) {
    const value = given.get(setting.key);
    if (value === undefined) continue;
    const problem = checkValue(setting, value);
    if (problem !== undefined) issues.push(issue(setting, problem));
    if (shellFiles.has(setting.file) && hasShellCharacters(value)) {
      issues.push(issue(setting, SHELL_MESSAGE));
    }
  }
  const known = new Map([...given].filter(([key]) => settings.has(key)));
  const data = ruleData(effectiveValues(pack, known));
  for (const rule of pack.rules) {
    if (rule.serverEvaluated === true && !withServerRules) continue;
    if (!ruleFires(rule, data)) continue;
    for (const key of rule.settings) {
      issues.push({ key, severity: rule.severity, message: rule.message });
    }
  }
  return issues;
}
