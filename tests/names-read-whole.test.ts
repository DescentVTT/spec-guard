/**
 * Names and aliases read whole.
 *
 * On 0.27.0 a Go package name was read as ASCII: `import 名 "fmt"` and
 * `import café "fmt"` were read as no import, and so was `import _x "fmt"`,
 * whose `_` was taken for the blank identifier and the rest left over. And
 * a name at the end of its line, where Go puts a semicolon after it and the
 * import ends with no path, was read as an import of the next line's path.
 * No Go compiler is on the workstation, so the measure is The Go
 * Programming Language Specification, go1.27, read on 2026-10-19
 * ("Characters", "Letters and digits", "Identifiers", "Keywords",
 * "Semicolons", "Comments" and "Import declarations"): each source below is
 * held to the import the specification has it make, or to none where the
 * specification has it refused (ADR-0008, amended 2026-10-19).
 *
 * And a C# alias or `using static` was read by the name its type starts
 * with: `using T = G.L<N1.X>;` named `G.L` and not `N1.X`, `using T =
 * (N1.X, N2.Y);` named nothing, and `using T = int;` a namespace called
 * `int`. Each C# source below was compiled by the compiler of the .NET SDK
 * 10.0.401 beside the types it may name, and then without each type it is
 * said to name, which it failed to compile without.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import { MAX_EXPANSION, Reader } from '../src/polyglot.js';
import { runSpecGuard } from '../src/runner.js';
import { memoryIo } from './helpers.js';

const go = (source: string): string[] => analyzeSource(`package a\n${source}\n`, 'a.go').references.map((reference) => reference.specifier);

/** Each source, and the path the specification has it import, or null where it has the source refused. */
const GO: Array<[name: string, source: string, imports: string | null]> = [
  ['a name of a Letter category, Lo', 'import \u{540d} "fmt"', 'fmt'],
  ['a name in its NFC form, Ll', 'import caf\u{e9} "fmt"', 'fmt'],
  ['a name of Lt', 'import \u{1c5} "fmt"', 'fmt'],
  ['a name of Lm', 'import \u{2b0} "fmt"', 'fmt'],
  ['a name that starts with `_`', 'import _x "fmt"', 'fmt'],
  ['a name with `_` and a digit', 'import x_1 "fmt"', 'fmt'],
  ['a name with a decimal digit beyond ASCII, Nd', 'import x\u{661} "fmt"', 'fmt'],
  ['an ASCII name', 'import fmt2 "fmt"', 'fmt'],
  ['a word that is no keyword', 'import funcs "fmt"', 'fmt'],
  ['no space between a name and the path', 'import \u{540d}"fmt"', 'fmt'],
  ['`.` with no space', 'import ."fmt"', 'fmt'],
  ['`_` with no space', 'import _"fmt"', 'fmt'],
  ['`.` and a line break, which puts no semicolon after it', 'import .\n"fmt"', 'fmt'],
  ['a general comment with no line break, which acts like a space', 'import fmt2 /* c */ "fmt"', 'fmt'],
  ['a line break after `import`, which puts no semicolon after it', 'import\n"fmt"', 'fmt'],
  ['a line break after `import`, then a name', 'import\n\tfmt2 "fmt"', 'fmt'],
  ['a raw string for the path', 'import \u{540d} `fmt`', 'fmt'],
  ['names in a group', 'import (\n\t\u{540d} "fmt"\n\tcaf\u{e9} "os"\n)', 'fmt,os'],
  ['a combining mark, Mn, which is no letter', 'import cafe\u{301} "fmt"', null],
  ['a decimal digit first', 'import \u{661}x "fmt"', null],
  ['a letter number, Nl, which is no letter', 'import \u{2160} "fmt"', null],
  ['a formatting character, Cf', 'import x\u{200b} "fmt"', null],
  ['a line break between the name and the path', 'import fmt2\n"fmt"', null],
  ['a line comment between them, which acts like a line break', 'import fmt2 // c\n"fmt"', null],
  ['a general comment holding a line break between them', 'import fmt2 /* a\nb */ "fmt"', null],
  ['`_` and a line break', 'import _\n"fmt"', null],
  ['a keyword for the name', 'import func "fmt"', null],
  ['two names', 'import \u{540d} \u{540d} "fmt"', null],
  ['a digit for the name', 'import 1 "fmt"', null],
];

describe('a Go import with a package name', () => {
  it.each(GO)('with %s is read as the specification has it', (_name, source, imports) => {
    expect(go(source).join(','), source).toBe(imports ?? '');
  });

  it.each(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'].map((word) => [word]))(
    'names nothing with the keyword %s for its name, which Go refuses',
    (word) => {
      expect(go(`import ${word} "fmt"`)).toEqual([]);
      expect(go(`import ${word}s "fmt"`)).toEqual(['fmt']);
    },
  );

  it('reports the import on the line of its `import`, as before', () => {
    expect(analyzeSource('package a\n\nimport \u{540d} "fmt"\n', 'a.go').references.map(({ line }) => line)).toEqual([3]);
  });
});

