// The lint of the raw editor's draft (live check F3): the same lintFile the
// server runs, through the pack code that runs in the browser alike, so the
// Monaco gutter carries a marker the moment a line goes wrong - not only
// after a save refuses. A file the pack does not describe stays unmarked;
// the server still guards the write.
import { lintFile, type LintIssue, type Pack } from "@dialwarden/packs-schema";
import type { LintMarker } from "../components/code-editor";

/** The lint of the draft text of one pack file, empty when it cannot run. */
export function draftLint(
  pack: Pack,
  fileId: string,
  text: string,
): readonly LintIssue[] {
  try {
    return lintFile(pack, fileId, new TextEncoder().encode(text));
  } catch {
    return [];
  }
}

/**
 * The gutter markers of the lint: every issue spans its whole line, so the
 * squiggle and the glyph show even when the adapter names only a column.
 */
export function lintMarkers(
  text: string,
  issues: readonly LintIssue[],
): readonly LintMarker[] {
  const lines = text.split("\n");
  return issues
    .filter((issue) => issue.line > 0)
    .map((issue) => ({
      line: issue.line,
      endLine: issue.line,
      column: issue.column,
      endColumn: (lines[issue.line - 1]?.length ?? 0) + 1,
      severity: issue.severity,
      message: issue.message,
    }));
}
