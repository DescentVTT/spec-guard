/**
 * Markdown directive parser.
 *
 * spec-guard directives are plain HTML comments, which means they are invisible
 * in every Markdown renderer on earth and require no front-matter, no custom
 * fences and no preprocessor:
 *
 *   <!-- @assert-absence target="src/" symbol="LegacyPaymentGateway" -->
 *
 * Two properties matter more than raw speed here:
 *  1. Directives inside code - fenced or indented blocks, code spans, and the
 *     HTML elements whose content is not Markdown - are IGNORED, so a README can
 *     document the syntax without executing it.
 *  2. Anything that looks like a directive but is malformed is reported as an
 *     error rather than silently skipped - a typo must never turn into a
 *     silently-passing invariant.
 *
 * What is code, what is a comment, where the front matter ends and which lines
 * are headings is decided by spec-core's Markdown scanner, copied into
 * `src/vendor` and verified by hash, which every spec-* tool reads documents
 * with. This module keeps what is spec-guard's: the directive grammar, and
 * what a status line means. ADR-0002.
 */

import { lineStarts, locate } from './text.js';
import {
  findEntry,
  keyName,
  readFrontMatter,
  scanMarkdown,
  titleOf,
  type Block,
  type FrontMatterBlock,
  type Heading,
  type MarkdownScan,
} from './vendor/spec-core/markdown/index.js';
import type {
  Directive,
  DirectiveError,
  DirectiveKind,
  MaskedContext,
  MaskedDirective,
  ParseResult,
  SourceLocation,
  SpecStatus,
  SpecWarning,
} from './types.js';

/** Every directive spec-guard understands. */
export const KINDS = new Set<string>([
  'assert-absence',
  'assert-count',
  'assert-present',
  'assert-import-absence',
  'assert-import-count',
  'assert-import-cycle',
  'assert-layers',
  'assert-structure',
]);

/**
 * Which attributes each directive accepts.
 *
 * Exported so a test can assert it entry by entry. It used to be private, and
 * the suite carried a second copy that had fallen five attributes behind - so
 * `comments`, `allow-empty`, `baseline` and `ratchet` could have been dropped
 * from any kind and nothing would have said so.
 */
export const ALLOWED_ATTRIBUTES: Record<DirectiveKind, ReadonlySet<string>> = {
  'assert-absence': new Set([
    'target',
    'symbol',
    'expected',
    'max',
    'glob',
    'exclude',
    'comments',
    'regex',
    'word',
    'ignore-case',
    'allow-empty',
    'baseline',
    'ratchet',
    'reason',
  ]),
  'assert-count': new Set([
    'target',
    'symbol',
    'expected',
    'min',
    'max',
    'glob',
    'exclude',
    'comments',
    'regex',
    'word',
    'ignore-case',
    'allow-empty',
    'reason',
  ]),
  'assert-present': new Set(['file', 'reason']),
  'assert-import-absence': new Set([
    'target',
    'module',
    'exclude',
    'types',
    'expected',
    'max',
    'allow-empty',
    'baseline',
    'ratchet',
    'reason',
  ]),
  'assert-import-count': new Set([
    'target',
    'module',
    'exclude',
    'types',
    'expected',
    'min',
    'max',
    'allow-empty',
    'reason',
  ]),
  // No baseline: a baseline lists files, and a cycle is not a file. Exempting
  // the files of today's cycle would exempt a new one among the same files.
  // `dynamic` only here: import('x') still points a layer the wrong way, but it
  // creates no cycle in the order modules load.
  'assert-import-cycle': new Set(['target', 'exclude', 'types', 'dynamic', 'expected', 'max', 'allow-empty', 'reason']),
  'assert-layers': new Set([
    'target',
    'order',
    'exclude',
    'types',
    'expected',
    'max',
    'allow-empty',
    'baseline',
    'ratchet',
    'reason',
  ]),
  // No `types` or `comments`: a structure rule reads names, never contents.
  'assert-structure': new Set([
    'target',
    'pattern',
    'required',
    'partner',
    'dirs',
    'glob',
    'exclude',
    'expected',
    'max',
    'allow-empty',
    'baseline',
    'ratchet',
    'reason',
  ]),
};

