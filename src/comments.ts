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
  /**
   * The opener is a run of its character at least `open` long, and only a run
   * of the same length closes it: C#'s raw strings, which take `"""` or as many
   * more quotes as their text needs to hold a `"""` of its own.
   */
  run?: boolean;
  /**
   * Rust's raw strings: `open`, any number of `#` and a quote, closed only by a
   * quote and as many `#` - `r"…"`, `r#"…"#`, `r##"…"##`, as many as the text
   * needs to hold a `"#` of its own. Without the quote it is no string at all:
   * `r#match` is a raw identifier, and the `r` in `for` is a letter.
   */
  hashes?: boolean;
  /**
   * The literal cannot hold a line break, so reaching one means it was never
   * closed. A Rust character literal holds a single character, and rustc stops
   * reading one at the end of its line.
   */
  singleLine?: boolean;
}

export interface CommentSyntax {
  name: string;
  /** Prefixes that comment out the rest of the line. */
  line: readonly string[];
  /** Delimiter pairs for block comments. */
  block: ReadonlyArray<readonly [string, string]>;
  /** Block comments nest, as in Rust. */
  nested: boolean;
  /**
   * A quote before an identifier that no quote closes is a lifetime or a loop
   * label, as in Rust - `'a`, `'static`, `'_`, `'outer` - and is code.
   */
  lifetimes: boolean;
  /**
   * A quote straight after a number is part of it: C++14 and C23 separate
   * digits with one, `100'000`.
   */
  digitSeparators: boolean;
  /**
   * A line comment opens only where a word could start - at the start of a
   * line, or after a space or a tab - as in a shell, where `${#items[@]}` and
   * `$#` are code, and in YAML, where `a#b` is text.
   */
  wordComments: boolean;
  /** Literal forms that may contain comment-looking text. */
  strings: readonly StringRule[];
}

const QUOTES: readonly StringRule[] = [
  { open: '"', close: '"', escape: true },
  { open: "'", close: "'", escape: true },
];

// Every profile writes the same keys in the same order, flags included where
// they are false. The lexer reads these on every character of every file, and
// objects of one shape keep those reads monomorphic: with the flags left off
// where unused, each profile was a shape of its own, and a run that had seen
// four of them read C about a fifth slower than 0.10.2 did.

const C_LIKE: CommentSyntax = {
  name: 'c-like',
  line: ['//'],
  block: [['/*', '*/']],
  nested: false,
  lifetimes: false,
  // C++ and C23 write them, and nothing else read with this profile puts a
  // quote straight after a number. Nor does JavaScript, C# or Go, which is why
  // they set it false: a rule no valid file of theirs can reach would only
  // change which wrong answer a misread file gets.
  digitSeparators: true,
  wordComments: false,
  strings: QUOTES,
};

const JS_LIKE: CommentSyntax = {
  ...C_LIKE,
  name: 'javascript',
  digitSeparators: false,
  strings: [...QUOTES, { open: '`', close: '`', escape: true }],
};

const C_SHARP: CommentSyntax = {
  ...C_LIKE,
  name: 'c#',
  digitSeparators: false,
  // Longest opener first, so a raw string's """ wins over an empty "" and a
  // verbatim string's @" - or @$", the interpolated one - over ".
  //
  // Neither of the first two was here before 0.10.2. A raw string holding a
  // quote read as a string that closed early, and one of four quotes ran to the
  // end of the file; @$"C:\" read its closing quote as escaped and did the same,
  // so every using after it went unread.
  strings: [
    { open: '"""', close: '"""', escape: false, run: true },
    { open: '@$"', close: '"', escape: false },
    { open: '@"', close: '"', escape: false },
    ...QUOTES,
  ],
};

