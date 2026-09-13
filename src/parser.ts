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
 *  1. Directives inside fenced code blocks or inline code spans are IGNORED, so
 *     a README can document the syntax without executing it.
 *  2. Anything that looks like a directive but is malformed is reported as an
 *     error rather than silently skipped - a typo must never turn into a
 *     silently-passing invariant.
 */

import { lineStarts, locate, maskRanges } from './text.js';
import type {
  Directive,
  DirectiveError,
  DirectiveKind,
  ParseResult,
  SourceLocation,
  SpecStatus,
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
  'assert-import-cycle': new Set(['target', 'exclude', 'types', 'expected', 'max', 'allow-empty', 'reason']),
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
 * between them, plus `draft`, which is the one people actually type. The list
 * is closed and short on purpose: every word added to it is another way for a
 * document to go dark, and a rule that stops being enforced without anyone
 * deciding so is the failure this tool exists to prevent. Anything else - an
 * unrecognised word, a misspelling, no status at all - stays in force. See
 * ADR-0010.
 */
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'proposed',
  'rejected',
  'deprecated',
  'superseded',
]);

/** `---\n...\n---` at the very top of the file, and nowhere else. */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

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
 * The value a YAML scalar holds: a quoted one up to its closing quote, a plain
 * one up to a comment.
 *
 * Not a YAML parser, and it does not need to be one - it reads one line. But
 * it has to read that line the way YAML does. MADR's own template quotes the
 * status, and a quote left in leaves no first word to read; a trailing
 * `# decided at review` left in is part of the label; and a regex anchored at
 * both ends of a quoted value read `"proposed" # a comment` as no status at
 * all, which keeps a withdrawn proposal in force.
 */
function yamlScalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  return quoted ? (quoted[2] as string) : text.replace(/\s#.*/, '');
}

/** An ATX heading whose entire text is "Status". */
const STATUS_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+status[ \t]*#*[ \t]*$/i;

/** Any ATX heading of level 2 or deeper - where a document's preamble ends. */
const SECTION_HEADING_RE = /^[ \t]{0,3}#{2,6}[ \t]/;

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

/**
 * Lines, whichever way the file ends them.
 *
 * Splitting on "\n" alone leaves a carriage return on every line of a CRLF
 * document, and a trailing "\r" defeats every `$` below - so a Windows-checkout
 * ADR declared no status at all, silently, which is the one failure mode this
 * feature must not have. Found by running the parser over this repository's own
 * ADR-0003, which happened to be CRLF on disk.
 */
function toLines(masked: string): string[] {
  return masked.split(/\r?\n/);
}

function fromFrontmatter(masked: string): SpecStatus | undefined {
  const block = FRONTMATTER_RE.exec(masked);
  if (!block) return undefined;
  for (const line of toLines(block[1] as string)) {
    const found = STATUS_LABEL_RE.exec(line);
    // Read as YAML here and nowhere else: quotes and `#` are syntax in
    // front-matter and characters in a sentence.
    if (found) return toStatus(yamlScalar(found[2] as string), 'frontmatter');
  }
  return undefined;
}

/**
 * A `## Status` section, whose value is the first line of prose under it.
 *
 * A section with nothing but the next heading under it declares no status.
 * There is no guard for that here: every ATX heading begins with `#`, and a
 * value that does not begin with a letter is already no status at all. The
 * guard this used to carry could not decide anything, which is a different
 * thing from a guard that is merely never hit.
 */
function fromHeading(lines: readonly string[]): SpecStatus | undefined {
  const start = lines.findIndex((line) => STATUS_HEADING_RE.test(line));
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const candidate = (lines[index] as string).trim();
    if (candidate.length === 0) continue;
    return toStatus(candidate, 'heading');
  }
  return undefined;
}

/**
 * A `**Status:** accepted` line in the document's preamble.
 *
 * Bounded to the preamble - everything before the first `##` - because this
 * form is a line of prose with a colon in it, and a tool that accepts one
 * anywhere in a long document will eventually find one in a sentence.
 */
function fromLabel(lines: readonly string[]): SpecStatus | undefined {
  for (const line of lines) {
    if (SECTION_HEADING_RE.test(line)) return undefined;
    const found = STATUS_LABEL_RE.exec(line);
    if (found) return toStatus(found[2] as string, 'label');
  }
  return undefined;
}

/**
 * The lifecycle status a Markdown document declares about itself.
 *
 * Three spellings are recognised because three are in use, including two in
 * this repository's own ADRs: YAML front-matter (MADR), a `## Status` section
 * (Nygard), and a bold `**Status:**` label. Front-matter wins when present -
 * it is machine-readable metadata rather than a convention read out of prose.
 *
 * Code is masked first, so a document that documents this syntax inside a
 * fence - this project's README does - is not read as declaring a status.
 */
export function parseStatus(source: string): SpecStatus | undefined {
  return statusOf(maskCode(source));
}