/* --------------------------------------------------------------- the status */

/**
 * Status words that withhold a document's directives from execution.
 *
 * The words that mean "not in force" in Nygard's ADR template and in MADR's
 * between them, plus `draft`, which is the one people actually type, and
 * `archived`, which `spec-brief` writes when it closes a task brief's round -
 * whose directives stated premises and goals that are history once it closes.
 * The list is closed and short on purpose: every word added to it is another
 * way for a document to go dark, and a rule that stops being enforced without
 * anyone deciding so is the failure this tool exists to prevent. Anything else -
 * an unrecognised word, a misspelling, no status at all - stays in force. See
 * ADR-0010 and its amendment.
 */
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'proposed',
  'rejected',
  'deprecated',
  'superseded',
  'archived',
]);

/**
 * The three ways the key is spelled: `**Status**:`, `**Status:**`, `Status:`.
 *
 * Written as alternatives rather than as optional emphasis on either side of
 * the colon, which is what it used to be - and an optional `**` after the colon
 * cannot tell the key's closing marker from the value's opening one, so
 * `Status: **Draft**` reached the report as "Draft**". Here emphasis after the
 * colon is only consumed when it closes emphasis that opened the key. The
 * colon itself is mandatory, which keeps "Status reports are..." from being
 * read as metadata. Leading whitespace in the value is left to `toStatus`,
 * which trims it anyway.
 */
const STATUS_LABEL_RE = /^[ \t]{0,3}(?:(\*\*|__)status(?:\1[ \t]*:|[ \t]*:\1)|status[ \t]*:)(.*)/i;

/** A status line read: the status, or no status and why, where there is more to say than that no word begins it. */
type StatusRead = { readonly status: SpecStatus } | { readonly reason?: string };

/**
 * Turns a status line into a status, or into why it is none.
 *
 * The value is the first run of letters, so "Accepted (0.3.0)." and
 * "Superseded by ADR-0007" normalise to one word while the line as written
 * survives for the report - a reader shown "superseded" learns much less than
 * one shown what it was superseded by.
 */
function toStatus(raw: string, source: SpecStatus['source']): StatusRead {
  const trimmed = raw.trim();
  // The word is read through any leading emphasis, so `**Superseded** by
  // ADR-0007` is superseded rather than nothing at all - which is what a rule
  // that required the markers to balance made of it.
  const word = /^[*_]*([a-zA-Z]+)/.exec(trimmed);
  if (!word) return {};
  // The label loses emphasis only when it wraps the whole line. `**Draft**` is
  // a status written in bold and reads better without the markers; "Superseded
  // by *ADR-0007*" is a sentence with emphasis inside it, and taking one marker
  // off each end would put a half-mangled line in the report.
  const label = trimmed.replace(/^(\*{1,2}|_{1,2})(.*)\1$/, '$2');
  const value = (word[1] as string).toLowerCase();
  return { status: { value, label, source, active: !INACTIVE_STATUSES.has(value) } };
}

/** Why a status written as `text` cannot be read: the reason it was given, or what the text holds. */
function unreadable(text: string, reason: string | undefined): string {
  return reason ?? (text.trim() === '' ? 'it is empty' : `"${text}" does not begin with a word`);
}

/** A document's status as read, or why the status it declares could not be, and on which line. */
interface StatusReading {
  status?: SpecStatus;
  problem?: { line: number; message: string };
}

/**
 * The reading of a status written in the body - a section, or a label - on
 * `line`: the status, or a warning there that it cannot be read, which keeps
 * the document in force. `subject` names where it was written.
 */
function decided(read: StatusRead, line: number, text: string, subject: string, below: string): StatusReading {
  if ('status' in read) return { status: read.status };
  return {
    problem: {
      line,
      message: `${subject} cannot be read (${unreadable(text, read.reason)}), so its status is unrecognised and the document stays in force${below}`,
    },
  };
}

/**
 * What front matter's `status` key holds before it is read as a status: the
 * text of a string, or why there is none, on the key's 1-based line.
 */
type Declared = { readonly line: number } & ({ readonly text: string } | { readonly reason: string });

