import { describe, expect, it } from "vitest";
import {
  auditLicences,
  findOutsideAssets,
  flattenLicences,
  licenceAllowed,
  parseAllowList,
  parseExceptions,
  renderNotices,
} from "./lib.mjs";

const allowed = new Set(["MIT", "Apache-2.0", "ISC"]);
const ok = (expression) => licenceAllowed(expression, allowed);

const policy = [
  "# Licences",
  "## Allowed licences",
  "- `MIT`",
  "- `Apache-2.0`",
  "## Reviewed exceptions",
  "| Package | Licence | Scope | Reason |",
  "| --- | --- | --- | --- |",
  "| `argparse` | `Python-2.0` | dev | linter only |",
  "## Other",
  "- `GPL-3.0-only`",
].join("\n");

const abc = {
  name: "abc",
  version: "1.0.0",
  licence: "ISC",
  homepage: "",
  path: "/n/abc",
};

describe("flattenLicences", () => {
  it("reads the pnpm 10 report and skips workspace packages", () => {
    const fastify = {
      name: "fastify",
      versions: ["5.4.0"],
      paths: ["/n/fastify"],
      license: "MIT",
      homepage: "https://fastify.dev",
    };
    const own = { name: "@dialwarden/entitlement", versions: ["27.0.0"] };
    const report = {
      MIT: [fastify, own],
      ISC: [{ name: "abc", version: "1.0.0", path: "/n/abc" }],
    };
    const flat = flattenLicences(report);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual(abc);
    expect(flat[1]).toEqual({
      name: "fastify",
      version: "5.4.0",
      licence: "MIT",
      homepage: "https://fastify.dev",
      path: "/n/fastify",
    });
  });
});

describe("licenceAllowed", () => {
  it("evaluates SPDX expressions", () => {
    expect(ok("MIT")).toBe(true);
    expect(ok("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(ok("MIT AND GPL-3.0-only")).toBe(false);
    expect(ok("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(ok("GPL-3.0-only")).toBe(false);
    expect(ok("Unknown")).toBe(false);
    expect(ok("(MIT")).toBe(false);
    expect(ok("")).toBe(false);
  });
});

describe("docs/licences.md policy", () => {
  it("reads the allow-list and the reviewed exceptions", () => {
    expect([...parseAllowList(policy)]).toEqual(["MIT", "Apache-2.0"]);
    expect(parseExceptions(policy)).toEqual([
      { name: "argparse", licence: "Python-2.0", scope: "dev" },
    ]);
  });

  it("accepts a dev-only exception only outside production", () => {
    const argparse = {
      name: "argparse",
      version: "2.0.1",
      licence: "Python-2.0",
    };
    const gpl = { name: "gpl", version: "1.0.0", licence: "GPL-3.0-only" };
    const exceptions = parseExceptions(policy);
    const audit = (all, prod) => auditLicences(all, prod, allowed, exceptions);
    expect(audit([argparse], [])).toEqual([]);
    expect(audit([argparse], [argparse])).toEqual([
      "argparse@2.0.1: dev-only exception, but it ships in production",
    ]);
    expect(audit([gpl], [])).toEqual([
      'gpl@1.0.0: licence "GPL-3.0-only" is not on the allow-list',
    ]);
  });
});

describe("findOutsideAssets", () => {
  it("finds outside hosts in CSS and outside font hosts anywhere", () => {
    const css = [
      "@import url('https://fonts.googleapis.com/css2?family=Inter');",
      '@import "//cdn.example.com/x.css";',
      "a{background:url(/assets/a.png)}",
      "b{background:url(data:image/png;base64,AAAA)}",
      'c{src:url("http://example.com/f.woff2")}',
    ].join("\n");
    expect(findOutsideAssets(css, "style")).toEqual([
      "https://fonts.googleapis.com/css2?family=Inter",
      "http://example.com/f.woff2",
      "//cdn.example.com/x.css",
      "fonts.googleapis.com",
    ]);
    const link = '<link href="https://fonts.gstatic.com/s/inter.woff2">';
    expect(findOutsideAssets(link, "style")).toEqual(["fonts.gstatic.com"]);
  });

  it("finds url() in HTML style blocks and attributes", () => {
    const html = [
      "<style>body{background:url(https://cdn.example.com/bg.png)}</style>",
      "<div style=\"background-image: url('//img.example.com/a.png')\"></div>",
      '<img src="/assets/logo.svg">',
    ].join("\n");
    expect(findOutsideAssets(html, "style")).toEqual([
      "https://cdn.example.com/bg.png",
      "//img.example.com/a.png",
    ]);
  });

  it("finds CSS inlined into JavaScript, not URL calls", () => {
    const js = [
      'const css = "a{background:url(https://cdn.example.com/a.png)}";',
      'const api = new URL("https://store.steampowered.com/app/1");',
      'const b = link.url("https://example.com/b");',
      'const c = "@import \\"https://cdn.example.com/c.css\\";";',
      'const d = "b{src:url(\\"//cdn.example.com/d.woff2\\")}";',
    ].join("\n");
    expect(findOutsideAssets(js, "script")).toEqual([
      "https://cdn.example.com/a.png",
      "//cdn.example.com/d.woff2",
      "https://cdn.example.com/c.css",
    ]);
  });
});

describe("renderNotices", () => {
  it("lists every package with its licence text", () => {
    const licenceText = (path) => (path === "/n/abc" ? "ISC text" : "");
    const text = renderNotices([abc], "27.0.0", licenceText);
    expect(text).toContain("THIRD-PARTY NOTICES for Dialwarden 27.0.0");
    expect(text).toContain("abc 1.0.0\nLicence: ISC\n\nISC text\n");
  });
});
