/**
 * The JavaScript extractor where the file runs out, and where it nearly
 * mistakes one construct for another.
 *
 * Two shapes of gap. The first is the end of the file: almost every lookahead
 * in the extractor is optional-chained, and the chain only earns its keep when
 * the token it reaches for is not there - which means a file that stops in the
 * middle of an import. Truncated files are what a partial write, a merge
 * conflict marker or a generator crash leave behind, and the extractor reading
 * one has to produce a note rather than a stack trace.
 *
 * The second is the near-miss: `import.meta` is not an import, `import type` is
 * usually one but not always, `/*​/` does not close the comment it opens, and a
 * `{` in a template is only a substitution when a `$` precedes it. Each of
 * those is one character away from something the extractor does read.
 */

import { describe, expect, it } from 'vitest';

import { analyzeJavaScript } from '../src/imports.js';

function specifiers(source: string): string[] {
  return analyzeJavaScript(source, 'a.ts').references.map((reference) => reference.specifier);
}

function typeOnly(source: string): boolean | undefined {
  return analyzeJavaScript(source, 'a.ts').references[0]?.typeOnly;
}

function notes(source: string): string[] {
  return analyzeJavaScript(source, 'a.ts').notes.map((note) => `${note.kind}: ${note.detail}`);
}

/* -------------------------------------------------------- the end of a file */