/**
 * The status front matter declares, or undefined when front matter names none.
 *
 * YAML is read by spec-core's reader, which the family's tools share: a quoted
 * value is taken up to its closing quote and a plain one up to a comment, as
 * the one-line reader this replaced did - MADR's own template quotes the
 * status, and `"proposed" # decided at review` is proposed. Quotes and `#` are
 * syntax here and nowhere else. TOML, between `+++` lines, is read for this
 * one key by `tomlStatus`: a string on one line, quoted as TOML quotes it.
 *
 * A `status` key decides, whether or not its value can be read. One the reader
 * refuses - continued onto the next line, text after a closing quote, `: ` in
 * a plain value, a TOML array or table - or one with no word in it declares no
 * status, which leaves the document in force, and says why. It used to be
 * skipped, and then a `## Status` section or a `Status:` line further down was
 * read in its place: `status: "accepted" (2024-05-01)` above a section still
 * saying `Proposed` took an accepted decision out of force. TOML's key was
 * once not read at all, and `status = "accepted"` above the same section was
 * withheld by it.
 *
 * Front matter opened on the first line and never closed decides the same
 * way. Its author wrote front matter, and what it says cannot be read, so the
 * status is unrecognised and the document stays in force; reading the section
 * or the label in its place took `status: accepted` above a section still
 * saying `Proposed` out of force. `unclosedFrontMatter` says so on line 1,
 * which is why no problem is returned here as well.
 */
function fromFrontmatter(scan: MarkdownScan): StatusReading | undefined {
  if (scan.unclosedFrontMatter !== null) return {};
  const block = scan.frontMatter;
  if (block === null) return undefined;
  const declared =
    block.kind === 'toml' ? tomlStatus(block.raw, (offset) => scan.index.positionAt(block.start + offset).line) : yamlStatus(scan, block);
  if (declared === undefined) return undefined;
  const read = 'text' in declared ? toStatus(declared.text, 'frontmatter') : declared;
  if ('status' in read) return { status: read.status };
  const reason = unreadable('text' in declared ? declared.text : '', read.reason);
  return {
    problem: {
      line: declared.line,
      message: `the status in front matter cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place`,
    },
  };
}

/** The `status` of YAML front matter, as spec-core's reader reads it, or undefined when it has none. */
function yamlStatus(scan: MarkdownScan, block: FrontMatterBlock): Declared | undefined {
  const entry = findEntry(readFrontMatter(scan.text.slice(0, block.bodyStart)), 'status');
  if (entry === undefined) return undefined;
  // The reader counts lines from 0 in the text the scan read, which is the
  // document's own lines after any byte-order mark.
  const line = entry.line + 1;
  const { value } = entry;
  if (value.kind === 'scalar') return { line, text: value.scalar.text };
  return { line, reason: value.kind === 'list' ? 'a list is not a status' : value.reason };
}

/*
 * What ends a line in TOML front matter, as the scanner ends its lines, and
 * then what else ends what is being read. Past the end of the text `charAt`
 * reads the empty string, which each of them includes, so every walk that
 * stops at one of them stops at the end as well.
 */
const TOML_LINE_END = '\n\r';
/** What may follow a value on its line: nothing, or a comment. */
const TOML_VALUE_END = '\n\r#';
/** What ends a number, a boolean or a date: its line, or the array or inline table it is in. */
const TOML_BARE_END = '\n\r#,]}';
const TOML_BARE_KEY = /[A-Za-z0-9_-]/;
/** TOML 1.0's escapes. A later version's `\e` and `\x` are refused, which leaves the document in force. */
const TOML_ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const TOML_HEX_DIGITS: Readonly<Record<string, number>> = { u: 4, U: 8 };

