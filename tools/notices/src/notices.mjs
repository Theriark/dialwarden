// pnpm run notices: writes THIRD_PARTY_NOTICES for the production packages
// (Dockerfile build stage). Sorted and without timestamps, so a rebuild of the
// same commit writes the same file.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderNotices } from "./lib.mjs";
import { listLicences } from "./pnpm.mjs";

const target = process.argv[2] ?? "THIRD_PARTY_NOTICES";
const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:\.[a-z]+|)$/i;

function licenceText(dir) {
  if (dir === "") {
    return "";
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- package folder reported by pnpm
    const file = readdirSync(dir).find((name) => LICENCE_FILE.test(name));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file found above
    return file === undefined ? "" : readFileSync(join(dir, file), "utf8");
  } catch {
    return "";
  }
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- root package.json
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const packages = listLicences(true);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from the package script
writeFileSync(target, renderNotices(packages, version, licenceText));
console.log(`notices: ${packages.length} production packages in ${target}`);
