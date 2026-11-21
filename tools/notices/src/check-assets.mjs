// pnpm run check:assets (after the web build): fails when the built web app
// references an outside host in CSS url() or @import, or an outside font host
// anywhere. Fonts are self-hosted (CSP font-src 'self', brand rules).
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { findOutsideAssets } from "./lib.mjs";

const dist = process.argv[2] ?? "apps/web/dist";
const CHECKED = new Set([".css", ".html", ".js", ".mjs", ".svg"]);

function files(dir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- build output folder
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

let all;
try {
  all = files(dist);
} catch {
  console.error(
    `::error::check:assets: ${dist} does not exist; run the build first`,
  );
  process.exit(1);
}
let problems = 0;
for (const file of all.filter((f) => CHECKED.has(extname(f)))) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- listed above
  const text = readFileSync(file, "utf8");
  for (const url of findOutsideAssets(text, extname(file) === ".css")) {
    console.error(`::error::${relative(".", file)} references outside ${url}`);
    problems += 1;
  }
}
console.log(
  `check:assets: ${all.length} files in ${dist}, ${problems} outside references`,
);
process.exit(problems === 0 ? 0 : 1);