function statusOf(masked: string): SpecStatus | undefined {
  const lines = toLines(masked);
  return fromFrontmatter(masked) ?? fromHeading(lines) ?? fromLabel(lines);
}

/** An ATX heading of level 1, with any closing sequence taken off. */
const TITLE_RE = /^[ \t]{0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * The document's title: its first level-one heading.
 *
 * Read so that a rule can be shown with the decision it belongs to - "ADR-0011:
 * Layering constraints and import cycles" says more to someone about to edit a
 * file than `docs/adr/0011-layers-and-cycles.md` does. Front-matter is skipped
 * and code is masked, for the same reasons as the status: a README that shows
 * an example ADR inside a fence has not titled itself with the example.
 *
 * Setext headings (a line underlined with `===`) are not read. Nobody writes an
 * ADR that way, and a reader that guessed at underlines would find titles in
 * tables.
 */
export function parseTitle(source: string): string | undefined {
  return titleOf(maskCode(source));
}

function titleOf(masked: string): string | undefined {
  const body = masked.slice(FRONTMATTER_RE.exec(masked)?.[0].length ?? 0);
  for (const line of toLines(body)) {
    const title = TITLE_RE.exec(line)?.[1];
    if (title) return title;
  }
  return undefined;
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
 * Blanks out fenced code blocks and inline code spans, preserving every byte
 * offset and newline so that reported line/column numbers stay exact.
 */
export function maskCode(source: string): string {
  // Ranges, blanked by `maskRanges`, rather than a character array blanked in
  // place. The array was `source.split('')` - one string per UTF-16 unit - and
  // measured at 7.2ms over this repository's 183KB of specs against 0.8ms for
  // the ranges, with identical output on every one of them and on 50,000
  // random inputs. It became worth measuring when `spec-guard query` put a
  // budget on reading specs; see ADR-0012. Offsets still survive, for the reason
  // `maskRanges` gives.

  // Fenced code blocks: ``` or ~~~ (3+ markers), optionally indented up to 3 spaces.
  const fenceRe = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  const fences: Array<{ index: number; end: number; marker: string }> = [];
  while ((match = fenceRe.exec(source)) !== null) {
    fences.push({ index: match.index, end: match.index + match[0].length, marker: match[1] as string });
  }
  const consumed: Array<[number, number]> = [];
  for (let i = 0; i < fences.length; i++) {
    const open = fences[i] as { index: number; end: number; marker: string };
    if (consumed.some(([s, e]) => open.index >= s && open.index < e)) continue;
    const char = open.marker[0] as string;
    let closeEnd = source.length;
    for (let j = i + 1; j < fences.length; j++) {
      const candidate = fences[j] as { index: number; end: number; marker: string };
      if (candidate.marker[0] === char && candidate.marker.length >= open.marker.length) {
        closeEnd = candidate.end;
        break;
      }
    }
    consumed.push([open.index, closeEnd]);
  }

  // Inline code spans, using CommonMark's rule: a run of N backticks is closed
  // by the next run of EXACTLY N backticks. Runs of a different length are
  // skipped rather than treated as a closer - otherwise a stray ``` inside a
  // sentence shifts every later pairing by one and un-masks real prose.
  const masked = maskRanges(source, consumed);
  const spans: Array<[number, number]> = [];
  const runs: Array<{ index: number; length: number }> = [];
  const runRe = /`+/g;
  let run: RegExpExecArray | null;
  while ((run = runRe.exec(masked)) !== null) {
    runs.push({ index: run.index, length: run[0].length });
  }

  for (let index = 0; index < runs.length; index++) {
    const open = runs[index] as { index: number; length: number };
    const closeIndex = runs.findIndex((candidate, position) => position > index && candidate.length === open.length);
    if (closeIndex === -1) continue;
    const close = runs[closeIndex] as { index: number; length: number };
    spans.push([open.index, close.index + close.length]);
    index = closeIndex;
  }

  return maskRanges(masked, spans);
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
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
  return directivesOf(source, maskCode(source), context);
}

/** A whole document: its directives, its status and its title. */
export interface ParsedDocument extends ParseResult {
  title?: string;
}

/**
 * Everything a spec document declares, read with one pass of `maskCode`.
 *
 * `parseDirectives` and `parseTitle` each mask the source, and masking is most
 * of what reading a spec costs; a caller that wants both should not pay twice.
 */
export function parseDocument(source: string, context: ParseContext): ParsedDocument {
  const masked = maskCode(source);
  const parsed = directivesOf(source, masked, context);
  const title = titleOf(masked);
  return title === undefined ? parsed : { ...parsed, title };
}

function directivesOf(source: string, masked: string, context: ParseContext): ParseResult {
  const directives: Directive[] = [];
  const errors: DirectiveError[] = [];
  const starts = lineStarts(source);

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

  const status = statusOf(masked);
  return status ? { directives, errors, status } : { directives, errors };
}