const RUST: CommentSyntax = {
  name: 'rust',
  line: ['//'],
  block: [['/*', '*/']],
  // Rust block comments nest, so /* /* */ */ is one comment, not one and a half.
  nested: true,
  // Until 0.10.3 every `'` opened a character literal, so `&'static str` read
  // on to the next quote in the file - often an apostrophe in a comment - and
  // every use in between went unread, without a word. See ADR-0006.
  lifetimes: true,
  digitSeparators: false,
  wordComments: false,
  strings: [
    // Before 0.10.3 only r"…" and r#"…"# were known, and r##"…"## read as an
    // ordinary string that closed at the first quote inside it.
    { open: 'r', close: '"', escape: false, hashes: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true, singleLine: true },
  ],
};

const GO: CommentSyntax = {
  ...C_LIKE,
  name: 'go',
  digitSeparators: false,
  strings: [...QUOTES, { open: '`', close: '`', escape: false }],
};

const HASH: CommentSyntax = {
  name: 'hash',
  line: ['#'],
  block: [],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: false,
  // Triple quotes first: a Python docstring is a string, not a comment, and
  // treating it as code is the conservative reading.
  strings: [
    { open: '"""', close: '"""', escape: true },
    { open: "'''", close: "'''", escape: true },
    ...QUOTES,
  ],
};

/**
 * Shell scripts and YAML: `#` comments, but only where a word starts.
 *
 * Both say so. A shell ignores a word *beginning* with `#`, so `${path##*.}`,
 * `${#items[@]}` and `$#` are code; YAML needs whitespace before a comment, so
 * `https://example.com/#top` is one value. Read as Python reads `#`, each of
 * those hid the rest of its line. (The basename expansion, whose pattern ends
 * in a star and a slash, is the commonest of them, and cannot be written in a
 * comment like this one without closing it.)
 *
 * A comment written straight after code, as in `x;# note`, is read as code
 * here, which is the direction that fails loudly.
 */
const SHELL_LIKE: CommentSyntax = {
  name: 'shell-like',
  line: ['#'],
  block: [],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: true,
  strings: [
    // ANSI-C quoting, the one single-quoted form a backslash escapes in.
    { open: "$'", close: "'", escape: true },
    { open: '"', close: '"', escape: true },
    // Nothing escapes inside single quotes, in either language: 'C:\' is
    // complete. YAML writes a quote inside one as '', two strings side by side.
    { open: "'", close: "'", escape: false },
  ],
};

const SQL_LIKE: CommentSyntax = {
  name: 'sql-like',
  line: ['--'],
  block: [['/*', '*/']],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: false,
  strings: QUOTES,
};

const MARKUP: CommentSyntax = {
  name: 'markup',
  line: [],
  block: [['<!--', '-->']],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: false,
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
  lifetimes: false,
  digitSeparators: false,
  wordComments: false,
  strings: [],
};

/** Extension to comment syntax. Anything absent is left unclassified. */
const BY_EXTENSION = new Map<string, CommentSyntax>();

/**
 * The same profiles, addressed by name instead of by extension.
 *
 * For callers that already know what language they are looking at and must not
 * re-derive it from the path. Two ways of answering "which language is this"
 * is one more than the number that can be right, so this is filled from the
 * same calls rather than from a second list.
 */
const BY_NAME = new Map<string, CommentSyntax>();

/**
 * Records the files one profile covers.
 *
 * A call per language rather than a table of rows, and the shape is chosen for
 * a specific reason. This table has been written three ways: ten spread
 * `.map()` calls, then an array of `[extensions, syntax]` pairs, and now this.
 * The first two share a failure mode - a mutation inside the callback, or a row
 * emptied to `[]`, makes this module throw while it is loading, and a mutant
 * that stops a module loading produces no test results at all, which the
 * mutation runner reads as "no test killed it". Twenty such mutants have sat in
 * this table across the two earlier shapes, looking like untested code while
 * the suite caught every one of them.
 *
 * Emptying an argument list here cannot throw. It produces a table that is
 * simply *wrong* - `syntaxFor('a.cs')` answers null - which is something a test
 * can see, and one does. See ADR-0003.
 */
function register(syntax: CommentSyntax, extensions: readonly string[]): void {
  BY_NAME.set(syntax.name, syntax);
  for (const extension of extensions) BY_EXTENSION.set(extension, syntax);
}

