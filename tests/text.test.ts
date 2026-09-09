/**
 * Offset arithmetic.
 *
 * Three small functions that four other modules depend on, so a defect here
 * shows up as a report pointing at the wrong line rather than as a crash. They
 * were tested only through their callers until mutation testing pointed out
 * that no caller ever passes an overlapping range or an out-of-order one - so
 * neither the sort nor the clamp was pinned down by anything.
 */

import { describe, expect, it } from 'vitest';

import { lineStarts, locate, maskRanges } from '../src/text.js';

describe('lineStarts', () => {
  it('starts at zero for an empty source', () => {
    expect(lineStarts('')).toEqual([0]);
  });

  it('records the offset after each newline', () => {
    expect(lineStarts('ab\ncd\n\nx')).toEqual([0, 3, 6, 7]);
  });

  it('counts a trailing newline as opening a line', () => {
    expect(lineStarts('a\n')).toEqual([0, 2]);
  });
});

describe('locate', () => {
  const source = 'ab\ncd\n\nxyz';
  const starts = lineStarts(source);

  it.each([
    [0, 1, 1],
    [1, 1, 2],
    [2, 1, 3], // the newline itself belongs to the line it ends
    [3, 2, 1],
    [6, 3, 1],
    [7, 4, 1],
    [9, 4, 3],
  ])('puts offset %i at line %i column %i', (offset, line, column) => {
    expect(locate(starts, offset)).toEqual({ line, column });
  });

  it('handles a single-line source', () => {
    expect(locate(lineStarts('abc'), 2)).toEqual({ line: 1, column: 3 });
  });

  it('does not run off the end for an offset past the source', () => {
    // Line 4 starts at offset 7, so an offset of 60 is column 54.
    expect(locate(starts, source.length + 50)).toEqual({ line: 4, column: 54 });
  });
});

describe('maskRanges', () => {
  it('returns the source untouched when there is nothing to mask', () => {
    expect(maskRanges('abcdef', [])).toBe('abcdef');
  });

  it('blanks a range and preserves every offset', () => {
    const masked = maskRanges('abcdef', [[2, 4]]);
    expect(masked).toBe('ab  ef');
    expect(masked).toHaveLength('abcdef'.length);
  });

  it('keeps newlines inside a masked range', () => {
    // Line numbers are derived from this string afterwards, so a newline
    // turned into a space moves every later report by a line.
    expect(maskRanges('a\nbc\nd', [[0, 6]])).toBe(' \n  \n ');
  });

  it('masks several ranges', () => {
    expect(maskRanges('abcdefgh', [[1, 3], [5, 7]])).toBe('a  de  h');
  });

  it('masks ranges given out of order', () => {
    // The cursor only moves forward, so an unsorted list would leave the
    // earlier range unmasked entirely.
    expect(maskRanges('abcdefgh', [[5, 7], [1, 3]])).toBe('a  de  h');
  });

  it('does not duplicate text when one range sits inside another', () => {
    // The failure this guards against is not a wrong mask, it is a cursor that
    // moves backwards and emits the text between twice - a longer string, and
    // every offset after it wrong.
    const masked = maskRanges('abcdefgh', [[0, 6], [2, 3]]);
    expect(masked).toBe('      gh');
    expect(masked).toHaveLength(8);
  });

  it('does not duplicate text when two ranges overlap partway', () => {
    const masked = maskRanges('abcdefgh', [[0, 4], [2, 6]]);
    expect(masked).toBe('      gh');
    expect(masked).toHaveLength(8);
  });

  it('ignores an empty or inverted range', () => {
    expect(maskRanges('abcdef', [[2, 2]])).toBe('abcdef');
    expect(maskRanges('abcdef', [[4, 1]])).toBe('abcdef');
  });

  it('clamps a range that runs past the end', () => {
    expect(maskRanges('abc', [[1, 99]])).toBe('a  ');
  });

  it('ignores a range that starts past the end', () => {
    expect(maskRanges('abc', [[10, 20]])).toBe('abc');
  });

  it('masks a range that starts at zero', () => {
    expect(maskRanges('abc', [[0, 2]])).toBe('  c');
  });

  it('keeps the length of a surrogate pair', () => {
    // A code point outside the BMP is two UTF-16 units. Masking it as one
    // character would shift every offset after it by one, which is how an
    // emoji in a comment moves a reported column.
    const source = `x${String.fromCodePoint(0x1f600)}y`;
    const masked = maskRanges(source, [[1, 3]]);

    expect(masked).toBe('x  y');
    expect(masked).toHaveLength(source.length);
  });
});
