// pnpm packs:check (dev-work-plan P3-A step 3), part of pnpm test: every pack
// folder holds a pack.json that passes the schema and reference checks, every
// setting locator resolves on its synthetic fixture, and every default equals
// the fixture value where the fixture sets one.
import { fileURLToPath } from "node:url";
import { checkPacksFolder } from "@dialwarden/packs-schema/node";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("./", import.meta.url));

describe("packs folder", () => {
  it("passes pnpm packs:check", () => {
    const failed = checkPacksFolder(root).filter(
      (report) => report.problems.length > 0,
    );
    expect(failed).toEqual([]);
  });
});
