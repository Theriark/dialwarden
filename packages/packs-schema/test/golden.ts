// Values of the synthetic test pack and the issues validate gives for them,
// written out once: validate.test.ts (node) and browser.test.ts (jsdom) both
// compare with these lists, so the two give the same result. No Node import
// and no import.meta.url here: the jsdom test loads this file too.
import type { JsonValue, Pack, Rule, ValidationIssue } from "../src/types.js";

export const GOLDEN_VALUES: { readonly [key: string]: JsonValue } = {
  Unknown: true,
  MaxPlayers: 0,
  Difficulty: 1.25,
  Mode: "Hardcore",
  StartParameters: "-port=${port} -log; reboot",
  "Options.ExpRate": 12,
  AdminPassword: "Test",
};

const HARDCORE = "Hardcore mode is meant to be played with player combat on.";

const PASSWORD_IN_NAME =
  "The admin password appears in the server name, which every player can read.";

/**
 * A rule that reads the secret admin password beyond an emptiness test, so
 * it runs on the server only (THE-2361).
 */
export const GOLDEN_SERVER_RULE: Rule = {
  id: "password-in-server-name",
  severity: "warning",
  message: PASSWORD_IN_NAME,
  settings: ["AdminPassword", "ServerName"],
  serverEvaluated: true,
  when: {
    and: [
      { "!=": [{ var: "AdminPassword" }, ""] },
      { in: [{ var: "AdminPassword" }, { var: "ServerName" }] },
    ],
  },
};

/** The test pack with the server-evaluated rule added. */
export function goldenPack(pack: Pack): Pack {
  return { ...pack, rules: [...pack.rules, GOLDEN_SERVER_RULE] };
}

/** The issues of the browser call, which skips the server-evaluated rule. */
export const GOLDEN_BROWSER_ISSUES: readonly ValidationIssue[] = [
  { key: "Unknown", severity: "error", message: "Unknown setting." },
  { key: "MaxPlayers", severity: "error", message: "Must be at least 1." },
  {
    key: "Difficulty",
    severity: "error",
    message: "Must be a multiple of 0.5.",
  },
  {
    key: "StartParameters",
    severity: "error",
    message:
      "Must not contain ; & | ` ( ) < > \\, a line break or a $ other than a plain $NAME or ${NAME} reference: the server start script passes this value to a shell.",
  },
  { key: "Mode", severity: "warning", message: HARDCORE },
  { key: "PvP", severity: "warning", message: HARDCORE },
  {
    key: "Options.ExpRate",
    severity: "warning",
    message: "An experience rate above 10 skips most of the synthetic game.",
  },
];

/** The issues of the server call: every rule, the marked one included. */
export const GOLDEN_ISSUES: readonly ValidationIssue[] = [
  ...GOLDEN_BROWSER_ISSUES,
  { key: "AdminPassword", severity: "warning", message: PASSWORD_IN_NAME },
  { key: "ServerName", severity: "warning", message: PASSWORD_IN_NAME },
];