describe("the Reader's identifier", () => {
  it('is a letter of any Letter category, or `_`, then letters and decimal digits', () => {
    for (const name of ['\u{540d}', 'caf\u{e9}', '\u{1c5}x', '\u{2b0}', '_', '_x9', 'x\u{661}', '\u{3b1}\u{3b2}']) {
      const reader = new Reader(`${name} "fmt"`);
      expect(reader.identifier(), name).toBe(name);
      expect(reader.index, name).toBe(name.length);
    }
  });

  it('stops at a mark, a letter number, a formatting character and a digit first', () => {
    expect(new Reader('cafe\u{301}').identifier()).toBe('cafe');
    expect(new Reader('\u{2160}').identifier()).toBe('');
    expect(new Reader('x\u{200b}y').identifier()).toBe('x');
    expect(new Reader('\u{661}x').identifier()).toBe('');
  });
});

describe('an import rule over a Go package name beyond ASCII', () => {
  const root = path.resolve('/virtual');
  const report = (source: string) =>
    runSpecGuard({
      root,
      patterns: ['docs/a.md'],
      io: memoryIo(root, { 'docs/a.md': '<!-- @assert-import-absence target="src" module="forbidden/**" -->\n', 'src/a.go': `package a\n${source}\n` }),
    });

  it('fails where the package is imported under such a name, and holds where Go refuses the import', async () => {
    for (const source of ['import \u{540d} "forbidden/db"', 'import caf\u{e9} "forbidden/db"', 'import _x "forbidden/db"']) {
      const result = await report(source);
      expect([result.ok, result.results[0]?.matches.map(({ line }) => line)], source).toEqual([false, [2]]);
    }
    for (const source of ['import cafe\u{301} "forbidden/db"', 'import db\n"forbidden/db"', 'import func "forbidden/db"']) {
      const result = await report(source);
      expect([result.ok, result.results[0]?.actual], source).toEqual([true, 0]);
    }
  });
});

const csharp = (source: string): string[] => analyzeSource(source, 'src/Shop.cs').references.map((reference) => reference.specifier);

/**
 * Each source the compiler of the .NET SDK 10.0.401 compiled on 2026-10-19
 * beside the types it may name, and the types it then failed to compile
 * without, one at a time: the names the directive depends on, as the C#
 * specification has a type written (Types, 8; Unsafe code, 24.3; Namespaces,
 * 14.6.2 and 14.6.4, on Microsoft Learn, dated 2026-09-22).
 */
const CSHARP: Array<[source: string, names: string[]]> = [
  ['using static G.L<N1.At_N1>;', ['G.L', 'N1.At_N1']],
  ['using T = G.L<N1.At_N1>;', ['G.L', 'N1.At_N1']],
  ['using T = G.L<G.M<N1.At_N1>>;', ['G.L', 'G.M', 'N1.At_N1']],
  ['using T = G.L2<N1.At_N1, N3.X>;', ['G.L2', 'N1.At_N1', 'N3.X']],
  ['using T = (N1.At_N1, N1.N2.At_N1_N2);', ['N1.At_N1', 'N1.N2.At_N1_N2']],
  ['using T = (N1.At_N1 a, N1.N2.At_N1_N2 b);', ['N1.At_N1', 'N1.N2.At_N1_N2']],
  ['using T = (N1.At_N1, (N1.N2.At_N1_N2, int));', ['N1.At_N1', 'N1.N2.At_N1_N2']],
  ['using T = (N1.At_N1, N3.X)[];', ['N1.At_N1', 'N3.X']],
  ['using T = int;', []],
  ['using T = string;', []],
  ['using T = object[];', []],
  ['using T = (int, string);', []],
  ['using T = G.L<int>;', ['G.L']],
  ['using T = G.L<object>;', ['G.L']],
  ['using T = G.L<N1.At_N1[]>;', ['G.L', 'N1.At_N1']],
  ['using T = G.L<N1.N2.V?>;', ['G.L', 'N1.N2.V']],
  ['using T = G.L<(N1.At_N1, int)>;', ['G.L', 'N1.At_N1']],
  ['using unsafe T = delegate*<N1.N2.V, void>;', ['N1.N2.V']],
  ['using unsafe T = delegate*<int, N1.N2.V>;', ['N1.N2.V']],
  ['using unsafe T = N1.N2.V*;', ['N1.N2.V']],
  ['using T = global::G.L<global::N1.At_N1>;', ['G.L', 'N1.At_N1']],
  ['using static G.L<N1.At_N1>.Nested;', ['G.L.Nested', 'N1.At_N1']],
  ['namespace N9 { using T = G.L<N1.At_N1>; }', ['G.L', 'N1.At_N1']],
];

