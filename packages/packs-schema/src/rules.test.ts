import { describe, expect, it } from "vitest";
import { testPack } from "../test/kit.js";
import {
  checkLogic,
  checkRules,
  RULE_OPERATORS,
  ruleData,
  ruleFires,
  secretReads,
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
    // json-logic-js evaluates a third argument too, so it must not get past.
    const extra = { missing_some: [1, ["Mode"], { log: { var: "Mode" } }] };
    expect(checkLogic(extra).problems).toEqual([
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

describe("rules that read secrets (THE-2361)", () => {
  const secrets = new Set(["AdminPassword", "JoinPassword"]);
  const admin = { var: "AdminPassword" };

  it("lets a secret be compared with the empty text or tested for presence", () => {
    const allowed: JsonValue[] = [
      { "==": [admin, ""] },
      { "===": ["", admin] },
      { "!=": [{ var: ["AdminPassword"] }, ""] },
      { "!==": [admin, ""] },
      { missing: ["AdminPassword"] },
      { missing_some: [1, ["AdminPassword", "JoinPassword"]] },
      { and: [{ "==": [admin, ""] }, { "==": [{ var: "Mode" }, "Hard"] }] },
      { in: ['"', { var: "ServerName" }] },
    ];
    for (const logic of allowed) {
      expect(secretReads(logic, secrets), JSON.stringify(logic)).toEqual([]);
    }
  });

  it("finds every other use of a secret value", () => {
    const refused: JsonValue[] = [
      { in: ['"', admin] },
      { substr: [admin, 0, 1] },
      { cat: [admin, "x"] },
      { "==": [admin, { var: "JoinPassword" }] },
      { "==": [admin, "hunter2"] },
      { "==": [admin, 0] },
      { "==": [admin, "", "extra"] },
      { "+": [admin, 1] },
      { "!": [admin] },
      { "!!": [admin] },
      { or: [admin, false] },
      { if: [admin, 1, 2] },
      { "==": [{ var: ["AdminPassword", "fallback"] }, ""] },
      { var: ["Mode", { var: "AdminPassword" }] },
      { "==": [{ cat: [admin] }, ""] },
    ];
    for (const logic of refused) {
      const found = secretReads(logic, secrets);
      expect(found, JSON.stringify(logic)).toContain("AdminPassword");
    }
    const both = { "!=": [admin, { var: "JoinPassword" }] };
    expect(secretReads(both, secrets)).toEqual([
      "AdminPassword",
      "JoinPassword",
    ]);
    expect(secretReads({ "!": [admin] }, new Set())).toEqual([]);
  });

  it("finds a var default at the depth limit and fails closed past it", () => {
    // 31 levels put the var at depth 31 and its default at 32, the deepest
    // node checkLogic still accepts.
    let atLimit: JsonValue = { var: ["Mode", admin] };
    for (let i = 0; i < 31; i++) atLimit = { "!": atLimit };
    expect(checkLogic(atLimit).problems).toEqual([]);
    expect(secretReads(atLimit, secrets)).toEqual(["AdminPassword"]);

    let tooDeep: JsonValue = { var: "Mode" };
    for (let i = 0; i < 40; i++) tooDeep = { "!": tooDeep };
    expect(secretReads(tooDeep, secrets)).toEqual([
      "AdminPassword",
      "JoinPassword",
    ]);
  });

  it("refuses a missing_some that hides a read in a third argument", () => {
    const pack = testPack();
    const hidden: Rule = {
      id: "hidden-log",
      severity: "warning",
      message: "A rule that tries to log a secret.",
      settings: ["ServerName"],
      when: {
        missing_some: [1, ["ServerName"], { log: { var: "AdminPassword" } }],
      },
    };
    expect(checkRules({ ...pack, rules: [hidden] })).toEqual([
      "rule hidden-log: missing_some takes a count and a list of names",
    ]);
  });

  it("refuses such a rule unless it is marked serverEvaluated", () => {
    const pack = testPack();
    const reads: Rule = {
      id: "password-in-name",
      severity: "warning",
      message: "The admin password is part of the server name.",
      settings: ["AdminPassword"],
      when: { in: [{ var: "AdminPassword" }, { var: "ServerName" }] },
    };
    const empty: Rule = {
      ...reads,
      id: "no-password",
      when: { "==": [{ var: "AdminPassword" }, ""] },
    };
    expect(checkRules({ ...pack, rules: [reads, empty] })).toEqual([
      "rule password-in-name: reads the secret AdminPassword beyond an emptiness or presence test, so it must be marked serverEvaluated",
    ]);
    const marked = { ...reads, serverEvaluated: true };
    expect(checkRules({ ...pack, rules: [marked, empty] })).toEqual([]);
    const unmarked = { ...reads, serverEvaluated: false };
    expect(checkRules({ ...pack, rules: [unmarked] })).toHaveLength(1);
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

describe("strlen operator (P6)", () => {
  it("measures the length of a setting's text", () => {
    const logic = { "<": [{ strlen: { var: "ServerName" } }, 5] };
    expect(checkLogic(logic)).toEqual({ problems: [], keys: ["ServerName"] });
    const short = ruleData(
      new Map<string, JsonValue>([["ServerName", "tiny"]]),
    );
    const long = ruleData(
      new Map<string, JsonValue>([["ServerName", "a longer name"]]),
    );
    expect(ruleFires(rule(logic), short)).toBe(true);
    expect(ruleFires(rule(logic), long)).toBe(false);
  });

  it("measures nothing but text", () => {
    const logic = { "==": [{ strlen: { var: "PvP" } }, 0] };
    const values = ruleData(new Map<string, JsonValue>([["PvP", true]]));
    expect(ruleFires(rule(logic), values)).toBe(true);
  });
});