/**
 * The top-level `status` of TOML front matter, as TOML reads it, or undefined
 * when it has none. `raw` is the text between the `+++` lines, and `lineAt`
 * turns an offset in it into a line of the document.
 *
 * Only that key is read, and only as a string on one line - `status =
 * "accepted"` or `status = 'accepted'`, with the blanks and the comment TOML
 * allows around it. spec-guard depends on nothing, and a TOML parser would be
 * its first dependency, for one key. The rest of the block is walked rather
 * than read: strings, arrays and inline tables are stepped over to their ends,
 * whatever lines those are on, so that a `status = "draft"` line inside a
 * multi-line string is not taken for the key, nor a `[1, 2]` line inside an
 * array for a table header, which would end the top level early.
 *
 * The key is the document's when it comes before the first table header, or
 * when a header names it; it is compared as the YAML reader compares keys, so
 * `Status` is it. Any other form of it - a multi-line string, an array, a
 * table, a value that is not a string - is why it cannot be read, as a YAML
 * value the reader refuses is. A `status` in a table is the table's, one in an
 * inline table is that table's, and one in a comment is not written. A line
 * this walk cannot follow is passed over to its end, as the YAML reader passes
 * over a line that is not `key: value`.
 */
function tomlStatus(raw: string, lineAt: (offset: number) => number): Declared | undefined {
  let i = 0;
  const peek = (): string => raw.charAt(i);
  const opens = (delimiter: string): boolean => raw.startsWith(delimiter, i);
  const blank = (): void => {
    while (peek() === ' ' || peek() === '\t') i += 1;
  };
  const toLineEnd = (): void => {
    while (!TOML_LINE_END.includes(peek())) i += 1;
  };
  /** Blanks, newlines and comments: what may come between the items of an array or an inline table. */
  const space = (): void => {
    for (;;) {
      blank();
      if (peek() === '#') toLineEnd();
      if (peek() !== '\n' && peek() !== '\r') return;
      i += 1;
    }
  };

  /** A string on one line, basic or literal, from its opening quote: its text, or why it cannot be read. */
  const string = (): { readonly text: string } | { readonly reason: string } => {
    const quote = peek();
    let text = '';
    for (i += 1; ; i += 1) {
      const ch = peek();
      if (TOML_LINE_END.includes(ch)) return { reason: 'the string is never closed on its line' };
      if (ch === quote) {
        i += 1;
        return { text };
      }
      if (ch !== '\\' || quote === "'") {
        text += ch;
        continue;
      }
      const code = raw.charAt(i + 1);
      // A backslash ending the line escapes nothing, and the string runs off it.
      if (TOML_LINE_END.includes(code)) continue;
      i += 1;
      const simple = TOML_ESCAPES[code];
      if (simple !== undefined) {
        text += simple;
        continue;
      }
      const width = TOML_HEX_DIGITS[code] ?? 0;
      const hex = raw.slice(i + 1, i + 1 + width);
      // Every line of the block ends in a terminator, which is not a digit, so
      // an escape cut short is never all digits.
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return { reason: `"\\${code}" is not an escape this reader knows` };
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff) return { reason: `"\\${code}${hex}" is not a character` };
      text += String.fromCodePoint(point);
      i += width;
    }
  };

  /** Steps over a multi-line string from its opening delimiter to its closing one, or to the end. */
  const multiline = (delimiter: string): void => {
    const quote = delimiter.charAt(0);
    i += 3;
    while (peek() !== '') {
      if (opens(delimiter)) {
        // Up to two quotes just inside the closing delimiter are the string's,
        // so the string ends where the run of quotes does.
        while (peek() === quote) i += 1;
        return;
      }
      // In a basic string a backslash escapes what follows it, a quote included.
      i += peek() === '\\' && quote === '"' ? 2 : 1;
    }
  };

  /** A key, dotted or not, as its parts, and the blanks after it; undefined where none is written. */
  const key = (): string[] | undefined => {
    const parts: string[] = [];
    for (;;) {
      blank();
      if (peek() === '"' || peek() === "'") {
        const read = string();
        if ('reason' in read) return undefined;
        parts.push(read.text);
      } else {
        const from = i;
        while (TOML_BARE_KEY.test(peek())) i += 1;
        if (i === from) return undefined;
        parts.push(raw.slice(from, i));
      }
      blank();
      if (peek() !== '.') return parts;
      i += 1;
    }
  };

  /** The `=` after a key, and the blanks after it. */
  const equals = (): boolean => {
    if (peek() !== '=') return false;
    i += 1;
    blank();
    return true;
  };

  /** Steps over a value to its end, or to what it cannot follow. */
  const value = (): void => {
    if (opens('"""') || opens("'''")) multiline(raw.slice(i, i + 3));
    else if (peek() === '"' || peek() === "'") string();
    else if (peek() === '[' || peek() === '{') brackets();
    else while (!TOML_BARE_END.includes(peek())) i += 1;
  };

  /** Steps over an array or an inline table from its opening bracket to its closing one, or to what it cannot follow. */
  const brackets = (): void => {
    const table = peek() === '{';
    const close = table ? '}' : ']';
    i += 1;
    for (;;) {
      space();
      if (peek() === close) {
        i += 1;
        return;
      }
      if (table && (key() === undefined || !equals())) return;
      value();
      space();
      if (peek() === ',') i += 1;
      else if (peek() !== close) return;
    }
  };

  const isStatus = (part: string): boolean => keyName(part) === 'status';

  /** The value of the top-level `status` key, from just past the key. */
  const status = (parts: readonly string[], at: number): Declared => {
    const line = lineAt(at);
    const cannot = (reason: string): Declared => ({ line, reason });
    if (parts.length > 1) return cannot('a table is not a status');
    if (!equals()) return cannot('"=" does not follow the key');
    if (opens('"""') || opens("'''")) return cannot('a multi-line string is not read; write it as "..." on one line');
    const ch = peek();
    if (ch === '[') return cannot('an array is not a status');
    if (ch === '{') return cannot('a table is not a status');
    if (TOML_VALUE_END.includes(ch)) return cannot('it is empty');
    if (ch !== '"' && ch !== "'") return cannot('it is not a string; quote it');
    const read = string();
    if ('reason' in read) return cannot(read.reason);
    blank();
    return TOML_VALUE_END.includes(peek()) ? { line, text: read.text } : cannot('text follows a closing quote');
  };

  let root = true;
  while (peek() !== '') {
    blank();
    const at = i;
    if (peek() === '[') {
      const array = opens('[[');
      i += array ? 2 : 1;
      const header = key();
      if (header !== undefined && isStatus(header[0] as string)) {
        return { line: lineAt(at), reason: array ? 'an array of tables is not a status' : 'a table is not a status' };
      }
      root = false;
    } else {
      // A blank line or a comment holds no key, so it is passed over as a
      // line that cannot be followed is.
      const parts = key();
      if (parts !== undefined && root && isStatus(parts[0] as string)) return status(parts, at);
      if (parts !== undefined && equals()) value();
    }
    toLineEnd();
    i += 1;
  }
  return undefined;
}

