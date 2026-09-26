/**
 * Links, images and reference definitions, read from the structure mask so
 * that nothing in code or a comment is one.
 *
 * Six forms: inline `[text](dest "title")`, full and collapsed reference
 * `[text][label]` and `[label][]`, shortcut `[label]`, autolink `<https://x>`,
 * wiki `[[target|text]]`, and the definition `[label]: dest` the reference
 * forms are read through. Each may be an image, written with a leading `!`.
 * A link's text is read again for images, which CommonMark renders there - a
 * badge wrapped in a link has two destinations - and for nothing else; each
 * is listed after the link it lies in.
 *
 * Brackets are paired once per paragraph with a stack, and the tables that
 * say where a destination or a title ends are built once per paragraph, so
 * no bracket searches the text again for its partner. A document of nothing
 * but brackets costs its length.
 *
 * A paragraph ends at `to`, and the character there is a line terminator,
 * which no loop here acts on; nor is any lookup made at the first three
 * offsets of a paragraph, before the shortest `[](` could end. Mutants that
 * move a bound onto those places change no answer, and are equivalent.
 */

import { inRanges, mergeRanges } from '../text/index.js';
import { isMarkdown, isSpaceOrTab, visibleLead, type Layout } from './layout.js';
import type { Link, ScannedLine } from './types.js';

const BANG = 33;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const LESS_THAN = 60;
const GREATER_THAN = 62;
const OPEN_BRACKET = 91;
const BACKSLASH = 92;
const CLOSE_BRACKET = 93;
const LF = 10;
const CR = 13;

/** CommonMark: a link label holds at most 999 characters. */
const MAX_LABEL = 999;

const DEFINITION = /^ {0,3}\[(?!\^)([^\]]+)\]:[ \t]*(<[^<>]*>|\S+)/;
/** What may follow a definition's destination: nothing, or a title after whitespace. */
const TITLE_ONLY = /^(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const AUTOLINK = /<((?:https?|ftp|mailto):[^<>\s]+)>/g;

interface Definition {
  readonly target: string;
  readonly targetStart: number;
  readonly targetEnd: number;
}

export function findLinks(layout: Layout): Link[] {
  const definitions = new Map<string, Definition>();
  const defined = readDefinitions(layout, definitions);
  const bracketed = readBrackets(layout, definitions, new Set(defined.map((d) => d.line)));
  // `<https://x>` as a link's destination or text is part of that link.
  const taken = mergeRanges([...defined, ...bracketed]);
  const autolinks = readAutolinks(layout).filter((link) => !inRanges(taken, link.start));
  return [...defined, ...bracketed, ...autolinks].sort((a, b) => a.start - b.start);
}

/**
 * How labels compare: trimmed, whitespace collapsed, and case folded as
 * CommonMark's reference implementations fold it, down and then up, so that
 * `ẞ` and `SS` are one label.
 */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

/**
 * Definitions come first: the reference forms are read through them, and a
 * definition is conventionally written at the foot of the file, after the
 * links that use it. The first definition of a label wins.
 *
 * `[Note]: this matters` is prose that looks like one, so a definition has
 * nothing after its destination but a title. `[^1]: text` is a footnote.
 */
function readDefinitions(layout: Layout, definitions: Map<string, Definition>): Link[] {
  const { text, structure } = layout;
  const out: Link[] = [];
  for (const line of layout.lines) {
    if (!isMarkdown(line) || !visibleLead(layout, line)) continue;
    const masked = structure.slice(line.contentStart, line.end);
    const match = DEFINITION.exec(masked);
    if (match === null || !TITLE_ONLY.test(masked.slice(match[0].length))) continue;
    const start = line.contentStart + match[0].indexOf('[');
    const label = text.slice(start + 1, start + 1 + (match[1] as string).length).trim();
    if (label.length === 0) continue;
    const written = match[2] as string;
    const end = line.contentStart + match[0].length;
    const angle = written.charCodeAt(0) === LESS_THAN ? 1 : 0;
    const targetStart = end - written.length + angle;
    const targetEnd = end - angle;
    const target = text.slice(targetStart, targetEnd);
    const key = normalizeLabel(label);
    if (!definitions.has(key)) definitions.set(key, { target, targetStart, targetEnd });
    out.push({ form: 'definition', image: false, text: label, target, label, start, end, targetStart, targetEnd, line: line.line });
  }
  return out;
}

function readAutolinks(layout: Layout): Link[] {
  const out: Link[] = [];
  for (const match of layout.structure.matchAll(AUTOLINK)) {
    const start = match.index;
    const end = start + match[0].length;
    out.push({
      form: 'autolink',
      image: false,
      text: '',
      target: match[1] as string,
      label: null,
      start,
      end,
      targetStart: start + 1,
      targetEnd: end - 1,
      line: layout.index.positionAt(start).line,
    });
  }
  return out;
}

/** Pairs `[` with `]` inside a paragraph, innermost first, skipping escaped ones. */
function pairBrackets(structure: string, from: number, to: number): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let at = from; at < to; at += 1) {
    const ch = structure.charCodeAt(at);
    if (ch === BACKSLASH) at += 1;
    else if (ch === OPEN_BRACKET) open.push(at);
    else if (ch === CLOSE_BRACKET) {
      // A `]` with nothing to close pairs with nothing; recorded under
      // `undefined` it would not be found either, so this test changes no
      // answer, only what the map holds.
      const opened = open.pop();
      if (opened !== undefined) pairs.set(opened, at);
    }
  }
  return pairs;
}

