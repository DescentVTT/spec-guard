/**
 * Offset arithmetic shared by everything that reads source files.
 *
 * These three functions are the entire vocabulary spec-guard needs for talking
 * about positions in a file, and they live here rather than in whichever module
 * needed them first. That is not tidiness: a second copy of "which line is this
 * offset on" is a second chance to be off by one, and a report that points at
 * the wrong line is worse than one that points nowhere.
 */

/** Offsets at which each line begins. Index 0 is line 1. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Resolves an offset to a 1-based line and column, in O(log n). */
export function locate(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= index) low = mid;
    else high = mid - 1;
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
  const sorted = [...ranges].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;

  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    const to = Math.min(end, source.length);
    if (to <= from) continue;
    if (from > cursor) parts.push(source.slice(cursor, from));
    // No `u` flag: the replacement walks UTF-16 code units, so a surrogate pair
    // becomes two spaces and every later offset still lands where it did.
    parts.push(source.slice(from, to).replace(/[^\n]/g, ' '));
    cursor = to;
  }

  parts.push(source.slice(cursor));
  return parts.join('');
}
