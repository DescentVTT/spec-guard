/**
 * Module-reference extraction for JavaScript and TypeScript.
 *
 * This is deliberately a tokenizer and not a parser. It walks the source
 * tracking whether it is in code, a comment, a string, a template literal or a
 * regular expression, emits a flat token stream, and reads module references
 * off that stream. It knows nothing about scopes, types or semantics.
 *
 * The reason it is a tokenizer rather than a regular expression is that a
 * regular expression cannot tell these apart:
 *
 *   // import { Client } from '../db';        a comment
 *   const doc = "import { Client } from '..'"; a string
 *
 * and the reason it is not a parser is that a parser for two languages is
 * larger than this whole tool. See ADR-0005.
 *
 * The critical property is that it knows when it has failed. If the scan ends
 * inside a string, template or comment, the token stream is not trustworthy and
 * the file is reported as unanalysable rather than as having no imports.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { toPosix } from './glob.js';

/** Extensions this analyser understands. Anything else is reported as skipped. */
export const ANALYSABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);

export type ReferenceKind = 'import' | 'export' | 'require' | 'dynamic-import';

export interface ModuleReference {
  /** The specifier exactly as written, e.g. `../db/client.js`. */
  specifier: string;
  kind: ReferenceKind;
  /** True for `import type ...` and `export type ... from`. */
  typeOnly: boolean;
  line: number;
  column: number;
}

export type NoteKind = 'dynamic' | 'unreadable';

export interface AnalysisNote {
  kind: NoteKind;
  /** Path relative to the root, for display. */
  file: string;
  line: number;
  column: number;
  /** What could not be resolved, e.g. `import(componentPath)`. */
  detail: string;
}

export interface FileImports {
  references: ModuleReference[];
  notes: AnalysisNote[];
}

/* ---------------------------------------------------------------- tokenizer */

type TokenType = 'word' | 'string' | 'punct' | 'template';

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

/**
 * Words after which a `/` begins a regular expression rather than a division.
 * The remaining ambiguity is `)` and `}`, where this follows the usual
 * heuristic; a wrong guess is caught by the end-state check rather than
 * silently mis-scanning the rest of the file.
 */