/** What a status in the body that cannot be read says of the spellings ranked below it. */
const NOT_READ_BELOW = '; a status written elsewhere in the document is not read in its place';

/**
 * A `## Status` section, whose value is the first line of prose under it,
 * before the next heading.
 *
 * The section is a heading the scanner reads - ATX or setext, at any level, and
 * never one inside code or a comment, which is where a template keeps a
 * `## Status` it has not filled in. Its text is compared whole, so `## Status
 * of the migration` is a section about something else.
 *
 * A section that is there decides, as front matter's key does: one whose value
 * cannot be read - nothing under it before the next heading, or a line that
 * begins with no word - keeps the document in force, says so on that line, and
 * the label is not read in its place. It used to be: `## Status` over
 * `2024-05-01: accepted` handed over to a `Status: draft` line in the preamble,
 * and a status that cannot be read withheld a document by accident.
 */
function fromHeading(scan: MarkdownScan): StatusReading | undefined {
  const at = scan.headings.findIndex((candidate) => candidate.text.toLowerCase() === 'status');
  if (at === -1) return undefined;
  const heading = scan.headings[at] as Heading;
  const next = scan.headings[at + 1];
  const subject = `the status under the heading "${heading.text}"`;
  const view = scan.masks.directives;
  for (const line of scan.lines.slice(heading.endLine, next === undefined ? undefined : next.line - 1)) {
    const candidate = view.slice(line.start, line.end).trim();
    if (candidate.length > 0) return decided(toStatus(candidate, 'heading'), line.line, candidate, subject, NOT_READ_BELOW);
  }
  return decided({}, heading.line, '', subject, NOT_READ_BELOW);
}

