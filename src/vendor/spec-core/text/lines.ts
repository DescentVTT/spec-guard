/**
 * Lines, offsets and masks.
 *
 * Every finding a spec-* tool reports points at a line and a column, and every
 * structure the scanner builds carries raw offsets rather than copies of the
 * text. Converting between the two is on the hot path, so the line table is
 * built once per file and searched by bisection.
 *
 * All three line terminators end a line - `\n`, `\r\n` and a lone `\r`, as
 * CommonMark has it - and `\r\n` counts once. A Windows checkout of a document
 * must produce the line numbers a POSIX checkout does.
 */

export interface Position {
  /** UTF-16 offset into the text. */
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 code units. */
  readonly column: number;
}

export interface LineIndex {
  /** Number of lines. A final terminator does not open a line of its own. */
  readonly lineCount: number;
  /** Offset at which a 1-based line starts. Out-of-range lines are clamped. */
  lineStart(line: number): number;
  /** Offset just past a 1-based line, before its terminator. */
  lineEnd(line: number): number;
  /** A 1-based line without its terminator. */
  lineText(line: number): string;
  /** The line and column of an offset. Out-of-range offsets are clamped. */
  positionAt(offset: number): Position;
}

const LF = 10;
const CR = 13;

/** Offsets at which each line starts; index 0 is line 1. */
export function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === LF) {
      starts.push(i + 1);
    } else if (ch === CR) {
      if (text.charCodeAt(i + 1) === LF) i += 1;
      starts.push(i + 1);
    }
  }
  // A terminator at the very end opens a line that holds nothing; an editor
  // does not count it, and neither does this.
  if (starts.length > 1 && starts[starts.length - 1] === text.length) starts.pop();
  return starts;
}

/** Builds the line table for a text. */
export function createLineIndex(text: string): LineIndex {
  const starts = lineStarts(text);
  const lineCount = starts.length;
  const clamp = (line: number): number => (line < 1 ? 1 : line > lineCount ? lineCount : line);
  const startOf = (line: number): number => starts[clamp(line) - 1] as number;
  const endOf = (line: number): number => {
    const index = clamp(line);
    const start = starts[index - 1] as number;
    let end = index === lineCount ? text.length : (starts[index] as number);
    // At most two terminator characters, and never past the line's own start.
    if (end > start && text.charCodeAt(end - 1) === LF) end -= 1;
    if (end > start && text.charCodeAt(end - 1) === CR) end -= 1;
    return end;
  };
  return {
    lineCount,
    lineStart: startOf,
    lineEnd: endOf,
    lineText: (line) => text.slice(startOf(line), endOf(line)),
    positionAt: (offset) => locate(starts, offset < 0 ? 0 : offset > text.length ? text.length : offset),
  };
}

/**
 * The line and column of an offset, by bisection over a line table.
 *
 * The search is half-open: `high` is one past the last candidate, and it
 * narrows until one is left. There is no `- 1` to get wrong.
 */
export function locate(starts: readonly number[], offset: number): Position {
  let low = 0;
  let high = starts.length;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid;
  }
  return { offset, line: low + 1, column: offset - (starts[low] as number) + 1 };
}

/** A half-open range of offsets. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/** Sorts and merges ranges; touching ranges merge. Empty ranges vanish. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ start: range.start, end: range.end });
  }
  return out;
}

/** Whether an offset lies in one of a list of merged, sorted ranges. */
export function inRanges(merged: readonly Range[], offset: number): boolean {
  let low = 0;
  let high = merged.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const range = merged[mid] as Range;
    if (offset < range.start) high = mid;
    else if (offset >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}

const NOT_A_TERMINATOR = /[^\n\r]/g;

/**
 * Blanks the given ranges with spaces, keeping every other character and
 * every line terminator where it was.
 *
 * Offsets survive a mask, which is the point: something found at offset 400
 * of the masked text is at offset 400 of the original, on the same line. The
 * replacement walks UTF-16 code units, so a surrogate pair becomes two spaces
 * and every later offset still lands where it did.
 */
export function maskRanges(text: string, ranges: readonly Range[]): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const range of merged) {
    const start = Math.min(range.start, text.length);
    const end = Math.min(range.end, text.length);
    out += text.slice(cursor, start);
    out += text.slice(start, end).replace(NOT_A_TERMINATOR, ' ');
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** A text without a leading byte-order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The terminator a text mostly uses; `\n` when it has none or they tie. */
export function lineEnding(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === CR) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * The lines of a text, without terminators. Unlike the line table, a final
 * terminator does produce a last, empty line, so that joining the lines with
 * the same terminator gives the text back byte for byte.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}
