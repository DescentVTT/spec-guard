/**
 * Module-reference extraction for Python, Go, Rust and C#.
 *
 * The JavaScript analyser in `imports.ts` is a full tokenizer because it has to
 * be: a module reference can appear anywhere in an expression, `/` is division
 * or a regular expression depending on context, and template literals nest
 * arbitrarily. None of that is true here. In these four languages an import is
 * a statement, its shape is fixed, and the only thing that can disguise one is
 * a comment or a string literal.
 *
 * spec-guard already has something that finds comments and string literals in
 * nine language families, and it is the most adversarially tested code in the
 * project. So this module does not add four more tokenizers. It masks the
 * source with the existing lexer and then reads statements off what is left:
 *
 *   source -> lexRanges (comments.ts) -> masked code -> per-language statement reader
 *
 * That is the whole architecture, and it is the reason four languages cost
 * about as much as one.
 *
 * The alternative was Tree-sitter, and the reason it lost is size: its runtime
 * plus grammars for these four languages measures 94 MB unpacked against this
 * package's 0.33 MB. What that buys is real - a parser knows about
 * conditional compilation and macro expansion, and this does not - so the
 * places where it would be more accurate are listed in ADR-0008 rather than
 * waved away. None of them is an import that this misreads; they are imports
 * this cannot see, and every one of them is reported.
 *
 * Which is the invariant from ADR-0005, carried over unchanged: **a reference
 * this module cannot resolve becomes a note, never silence**. A dependency
 * rule that quietly ignores what it did not understand is a rule that passes
 * for the wrong reason.
 */

import path from 'node:path';

import { lexRanges, syntaxNamed, type CommentRange } from './comments.js';
import { lineStarts, locate, maskRanges } from './text.js';
import type { AnalysisNote, FileImports, ModuleReference, ReferenceKind } from './imports.js';

/** Languages this module reads. JavaScript and TypeScript live in `imports.ts`. */
export type ModuleLanguage = 'python' | 'go' | 'rust' | 'csharp';

/** Extension to language. The single place a new language is switched on. */
export const POLYGLOT_EXTENSIONS: ReadonlyMap<string, ModuleLanguage> = new Map<string, ModuleLanguage>([
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.cs', 'csharp'],
  ['.csx', 'csharp'],
]);

/** The language for a path, or null when this module does not read it. */
export function languageFor(filePath: string): ModuleLanguage | null {
  return POLYGLOT_EXTENSIONS.get(path.extname(filePath).toLowerCase()) ?? null;
}

/**
 * Largest number of module paths one statement may expand to.
 *
 * Rust's brace groups nest, and nesting multiplies: `use a::{b::{c,d}, e::{f,g}}`
 * is four paths from twelve characters, and the growth is exponential in depth.
 * A file that nests twenty levels deep is not a file anyone wrote, but it is a
 * file somebody could commit, and the failure mode without a cap is an
 * out-of-memory kill in CI rather than an error message. Hitting the cap is
 * reported as a note, so the statement is never silently half-read.
 */
export const MAX_EXPANSION = 64;

/* ------------------------------------------------------------------ masking */

interface Masked {
  /** Source with comments and string interiors blanked, offsets preserved. */
  code: string;
  /** String literal ranges over the original source, ascending. */
  strings: readonly CommentRange[];
  /** Comment ranges over the original source, delimiters included, ascending: a Rust doc comment is told from another by its opening. */
  comments: readonly CommentRange[];
  /** Original source, for reading literal values back out. */
  source: string;
  starts: number[];
  unterminated: boolean;
}

/**
 * Which comment profile each language is read with.
 *
 * Keyed by language rather than by extension on purpose: the caller has already
 * decided what this file is, and looking the answer up a second way is how the
 * two answers get to disagree. A test asserts these agree with the
 * extension-based lookup for every extension this module claims.
 */
export const SYNTAX_NAMES: Record<ModuleLanguage, string> = {
  python: 'hash',
  go: 'go',
  rust: 'rust',
  csharp: 'c#',
};

function mask(source: string, language: ModuleLanguage): Masked {
  const syntax = syntaxNamed(SYNTAX_NAMES[language]);
  /* c8 ignore next -- SYNTAX_NAMES is asserted complete and correct in the tests */
  if (!syntax) throw new Error(`no comment syntax for ${language}`);
  const { comments, strings, unterminated } = lexRanges(source, syntax);
  // The opening delimiter is left visible so a reader can see that a literal
  // starts here; everything inside it is blanked so no keyword can hide there.
  const blanks = [...comments, ...strings.map(([start, end]): CommentRange => [start + 1, end])];
  return { code: maskRanges(source, blanks), strings, comments, source, starts: lineStarts(source), unterminated };
}

/** The literal that starts exactly at `offset`, or null. */
function literalAt(masked: Masked, offset: number): string | null {
  const { strings } = masked;
  let low = 0;
  let high = strings.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = strings[mid] as CommentRange;
    // Three-way, with the hit last. Testing for equality first made both
    // remaining comparisons unfalsifiable: `start === offset` had already
    // returned, so `<` and `<=` decided the same searches.
    if (start < offset) low = mid + 1;
    else if (start > offset) high = mid - 1;
    else return literalValue(masked.source.slice(start, end));
  }
  return null;
}

/** Every literal whose opening delimiter falls inside [from, to). */
function literalsBetween(masked: Masked, from: number, to: number): string[] {
  const values: string[] = [];
  for (const [start, end] of masked.strings) {
    if (start >= to) break;
    if (start >= from) values.push(literalValue(masked.source.slice(start, end)));
  }
  return values;
}

/** Strips the delimiters off a literal as the lexer captured it. */
export function literalValue(raw: string): string {
  let text = raw;
  if (text.startsWith('@')) text = text.slice(1);
  // r"…", r#"…"#, r##"…"##: a closer is one character shorter than its opener.
  const opener = /^r#*"/.exec(text);
  if (opener) return text.slice(opener[0].length, 1 - opener[0].length);
  if (text.startsWith('"""') || text.startsWith("'''")) return text.slice(3, -3);
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === '`') return text.slice(1, -1);
  /* c8 ignore next -- every literal the lexer emits starts with one of the above */
  return text;
}

/* ------------------------------------------------------------------ reading */

/**
 * A Go identifier: a letter, then letters and decimal digits, where a letter
 * is `_` or a character of a Letter category, Lu, Ll, Lt, Lm or Lo, and a
 * digit one of Nd (The Go Programming Language Specification, "Characters",
 * "Letters and digits" and "Identifiers", go1.27, read on 2026-10-19). The
 * page has those categories as Unicode 8.0 gives them; it follows from it,
 * and is not on it, that a later Unicode's letters, which the Node that runs
 * spec-guard has, are read as letters. A mark is no letter, so `cafe` with a
 * combining accent is no identifier, and the text is not normalised: `café`
 * written so is two characters of which the second is none.
 */
const IDENTIFIER = /[\p{L}_][\p{L}\p{Nd}_]*/uy;

