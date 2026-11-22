// JSONLogic rules (contract C3) with an operator allow-list. json-logic-js
// interprets the logic and never evaluates code, but it also has "log" and
// "method" and lets any caller add operators. A pack may use only the
// operators below; every var and missing names a setting of the pack as a
// literal string, so a rule can read nothing but setting values. A rule that
// reads a secret beyond an emptiness test runs on the server only.
import jsonLogic, { type RulesLogic } from "json-logic-js";
import type { JsonValue, Pack, Rule } from "./types.js";

export const RULE_OPERATORS = [
  "var",
  "missing",
  "missing_some",
  "if",
  "?:",
  "==",
  "===",
  "!=",
  "!==",
  "!",
  "!!",
  "or",
  "and",
  ">",
  ">=",
  "<",
  "<=",
  "max",
  "min",
  "+",
  "-",
  "*",
  "/",
  "%",
  "in",
  "cat",
  "substr",
] as const;

const ALLOWED = new Set<string>(RULE_OPERATORS);
const MAX_DEPTH = 32;
const MAX_NODES = 2000;

export interface LogicCheck {
  /** What is wrong with the logic; empty when it may run. */
  readonly problems: readonly string[];
  /** The setting keys the logic reads. */
  readonly keys: readonly string[];
}

/** Checks a JSONLogic expression against the allow-list. */
export function checkLogic(logic: unknown): LogicCheck {
  const problems = new Set<string>();
  const keys = new Set<string>();
  let nodes = 0;

  const name = (value: unknown, operator: string): void => {
    if (typeof value === "string" && value !== "") {
      keys.add(value);
    } else {
      problems.add(`${operator} must name a setting as a literal string`);
    }
  };

  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      problems.add("the logic is too large or nested too deeply");
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node as unknown[]) visit(item, depth + 1);
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    const entries = Object.entries(node);
    const first = entries.at(0);
    if (first === undefined || entries.length !== 1) {
      problems.add("an object in the logic must hold exactly one operator");
      return;
    }
    const [operator, args] = first;
    if (!ALLOWED.has(operator)) {
      problems.add(`operator ${operator} is not allowed`);
      return;
    }
    const list: unknown[] = Array.isArray(args) ? args : [args];
    if (operator === "var") {
      name(list.at(0), operator);
      if (list.length > 2) problems.add("var takes a name and a default");
      if (list.length === 2) visit(list.at(1), depth + 1);
    } else if (operator === "missing") {
      if (list.length === 0) problems.add("missing needs a setting name");
      for (const item of list) name(item, operator);
    } else if (operator === "missing_some") {
      const options = list.at(1);
      if (typeof list.at(0) !== "number" || !Array.isArray(options)) {
        problems.add("missing_some takes a count and a list of names");
        return;
      }
      for (const item of options as unknown[]) name(item, operator);
    } else {
      visit(args, depth + 1);
    }
  };

  visit(logic, 0);
  if (logic === null || typeof logic !== "object" || Array.isArray(logic)) {
    problems.add("a rule must be a JSONLogic operation");
  }
  return { problems: [...problems], keys: [...keys] };
}

/** The comparisons a secret may take part in, against the literal "". */
const EMPTINESS_TESTS = new Set(["==", "===", "!=", "!=="]);

/** The name a plain var reads ({ var: "K" } or { var: ["K"] }), if any. */
function plainVarName(node: unknown): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return undefined;
  }
  const entries = Object.entries(node);
  const first = entries.at(0);
  if (first === undefined || entries.length !== 1 || first[0] !== "var") {
    return undefined;
  }
  const args: unknown = first[1];
  const list: unknown[] = Array.isArray(args) ? args : [args];
  const name = list.at(0);
  return list.length === 1 && typeof name === "string" ? name : undefined;
}

/** True for a secret compared with "", as in { "==": [{ var: S }, ""] }. */
function isEmptinessTest(node: object, secrets: ReadonlySet<string>): boolean {
  const entries = Object.entries(node);
  const first = entries.at(0);
  if (first === undefined || entries.length !== 1) return false;
  const [operator, args] = first;
  if (!EMPTINESS_TESTS.has(operator) || !Array.isArray(args)) return false;
  const list = args as unknown[];
  if (list.length !== 2) return false;
  const [a, b] = list;
  let name: string | undefined;
  if (a === "") name = plainVarName(b);
  else if (b === "") name = plainVarName(a);
  return name !== undefined && secrets.has(name);
}

