/**
 * Recognisers for what one line of Markdown opens.
 *
 * Each takes a line's content - after any block-quote markers, without its
 * terminator - and answers in time linear in the line. They are written as
 * loops where a regular expression would have to backtrack: a line of forty
 * thousand spaces is a document someone can commit.
 */

const TAB = 9;
const SPACE = 32;
const HASH = 35;
const GREATER_THAN = 62;

/** Columns of leading whitespace, a tab reaching the next multiple of four. */
export function measureIndent(content: string): number {
  return measureIndentAt(content, 0, content.length);
}

/** Columns of whitespace from an offset, stopping at the first other character or at `to`. */
export function measureIndentAt(text: string, from: number, to: number): number {
  let width = 0;
  for (let i = from; i < to; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === SPACE) width += 1;
    else if (ch === TAB) width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Index of the first character that is not a space or a tab; the length when there is none. */
export function leadIndex(content: string): number {
  let i = 0;
  while (content.charCodeAt(i) === SPACE || content.charCodeAt(i) === TAB) i += 1;
  return i;
}

/**
 * Where what opens a line starts: just past up to three spaces. After four
 * nothing opens there, and the answer is the end of the line, where every
 * recogniser below finds nothing.
 */
function opening(content: string): number {
  let i = 0;
  while (i < 4 && content.charCodeAt(i) === SPACE) i += 1;
  return i === 4 ? content.length : i;
}

/**
 * Takes up to `maxDepth` block-quote markers off the line starting at
 * `start`: up to three spaces, a `>`, and one optional space, as many times as
 * they repeat. The line ends at a terminator or at the end of the text, and
 * neither is a space or a `>`, so nothing here reads past it.
 */
export function stripQuotes(text: string, start: number, maxDepth: number): { readonly contentStart: number; readonly depth: number } {
  let at = start;
  let depth = 0;
  while (depth < maxDepth) {
    let j = at;
    while (j - at < 3 && (text.charCodeAt(j) === SPACE || text.charCodeAt(j) === TAB)) j += 1;
    if (text.charCodeAt(j) !== GREATER_THAN) break;
    j += 1;
    if (text.charCodeAt(j) === SPACE) j += 1;
    depth += 1;
    at = j;
  }
  return { contentStart: at, depth };
}

export interface FenceOpen {
  /** `` ` `` or `~`. */
  readonly char: string;
  readonly length: number;
  /** Columns before the fence. */
  readonly indent: number;
  readonly info: string;
}

// A line's content holds no terminator, so `.*` reaches its end unanchored.
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)/;
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;

/**
 * A code fence opening the line, at any indentation: a fence inside a list
 * item is indented with the item.
 */
export function fenceOpen(content: string): FenceOpen | null {
  const match = FENCE.exec(content);
  if (match === null) return null;
  const run = match[2] as string;
  const info = match[3] as string;
  // CommonMark: a backtick fence's info string may not hold a backtick. The
  // line is a paragraph whose backticks open code spans, not a fence that
  // swallows the rest of the document.
  if (run.charCodeAt(0) === 0x60 && info.includes('`')) return null;
  return { char: run.charAt(0), length: run.length, indent: measureIndent(match[1] as string), info: info.trim() };
}

/**
 * Whether a line closes an open fence: the same character, at least as many
 * of it, nothing but whitespace after, and no more than three columns deeper
 * than the opening fence.
 */
export function fenceCloses(content: string, fence: FenceOpen): boolean {
  const match = FENCE_CLOSE.exec(content);
  if (match === null) return false;
  const run = match[2] as string;
  return run.charAt(0) === fence.char && run.length >= fence.length && measureIndent(match[1] as string) <= fence.indent + 3;
}

/** The level of an ATX heading opening the line, or 0. */
export function atxLevel(content: string): number {
  const at = opening(content);
  let level = 0;
  while (content.charCodeAt(at + level) === HASH) level += 1;
  // Seven are text. None is 0 whatever follows, which is what this returns.
  if (level > 6) return 0;
  const next = at + level;
  if (next === content.length) return level;
  const ch = content.charCodeAt(next);
  return ch === SPACE || ch === TAB ? level : 0;
}

/** Three or more of one of `*`, `-` or `_`, with nothing but spaces and tabs between. */
export function isThematicBreak(content: string): boolean {
  const at = opening(content);
  const mark = content.charAt(at);
  if (mark !== '*' && mark !== '-' && mark !== '_') return false;
  let count = 0;
  for (let i = at; i < content.length; i += 1) {
    const ch = content.charAt(i);
    if (ch === mark) count += 1;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

/** `=` or `-` for a line that could underline a setext heading, else `null`. */
export function setextUnderline(content: string): '=' | '-' | null {
  let at = opening(content);
  const mark = content.charAt(at);
  if (mark !== '=' && mark !== '-') return null;
  while (content.charAt(at) === mark) at += 1;
  while (content.charAt(at) === ' ' || content.charAt(at) === '\t') at += 1;
  return at === content.length ? mark : null;
}

export interface ListMarker {
  /** Characters of whitespace before the marker. */
  readonly offset: number;
  readonly marker: string;
  /** Characters from the marker's start to the item's text. */
  readonly width: number;
}

const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/**
 * A list marker opening the line, at any indentation. A thematic break that
 * could also be read as one (`- - -`) is a thematic break.
 */
export function listMarker(content: string): ListMarker | null {
  const match = LIST_MARKER.exec(content);
  if (match === null || isThematicBreak(content)) return null;
  const marker = match[2] as string;
  return { offset: (match[1] as string).length, marker, width: marker.length + (match[3] as string).length };
}

const RAW_TEXT_OPEN = /^[ \t]*<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;
const RAW_TEXT_CLOSE = /<\/(?:script|pre|style|textarea)>/i;

/**
 * `<script>`, `<pre>`, `<style>` or `<textarea>` opening the line.
 *
 * These four are the HTML elements whose content CommonMark does not read as
 * Markdown. A page explaining a directive puts an example inside one, and the
 * example must not be read as the directive. `<div>` and `<details>` are not
 * on the list: their content is Markdown, and a decision written inside a
 * collapsed section is still a decision.
 */
export function isRawTextOpen(content: string): boolean {
  return RAW_TEXT_OPEN.test(content);
}

/** Whether a line holds the close tag of any of the four raw-text elements. */
export function hasRawTextClose(content: string): boolean {
  return RAW_TEXT_CLOSE.test(content);
}

/** `<!--` opening the line after up to three spaces. */
export function opensComment(content: string): boolean {
  return content.startsWith('<!--', opening(content));
}