/**
 * Whitespace-skipping cursor over masked code, which a Go import and a Python
 * dynamic import are read with.
 *
 * Exported so its edges can be pinned directly. Reaching "what does peek() do
 * at the end of the file" through a Go source string is possible but says
 * nothing about Go.
 */
export class Reader {
  index = 0;

  constructor(readonly text: string) {}

  skipSpace(): void {
    // Character codes rather than /\s/: this runs once per whitespace character
    // in the file, and a regular expression test at that frequency is the
    // difference between the reader being free and the reader being the cost.
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return;
      this.index += 1;
    }
  }

  peek(): string {
    return this.text[this.index] ?? '';
  }

  identifier(): string {
    IDENTIFIER.lastIndex = this.index;
    const match = IDENTIFIER.exec(this.text);
    if (!match) return '';
    this.index += match[0].length;
    return match[0];
  }
}

/** Offset of the matching close, given the depth-tracking characters. */
export function matchingClose(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index] as string;
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

/* ------------------------------------------------------------------ builders */

interface Collector {
  references: ModuleReference[];
  notes: AnalysisNote[];
  masked: Masked;
  file: string;
  /** C# only: the namespaces the file declares. */
  namespaces?: string[];
}

function emit(collector: Collector, specifier: string, kind: ReferenceKind, offset: number, namespace?: string): void {
  const trimmed = specifier.trim();
  if (!trimmed) return;
  const { line, column } = locate(collector.masked.starts, offset);
  collector.references.push({ specifier: trimmed, kind, typeOnly: false, line, column, namespace });
}

function note(collector: Collector, kind: AnalysisNote['kind'], offset: number, detail: string): void {
  const { line, column } = locate(collector.masked.starts, offset);
  collector.notes.push({ kind, file: collector.file, line, column, detail });
}

/* ------------------------------------------------------------------- python */

/**
 * Groups physical lines into the logical lines Python actually executes.
 *
 * A statement continues while a bracket is open or the line ends in a
 * backslash, and `from x import (\n  a,\n  b,\n)` is the shape that matters
 * here. Lines are joined with a space so two tokens cannot fuse into one.
 *
 * A line ends where Python ends one: at LF, at CRLF and at a lone CR. Only
 * LF ended one here, so every line of a file with CRLF endings kept its
 * carriage return. The pattern that read a `from` statement could not reach
 * the end of such a line, and read none in the file, and a backslash before
 * the carriage return continued nothing (ADR-0008, amended 2026-10-12).
 *
 * `starts` is where each physical line begins, in the text and in the
 * source. A statement after a `;` stands on a line of its own where the
 * statement before it ran over several, and is reported there (ADR-0008,
 * amended 2026-10-14).
 */
