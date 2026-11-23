// Splits a unified diff of contract C5 text[] back into its two sides, so the
// save dialog can show the diff with the Monaco diff editor. Hunk headers
// carry line numbers but the sides are rebuilt without them: only the changed
// lines matter, and the server guarantees the hunks follow file order.
export interface DiffSides {
  readonly before: string;
  readonly after: string;
  readonly hunks: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function splitUnifiedDiff(unifiedDiff: string): DiffSides {
  const before: string[] = [];
  const after: string[] = [];
  let hunks = 0;
  let sawHeader = false;
  for (const raw of unifiedDiff.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      continue;
    }
    if (HUNK_HEADER.test(raw)) {
      hunks += 1;
      sawHeader = true;
      continue;
    }
    if (!sawHeader) {
      // Text before the first hunk header (for example a diff --git line).
      continue;
    }
    const kind = raw.charAt(0);
    const line = raw.slice(1);
    if (kind === "-") {
      before.push(line);
    } else if (kind === "+") {
      after.push(line);
    } else if (kind === " ") {
      before.push(line);
      after.push(line);
    } else if (raw === "") {
      before.push("");
      after.push("");
    } else if (raw === "\\ No newline at end of file") {
      continue;
    } else {
      // Not a diff line: keep it out of both sides rather than corrupt them.
      continue;
    }
  }
  return {
    before: before.join("\n"),
    after: after.join("\n"),
    hunks,
  };
}