/**
 * A `**Status:** accepted` line in the document's preamble.
 *
 * Bounded to the preamble - everything before the first heading of level two
 * or deeper - because this form is a line of prose with a colon in it, and a
 * tool that accepts one anywhere in a long document will eventually find one in
 * a sentence. The bound is a heading the scanner reads, so a `##` shown in code
 * or kept in a comment does not end the preamble early. The first such line
 * decides, and one whose value cannot be read says so, as a section does.
 */
function fromLabel(scan: MarkdownScan): StatusReading | undefined {
  const section = scan.headings.find((heading) => heading.level >= 2);
  const view = scan.masks.directives;
  for (const line of section === undefined ? scan.lines : scan.lines.slice(0, section.line - 1)) {
    const found = STATUS_LABEL_RE.exec(view.slice(line.start, line.end));
    if (found) return decided(toStatus(found[2] as string, 'label'), line.line, (found[2] as string).trim(), 'the status label', '');
  }
  return undefined;
}

/**
 * The lifecycle status a Markdown document declares about itself.
 *
 * Three spellings are recognised because three are in use, including two in
 * this repository's own ADRs: front-matter (MADR's YAML, or TOML between `+++`
 * lines), a `## Status` section (Nygard), and a bold `**Status:**` label.
 * Front-matter wins when it has a `status` key, readable or not, and when it
 * never closes - it is machine-readable metadata rather than a convention read
 * out of prose, and front matter that cannot be read is no licence to read the
 * prose instead.
 *
 * The section and the label are read with code masked, so a document that
 * documents this syntax inside a fence - this project's README does - is not
 * read as declaring a status.
 */
export function parseStatus(source: string): SpecStatus | undefined {
  return statusOf(scanMarkdown(source)).status;
}

function statusOf(scan: MarkdownScan): StatusReading {
  return fromFrontmatter(scan) ?? fromHeading(scan) ?? fromLabel(scan) ?? {};
}

/**
 * The document's title: its first level-one heading, ATX or setext, as the
 * scanner reads it.
 *
 * Read so that a rule can be shown with the decision it belongs to - "ADR-0011:
 * Layering constraints and import cycles" says more to someone about to edit a
 * file than `docs/adr/0011-layers-and-cycles.md` does. Front matter, code and
 * comments are not read, for the same reasons as the status: a README that
 * shows an example ADR inside a fence, or a template that keeps its heading in
 * a comment, has not titled itself with it. A first level-one heading with no
 * text is no title.
 */
export function parseTitle(source: string): string | undefined {
  return titleIn(scanMarkdown(source));
}

function titleIn(scan: MarkdownScan): string | undefined {
  const title = titleOf(scan)?.text;
  return title === '' ? undefined : title;
}

/**
 * A code fence or raw-text HTML block that is never closed and runs to the end
 * of the document, with something in it after its opening line.
 *
 * CommonMark reads one so, and so does the scanner: every line after it is
 * code, and a directive there does not run. That is a document whose rules
 * stop at a typo, and nothing else says so - a run over it is as green as one
 * over a document that states no more rules. One closed by the end of its
 * block quote hides nothing past the quote, and one on the last line hides
 * nothing at all.
 */
function unclosedBlocks(scan: MarkdownScan): Array<{ line: number; message: string }> {
  const found: Array<{ line: number; message: string }> = [];
  for (const block of scan.blocks) {
    // An indented block is always closed: it ends where the indentation does.
    if (block.closed || scan.text.slice(block.end).trim() !== '') continue;
    if (scan.lines.slice(block.line, block.endLine).every((line) => line.blank)) continue;
    const opener = (scan.lines[block.line - 1] as { content: string }).content.trim();
    const what =
      block.kind === 'fenced'
        ? `the code fence ${opener} opened here is never closed`
        : `the <${block.tag}> block opened here is never closed`;
    found.push({
      line: block.line,
      message: `${what}, so lines ${block.line} to ${block.endLine}, the rest of the document, are read as code, and no directive in them runs`,
    });
  }
  return found;
}

