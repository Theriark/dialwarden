// Game packs (interface contract C3): the pack.json schema and its checks,
// validate(pack, values), JSONLogic rules, presets, detection, secret masking
// and the wrong-file lint. Everything here runs in the browser and on the
// server alike; the loader and the packs check that read files are in
// @dialwarden/packs-schema/node.

export * from "./types.js";
export { checkPack, referenceProblems, safeRelativePath } from "./check.js";
export type { PackCheck } from "./check.js";
export { fromFileValue, sameAsDefault } from "./coerce.js";
export {
  AcfError,
  appManifestPath,
  buildSupported,
  detectGames,
  MAX_ACF_BYTES,
  parseAppManifest,
  parseKeyValues,
} from "./detection.js";
export type {
  AppManifest,
  Detection,
  DetectionProbe,
  KeyValues,
} from "./detection.js";
export { lintPackFile } from "./lint.js";
export { maskSecrets, maskValue, SECRET_MASK } from "./mask.js";
export { applyPreset, sameJson } from "./presets.js";
export type { PresetChange, PresetResult } from "./presets.js";
export {
  checkLogic,
  checkRules,
  RULE_OPERATORS,
  ruleData,
  ruleFires,
  secretReads,
} from "./rules.js";
export type { LogicCheck, RuleData } from "./rules.js";
export { schemaProblems } from "./schema.js";
export {
  checkValue,
  effectiveValues,
  hasShellCharacters,
  SHELL_ADAPTERS,
  validate,
} from "./validate.js";
export type { ValidateOptions, Values } from "./validate.js";

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A pack id is the folder name under packs/: lower case, digits and dashes. */
export function isPackId(value: string): boolean {
  return PACK_ID.test(value);
}
