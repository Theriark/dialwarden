// @ts-nocheck
// TEMPORARY diagnostic (THE-2121): prints what prettier --check would change in
// the files of this review round, as line diffs in the CI log. Removed in the
// next commit.
import { readFileSync } from "node:fs";
import * as prettier from "prettier";
import { expect, it } from "vitest";

const FILES = [
  "apps/server/src/http/contract.test.ts",
  "apps/web/src/api/client.test.ts",
  "apps/web/src/api/errors.ts",
  "apps/web/src/api/session.test.ts",
  "apps/web/src/api/session.ts",
  "apps/web/src/api/upload.ts",
  "apps/web/src/app.tsx",
  "apps/web/src/components/layout/app-shell.test.tsx",
  "apps/web/src/components/layout/app-shell.tsx",
  "apps/web/src/components/upgrade-hint.test.tsx",
  "apps/web/src/components/upgrade-hint.tsx",
  "apps/web/src/lib/format.test.ts",
  "apps/web/src/lib/passphrase.test.ts",
  "apps/web/src/lib/passphrase.ts",
  "apps/web/src/pages/about.test.tsx",
  "apps/web/src/pages/login-2fa.test.tsx",
  "apps/web/src/pages/login-2fa.tsx",
  "apps/web/src/pages/settings/backup.test.tsx",
  "apps/web/src/pages/settings/backup.tsx",
  "apps/web/src/pages/settings/licence.test.tsx",
  "apps/web/src/pages/settings/licence.tsx",
  "apps/web/src/pages/settings/profile.test.tsx",
  "apps/web/src/pages/settings/profile.tsx",
  "apps/web/src/pages/setup.test.tsx",
  "apps/web/src/pages/setup.tsx",
  "apps/web/src/router.test.tsx",
  "apps/web/src/test/fixtures.ts",
  "apps/web/src/test/render.tsx",
  "apps/web/src/test/start.tsx",
  "apps/web/src/theme/theme.test.ts",
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
    if (formatted !== source) {
      report.push(`=== ${file}`);
      report.push(...diff(source.split("\n"), formatted.split("\n")));
    }
  }
  console.log(`PROBE-BEGIN\n${report.join("\n")}\nPROBE-END`);
  expect(report.length).toBeGreaterThan(0);
});
