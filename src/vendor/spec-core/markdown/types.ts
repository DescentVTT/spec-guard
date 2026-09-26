/**
 * The shapes a scan produces.
 *
 * Every structure carries absolute UTF-16 offsets into the scanned text - the
 * text after any byte-order mark - and a 1-based line. Nothing holds a copy of
 * the document that a rule could match against and then report somewhere else.
 */

import type { LineIndex, Range } from '../text/index.js';

/** The three masked copies of a document; see {@link Masks}. */
export type MaskKind = 'structure' | 'prose' | 'directives';

/**
 * Copies of the text with some constructs blanked to spaces.
 *
 * Every copy has the length of the text and its line terminators at the same
 * offsets, so a match at an offset of a mask is at that offset of the text, on
 * the same line and in the same column.
 */
export interface Masks {
  /**
   * Front matter, block code, raw-text HTML, code spans and comments blanked:
   * what counts as structure. Headings, list items, links and tables are read
   * from this copy.
   */
  readonly structure: string;
  /**
   * Front matter and comments blanked, code kept: what counts as content. A
   * section holding only a template hint in a comment is empty; one holding
   * only a code sample is not.
   */
  readonly prose: string;
  /**
   * Front matter, block code, raw-text HTML and code spans blanked, comments
   * kept: where a directive written in a comment is read, so that one shown in
   * a code sample is not.
   */
  readonly directives: string;
}

export type FrontMatterKind = 'yaml' | 'toml';

/** The metadata block at the top of a document. */
export interface FrontMatterBlock {
  /** YAML between `---` lines, closed by `---` or `...`; TOML between `+++` lines. */
  readonly kind: FrontMatterKind;
  /** The text between the delimiter lines. */
  readonly raw: string;
  /** Offset of the first character of `raw`. */
  readonly start: number;
  /** Offset just past `raw`: the start of the closing delimiter line. */
  readonly end: number;
  /** Offset just past the closing delimiter line and its terminator. */
  readonly bodyStart: number;
  /** 1-based line of the closing delimiter. */
  readonly closeLine: number;
}

/**
 * One line of the document. Every line has one, front matter included, so the
 * record for line `n` is at index `n - 1`.
 */
export interface ScannedLine {
  /** 1-based. */
  readonly line: number;
  /** Offset of the line's first character. */
  readonly start: number;
  /** Offset just past the line, before its terminator. */
  readonly end: number;
  /**
   * Offset of the first character after the block-quote markers. In a fenced
   * block only the markers of the quote holding the fence are taken off: a `>`
   * written inside the code is code.
   */
  readonly contentStart: number;
  /** The line from `contentStart`, indentation intact. */
  readonly content: string;
  /** Indentation of `content` in columns, a tab reaching the next multiple of four. */
  readonly indent: number;
  /** `content` is empty or whitespace. */
  readonly blank: boolean;
  readonly quoteDepth: number;
  /** Part of the front matter, delimiters included. */
  readonly frontMatter: boolean;
  /** Part of a fenced or indented code block, fences included. */
  readonly code: boolean;
  /** Part of a `<script>`, `<pre>`, `<style>` or `<textarea>` block. */
  readonly html: boolean;
  /**
   * The line's first non-blank character is inside an HTML comment. What is
   * written there is not Markdown, whatever it looks like. Never set on a blank
   * line.
   */
  readonly comment: boolean;
}

export type BlockKind = 'fenced' | 'indented' | 'html';

/** A block whose content is not Markdown: code, or raw-text HTML. */
export interface Block {
  readonly kind: BlockKind;
  /** Offset of the first line's first character. */
  readonly start: number;
  /** Offset just past the last line, before its terminator. */
  readonly end: number;
  /** 1-based first line: the opening fence or tag, or the first code line. */
  readonly line: number;
  /** 1-based last line. */
  readonly endLine: number;
  /** A fenced block's info string, trimmed; empty for the other kinds. */
  readonly info: string;
  /**
   * Whether a closing fence or closing tag ended the block. One that runs to
   * the end of the document or of its block quote is not closed. An indented
   * block always is.
   */
  readonly closed: boolean;
}

export interface HtmlComment {
  /** Offset of `<!--`. */
  readonly start: number;
  /** Offset just past `-->`, or the end of the text for one never closed. */
  readonly end: number;
  /** The text between `<!--` and `-->`. */
  readonly inner: string;
  readonly innerStart: number;
  /** 1-based line of `<!--`. */
  readonly line: number;
  /**
   * False for a comment that opens a line and is never closed, which runs to
   * the end of the document as CommonMark's HTML block does. A `<!--` in the
   * middle of a line with no `-->` after it is text, and is not a comment.
   */
  readonly closed: boolean;
}

export type HeadingForm = 'atx' | 'setext';

export interface Heading {
  readonly form: HeadingForm;
  readonly level: number;
  /**
   * The text a reader sees: trimmed, without an ATX closing sequence, and
   * without any comment in it. Code spans are kept as written.
   */
  readonly text: string;
  /** GitHub's slug of `text`. */
  readonly slug: string;
  /**
   * The anchor GitHub gives the heading: its slug, with `-1`, `-2` and so on
   * appended for the second and later headings that slug the same.
   */
  readonly anchor: string;
  /** Offset of the heading line's content, after any block-quote markers. */
  readonly start: number;
  /** Offset just past the heading line, or past a setext heading's underline. */
  readonly end: number;
  /** Offsets of `text` as written; a comment inside it is between them. */
  readonly textStart: number;
  readonly textEnd: number;
  /** 1-based line of the heading text. */
  readonly line: number;
  /** 1-based last line: the underline of a setext heading. */
  readonly endLine: number;
}

