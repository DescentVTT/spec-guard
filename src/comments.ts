/**
 * Comment classification.
 *
 * A documented codebase defeats a plain text search in the most ironic way
 * available: the comment recording that a symbol was deleted is itself a match
 * for that symbol. `@assert-absence symbol="LegacyThing"` then fails on
 *
 *   // LegacyThing was removed; do not reintroduce it
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
  /**
   * A doubled closing delimiter is an escaped one rather than the end: YAML
   * writes a quote inside a single-quoted scalar as `''`, and `'it''s'` is one
   * scalar. Without this the scalar ends at the first of the pair and the rest
   * of the line becomes text, where a `#` would open a comment.
   */
  doubled?: boolean;
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
  /**
   * A quote opens a literal only where a word could start, as in YAML, whose
   * plain scalars are unquoted text: `name: the decoder's artefact` holds an
   * apostrophe, not the opening of a string.
   */
  wordQuotes: boolean;
  /**
   * `/` may open a regular expression, which is a literal that can hold a
   * quote or a comment marker: `/'/`, `replace(/\/\//g, '')`.
   */
  regexLiterals: boolean;
  /**
   * A block comment does not open directly after `>`, which in JSX is the end
   * of a tag and the start of text that may say anything: `<div>/*</div>`.
   */
  jsxText: boolean;
  /** Literal forms that may contain comment-looking text. */
  strings: readonly StringRule[];
}

/**
 * Words after which a `/` opens a regular expression rather than dividing.
 *
 * The remaining ambiguity is `)` and `}`, where this follows the usual
 * heuristic. Both tables are shared with the import tokenizer in `imports.ts`,
 * which is where they were written and proved: two copies would be two answers
 * to "is this a regular expression", and the only thing worse than one
 * heuristic is two of them disagreeing about the same file.
 */
export const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * `<` is deliberately absent: in JSX every closing tag is `</`, and reading that
 * as the start of a regular expression loses the scan for the rest of the line.
 * The cost is that `a < /re/.test(b)` is misread instead, which is a shape that
 * does not occur in practice.
 *
 * `}` stays, for a regular expression that opens a statement after a block,
 * except before `/>`. That is a JSX element closing after an expression
 * attribute, `<App x={y} />`. `/>` after anything else is still one - `/>/` is a
 * regular expression, and HTML escaping is full of `replace(/>/g, ...)`.
 */
export const REGEX_AFTER_PUNCT: ReadonlySet<string> = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '~',
  '>',
]);

const QUOTES: readonly StringRule[] = [
  { open: '"', close: '"', escape: true },
  { open: "'", close: "'", escape: true },
];

// Every profile writes the same keys in the same order, flags included where
// they are false, so the lexer's reads of them stay monomorphic. With the
// flags left off where unused, each profile was a shape of its own, and a run
// that had seen four of them read C about a fifth slower than 0.10.2 did. The
// scan reads a profile once per file now rather than once per character, which
// makes this cheaper to get wrong than it was - and no less wrong.

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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
  strings: QUOTES,
};

/**
 * A quoted string in JavaScript cannot hold a line break - only a template
 * can - so one that reaches the end of its line was never a string.
 *
 * The same backstop Rust's character literal got in 0.10.3, for the same
 * reason: whatever this table misreads next, it costs a line rather than a
 * file. It is also what JSX text costs. `<p>Don't click</p>` opens a literal
 * that no quote closes, and bounded to its line that literal is read as code -
 * which is what the text is.
 */
const JS_QUOTES: readonly StringRule[] = [
  { open: '"', close: '"', escape: true, singleLine: true },
  { open: "'", close: "'", escape: true, singleLine: true },
];

const JS_LIKE: CommentSyntax = {
  ...C_LIKE,
  name: 'javascript',
  digitSeparators: false,
  // Until 0.11.0 no profile read a regular expression, so a quote inside one -
  // `/'/`, `/["']/` - opened a string that closed on some later quote, and the
  // comments in between were read as code. See ADR-0006.
  regexLiterals: true,
  jsxText: true,
  strings: [...JS_QUOTES, { open: '`', close: '`', escape: true }],
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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
  // Triple quotes first: a Python docstring is a string, not a comment, and
  // treating it as code is the conservative reading.
  strings: [
    { open: '"""', close: '"""', escape: true },
    { open: "'''", close: "'''", escape: true },
    ...QUOTES,
  ],
};

/**
 * Shell scripts: `#` comments, but only where a word starts.
 *
 * POSIX says so. A shell ignores a word *beginning* with `#`, so `${path##*.}`,
 * `${#items[@]}` and `$#` are code; read as Python reads `#`, each of those hid
 * the rest of its line. (The basename expansion, whose pattern ends in a star
 * and a slash, is the commonest of them, and cannot be written in a comment
 * like this one without closing it.)
 *
 * A comment written straight after code, as in `x;# note`, is read as code
 * here, which is the direction that fails loudly.
 */
