/**
 * GFM pipe tables, with an offset for every cell.
 *
 * Cell offsets are the point: a register kept as a table needs findings that
 * name the cell declaring a relation, not the row and not the file. Rows are
 * split on the structure mask, so a pipe inside a code span or a comment
 * cannot invent a column, and the text of each cell comes from the original.
 *
 * Reading one line past the last, or one character past a line's end, finds
 * no row and no pipe, so mutants that move those bounds are equivalent.
 */

import { isMarkdown, leadOffset, type Layout } from './layout.js';
import type { Heading, ScannedLine, Table, TableCell, TableRow } from './types.js';

const PIPE = 124;
const BACKSLASH = 92;
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * A header line, a delimiter row with as many cells, and the rows under them
 * up to a line that is blank, holds no pipe, or is not Markdown.
 */
export function findTables(layout: Layout, atx: readonly Pick<Heading, 'line'>[]): Table[] {
  const { lines } = layout;
  const heading = new Set(atx.map((h) => h.line));
  // A line starting in a comment is not a row, and neither is one that
  // continues a code span or comment from the line above.
  const row = (i: number): ScannedLine | null => {
    const line = lines[i];
    if (line === undefined || !isMarkdown(line) || line.blank || line.comment) return null;
    return layout.covered.has(line.line) || heading.has(line.line) ? null : line;
  };

  const out: Table[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = row(i);
    const delimiter = row(i + 1);
    if (header === null || delimiter === null) continue;
    const headers = splitRow(layout, header);
    if (headers.length === 0) continue;
    const marks = splitRow(layout, delimiter);
    if (marks.length !== headers.length || !marks.every((cell) => DELIMITER_CELL.test(cell.text))) continue;

    const rows: TableRow[] = [];
    let last = delimiter;
    for (let line = row(i + 2); line !== null; line = row(line.line)) {
      const cells = splitRow(layout, line);
      if (cells.length === 0) break;
      rows.push({ cells, start: line.contentStart, end: line.end, line: line.line });
      last = line;
    }
    out.push({ start: header.contentStart, end: last.end, line: header.line, endLine: last.line, headers, rows });
    i = last.line - 1;
  }
  return out;
}

/** Splits a row into cells, keeping each cell's offsets. A row without a pipe has none. */
function splitRow(layout: Layout, line: ScannedLine): TableCell[] {
  const { text, structure } = layout;
  const bounds: number[] = [];
  for (let at = line.contentStart; at < line.end; at += 1) {
    // A pipe escaped with a backslash is content, not a column edge.
    if (structure.charCodeAt(at) === PIPE && text.charCodeAt(at - 1) !== BACKSLASH) bounds.push(at);
  }
  if (bounds.length === 0) return [];

  const cells: TableCell[] = [];
  // A pipe opening the row is a border, not the edge of an empty first cell.
  let cursor = bounds[0] === leadOffset(line) ? (bounds.shift() as number) + 1 : line.contentStart;
  for (const bound of bounds) {
    cells.push(cell(text, cursor, bound));
    cursor = bound + 1;
  }
  // What follows the last pipe is a cell unless the row ended with a border.
  if (text.slice(cursor, line.end).trim().length > 0) cells.push(cell(text, cursor, line.end));
  return cells;
}

function cell(text: string, start: number, end: number): TableCell {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  return { text: trimmed, start: start + leading, end: start + leading + trimmed.length };
}
