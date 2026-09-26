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
import { findEntry, readFrontMatter, scanMarkdown, titleOf, type MarkdownScan } from './vendor/spec-core/markdown/index.js';
import type {
  Directive,
  DirectiveError,
  DirectiveKind,
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

/**
 * Turns a status line into a status, or into nothing.
 *
 * The value is the first run of letters, so "Accepted (0.3.0)." and
 * "Superseded by ADR-0007" normalise to one word while the line as written
 * survives for the report - a reader shown "superseded" learns much less than
 * one shown what it was superseded by.
 */
function toStatus(raw: string, source: SpecStatus['source']): SpecStatus | undefined {
  const trimmed = raw.trim();
  // The word is read through any leading emphasis, so `**Superseded** by
  // ADR-0007` is superseded rather than nothing at all - which is what a rule
  // that required the markers to balance made of it.
  const word = /^[*_]*([a-zA-Z]+)/.exec(trimmed);
  if (!word) return undefined;
  // The label loses emphasis only when it wraps the whole line. `**Draft**` is
  // a status written in bold and reads better without the markers; "Superseded
  // by *ADR-0007*" is a sentence with emphasis inside it, and taking one marker
  // off each end would put a half-mangled line in the report.
  const label = trimmed.replace(/^(\*{1,2}|_{1,2})(.*)\1$/, '$2');
  const value = (word[1] as string).toLowerCase();
  return { value, label, source, active: !INACTIVE_STATUSES.has(value) };
}

/** A document's status as read, or why front matter's could not be, and on which line. */
interface StatusReading {
  status?: SpecStatus;
  problem?: { line: number; message: string };
}

/**
 * The status front matter declares, read as YAML reads it, or undefined when
 * front matter names none.
 *
 * spec-core's reader, which the family's tools share: a quoted value is taken
 * up to its closing quote and a plain one up to a comment, as the one-line
 * reader this replaced did - MADR's own template quotes the status, and
 * `"proposed" # decided at review` is proposed. Quotes and `#` are syntax here
 * and nowhere else.
 *
 * A `status` key decides, whether or not its value can be read. One the reader
 * refuses - continued onto the next line, text after a closing quote, `: ` in
 * a plain value - or one with no word in it declares no status, which leaves
 * the document in force, and says why. It used to be skipped, and then a
 * `## Status` section or a `Status:` line further down was read in its place:
 * `status: "accepted" (2024-05-01)` above a section still saying `Proposed`
 * took an accepted decision out of force.
 */
function fromFrontmatter(scan: MarkdownScan): StatusReading | undefined {
  if (scan.frontMatter === null) return undefined;
  const entry = findEntry(readFrontMatter(scan.text.slice(0, scan.frontMatter.bodyStart)), 'status');
  if (entry === undefined) return undefined;
  const { value } = entry;
  const status = value.kind === 'scalar' ? toStatus(value.scalar.text, 'frontmatter') : undefined;
  if (status !== undefined) return { status };
  const reason =
    value.kind === 'unsupported'
      ? value.reason
      : value.kind === 'list'
        ? 'a list is not a status'
        : value.scalar.text.trim() === ''
          ? 'it is empty'
          : `"${value.scalar.text}" does not begin with a word`;
  return {
    problem: {
      // The reader counts lines from 0 in the text the scan read, which is the
      // document's own lines after any byte-order mark.
      line: entry.line + 1,
      message: `the status in front matter cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place`,
    },
  };
}

/**
 * A `## Status` section, whose value is the first line of prose under it.
 *
 * The section is a heading the scanner reads - ATX or setext, at any level, and
 * never one inside code or a comment, which is where a template keeps a
 * `## Status` it has not filled in. Its text is compared whole, so `## Status
 * of the migration` is a section about something else.
 *
 * A section with nothing but the next heading under it declares no status.
 * There is no guard for that here: an ATX heading begins with `#`, and a value
 * that does not begin with a letter is already no status at all.
 */
function fromHeading(scan: MarkdownScan): SpecStatus | undefined {
  const heading = scan.headings.find((candidate) => candidate.text.toLowerCase() === 'status');
  if (heading === undefined) return undefined;
  const view = scan.masks.directives;
  for (const line of scan.lines.slice(heading.endLine)) {
    const candidate = view.slice(line.start, line.end).trim();
    if (candidate.length > 0) return toStatus(candidate, 'heading');
  }
  return undefined;
}

/**
 * A `**Status:** accepted` line in the document's preamble.
 *
 * Bounded to the preamble - everything before the first heading of level two
 * or deeper - because this form is a line of prose with a colon in it, and a
 * tool that accepts one anywhere in a long document will eventually find one in
 * a sentence. The bound is a heading the scanner reads, so a `##` shown in code
 * or kept in a comment does not end the preamble early.
 */
function fromLabel(scan: MarkdownScan): SpecStatus | undefined {
  const section = scan.headings.find((heading) => heading.level >= 2);
  const view = scan.masks.directives;
  for (const line of section === undefined ? scan.lines : scan.lines.slice(0, section.line - 1)) {
    const found = STATUS_LABEL_RE.exec(view.slice(line.start, line.end));
    if (found) return toStatus(found[2] as string, 'label');
  }
  return undefined;
}

/**
 * The lifecycle status a Markdown document declares about itself.
 *
 * Three spellings are recognised because three are in use, including two in
 * this repository's own ADRs: YAML front-matter (MADR), a `## Status` section
 * (Nygard), and a bold `**Status:**` label. Front-matter wins when it has a
 * `status` key, readable or not - it is machine-readable metadata rather than
 * a convention read out of prose, and a value it cannot read is no licence to
 * read the prose instead.
 *
 * The section and the label are read with code masked, so a document that
 * documents this syntax inside a fence - this project's README does - is not
 * read as declaring a status.
 */
export function parseStatus(source: string): SpecStatus | undefined {
  return statusOf(scanMarkdown(source)).status;
}

function statusOf(scan: MarkdownScan): StatusReading {
  return fromFrontmatter(scan) ?? { status: fromHeading(scan) ?? fromLabel(scan) };
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
    if (block.closed || block.kind === 'indented' || scan.text.slice(block.end).trim() !== '') continue;
    if (scan.lines.slice(block.line, block.endLine).every((line) => line.blank)) continue;
    const opener = (scan.lines[block.line - 1] as { content: string }).content.trim();
    // A raw-text block's first line starts with its tag, or it would be none.
    const what =
      block.kind === 'fenced'
        ? `the code fence ${opener} opened here is never closed`
        : `the ${(/^<[a-z]+/i.exec(opener) as RegExpExecArray)[0].toLowerCase()}> block opened here is never closed`;
    found.push({
      line: block.line,
      message: `${what}, so lines ${block.line} to ${block.endLine}, the rest of the document, are read as code, and no directive in them runs`,
    });
  }
  return found;
}

const DIRECTIVE_RE = /<!--\s*@([a-zA-Z][\w-]*)([\s\S]*?)-->/g;
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
    ...(problem === undefined ? [] : [{ location: at(problem.line), message: problem.message }]),
    ...unclosedBlocks(scan).map(({ line, message }) => ({ location: at(line), message })),
  ];
  return {
    directives,
    errors,
    ...(status === undefined ? {} : { status }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
