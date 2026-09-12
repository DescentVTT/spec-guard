/**
 * The polyglot readers, at the places the existing tests reach past.
 *
 * Every test of this module asserts the list of module paths it produced, and
 * that list is blind to a good deal of what the readers do: which verb a
 * reference was written with, whether a reference is type-only, where a
 * multi-line statement is reported to start, and every depth counter that keeps
 * a reader from ending a statement in the middle of a bracket. A reader that
 * lost its place inside `List<Dictionary<int, string>>` produced the same
 * answer as one that did not, for every file anybody had written a test for.
 */

import { describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import type { ModuleReference } from '../src/imports.js';
import { expandUsePath, logicalLines, matchingClose, normalizeModule, MAX_EXPANSION } from '../src/polyglot.js';

function references(source: string, file: string): ModuleReference[] {
  return analyzeSource(source, file).references;
}

function specifiers(source: string, file: string): string[] {
  return references(source, file).map((reference) => reference.specifier);
}

/* ------------------------------------------------------- what a reference is */

describe('every polyglot reference', () => {
  it.each([
    ['a.py', 'import os\n', 'import'],
    ['a.py', 'from os import path\n', 'import'],
    // The bare relative form emits from a different place in the reader, and
    // so does a grouped Go import - each with its own copy of the verb.
    ['pkg/a.py', 'from . import sibling\n', 'import'],
    ['a.py', "__import__('os')\n", 'dynamic-import'],
    ['a.py', "importlib.import_module('os')\n", 'dynamic-import'],
    ['a.go', 'import "fmt"\n', 'import'],
    ['a.go', 'import (\n\t"fmt"\n)\n', 'import'],
    ['a.go', 'import f "fmt"\n', 'import'],
    ['a.rs', 'use std::fmt;\n', 'use'],
    ['a.rs', 'use std::{fmt, io};\n', 'use'],
    ['a.cs', 'using System.Text;\n', 'using'],
    ['a.cs', 'using J = System.Text.Json;\n', 'using'],
  ])('%s writes %s with the verb %s', (file, source, kind) => {
    // The verb reaches the report as the first word of every snippet, and the
    // list of specifiers every other test reads is blind to it.
    expect(references(source, file)[0]?.kind).toBe(kind);
  });

  it.each(['a.py', 'a.go', 'a.rs', 'a.cs'])('is never type-only, in %s', (file) => {
    // None of these four languages has a type-only import. Marking one would
    // make `types="ignore"` silently drop every dependency in the file.
    const sources: Record<string, string> = {
      'a.py': 'import os\n',
      'a.go': 'import "fmt"\n',
      'a.rs': 'use std::fmt;\n',
      'a.cs': 'using System.Text;\n',
    };
    expect(references(sources[file] as string, file)[0]?.typeOnly).toBe(false);
  });

  it('refuses a specifier that came out empty', () => {
    // `using ;` reads no name at all. Emitting it puts an empty dependency in
    // the report, and an empty pattern matches things a reader did not intend.
    expect(specifiers('using ;\n', 'a.cs')).toEqual([]);
  });
});

/* ------------------------------------------------------------ logical lines */

describe('logicalLines', () => {
  it('drops a line with nothing on it', () => {
    expect(logicalLines('a\n\n   \nb').map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('joins a statement held open by a bracket', () => {
    // The depth counter. Counting an opening bracket the wrong way makes every
    // parenthesised import a separate, unparseable line.
    const lines = logicalLines('from a import (\n  b,\n  c,\n)\nnext\n');

    expect(lines.map((line) => line.text)).toEqual(['from a import (   b,   c, )', 'next']);
  });

  it('joins a statement held open by a backslash', () => {
    // The backslash becomes a space, so the join keeps every offset after it
    // where it was in the file.
    const [line] = logicalLines('import a, \\\n  b\n');
    expect(line?.text.replace(/ +/g, ' ')).toBe('import a, b');
    expect(logicalLines('import a, \\\n  b\n')).toHaveLength(1);
  });

  it('reports a joined statement at the line it started on, not the line it ended on', () => {
    // The offset is only set for the first physical line of a statement.
    // Updating it every time reports a multi-line import at its closing
    // bracket, which is not where the reader will look for it.
    const source = 'x = 1\nfrom a import (\n  b,\n)\n';
    const [, joined] = logicalLines(source);

    expect(source.slice(joined?.offset ?? 0).startsWith('from a import')).toBe(true);
  });

  it('does not go negative on a closing bracket that never opened', () => {
    expect(logicalLines(')\nimport a\n').map((line) => line.text)).toEqual([')', 'import a']);
  });
});

describe('matchingClose', () => {
  it('finds the close that balances the open', () => {
    expect(matchingClose('f(a(b), c)', 1, '(', ')')).toBe(9);
  });

  it('returns the length when nothing balances it', () => {
    const text = 'f(a';
    expect(matchingClose(text, 1, '(', ')')).toBe(text.length);
  });
});

/* ---------------------------------------------------------------- python */

describe('python', () => {
  it('reads a from-import written with more than one space', () => {
    // `[ \t]+` after the keyword. With a single space the rest of the line
    // starts with whitespace, `from` no longer matches, and the dependency
    // disappears without a note.
    expect(specifiers('from  a.b import c\n', 'a.py')).toEqual(['a.b']);
    expect(specifiers('import   a.b\n', 'a.py')).toEqual(['a.b']);
  });

  it.each([
    ['from import x\n'],
    // The ones that really defeat the pattern. `from import x` looks broken but
    // still matches, with an empty module name; these do not match at all, and
    // reading group 1 off a null match is a crash rather than a bad answer.
    ['from .\n'],
    ['from ..\n'],
    ['from 1 import x\n'],
    ['from -\n'],
  ])('says nothing about %j, which it cannot parse', (source) => {
    expect(() => specifiers(source, 'pkg/m.py')).not.toThrow();
    expect(specifiers(source, 'pkg/m.py')).toEqual([]);
  });

  it('strips the parentheses off a bare relative import list', () => {
    expect(specifiers('from . import (a, b)\n', 'pkg/m.py')).toEqual(['.a', '.b']);
  });

  it('ignores a star in a bare relative import', () => {
    expect(specifiers('from . import *\n', 'pkg/m.py')).toEqual([]);
  });

  it('stops expanding a bare relative import at the cap', () => {
    const names = Array.from({ length: MAX_EXPANSION + 10 }, (_, index) => `n${index}`).join(', ');
    expect(specifiers(`from . import ${names}\n`, 'pkg/m.py')).toHaveLength(MAX_EXPANSION);
  });

  it('reads a dynamic import with spaces around its argument', () => {
    expect(specifiers("__import__ ( 'os' )\n", 'a.py')).toEqual(['os']);
  });

  it('reads a multi-line parenthesised import as one statement', () => {
    expect(specifiers('from a.b import (\n  c,\n  d,\n)\n', 'a.py')).toEqual(['a.b']);
  });
});

/* -------------------------------------------------------------------- go */

describe('go', () => {
  it('reads a single import without treating the rest of the file as a group', () => {
    // The `(` test decides between a group and a single import. Taking the
    // group path for a single one scans to the end of the file and collects
    // every string literal in it.
    const source = 'package main\n\nimport "fmt"\n\nfunc main() { println("not an import") }\n';
    expect(specifiers(source, 'a.go')).toEqual(['fmt']);
  });

  it('reads a grouped import', () => {
    expect(specifiers('import (\n\t"fmt"\n\t"os"\n)\n', 'a.go')).toEqual(['fmt', 'os']);
  });

  it('reads an aliased import', () => {
    expect(specifiers('import fmt2 "fmt"\n', 'a.go')).toEqual(['fmt']);
  });

  it('reads a blank import', () => {
    expect(specifiers('import _ "database/sql"\n', 'a.go')).toEqual(['database/sql']);
  });

  it('reads a dot import', () => {
    // `import . "x"` puts the package's names in the file's scope. The `.` is
    // an alias like `_`, and skipping only `_` leaves the reader on the dot.
    expect(specifiers('import . "fmt"\n', 'a.go')).toEqual(['fmt']);
  });

  it('reads an aliased import inside a group', () => {
    expect(specifiers('import (\n\tf "fmt"\n\t_ "os"\n)\n', 'a.go')).toEqual(['fmt', 'os']);
  });
});

/* ------------------------------------------------------------------ rust */

describe('expandUsePath', () => {
  it('takes the path out of a plain use', () => {
    expect(expandUsePath('std::fmt;')).toEqual(['std::fmt']);
  });

  it('takes the left-hand side of an alias', () => {
    expect(expandUsePath('std::fmt as f;')).toEqual(['std::fmt']);
  });

  it('strips a terminator that is separated from the path', () => {
    // The trailing-run pattern is anchored. Unanchored it strips the first run
    // of semicolons or spaces anywhere, which joins two words into one path.
    expect(expandUsePath('std::fmt ;')).toEqual(['std::fmt']);
    expect(expandUsePath('a::b c;')).toEqual(['a::b c']);
  });

  it('strips a leading separator', () => {
    expect(expandUsePath('::std::fmt;')).toEqual(['std::fmt']);
  });

  it('expands a group', () => {
    expect(expandUsePath('std::{fmt, io};')).toEqual(['std::fmt', 'std::io']);
  });

  it('expands a nested group', () => {
    expect(expandUsePath('a::{b::{c, d}, e};')).toEqual(['a::b::c', 'a::b::d', 'a::e']);
  });

  it('trims the prefix before joining it', () => {
    // Without the trim the joined path carries the whitespace, and a pattern
    // that names the module never matches it.
    expect(expandUsePath('  a :: {b};')).toEqual(['a::b']);
  });

  it('reports an empty path as nothing rather than as an empty name', () => {
    expect(expandUsePath(';')).toEqual([]);
  });
});

describe('rust use statements', () => {
  it('ends a use at its semicolon, not at the next one', () => {
    expect(specifiers('use std::fmt;\nlet x = 1;\nuse std::io;\n', 'a.rs')).toEqual(['std::fmt', 'std::io']);
  });

  it('reads a nested group that spans lines', () => {
    const source = 'use a::{\n  b::{c, d},\n  e,\n};\n';
    expect(specifiers(source, 'a.rs')).toEqual(['a::b::c', 'a::b::d', 'a::e']);
  });

  it.each([
    ['a group', 'use a::{b};\nuse c::d;\n'],
    ['a group spanning lines', 'use a::{\n  b,\n};\nuse c::d;\n'],
    ['a nested group', 'use a::{b::{x, y}};\nuse c::d;\n'],
    ['a group with a trailing comma', 'use a::{b,};\nuse c::d;\n'],
  ])('stops %s at its own semicolon, not the next one', (_name, source) => {
    // The brace counter is what ends the path. Break it and the first `use`
    // runs past its terminator and swallows the statement below - which only
    // shows up when there *is* a statement below, so a one-statement fixture
    // cannot see it.
    const found = specifiers(source, 'a.rs');

    expect(found).toContain('c::d');
    expect(found.length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------- c# */

describe('c# using directives', () => {
  it('reads a plain using', () => {
    expect(specifiers('using System.Text;\n', 'a.cs')).toEqual(['System.Text']);
  });

  it('reads a static using', () => {
    expect(specifiers('using static System.Math;\n', 'a.cs')).toEqual(['System.Math']);
  });

  it('takes the right-hand side of an alias, with space around the equals', () => {
    expect(specifiers('using Json  =  System.Text.Json;\n', 'a.cs')).toEqual(['System.Text.Json']);
  });

  it('skips a generic argument list on an alias target', () => {
    // Without the generic skip the reader stops on `<` and never reaches the
    // semicolon, so the whole directive is dropped.
    expect(specifiers('using L = System.Collections.Generic.List<int>;\n', 'a.cs')).toEqual([
      'System.Collections.Generic.List',
    ]);
  });

  it('skips a nested generic argument list', () => {
    expect(
      specifiers('using D = System.Collections.Generic.Dictionary<int, List<string>>;\n', 'a.cs'),
    ).toEqual(['System.Collections.Generic.Dictionary']);
  });

  it('gives up on a generic list that is never closed, rather than running on', () => {
    expect(specifiers('using D = System.List<int\nusing System.Text;\n', 'a.cs')).toEqual(['System.Text']);
  });

  it('is not fooled by a using statement or a using declaration', () => {
    const source = 'using (var s = Open()) { }\nusing var t = Open();\nusing System.Text;\n';
    expect(specifiers(source, 'a.cs')).toEqual(['System.Text']);
  });

  it('does not read a namespace that merely starts with "static"', () => {
    expect(specifiers('using staticfiles.Helpers;\n', 'a.cs')).toEqual(['staticfiles.Helpers']);
  });
});

/* ------------------------------------------------------------- normalising */

describe('normalizeModule', () => {
  it('leaves a go import path alone, because it is already slashes', () => {
    expect(normalizeModule('database/sql', 'a.go', 'go')).toBe('database/sql');
  });

  it('turns rust separators into slashes', () => {
    expect(normalizeModule('std::fmt::Debug', 'a.rs', 'rust')).toBe('std/fmt/Debug');
  });

  it('turns c# dots into slashes', () => {
    expect(normalizeModule('System.Text.Json', 'a.cs', 'csharp')).toBe('System/Text/Json');
  });

  it('turns python dots into slashes', () => {
    expect(normalizeModule('app.db.client', 'app/main.py', 'python')).toBe('app/db/client');
  });

  it('resolves a single-dot relative import against the importing file', () => {
    expect(normalizeModule('.sibling', 'app/pkg/main.py', 'python')).toBe('app/pkg/sibling');
  });

  it('resolves a dotted relative import, separators and all', () => {
    // The tail is dotted too, and leaving it dotted produces a path that no
    // module pattern can match.
    expect(normalizeModule('..other.mod', 'app/pkg/main.py', 'python')).toBe('app/other/mod');
  });

  it('climbs one directory per extra dot', () => {
    expect(normalizeModule('...top', 'a/b/c/main.py', 'python')).toBe('a/top');
  });

  it.each([
    ['.', 'a/b.py', 'a'],
    ['..', 'a/b/c.py', 'a'],
    ['...', 'a/b/c/d.py', 'a'],
  ])('resolves the bare relative marker %s to a directory, not a trailing slash', (specifier, file, expected) => {
    // The dots are stripped before the separators are rewritten. Rewriting
    // them instead turns `.` into `/` and the answer into `a/`, which no
    // module pattern matches - and every longer form hides it, because
    // `path.normalize` collapses the extra slash back out again.
    expect(normalizeModule(specifier, file, 'python')).toBe(expected);
  });
});
