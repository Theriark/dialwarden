// Reads `pnpm licenses list --json` for the installed workspace.
// eslint-disable-next-line security/detect-child-process -- fixed command, no shell
import { execFileSync } from "node:child_process";
import { flattenLicences } from "./lib.mjs";

/** @param {boolean} prodOnly */
export function listLicences(prodOnly) {
  const args = ["licenses", "list", "--json"];
  if (prodOnly) {
    args.push("--prod");
  }
  // eslint-disable-next-line security/detect-child-process -- fixed command, no shell
  const out = execFileSync("pnpm", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // pnpm prints a sentence instead of JSON when a selection has no packages.
  const json = out.trim().startsWith("{") ? JSON.parse(out) : {};
  return flattenLicences(json);
}