const REGEX_AFTER_WORD = new Set([
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
 * as the start of a regular expression loses the scan for the rest of the file.
 * The cost is that `a < /re/.test(b)` is misread instead, which is a shape that
 * does not occur in practice.
 */
const REGEX_AFTER_PUNCT = new Set([
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

function isIdentifierStart(char: string): boolean {
  // Deliberately not @ or #: they can start a decorator or a private field but
  // cannot continue an identifier, so accepting them here would read a
  // zero-length word and never advance. They are emitted as punctuation.
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

export interface TokenizeResult {
  tokens: Token[];
  /** True when the scan ended inside a string, template or block comment. */
  desynced: boolean;
}

/** Splits source into the flat token stream the extractor reads. */
export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  // Brace depth at each open `${`, so the matching `}` returns to the template.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let desynced = false;

  const column = (at: number): number => at - lineStart + 1;
  const advanceLine = (at: number): void => {
    line += 1;
    lineStart = at + 1;
  };
  const previous = (): Token | undefined => tokens[tokens.length - 1];

  const regexAllowed = (): boolean => {
    const token = previous();
    if (!token) return true;
    if (token.type === 'word') return REGEX_AFTER_WORD.has(token.value);
    if (token.type === 'punct') return REGEX_AFTER_PUNCT.has(token.value);
    return false;
  };

  /** Reads a quoted string. Returns null when it does not terminate. */
  const readQuoted = (quote: string): string | null => {
    let value = '';
    index += 1;
    while (index < source.length) {
      const char = source[index] as string;
      if (char === '\\') {
        value += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) {
        index += 1;
        return value;
      }
      if (char === '\n') return null;
      value += char;
      index += 1;
    }
    return null;
  };

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === '\n') {
      advanceLine(index);
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        desynced = true;
        break;
      }
      for (let scan = index; scan < end; scan++) {
        if (source[scan] === '\n') advanceLine(scan);
      }
      index = end + 2;
      continue;
    }

    if (char === '/' && regexAllowed()) {
      const startLine = line;
      const startColumn = column(index);
      let scan = index + 1;
      let inClass = false;
      let closed = false;
      while (scan < source.length) {
        const inner = source[scan] as string;
        if (inner === '\\') {
          scan += 2;
          continue;
        }
        if (inner === '\n') break;
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) {
          closed = true;
          scan += 1;
          break;
        }
        scan += 1;
      }
      if (!closed) {
        desynced = true;
        break;
      }
      while (scan < source.length && isIdentifierPart(source[scan] as string)) scan += 1;
      tokens.push({ type: 'punct', value: 'regex', line: startLine, column: startColumn });
      index = scan;
      continue;
    }

    if (char === "'" || char === '"') {
      const startLine = line;
      const startColumn = column(index);
      const value = readQuoted(char);
      if (value === null) {
        desynced = true;
        break;
      }
      tokens.push({ type: 'string', value, line: startLine, column: startColumn });
      continue;
    }

    if (char === '`') {
      const startLine = line;
      const startColumn = column(index);
      let value = '';
      let substituted = false;
      let scan = index + 1;
      let closed = false;
      while (scan < source.length) {
        const inner = source[scan] as string;
        if (inner === '\\') {
          value += source[scan + 1] ?? '';
          scan += 2;
          continue;
        }
        if (inner === '`') {
          closed = true;
          scan += 1;
          break;
        }
        if (inner === '$' && source[scan + 1] === '{') {
          // Hand the substitution back to the main loop so its contents are
          // tokenized as code; the matching brace returns here.
          substituted = true;
          break;
        }
        if (inner === '\n') advanceLine(scan);
        value += inner;
        scan += 1;
      }

      if (substituted) {
        templateStack.push(braceDepth);
        braceDepth += 1;
        tokens.push({ type: 'template', value: '', line: startLine, column: startColumn });
        index = scan + 2;
        continue;
      }
      if (!closed) {
        desynced = true;
        break;
      }
      // A template with no substitutions is usable as a specifier.
      tokens.push({ type: 'string', value, line: startLine, column: startColumn });
      index = scan;
      continue;
    }

    if (char === '}' && templateStack.length > 0 && braceDepth === (templateStack.at(-1) as number) + 1) {
      // Closing a `${`: resume scanning the template that opened it.
      templateStack.pop();
      braceDepth -= 1;
      let scan = index + 1;
      let closed = false;
      while (scan < source.length) {
        const inner = source[scan] as string;
        if (inner === '\\') {
          scan += 2;
          continue;
        }
        if (inner === '`') {
          closed = true;
          scan += 1;
          break;
        }
        if (inner === '$' && source[scan + 1] === '{') {
          templateStack.push(braceDepth);
          braceDepth += 1;
          scan += 2;
          closed = true;
          break;
        }
        if (inner === '\n') advanceLine(scan);
        scan += 1;
      }
      if (!closed) {
        desynced = true;
        break;
      }
      index = scan;
      continue;
    }

    if (isIdentifierStart(char)) {
      const startColumn = column(index);
      let scan = index;
      while (scan < source.length && isIdentifierPart(source[scan] as string)) scan += 1;
      /* c8 ignore next -- belt and braces: a word must consume at least one character */
      if (scan === index) scan += 1;
      tokens.push({ type: 'word', value: source.slice(index, scan), line, column: startColumn });
      index = scan;
      continue;
    }

    if (char === '{') braceDepth += 1;
    if (char === '}') braceDepth -= 1;
    tokens.push({ type: 'punct', value: char, line, column: column(index) });
    index += 1;
  }

  if (templateStack.length > 0) desynced = true;
  return { tokens, desynced };
}

/* ---------------------------------------------------------------- extractor */

/** How far past `import`/`export` to look for `from`, before giving up. */
const CLAUSE_LOOKAHEAD = 200;

/**
 * Reads module references off a token stream.
 *
 * Recognised: `import ... from 'x'`, `import 'x'`, `import('x')`,
 * `export ... from 'x'`, `export * from 'x'`, `require('x')`. Anything whose
 * specifier is not a literal becomes a note instead of a reference.
 */
