// @ts-nocheck
// TEMPORARY diagnostic (THE-2121): prints what prettier --check would change in
// the files it reported, as line diffs in the CI log. Removed in the next commit.
import { readFileSync } from "node:fs";
import * as prettier from "prettier";
import { expect, it } from "vitest";

const FILES = [
  "apps/web/src/api/client.test.ts",
  "apps/web/src/components/layout/settings-layout.tsx",
  "apps/web/src/components/ui/badge.tsx",
  "apps/web/src/components/ui/button.tsx",
  "apps/web/src/components/ui/dialog.tsx",
  "apps/web/src/components/ui/field.tsx",
  "apps/web/src/pages/about.tsx",
  "apps/web/src/pages/settings/backup.test.tsx",
  "apps/web/src/pages/settings/backup.tsx",
  "apps/web/src/pages/settings/licence.tsx",
  "apps/web/src/pages/settings/profile.tsx",
];

function diff(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+${String(i + 1).padStart(4)}|${b[j]}`);
      j++;
    } else {
      out.push(`-${String(i + 1).padStart(4)}|${a[i]}`);
      i++;
    }
  }
  return out;
}

it("prints the prettier differences", async () => {
  const info = await prettier.getFileInfo(FILES[0]);
  const report = [`PRETTIER ${prettier.version} ${JSON.stringify(info)}`];
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    const options = (await prettier.resolveConfig(file)) ?? {};
    const formatted = await prettier.format(source, {
      ...options,
      filepath: file,
    });
    report.push(`=== ${file}`);
    report.push(...diff(source.split("\n"), formatted.split("\n")));
  }
  console.log(`PROBE-BEGIN\n${report.join("\n")}\nPROBE-END`);
  expect(report.length).toBeGreaterThan(0);
});
