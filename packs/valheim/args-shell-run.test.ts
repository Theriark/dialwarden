// Threat test T3b (security re-review THE-2605): the shell lint of the args
// file checked against a real shell instead of a second copy of its parser.
// The bash snippet of launchSnippets runs under sh and bash in a temporary
// folder, with a small script in place of the game that prints its
// arguments. A line the lint accepts must reach the game as the words the
// launch adapter reads, and must never run a command substitution.
import { launchWords } from "@dialwarden/formats";
import { launchSnippets, lintFile } from "@dialwarden/packs-schema";
// eslint-disable-next-line security/detect-child-process -- sh and bash, fixed programs, on test bytes
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadPack } from "../kit.js";

/* eslint-disable security/detect-non-literal-fs-filename -- a temporary test folder and this pack's fixtures */

const pack = loadPack("valheim");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ARGS_FILE = "dialwarden-args.txt";
const bytesOf = (line: string) => new TextEncoder().encode(line);

const dir = mkdtempSync(join(tmpdir(), "dw-args-shell-"));
const marker = join(dir, "marker");
writeFileSync(
  join(dir, "game.sh"),
  'for a in "$@"; do printf "%s\\n" "$a"; done\n',
);
const snippet = launchSnippets(ARGS_FILE, "sh ./game.sh").bash;
const shells = ["/bin/sh", "/bin/bash"].filter((shell) => existsSync(shell));
const runnable = process.platform !== "win32" && shells.length > 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether the pack lint lets the line be written to the args file. */
function accepted(line: string): boolean {
  const issues = lintFile(pack, "launch", bytesOf(line));
  return !issues.some((issue) => issue.severity === "error");
}

/** The arguments the game gets when the snippet runs the line. */
function run(shell: string, line: string): string[] {
  writeFileSync(join(dir, ARGS_FILE), line);
  // eslint-disable-next-line security/detect-child-process -- a fixed shell and the snippet under test
  const result = spawnSync(shell, ["-c", snippet], {
    cwd: dir,
    timeout: 5_000,
  });
  const out = new TextDecoder().decode(result.stdout);
  return out.split("\n").slice(0, -1);
}

/** A seeded generator, so a failure names the case that reproduces it. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  " ",
  "\t",
  "\r",
  "\n",
  "\f",
  "\v",
  "#",
  "# ",
  '"',
  "'",
  "\\",
  "$",
  "(",
  ")",
  "a",
  "-b",
  "2456",
];

/** A line that holds a command substitution somewhere in it. */
function generated(random: () => number): string {
  const pick = () => PIECES[Math.floor(random() * PIECES.length)] ?? "";
  const many = (n: number) =>
    Array.from({ length: Math.floor(random() * n) }, pick).join("");
  const payload = `$(touch ${marker})`;
  const wrap = random();
  let middle = payload;
  if (wrap < 0.3) middle = `#${payload}`;
  else if (wrap < 0.5) middle = `'${payload}'`;
  const bom = random() < 0.1 ? String.fromCharCode(0xfeff) : "";
  return `${bom}${many(7)}${middle}${many(5)}`;
}

describe.runIf(runnable)("the args file under a real shell", () => {
  it.each([
    '-name "Quarry Lane" -port 2456',
    "-name 'single $(x) quoted'",
    '-name "Quarry \\"Lane\\""',
    "-name Quarry -port 2456\n",
    "-name Quarry \\\n  -port 2456\n",
    "-name Quarry # note",
    "-name Quarry\n# note\n",
    "-name Quarry\t-port 2456",
    readFileSync(join(FIXTURES, ARGS_FILE), "utf8"),
  ])("hands the game the words the adapter reads: %j", (line) => {
    expect(accepted(line)).toBe(true);
    for (const shell of shells) {
      expect(run(shell, line)).toEqual(launchWords(bytesOf(line)));
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("runs no command substitution from any line the lint accepts", () => {
    const random = seeded(2605);
    let tried = 0;
    for (let i = 0; i < 1000; i++) {
      const line = generated(random);
      if (!accepted(line)) continue;
      tried += 1;
      for (const shell of shells) {
        run(shell, line);
        const label = `${shell} ${JSON.stringify(line)}`;
        expect(existsSync(marker), label).toBe(false);
      }
    }
    // The generator must reach the accepted side, or the test checks
    // nothing: comments and single quotes hide the payload legitimately.
    expect(tried).toBeGreaterThan(25);
  });
});
