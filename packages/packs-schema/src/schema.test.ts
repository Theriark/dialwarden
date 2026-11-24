import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingOf, testPack, withSetting } from "../test/kit.js";
import { schemaProblems } from "./schema.js";

/** A copy of an object without one key. */
function without(value: object, key: string): object {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

function problemsOf(data: unknown): string {
  return schemaProblems(data).join("\n");
}

describe("pack.json schema (contract C3)", () => {
  it("accepts the synthetic test pack", () => {
    expect(schemaProblems(testPack())).toEqual([]);
  });

  it("bounds the commands, path, host and port of a probe", () => {
    const probe = (fields: object) => ({
      ...testPack(),
      probes: [{ kind: "sourceRcon", ...fields }],
    });
    expect(
      schemaProblems(probe({ allow: ["sav"], saveCommand: "sav" })),
    ).toEqual([]);
    for (const bad of [
      { allow: ["sav\nquit"] },
      { allow: [""] },
      { allow: ["x".repeat(129)] },
      { saveCommand: "sav\rquit" },
      { infoPath: "/v1/api/info?x=1" },
      { infoPath: "v1/api/info" },
      { host: "evil.example/x" },
      { port: 70_000 },
    ]) {
      expect(schemaProblems(probe(bad))).not.toEqual([]);
    }
  });

  it("refuses data that is not a pack object", () => {
    expect(schemaProblems(null)).not.toEqual([]);
    expect(schemaProblems("pack")).not.toEqual([]);
    expect(schemaProblems([])).not.toEqual([]);
  });

  it("names a missing field and an unknown field", () => {
    const missing = problemsOf(without(testPack(), "sources"));
    expect(missing).toContain("must have required property 'sources'");
    const extra = problemsOf({ ...testPack(), official: true });
    expect(extra).toContain("must NOT have additional properties (official)");
  });

  it("requires sources and checks that they are web addresses", () => {
    expect(problemsOf({ ...testPack(), sources: [] })).toContain(
      "/sources: must NOT have fewer than 1 items",
    );
    const ftp = problemsOf({ ...testPack(), sources: ["ftp://example.com"] });
    expect(ftp).toContain("/sources/0: must match pattern");
  });

  it("keeps descriptions between 20 and 300 characters", () => {
    const short = withSetting(testPack(), "MaxPlayers", {
      description: "Too short to help.",
    });
    expect(problemsOf(short)).toContain("/settings/0/description");
    expect(problemsOf(short)).toContain("fewer than 20 characters");
    const long = withSetting(testPack(), "MaxPlayers", {
      description: "x".repeat(301),
    });
    expect(problemsOf(long)).toContain("more than 300 characters");
    const exact = withSetting(testPack(), "MaxPlayers", {
      description: "y".repeat(300),
    });
    expect(schemaProblems(exact)).toEqual([]);
  });

  it("checks pack ids, setting types and locator kinds", () => {
    expect(problemsOf({ ...testPack(), id: "Test Pack" })).toContain(
      "/id: must match pattern",
    );
    const pack = testPack();
    const mode = settingOf(pack, "Mode");
    const noChoices = without(mode, "enum");
    expect(problemsOf({ ...pack, settings: [noChoices] })).toContain(
      "/settings/0: must have required property 'enum'",
    );
    const badType = { ...mode, type: "colour" };
    expect(problemsOf({ ...pack, settings: [badType] })).toContain(
      "/settings/0/type: must be equal to one of the allowed values",
    );
    const badKind = { ...mode, locator: { kind: "registry", key: "Mode" } };
    expect(problemsOf({ ...pack, settings: [badKind] })).toContain(
      'value of tag "kind" must be in oneOf',
    );
    const extraField = {
      ...mode,
      locator: { kind: "ini", section: null, key: "Mode", field: "x" },
    };
    expect(problemsOf({ ...pack, settings: [extraField] })).toContain(
      "/settings/0/locator: must NOT have additional properties (field)",
    );
  });

  it("allows item choices on list settings only", () => {
    const pack = testPack();
    const itemEnum = [{ value: "Steam", label: "Steam" }];
    const list = withSetting(pack, "ServerName", {
      type: "list",
      default: ["Steam"],
      itemEnum,
    });
    expect(schemaProblems(list)).toEqual([]);
    const text = withSetting(pack, "ServerName", { itemEnum });
    expect(problemsOf(text)).toContain(
      "/settings/4/type: must be equal to constant",
    );
    const empty = withSetting(pack, "ServerName", {
      type: "list",
      default: [],
      itemEnum: [],
    });
    expect(problemsOf(empty)).toContain(
      "/settings/4/itemEnum: must NOT have fewer than 1 items",
    );
    const unlabelled = withSetting(pack, "ServerName", {
      type: "list",
      default: [],
      itemEnum: [{ value: "Steam" } as never],
    });
    expect(problemsOf(unlabelled)).toContain(
      "/settings/4/itemEnum/0: must have required property 'label'",
    );
  });

  it("takes serverEvaluated on a rule as a boolean only", () => {
    const pack = testPack();
    const [first, ...rest] = pack.rules;
    if (first === undefined) throw new Error("no rule");
    const marked = { ...first, serverEvaluated: true };
    expect(schemaProblems({ ...pack, rules: [marked, ...rest] })).toEqual([]);
    const text = { ...first, serverEvaluated: "yes" };
    expect(problemsOf({ ...pack, rules: [text, ...rest] })).toContain(
      "/rules/0/serverEvaluated: must be boolean",
    );
  });

  it("refuses paths that start at the root or use backslashes", () => {
    const pack = testPack();
    const files = pack.files.map((file) => ({
      ...file,
      paths: { linux: ["/etc/passwd"], windows: ["C:\\Games\\Game.ini"] },
    }));
    const text = problemsOf({ ...pack, files });
    expect(text).toContain("/files/0/paths/linux/0: must match pattern");
    expect(text).toContain("/files/0/paths/windows/0: must match pattern");
  });

  it("is generated code with no Ajv, eval or Function at run time", () => {
    const file = new URL("./generated/validate-pack.ts", import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the generated module of this package
    const code = readFileSync(file, "utf8");
    expect(code).toContain("export default");
    expect(code).not.toMatch(/\brequire\(|\beval\(|new Function|from "ajv/);
  });
});