/** A heading and everything under it up to the next heading at its level or above. */
export interface Section {
  readonly heading: Heading;
  /** Offset of the heading line's first character. */
  readonly start: number;
  /** Offset of the line after the heading. */
  readonly bodyStart: number;
  /** Offset of the first line of the next heading at this level or above, or the end of the text. */
  readonly end: number;
  /** 1-based line after the section: that heading's line, or one past the last line. */
  readonly endLine: number;
}

export interface ListItem {
  /** Offset of the marker line's content, after any block-quote markers. */
  readonly start: number;
  /** Offset just past the item's last line: continuations and nested content included. */
  readonly end: number;
  /** Offset of the marker. */
  readonly markerStart: number;
  /** `-`, `*`, `+`, or a number followed by `.` or `)`. */
  readonly marker: string;
  /** Offset of the item's text, after the marker and any checkbox. */
  readonly textStart: number;
  /**
   * The character inside a task checkbox, or `null` without one. GFM's are
   * space, `x` and `X`; `~ - ? ! * / +` are read too, and what each means is
   * the caller's decision.
   */
  readonly checkbox: string | null;
  /** Offset of the checkbox's `[`. */
  readonly checkboxStart: number | null;
  /** The text of the marker line, trimmed. */
  readonly firstLine: string;
  /** Everything from `textStart` to `end`. */
  readonly body: string;
  /**
   * `body` read from the structure mask. Anything that searches item text for
   * meaning reads this, or a fenced example nested under the item speaks for it.
   */
  readonly maskedBody: string;
  /** 1-based line of the marker. */
  readonly line: number;
  /** 1-based last line the item owns. */
  readonly endLine: number;
  /** How many list items enclose this one; a top-level item is `0`. */
  readonly depth: number;
  /** Columns before the marker, after any block-quote markers. */
  readonly indent: number;
  readonly quoteDepth: number;
}

export type LinkForm = 'inline' | 'reference' | 'shortcut' | 'autolink' | 'wiki' | 'definition';

export interface Link {
  /**
   * `[text](dest)`, `[text][label]` or `[label][]`, `[label]`, `<https://...>`,
   * `[[target|text]]`, or a reference definition `[label]: dest`.
   */
  readonly form: LinkForm;
  /** Written with a leading `!`: an image, or an embed in the wiki form. */
  readonly image: boolean;
  /** The label as written, trimmed. Empty for an autolink; the label for a definition. */
  readonly text: string;
  /** The destination as written, without angle brackets. */
  readonly target: string;
  /** The reference label of the reference, shortcut and definition forms; `null` for the others. */
  readonly label: string | null;
  /**
   * Offsets of the whole construct, a leading `!` included. An image may lie
   * inside a link's text, and is listed after that link.
   */
  readonly start: number;
  readonly end: number;
  /**
   * Offsets of `target` as written. For the inline form and a definition they
   * lie inside the construct, inside any angle brackets, so replacing them
   * rewrites the destination. For the reference and shortcut forms they lie
   * inside the definition: the use has no destination of its own, and the
   * line a human edits to fix one is the definition.
   */
  readonly targetStart: number;
  readonly targetEnd: number;
  /** 1-based line of `start`. */
  readonly line: number;
}

export interface TableCell {
  /** The cell as written, trimmed. */
  readonly text: string;
  /** Offsets of the trimmed text. */
  readonly start: number;
  readonly end: number;
}

export interface TableRow {
  readonly cells: readonly TableCell[];
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface Table {
  /** Offset of the header line's content. */
  readonly start: number;
  /** Offset just past the last row, or past the delimiter row of a table with none. */
  readonly end: number;
  /** 1-based line of the header. */
  readonly line: number;
  /** 1-based last line. */
  readonly endLine: number;
  readonly headers: readonly TableCell[];
  readonly rows: readonly TableRow[];
}

export interface MarkdownScan {
  /** The scanned text: the input without a leading byte-order mark. */
  readonly text: string;
  /** Code units taken off the input before scanning: 1 for a byte-order mark, else 0. */
  readonly bom: number;
  readonly index: LineIndex;
  /** One record per line of `index`, front matter included. */
  readonly lines: readonly ScannedLine[];
  readonly frontMatter: FrontMatterBlock | null;
  /** Offset where the body starts, after any front matter. */
  readonly bodyStart: number;
  /** Code blocks and raw-text HTML blocks, in order. */
  readonly blocks: readonly Block[];
  /** Code spans, backticks included, in order. */
  readonly codeSpans: readonly Range[];
  readonly comments: readonly HtmlComment[];
  readonly masks: Masks;
  /** ATX and setext headings, in order. */
  readonly headings: readonly Heading[];
  readonly listItems: readonly ListItem[];
  /** Links, images and definitions, in order of `start`. */
  readonly links: readonly Link[];
  readonly tables: readonly Table[];
  /** Whether an offset is blanked in a mask, the structure mask unless another is named. */
  isMasked(offset: number, mask?: MaskKind): boolean;
}
