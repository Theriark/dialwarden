// pnpm run licence:audit: every installed package (runtime and development)
// must carry a licence on the SPDX allow-list of docs/licences.md, or a
// reviewed exception listed there.
import { readFileSync } from "node:fs";
import {
  auditLicences,
  licenceAllowed,
  parseAllowList,
  parseExceptions,
} from "./lib.mjs";
import { listLicences } from "./pnpm.mjs";

const policyFile = process.argv[2] ?? "docs/licences.md";
// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from the package script
const policy = readFileSync(policyFile, "utf8");
const allowed = parseAllowList(policy);
const exceptions = parseExceptions(policy);

const all = listLicences(false);
const prod = listLicences(true);
const problems = auditLicences(all, prod, allowed, exceptions);
const excepted = all.filter((p) => !licenceAllowed(p.licence, allowed));

console.log(
  `licence:audit: ${all.length} package versions (${prod.length} in production), ` +
    `${excepted.length - problems.length} covered by reviewed exceptions`,
);
for (const problem of problems) {
  console.error(`::error::${problem}`);
}
if (problems.length > 0) {
  console.error(
    `licence:audit: ${problems.length} problem(s). Replace the package or add a reviewed exception to ${policyFile}.`,
  );
  process.exit(1);
}
