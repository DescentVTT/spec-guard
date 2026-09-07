/**
 * Comment classification.
 *
 * A documented codebase defeats a plain text search in the most ironic way
 * available: the comment recording that a symbol was deleted is itself a match
 * for that symbol. `@assert-absence symbol="LegacyThing"` then fails on
 *
 *   // LegacyThing was removed in ADR-398
 *
 * which is the sentence proving the assertion true. So matches are classified
 * and, by default, those inside comments do not count.
 *
 * The scanner tracks strings as well as comments, and it has to: a `//` inside
 * a string literal is not a comment, and misreading one is the dangerous
 * direction. Consider
 *
 *   const url = "http://example.com"; const x = LegacyThing;
 *
 * Treating `//` in that URL as a comment start would hide a real use of
 * LegacyThing and turn a violation into a silent pass. Every uncertainty here
 * therefore resolves the same way: **when in doubt, it is code**. A match
 * wrongly kept is a visible failure someone can argue with; a match wrongly
 * dropped is a lie.
 *
 * Languages it does not recognise get no comment ranges at all, so their
 * matches all count - and the result says so rather than implying the file was
 * understood.
 */

import path from 'node:path';

interface StringRule {
  open: string;
  close: string;
  /** Backslash escapes apply inside. */
  escape: boolean;
}

export interface CommentSyntax {
  name: string;
  /** Prefixes that comment out the rest of the line. */
  line: readonly string[];
  /** Delimiter pairs for block comments. */
  block: ReadonlyArray<readonly [string, string]>;
  /** Block comments nest, as in Rust. */
  nested: boolean;
  /** Literal forms that may contain comment-looking text. */
  strings: readonly StringRule[];
}

const QUOTES: readonly StringRule[] = [
  { open: '"', close: '"', escape: true },
  { open: "'", close: "'", escape: true },
];

const C_LIKE: CommentSyntax = {
  name: 'c-like',
  line: ['//'],
  block: [['/*', '*/']],
  nested: false,
  strings: QUOTES,
};

const JS_LIKE: CommentSyntax = {
  ...C_LIKE,
  name: 'javascript',
  strings: [...QUOTES, { open: '`', close: '`', escape: true }],
};

const C_SHARP: CommentSyntax = {
  ...C_LIKE,
  name: 'c#',
  // Verbatim strings come first so @" wins over ".
  strings: [{ open: '@"', close: '"', escape: false }, ...QUOTES],
};

const RUST: CommentSyntax = {
  name: 'rust',
  line: ['//'],
  block: [['/*', '*/']],
  // Rust block comments nest, so /* /* */ */ is one comment, not one and a half.
  nested: true,
  strings: [
    { open: 'r#"', close: '"#', escape: false },
    { open: 'r"', close: '"', escape: false },
    ...QUOTES,
  ],
};

const GO: CommentSyntax = {
  ...C_LIKE,
  name: 'go',
  strings: [...QUOTES, { open: '`', close: '`', escape: false }],
};

const HASH: CommentSyntax = {
  name: 'hash',
  line: ['#'],
  block: [],
  nested: false,
  // Triple quotes first: a Python docstring is a string, not a comment, and
  // treating it as code is the conservative reading.
  strings: [
    { open: '"""', close: '"""', escape: true },
    { open: "'''", close: "'''", escape: true },
    ...QUOTES,
  ],
};

const SQL_LIKE: CommentSyntax = {
  name: 'sql-like',
  line: ['--'],
  block: [['/*', '*/']],
  nested: false,
  strings: QUOTES,
};

const MARKUP: CommentSyntax = {
  name: 'markup',
  line: [],
  block: [['<!--', '-->']],
  nested: false,
  strings: [],
};

/**
 * Formats with no comments at all.
 *
 * Worth naming rather than leaving unknown: "this file has no comments" is
 * something we know about JSON, and saying "I could not read it" instead would
 * attach a caveat to every match in a package.json. Dialects that do allow
 * comments in practice - tsconfig.json and its `//` lines - simply have them
 * counted as code, which is the direction that fails loudly.
 */
const NO_COMMENTS: CommentSyntax = {
  name: 'none',
  line: [],
  block: [],
  nested: false,
  strings: [],
};

