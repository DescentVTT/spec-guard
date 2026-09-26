/**
 * Headings, their GitHub anchors, and the sections they open.
 *
 * A heading is found in the structure mask, so one written in a code sample
 * or a comment is not one, and its text is read from the prose mask, so a
 * code span in it is kept and a comment after it is not.
 */

import { isMarkdown, isSpaceOrTab, visibleLead, type Layout } from './layout.js';
import { atxLevel, isThematicBreak, leadIndex, listMarker, setextUnderline } from './syntax.js';
import type { Heading, HeadingForm, HtmlComment, MarkdownScan, ScannedLine, Section, Table } from './types.js';

/**
 * GitHub's slug of a heading's text: lower case, punctuation dropped, every
 * whitespace character a hyphen.
 *
 * spec-graph's slug, with two of its steps taken out because a later step
 * did their work: it dropped Markdown's punctuation and then all punctuation,
 * and trimmed before and after. What remains gives the same slug for every
 * text. It drops `_`, which GitHub keeps.
 */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      // GitHub hyphenates every whitespace character, so a run of two spaces
      // left behind by stripped punctuation becomes two hyphens, not one.
      .replace(/\s/g, '-')
  );
}

/** A heading before GitHub's anchors are counted, which needs every heading. */
export type Unanchored = Omit<Heading, 'anchor'>;

/**
 * ATX headings: `#` to `######` opening a line, after at most three spaces.
 *
 * Only a line whose first character is visible in the structure mask is read,
 * and the mask blanks every line of front matter, code and raw-text HTML.
 */
export function findAtxHeadings(layout: Layout): Unanchored[] {
  const out: Unanchored[] = [];
  const strip = commentStripper(layout);
  for (const line of layout.lines) {
    const level = atxLevel(line.content);
    if (level === 0 || !visibleLead(layout, line)) continue;
    const opened = line.contentStart + leadIndex(line.content) + level;
    const [textStart, textEnd] = atxText(layout.prose, opened, line.end);
    out.push(heading('atx', level, strip(textStart, textEnd), textStart, textEnd, line, line));
  }
  return out;
}

/**
 * The text of an ATX heading: trimmed, without a closing sequence. A closing
 * run of `#` counts only after a space or a tab, so `# C#` is about C#. The
 * character at `to` ends the line, and is not a space.
 */
function atxText(prose: string, from: number, to: number): [number, number] {
  let start = from;
  while (isSpaceOrTab(prose, start)) start += 1;
  let end = to;
  while (end > start && isSpaceOrTab(prose, end - 1)) end -= 1;
  let hashes = end;
  while (hashes > start && prose.charCodeAt(hashes - 1) === 35) hashes -= 1;
  // Before a closing run there is the space it needs, or the space after the
  // opening run when the heading is nothing else.
  if (isSpaceOrTab(prose, hashes - 1)) {
    end = hashes;
    while (end > start && isSpaceOrTab(prose, end - 1)) end -= 1;
  }
  return [start, end];
}

/**
 * Every heading in order, ATX and setext, with GitHub's anchors.
 *
 * A setext heading is a paragraph line underlined with `=` or `-`. The line
 * above the underline must be one a paragraph can hold: not a heading, a list
 * item, a thematic break, a table row, blank, or indented four columns.
 * Otherwise `---` is a thematic break, and a table or a list followed by one
 * would gain a heading nobody wrote.
 */
export function findHeadings(layout: Layout, atx: readonly Unanchored[], tables: readonly Table[]): Heading[] {
  const { lines } = layout;
  const taken = new Set<number>();
  for (const h of atx) taken.add(h.line);
  for (const table of tables) for (let line = table.line; line <= table.endLine; line += 1) taken.add(line);

  const setext: Unanchored[] = [];
  const strip = commentStripper(layout);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const above = lines[i] as ScannedLine;
    const under = lines[i + 1] as ScannedLine;
    if (taken.has(above.line) || !paragraphLine(layout, above)) continue;
    if (!isMarkdown(under) || under.quoteDepth !== above.quoteDepth) continue;
    const mark = setextUnderline(under.content);
    if (mark === null || !visibleLead(layout, under)) continue;
    let textStart = above.contentStart;
    while (isSpaceOrTab(layout.prose, textStart)) textStart += 1;
    let textEnd = above.end;
    while (isSpaceOrTab(layout.prose, textEnd - 1)) textEnd -= 1;
    setext.push(heading('setext', mark === '=' ? 1 : 2, strip(textStart, textEnd), textStart, textEnd, above, under));
    // The underline is part of this heading, not the text of the next.
    i += 1;
  }

  const all = [...atx, ...setext].sort((a, b) => a.line - b.line);
  const occurrences = new Map<string, number>();
  return all.map((h) => ({ ...h, anchor: anchorOf(occurrences, h.slug) }));
}

/** A line that can be the text of a setext heading. */
function paragraphLine(layout: Layout, line: ScannedLine): boolean {
  if (!isMarkdown(line) || line.blank || line.comment || line.indent >= 4) return false;
  return !(visibleLead(layout, line) && (listMarker(line.content) !== null || isThematicBreak(line.content)));
}

/**
 * GitHub's anchor for a slug: the slug itself the first time, then with `-1`,
 * `-2` and so on, skipping any suffixed form a heading already took.
 */
function anchorOf(occurrences: Map<string, number>, slug: string): string {
  let anchor = slug;
  while (occurrences.has(anchor)) {
    const count = (occurrences.get(slug) as number) + 1;
    occurrences.set(slug, count);
    anchor = `${slug}-${count}`;
  }
  occurrences.set(anchor, 0);
  return anchor;
}

function heading(
  form: HeadingForm,
  level: number,
  text: string,
  textStart: number,
  textEnd: number,
  first: ScannedLine,
  last: ScannedLine,
): Unanchored {
  return {
    form,
    level,
    text,
    slug: slugify(text),
    start: first.contentStart,
    end: last.end,
    textStart,
    textEnd,
    line: first.line,
    endLine: last.line,
  };
}

/**
 * The text between two offsets with the comments inside it taken out, as a
 * renderer shows it. Called with increasing offsets, so it walks the comments
 * once.
 */
function commentStripper(layout: Layout): (start: number, end: number) => string {
  const { comments, text } = layout;
  let c = 0;
  return (start, end) => {
    let out = '';
    for (let at = start; at < end; at += 1) {
      while (c < comments.length && (comments[c] as HtmlComment).end <= at) c += 1;
      const comment = comments[c];
      if (comment === undefined || comment.start > at) out += text.charAt(at);
    }
    return out;
  };
}

/**
 * Each heading of `level` or deeper with everything under it, up to the next
 * heading at its level or above.
 */
export function sectionsOf(scan: MarkdownScan, level = 1): Section[] {
  const { headings, index, text } = scan;
  const out: Section[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h] as Heading;
    if (heading.level < level) continue;
    let next: Heading | undefined;
    for (let k = h + 1; k < headings.length && next === undefined; k += 1) {
      const candidate = headings[k] as Heading;
      if (candidate.level <= heading.level) next = candidate;
    }
    out.push({
      heading,
      start: index.lineStart(heading.line),
      bodyStart: heading.endLine < index.lineCount ? index.lineStart(heading.endLine + 1) : text.length,
      end: next === undefined ? text.length : index.lineStart(next.line),
      endLine: next === undefined ? index.lineCount + 1 : next.line,
    });
  }
  return out;
}

/** The first level-one heading, which is what a reader takes as the title. */
export function titleOf(scan: MarkdownScan): Heading | undefined {
  return scan.headings.find((h) => h.level === 1);
}