/**
 * For every offset of a paragraph, where what starts there ends, or the end
 * of the paragraph when nothing does: a bare destination at the next space or
 * control character, or at the first `)` its own parentheses leave unmatched;
 * a title at its next unescaped closing quote or parenthesis. Filled from the
 * right in one pass, so every lookup is a read.
 */
interface Ends {
  readonly space: Int32Array;
  readonly paren: Int32Array;
  readonly doubleQuote: Int32Array;
  readonly singleQuote: Int32Array;
  readonly closeParen: Int32Array;
  readonly openParen: Int32Array;
}

function endsOf(structure: string, from: number, to: number): Ends {
  const length = to - from;
  const escaped = new Uint8Array(length + 1);
  for (let x = 0; x < length; x += 1) {
    if (escaped[x] === 0 && structure.charCodeAt(from + x) === BACKSLASH) escaped[x + 1] = 1;
  }
  // Two past the last offset: a `(` whose `)` is the paragraph's last
  // character looks one further for the next unmatched `)`, and finds none.
  const make = (): Int32Array => new Int32Array(length + 2).fill(to);
  const ends: Ends = { space: make(), paren: make(), doubleQuote: make(), singleQuote: make(), closeParen: make(), openParen: make() };
  for (let x = length - 1; x >= 0; x -= 1) {
    const at = from + x;
    const ch = structure.charCodeAt(at);
    const plain = escaped[x] === 0;
    ends.space[x] = ch <= 32 || ch === 127 ? at : (ends.space[x + 1] as number);
    // From a `(`, the first unmatched `)` is the first one after the `)` that
    // closes it, which is the first unmatched `)` after the `(`.
    const unmatched = ends.paren[x + 1] as number;
    if (plain && ch === CLOSE_PAREN) ends.paren[x] = at;
    else if (plain && ch === OPEN_PAREN) ends.paren[x] = ends.paren[unmatched + 1 - from] as number;
    else ends.paren[x] = unmatched;
    ends.doubleQuote[x] = plain && ch === DOUBLE_QUOTE ? at : (ends.doubleQuote[x + 1] as number);
    ends.singleQuote[x] = plain && ch === SINGLE_QUOTE ? at : (ends.singleQuote[x + 1] as number);
    ends.closeParen[x] = plain && ch === CLOSE_PAREN ? at : (ends.closeParen[x + 1] as number);
    ends.openParen[x] = plain && ch === OPEN_PAREN ? at : (ends.openParen[x + 1] as number);
  }
  return ends;
}

interface Destination {
  readonly targetStart: number;
  readonly targetEnd: number;
  /** Offset just past the closing `)`. */
  readonly end: number;
}