/** Extension to comment syntax. Anything absent is left unclassified. */
const BY_EXTENSION: ReadonlyMap<string, CommentSyntax> = new Map([
  ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].map(
    (extension) => [extension, JS_LIKE] as const,
  ),
  ...['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.java', '.kt', '.kts', '.scala', '.swift', '.dart', '.php', '.m', '.mm', '.zig'].map(
    (extension) => [extension, C_LIKE] as const,
  ),
  ...['.cs', '.csx'].map((extension) => [extension, C_SHARP] as const),
  ...['.rs'].map((extension) => [extension, RUST] as const),
  ...['.go'].map((extension) => [extension, GO] as const),
  ...['.py', '.pyi', '.rb', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.tf', '.pl', '.r'].map(
    (extension) => [extension, HASH] as const,
  ),
  ...['.sql', '.lua', '.hs', '.elm'].map((extension) => [extension, SQL_LIKE] as const),
  ...['.html', '.htm', '.xml', '.svg', '.vue', '.svelte', '.md', '.markdown'].map(
    (extension) => [extension, MARKUP] as const,
  ),
  // .jsonc is named for the comments it allows, so it gets the C-style reader.
  ...['.jsonc'].map((extension) => [extension, C_LIKE] as const),
  ...['.json', '.txt', '.csv', '.tsv', '.lock', '.log'].map(
    (extension) => [extension, NO_COMMENTS] as const,
  ),
]);

/** The comment syntax for a path, or null when the language is unknown. */
export function syntaxFor(filePath: string): CommentSyntax | null {
  return BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? null;
}

/** Half-open [start, end) offsets that are comment text. */
export type CommentRange = readonly [number, number];

/** Where the literal opened at `at` ends, or the end of the file. */
function endOfString(source: string, at: number, rule: StringRule): number {
  let index = at + rule.open.length;
  while (index < source.length) {
    if (rule.escape && source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith(rule.close, index)) return index + rule.close.length;
    index += 1;
  }
  return source.length;
}

/** Where the block comment opened at `at` ends, or the end of the file. */
function endOfBlock(source: string, at: number, pair: readonly [string, string], nested: boolean): number {
  const [open, close] = pair;
  let index = at + open.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    if (nested && source.startsWith(open, index)) {
      depth += 1;
      index += open.length;
      continue;
    }
    if (source.startsWith(close, index)) {
      depth -= 1;
      index += close.length;
      continue;
    }
    index += 1;
  }
  return index;
}

/**
 * Finds every comment in the source.
 *
 * One pass, tracking strings so that comment markers inside them are ignored.
 * An unterminated comment or string runs to the end of the file, which matches
 * how a compiler would read it.
 *
 * The scan is written so that it cannot stand still: whatever the branches
 * below decide, the loop advances by at least one character. That guarantee is
 * the difference between a wrong answer and a hang, and this loop appends as it
 * goes - standing still here would not spin, it would eat memory until the
 * process died, on somebody's file, in somebody's CI.
 */
export function commentRanges(source: string, syntax: CommentSyntax): CommentRange[] {
  const ranges: CommentRange[] = [];
  let index = 0;

  while (index < source.length) {
    const start = index;
    const startsWith = (token: string): boolean => source.startsWith(token, start);

    // First match wins, in this order: a literal hides comment markers inside
    // it, and a line comment hides a block opener on the same line. Each lookup
    // sits in the branch that needs it, so none of them runs speculatively.
    const stringRule = syntax.strings.find((rule) => startsWith(rule.open));
    if (stringRule) {
      index = endOfString(source, start, stringRule);
    } else {
      const lineToken = syntax.line.find((token) => startsWith(token));
      if (lineToken !== undefined) {
        const newline = source.indexOf('\n', start);
        index = newline === -1 ? source.length : newline;
        ranges.push([start, index]);
      } else {
        const blockPair = syntax.block.find(([open]) => startsWith(open));
        if (blockPair) {
          index = endOfBlock(source, start, blockPair, syntax.nested);
          ranges.push([start, index]);
        }
      }
    }

    // The single advance point, and the only place termination depends on.
    if (index <= start) index = start + 1;
  }

  return ranges;
}

/**
 * Decides whether a byte offset falls inside a comment.
 *
 * `classified` is false when the language is unknown, in which case nothing is
 * treated as a comment. Callers report that rather than implying the file was
 * understood.
 */
export interface CommentMask {
  readonly classified: boolean;
  readonly syntax: string | null;
  isComment(offset: number): boolean;
}

const UNCLASSIFIED: CommentMask = {
  classified: false,
  syntax: null,
  isComment: () => false,
};

export function createCommentMask(source: string, filePath: string): CommentMask {
  const syntax = syntaxFor(filePath);
  if (!syntax) return UNCLASSIFIED;

  const ranges = commentRanges(source, syntax);
  return {
    classified: true,
    syntax: syntax.name,
    isComment(offset: number): boolean {
      let low = 0;
      let high = ranges.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const [start, end] = ranges[mid] as CommentRange;
        if (offset < start) high = mid - 1;
        else if (offset >= end) low = mid + 1;
        else return true;
      }
      return false;
    },
  };
}