const SHELL: CommentSyntax = {
  name: 'shell',
  line: ['#'],
  block: [],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: true,
  // A shell quote opens anywhere, and has to: in `dir='C:\'` and `echo a'b'`
  // the quote is mid-word, and a `#` inside one it did not open would comment
  // out the rest of the line.
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
  strings: [
    // ANSI-C quoting, the one single-quoted form a backslash escapes in.
    { open: "$'", close: "'", escape: true },
    { open: '"', close: '"', escape: true },
    // Nothing escapes inside single quotes: 'C:\' is a complete string.
    { open: "'", close: "'", escape: false },
  ],
};

/**
 * YAML: a shell's `#` rule, and quotes only where a value starts.
 *
 * YAML needs whitespace before a comment, so `https://example.com/#top` is one
 * value - the rule a shell shares. What it does not share is the quoting. Most
 * YAML scalars are plain, which is to say unquoted, and a plain scalar may hold
 * an apostrophe: `- name: Build the decoder's artefact` is a sentence, not a
 * string opening. Read as a shell reads it, that apostrophe opened a literal
 * that closed on the next one in the file - often lines away, in another
 * sentence - and every `#` between them stopped being a comment.
 *
 * So a quote here opens a scalar only where a word could start, which is where
 * YAML puts one: after `key:`, after `- `, or at the start of a line. A quote
 * anywhere else is text. The limit is a quote in the middle of a plain scalar
 * with a space in front of it, `title: the 'quoted' word`, which is still read
 * as a string - harmlessly, because such quotes come in pairs, and it is the
 * unpaired apostrophe that used to run away.
 */
const YAML: CommentSyntax = {
  name: 'yaml',
  line: ['#'],
  block: [],
  nested: false,
  lifetimes: false,
  digitSeparators: false,
  wordComments: true,
  wordQuotes: true,
  regexLiterals: false,
  jsxText: false,
  strings: [
    { open: '"', close: '"', escape: true },
    // A single-quoted scalar has no backslash escapes. The one escape it has is
    // a doubled quote, `'it''s'`, and reading that as two scalars would leave
    // `s` outside a string - with a `#` after it free to open a comment.
    { open: "'", close: "'", escape: false, doubled: true },
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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
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
  wordQuotes: false,
  regexLiterals: false,
  jsxText: false,
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
register(SHELL, ['.sh', '.bash', '.zsh']);
register(YAML, ['.yaml', '.yml']);
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
    if (source.startsWith(close, index)) {
      // A doubled delimiter is an escaped one, so the literal carries on.
      if (rule.doubled && source.startsWith(close, index + close.length)) {
        index += close.length * 2;
        continue;
      }
      return { end: index + close.length, closed: true };
    }
    index += 1;
  }
  return { end: source.length, closed: false };
}

/** A line comment's opener, and a YAML scalar's quote, is where a word could start. */
function startsWord(source: string, at: number): boolean {
  const before = source[at - 1];
  return before === undefined || before === ' ' || before === '\t' || before === '\n';
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
  // YAML: a scalar is quoted only when the quote is where its value starts, so
  // an apostrophe inside a word is part of a sentence.
  if (syntax.wordQuotes && !startsWord(source, at)) return at + 1;
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

/**
 * Whether the `/` at `at` opens a regular expression rather than dividing.
 *
 * The one question in JavaScript a character cannot answer by itself, and the
 * reason no profile read a regular expression until 0.11.0: `/` divides or
 * quotes according to what came before it. So this looks back, past the
 * whitespace and past the comments - `// note` and then a line that opens with
 * a regular expression is ordinary code - and asks the same two tables the
 * import tokenizer asks.
 */
function opensRegex(source: string, at: number, comments: readonly CommentRange[]): boolean {
  const word = /[A-Za-z0-9_$]/;
  let index = at - 1;
  let recent = comments.length - 1;

  for (;;) {
    while (index >= 0) {
      const char = source[index] as string;
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break;
      index -= 1;
    }
    // A comment is not a token. Step over the whole of it and ask again, which
    // the ranges collected so far already say how to do.
    while (recent >= 0 && (comments[recent] as CommentRange)[0] > index) recent -= 1;
    const range = comments[recent];
    if (range === undefined || range[1] <= index) break;
    index = range[0] - 1;
  }

  // Nothing before it at all: a file may open with a regular expression.
  if (index < 0) return true;
  const before = source[index] as string;
  if (word.test(before)) {
    let from = index;
    while (from > 0 && word.test(source[from - 1] as string)) from -= 1;
    return REGEX_AFTER_WORD.has(source.slice(from, index + 1));
  }
  return REGEX_AFTER_PUNCT.has(before) && !(before === '}' && source[at + 1] === '>');
}

/**
 * Where the regular expression opened at `at` ends, or `at` itself when
 * nothing closes it before the end of the line - in which case the `/` divided
 * after all.
 *
 * A regular expression is one line long, and that is the backstop here: a `/`
 * this reads wrongly costs at most the rest of its line, never the rest of the
 * file, the same bound a Rust character literal got in 0.10.3.
 */
function endOfRegex(source: string, at: number): number {
  let index = at + 1;
  let inClass = false;

  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') return at;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    // Inside a character class `/` is an ordinary character: /[/]/ is one
    // literal, and `replace(/[/\\]/g, …)` is how a path is split.
    else if (char === '/' && !inClass) return index + 1;
    index += 1;
  }
  return at;
}

