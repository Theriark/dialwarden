// The one edit that turns the editor's text into an external text (live
// check F13): the raw editor owns its Monaco model, so a file switch or a
// reload after a save reaches the model as a single replace of the part that
// differs, pushed through pushEditOperations. The caret stays put unless the
// replaced part holds it, the undo stack survives, and a text the model
// already holds is no edit at all.

/** A replace of the UTF-16 units from start (inclusive) to end with text. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function highSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function lowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The smallest replace that turns before into after, or null when the two
 * are the same text. A surrogate pair is never split: the edit widens to
 * the whole character.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) {
    return null;
  }
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (
    start < shortest &&
    before.charCodeAt(start) === after.charCodeAt(start)
  ) {
    start += 1;
  }
  if (start > 0 && highSurrogate(before.charCodeAt(start - 1))) {
    start -= 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  if (
    endBefore < before.length &&
    endAfter < after.length &&
    lowSurrogate(before.charCodeAt(endBefore))
  ) {
    endBefore += 1;
    endAfter += 1;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}