/**
 * The secret settings a JSONLogic expression reads beyond an emptiness or
 * presence test (THE-2361). The masked browser view keeps only whether a
 * secret is empty, so a secret may be compared with the literal "" (==, !=,
 * === and !==) or named in missing and missing_some; any other read (in,
 * substr, cat, a comparison with another value, arithmetic, truthiness or a
 * var default) gives the browser a different answer than the server.
 */
export function secretReads(
  logic: unknown,
  secrets: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node as unknown[]) visit(item, depth + 1);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (isEmptinessTest(node, secrets)) return;
    for (const [operator, args] of Object.entries(node)) {
      if (operator === "missing" || operator === "missing_some") continue;
      if (operator !== "var") {
        visit(args, depth + 1);
        continue;
      }
      const list: unknown[] = Array.isArray(args) ? args : [args];
      const name = list.at(0);
      if (typeof name === "string" && secrets.has(name)) found.add(name);
      visit(list.slice(1), depth + 1);
    }
  };
  visit(logic, 0);
  return [...found];
}

/**
 * Problems of the rules of a pack: operators outside the allow-list, names
 * that are not settings of the pack, duplicate rule ids, and secrets read
 * beyond an emptiness or presence test by a rule not marked serverEvaluated.
 */
export function checkRules(pack: Pack): string[] {
  const known = new Set(pack.settings.map((setting) => setting.key));
  const secrets = new Set(
    pack.settings.filter((s) => s.secret === true).map((s) => s.key),
  );
  const ids = new Set<string>();
  const problems: string[] = [];
  for (const rule of pack.rules) {
    if (ids.has(rule.id)) problems.push(`rule ${rule.id} is listed twice`);
    ids.add(rule.id);
    const check = checkLogic(rule.when);
    for (const problem of check.problems) {
      problems.push(`rule ${rule.id}: ${problem}`);
    }
    for (const key of [...check.keys, ...rule.settings]) {
      if (!known.has(key)) {
        problems.push(`rule ${rule.id}: ${key} is not a setting of the pack`);
      }
    }
    if (rule.serverEvaluated === true) continue;
    for (const key of secretReads(rule.when, secrets)) {
      problems.push(
        `rule ${rule.id}: reads the secret ${key} beyond an emptiness or presence test, so it must be marked serverEvaluated`,
      );
    }
  }
  return problems;
}

/** Setting values as a rule reads them (see ruleData). */
export interface RuleData {
  readonly [key: string]: JsonValue;
}

type Tree = Map<string, Tree | JsonValue>;

function toObject(tree: Tree): RuleData {
  return Object.fromEntries(
    [...tree].map(([key, value]) => [
      key,
      value instanceof Map ? toObject(value) : value,
    ]),
  );
}

/**
 * The data a rule reads: the values by setting key, nested at the dots of a
 * key, because JSONLogic's var reads a.b as the field b of a. The pack check
 * refuses a key that is also the start of another key (a and a.b).
 */
export function ruleData(values: ReadonlyMap<string, JsonValue>): RuleData {
  const root: Tree = new Map();
  for (const [key, value] of values) {
    const parts = key.split(".");
    const last = parts.pop() ?? key;
    let node = root;
    for (const part of parts) {
      const next = node.get(part);
      if (next instanceof Map) {
        node = next;
      } else {
        const created: Tree = new Map();
        node.set(part, created);
        node = created;
      }
    }
    node.set(last, value);
  }
  return toObject(root);
}

/**
 * True when the rule fires for the data. A rule whose logic fails the
 * allow-list never runs: it throws, so a broken pack cannot pass silently.
 */
export function ruleFires(rule: Rule, data: RuleData): boolean {
  const check = checkLogic(rule.when);
  if (check.problems.length > 0) {
    throw new Error(`rule ${rule.id}: ${check.problems.join("; ")}`);
  }
  const logic = rule.when as unknown as RulesLogic;
  return jsonLogic.truthy(jsonLogic.apply(logic, data));
}
