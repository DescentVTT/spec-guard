/**
 * A structural Markdown scanner.
 *
 * Deliberately not a CommonMark parser: nothing here renders. What it must get
 * exactly right is what is code, what is a comment, and what is neither,
 * because every reader downstream asks that question first. A heading inside
 * a fenced block is not a section, a template hint inside `<!-- -->` is not
 * content, and a link in a code sample is not a reference.
 *
 * The scan works on offsets. One pass over the lines finds front matter, code
 * blocks and raw-text HTML, and inside everything else it finds code spans and
 * comments in a single sweep from left to right, as CommonMark does: whichever
 * of the two opens first wins, so `` `<!--` `` is code that mentions a comment,
 * and a backtick inside a comment is a character. Three masks are built from
 * the result, and headings, list items, links and tables are read from them.
 *
 * Every pass is linear in the text. No search runs to the end of the document
 * once per opener: a code span looks for its closer only to the end of its
 * paragraph and remembers what it saw there, and a comment with no `-->`
 * after it tells every later one that there is none.
 *
 * Loops here that stop at a line's end compare against it, and the character
 * there is the line's terminator, which none of them acts on. A bound moved
 * to read one character further changes no answer; mutation testing reports
 * such mutants as surviving, and they are equivalent. So is a search for `-->`
 * compared as `close <= 0` rather than `close < 0`: it starts past `<!--`.
 */

import { createLineIndex, inRanges, maskRanges, mergeRanges, splitLines, stripBom, type LineIndex, type Range } from '../text/index.js';
import { frontMatterCloses, frontMatterKind } from './frontmatter.js';
import { findAtxHeadings, findHeadings } from './headings.js';
import type { Layout } from './layout.js';
import { findLinks } from './links.js';
import { findListItems } from './lists.js';
import {
  atxLevel,
  fenceCloses,
  fenceOpen,
  hasRawTextClose,
  isRawTextOpen,
  isThematicBreak,
  leadIndex,
  listMarker,
  measureIndent,
  opensComment,
  setextUnderline,
  stripQuotes,
  type FenceOpen,
  type ListMarker,
} from './syntax.js';
import { findTables } from './tables.js';
import type { Block, BlockKind, FrontMatterBlock, HtmlComment, MarkdownScan, MaskKind, ScannedLine } from './types.js';

const BACKTICK = 0x60;
const BACKSLASH = 0x5c;

/** Scans a Markdown document. Pure, and linear in the length of the text. */
export function scanMarkdown(source: string): MarkdownScan {
  const text = stripBom(source);
  const index = createLineIndex(text);
  const frontMatter = readFrontMatterBlock(text, index);
  const bodyStart = frontMatter === null ? 0 : frontMatter.bodyStart;
  const core = scanCore(text, index, frontMatter === null ? 0 : frontMatter.closeLine);

  // Without front matter this range is empty, and merging drops it.
  const front: Range[] = [{ start: 0, end: bodyStart }];
  const ranges: Record<MaskKind, Range[]> = {
    structure: mergeRanges([...front, ...core.blocks, ...core.spans, ...core.comments]),
    prose: mergeRanges([...front, ...core.comments]),
    directives: mergeRanges([...front, ...core.blocks, ...core.spans]),
  };
  const masks = {
    structure: maskRanges(text, ranges.structure),
    prose: maskRanges(text, ranges.prose),
    directives: maskRanges(text, ranges.directives),
  };

  const layout: Layout = {
    text,
    index,
    lines: core.lines,
    blocks: core.blocks,
    comments: core.comments,
    structure: masks.structure,
    prose: masks.prose,
    covered: core.covered,
    continues: core.continues,
  };
  const atx = findAtxHeadings(layout);
  const tables = findTables(layout, atx);
  const headings = findHeadings(layout, atx, tables);

  return {
    text,
    bom: source.length - text.length,
    index,
    lines: core.lines,
    frontMatter,
    bodyStart,
    blocks: core.blocks,
    codeSpans: core.spans,
    comments: core.comments,
    masks,
    headings,
    listItems: findListItems(layout, headings),
    links: findLinks(layout),
    tables,
    isMasked: (offset, mask = 'structure') => inRanges(ranges[mask], offset),
  };
}

/**
 * The lines of the text or of one of its masks, without terminators, as
 * `splitLines` gives them: a final terminator leaves a last, empty line.
 * Every view has the same number of lines, each the same length.
 */
export function linesOf(scan: MarkdownScan, view: MaskKind | 'text' = 'text'): string[] {
  return splitLines(view === 'text' ? scan.text : scan.masks[view]);
}