export function logicalLines(code: string): Array<{ text: string; offset: number; starts: Array<[at: number, offset: number]> }> {
  const lines: Array<{ text: string; offset: number; starts: Array<[at: number, offset: number]> }> = [];
  let text = '';
  let offset = 0;
  let starts: Array<[at: number, offset: number]> = [];
  let depth = 0;
  let start = 0;

  const flush = (): void => {
    if (text.trim()) lines.push({ text, offset, starts });
    text = '';
    starts = [];
  };

  for (let index = 0; index <= code.length; index++) {
    const char = code[index];
    if (index < code.length && char !== '\n' && char !== '\r') {
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    const physical = code.slice(start, index);
    if (!text) offset = start;
    else text += ' ';
    starts.push([text.length, start]);
    text += physical.replace(/\\$/, ' ');
    if (depth === 0 && !/\\$/.test(physical)) flush();
    // The two characters of a CRLF end one line. Read as two, the empty
    // second would end a statement the first had continued.
    if (char === '\r' && code[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  flush();
  return lines;
}

/**
 * Where an import statement may start: at the head of a logical line, or
 * after `;` or `:`. What separates tokens is a blank, a tab or a form feed,
 * as Python has it, and `lazy` before the keyword is Python 3.15's lazy
 * import. The keyword is a whole word, and nothing need follow it but its
 * next token: `from.a import(b)` is an import Python reads.
 */
const PYTHON_STATEMENT = /(^|[;:])([ \t\f]*)(lazy[ \t\f]+)?(import|from)(?!\p{XID_Continue})/gu;
/** One token of an import statement, after any blanks: a name, one of its marks, or its end at a `;` or at the end of the line. */
const PYTHON_TOKEN = /[ \t\f]*(?:([\p{XID_Start}_]\p{XID_Continue}*)|([.,()*])|;|$)/uy;
/** What is no name: the marks of an import statement, and the `;` that ends it. */
const PYTHON_MARKS = '.,()*;';

/**
 * The tokens of the statement that goes on from `from`, with `;` for its
 * end whichever way it ended, or null where a character is no part of an
 * import statement.
 */
function pythonTokens(text: string, from: number): string[] | null {
  const tokens: string[] = [];
  PYTHON_TOKEN.lastIndex = from;
  for (;;) {
    const match = PYTHON_TOKEN.exec(text);
    if (match === null) return null;
    const token = match[1] ?? match[2];
    if (token === undefined) return [...tokens, ';'];
    tokens.push(token);
  }
}

/**
 * The modules one import statement names, read as Python's grammar has it,
 * or null for a statement Python refuses: an import it reads is read here,
 * and what it refuses stays unread (ADR-0008, amended 2026-10-14).
 *
 *   import a.b as c, d
 *   from ..a.b import c as d, e      from . import (a, b,)      from a import *
 *
 * A name is not held to Python's keywords, and a statement to nothing but
 * its own grammar: what scope it stands in, and whether the rest of its file
 * parses, are not asked.
 */
function pythonImports(tokens: readonly string[], from: boolean, lazy: boolean): string[] | null {
  let at = 0;
  const eat = (mark: string): boolean => {
    if (tokens[at] !== mark) return false;
    at += 1;
    return true;
  };
  // A name, or nothing where a mark stands. The place is never past the `;`
  // a statement ends with, which is a mark too.
  const name = (): string => {
    const token = tokens[at]!;
    if (PYTHON_MARKS.includes(token)) return '';
    at += 1;
    return token;
  };
  const dotted = (): string => {
    const parts: string[] = [];
    do {
      const part = name();
      if (part === '') return '';
      parts.push(part);
    } while (eat('.'));
    return parts.join('.');
  };
  // `as` and the name after it, where there is one.
  const renamed = (): boolean => !eat('as') || name() !== '';

  if (!from) {
    const modules: string[] = [];
    do {
      const module = dotted();
      if (module === '' || !renamed()) return null;
      modules.push(module);
    } while (eat(','));
    return eat(';') ? modules : null;
  }

  let dots = '';
  while (eat('.')) dots += '.';
  // Dots, a module or both stand before `import`. A module that is no name
  // leaves the place at what it could not read, which is not `import`.
  const module = tokens[at] === 'import' ? '' : dotted();
  if (`${dots}${module}` === '' || !eat('import')) return null;
  const names: string[] = [];
  if (eat('*')) {
    // Python 3.15 refuses a star import that is lazy.
    if (lazy) return null;
  } else {
    const open = eat('(');
    do {
      const imported = name();
      if (imported === '' || !renamed()) return null;
      names.push(imported);
      // A comma before `)` is the last, which only parentheses take: where
      // none was opened the `)` is left standing, and ends no statement.
    } while (eat(',') && tokens[at] !== ')');
    if (open && !eat(')')) return null;
  }
  if (!eat(';')) return null;
  if (module !== '') return [`${dots}${module}`];
  // `from . import a, b` - here the imported names are themselves modules,
  // which `from .pkg import name` cannot assume.
  return names.slice(0, MAX_EXPANSION).map((imported) => `${dots}${imported}`);
}

const PYTHON_DYNAMIC = /\b(__import__|import_module)[ \t]*\(/g;

function readPython(collector: Collector): void {
  const { code } = collector.masked;

  for (const line of logicalLines(code)) {
    PYTHON_STATEMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PYTHON_STATEMENT.exec(line.text)) !== null) {
      const tokens = pythonTokens(line.text, PYTHON_STATEMENT.lastIndex);
      const modules = tokens === null ? null : pythonImports(tokens, match[4] === 'from', match[3] !== undefined);
      // Reported on the line its first word stands on, at that line's head,
      // as an import at the head of a logical line always was.
      const first = match.index + match[1]!.length + match[2]!.length;
      const [, offset] = line.starts.findLast(([at]) => at <= first)!;
      // A statement that starts as an import and that Python refuses names no
      // module, and is said, as everything that could not be read is: a rule
      // that passes over it under --strict fails (ADR-0008, amended
      // 2026-10-18).
      if (modules === null) {
        note(collector, 'refused', offset, 'a statement that starts as an import is one Python refuses, and no module is read from it');
        continue;
      }
      // Python reads a name in the form NFKC gives it.
      for (const module of modules) emit(collector, module.normalize('NFKC'), 'import', offset);
    }
  }

  PYTHON_DYNAMIC.lastIndex = 0;
  let dynamic: RegExpExecArray | null;
  while ((dynamic = PYTHON_DYNAMIC.exec(code)) !== null) {
    const reader = new Reader(code);
    reader.index = dynamic.index + dynamic[0].length;
    reader.skipSpace();
    const literal = literalAt(collector.masked, reader.index);
    if (literal !== null) emit(collector, literal, 'dynamic-import', dynamic.index);
    else note(collector, 'dynamic', dynamic.index, `${dynamic[1]}(...) with a computed name`);
  }
}

/* ----------------------------------------------------------------------- go */

const GO_IMPORT = /\bimport\b/g;

/** Go's keywords, which no identifier is, so no package name ("Keywords"). */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  ...['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto'],
  ...['if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'],
]);

function readGo(collector: Collector): void {
  const { code } = collector.masked;
  GO_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = GO_IMPORT.exec(code)) !== null) {
    const reader = new Reader(code);
    reader.index = match.index + match[0].length;
    reader.skipSpace();

    if (reader.peek() === '(') {
      const close = matchingClose(code, reader.index, '(', ')');
      for (const value of literalsBetween(collector.masked, reader.index, close)) {
        emit(collector, value, 'import', match.index);
      }
      GO_IMPORT.lastIndex = close;
      continue;
    }

    // A single import may carry a package name, `import fmt2 "fmt"`, `import
    // 名 "fmt"` or `import _ "x"`, or a `.` ("Import declarations"). A name at
    // the end of its line has a semicolon put after it, and a comment that
    // holds a line break ends the line too ("Semicolons", "Comments"): the
    // import ends there, with no path, which Go refuses.
    if (reader.peek() === '.') {
      reader.index += 1;
    } else {
      const name = reader.identifier();
      // On from the keyword, so that `import import "x"` is read as no
      // import, and not as a second.
      if (GO_KEYWORDS.has(name)) {
        GO_IMPORT.lastIndex = reader.index;
        continue;
      }
      // With no name the space after `import` was passed over already, so
      // this finds a line break only after one.
      const after = reader.index;
      reader.skipSpace();
      if (code.slice(after, reader.index).includes('\n')) continue;
    }
    reader.skipSpace();
    const literal = literalAt(collector.masked, reader.index);
    if (literal !== null) emit(collector, literal, 'import', match.index);
  }
}

/* --------------------------------------------------------------------- rust */

/** Rust's white space, Unicode's Pattern_White_Space, which a masked comment is too. */
const RUST_SPACE = String.raw`\t\n\v\f\r \u{85}\u{200e}\u{200f}\u{2028}\u{2029}`;

/**
 * Where a use declaration or an extern crate starts. The keyword is a whole
 * word, so not the tail of `r#use`, a raw identifier.
 */
const RUST_USE = new RegExp(String.raw`(?<![\p{XID_Continue}#])(?:use|extern[${RUST_SPACE}]+crate)(?!\p{XID_Continue})`, 'gu');

/**
 * One token of a use declaration, after any white space: a name, raw or not,
 * `$crate` or another of a macro's names, or a mark. Nothing need separate two
 * tokens that cannot be read as one.
 */
const RUST_TOKEN = new RegExp(String.raw`[${RUST_SPACE}]*(?:(r#)?([\p{XID_Start}_]\p{XID_Continue}*)|(\$[\p{XID_Start}_]\p{XID_Continue}*|::|[{},*;]))`, 'uy');

/** Nothing but white space, to the end of the text. */
const RUST_BLANK = new RegExp(String.raw`^[${RUST_SPACE}]*$`, 'u');

/** What `r#` cannot make a raw identifier of. */
const RUST_NOT_RAW: ReadonlySet<string> = new Set(['_', 'crate', 'self', 'Self', 'super']);

/**
 * What no segment of a path, alias or crate name is unless written raw:
 * `_`, and Rust's keywords in every edition, strict and reserved (Keywords,
 * as read on 2026-10-19), `Self` among them, which no use path holds
 * (Use declarations, "use Paths"). So a declaration left open is never read
 * on into the next, whose `use` or `extern` is one. `crate`, `self` and
 * `super` are not here: they stand where `rustPathRefused` lets them.
 * `async`, `await` and `dyn` are keywords from the 2018 edition on, `try`
 * from 2018 and `gen` from 2024, and the edition is in `Cargo.toml`, which
 * the reader does not open, so each is read as the name it is before them.
 */
