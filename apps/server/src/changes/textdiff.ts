// Line diffs of the change sets (contract C5, rnd-report-1 2.7): the unified
// diff a change set shows per file, the number of lines an outside edit
// changed, and the three-way merge of a raw file patch when the file changed
// outside the app after the patch was made.
//
// The diff is Myers' O(ND) algorithm over whole lines (each line keeps its
// own line break, so joining the lines gives the text back byte for byte).
// Config files are a few KiB; past MAX_EDIT_DISTANCE the middle of a file is
// treated as one changed block, which keeps the work bounded for any input.

/** The most differing lines the diff aligns before it gives up on detail. */
export const MAX_EDIT_DISTANCE = 2000;

/** Lines of context around each change in a unified diff. */
const CONTEXT = 3;

/**
 * A block where two texts differ: lines aStart to aEnd (exclusive) of the
 * first text became lines bStart to bEnd of the second. Blocks are in order
 * and never touch: at least one equal line sits between two of them.
 */
export interface Hunk {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

/** The lines of a text, each with its line break, so join("") is the text. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end === -1) break;
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Equal (0), deleted from a (-1) or inserted from b (1), one line each. */
type Op = -1 | 0 | 1;

/**
 * The shortest edit script from a to b as one op per line, or null when it
 * needs more than limit deletions and insertions.
 */
function editScript(a: string[], b: string[], limit: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const furthest = (k: number): number => v[max + k] ?? 0;
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, limit) && found < 0; d += 1) {
    // The furthest x of every diagonal after d - 1 steps, k from -d to d.
    trace.push(v.slice(max - d, max + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest(k - 1) < furthest(k + 1));
      let x = down ? furthest(k + 1) : furthest(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a.at(x) === b.at(y)) {
        x += 1;
        y += 1;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const before = trace.at(d) ?? new Int32Array(0);
    const earlier = (k: number): number => before[k + d] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && earlier(k - 1) < earlier(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : earlier(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push(0);
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    ops.push(down ? 1 : -1);
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

/** The blocks of an op list, with a and b offset by the trimmed prefix. */
function hunksOf(ops: readonly Op[], offset: number): Hunk[] {
  const hunks: Hunk[] = [];
  let a = offset;
  let b = offset;
  let open: { aStart: number; bStart: number } | null = null;
  for (const op of ops) {
    if (op === 0) {
      if (open !== null) hunks.push({ ...open, aEnd: a, bEnd: b });
      open = null;
      a += 1;
      b += 1;
      continue;
    }
    open ??= { aStart: a, bStart: b };
    if (op === -1) a += 1;
    else b += 1;
  }
  if (open !== null) hunks.push({ ...open, aEnd: a, bEnd: b });
  return hunks;
}

/** The blocks where the lines of a and b differ, in order. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let prefix = 0;
  const both = Math.min(a.length, b.length);
  while (prefix < both && a.at(prefix) === b.at(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < both - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) {
    suffix += 1;
  }
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  if (middleA.length === 0 && middleB.length === 0) return [];
  const ops = editScript(middleA, middleB, MAX_EDIT_DISTANCE);
  if (ops === null) {
    const aEnd = a.length - suffix;
    const bEnd = b.length - suffix;
    return [{ aStart: prefix, aEnd, bStart: prefix, bEnd }];
  }
  return hunksOf(ops, prefix);
}

/** How many lines differ: per block, the larger of its two sides. */
export function changedLineCount(before: string, after: string): number {
  const hunks = diffLines(splitLines(before), splitLines(after));
  let count = 0;
  for (const hunk of hunks) {
    count += Math.max(hunk.aEnd - hunk.aStart, hunk.bEnd - hunk.bStart);
  }
  return count;
}

/** Lines of a unified diff body, each with the no-newline marker if needed. */
function marked(mark: string, lines: readonly string[]): string {
  let out = "";
  for (const line of lines) {
    if (line.endsWith("\n")) out += `${mark}${line}`;
    else out += `${mark}${line}\n\\ No newline at end of file\n`;
  }
  return out;
}

/** The hunk header range: the first line (1-based) and the line count. */
function range(start: number, length: number): string {
  return `${length === 0 ? start : start + 1},${length}`;
}

/** Blocks close enough to share their context lines, grouped. */
function groupHunks(hunks: readonly Hunk[]): Hunk[][] {
  const groups: Hunk[][] = [];
  for (const hunk of hunks) {
    const last = groups.at(-1);
    const previous = last?.at(-1);
    if (last && previous && hunk.aStart - previous.aEnd <= 2 * CONTEXT) {
      last.push(hunk);
    } else {
      groups.push([hunk]);
    }
  }
  return groups;
}

/**
 * A unified diff of a file with 3 lines of context, as `diff -u` writes it
 * (a/ and b/ before the file id). Empty when the texts are equal.
 */
export function unifiedDiff(
  fileId: string,
  before: string,
  after: string,
): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const hunks = diffLines(a, b);
  if (hunks.length === 0) return "";
  let out = `--- a/${fileId}\n+++ b/${fileId}\n`;
  for (const group of groupHunks(hunks)) {
    const first = group.at(0);
    const last = group.at(-1);
    if (first === undefined || last === undefined) continue;
    const aFrom = Math.max(0, first.aStart - CONTEXT);
    const bFrom = first.bStart - (first.aStart - aFrom);
    const aTo = Math.min(a.length, last.aEnd + CONTEXT);
    const bTo = last.bEnd + (aTo - last.aEnd);
    const oldRange = range(aFrom, aTo - aFrom);
    const newRange = range(bFrom, bTo - bFrom);
    out += `@@ -${oldRange} +${newRange} @@\n`;
    let line = aFrom;
    for (const hunk of group) {
      out += marked(" ", a.slice(line, hunk.aStart));
      out += marked("-", a.slice(hunk.aStart, hunk.aEnd));
      out += marked("+", b.slice(hunk.bStart, hunk.bEnd));
      line = hunk.aEnd;
    }
    out += marked(" ", a.slice(line, aTo));
  }
  return out;
}

/** A block of one side of a merge, with that side's lines. */
interface SideHunk extends Hunk {
  readonly lines: readonly string[];
}

/** The lines a side gives region start to end of base, with its blocks. */
function sideText(
  base: readonly string[],
  hunks: readonly SideHunk[],
  start: number,
  end: number,
): string[] {
  const out: string[] = [];
  let line = start;
  let next = 0;
  for (;;) {
    let hunk = hunks.at(next);
    while (hunk !== undefined && hunk.aStart === line) {
      out.push(...hunk.lines.slice(hunk.bStart, hunk.bEnd));
      line = hunk.aEnd;
      next += 1;
      hunk = hunks.at(next);
    }
    if (line >= end) return out;
    out.push(...base.slice(line, line + 1));
    line += 1;
  }
}

interface Tagged {
  readonly hunk: SideHunk;
  readonly isOurs: boolean;
}

function byStart(x: Tagged, y: Tagged): number {
  return x.hunk.aStart - y.hunk.aStart || x.hunk.aEnd - y.hunk.aEnd;
}

/** Base lines start to end and the blocks of each side that touch them. */
interface Region {
  readonly start: number;
  end: number;
  readonly ours: SideHunk[];
  readonly theirs: SideHunk[];
}

function regionsOf(tagged: readonly Tagged[]): Region[] {
  const regions: Region[] = [];
  for (const { hunk, isOurs } of tagged) {
    let region = regions.at(-1);
    if (region === undefined || hunk.aStart > region.end) {
      region = { start: hunk.aStart, end: hunk.aEnd, ours: [], theirs: [] };
      regions.push(region);
    }
    region.end = Math.max(region.end, hunk.aEnd);
    if (isOurs) region.ours.push(hunk);
    else region.theirs.push(hunk);
  }
  return regions;
}

export type MergeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly conflicts: number };

/**
 * The three-way merge of the write path: base is the text the change was
 * made on, ours the change, theirs the file as it is now. Blocks only one side
 * changed are taken from that side; blocks both sides changed the same way
 * are taken once. Blocks both changed differently, including changes on the
 * same or touching lines, are conflicts: the merge then answers how many and
 * merges nothing, so an edit is never lost by guessing.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
): MergeResult {
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  const tagged: Tagged[] = [];
  for (const hunk of diffLines(baseLines, oursLines)) {
    tagged.push({ hunk: { ...hunk, lines: oursLines }, isOurs: true });
  }
  for (const hunk of diffLines(baseLines, theirsLines)) {
    tagged.push({ hunk: { ...hunk, lines: theirsLines }, isOurs: false });
  }
  tagged.sort(byStart);
  const out: string[] = [];
  let conflicts = 0;
  let line = 0;
  for (const region of regionsOf(tagged)) {
    out.push(...baseLines.slice(line, region.start));
    const { start, end } = region;
    const mine = sideText(baseLines, region.ours, start, end);
    const other = sideText(baseLines, region.theirs, start, end);
    if (region.theirs.length === 0) out.push(...mine);
    else if (region.ours.length === 0) out.push(...other);
    else if (mine.join("") === other.join("")) out.push(...mine);
    else conflicts += 1;
    line = end;
  }
  out.push(...baseLines.slice(line));
  if (conflicts > 0) return { ok: false, conflicts };
  return { ok: true, text: out.join("") };
}