/**
 * The ASCII characters that can begin anything a profile reads.
 *
 * Every comment token and every literal opener in this table starts with one
 * of a handful of characters, and a source file is mostly none of them. So the
 * scan asks this first, and a character that begins nothing costs one array
 * read instead of four searches that were always going to fail.
 *
 * It is also what keeps a rule cheap for the languages that do not have it.
 * Adding the regular-expression branch below to the scan made C 16% slower
 * before this existed - not the branch's work, which C never reaches, but its
 * presence: the same branch with its body deleted cost the same, and so did an
 * unrelated one bolted onto 0.10.3. A question asked per character is paid for
 * per character whether or not it is answered.
 *
 * The table is ASCII-wide, and deliberately has no bounds check at either end.
 * A typed array ignores a write past its end and reads back `undefined`, which
 * is not `0`, so a delimiter in some other script marks nothing and every
 * character of that script takes the slow path - read correctly, and slowly.
 * Both halves of that are the language's own behaviour rather than a branch
 * that no file anyone has could reach.
 *
 * A profile that reads regular expressions needs `/` marked, and gets it from
 * the `//` that opens its line comments; one that has the JSX rule needs it
 * too, and gets it from `/*`. Both are the same character, and no language
 * has one without the other.
 */
function openingCharacters(syntax: CommentSyntax): Uint8Array {
  const starts = new Uint8Array(128);
  const mark = (token: string): void => {
    starts[token.charCodeAt(0)] = 1;
  };
  for (const token of syntax.line) mark(token);
  for (const [open] of syntax.block) mark(open);
  for (const rule of syntax.strings) mark(rule.open);
  return starts;
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
  /**
   * Half-open ranges of literals, delimiters included: strings, and the
   * regular expressions of a profile that has them. Both are code, and both
   * are places a comment marker means nothing.
   */
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
  // Read once, at the top: the loop below reaches for each of these wherever
  // a character opens something, and the profile itself is never touched
  // inside it. 0.10.3 paid a tenth of the scan for a question asked per
  // character and concluded that the profiles must all be one object shape;
  // they still are, for the rules read at an opener. Nothing mutates a
  // profile, so these cannot go stale mid-scan.
  const { line, block, strings: literals, nested, wordComments, regexLiterals, jsxText } = syntax;
  const starts = openingCharacters(syntax);
  let unterminated = false;
  let index = 0;

  while (index < source.length) {
    const start = index;
    // A character that opens nothing in this language is code, and there is
    // nothing further to ask about it. Written this way round because a
    // character outside the table's reach reads back `undefined`, which is not
    // `0`: an unknown character is asked the long questions, not skipped.
    if (starts[source.charCodeAt(start)] !== 0) {
      const startsWith = (token: string): boolean => source.startsWith(token, start);

      // First match wins, in this order: a literal hides comment markers inside
      // it, a line comment hides a block opener on the same line, and a `/` is
      // asked whether it opens a regular expression only once it has failed to
      // open either comment. Each lookup sits in the branch that needs it, so
      // none of them runs speculatively - which is why a quote is asked whether
      // it is code only once a literal would open there. Asked on every
      // character, that question cost a tenth of the scan.
      const opener = openerAt(source, start, literals);
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
        const lineToken = line.find((token) => startsWith(token));
        if (lineToken !== undefined && (!wordComments || startsWord(source, start))) {
          // A line comment is closed by the end of the file as legitimately as
          // by a newline, so running off the end is not a lost scan.
          const newline = source.indexOf('\n', start);
          index = newline === -1 ? source.length : newline;
          comments.push([start, index]);
        } else {
          const blockPair = block.find(([open]) => startsWith(open));
          // In JSX a `>` ends a tag, and what follows is text that may say
          // anything: `<div>/*</div>` opens no comment, and reading one there
          // hid every line up to the next `*/` in the file.
          if (blockPair && !(jsxText && source[start - 1] === '>')) {
            const span = endOfBlock(source, start, blockPair, nested);
            index = span.end;
            comments.push([start, index]);
            if (!span.closed) unterminated = true;
          } else if (regexLiterals && source[start] === '/' && source[start + 1] !== '*' && opensRegex(source, start, comments)) {
            // No regular expression begins with `*`, so the only `/*` that
            // reaches here is the JSX text above, and it stays code.
            //
            // The test for `/` looks redundant, because in this profile every
            // other opening character opens a literal. It is not: a rule whose
            // opener may open nothing - Rust's `r`, which needs a quote after
            // its hashes - reaches here too, and without this the scan would
            // read from that `r` to the next slash on the line.
            const end = endOfRegex(source, start);
            if (end > start) {
              index = end;
              strings.push([start, index]);
            }
          }
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