const RUST_NOT_SEGMENT: ReadonlySet<string> = new Set([
  '_',
  ...['as', 'break', 'const', 'continue', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop'],
  ...['match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'Self', 'static', 'struct', 'trait', 'true', 'type', 'unsafe'],
  ...['use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized'],
  ...['virtual', 'yield'],
]);

/** The words a path starts with to name a module, which an import binds only under a name of its own. */
const RUST_PATH_KEYWORDS: ReadonlySet<string> = new Set(['crate', 'self', 'super', '$crate']);

interface RustToken {
  /** A name as rustc compares two, in its NFC form and with no `r#`; or a mark. */
  text: string;
  name: boolean;
  raw: boolean;
  /** Where the text goes on after it. */
  end: number;
}

/** The token at `index`, or null where none starts. */
function rustToken(text: string, index: number): RustToken | null {
  RUST_TOKEN.lastIndex = index;
  const match = RUST_TOKEN.exec(text);
  if (match === null) return null;
  const [, raw, word, mark] = match;
  // `r#` stands only before a name.
  if (raw !== undefined && RUST_NOT_RAW.has(word!)) return null;
  return { text: word?.normalize('NFC') ?? mark!, name: word !== undefined, raw: raw !== undefined, end: RUST_TOKEN.lastIndex };
}

/** One path of a use tree, segment by segment. */
interface UsePath {
  segments: string[];
  /** Written after a leading `::`, which names the extern prelude, or the crate root in the 2015 edition. */
  global: boolean;
  /** Binding what it names under that name: no `as`, no glob and no empty group. */
  bare: boolean;
}

/**
 * Whether rustc refuses a path of a use tree for where `crate`, `self`,
 * `super` or `$crate` stands in it (Paths, "Path qualifiers"), or for
 * importing a module that it binds only under a name given with `as` (Use
 * declarations, "Restrictions"), each as read on 2026-10-19, and each held
 * to rustc 1.97.1 in every edition.
 */
function rustPathRefused({ segments, global, bare }: UsePath): boolean {
  const last = segments.length - 1;
  const misplaced = segments.some((segment, at) => {
    // First, and not after a `::`.
    if (segment === 'crate' || segment === '$crate') return at > 0 || global;
    // First and not after a `::`, or last after one: `a::self` names `a`.
    // `::{self as root}` imports the crate root in the 2015 edition and is
    // refused from 2018, which the reader cannot tell apart, so it is read.
    if (segment === 'self') return at < last && (at > 0 || global);
    // Only after other `super`s, or after a first `self`: a `self` anywhere
    // else before it is refused where it stands.
    if (segment === 'super') return global || !segments.slice(0, at).every((before) => before === 'super' || before === 'self');
    return false;
  });
  // `use crate;`, `use self;`, `use super::super;` and `use a::{self}` with
  // `a` one of them: the module is bound only under a name given with `as`.
  // `use crate::{};` binds nothing, and rustc takes it. A trailing `self`
  // is one of those words too, so `use crate::self;` is refused alike.
  return misplaced || (bare && segments.every((segment) => RUST_PATH_KEYWORDS.has(segment)));
}

/**
 * The paths one use tree names, segment by segment, read as the Rust
 * Reference's grammar has it:
 *
 *   (path ::)? *    (path ::)? { tree, ... }    path (as name)?
 *
 * `refused` where rustc would refuse the text, and `overflow` past
 * MAX_EXPANSION paths or groups nested that deep. `end` is where reading
 * stopped, past the tree or at the token it could not read.
 */
function readUseTree(text: string, from: number): { paths: UsePath[] | 'refused' | 'overflow'; end: number } {
  let index = from;
  const take = (accept: (token: RustToken) => boolean): RustToken | null => {
    const token = rustToken(text, index);
    if (token === null || !accept(token)) return null;
    index = token.end;
    return token;
  };
  // No name is written as a mark is.
  const mark = (text: string): boolean => take((token) => token.text === text) !== null;
  // A name, or `$crate` or another name of a macro's, which rustc reads
  // where the macro is expanded.
  const named = (token: RustToken): boolean => token.name || token.text.startsWith('$');
  // `_` is a token of its own, and stands in a path only after `as`.
  const segment = (): string | null => take((token) => named(token) && (token.raw || !RUST_NOT_SEGMENT.has(token.text)))?.text ?? null;
  // A name given with `as`: `_`, or a name that is no keyword and no word a path starts with.
  const alias = (token: RustToken): boolean => named(token) && (token.raw || token.text === '_' || !(RUST_NOT_SEGMENT.has(token.text) || RUST_PATH_KEYWORDS.has(token.text)));

  const paths: UsePath[] = [];
  const tree = (head: readonly string[], rooted: boolean, depth: number): 'read' | 'refused' | 'overflow' => {
    if (depth > MAX_EXPANSION) return 'overflow';
    const path = [...head];
    // A `::` before the first segment of all is the global root, and rustc
    // refuses one anywhere else: `use a::{::b};`.
    const leading = mark('::');
    if (leading && head.length > 0) return 'refused';
    const global = rooted || leading;
    for (let name = segment(); name !== null; name = segment()) {
      path.push(name);
      if (mark('::')) continue;
      const renamed = take((token) => !token.raw && token.text === 'as') !== null;
      if (renamed && take(alias) === null) return 'refused';
      paths.push({ segments: path, global, bare: !renamed });
      return 'read';
    }
    // A separator was the last token read, or nothing was.
    if (mark('*')) {
      // A glob binds no module of its own; its `*` is no word a path starts
      // with either, so `bare` is never what decides it.
      paths.push({ segments: [...path, '*'], global, bare: false });
      return 'read';
    }
    if (!mark('{')) return 'refused';
    if (mark('}')) {
      // An empty group imports nothing, and rustc still reads the path before
      // it as an import: its lint names `use a::{};` an unused one.
      paths.push({ segments: path, global, bare: false });
      return 'read';
    }
    do {
      const read = tree(path, global, depth + 1);
      if (read !== 'read') return read;
      if (paths.length > MAX_EXPANSION) return 'overflow';
    } while (mark(',') && rustToken(text, index)?.text !== '}');
    return mark('}') ? 'read' : 'refused';
  };

  const read = tree([], false, 0);
  return { paths: read !== 'read' ? read : paths.some(rustPathRefused) ? 'refused' : paths, end: index };
}

/** The module a path of a use tree names, in the notation a rule writes, or nothing. */
function usePath({ segments }: UsePath): string {
  // `a::b::self` names `a::b`, as `a::{self}` names `a`. A glob of nothing,
  // the one path a `*` starts, names no module.
  const named = segments.length > 1 && segments.at(-1) === 'self' ? segments.slice(0, -1) : segments;
  return named[0] === '*' ? '' : named.join('::');
}

/**
 * Expands one use tree, with its `;` or without, into the module paths it
 * names.
 *
 * `a::{b, c::{d, e}}` is three dependencies written as one declaration, and a
 * rule about `a::c` has to see them. A tree is read as rustc reads it: white
 * space and comments between its tokens, a raw identifier without its `r#`, a
 * name in its NFC form, and `self` at the end of a path naming what is before
 * it. Text that is no use tree, which rustc refuses, names nothing (ADR-0008,
 * amended 2026-10-18), and so does a tree with a keyword for a segment, or
 * with `crate`, `self` or `super` where rustc refuses it (amended
 * 2026-10-19). A `$` name is read as a macro's, as a tree alone says nothing
 * of where it stands. Returns null when the tree would name more than
 * MAX_EXPANSION paths, or nest its groups deeper than that, which the caller
 * reports rather than truncating.
 */
export function expandUsePath(input: string): string[] | null {
  const { paths, end } = readUseTree(input, 0);
  if (paths === 'overflow') return null;
  const semicolon = rustToken(input, end);
  const rest = input.slice(semicolon?.text === ';' ? semicolon.end : end);
  return paths !== 'refused' && RUST_BLANK.test(rest) ? paths.map(usePath).filter((path) => path !== '') : [];
}

/**
 * The crate an extern crate declaration names, read from after `crate`, or
 * null where rustc refuses it: `extern crate name (as alias)? ;`, the name an
 * identifier that is no keyword, or `self` with an alias, which rustc takes
 * only so, and the end of its `;`.
 */
function externCrate(text: string, from: number): { crate: string; end: number } | null {
  // A name that is no keyword and no word a path starts with, raw or not.
  const name = (token: RustToken): boolean => token.name && (token.raw || !(RUST_NOT_SEGMENT.has(token.text) || RUST_PATH_KEYWORDS.has(token.text)));
  const crate = rustToken(text, from);
  if (crate === null || !(name(crate) || crate.text === 'self')) return null;
  let next = rustToken(text, crate.end);
  const renamed = next !== null && !next.raw && next.text === 'as';
  if (renamed) {
    const alias = rustToken(text, next!.end);
    next = alias !== null && (name(alias) || alias.text === '_') ? rustToken(text, alias.end) : null;
  }
  return next?.text === ';' && (renamed || crate.text !== 'self') ? { crate: crate.text, end: next.end } : null;
}

/**
 * Where a macro's tokens stand: the group of an invocation, `m!(...)`,
 * `path::m![...]` or `m! {...}`, of a definition, `macro_rules! m {...}`
 * and `macro m(...) {...}`, and of an attribute, `#[...]` and `#![...]`.
 * rustc reads them as tokens and refuses none of them for not being a
 * declaration: a matcher holds the word `use`, and `quote!` writes
 * `use #name::Thing;`. Too wide a reach costs a note, never a reading: a
 * declaration in one is read as everywhere else.
 */
const RUST_MACRO = new RegExp(
  String.raw`(?:(?<!\p{XID_Continue})macro_rules[${RUST_SPACE}]*![${RUST_SPACE}]*[\p{XID_Start}_]\p{XID_Continue}*|(?<![\p{XID_Continue}#])(macro)[${RUST_SPACE}]+[\p{XID_Start}_]\p{XID_Continue}*|\p{XID_Continue}!|#!?)[${RUST_SPACE}]*([(\[{])`,
  'gu',
);
const RUST_CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
/** The brace a `macro` definition's body opens after its parameters. */
const RUST_BODY = new RegExp(String.raw`[${RUST_SPACE}]*\{`, 'uy');

/** The half-open ranges of a file's macro tokens, outermost only, ascending. */
function macroRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  RUST_MACRO.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUST_MACRO.exec(code)) !== null) {
    const opener = match[2]!;
    let end = matchingClose(code, RUST_MACRO.lastIndex - 1, opener, RUST_CLOSERS[opener]!) + 1;
    // The body ends at its `}`, and `- 1` for its `+ 1` is an equivalent
    // mutant: no `use` starts in the body's last two characters.
    RUST_BODY.lastIndex = end;
    if (match[1] !== undefined && RUST_BODY.test(code)) end = matchingClose(code, RUST_BODY.lastIndex - 1, '{', '}') + 1;
    ranges.push([match.index, end]);
    // Outermost only: each is read to its end once, so nesting costs nothing.
    RUST_MACRO.lastIndex = end;
  }
  return ranges;
}