export function extractReferences(tokens: readonly Token[], file: string): FileImports {
  const references: ModuleReference[] = [];
  const notes: AnalysisNote[] = [];

  const note = (kind: NoteKind, token: Token, detail: string): void => {
    notes.push({ kind, file, line: token.line, column: token.column, detail });
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.type !== 'word') continue;

    const isImport = token.value === 'import';
    const isExport = token.value === 'export';
    const isRequire = token.value === 'require';
    if (!isImport && !isExport && !isRequire) continue;

    // ADR-0005 Q3: a property access is not a module reference. `loader.require`
    // and `obj.import` are ordinary method calls.
    const preceding = tokens[index - 1];
    if (preceding?.type === 'punct' && preceding.value === '.') continue;

    const after = tokens[index + 1];
    if (!after) continue;

    // import.meta / import.something - not a module reference.
    if (isImport && after.type === 'punct' && after.value === '.') continue;

    // Call form: import('x') and require('x').
    if ((isImport || isRequire) && after.type === 'punct' && after.value === '(') {
      const argument = tokens[index + 2];
      const closing = tokens[index + 3];
      if (
        argument?.type === 'string' &&
        closing?.type === 'punct' &&
        (closing.value === ')' || closing.value === ',')
      ) {
        references.push({
          specifier: argument.value,
          kind: isImport ? 'dynamic-import' : 'require',
          typeOnly: false,
          line: token.line,
          column: token.column,
        });
      } else {
        const shape = argument?.type === 'word' ? argument.value : 'expression';
        note('dynamic', token, `${token.value}(${shape})`);
      }
      index += 1;
      continue;
    }

    // Bare side-effect import: import 'x'.
    if (isImport && after.type === 'string') {
      references.push({
        specifier: after.value,
        kind: 'import',
        typeOnly: false,
        line: token.line,
        column: token.column,
      });
      index += 1;
      continue;
    }

    if (isRequire) continue;

    // Statement form: scan the clause for `from` followed by a literal.
    // `import type { A } from 'x'` is type-only. `import type from 'x'` imports a
    // default binding that happens to be called type, and is a value import.
    const following = tokens[index + 2];
    const typeOnly =
      after.type === 'word' &&
      after.value === 'type' &&
      following?.type !== 'string' &&
      !(following?.type === 'word' && following.value === 'from');
    const limit = Math.min(tokens.length, index + CLAUSE_LOOKAHEAD);
    for (let scan = index + 1; scan < limit; scan++) {
      const current = tokens[scan] as Token;
      if (current.type === 'punct' && current.value === ';') break;
      if (current.type !== 'word' || current.value !== 'from') continue;

      const specifier = tokens[scan + 1];
      if (specifier?.type === 'string') {
        references.push({
          specifier: specifier.value,
          kind: isImport ? 'import' : 'export',
          typeOnly,
          line: token.line,
          column: token.column,
        });
        index = scan + 1;
      }
      break;
    }
  }

  return { references, notes };
}

/** Tokenizes and extracts, reporting a lost scan as an unreadable note. */
export function analyzeSource(source: string, file: string): FileImports {
  const { tokens, desynced } = tokenize(source);
  const result = extractReferences(tokens, file);
  if (desynced) {
    result.notes.push({
      kind: 'unreadable',
      file,
      line: 1,
      column: 1,
      detail: 'the scan ended inside a string, template or comment, so its imports are not trustworthy',
    });
  }
  return result;
}

/* ------------------------------------------------------------- normalisation */

/**
 * Resolves a specifier to something matchable, using path arithmetic only.
 *
 * Relative specifiers become root-relative paths; everything else is left
 * exactly as written. There is deliberately no filesystem access, no extension
 * guessing and no tsconfig path mapping - see ADR-0005.
 */
export function resolveSpecifier(specifier: string, importingFile: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;
  const directory = path.posix.dirname(toPosix(importingFile));
  return path.posix.normalize(path.posix.join(directory, specifier));
}

/* -------------------------------------------------------------------- index */

export interface ImportIndex {
  analyze(absolutePath: string, relativePath: string): Promise<FileImports>;
  /** Files analysed so far, for reporting. */
  readonly size: number;
}

/**
 * Per-run cache: parse once, query many.
 *
 * Several assertions in one document routinely point at the same directory, and
 * tokenizing is the most expensive thing spec-guard does. Without this the cost
 * would be the tree multiplied by the number of import assertions.
 */
export function createImportIndex(): ImportIndex {
  const cache = new Map<string, Promise<FileImports>>();

  return {
    get size(): number {
      return cache.size;
    },
    analyze(absolutePath: string, relativePath: string): Promise<FileImports> {
      let pending = cache.get(absolutePath);
      if (!pending) {
        pending = fs
          .readFile(absolutePath, 'utf8')
          .then((source) => analyzeSource(source, relativePath))
          .catch(
            (error: unknown): FileImports => ({
              references: [],
              notes: [
                {
                  kind: 'unreadable',
                  file: relativePath,
                  line: 1,
                  column: 1,
                  detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }),
          );
        cache.set(absolutePath, pending);
      }
      return pending;
    },
  };
}
