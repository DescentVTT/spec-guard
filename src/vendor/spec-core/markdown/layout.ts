/**
 * What the readers of headings, list items, links and tables work from: the
 * lines as the block pass classified them, and the masks.
 */

import type { LineIndex } from '../text/index.js';
import { leadIndex } from './syntax.js';
import type { Block, HtmlComment, ScannedLine } from './types.js';

export interface Layout {
  readonly text: string;
  readonly index: LineIndex;
  readonly lines: readonly ScannedLine[];
  readonly blocks: readonly Block[];
  readonly comments: readonly HtmlComment[];
  readonly structure: string;
  readonly prose: string;
  /**
   * The lines, by number, that start inside a code span or comment opened on
   * an earlier line, so nothing on them opens a block.
   */
  readonly covered: ReadonlySet<number>;
  /**
   * The lines, by number, that would continue a paragraph on the line before
   * them: not blank, opening nothing of their own, and not after a heading.
   * Only asked of a line after one that is not blank.
   */
  readonly continues: ReadonlySet<number>;
}

/** A line whose content is Markdown: not front matter, code or raw-text HTML. */
export function isMarkdown(line: ScannedLine): boolean {
  return !line.frontMatter && !line.code && !line.html;
}

/** Offset of a line's first non-blank character, or its end when it is blank. */
export function leadOffset(line: ScannedLine): number {
  return line.contentStart + leadIndex(line.content);
}

/**
 * Whether a line's first non-blank character is structure. A heading or a
 * list marker is only one when it is the first thing on its line, and the
 * first thing on a line that closes a comment or a code span is the end of
 * that comment or span, whatever follows it.
 */
export function visibleLead(layout: Layout, line: ScannedLine): boolean {
  return layout.structure.charCodeAt(leadOffset(line)) !== 32;
}

/** Whether the character at an offset of a text is a space or a tab. */
export function isSpaceOrTab(text: string, at: number): boolean {
  const ch = text.charCodeAt(at);
  return ch === 32 || ch === 9;
}