const RUST_SPACE_CHARACTER = new RegExp(`[${RUST_SPACE}]`, 'u');

/** Whether `at` is where an item or a statement may start: at the head of the file, or after `;`, a brace, an attribute's `]`, `pub` or its `(...)`. */
function startsAnItem(code: string, at: number): boolean {
  let before = at;
  while (RUST_SPACE_CHARACTER.test(code[before - 1] ?? '')) before -= 1;
  return before === 0 || ';{}])'.includes(code[before - 1]!) || /(?<!\p{XID_Continue})pub$/u.test(code.slice(Math.max(0, before - 4), before));
}

/**
 * A doc comment, which rustc reads as an attribute: three slashes and no
 * fourth, `//!`, a block opened with two stars and no third that holds
 * something, and a block opened with `/*!` (Comments, as read on
 * 2026-10-19).
 */
const RUST_DOC = /^(?:\/\/\/(?!\/)|\/\/!|\/\*\*(?![*/])|\/\*!)/;

function readRust(collector: Collector): void {
  const { code, comments, source } = collector.masked;
  const macros = macroRanges(code);
  let macro = 0;
  let comment = 0;
  RUST_USE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RUST_USE.exec(code)) !== null) {
    const at = match.index;
    while (macro < macros.length && macros[macro]![1] <= at) macro += 1;
    // A range starts at a macro's name or an attribute's `#`, never where a
    // `use` does, so `<` for `<=` is an equivalent mutant; and no comment
    // starts where a `use` does, so `<=` for the `<` after it is one too.
    const inMacro = macro < macros.length && macros[macro]![0] <= at;
    while (comment < comments.length && comments[comment]![0] < at) comment += 1;
    // A doc comment between `use` and the end of the declaration, which rustc
    // reads as an attribute where no attribute may stand.
    const documented = (end: number): boolean => {
      for (let next = comment; next < comments.length && comments[next]![0] < end; next++) {
        if (RUST_DOC.test(source.slice(comments[next]![0], comments[next]![0] + 4))) return true;
      }
      return false;
    };
    // What rustc refuses is said where it starts as a declaration: where an
    // item or a statement may start, and not among a macro's tokens, which
    // rustc does not read as one (ADR-0008, amended 2026-10-19).
    const refused = (): void => {
      if (!inMacro && startsAnItem(code, at)) {
        note(collector, 'refused', at, 'a declaration that starts as a use or an extern crate is one rustc refuses, and no module is read from it');
      }
    };
    const start = at + match[0].length;
    if (match[0] !== 'use') {
      const extern = externCrate(code, start);
      if (extern !== null && !documented(extern.end)) emit(collector, extern.crate, 'use', at);
      else refused();
      continue;
    }
    const { paths, end } = readUseTree(code, start);
    const semicolon = rustToken(code, end);
    if (paths === 'overflow') {
      note(collector, 'truncated', at, `a use declaration expands to more than ${MAX_EXPANSION} module paths, or nests its groups deeper than that`);
    } else if (
      paths !== 'refused' &&
      semicolon?.text === ';' &&
      !documented(semicolon.end) &&
      // A `$` name stands only in a macro's tokens, where it is read as the
      // macro is expanded.
      (inMacro || !paths.some(({ segments }) => segments.some((segment) => segment.startsWith('$'))))
    ) {
      for (const path of paths) emit(collector, usePath(path), 'use', at);
    } else {
      refused();
    }
    // On from where reading stopped, past the tree or at the token rustc
    // would refuse, so that no token is read twice. No segment is `use` or
    // `extern`, so no declaration is read into the next.
    RUST_USE.lastIndex = end;
  }
}

