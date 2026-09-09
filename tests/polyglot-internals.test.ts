/**
 * The edges of the polyglot readers.
 *
 * `polyglot.test.ts` asserts what the readers do with source somebody might
 * write. This file asserts what the machinery underneath does at its
 * boundaries: an empty file, a bracket that never closes, whitespace that is a
 * tab rather than a space, a literal whose closing delimiter is missing.
 *
 * Every case here comes from a mutant that the language-level tests left alive
 * on the first full run. That is the honest provenance: the readers scored
 * 77.45% and the gap was not in the languages, it was in the two hundred lines
 * of cursor and bracket arithmetic that every language shares.
 */

import { describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import {
  expandUsePath,
  literalValue,
  logicalLines,
  matchingClose,
  normalizeModule,
  Reader,
  MAX_EXPANSION,
} from '../src/polyglot.js';

const specifiers = (source: string, file: string): string[] =>
  analyzeSource(source, file).references.map((reference) => reference.specifier);

describe('Reader', () => {
  it('reports an empty string past the end rather than undefined', () => {
    const reader = new Reader('ab');
    reader.index = 5;
    expect(reader.peek()).toBe('');
  });

  it.each([
    ['space', ' '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['carriage return', '\r'],
  ])('skips a %s', (_name, whitespace) => {
    const reader = new Reader(`${whitespace}${whitespace}x`);
    reader.skipSpace();
    expect(reader.index).toBe(2);
  });

  it.each([
    ['form feed', '\f'],
    ['vertical tab', '\v'],
    ['non-breaking space', ' '],
  ])('does not skip a %s', (_name, character) => {
    const reader = new Reader(`${character}x`);
    reader.skipSpace();
    expect(reader.index).toBe(0);
  });

  it('stops skipping at the end of the text', () => {
    const reader = new Reader('   ');
    reader.skipSpace();
    expect(reader.index).toBe(3);
  });

  it('reads an identifier, or nothing where there is none', () => {
    const reader = new Reader('abc9_ .');
    expect(reader.identifier()).toBe('abc9_');
    expect(reader.identifier()).toBe('');
    expect(reader.index).toBe(5);
  });

  it('does not start an identifier with a digit', () => {
    expect(new Reader('9abc').identifier()).toBe('');
  });

  it('reads a dotted path and stops at the first non-separator', () => {
    const reader = new Reader('a.b.c;');
    expect(reader.dotted()).toBe('a.b.c');
    expect(reader.peek()).toBe(';');
  });

  it('treats :: as a separator too', () => {
    expect(new Reader('global::System.Text;').dotted()).toBe('global.System.Text');
  });

  it('stops a dotted path at a trailing separator', () => {
    expect(new Reader('a.b.').dotted()).toBe('a.b');
  });

  it('returns nothing for a dotted path that never starts', () => {
    expect(new Reader('(x)').dotted()).toBe('');
  });

  describe('eat and keyword', () => {
    it('eat matches a prefix; keyword does not', () => {
      expect(new Reader('staticfiles').eat('static')).toBe(true);
      expect(new Reader('staticfiles').keyword('static')).toBe(false);
    });

    it('keyword matches at the very end of the text', () => {
      expect(new Reader('static').keyword('static')).toBe(true);
    });

    it.each([' ', '.', ';', '\t'])('keyword matches before %j', (next) => {
      expect(new Reader(`static${next}x`).keyword('static')).toBe(true);
    });

    it.each(['s', '9', '_'])('keyword does not match before %j', (next) => {
      expect(new Reader(`static${next}`).keyword('static')).toBe(false);
    });

    it('neither advances on a miss', () => {
      const reader = new Reader('dynamic');
      expect(reader.eat('static')).toBe(false);
      expect(reader.keyword('static')).toBe(false);
      expect(reader.index).toBe(0);
    });
  });

  describe('skipGenerics', () => {
    it('does nothing when there is no generic', () => {
      const reader = new Reader('X;');
      reader.skipGenerics();
      expect(reader.index).toBe(0);
    });

    it('skips a balanced generic', () => {
      const reader = new Reader('<int>;');
      reader.skipGenerics();
      expect(reader.peek()).toBe(';');
    });

    it('skips a nested generic', () => {
      const reader = new Reader('<List<int>>;');
      reader.skipGenerics();
      expect(reader.peek()).toBe(';');
    });

    it('gives up at a terminator rather than swallowing the file', () => {
      const reader = new Reader('<int; more');
      reader.skipGenerics();
      expect(reader.peek()).toBe(';');
    });

    it('gives up at a newline', () => {
      const reader = new Reader('<int\nmore');
      reader.skipGenerics();
      expect(reader.peek()).toBe('\n');
    });

    it('stops at the end of an unclosed generic', () => {
      const reader = new Reader('<int');
      reader.skipGenerics();
      expect(reader.peek()).toBe('');
    });
  });
});

describe('matchingClose', () => {
  it('finds the close of a simple pair', () => {
    expect(matchingClose('a(b)c', 1, '(', ')')).toBe(3);
  });

  it('skips a nested pair', () => {
    expect(matchingClose('((x))y', 0, '(', ')')).toBe(4);
  });

  it('returns the end of the text when nothing closes it', () => {
    expect(matchingClose('a(bc', 1, '(', ')')).toBe(4);
  });

  it('works for braces as well as parentheses', () => {
    expect(matchingClose('{a{b}c}', 0, '{', '}')).toBe(6);
  });
});

describe('logicalLines', () => {
  it('returns nothing for an empty source', () => {
    expect(logicalLines('')).toEqual([]);
  });

  it('drops blank lines', () => {
    expect(logicalLines('a\n\n\nb').map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('records the offset of each line', () => {
    expect(logicalLines('ab\ncd')).toEqual([
      { text: 'ab', offset: 0 },
      { text: 'cd', offset: 3 },
    ]);
  });

  it.each([
    ['parentheses', '(', ')'],
    ['brackets', '[', ']'],
    ['braces', '{', '}'],
  ])('joins lines while %s are open', (_name, open, close) => {
    const joined = logicalLines(`x = ${open}\n  1,\n  2\n${close}\ny = 2`);
    expect(joined.map((line) => line.text)).toEqual([`x = ${open}   1,   2 ${close}`, 'y = 2']);
  });

  it('joins a backslash continuation', () => {
    expect(logicalLines('a = 1 + \\\n    2\nb = 3').map((line) => line.text)).toEqual([
      'a = 1 +       2',
      'b = 3',
    ]);
  });

  it('only treats a backslash at the very end of a line as a continuation', () => {
    expect(logicalLines('a = "x\\y"\nb = 2').map((line) => line.text)).toEqual(['a = "x\\y"', 'b = 2']);
  });

  it('does not go negative on an unmatched closer', () => {
    // A stray `)` must not push the depth below zero, or every later line joins
    // onto this one and the whole file becomes one statement.
    expect(logicalLines(')\na = 1\nb = 2').map((line) => line.text)).toEqual([')', 'a = 1', 'b = 2']);
  });

  it('runs an unclosed bracket to the end of the file', () => {
    expect(logicalLines('x = (\n1\n2').map((line) => line.text)).toEqual(['x = ( 1 2']);
  });

  it('keeps the last line when the file does not end in a newline', () => {
    expect(logicalLines('a\nb').map((line) => line.text)).toEqual(['a', 'b']);
  });
});

describe('literalValue', () => {
  it('falls back to the single-quote rule when a triple quote does not close', () => {
    // An unterminated docstring: starts with `"""` but does not end with one.
    // startsWith and endsWith agree on every well-formed literal, which is why
    // this needs a malformed one to pin down.
    expect(literalValue('"""doc"')).toBe('d');
    expect(literalValue("'''doc'")).toBe('d');
  });

  it('strips a verbatim prefix before looking at the quotes', () => {
    expect(literalValue('@"a"')).toBe('a');
  });

  it('returns text it does not recognise unchanged', () => {
    expect(literalValue('bare')).toBe('bare');
  });

  it('handles the shortest possible literal', () => {
    expect(literalValue('""')).toBe('');
  });
});

describe('expandUsePath boundaries', () => {
  it('allows exactly the maximum expansion', () => {
    const items = Array.from({ length: MAX_EXPANSION }, (_, index) => `m${index}`);
    expect(expandUsePath(`a::{${items.join(', ')}}`)).toHaveLength(MAX_EXPANSION);
  });

  it('refuses one more than the maximum', () => {
    const items = Array.from({ length: MAX_EXPANSION + 1 }, (_, index) => `m${index}`);
    expect(expandUsePath(`a::{${items.join(', ')}}`)).toBeNull();
  });

  it('strips a trailing semicolon and any spaces around it', () => {
    expect(expandUsePath('a::b ;  ')).toEqual(['a::b']);
    expect(expandUsePath('a::b;')).toEqual(['a::b']);
  });

  it('keeps a group that never closes', () => {
    expect(expandUsePath('a::{b, c')).toEqual(['a::b', 'a::c']);
  });
});

describe('reading at the edges of a file', () => {
  it('reads a c# using that runs to the end without a terminator', () => {
    expect(specifiers('using System.Text', 'a.cs')).toEqual([]);
  });

  it('reads a c# using static at the very end of the file', () => {
    expect(specifiers('using static', 'a.cs')).toEqual([]);
  });

  it('reads a rust use that runs to the end without a semicolon', () => {
    expect(specifiers('use crate::db', 'a.rs')).toEqual(['crate::db']);
  });

  it('stops a rust use at a closing brace', () => {
    expect(specifiers('fn f() { use crate::db }\n', 'a.rs')).toEqual(['crate::db']);
  });

  it('reads a go import with no literal after it', () => {
    expect(specifiers('import\n', 'a.go')).toEqual([]);
  });

  it('reads a go group that never closes', () => {
    expect(specifiers('import (\n\t"fmt"\n', 'a.go')).toEqual(['fmt']);
  });

  it('reads a single dot-aliased go import', () => {
    expect(specifiers('import . "strings"\n', 'a.go')).toEqual(['strings']);
  });

  it('ignores a literal before a go import group', () => {
    // literalsBetween has to start at the group, not at the first string in
    // the file, and stop at the close rather than running to the end.
    const source = 'var banner = "hello"\nimport (\n\t"fmt"\n)\nvar tail = "goodbye"\n';
    expect(specifiers(source, 'a.go')).toEqual(['fmt']);
  });

  it('separates several go imports so the literal lookup has to search', () => {
    const source = ['import "a"', 'import "b"', 'import "c"', 'import "d"', 'import "e"'].join('\n');
    expect(specifiers(source, 'a.go')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('python statement shapes', () => {
  it('reads a relative import with a module name', () => {
    expect(specifiers('from .core import Thing\n', 'app/a.py')).toEqual(['.core']);
  });

  it('ignores a star in a bare relative import', () => {
    expect(specifiers('from . import *\n', 'app/a.py')).toEqual([]);
  });

  it('ignores an empty clause in a comma list', () => {
    expect(specifiers('import os, , sys\n', 'a.py')).toEqual(['os', 'sys']);
  });

  it('needs whitespace after the keyword', () => {
    expect(specifiers('importos\nfromos import x\n', 'a.py')).toEqual([]);
  });

  it('reads an import from the first line only when it starts one', () => {
    expect(specifiers('x = 1; import os\n', 'a.py')).toEqual(['os']);
    expect(specifiers('x = notimport os\n', 'a.py')).toEqual([]);
  });

  it('reads a dynamic import with space before the parenthesis', () => {
    expect(specifiers('m = import_module ("app.db")\n', 'a.py')).toEqual(['app.db']);
  });

  it('resolves a bare relative import at the repository root', () => {
    expect(normalizeModule('.db', 'handler.py', 'python')).toBe('db');
  });
});

describe('rust statement shapes', () => {
  it('reads extern crate with several spaces or a newline between the words', () => {
    expect(specifiers('extern   crate serde;\n', 'a.rs')).toEqual(['serde']);
    expect(specifiers('extern\ncrate serde;\n', 'a.rs')).toEqual(['serde']);
  });

  it('does not read externcrate as one word', () => {
    expect(specifiers('let externcrate = 1;\n', 'a.rs')).toEqual([]);
  });

  it('reports the truncation with the cap in the message', () => {
    const wide = `use a::{${Array.from({ length: MAX_EXPANSION + 1 }, (_, i) => `m${i}`).join(', ')}};\n`;
    expect(analyzeSource(wide, 'a.rs').notes[0]?.detail).toBe(
      `a use declaration expands to more than ${MAX_EXPANSION} module paths`,
    );
  });
});

describe('the note for a lost scan', () => {
  it('says why the imports are not trustworthy', () => {
    expect(analyzeSource('x = "open\n', 'a.py').notes[0]).toMatchObject({
      kind: 'unreadable',
      line: 1,
      column: 1,
      detail: 'a string or comment ran to the end of the file, so its imports are not trustworthy',
    });
  });
});