describe('a file that stops mid-statement', () => {
  it.each([
    ['import', 'import'],
    ['an import call with nothing in it', 'const a = await import('],
    ['an import call with an unfinished argument', "const a = await import('x'"],
    ['a require call with nothing in it', 'const a = require('],
    ['a require call with an unfinished argument', "const a = require('x'"],
    ['an import clause', 'import {'],
    ['an import clause with a name', 'import { A'],
    ['a from with nothing after it', "import { A } from"],
    ['a type import', 'import type'],
    ['a type import with a brace', 'import type {'],
    ['an export', 'export'],
    ['an export clause', 'export {'],
    ['an export from', 'export { A } from'],
    ['a bare dot after import', 'import.'],
  ])('reads %s without reaching for a token that is not there', (_name, source) => {
    expect(() => analyzeJavaScript(source, 'a.ts')).not.toThrow();
    expect(specifiers(source)).toEqual([]);
  });

  it('still reads the imports that came before the truncation', () => {
    expect(specifiers("import { A } from './a.js';\nimport { B } from")).toEqual(['./a.js']);
  });

  it('reports a scan that ended inside a construct, in so many words', () => {
    // The note is the whole point of the flag: a file whose scan lost its place
    // has imports nobody should trust, and saying nothing is the failure this
    // project exists to prevent.
    expect(notes('const a = `never closed')).toEqual([
      'unreadable: the scan ended inside a string, template or comment, so its imports are not trustworthy',
    ]);
  });

  it('says nothing of the sort about a file that ended cleanly', () => {
    expect(notes("import { A } from './a.js';\n")).toEqual([]);
  });

  it('keeps a trailing backslash at the very end of a string', () => {
    // `source[index + 1] ?? ''` - the escape has nothing after it, and the
    // fallback is what stops `undefined` being appended to the token value.
    const source = "const a = 'x\\";
    expect(() => analyzeJavaScript(source, 'a.ts')).not.toThrow();
    expect(notes(source)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- near misses */

describe('constructs one character away from an import', () => {
  it('does not read import.meta as an import', () => {
    expect(specifiers("const url = import.meta.url;\nimport './a.js';")).toEqual(['./a.js']);
  });

  it('does read an import call', () => {
    expect(specifiers("const a = await import('./a.js');")).toEqual(['./a.js']);
  });

  it('notes a dynamic import whose argument is not a literal', () => {
    expect(notes('const a = await import(name);')).toEqual(['dynamic: import(name)']);
  });

  it('describes a computed argument that is not even a name', () => {
    expect(notes('const a = await import(`${x}`);')).toEqual(['dynamic: import(expression)']);
  });

  it('does not close a block comment on the slash that opened it', () => {
    // `/*​/` is an open comment, not an empty one: the search for `*​/` starts
    // past the opener, and starting before it finds the opener's own slash.
    expect(specifiers("/*/\nimport './hidden.js';\n*/\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('closes an empty block comment', () => {
    expect(specifiers("/**/\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('does not open a block comment on a multiplication', () => {
    // Both characters have to be right. Checking only the `*` makes `2*3` the
    // start of a comment that runs to the end of the file, taking every import
    // below it with it - and a corpus of real code is full of `2*3`.
    expect(specifiers("const a = 2*3;\nimport './real.js';")).toEqual(['./real.js']);
    expect(specifiers("const a = b *c;\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('does not open a line comment on a lone slash', () => {
    expect(specifiers("const a = 6 / 2;\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('does not read a brace in a template as a substitution', () => {
    // Only `${` opens one. Treating a bare `{` as a substitution ends the
    // template early and everything after it is read as code.
    expect(specifiers("const a = `a{b}c`;\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('does read a substitution, and comes back out of it', () => {
    expect(specifiers("const a = `x${ y }z`;\nimport './real.js';")).toEqual(['./real.js']);
  });

  it.each([
    ['an unmatched opening brace', 'const a = `a{b`;'],
    ['an unmatched closing brace', 'const a = `a}b`;'],
    ['a brace-heavy template', 'const a = `{{{`;'],
    ['a brace inside a substitution', 'const a = `x${ {y: 1} }z`;'],
    ['a template inside a substitution', 'const a = `x${ `y{z` }w`;'],
  ])('reads %s as ordinary template text', (_name, prelude) => {
    // Only `${` opens a substitution. Accepting a bare `{` sends the scanner
    // looking for a closing brace that a template need not contain, and it
    // runs off the end of the file taking every import with it.
    const source = `${prelude}\nimport './real.js';`;

    expect(specifiers(source)).toEqual(['./real.js']);
    expect(notes(source)).toEqual([]);
  });

  it('does not read a string whose contents are the word import', () => {
    // The extractor only considers *word* tokens. Dropping that filter makes
    // the contents of a string literal into a keyword, and two adjacent
    // strings into an import of the second.
    expect(specifiers("const a = 'import'\n'./evil.js'\n")).toEqual([]);
  });

  it('imports the module named "." rather than mistaking it for a member access', () => {
    // `import.meta` is recognised by the punctuation after `import`. A string
    // whose contents happen to be a dot is not punctuation.
    expect(specifiers("import '.';")).toEqual(['.']);
  });

  it('imports the module named "(" rather than mistaking it for a call', () => {
    expect(specifiers("import '(';")).toEqual(['(']);
  });

  it('does not mark an import of a module named "type" as type-only', () => {
    // The word after `import` decides. A string is not that word.
    expect(specifiers("import 'type';")).toEqual(['type']);
    expect(typeOnly("import 'type';")).toBe(false);
  });

  it('ends a line comment at the newline', () => {
    expect(specifiers("// import './hidden.js';\nimport './real.js';")).toEqual(['./real.js']);
  });

  it('does not let a string run over a newline', () => {
    expect(specifiers("const a = 'unclosed\nimport './real.js';")).not.toContain('./hidden.js');
  });

  it('gives up rather than reading past an unclosed regular expression', () => {
    // A regex cannot span a line, so at the newline the scan has lost its
    // place. It stops and says so: whether the imports below are inside the
    // literal is exactly what it no longer knows.
    const source = "const a = /unclosed\nimport './real.js';";

    expect(specifiers(source)).toEqual([]);
    expect(notes(source)).toEqual([
      'unreadable: the scan ended inside a string, template or comment, so its imports are not trustworthy',
    ]);
  });
});

/* ---------------------------------------------------------------- type-only */

describe('import type', () => {
  it('marks a braced type import as type-only', () => {
    expect(specifiers("import type { A } from './a.js';")).toEqual(['./a.js']);
    expect(typeOnly("import type { A } from './a.js';")).toBe(true);
  });

  it('marks a default type import as type-only', () => {
    expect(typeOnly("import type A from './a.js';")).toBe(true);
  });

  it('does not mark a default import that happens to be named type', () => {
    // `import type from 'x'` imports a binding called `type`. The word after
    // `type` decides which of the two this is.
    expect(typeOnly("import type from './a.js';")).toBe(false);
  });

  it('reads nothing from `import type "x"`, which is not a statement', () => {
    // `type` is a word, so this is neither a side-effect import nor a clause
    // with a `from`. Guessing at one would invent a dependency.
    expect(specifiers("import type './a.js';")).toEqual([]);
  });

  it.each([
    ['a named import', "import { A } from './a.js';"],
    ['a default import', "import A from './a.js';"],
    ['a default and a named import together', "import A, { B } from './a.js';"],
    ['a namespace import', "import * as ns from './a.js';"],
    ['a default and a namespace import', "import A, * as ns from './a.js';"],
    ['a side-effect import', "import './a.js';"],
    ['a re-export', "export { A } from './a.js';"],
    ['a star re-export', "export * from './a.js';"],
    ['a renamed re-export', "export { A as B } from './a.js';"],
    ['a require', "const a = require('./a.js');"],
    ['a dynamic import', "const a = await import('./a.js');"],
  ])('leaves %s alone', (_name, source) => {
    // Every shape, because the type-only test is three conditions joined by
    // `&&` and loosening any one of them marks a whole class of ordinary
    // import as type-only - which `types="ignore"` then drops silently.
    expect(specifiers(source)).toEqual(['./a.js']);
    expect(typeOnly(source)).toBe(false);
  });

  it('marks a type-only export as type-only', () => {
    expect(typeOnly("export type { A } from './a.js';")).toBe(true);
  });
});

/* ------------------------------------------------------------ the from scan */

describe('finding the specifier', () => {
  it('stops at the semicolon rather than borrowing the next statement', () => {
    // Without the terminator the scan runs on and attaches the next
    // statement's module to this import.
    expect(specifiers("import { A };\nconst from = 1;\nimport './b.js';")).toEqual(['./b.js']);
  });

  it('reads a clause that spans several lines', () => {
    expect(specifiers("import {\n  A,\n  B,\n} from './a.js';")).toEqual(['./a.js']);
  });

  it('carries on after the statement it just read, not before it', () => {
    // The cursor moves past the specifier. Moving it back re-reads the same
    // statement and reports the dependency twice.
    expect(specifiers("import { A } from './a.js';\nimport { B } from './b.js';")).toEqual(['./a.js', './b.js']);
  });

  it('ignores a from that is not followed by a string', () => {
    expect(specifiers('import { A } from B;')).toEqual([]);
  });
});

/* ------------------------------------------------------------------- notes */

describe('a file that cannot be read at all', () => {
  it('says why, rather than reporting no imports', async () => {
    const { createImportIndex } = await import('../src/imports.js');
    const index = createImportIndex();

    const analysis = await index.analyze('C:/definitely/not/here.ts', 'not/here.ts');

    expect(analysis.references).toEqual([]);
    expect(analysis.notes).toHaveLength(1);
    expect(analysis.notes[0]?.kind).toBe('unreadable');
    expect(analysis.notes[0]?.detail).toMatch(/^could not be read: .+/);
  });
});