/* -------------------------------------------------------------------- c-sharp */

/** What C# lets continue an identifier beside a letter: a mark, a digit, a connector, a formatting character. */
const CSHARP_PART = String.raw`\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}`;
/** C#'s white space, and what ends a line. */
const CSHARP_BLANK = String.raw`\p{Zs}\t\v\f`;
const CSHARP_BREAK = String.raw`\r\n\u{85}\u{2028}\u{2029}`;

/**
 * Everything the C# reader stops at: a using, a namespace, or a brace. Each
 * keyword is a whole word, so neither the identifier `@using` nor a word an
 * escape goes on with.
 */
const CSHARP_TOKEN = new RegExp(String.raw`(?<![${CSHARP_PART}@\\])(?:using|namespace)(?![${CSHARP_PART}\\])|[{}]`, 'gu');

/**
 * A pre-processing directive, which takes the whole of its line, so that the
 * message of a `#region` is no code.
 */
const CSHARP_DIRECTIVE = new RegExp(String.raw`^[${CSHARP_BLANK}]*#[^${CSHARP_BREAK}]*`, 'gmu');

/**
 * One token of a using directive or a namespace declaration, after any white
 * space or end of a line, which a masked comment is too: a word, as an
 * identifier and a keyword are both written, or a mark.
 */
const CSHARP_WORD = new RegExp(
  String.raw`[${CSHARP_BLANK}${CSHARP_BREAK}]*(?:(@?(?:[${CSHARP_PART}]|\\u[\dA-Fa-f]{4}|\\U[\dA-Fa-f]{8})+)|(::|[.;=<>,?*\[\](){}]))`,
  'uy',
);

const CSHARP_ESCAPE = /\\u([\dA-Fa-f]{4})|\\U([\dA-Fa-f]{8})/g;
const CSHARP_IDENTIFIER = new RegExp(String.raw`^[\p{L}\p{Nl}_][${CSHARP_PART}]*$`, 'u');

/**
 * C#'s keywords (6.4.4, as read on 2026-10-19), which no identifier is
 * unless written with `@`, or with an escape in it, which no keyword holds.
 * Its contextual keywords, `global`, `var` and `dynamic` among them, are
 * identifiers where a name stands.
 */
const CSHARP_KEYWORDS: ReadonlySet<string> = new Set([
  ...['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue'],
  ...['decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally'],
  ...['fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock'],
  ...['long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected'],
  ...['public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string'],
  ...['struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort'],
  ...['using', 'virtual', 'void', 'volatile', 'while'],
]);

/** The keywords that name a type (8.2.1, 8.3.1): `void` is one only before a `*`. */
const CSHARP_TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  ...['bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte', 'short', 'string', 'uint'],
  ...['ulong', 'ushort'],
]);

/**
 * The identifier a word is, as C# compares two: with no `@`, each escape the
 * character it stands for, and no formatting character. Null for a word that
 * is no identifier: a digit first, or an escape of what no identifier holds.
 */
function csharpIdentifier(word: string): string | null {
  // A word holds an `@` only as its first character.
  const decoded = word.replace('@', '').replace(CSHARP_ESCAPE, (_, short: string | undefined, long: string | undefined) => {
    try {
      return String.fromCodePoint(Number.parseInt(short ?? long!, 16));
    } catch {
      // \U can write a number no character has. A dot is no part of a name.
      return '.';
    }
  });
  return CSHARP_IDENTIFIER.test(decoded) ? decoded.replace(/\p{Cf}/gu, '') : null;
}

/** A cursor over the tokens of one directive or declaration. */
class CsharpTokens {
  /** How deep the type being read is. */
  private nesting = 0;
  /** Whether a type nested deeper than MAX_EXPANSION, and was not read. */
  overflow = false;
  /** The name of each type read, in the order written: a type is its name, then its arguments. */
  readonly names: string[] = [];

  constructor(
    private readonly text: string,
    public index: number,
  ) {}

  private next(): { word?: string; mark?: string; end: number } | null {
    CSHARP_WORD.lastIndex = this.index;
    const match = CSHARP_WORD.exec(this.text);
    return match === null ? null : { word: match[1], mark: match[2], end: CSHARP_WORD.lastIndex };
  }

  mark(mark: string): boolean {
    const token = this.next();
    if (token?.mark !== mark) return false;
    this.index = token.end;
    return true;
  }

  /** A keyword, as it is written: `@static`, and `static` with an escape in it, are identifiers. */
  keyword(word: string): boolean {
    const token = this.next();
    if (token?.word !== word) return false;
    this.index = token.end;
    return true;
  }

  /**
   * An identifier, which is never a keyword as it is written: so `using
   * class.N;` names nothing, and a directive left open is never read on
   * into the next, whose `using` or `namespace` is one.
   */
  identifier(): string | null {
    const token = this.next();
    const name = token?.word === undefined || CSHARP_KEYWORDS.has(token.word) ? null : csharpIdentifier(token.word);
    if (name !== null) this.index = token!.end;
    return name;
  }

  /** `name (. name)*`, the name of a namespace declaration. */
  qualified(): string | null {
    const parts: string[] = [];
    for (let part = this.identifier(); part !== null; part = this.identifier()) {
      parts.push(part);
      if (!this.mark('.')) return parts.join('.');
    }
    return null;
  }

  /**
   * A namespace or type name, `(alias ::)? name (. name)*`, or null. What
   * stands before `::` says where to look the name up, the global namespace
   * or an extern alias, and is no part of it. Where `generic` allows them, a
   * type argument list after a name is passed over.
   */
  name(generic: boolean): string | null {
    let part = this.identifier();
    if (part !== null && this.mark('::')) part = this.identifier();
    const parts: string[] = [];
    for (; part !== null; part = this.identifier()) {
      parts.push(part);
      if (generic && !this.typeArguments()) return null;
      if (!this.mark('.')) return parts.join('.');
    }
    return null;
  }

  /**
   * Passes over a type argument list, `<` to the `>` that closes it, each
   * argument a type and none a pointer, which the compiler refuses there;
   * false where something else stands. Token by token, so it never reads
   * past a `;`, a brace or the next directive.
   */
  private typeArguments(): boolean {
    if (!this.mark('<')) return true;
    do {
      if (!this.type(false)) return false;
    } while (this.mark(','));
    return this.mark('>');
  }

