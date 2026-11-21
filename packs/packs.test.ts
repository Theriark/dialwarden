import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("./", import.meta.url);
const skip = new Set(["node_modules"]);

describe("packs folder", () => {
  it("holds a pack.json in every pack folder", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this folder
    const entries = readdirSync(root, { withFileTypes: true });
    const missing: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) {
        continue;
      }
      const pack = new URL(`${entry.name}/pack.json`, root);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- listed above
      if (!existsSync(pack)) {
        missing.push(entry.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