/**
 * YAML between `---` lines, closed by `---` or `...`, or TOML between `+++`
 * lines. The opening line is the document's first, exactly. An opening line
 * that is never closed opens nothing: it is a thematic break.
 */
function readFrontMatterBlock(text: string, index: LineIndex): FrontMatterBlock | null {
  const kind = frontMatterKind(index.lineText(1));
  if (kind === null) return null;
  for (let line = 2; line <= index.lineCount; line += 1) {
    if (!frontMatterCloses(index.lineText(line), kind)) continue;
    const start = index.lineStart(2);
    const end = index.lineStart(line);
    const bodyStart = line < index.lineCount ? index.lineStart(line + 1) : text.length;
    return { kind, raw: text.slice(start, end), start, end, bodyStart, closeLine: line };
  }
  return null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Core {
  readonly lines: ScannedLine[];
  readonly blocks: Block[];
  readonly spans: Range[];
  readonly comments: HtmlComment[];
  readonly covered: ReadonlySet<number>;
  readonly continues: ReadonlySet<number>;
}

/** What each body line is on its own, before anything around it is known. */
interface Shape {
  readonly contentStart: number;
  readonly depth: number;
  readonly indent: number;
  readonly blank: boolean;
  /** An ATX heading, which is a paragraph of one line. */
  readonly atx: boolean;
  /** Opens a block that ends a paragraph above it. */
  readonly interrupts: boolean;
}

/**
 * The block pass, with the inline sweep for code spans and comments run
 * inside it line by line.
 *
 * The two cannot be separate passes. Whether a line opens a fence depends on
 * whether it lies inside a comment, and whether a comment opens depends on
 * whether its `<!--` lies inside a code span.
 */
function scanCore(text: string, index: LineIndex, frontLines: number): Core {
  const count = index.lineCount;
  const lines: Mutable<ScannedLine>[] = [];
  const blocks: Mutable<Block>[] = [];
  const spans: Range[] = [];
  const comments: HtmlComment[] = [];
  const covered = new Set<number>();

  for (let i = 0; i < frontLines; i += 1) {
    const start = index.lineStart(i + 1);
    const end = index.lineEnd(i + 1);
    lines.push(record(i, start, end, start, text.slice(start, end), 0, { frontMatter: true, code: false, html: false }));
  }

  // One shape too many, for a line past the last, would never be read.
  const shapes: Shape[] = [];
  for (let i = frontLines; i < count; i += 1) {
    const start = index.lineStart(i + 1);
    const end = index.lineEnd(i + 1);
    const q = stripQuotes(text, start, Number.POSITIVE_INFINITY);
    const content = text.slice(q.contentStart, end);
    const indent = measureIndent(content);
    const blank = leadIndex(content) === content.length;
    const atx = atxLevel(content) > 0;
    const previous = shapes[shapes.length - 1];
    const interrupts =
      atx ||
      isThematicBreak(content) ||
      setextUnderline(content) !== null ||
      opensComment(content) ||
      listMarker(content) !== null ||
      fenceOpen(content) !== null ||
      isRawTextOpen(content) ||
      (previous !== undefined && q.depth > previous.depth);
    shapes.push({ contentStart: q.contentStart, depth: q.depth, indent, blank, atx, interrupts });
  }
  const shapeOf = (i: number): Shape => shapes[i - frontLines] as Shape;

  // A line continues the paragraph above it when it is not blank, opens
  // nothing of its own, and the line above is not a one-line heading. After a
  // blank line there is no paragraph to continue, and no search asks. Each
  // body line's paragraph ends at `stops`, walked from the bottom up.
  const continues = new Set<number>();
  const stops = new Map<number, number>();
  for (let i = count - 1; i >= frontLines; i -= 1) {
    const shape = shapeOf(i);
    const above = shapes[i - frontLines - 1];
    if (above !== undefined && !above.atx && !shape.blank && !shape.interrupts) continues.add(i + 1);
    stops.set(i, continues.has(i + 2) ? (stops.get(i + 1) as number) : index.lineEnd(i + 1));
  }

  /* ------------------------------------------------------------ inline sweep */

  // Where the last failed search for a closing backtick run stopped, and the
  // last run of each length it passed. Openers come in order, so a later one
  // before that stop lies inside the stretch searched, and closes only if a
  // run of its length lies after it there, which is a lookup.
  let seen: { readonly end: number; readonly last: ReadonlyMap<number, number> } | null = null;

  /** Where the span opened by a run ending at `from` closes, if it does. */
  const closeRun = (from: number, length: number, line: number): number | undefined => {
    // A run of a length the search never saw - one an escape split in two -
    // has no closer either. Reading its absence as any number below `from`
    // gives that answer, and one that is not below it gives it by searching.
    // No run starts at `from`, which follows one, and an opener at `seen.end`
    // finds nothing either way: the comparisons are equivalent at equality.
    if (seen !== null && from < seen.end && (seen.last.get(length) ?? -1) < from) return undefined;
    const stop = stops.get(line) as number;
    const last = new Map<number, number>();
    let at = text.indexOf('`', from);
    while (at >= 0 && at < stop) {
      const run = at;
      while (at < stop && text.charCodeAt(at) === BACKTICK) at += 1;
      if (at - run === length) return at;
      last.set(at - run, run);
      at = text.indexOf('`', at);
    }
    seen = { end: stop, last };
    return undefined;
  };

  // Once one `<!--` has no `-->` after it, no later one has either.
  let closable = true;

  /** Where the comment opened at `at` closes, if it does. */
  const commentEnd = (at: number): number | undefined => {
    // CommonMark 0.31: `<!-->` and `<!--->` are whole, empty comments.
    if (text.startsWith('<!-->', at)) return at + 5;
    if (text.startsWith('<!--->', at)) return at + 6;
    if (!closable) return undefined;
    const close = text.indexOf('-->', at + 4);
    closable = close !== -1;
    return closable ? close + 3 : undefined;
  };

  const pushComment = (start: number, end: number, closed: boolean): void => {
    comments.push({
      start,
      end,
      // An empty comment's `-->` overlaps its `<!--`, and the slice is empty.
      inner: text.slice(start + 4, closed ? end - 3 : end),
      innerStart: start + 4,
      line: index.positionAt(start).line,
      closed,
    });
  };
  /**
   * Sweeps one line from `from`, returning where the next line's sweep may
   * begin: past a span or comment that runs onto a later line, or the line's
   * end. `lead` is the offset at which a `<!--` would open the line, or the
   * end of the line when none can: a sweep never stops there.
   */
  const sweep = (from: number, end: number, line: number, lead: number): number => {
    let at = from;
    while (at < end) {
      const ch = text.charCodeAt(at);
      if (ch === BACKSLASH) {
        // An escaped backtick opens no span, and an escaped `<` no comment.
        at += 2;
      } else if (ch === BACKTICK) {
        let run = at + 1;
        while (run < end && text.charCodeAt(run) === BACKTICK) run += 1;
        const close = closeRun(run, run - at, line);
        if (close === undefined) {
          at = run;
        } else {
          spans.push({ start: at, end: close });
          at = close;
        }
      } else if (text.startsWith('<!--', at)) {
        const close = commentEnd(at);
        if (close !== undefined) {
          pushComment(at, close, true);
          at = close;
        } else if (at === lead) {
          // CommonMark's HTML block: a comment opening a line runs to its
          // `-->`, and one never closed runs to the end of the document.
          pushComment(at, text.length, false);
          return text.length;
        } else {
          at += 4;
        }
      } else {
        at += 1;
      }
    }
    return at;
  };

  /* ------------------------------------------------------------- block pass */

  interface Open {
    readonly block: Mutable<Block>;
    readonly depth: number;
  }
  let fence: (Open & { readonly open: FenceOpen }) | null = null;
  let raw: Open | null = null;
  let indented: Mutable<Block> | null = null;
  let previousBlank = true;
  // The content column of each list item open around the line, innermost last.
  const items: number[] = [];
  let pos = 0;

  const openBlock = (kind: BlockKind, i: number, info: string): Mutable<Block> => {
    const block = { kind, start: index.lineStart(i + 1), end: index.lineEnd(i + 1), line: i + 1, endLine: i + 1, info, closed: kind === 'indented' };
    blocks.push(block);
    return block;
  };
  const extend = (block: Mutable<Block>, i: number): void => {
    block.end = index.lineEnd(i + 1);
    block.endLine = i + 1;
  };
  // Blank lines after an indented block were marked as code in case more
  // code followed; the block ends at its last code line.
  const endIndented = (block: Mutable<Block>, next: number): void => {
    for (let i = block.endLine; i < next; i += 1) (lines[i] as Mutable<ScannedLine>).code = false;
  };

  /** Classifies one line and sweeps it; the caller records whether it was blank. */
  const scanLine = (i: number): void => {
    const start = index.lineStart(i + 1);
    const end = index.lineEnd(i + 1);
    const shape = shapeOf(i);
    const content = text.slice(shape.contentStart, end);
    const push = (kind: Kinds): void => {
      lines.push(record(i, start, end, shape.contentStart, content, shape.depth, kind));
    };

    if (pos > start) {
      // Inside a comment or span opened above: nothing opens a block here.
      covered.add(i + 1);
      push(NONE);
      pos = sweep(pos, end, i, end);
      return;
    }

    const container = fence ?? raw;
    if (container !== null) {
      // A fenced block or raw-text block ends with its block quote.
      const q = stripQuotes(text, start, container.depth);
      if (q.depth === container.depth) {
        const inside = text.slice(q.contentStart, end);
        lines.push(record(i, start, end, q.contentStart, inside, q.depth, fence === null ? HTML : CODE));
        extend(container.block, i);
        if (fence !== null ? fenceCloses(inside, fence.open) : hasRawTextClose(inside)) {
          container.block.closed = true;
          fence = null;
          raw = null;
        }
        return;
      }
      fence = null;
      raw = null;
    }

    // After a blank line, a line left of an item's content is outside it.
    if (!shape.blank && previousBlank) {
      while (items.length > 0 && (items[items.length - 1] as number) > shape.indent) items.pop();
    }
    // Indented code: four columns past the item the line is in, or past the
    // margin outside a list, and never interrupting a paragraph. Four columns
    // inside an item are its text, not code.
    const margin = items[items.length - 1] ?? 0;
    const deep = shape.indent >= margin + 4;
    if (!shape.blank && deep && (previousBlank || indented !== null)) {
      if (indented === null) indented = openBlock('indented', i, '');
      else extend(indented, i);
      push(CODE);
      return;
    }
    if (shape.blank) {
      push(indented === null ? NONE : CODE);
      return;
    }
    if (indented !== null) {
      endIndented(indented, i);
      indented = null;
    }

    // A fence as deep as indented code continues a paragraph instead.
    const open = deep ? null : fenceOpen(content);
    if (open !== null) {
      fence = { block: openBlock('fenced', i, open.info), depth: shape.depth, open };
      push(CODE);
      return;
    }
    if (isRawTextOpen(content)) {
      const block = openBlock('html', i, '');
      push(HTML);
      if (hasRawTextClose(content)) block.closed = true;
      else raw = { block, depth: shape.depth };
      return;
    }

    push(NONE);
    const marker = listMarker(content);
    if (marker !== null) {
      // A marker left of an item's content starts a sibling or an outer item.
      while (items.length > 0 && (items[items.length - 1] as number) > shape.indent) items.pop();
      items.push(itemColumn(shape.indent, marker));
    }
    // A heading ends a list whatever its indentation.
    if (shape.atx) items.length = 0;
    const lead = shape.indent <= 3 ? shape.contentStart + leadIndex(content) : end;
    pos = sweep(shape.contentStart, end, i, lead);
  };

  for (let i = frontLines; i < count; i += 1) {
    scanLine(i);
    // Whether the line was blank to look at, whatever it was classified as:
    // indented code starts only after one.
    previousBlank = shapeOf(i).blank;
  }
  if (indented !== null) endIndented(indented, count);

  markCommentLines(lines, comments);
  return { lines, blocks, spans, comments, covered, continues };
}

/**
 * The column an item's text starts at: past its marker and the one to four
 * spaces after it. With none, or five or more, the text starts one column
 * past the marker, and anything further is indented code.
 */
function itemColumn(indent: number, marker: ListMarker): number {
  const spaces = marker.width - marker.marker.length;
  return indent + marker.marker.length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
}

type Kinds = Pick<ScannedLine, 'frontMatter' | 'code' | 'html'>;
const NONE: Kinds = { frontMatter: false, code: false, html: false };
const CODE: Kinds = { frontMatter: false, code: true, html: false };
const HTML: Kinds = { frontMatter: false, code: false, html: true };

function record(
  i: number,
  start: number,
  end: number,
  contentStart: number,
  content: string,
  quoteDepth: number,
  kinds: Kinds,
): Mutable<ScannedLine> {
  return {
    line: i + 1,
    start,
    end,
    contentStart,
    content,
    indent: measureIndent(content),
    blank: leadIndex(content) === content.length,
    quoteDepth,
    ...kinds,
    comment: false,
  };
}

/** Marks each line whose first non-blank character lies inside a comment. */
function markCommentLines(lines: readonly Mutable<ScannedLine>[], comments: readonly HtmlComment[]): void {
  let c = 0;
  for (const line of lines) {
    if (line.blank) continue;
    const lead = line.contentStart + leadIndex(line.content);
    // No comment ends exactly at a line's first non-blank character: a
    // comment ends in `>`, so one that ends before it ends on an earlier line.
    while (c < comments.length && (comments[c] as HtmlComment).end <= lead) c += 1;
    const comment = comments[c];
    line.comment = comment !== undefined && comment.start <= lead;
  }
}