  /**
   * Passes over a type, as the specification has one (8.1 and 24.3): a
   * tuple of two or more, a keyword that names a type, a function pointer
   * or a name with its type arguments, then the marks of a nullable, an
   * array and a pointer. A pointer, a function pointer among them, only where
   * `pointers` lets one stand: in an alias that is `unsafe`, and never in a
   * tuple or a type argument. False where the text is none, and where it
   * nests deeper than MAX_EXPANSION, as a Rust use group may not, with
   * `overflow` set: so no type nested twenty thousand deep runs the reader
   * out of stack.
   */
  type(pointers: boolean): boolean {
    if (this.nesting >= MAX_EXPANSION) {
      this.overflow = true;
      return false;
    }
    this.nesting += 1;
    const read = this.typeWithin(pointers);
    this.nesting -= 1;
    return read;
  }

  private typeWithin(pointers: boolean): boolean {
    let pointer = false;
    // Where no word is next, at the end of the text or before a mark, `''`
    // is none of what a word is compared with, `delegate`, `void` and the
    // type keywords: any other such string for it is an equivalent mutant.
    const word = this.next()?.word ?? '';
    if (this.mark('(')) {
      let elements = 0;
      do {
        if (!this.type(false)) return false;
        // The name an element may have.
        this.identifier();
        elements += 1;
      } while (this.mark(','));
      if (elements < 2 || !this.mark(')')) return false;
    } else if (word === 'delegate' || word === 'void') {
      this.keyword(word);
      if (!this.mark('*') || (word === 'delegate' && !this.functionPointer())) return false;
      pointer = true;
    } else if (CSHARP_TYPE_KEYWORDS.has(word)) {
      this.keyword(word);
    } else {
      // Before the names its arguments hold, which reading it put here.
      const at = this.names.length;
      const name = this.name(true);
      if (name === null) return false;
      this.names.splice(at, 0, name);
    }
    for (;;) {
      if (this.mark('?')) continue;
      if (this.mark('*')) {
        pointer = true;
        continue;
      }
      if (!this.mark('[')) return pointers || !pointer;
      while (this.mark(',')) continue;
      if (!this.mark(']')) return false;
    }
  }

  /**
   * What follows `delegate*`: a calling convention or none, then `<`, the
   * parameters, each `ref`, `ref readonly`, `in` or `out` or none, and the
   * return type, `void` among them, then `>` (24.3.3).
   */
  private functionPointer(): boolean {
    if (this.keyword('unmanaged') && this.mark('[')) {
      do {
        if (this.identifier() === null) return false;
      } while (this.mark(','));
      if (!this.mark(']')) return false;
    } else {
      this.keyword('managed');
    }
    if (!this.mark('<')) return false;
    do {
      if (this.keyword('ref')) this.keyword('readonly');
      else if (!this.keyword('in')) this.keyword('out');
      if (!this.keyword('void') && !this.type(true)) return false;
    } while (this.mark(','));
    return this.mark('>');
  }
}

/**
 * The namespaces and types a using directive names, read from after
 * `using`, or null where C# would refuse it:
 *
 *   using static unsafe? type ;    using unsafe? alias = name-or-type ;    using namespace ;
 *
 * `global` before `using` changes nothing of it. A type is read whole: a
 * name, then each type its arguments name, and each element of a tuple; a
 * keyword that names a type, `int` or `string`, names nothing, and nor does
 * a tuple element's own name, and an alias of a type that names nothing is
 * no refusal. A using statement and a using declaration are none of these,
 * and are read as nothing.
 */
function usingDirective(tokens: CsharpTokens): string[] | null {
  let target: string[] | null;
  if (tokens.keyword('static')) {
    tokens.keyword('unsafe');
    const name = tokens.name(true);
    target = name === null ? null : [name, ...tokens.names];
  } else {
    const unsafe = tokens.keyword('unsafe');
    const start = tokens.index;
    if (tokens.identifier() !== null && tokens.mark('=')) {
      // An alias may name any type (14.6.2), and a pointer of one where it
      // is `unsafe`.
      if (!tokens.type(unsafe)) return null;
      target = tokens.names;
    } else if (unsafe) {
      return null;
    } else {
      tokens.index = start;
      const name = tokens.name(false);
      target = name === null ? null : [name];
    }
  }
  // A type named twice, `G.L<G.L<int>>`, is one dependency. A refused
  // directive stays null, not an empty list, which is what says it refused.
  return tokens.mark(';') && target !== null ? [...new Set(target)] : null;
}

/**
 * Whether the tokens after a `using` start a using statement or a using
 * declaration, which top-level statements may hold where a directive may
 * stand: `(`, or a type and the name of a local, `using var x = ...;` and
 * `using N.D? d = null;` among them. Each is a statement the compiler reads
 * as one, refused or not, and no directive it refuses.
 */
function startsAStatement(code: string, from: number): boolean {
  const tokens = new CsharpTokens(code, from);
  return tokens.mark('(') || (tokens.type(true) && tokens.identifier() !== null);
}

const CSHARP_SPACE_CHARACTER = new RegExp(`[${CSHARP_BLANK}${CSHARP_BREAK}]`, 'u');
const CSHARP_GLOBAL_BEFORE = new RegExp(String.raw`(?<![${CSHARP_PART}@\\])global$`, 'u');

/**
 * Whether a `using` at `at` stands where a directive may start: at the head
 * of the file, after `;` or a brace, or after `global`. Where it follows
 * anything else, `await` or an `)`, it starts a statement.
 */
function startsADirective(code: string, at: number): boolean {
  let before = at;
  while (CSHARP_SPACE_CHARACTER.test(code[before - 1] ?? '')) before -= 1;
  return before === 0 || ';{}'.includes(code[before - 1]!) || CSHARP_GLOBAL_BEFORE.test(code.slice(Math.max(0, before - 7), before));
}

/** The `#if` or `#endif` a pre-processing line is, or neither. */
const CSHARP_CONDITION = new RegExp(String.raw`^[${CSHARP_BLANK}]*#[${CSHARP_BLANK}]*(if|endif)(?![${CSHARP_PART}])`, 'u');

/**
 * The half-open ranges from each outermost `#if` to the end of its `#endif`.
 * The compiler skips the text of a section whose condition is false and reads
 * none of it (6.5.5), and which condition holds is the build's to say: so a
 * directive there is read as one anywhere else, and none is said to be
 * refused. One left open runs to the end of the file.
 */
function conditionalRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  CSHARP_DIRECTIVE.lastIndex = 0;
  let line: RegExpExecArray | null;
  while ((line = CSHARP_DIRECTIVE.exec(code)) !== null) {
    const kind = CSHARP_CONDITION.exec(line[0])?.[1];
    if (kind === 'if' && depth++ === 0) start = line.index;
    if (kind === 'endif' && depth > 0 && --depth === 0) ranges.push([start, line.index + line[0].length]);
  }
  if (depth > 0) ranges.push([start, code.length]);
  return ranges;
}

/** A block namespace not yet closed, and the brace depth of its body. */
interface OpenNamespace {
  name: string;
  depth: number;
}