register(JS_LIKE, ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
register(C_LIKE, ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.java', '.kt', '.kts', '.scala', '.swift', '.dart', '.php', '.m', '.mm', '.zig']);
register(C_SHARP, ['.cs', '.csx']);
register(RUST, ['.rs']);
register(GO, ['.go']);
register(HASH, ['.py', '.pyi', '.rb', '.toml', '.tf', '.pl', '.r']);
register(SHELL_LIKE, ['.sh', '.bash', '.zsh', '.yaml', '.yml']);
register(SQL_LIKE, ['.sql', '.lua', '.hs', '.elm']);
register(MARKUP, ['.html', '.htm', '.xml', '.svg', '.vue', '.svelte', '.md', '.markdown']);
// MSBuild's files, and the rest of .NET's XML. A project file is where a
// ProjectReference or a <Using Include> says what a project depends on, and a
// reference commented out there is not one.
register(MARKUP, ['.csproj', '.fsproj', '.vbproj', '.props', '.targets', '.slnx', '.nuspec', '.resx', '.xaml']);
// .jsonc is named for the comments it allows, so it gets the C-style reader.
register(C_LIKE, ['.jsonc']);
register(NO_COMMENTS, ['.json', '.txt', '.csv', '.tsv', '.lock', '.log']);

/** The comment syntax for a path, or null when the language is unknown. */
export function syntaxFor(filePath: string): CommentSyntax | null {
  return BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function syntaxNamed(name: string): CommentSyntax | null {
  return BY_NAME.get(name) ?? null;
}

/** Half-open [start, end) offsets that are comment text. */
export type CommentRange = readonly [number, number];

/** Where a literal or block ended, and whether it was actually closed. */
interface Span {
  end: number;
  closed: boolean;
}

/** A literal's opening delimiter as the source wrote it. */
interface Opener {
  rule: StringRule;
  /** Where the literal's text starts. */
  text: number;
  /** What closes it, grown by whatever the opener repeated. */
  close: string;
}

/** The literal that opens at `at`, by the first rule that opens one there. */
function openerAt(source: string, at: number, rules: readonly StringRule[]): Opener | null {
  for (const rule of rules) {
    if (!source.startsWith(rule.open, at)) continue;
    const from = at + rule.open.length;
    let text = from;
    if (rule.run) while (source[text] === rule.open[0]) text += 1;
    if (rule.hashes) while (source[text] === '#') text += 1;
    // Every character the opener repeated, the closer needs as well.
    const close = rule.close + source.slice(from, text);
    if (!rule.hashes) return { rule, text, close };
    if (source[text] === '"') return { rule, text: text + 1, close };
  }
  return null;
}

/** Where the literal ends, or where it was left open. */
function endOfString(source: string, { rule, text, close }: Opener): Span {
  let index = text;
  while (index < source.length) {
    if (rule.singleLine && source[index] === '\n') return { end: index, closed: false };
    if (rule.escape && source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith(close, index)) return { end: index + close.length, closed: true };
    index += 1;
  }
  return { end: source.length, closed: false };
}

/**
 * Where the code that starts at `at` with a quote ends, or `at` itself when
 * the quote opens a literal - or there is no quote.
 *
 * Two languages write a quote that opens nothing. rustc reads a quote and an
 * identifier as a lifetime or a label unless a quote follows the identifier:
 * `'a'` and `'_'` are characters, `'a` and `'_` are not. And a C++ number may
 * carry quotes between its digits, so a quote after a word that begins with a
 * digit is still that number, where `u8'a'` is a character.
 */
function codeAfterQuote(source: string, at: number, syntax: CommentSyntax): number {
  if (source[at] !== "'") return at;
  if (syntax.lifetimes) {
    const identifier = /[\p{XID_Start}_]\p{XID_Continue}*/uy;
    identifier.lastIndex = at + 1;
    // Past the whole identifier: in a macro's tokens, `'xr"…"` is a lifetime
    // and then a string, not a raw string opened by the lifetime's last letter.
    if (identifier.test(source) && source[identifier.lastIndex] !== "'") return identifier.lastIndex;
  }
  if (syntax.digitSeparators) {
    const inWord = /[\w']/;
    let word = at;
    while (word > 0 && inWord.test(source[word - 1] as string)) word -= 1;
    if (/\d/.test(source[word] as string)) return at + 1;
  }
  return at;
}

/** A line comment's opener is where a word could start. */
function startsWord(source: string, at: number): boolean {
  const before = source[at - 1];
  return before === undefined || before === ' ' || before === '\t' || before === '\n';
}

/** Where the block comment opened at `at` ends, or the end of the file. */
function endOfBlock(source: string, at: number, pair: readonly [string, string], nested: boolean): Span {
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
  return { end: index, closed: depth === 0 };
}

/** Everything one pass over a source file knows about its comments and literals. */
export interface LexResult {
  /** Half-open ranges of comment text, in ascending order. */
  comments: CommentRange[];
  /** Half-open ranges of string literals, delimiters included. */
  strings: CommentRange[];
  /**
   * True when a literal or block comment was never closed: it ran off the end
   * of the file, or - for a literal that cannot hold a line break - off the end
   * of its line.
   *
   * The ranges are still returned - reading an unterminated literal to its end
   * is what a compiler does - but everything after the opening delimiter was
   * swallowed by it, so anything derived from this scan is missing whatever
   * lived in there. Callers that draw conclusions from absence must say so.
   */
  unterminated: boolean;
}

/**
 * Finds every comment and string literal in the source.
 *
 * One pass, because the two questions are the same question: a comment marker
 * inside a literal is not a comment, and a quote inside a comment does not open
 * one. Two passes would need to answer each other's question to be right.
 *
 * The scan is written so that it cannot stand still: whatever the branches
 * below decide, the loop advances by at least one character. That guarantee is
 * the difference between a wrong answer and a hang, and this loop appends as it
 * goes - standing still here would not spin, it would eat memory until the
 * process died, on somebody's file, in somebody's CI.
 */
export function lexRanges(source: string, syntax: CommentSyntax): LexResult {
  const comments: CommentRange[] = [];
  const strings: CommentRange[] = [];
  let unterminated = false;
  let index = 0;

  while (index < source.length) {
    const start = index;
    const startsWith = (token: string): boolean => source.startsWith(token, start);

    // First match wins, in this order: a literal hides comment markers inside
    // it, and a line comment hides a block opener on the same line. Each lookup
    // sits in the branch that needs it, so none of them runs speculatively -
    // which is why a quote is asked whether it is code only once a literal
    // would open there. Asked on every character, it cost a tenth of the scan.
    const opener = openerAt(source, start, syntax.strings);
    if (opener) {
      const code = codeAfterQuote(source, start, syntax);
      if (code > start) {
        index = code;
      } else {
        const span = endOfString(source, opener);
        index = span.end;
        strings.push([start, index]);
        if (!span.closed) unterminated = true;
      }
    } else {
      const lineToken = syntax.line.find((token) => startsWith(token));
      if (lineToken !== undefined && (!syntax.wordComments || startsWord(source, start))) {
        // A line comment is closed by the end of the file as legitimately as by
        // a newline, so running off the end is not a lost scan.
        const newline = source.indexOf('\n', start);
        index = newline === -1 ? source.length : newline;
        comments.push([start, index]);
      } else {
        const blockPair = syntax.block.find(([open]) => startsWith(open));
        if (blockPair) {
          const span = endOfBlock(source, start, blockPair, syntax.nested);
          index = span.end;
          comments.push([start, index]);
          if (!span.closed) unterminated = true;
        }
      }
    }

    // The single advance point, and the only place termination depends on.
    if (index <= start) index = start + 1;
  }

  return { comments, strings, unterminated };
}

/** The comment ranges alone, for callers that only need to mask them. */
export function commentRanges(source: string, syntax: CommentSyntax): CommentRange[] {
  return lexRanges(source, syntax).comments;
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
