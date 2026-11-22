// The app version: apps/server/package.json, next to src/ and dist/ (also in
// the image).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path in the package
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION = pkg.version;
