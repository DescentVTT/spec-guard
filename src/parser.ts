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

import { lineStarts, locate } from './text.js';
import type { Directive, DirectiveError, DirectiveKind, ParseResult, SourceLocation } from './types.js';

/** Every directive spec-guard understands. */
export const KINDS = new Set<string>([
  'assert-absence',
  'assert-count',
  'assert-present',
  'assert-import-absence',
  'assert-import-count',
]);

/** Attributes each directive kind accepts. */
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
};

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
  // split('') keeps UTF-16 index parity with the original string, which
  // [...source] would break on astral characters (and break line numbers).
  const chars = source.split('');
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };

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
    blank(open.index, closeEnd);
  }

  // Inline code spans, using CommonMark's rule: a run of N backticks is closed
  // by the next run of EXACTLY N backticks. Runs of a different length are
  // skipped rather than treated as a closer - otherwise a stray ``` inside a
  // sentence shifts every later pairing by one and un-masks real prose.
  const masked = chars.join('');
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
    blank(open.index, close.index + close.length);
    index = closeIndex;
  }

  return chars.join('');
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
  const directives: Directive[] = [];
  const errors: DirectiveError[] = [];
  const masked = maskCode(source);
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

  return { directives, errors };
}
