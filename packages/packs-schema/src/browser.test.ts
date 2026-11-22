// @vitest-environment jsdom
// Contract C3: validate(pack, values) gives the same issues in the browser as
// on the server. This file runs the package root under jsdom and compares
// with the golden list that validate.test.ts also checks under node, and it
// keeps Node built-ins and the node entry out of the root's import graph.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN_ISSUES, GOLDEN_VALUES, testPack } from "../test/kit.js";
import { validate } from "./index.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the package's own sources */

// Plain paths, not URL objects: jsdom puts its own URL class on globalThis.
const SOURCE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(SOURCE, "..", "..");

/** Workspace packages the root imports, by name. */
const WORKSPACE = new Map([["@dialwarden/formats", "formats/src/index.ts"]]);

/** Packages from npm the browser bundle may take in. */
const NPM = new Set(["json-logic-js", "jsonc-parser"]);

const SPECIFIER = /(?:from|import)\s*\(?\s*"([^"]+)"/g;

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
  return workspace === undefined ? undefined : join(PACKAGES, workspace);
}

/** Every module the package root reaches, with the names it imports. */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [join(SOURCE, "index.ts")];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (graph.has(file)) continue;
    const text = readFileSync(file, "utf8");
    const names = Array.from(text.matchAll(SPECIFIER), (m) => String(m[1]));
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
    expect(validate(testPack(), GOLDEN_VALUES)).toEqual(GOLDEN_ISSUES);
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