/**
 * The bracket forms, a paragraph at a time. A paragraph here is a run of
 * Markdown lines, none blank, each continuing the one above: a bracket never
 * pairs across a blank line, a heading, or the start of another block.
 */
function readBrackets(layout: Layout, definitions: ReadonlyMap<string, Definition>, defined: ReadonlySet<number>): Link[] {
  const { lines, continues, structure, text } = layout;
  const out: Link[] = [];
  // The first `]]` at or after the last place one was looked for; the cursor
  // only moves forward, so each is found once.
  let doubleClose = -2;

  const lookup = (from: number, to: number): Definition | undefined =>
    to - from > MAX_LABEL ? undefined : definitions.get(normalizeLabel(text.slice(from, to)));

  // A blank or code line let into a paragraph would bring only characters the
  // structure mask blanks, so this test shapes the runs and changes no link.
  const inParagraph = (i: number): boolean => {
    const line = lines[i];
    return line !== undefined && isMarkdown(line) && !line.blank;
  };

  for (let first = 0; first < lines.length; first += 1) {
    if (!inParagraph(first)) continue;
    let last = first;
    while (inParagraph(last + 1) && continues.has(last + 2)) last += 1;
    const from = (lines[first] as ScannedLine).start;
    const to = (lines[last] as ScannedLine).end;
    const pairs = pairBrackets(structure, from, to);
    let ends: Ends | null = null;

    // Spaces and tabs, and at most one line ending inside the paragraph. The
    // character at `to` ends the paragraph's last line and is none of these.
    const skipSpace = (start: number): number => {
      let at = start;
      while (isSpaceOrTab(structure, at)) at += 1;
      if (at < to) {
        if (structure.charCodeAt(at) === CR) at += 1;
        if (structure.charCodeAt(at) === LF) at += 1;
        while (isSpaceOrTab(structure, at)) at += 1;
      }
      return at;
    };

    const destination = (open: number): Destination | null => {
      const at = skipSpace(open);
      let targetStart: number;
      let targetEnd: number;
      let after: number;
      if (structure.charCodeAt(at) === LESS_THAN) {
        // `<dest>`: no line ending and no unescaped `<` inside.
        let close = at + 1;
        for (;;) {
          if (close >= to) return null;
          const ch = structure.charCodeAt(close);
          if (ch === GREATER_THAN) break;
          if (ch === LESS_THAN || ch === LF || ch === CR) return null;
          close += ch === BACKSLASH ? 2 : 1;
        }
        targetStart = at + 1;
        targetEnd = close;
        after = close + 1;
      } else {
        ends ??= endsOf(structure, from, to);
        const space = ends.space[at - from] as number;
        const paren = ends.paren[at - from] as number;
        targetStart = at;
        // The two are equal only when neither is found, at `to`.
        targetEnd = paren < space ? paren : space;
        after = targetEnd;
        // An empty destination points nowhere a reader can follow.
        if (targetEnd === at) return null;
      }
      let k = skipSpace(after);
      if (structure.charCodeAt(k) === CLOSE_PAREN) return { targetStart, targetEnd, end: k + 1 };
      // A title is separated from the destination by whitespace, and quoted.
      if (k === after) return null;
      ends ??= endsOf(structure, from, to);
      const x = k + 1 - from;
      const quote = structure.charCodeAt(k);
      let close: number;
      if (quote === DOUBLE_QUOTE) close = ends.doubleQuote[x] as number;
      else if (quote === SINGLE_QUOTE) close = ends.singleQuote[x] as number;
      // A title in parentheses may not hold an unescaped `(`.
      else if (quote === OPEN_PAREN) close = (ends.openParen[x] as number) < (ends.closeParen[x] as number) ? to : (ends.closeParen[x] as number);
      else return null;
      // Equal ends are `to`, where the title fails either way. Past `to` the
      // next line opens a block of its own, and none opens with `)`.
      if (close === to) return null;
      k = skipSpace(close + 1);
      return structure.charCodeAt(k) === CLOSE_PAREN ? { targetStart, targetEnd, end: k + 1 } : null;
    };

    const wiki = (at: number, start: number, image: boolean, line: ScannedLine): Link | null => {
      if (structure.charCodeAt(at + 1) !== OPEN_BRACKET) return null;
      if (doubleClose !== -1 && doubleClose < at + 2) doubleClose = structure.indexOf(']]', at + 2);
      const close = doubleClose;
      if (close < 0 || close + 2 > line.end) return null;
      const inner = text.slice(at + 2, close);
      const written = inner.trim();
      const pipe = written.indexOf('|');
      const target = (pipe < 0 ? written : written.slice(0, pipe)).trim();
      // `[[ ]]` and `[[|text]]` name nothing to link to.
      if (target.length === 0) return null;
      const targetStart = at + 2 + inner.length - inner.trimStart().length;
      return {
        form: 'wiki',
        image,
        text: written,
        target,
        label: null,
        start,
        end: close + 2,
        targetStart,
        targetEnd: targetStart + target.length,
        line: line.line,
      };
    };

    const bracket = (at: number, start: number, image: boolean, line: ScannedLine): Link | null => {
      const close = pairs.get(at);
      if (close === undefined) return null;
      const label = (): string => text.slice(at + 1, close).trim();
      if (structure.charCodeAt(close + 1) === OPEN_PAREN) {
        const dest = destination(close + 2);
        if (dest !== null) {
          const target = text.slice(dest.targetStart, dest.targetEnd);
          return { form: 'inline', image, text: label(), target, label: null, start, line: line.line, ...dest };
        }
      } else {
        // Only a `[` is paired, so a second label follows exactly when this finds one.
        const refClose = pairs.get(close + 1);
        if (refClose !== undefined) {
          // `[text][]` is read through its text; `[text][label]` through its label.
          const collapsed = refClose - close - 2 <= MAX_LABEL && text.slice(close + 2, refClose).trim() === '';
          const found = collapsed ? lookup(at + 1, close) : lookup(close + 2, refClose);
          if (found === undefined) return null;
          const written = collapsed ? label() : text.slice(close + 2, refClose).trim();
          return { form: 'reference', image, text: label(), label: written, start, end: refClose + 1, line: line.line, ...found };
        }
      }
      // `[text](not a destination)` is a shortcut followed by text, as CommonMark reads it.
      const found = lookup(at + 1, close);
      if (found === undefined) return null;
      return { form: 'shortcut', image, text: label(), label: label(), start, end: close + 1, line: line.line, ...found };
    };

    let escaped = -1;
    let at = from;
    // Inside a link's text, up to its `]`, where CommonMark reads an image -
    // a badge wrapped in a link - but no other link; then on past the link.
    let textEnd = -1;
    let resume = -1;
    while (at < to) {
      if (textEnd >= 0 && at >= textEnd) {
        at = resume;
        textEnd = -1;
        continue;
      }
      const ch = structure.charCodeAt(at);
      if (ch === BACKSLASH) {
        escaped = at + 1;
        at += 2;
        continue;
      }
      if (ch !== OPEN_BRACKET) {
        at += 1;
        continue;
      }
      const line = lines[layout.index.positionAt(at).line - 1] as ScannedLine;
      // A definition's line holds its label, its destination and its title,
      // and none of them is a link.
      if (defined.has(line.line)) {
        at = line.end;
        continue;
      }
      const image = structure.charCodeAt(at - 1) === BANG && escaped !== at - 1;
      const start = image ? at - 1 : at;
      const link = wiki(at, start, image, line) ?? bracket(at, start, image, line);
      if (textEnd >= 0) {
        // An image that closes inside the text; its own text is alt text, and
        // holds nothing a reader follows.
        if (link !== null && link.image && link.form !== 'wiki' && link.end <= textEnd) {
          out.push(link);
          at = link.end;
        } else {
          at += 1;
        }
      } else if (link === null) {
        at += 1;
      } else {
        out.push(link);
        if (!link.image && link.form !== 'wiki') {
          textEnd = pairs.get(at) as number;
          resume = link.end;
          at += 1;
        } else {
          at = link.end;
        }
      }
    }
    first = last;
  }
  return out;
}
