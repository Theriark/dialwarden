// @vitest-environment jsdom
// Contract C3: validate(pack, values) gives the same issues in the browser as
// on the server for every rule not marked serverEvaluated, and the browser
// call skips the marked ones. This file runs the package root under jsdom and
// compares with the golden lists that validate.test.ts also checks under
// node, and it keeps Node built-ins and the node entry out of the root's
// import graph. Under jsdom import.meta.url is no file URL, so files are
// found from the path of this test file instead.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_BROWSER_ISSUES,
  GOLDEN_ISSUES,
  GOLDEN_VALUES,
  goldenPack,
} from "../test/golden.js";
import { type Pack, SECRET_MASK, validate } from "./index.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the package's own sources */

/** Workspace packages the root imports, by name. */
const WORKSPACE = new Map([["@dialwarden/formats", "formats/src/index.ts"]]);

/** Packages from npm the browser bundle may take in. */
const NPM = new Set(["json-logic-js", "jsonc-parser"]);

/** An import or export with from, or an import for its side effects. */
const FROM = /^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gm;
const BARE_IMPORT = /^import\s*"([^"]+)"/gm;

/** packages/packs-schema/src, the folder of this test file. */
function sourceDir(): string {
  const path = expect.getState().testPath;
  if (path === undefined) throw new Error("no test path");
  return dirname(path);
}

/** The synthetic test pack. */
function testPack(): Pack {
  const file = join(sourceDir(), "../test/packs/testpack/pack.json");
  return JSON.parse(readFileSync(file, "utf8")) as Pack;
}

/** A relative import, a workspace package or an allowed npm package. */
function isKnown(name: string): boolean {
  return name.startsWith(".") || WORKSPACE.has(name) || NPM.has(name);
}

/** The source file an import names, or undefined for an npm package. */
function resolve(name: string, from: string): string | undefined {
  if (name.startsWith(".")) {
    return join(dirname(from), name.replace(/\.js$/, ".ts"));
  }
  const workspace = WORKSPACE.get(name);
  if (workspace === undefined) return undefined;
  return join(sourceDir(), "..", "..", workspace);
}

/** Every module the package root reaches, with the names it imports. */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [join(sourceDir(), "index.ts")];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (graph.has(file)) continue;
    const text = readFileSync(file, "utf8");
    const found = [...text.matchAll(FROM), ...text.matchAll(BARE_IMPORT)];
    const names = found.map((m) => String(m[1]));
    graph.set(file, names);
    for (const name of names) {
      const next = resolve(name, file);
      if (next !== undefined) queue.push(next);
    }
  }
  return graph;
}

describe("packs-schema in the browser (jsdom)", () => {
  it("runs with browser globals", () => {
    expect("window" in globalThis).toBe(true);
    expect("document" in globalThis).toBe(true);
  });

  it("gives the same issues as on the server", () => {
    expect(validate(goldenPack(testPack()), GOLDEN_VALUES)).toEqual(
      GOLDEN_ISSUES,
    );
  });

  it("skips server-evaluated rules in the browser call", () => {
    const pack = goldenPack(testPack());
    const browser = { includeServerEvaluated: false };
    expect(validate(pack, GOLDEN_VALUES, browser)).toEqual(
      GOLDEN_BROWSER_ISSUES,
    );
    // The browser holds the masked secret; the answer does not change.
    const masked = { ...GOLDEN_VALUES, AdminPassword: SECRET_MASK };
    expect(validate(pack, masked, browser)).toEqual(GOLDEN_BROWSER_ISSUES);
  });

  it("reaches no Node built-in and not the node entry", () => {
    const graph = importGraph();
    const files = [...graph.keys()];
    const reached = (end: string) => files.some((file) => file.endsWith(end));
    expect(reached("/packs-schema/src/validate.ts")).toBe(true);
    expect(reached("/formats/src/lua.ts")).toBe(true);
    expect(reached("/packs-schema/src/node.ts")).toBe(false);
    const names = [...graph.values()].flat();
    expect(names.filter((name) => !isKnown(name))).toEqual([]);
  });
});