describe('a C# using directive', () => {
  it.each(CSHARP)('%j names each type the compiler has it depend on', (source, names) => {
    expect(csharp(source)).toEqual(names);
  });

  it('names nothing for a keyword that names a type, an alias, a tuple element or a calling convention', () => {
    for (const word of ['bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte', 'short', 'string', 'uint', 'ulong', 'ushort']) {
      expect(csharp(`using T = ${word};`), word).toEqual([]);
      expect(csharp(`using T = G.L<${word}>;`), word).toEqual(['G.L']);
    }
    expect(csharp('using unsafe T = void*;')).toEqual([]);
    expect(csharp('using Alias = (N1.X First, N2.Y Second);')).toEqual(['N1.X', 'N2.Y']);
    expect(csharp('using unsafe T = delegate* unmanaged[Cdecl]<N1.X, void>;')).toEqual(['N1.X']);
  });

  it('names a type it holds twice once, and each on the line of its `using`, in its namespace', () => {
    expect(csharp('using T = G.L<G.L<int>>;')).toEqual(['G.L']);
    const analysis = analyzeSource('namespace Shop\n{\n    using Pool = G.L<\n        Db.Key>;\n}\n', 'src/Shop.cs');
    expect(analysis.references.map(({ specifier, line, namespace }) => [specifier, line, namespace])).toEqual([
      ['G.L', 3, 'Shop'],
      ['Db.Key', 3, 'Shop'],
    ]);
  });

  it('reads a contextual keyword where a type stands as the name it may be, as before', () => {
    // `dynamic` and `nint` are the dynamic type and IntPtr unless a type so
    // named is in scope, which the reader cannot tell.
    expect(csharp('using T = dynamic;')).toEqual(['dynamic']);
    expect(csharp('using T = G.L<dynamic>;')).toEqual(['G.L', 'dynamic']);
  });

  it('reads nothing of a type the compiler refuses', () => {
    for (const source of ['using T = void;', 'using T = int*;', 'using T = (int);', 'using T = ();', 'using T = G.L<>;', 'using unsafe T = G.L<int*>;', 'using unsafe T = (delegate*<void>, int);']) {
      expect(csharp(source), source).toEqual([]);
    }
  });
});

describe('how deep a C# type may nest', () => {
  const nested = (depth: number): string => `using T = ${'G.L<'.repeat(depth)}N1.X${'>'.repeat(depth)};\nusing Ui;\n`;
  const said = (source: string) => {
    const analysis = analyzeSource(source, 'src/Shop.cs');
    return [analysis.references.map(({ specifier }) => specifier), analysis.notes.map(({ kind }) => kind)];
  };

  it('is MAX_EXPANSION types, and one deeper is reported, with no name read, as twenty thousand are', () => {
    expect(said(nested(MAX_EXPANSION - 1))).toEqual([['G.L', 'N1.X', 'Ui'], []]);
    for (const depth of [MAX_EXPANSION, 20_000]) expect(said(nested(depth)), String(depth)).toEqual([['Ui'], ['truncated']]);
    expect(said(`using T = ${'('.repeat(20_000)}int, int${', int)'.repeat(20_000)};\n`)).toEqual([[], ['truncated']]);
    expect(said(`using T = ${'G.L<'.repeat(125_000)}\nusing Ui;\n`)).toEqual([['Ui'], ['truncated']]);
  });

  it('is a depth, not a count: a thousand types side by side are read', () => {
    expect(said(`using T = G.L<${Array.from({ length: 1000 }, (_, at) => `N${at}.X`).join(', ')}>;\n`)[0]).toHaveLength(1001);
  });
});

describe('an import rule over a type a C# alias names', () => {
  const root = path.resolve('/virtual');
  const report = (source: string) =>
    runSpecGuard({
      root,
      patterns: ['docs/a.md'],
      io: memoryIo(root, { 'docs/a.md': '<!-- @assert-import-absence target="src" module="Shop.Db" -->\n', 'src/Shop.cs': source }),
    });

  it('fails where an alias holds the type as an argument or an element, and holds where it holds none', async () => {
    for (const source of ['using Pool = System.Collections.Generic.Dictionary<Shop.Db.Key, int>;\n', 'using Pair = (Shop.Db.Key, int);\n', 'using static Shop.Ui.Views<Shop.Db.Key>;\n']) {
      const result = await report(source);
      expect([result.ok, result.results[0]?.matches.map(({ line }) => line)], source).toEqual([false, [1]]);
    }
    for (const source of ['using Pair = (int, string);\n', 'using Pool = Shop.Ui.Views<int>;\n']) {
      const result = await report(source);
      expect([result.ok, result.results[0]?.actual], source).toEqual([true, 0]);
    }
  });
});

