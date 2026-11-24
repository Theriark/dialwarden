// The bridge between the settings-meta API (contract C3) and the pack types
// the shared @dialwarden/packs-schema code works with. validate() runs in the
// browser exactly as on the server, so the editor shows the same issues the
// server refuses with; only rules marked serverEvaluated are left to the
// server, because the browser holds masked secrets (THE-2361).
import {
  validate,
  type Pack,
  type Setting,
  type ValidationIssue,
  type Values,
} from "@dialwarden/packs-schema";
import type { SettingsMeta } from "../api/schema";

/**
 * The pack of a settings-meta answer. builds, detection and probes never
 * reach the browser paths of the pack code; the cast fills them as unknown.
 */
export function packOf(meta: SettingsMeta): Pack {
  return {
    id: meta.id,
    version: meta.version,
    displayName: meta.displayName,
    steamAppId: meta.steamAppId,
    os: [...meta.os],
    files: meta.files as Pack["files"],
    settings: meta.settings as Pack["settings"],
    rules: meta.rules as Pack["rules"],
    presets: meta.presets as Pack["presets"],
    hooksSupported: [...meta.hooksSupported] as Pack["hooksSupported"],
    sources: [...meta.sources],
  } as unknown as Pack;
}

/** The pack's settings by key. */
export function settingsByKey(
  settings: readonly Setting[],
): Map<string, Setting> {
  return new Map(settings.map((setting) => [setting.key, setting]));
}

/**
 * The issues of the editor's values, by setting key: the shared validate()
 * over the current values with the server-only rules skipped.
 */
export function issuesOf(
  pack: Pack,
  values: Readonly<Record<string, unknown>>,
): Map<string, ValidationIssue> {
  const issues = new Map<string, ValidationIssue>();
  // The values arrive from the settings JSON answer, so they are JsonValue by
  // construction; the cast only satisfies the shared signature.
  for (const issue of validate(pack, values as Values, {
    includeServerEvaluated: false,
  })) {
    if (!issues.has(issue.key)) {
      issues.set(issue.key, issue);
    }
  }
  return issues;
}