/**
 * Reads using directives and the namespaces a file declares, in one pass.
 *
 * One pass because each needs what the other knows. A using inside a namespace
 * resolves its name there first - in `namespace A.B { using C; }`, `C` may be
 * `A.B.C` or `A.C` - so the namespace around it is kept on the reference
 * (ADR-0008). And a block namespace inside another is named in full: `namespace
 * A { namespace B {` declares `A` and `A.B`, the name a using elsewhere writes.
 *
 * Depth, not offsets, decides what is inside what. A namespace is open until
 * the brace depth falls below its body's, so nothing here compares an offset
 * with the offset of a delimiter - which no keyword can ever sit on, and which
 * would leave `<` and `<=` meaning the same thing to every test. The code is
 * masked, so no brace in a string, a comment or a pre-processing directive
 * counts.
 *
 * A directive and a declaration are read token by token, as the C#
 * specification has them (ADR-0008, amended 2026-10-18): white space and
 * comments between the tokens, an identifier as C# compares two, and what
 * C# refuses read as nothing. Each type a directive names is read whole,
 * the types its arguments name and a tuple's elements among them, and each
 * is a reference. What it refuses is said where it starts as a directive:
 * in no brace but a namespace's, where a directive may start, where no
 * statement does, and outside every `#if` (amended 2026-10-19).
 */
function readCsharp(collector: Collector): void {
  // A byte order mark at the head of a file is no character of its text.
  const marked = collector.masked.code.replace(/^\u{feff}/u, ' ');
  const conditions = conditionalRanges(marked);
  let condition = 0;
  const code = marked.replace(CSHARP_DIRECTIVE, (line) => ' '.repeat(line.length));
  const declared = new Set<string>();
  const open: OpenNamespace[] = [];
  let fileScoped: string | undefined;
  let depth = 0;
  CSHARP_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CSHARP_TOKEN.exec(code)) !== null) {
    const token = match[0];
    if (token === '{') {
      depth += 1;
      continue;
    }
    if (token === '}') {
      depth -= 1;
      while (open.length > 0 && open.at(-1)!.depth > depth) open.pop();
      continue;
    }

    const tokens = new CsharpTokens(code, CSHARP_TOKEN.lastIndex);
    if (token === 'namespace') {
      const name = tokens.qualified();
      if (name !== null) {
        const scoped = tokens.mark(';');
        if (scoped || tokens.mark('{')) {
          const outer = open.at(-1);
          const full = outer === undefined ? name : `${outer.name}.${name}`;
          // A file-scoped namespace covers the rest of the file, and C# allows
          // neither a second one nor a block beside it. A block's brace is
          // read here, and counted.
          if (scoped) fileScoped = full;
          else open.push({ name: full, depth: (depth += 1) });
          declared.add(full);
        }
      }
    } else {
      const targets = usingDirective(tokens);
      // A section starts at the head of its `#if` line and ends at its
      // `#endif` line's end, where no `using` starts: `<` for either `<=`
      // is an equivalent mutant.
      while (condition < conditions.length && conditions[condition]![1] <= match.index) condition += 1;
      const conditional = condition < conditions.length && conditions[condition]![0] <= match.index;
      if (targets !== null) {
        for (const target of targets) emit(collector, target, 'using', match.index, open.at(-1)?.name ?? fileScoped);
      } else if (tokens.overflow) {
        note(collector, 'truncated', match.index, `a using directive nests its types deeper than ${MAX_EXPANSION}`);
      } else if (!conditional && depth === (open.at(-1)?.depth ?? 0) && startsADirective(code, match.index) && !startsAStatement(code, CSHARP_TOKEN.lastIndex)) {
        note(collector, 'refused', match.index, 'a directive that starts as a using is one the C# compiler refuses, and no namespace is read from it');
      }
    }
    // On from where reading stopped, so that no token is read twice. No name
    // is `using` or `namespace`, so no directive is read into the next.
    CSHARP_TOKEN.lastIndex = tokens.index;
  }
  collector.namespaces = [...declared];
}

/* ----------------------------------------------------------------- normalise */

/**
 * Rewrites a specifier into the `/`-separated form module patterns match.
 *
 * Every language names modules with its own separator - `a.b.c`, `a::b::c`,
 * `a/b/c` - and a rule author should not have to know which one a given file
 * uses. One notation, and the raw specifier stays matchable too, so a pattern
 * written either way finds the dependency.
 *
 * Python's relative imports resolve against the importing file, the same path
 * arithmetic (and the same refusal to touch the filesystem) as ADR-0005.
 * Rust's `self::` and `super::` deliberately do not: resolving them needs the
 * module tree, the module tree needs to know where inline `mod` blocks are, and
 * that needs a parser. They are matched literally instead, and ADR-0008 says so
 * out loud rather than leaving a rule to quietly miss them.
 */
export function normalizeModule(specifier: string, importingFile: string, language: ModuleLanguage): string {
  if (language === 'go') return specifier;
  if (language === 'rust') return specifier.replace(/::/g, '/');

  // No branch for C#. A C# specifier is dotted and never relative, so the
  // general case below already returns exactly what a `language === 'csharp'`
  // branch returned - it was a special case that did nothing special.
  if (!specifier.startsWith('.')) return specifier.replace(/\./g, '/');
  let level = 0;
  while (specifier[level] === '.') level += 1;
  const tail = specifier.slice(level).replace(/\./g, '/');
  let base = path.posix.dirname(importingFile);
  for (let up = 1; up < level; up++) base = path.posix.dirname(base);
  return path.posix.normalize(path.posix.join(base, tail));
}

/**
 * The modules a specifier sits under, nearest first: `a.b` and `a` for
 * `a.b.c`, in the language's own notation.
 *
 * Nothing for Go, whose import paths already carry their hierarchy in `/`, and
 * nothing for a Python relative import, which is matched by the path it
 * resolves to.
 */
export function enclosingModules(specifier: string, language: ModuleLanguage): string[] {
  if (language === 'go' || specifier.startsWith('.')) return [];
  const separator = language === 'rust' ? '::' : '.';
  const parts = specifier.split(separator);
  const enclosing: string[] = [];
  for (let length = parts.length - 1; length > 0; length--) enclosing.push(parts.slice(0, length).join(separator));
  return enclosing;
}

/* -------------------------------------------------------------------- entry */

const READERS: Record<ModuleLanguage, (collector: Collector) => void> = {
  python: readPython,
  go: readGo,
  rust: readRust,
  csharp: readCsharp,
};

/** Extracts every module reference from a Python, Go, Rust or C# source file. */
export function analyzePolyglot(source: string, file: string, language: ModuleLanguage): FileImports {
  const masked = mask(source, language);
  const collector: Collector = { references: [], notes: [], masked, file };
  (READERS[language] as (collector: Collector) => void)(collector);

  if (masked.unterminated) {
    collector.notes.push({
      kind: 'unreadable',
      file,
      line: 1,
      column: 1,
      detail: 'a string or comment was never closed, so its imports are not trustworthy',
    });
  }
  return { references: collector.references, notes: collector.notes, namespaces: collector.namespaces };
}
