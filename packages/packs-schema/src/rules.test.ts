import { describe, expect, it } from "vitest";
import { testPack } from "../test/kit.js";
import {
  checkLogic,
  checkRules,
  RULE_OPERATORS,
  ruleData,
  ruleFires,
  type RuleData,
} from "./rules.js";
import type { JsonValue, Rule } from "./types.js";

function rule(when: Rule["when"]): Rule {
  return {
    id: "probe",
    severity: "warning",
    message: "A rule used by the tests.",
    settings: ["Mode"],
    when,
  };
}

function modeAndPvp(mode: string, pvp: boolean): RuleData {
  const values = new Map<string, JsonValue>([
    ["Mode", mode],
    ["PvP", pvp],
  ]);
  return ruleData(values);
}

describe("JSONLogic allow-list", () => {
  it("accepts the operators a settings rule needs", () => {
    const logic = {
      if: [
        {
          and: [
            { "==": [{ var: "Mode" }, "Hardcore"] },
            { "!": { var: "PvP" } },
          ],
        },
        { cat: ["a", { substr: [{ var: "ServerName" }, 0, 3] }] },
        { missing_some: [1, ["Mode", "PvP"]] },
      ],
    };
    expect(checkLogic(logic)).toEqual({
      problems: [],
      keys: ["Mode", "PvP", "ServerName"],
    });
    expect(RULE_OPERATORS).not.toContain("method");
    expect(RULE_OPERATORS).not.toContain("log");
  });

  it("refuses operators outside the list, also deep inside", () => {
    for (const operator of ["method", "log", "map", "reduce", "eval"]) {
      const logic = { and: [true, { [operator]: [{ var: "Mode" }, "x"] }] };
      expect(checkLogic(logic).problems).toEqual([
        `operator ${operator} is not allowed`,
      ]);
    }
  });

  it("needs literal setting names in var and missing", () => {
    const computed = { var: { cat: ["Mo", "de"] } };
    expect(checkLogic(computed).problems).toContain(
      "var must name a setting as a literal string",
    );
    expect(checkLogic({ var: "" }).problems).toHaveLength(1);
    expect(checkLogic({ var: ["Mode", "Normal", "x"] }).problems).toEqual([
      "var takes a name and a default",
    ]);
    expect(checkLogic({ var: ["Mode", { var: "PvP" }] }).keys).toEqual([
      "Mode",
      "PvP",
    ]);
    expect(checkLogic({ missing: [] }).problems).toEqual([
      "missing needs a setting name",
    ]);
    expect(checkLogic({ missing: ["Mode", 3] }).problems).toEqual([
      "missing must name a setting as a literal string",
    ]);
    expect(checkLogic({ missing_some: ["1", ["Mode"]] }).problems).toEqual([
      "missing_some takes a count and a list of names",
    ]);
  });

  it("refuses a rule that is not one operation", () => {
    expect(checkLogic(true).problems).toEqual([
      "a rule must be a JSONLogic operation",
    ]);
    expect(checkLogic({ "==": [1, 1], "!=": [1, 2] }).problems).toEqual([
      "an object in the logic must hold exactly one operator",
    ]);
    expect(checkLogic({}).problems).toContain(
      "an object in the logic must hold exactly one operator",
    );
  });

  it("refuses logic that is nested too deeply", () => {
    let logic: JsonValue = { var: "Mode" };
    for (let i = 0; i < 40; i++) logic = { "!": [logic] };
    expect(checkLogic(logic).problems).toEqual([
      "the logic is too large or nested too deeply",
    ]);
  });

  it("checks that rules name settings of the pack", () => {
    expect(checkRules(testPack())).toEqual([]);
    const pack = testPack();
    const broken = {
      ...pack,
      rules: [
        ...pack.rules,
        { ...rule({ "==": [{ var: "Nope" }, 1] }), settings: ["Gone"] },
        rule({ method: [{ var: "Mode" }, "toString"] }),
        rule({ "!": { var: "PvP" } }),
      ],
    };
    expect(checkRules(broken)).toEqual([
      "rule probe: Nope is not a setting of the pack",
      "rule probe: Gone is not a setting of the pack",
      "rule probe is listed twice",
      "rule probe: operator method is not allowed",
      "rule probe is listed twice",
    ]);
  });
});

describe("rule evaluation", () => {
  it("nests dotted keys the way var reads them", () => {
    const values = new Map<string, JsonValue>([
      ["Options.ExpRate", 2],
      ["Options.DeathPenalty", "All"],
      ["Mode", "Casual"],
    ]);
    expect(ruleData(values)).toEqual({
      Options: { ExpRate: 2, DeathPenalty: "All" },
      Mode: "Casual",
    });
  });

  it("fires and clears with the values", () => {
    const pack = testPack();
    const hardcore = pack.rules.at(0);
    if (hardcore === undefined) throw new Error("no rule");
    expect(ruleFires(hardcore, modeAndPvp("Hardcore", false))).toBe(true);
    expect(ruleFires(hardcore, modeAndPvp("Hardcore", true))).toBe(false);
    expect(ruleFires(hardcore, modeAndPvp("Normal", false))).toBe(false);
  });

  it("never runs logic that fails the allow-list", () => {
    const bad = rule({ log: "hello" });
    expect(() => ruleFires(bad, {})).toThrow(
      "rule probe: operator log is not allowed",
    );
  });
});