describe('a C# alias of any type C# 12 takes', () => {
  it('reads each as the compiler of the .NET SDK 10.0.401 takes it, and names what it holds', () => {
    // Each compiled as a library and as a program on 2026-10-19.
    const read: Array<[string, string[]]> = [
      ['using T = (int a, string b);', []],
      ['using T = (int, string)[];', []],
      ['using T = (int, string)?;', []],
      ['using T = ((int, int), (string, string));', []],
      ['using T = int[];', []],
      ['using T = int?;', []],
      ['using T = N1.N2.At_N1_N2[ , ][];', ['N1.N2.At_N1_N2']],
      ['using unsafe T = int**;', []],
      ['using unsafe T = delegate*<void>;', []],
      ['using unsafe T = delegate*<int, string, void>;', []],
      ['using unsafe T = delegate* unmanaged[Cdecl]<int, void>;', []],
      ['using unsafe T = delegate* managed<int, void>;', []],
      ['using unsafe T = delegate*<ref int, ref readonly int>;', []],
      ['using unsafe T = delegate*<in int, out int, ref readonly int, void>;', []],
      ['using unsafe T = delegate*<int*, void>;', []],
      ['using unsafe T = delegate*<void>*;', []],
      ['using unsafe T = delegate*<void>[];', []],
      ['using unsafe T = G.L<int>*;', ['G.L']],
      ['using unsafe T = delegate*<in N1.X, out N2.Y, ref readonly N3.Z>;', ['N1.X', 'N2.Y', 'N3.Z']],
    ];
    for (const [source, names] of read) expect(csharp(source), source).toEqual(names);
  });
});

describe('a C# alias the compiler refuses, which names nothing', () => {
  it('is read as nothing, where the type that refuses it holds a name', () => {
    // Each refused by the compiler of the .NET SDK 10.0.401 on 2026-10-19,
    // beside the types the names name: a tuple of one (CS8124), a pointer for
    // a tuple's element or a type argument (CS0306), and a pointer outside
    // `unsafe` (CS0214).
    for (const source of ['using T = (N1.X);', 'using unsafe T = (N1.X*, int);', 'using unsafe T = G.L<delegate*<N1.X>>;', 'using T = N1.N2.V*;', 'using static;', 'using N1.N2\nclass X {}']) {
      expect(csharp(source), source).toEqual([]);
    }
  });

  it('names what a function pointer takes, with its calling convention or a pointer for a parameter', () => {
    // Each compiled beside the types on 2026-10-19.
    expect(csharp('using unsafe T = delegate* managed<N1.X, void>;')).toEqual(['N1.X']);
    expect(csharp('using unsafe T = delegate*<N1.X*, void>;')).toEqual(['N1.X']);
  });
});

describe('a C# type cut short', () => {
  it('names nothing, where what was read of it holds a name', () => {
    // Refused by the compiler: a tuple of one left open (CS8124) and one with
    // nothing after its comma (CS1031).
    expect(csharp('using T = (N1.X;')).toEqual([]);
    expect(csharp('using T = (N1.X, ;')).toEqual([]);
    // An argument list and a function pointer's parameters left open after a
    // name (CS1031).
    expect(csharp('using T = G.L<;')).toEqual([]);
    expect(csharp('using unsafe T = delegate*<N1.X, ;')).toEqual([]);
    // An argument list left empty at the depth is cut short there too.
    const deep = analyzeSource(`using T = ${'G.L<'.repeat(MAX_EXPANSION)}${'>'.repeat(MAX_EXPANSION)};\n`, 'src/Shop.cs');
    expect([deep.references, deep.notes.map(({ kind, detail }) => [kind, detail])]).toEqual([[], [['truncated', `a using directive nests its types deeper than ${MAX_EXPANSION}`]]]);
  });

  it('names a nested type and what a function pointer of two conventions takes', () => {
    // Each compiled on 2026-10-19.
    expect(csharp('using T = G.L<int>.Nested;')).toEqual(['G.L.Nested']);
    expect(csharp('using unsafe T = delegate* unmanaged[Cdecl, SuppressGCTransition]<N1.X, void>;')).toEqual(['N1.X']);
  });
});

describe('a C# directive the compiler refuses, in this reader', () => {
  it('is read as nothing and makes no note, at the end of a file too', () => {
    // A note is made only of a type that nests too deep; what is refused for
    // anything else is passed over, as it was.
    for (const source of ['using A.;', 'using T = void;', 'using unsafe N1.N2;', 'using T =', 'using static', 'using T = G.L<']) {
      const analysis = analyzeSource(source, 'src/Shop.cs');
      expect([analysis.references, analysis.notes], source).toEqual([[], []]);
    }
  });
});