/**
 * Front matter opened on the first line and never closed, with something
 * after its opening line.
 *
 * The scanner reads it as CommonMark does: the first line is a thematic break
 * and every line after it Markdown, so none of it is front matter, and a
 * directive under the opening line runs. Its status is read as a front-matter
 * status that cannot be read is (ADR-0010): unrecognised, with the document
 * in force and neither the section nor the label read in its place. The
 * report says so on that line, in the words the unreadable status is given,
 * since both leave a document in force that its prose may say is not. One
 * with nothing after its opening line has nothing in it to lose.
 */
function unclosedFrontMatter(scan: MarkdownScan): Array<{ line: number; message: string }> {
  const open = scan.unclosedFrontMatter;
  if (open === null || scan.lines.slice(open.line).every((line) => line.blank)) return [];
  const delimiter = open.kind === 'yaml' ? '---' : '+++';
  return [
    {
      line: open.line,
      message: `the front matter opened here with ${delimiter} is never closed, so none of it is read as front matter, its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place; close it with ${delimiter} on a line of its own`,
    },
  ];
}

const DIRECTIVE_RE = /<!--\s*@([a-zA-Z][\w-]*)([\s\S]*?)-->/g;
/** The opening of a directive, `<!-- @kind`, wherever it is written. */
const DIRECTIVE_SHAPE_RE = /<!--\s*@([a-zA-Z][\w-]*)/g;
const ATTRIBUTE_RE =
  /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'=<>`]+)))?/g;

export interface ParseContext {
  /** Absolute path of the spec file. */
  file: string;
  /** Display path, relative to root, forward slashes. */
  relativeFile: string;
}

/**
 * The source with its code blanked and its comments kept, offset for offset:
 * the scanner's directives mask, behind the byte-order mark it took off. A
 * match at an offset of this is at that offset of the source, so a directive
 * is reported on the line and in the column a person finds it.
 */
function directivesView(source: string, scan: MarkdownScan): string {
  return source.slice(0, scan.bom) + scan.masks.directives;
}

/**
 * Blanks out what is not read for directives - fenced and indented code, code
 * spans, `<script>`, `<pre>`, `<style>` and `<textarea>` blocks, and front
 * matter - preserving every offset and line terminator, so that reported
 * line/column numbers stay exact. Comments are kept: a directive is one.
 *
 * spec-core's scanner decides all of it, in one pass, by CommonMark's rules for
 * what is code and what is a comment: whichever of a code span and a comment
 * opens first wins, and a code span ends with its paragraph. ADR-0002.
 */
export function maskCode(source: string): string {
  return directivesView(source, scanMarkdown(source));
}

/**
 * Undoes the escapes a quoted value needs: `\"`, `\'` and `\\`.
 *
 * Every other backslash is kept. Until 0.10.2 any backslash escaped the next
 * character, so `symbol="\bTODO\b" regex="true"` searched for `bTODOb` and
 * found nothing - a rule that passed because its pattern had been rewritten
 * under it - and `exclude="src\gen"` excluded `srcgen`.
 */
function unescape(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
}

/** Parses `name="value"` pairs; bare `name` is shorthand for `name="true"`. */
export function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(input)) !== null) {
    const name = (match[1] as string).toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4];
    attributes[name] = raw === undefined ? 'true' : unescape(raw);
  }
  return attributes;
}

/** Extracts every spec-guard directive from a Markdown source string. */
export function parseDirectives(source: string, context: ParseContext): ParseResult {
  return directivesOf(source, scanMarkdown(source), context);
}

/** A whole document: its directives, its status and its title. */
export interface ParsedDocument extends ParseResult {
  title?: string;
}

/**
 * Everything a spec document declares, read with one scan.
 *
 * `parseDirectives` and `parseTitle` each scan the source, and scanning is most
 * of what reading a spec costs; a caller that wants both should not pay twice.
 */
export function parseDocument(source: string, context: ParseContext): ParsedDocument {
  const scan = scanMarkdown(source);
  const parsed = directivesOf(source, scan, context);
  const title = titleIn(scan);
  return title === undefined ? parsed : { ...parsed, title };
}

