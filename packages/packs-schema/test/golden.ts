// Values of the synthetic test pack and the issues validate gives for them,
// written out once: validate.test.ts (node) and browser.test.ts (jsdom) both
// compare with this list, so the two give the same result. No Node import
// and no import.meta.url here: the jsdom test loads this file too.
import type { JsonValue, ValidationIssue } from "../src/types.js";

export const GOLDEN_VALUES: { readonly [key: string]: JsonValue } = {
  Unknown: true,
  MaxPlayers: 0,
  Difficulty: 1.25,
  Mode: "Hardcore",
  StartParameters: "-port=${port} -log; reboot",
  "Options.ExpRate": 12,
};

const HARDCORE = "Hardcore mode is meant to be played with player combat on.";

export const GOLDEN_ISSUES: readonly ValidationIssue[] = [
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
