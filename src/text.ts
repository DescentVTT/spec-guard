/**
 * Offset arithmetic shared by everything that reads source files.
 *
 * These three functions are the entire vocabulary spec-guard needs for talking
 * about positions in a file, and they live here rather than in whichever module
 * needed them first. That is not tidiness: a second copy of "which line is this
 * offset on" is a second chance to be off by one, and a report that points at
 * the wrong line is worse than one that points nowhere.
 *
 * What a snippet of a line is cut to, and with what, is here for the same
 * reason: the engine cuts one and the reporter has to know one that was cut.
 */

/** Longest line snippet echoed back to the terminal. */
export const MAX_SNIPPET_LENGTH = 200;

/** What a snippet ends with where its line was longer than that. */
export const CUT_MARK = '…';

/**
 * Whether a snippet is a line that was cut, which a report in ASCII draws
 * with three dots where the mark is.
 *
 * Only a cut makes a line's snippet one longer than a snippet may be, and
 * every cut ends with the mark, so a line somebody wrote with an ellipsis at
 * its end is told apart by its length, and is left as it was written. The
 * mark is asked for beside the length because not every match is a line of a
 * file: an import rule's and a cycle's are written by the runner, at any
 * length, and end as they end.
 */
export function wasCut(snippet: string): boolean {
  return snippet.length === MAX_SNIPPET_LENGTH + 1 && snippet.endsWith(CUT_MARK);
}

/** Offsets at which each line begins. Index 0 is line 1. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  // Driven by indexOf rather than a character loop. Same answer, one less
  // bound to get wrong - `index < source.length` reads past the end harmlessly
  // when loosened, so nothing could ever fail on it - and it hands the scan to
  // the engine's own memchr instead of walking UTF-16 units in JavaScript.
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/**
 * Resolves an offset to a 1-based line and column, in O(log n).
 *
 * The search is half-open - `high` is one past the last candidate - and narrows
 * until exactly one candidate is left. Written with an inclusive `high` it
 * needed a `- 1` that could be perturbed without changing any answer, because
 * an out-of-range probe reads `undefined`, compares false, and converges anyway.
 * There is no arithmetic here that a wrong value would leave working.
 */
export function locate(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((starts[mid] as number) <= index) low = mid;
    else high = mid;
  }
  return { line: low + 1, column: index - (starts[low] as number) + 1 };
}

/**
 * Blanks out the given ranges, preserving every other byte and every newline.
 *
 * Offsets survive masking, which is the point: a keyword found at offset 400 of
 * the masked text is at offset 400 of the original, so it can be reported at
 * the line and column a human will find it on. Newlines are kept for the same
 * reason.
 */
export function maskRanges(source: string, ranges: Iterable<readonly [number, number]>): string {
  // Built from slices rather than a character array. The obvious version -
  // source.split(''), blank in place, join('') - allocates one string object
  // per character in the file, and measured at roughly half the throughput of
  // this on a 1 MB source. Both are O(n); only one of them is fast.
  // Sorted because the cursor only moves forward: an out-of-order range would
  // be clamped away and silently never masked.
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;

  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    const to = Math.min(end, source.length);
    // No guard on the degenerate cases, because there is nothing left for one
    // to do. An empty range, an inverted one and a range already inside one
    // that has been masked all produce two empty or already-emitted slices,
    // and advancing the cursor to the furthest point reached - rather than to
    // `to`, which can lie behind it - is what stops it moving backwards and
    // duplicating the text between. The special case used to be a branch whose
    // only distinguishing input was one nothing produces; now it is arithmetic.
    parts.push(source.slice(cursor, from));
    // No `u` flag: the replacement walks UTF-16 code units, so a surrogate pair
    // becomes two spaces and every later offset still lands where it did.
    parts.push(source.slice(from, to).replace(/[^\n]/g, ' '));
    cursor = Math.max(from, to);
  }

  parts.push(source.slice(cursor));
  return parts.join('');
}