function directivesOf(source: string, scan: MarkdownScan, context: ParseContext): ParseResult {
  const directives: Directive[] = [];
  const errors: DirectiveError[] = [];
  // Lines as they have always been counted here, by `\n`, so a directive is
  // reported where it was. The scanner counts a lone `\r` as well, and reads
  // the document by it, but a line number in a report is not the place to
  // change what a line is.
  const starts = lineStarts(source);
  const masked = directivesView(source, scan);

  DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_RE.exec(masked)) !== null) {
    const kind = (match[1] as string).toLowerCase();
    const body = match[2] as string;
    const raw = source.slice(match.index, match.index + match[0].length);
    const position = locate(starts, match.index);
    const location: SourceLocation = {
      file: context.file,
      relativeFile: context.relativeFile,
      line: position.line,
      column: position.column,
    };

    if (!KINDS.has(kind)) {
      // Only complain about things that clearly meant to be a directive.
      if (kind.startsWith('assert')) {
        errors.push({
          location,
          raw,
          message: `Unknown directive "@${kind}". Expected one of: ${[...KINDS].map((k) => `@${k}`).join(', ')}.`,
        });
      }
      continue;
    }

    const attributes = parseAttributes(body);
    const allowed = ALLOWED_ATTRIBUTES[kind as DirectiveKind];
    const unknown = Object.keys(attributes).filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      errors.push({
        location,
        raw,
        message: `Unknown attribute${unknown.length > 1 ? 's' : ''} ${unknown
          .map((name) => `"${name}"`)
          .join(', ')} on @${kind}. Allowed: ${[...allowed].join(', ')}.`,
      });
      continue;
    }

    directives.push({ kind: kind as DirectiveKind, attributes, location, raw });
  }

  const { status, problem } = statusOf(scan);
  const at = (line: number): SourceLocation => ({ file: context.file, relativeFile: context.relativeFile, line, column: 1 });
  const warnings: SpecWarning[] = [
    ...unclosedFrontMatter(scan).map(({ line, message }) => ({ location: at(line), kind: 'unclosed-front-matter' as const, message })),
    ...(problem === undefined ? [] : [{ location: at(problem.line), kind: 'unreadable-status' as const, message: problem.message }]),
    ...unclosedBlocks(scan).map(({ line, message }) => ({ location: at(line), kind: 'unclosed-block' as const, message })),
  ];
  const hidden = maskedDirectives(source, masked, scan, starts, context);
  return {
    directives,
    errors,
    ...(status === undefined ? {} : { status }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(hidden.length === 0 ? {} : { masked: hidden }),
  };
}

/**
 * Every directive-shaped comment the masked copy blanked: `<!--`, an `@`, and
 * a kind that begins with `assert`, as the parser's own test of what "clearly
 * meant to be a directive" is.
 *
 * Found in the source as written, where the parser reads the masked copy, and
 * kept when its `<!--` is blanked there. A kind is read in any case, as the
 * parser reads one.
 *
 * One search finds them all, and a document with no `<!-- @` in it costs no
 * more than that. A search for `@assert` used to come first, to spare the
 * documents without one; it could decide nothing this one does not, and it
 * saved nothing measurable (ADR-0002).
 */
function maskedDirectives(source: string, view: string, scan: MarkdownScan, starts: readonly number[], context: ParseContext): MaskedDirective[] {
  const found: MaskedDirective[] = [];
  for (const match of source.matchAll(DIRECTIVE_SHAPE_RE)) {
    if (view.startsWith('<!--', match.index) || !(match[1] as string).toLowerCase().startsWith('assert')) continue;
    const { line, column } = locate(starts, match.index);
    found.push({ location: { file: context.file, relativeFile: context.relativeFile, line, column }, inside: maskedBy(scan, match.index - scan.bom) });
  }
  return found;
}

const BLOCKS: Readonly<Record<Block['kind'], MaskedContext>> = { fenced: 'fenced code', indented: 'indented code', html: 'raw HTML' };

/**
 * What blanked an offset of the scanned text: the front matter, a block, or
 * else a code span, the one construct left. The body starts at 0 in a document
 * with no front matter, so nothing is before it.
 */
function maskedBy(scan: MarkdownScan, offset: number): MaskedContext {
  if (offset < scan.bodyStart) return 'front matter';
  const block = scan.blocks.find((candidate) => candidate.start <= offset && offset < candidate.end);
  return block === undefined ? 'code span' : BLOCKS[block.kind];
}
