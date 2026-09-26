/**
 * List items, as blocks rather than lines.
 *
 * An item owns what is nested under it - anything indented past its marker -
 * and its lazy continuation lines: text directly under it, with no blank line
 * between, that opens nothing of its own. So a resolution written on the
 * second line of a bullet is found instead of missed, and a fenced example
 * nested under an item is the item's.
 *
 * The items open at a line are kept on a stack, innermost last, and each line
 * closes items from the top. Every item is opened and closed once, so the
 * pass is linear however deep the nesting.
 */

import { visibleLead, type Layout } from './layout.js';
import { isThematicBreak, listMarker, measureIndentAt, stripQuotes } from './syntax.js';
import type { Block, Heading, ListItem, ScannedLine } from './types.js';

const CHECKBOX = /^\[([ xX~\-?!*/+])\](?=[ \t]|$)/;

type Draft = { -readonly [K in Exclude<keyof ListItem, 'body' | 'maskedBody'>]: ListItem[K] };

/**
 * Items end where CommonMark's do, near enough: at a heading; at a line no
 * deeper than the marker after a blank line; and at a line no deeper than the
 * marker that opens something - another item, a block quote, a thematic
 * break, a fence. A block of code is owned whole or not at all.
 */
export function findListItems(layout: Layout, headings: readonly Heading[]): ListItem[] {
  const { lines, text, structure, blocks } = layout;
  const heading = new Set<number>();
  for (const h of headings) for (let line = h.line; line <= h.endLine; line += 1) heading.add(line);

  const items: Draft[] = [];
  const stack: Draft[] = [];
  // Whether a blank line came since the last line read. Its first value is
  // never asked for: no item is open before a marker line, which clears it.
  let sawBlank = false;
  // The last line every open item owns: each owns every line it has not been closed by.
  let lastEnd = 0;
  let lastLine = 0;
  let block = 0;

  const closeWhile = (closes: (item: Draft) => boolean): void => {
    for (let top = stack[stack.length - 1]; top !== undefined && closes(top); top = stack[stack.length - 1]) {
      top.end = lastEnd;
      top.endLine = lastLine;
      stack.pop();
    }
  };

  // Front matter is blank in the structure mask, so no marker is visible in it.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as ScannedLine;
    // A blank line inside a block of code is skipped with the block.
    if (line.blank) {
      sawBlank = true;
      continue;
    }
    // No item is open after a heading, so whether a blank line came before it
    // is never asked.
    if (heading.has(line.line)) {
      closeWhile(() => true);
      continue;
    }

    if (line.code || line.html) {
      while ((blocks[block] as Block).endLine < line.line) block += 1;
      const owned = blocks[block] as Block;
      closeWhile((item) => indentFor(text, line, item) <= item.indent);
      lastEnd = owned.end;
      lastLine = owned.endLine;
      i = owned.endLine - 1;
      sawBlank = false;
      continue;
    }

    const marker = visibleLead(layout, line) ? listMarker(line.content) : null;
    const opens = marker !== null || (visibleLead(layout, line) && isThematicBreak(line.content));
    closeWhile((item) => {
      if (indentFor(text, line, item) > item.indent) return false;
      return sawBlank || opens || line.quoteDepth > item.quoteDepth;
    });
    lastEnd = line.end;
    lastLine = line.line;
    sawBlank = false;
    if (marker === null) continue;

    const markerStart = line.contentStart + marker.offset;
    let textStart = markerStart + marker.width;
    const box = CHECKBOX.exec(structure.slice(textStart, line.end));
    const checkboxStart = box === null ? null : textStart;
    if (box !== null) {
      // The character at the end of the line is its terminator, not a space.
      textStart += 3;
      while (text.charCodeAt(textStart) === 32 || text.charCodeAt(textStart) === 9) textStart += 1;
    }
    const item: Draft = {
      start: line.contentStart,
      end: line.end,
      markerStart,
      marker: marker.marker,
      textStart,
      checkbox: box === null ? null : (box[1] as string),
      checkboxStart,
      firstLine: text.slice(textStart, line.end).trim(),
      line: line.line,
      endLine: line.line,
      depth: stack.length,
      indent: line.indent,
      quoteDepth: line.quoteDepth,
    };
    items.push(item);
    stack.push(item);
  }
  closeWhile(() => true);

  return items.map((item) => ({
    ...item,
    body: text.slice(item.textStart, item.end),
    maskedBody: structure.slice(item.textStart, item.end),
  }));
}

/**
 * A line's indentation as an item sees it: measured inside the item's block
 * quote. A line quoted deeper than the item is measured up to its extra `>`,
 * so a quote nested under an item is nested, and one at the item's own
 * indentation opens a block quote beside it.
 */
function indentFor(text: string, line: ScannedLine, item: Draft): number {
  const q = stripQuotes(text, line.start, item.quoteDepth);
  return measureIndentAt(text, q.contentStart, line.end);
}
