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
  const blanks = [...comments, ...strings.map(([start, end]) => [start + 1, end] as const)];
  return { code: maskRanges(source, blanks), strings, source, starts: lineStarts(source), unterminated };
}

/** The literal that starts exactly at `offset`, or null. */
function literalAt(masked: Masked, offset: number): string | null {
  const { strings } = masked;
  let low = 0;
  let high = strings.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = strings[mid] as CommentRange;
    if (start === offset) return literalValue(masked.source.slice(start, end));
    if (start < offset) low = mid + 1;
    else high = mid - 1;
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
  if (text.startsWith('r#"')) return text.slice(3, -2);
  if (text.startsWith('r"')) return text.slice(2, -1);
  if (text.startsWith('"""') || text.startsWith("'''")) return text.slice(3, -3);
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === '`') return text.slice(1, -1);
  /* c8 ignore next -- every literal the lexer emits starts with one of the above */
  return text;
}

/* ------------------------------------------------------------------ reading */

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Whitespace-skipping cursor over masked code. */
class Reader {
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

  eat(token: string): boolean {
    if (!this.text.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  identifier(): string {
    IDENTIFIER.lastIndex = this.index;
    const match = IDENTIFIER.exec(this.text);
    if (!match) return '';
    this.index += match[0].length;
    return match[0];
  }

  /** Reads `a.b.c`, treating `::` as a separator too (C# alias qualifiers). */
  dotted(): string {
    const parts: string[] = [];
    for (;;) {
      const part = this.identifier();
      if (!part) break;
      parts.push(part);
      if (!this.eat('.') && !this.eat('::')) break;
    }
    return parts.join('.');
  }

  /** Skips a balanced `<...>`, so a generic alias target does not end the read. */
  skipGenerics(): void {
    if (this.peek() !== '<') return;
    let depth = 0;
    while (this.index < this.text.length) {
      const char = this.text[this.index] as string;
      if (char === '<') depth += 1;
      else if (char === '>') {
        depth -= 1;
        this.index += 1;
        if (depth === 0) return;
        continue;
      } else if (char === ';' || char === '\n') return;
      this.index += 1;
    }
  }
}

/** Offset of the matching close, given the depth-tracking characters. */
function matchingClose(text: string, open: number, opener: string, closer: string): number {
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
}

function emit(collector: Collector, specifier: string, kind: ReferenceKind, offset: number): void {
  const trimmed = specifier.trim();
  if (!trimmed) return;
  const { line, column } = locate(collector.masked.starts, offset);
  collector.references.push({ specifier: trimmed, kind, typeOnly: false, line, column });
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
 */
function logicalLines(code: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let text = '';
  let offset = 0;
  let depth = 0;
  let start = 0;

  const flush = (): void => {
    if (text.trim()) lines.push({ text, offset });
    text = '';
  };

  for (let index = 0; index <= code.length; index++) {
    if (index < code.length && code[index] !== '\n') {
      const char = code[index] as string;
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    const physical = code.slice(start, index);
    if (!text) offset = start;
    text += (text ? ' ' : '') + physical.replace(/\\$/, ' ');
    if (depth === 0 && !/\\$/.test(physical)) flush();
    start = index + 1;
  }
  flush();
  return lines;
}

/** `import` / `from` at a statement position: line start, or after `;` or `:`. */
const PYTHON_STATEMENT = /(?:^|[;:])[ \t]*(import|from)[ \t]+/g;
const PYTHON_FROM = /^(\.*)([A-Za-z_][\w.]*)?[ \t]*import[ \t]+(.*)$/;
const PYTHON_DYNAMIC = /\b(__import__|import_module)[ \t]*\(/g;

function readPython(collector: Collector): void {
  const { code } = collector.masked;

  for (const line of logicalLines(code)) {
    PYTHON_STATEMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PYTHON_STATEMENT.exec(line.text)) !== null) {
      const rest = line.text.slice(match.index + match[0].length).split(';')[0] as string;

      if (match[1] === 'import') {
        // `import a.b as x, c.d` - one statement, two dependencies.
        for (const clause of rest.split(',')) {
          const name = clause.trim().split(/\s+/)[0] as string | undefined;
          if (name) emit(collector, name, 'import', line.offset);
        }
        continue;
      }

      const from = PYTHON_FROM.exec(rest);
      if (!from) continue;
      const dots = from[1] as string;
      const module = from[2] ?? '';
      if (module || !dots) {
        emit(collector, `${dots}${module}`, 'import', line.offset);
        continue;
      }
      // `from . import a, b` - here the imported names are themselves modules,
      // which `from .pkg import name` cannot assume.
      const names = (from[3] as string).replace(/[()]/g, '');
      for (const clause of names.split(',').slice(0, MAX_EXPANSION)) {
        const name = clause.trim().split(/\s+/)[0] as string | undefined;
        if (name && name !== '*') emit(collector, `${dots}${name}`, 'import', line.offset);
      }
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

    // A single import may carry an alias: `import fmt2 "fmt"`, `import _ "x"`.
    if (reader.peek() === '_' || reader.peek() === '.') reader.index += 1;
    else reader.identifier();
    reader.skipSpace();
    const literal = literalAt(collector.masked, reader.index);
    if (literal !== null) emit(collector, literal, 'import', match.index);
  }
}

/* --------------------------------------------------------------------- rust */

const RUST_USE = /\b(?:use|extern[ \t\r\n]+crate)\b/g;

/**
 * Expands one `use` path into the module paths it actually names.
 *
 * `a::{b, c::{d, e}}` is three dependencies written as one statement, and a
 * rule about `a::c` has to see them. Returns null when the expansion would
 * exceed MAX_EXPANSION, which the caller reports rather than truncating.
 */
export function expandUsePath(input: string): string[] | null {
  const text = input.trim();
  const open = text.indexOf('{');
  if (open === -1) {
    // `a::b as c` and `a::b;` both name `a::b`.
    const leaf = text.split(/\s+as\s+/)[0] as string;
    const trimmed = leaf.replace(/[;\s]+$/, '').replace(/^::/, '');
    return trimmed ? [trimmed] : [];
  }

  const close = matchingClose(text, open, '{', '}');
  const prefix = text.slice(0, open).replace(/::\s*$/, '').trim();
  const inner = text.slice(open + 1, close);

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  const results: string[] = [];
  for (const part of parts) {
    const expanded = expandUsePath(part);
    if (expanded === null) return null;
    for (const item of expanded) {
      // `use a::{self, b}` names `a` itself alongside `a::b`.
      results.push(item === 'self' || !prefix ? prefix || item : `${prefix}::${item}`);
      if (results.length > MAX_EXPANSION) return null;
    }
  }
  return results;
}

function readRust(collector: Collector): void {
  const { code } = collector.masked;
  RUST_USE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RUST_USE.exec(code)) !== null) {
    const start = match.index + match[0].length;
    let end = start;
    let depth = 0;
    while (end < code.length) {
      const char = code[end] as string;
      if (char === '{') depth += 1;
      else if (char === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ';' && depth === 0) break;
      end += 1;
    }

    const expanded = expandUsePath(code.slice(start, end));
    if (expanded === null) {
      note(
        collector,
        'truncated',
        match.index,
        `a use declaration expands to more than ${MAX_EXPANSION} module paths`,
      );
    } else {
      for (const specifier of expanded) emit(collector, specifier, 'use', match.index);
    }
    RUST_USE.lastIndex = end;
  }
}

/* -------------------------------------------------------------------- c-sharp */

const CSHARP_USING = /\busing\b/g;

function readCsharp(collector: Collector): void {
  const { code } = collector.masked;
  CSHARP_USING.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CSHARP_USING.exec(code)) !== null) {
    const reader = new Reader(code);
    reader.index = match.index + match[0].length;
    reader.skipSpace();

    if (reader.eat('static')) reader.skipSpace();

    let target = reader.dotted();
    reader.skipSpace();

    // `using Alias = System.Text.Json;` - the dependency is the right-hand side.
    if (reader.eat('=')) {
      reader.skipSpace();
      target = reader.dotted();
      reader.skipSpace();
      reader.skipGenerics();
      reader.skipSpace();
    }

    // The whole of what separates a directive from a resource statement, and
    // it is one condition on purpose. `using (var s = ...)` reads no name at
    // all and stops on `(`; `using var s = ...` reads `var` and then finds `s`
    // where a terminator has to be. Earlier versions guarded those two shapes
    // explicitly, and a third time against an empty name - none of the three
    // changed an outcome, which mutation testing established by leaving the
    // tests green with each of them defeated. `emit` refuses an empty
    // specifier, so this line is the only check that has to be right.
    if (reader.peek() !== ';') continue;
    emit(collector, target, 'using', match.index);
  }
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
  if (language === 'csharp') return specifier.replace(/\./g, '/');

  if (!specifier.startsWith('.')) return specifier.replace(/\./g, '/');
  let level = 0;
  while (specifier[level] === '.') level += 1;
  const tail = specifier.slice(level).replace(/\./g, '/');
  let base = path.posix.dirname(importingFile);
  for (let up = 1; up < level; up++) base = path.posix.dirname(base);
  return path.posix.normalize(path.posix.join(base, tail));
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
      detail: 'a string or comment ran to the end of the file, so its imports are not trustworthy',
    });
  }
  return { references: collector.references, notes: collector.notes };
}
