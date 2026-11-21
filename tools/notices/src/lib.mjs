// Pure helpers of the licence audit (licence:audit), the THIRD_PARTY_NOTICES
// generator (notices) and the outside-host asset check (check:assets). The CLI
// files next to this one do the file and process work.

/**
 * Flattens `pnpm licenses list --json` (pnpm 9 and 10) into one entry per
 * package version. Workspace packages (@dialwarden/*) are left out.
 * @param {Record<string, Array<Record<string, unknown>>>} report
 */
export function flattenLicences(report) {
  const out = [];
  for (const [group, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const name = String(entry.name ?? "");
      if (name === "" || name.startsWith("@dialwarden/")) {
        continue;
      }
      const licence = typeof entry.license === "string" ? entry.license : group;
      const versions = Array.isArray(entry.versions)
        ? entry.versions.map(String)
        : [String(entry.version ?? "")];
      const paths = Array.isArray(entry.paths)
        ? entry.paths.map(String)
        : [String(entry.path ?? "")];
      versions.forEach((version, index) => {
        out.push({
          name,
          version,
          licence,
          homepage: String(entry.homepage ?? ""),
          path: paths.at(index) ?? paths.at(0) ?? "",
        });
      });
    }
  }
  return out.sort(byNameAndVersion);
}

function byNameAndVersion(a, b) {
  return (
    a.name.localeCompare(b.name, "en") ||
    a.version.localeCompare(b.version, "en")
  );
}

/**
 * True when an SPDX expression is satisfied by the allow-list: OR needs one
 * allowed side, AND needs both, "X WITH exception" needs X. Anything that does
 * not parse is not allowed.
 * @param {string} expression
 * @param {Set<string>} allowed
 */
export function licenceAllowed(expression, allowed) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens.at(pos);
  const next = () => tokens.at(pos++);
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === "OR") {
      next();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (peek() === "AND") {
      next();
      const right = parseAtom();
      value = value && right;
    }
    return value;
  };
  const parseAtom = () => {
    const atom = next();
    if (atom === "(") {
      const value = parseOr();
      if (next() !== ")") {
        throw new Error("unbalanced parenthesis");
      }
      return value;
    }
    if (atom === undefined || ["OR", "AND", "WITH", ")"].includes(atom)) {
      throw new Error("unexpected end of expression");
    }
    if (peek() === "WITH") {
      next();
      if (next() === undefined) {
        throw new Error("WITH without an exception");
      }
    }
    return allowed.has(atom);
  };
  try {
    const result = parseOr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

/** Lines of one "## Title" section of a Markdown document. */
function section(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) {
    throw new Error(`section "## ${title}" not found`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/** SPDX ids of the "Allowed licences" list in docs/licences.md. */
export function parseAllowList(markdown) {
  const ids = new Set();
  for (const line of section(markdown, "Allowed licences")) {
    const match = /^- `([^`]+)`/.exec(line.trim());
    if (match) {
      ids.add(match[1]);
    }
  }
  if (ids.size === 0) {
    throw new Error("the allow-list in docs/licences.md is empty");
  }
  return ids;
}

const EXCEPTION_ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(dev|all)\s*\|/;

/** Rows of the "Reviewed exceptions" table: package, licence, scope dev or all. */
export function parseExceptions(markdown) {
  const rows = [];
  for (const line of section(markdown, "Reviewed exceptions")) {
    const match = EXCEPTION_ROW.exec(line.trim());
    if (match) {
      rows.push({ name: match[1], licence: match[2], scope: match[3] });
    }
  }
  return rows;
}

/**
 * Packages whose licence is not allowed and not covered by an exception. A
 * dev-scope exception does not cover a package that is also in production.
 */
export function auditLicences(all, prod, allowed, exceptions) {
  const inProd = new Set(prod.map((p) => `${p.name}@${p.version}`));
  const problems = [];
  for (const pkg of all) {
    if (licenceAllowed(pkg.licence, allowed)) {
      continue;
    }
    const id = `${pkg.name}@${pkg.version}`;
    const exception = exceptions.find(
      (e) => e.name === pkg.name && e.licence === pkg.licence,
    );
    if (exception === undefined) {
      problems.push(`${id}: licence "${pkg.licence}" is not on the allow-list`);
    } else if (exception.scope === "dev" && inProd.has(id)) {
      problems.push(`${id}: dev-only exception, but it ships in production`);
    }
  }
  return problems;
}

const OUTSIDE_URL = /^\s*(?:https?:\/\/|\/\/)/i;
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/gi;
// CSS, and HTML or SVG with style blocks and style attributes: any url().
const STYLE_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
// JavaScript with inlined CSS: only a lowercase url( that is not a call such as
// new URL( or x.url(, so script code gives no false positives. Quotes inside a
// JavaScript string may be escaped with a backslash.
const SCRIPT_URL = /(?<![\w$.])url\(\s*\\?(['"]?)([^'"\\)]*)\\?\1\s*\)/g;
const IMPORT = /@import\s+\\?(['"])([^'"\\]*)\\?\1/gi;

/**
 * Outside URLs in CSS url() and @import, and outside font hosts anywhere. kind
 * is "style" for .css, .html and .svg files, "script" for .js and .mjs files.
 */
export function findOutsideAssets(text, kind) {
  const found = [];
  for (const pattern of [kind === "script" ? SCRIPT_URL : STYLE_URL, IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      if (OUTSIDE_URL.test(match[2])) {
        found.push(match[2]);
      }
    }
  }
  for (const match of text.matchAll(FONT_HOSTS)) {
    found.push(match[0]);
  }
  return [...new Set(found)];
}

/** Text of THIRD_PARTY_NOTICES; licenceText(path) returns a licence file or "". */
export function renderNotices(packages, version, licenceText) {
  const parts = [
    `THIRD-PARTY NOTICES for Dialwarden ${version}`,
    "",
    "Dialwarden is source-available under FCL-1.0-MIT (LICENSE, LICENSING.md).",
    "It ships the third-party packages below, each under its own licence.",
    "This file is generated at build time from `pnpm licenses list --prod`.",
    "",
  ];
  for (const pkg of packages) {
    parts.push("-".repeat(78));
    parts.push(`${pkg.name} ${pkg.version}`);
    parts.push(`Licence: ${pkg.licence}`);
    if (pkg.homepage !== "") {
      parts.push(`Homepage: ${pkg.homepage}`);
    }
    const text = licenceText(pkg.path).trim();
    if (text !== "") {
      parts.push("", text);
    }
    parts.push("");
  }
  return `${parts.join("\n")}\n`;
}
