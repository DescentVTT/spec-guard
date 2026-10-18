/**
 * A Python import statement is read as Python reads it.
 *
 * On 0.25.0 a statement was read by two patterns, which wanted a blank after
 * each keyword and took whatever followed `import`. `from a import(b)`, which
 * Python reads, was no import, and neither were `from.a import b`,
 * `from . a import b`, `from a import*` and the other spellings below that
 * put no blank, a dot, a form feed or a name beyond ASCII where the patterns
 * wanted something else: an import rule passed over each. And
 * `from a import b,`, `import (a)` and `import a b`, which Python refuses,
 * were each read as an import.
 *
 * The two tables are Python's own answers. Each source was parsed and
 * compiled by Python 3.11.9 on 2026-10-14, and what its `ast` gave is what
 * is asserted: every import by the name spec-guard gives it and the line
 * Python puts it on, or that the source was refused. A `lazy` import is
 * Python 3.15's, which 3.11.9 refuses, and is held to the language reference
 * as read that day (ADR-0008, amended 2026-10-14).
 *
 * A statement that starts as an import and that Python refuses names no
 * module, and on 0.26.0 nothing said so, under --strict either. Each is now
 * a note on its line, as everything an import rule could not read is
 * (ADR-0008, amended 2026-10-18).
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import { logicalLines } from '../src/polyglot.js';
import { runSpecGuard } from '../src/runner.js';
import { memoryIo } from './helpers.js';

const CR = String.fromCharCode(13);
const CRLF = `${CR}\n`;

/** Each import of a source, with the line it is reported on. */
function read(source: string): Array<[string, number]> {
  return analyzeSource(source, 'pkg/m.py').references.map((reference) => [reference.specifier, reference.line]);
}

/** The line of each statement a source starts as an import and Python refuses. */
function said(source: string): number[] {
  return analyzeSource(source, 'pkg/m.py').notes.filter((note) => note.kind === 'refused').map((note) => note.line);
}

/** Of the sources Python refuses, those in which no statement starts with an import's keyword. */
const NO_STATEMENT = new Set([
  'froma import b\n',
  'Import a\n',
  'FROM a IMPORT b\n',
  'import\u00e9 a\n',
  'from\u00e9 a import b\n',
  'import_ a\n',
  'from_ a import b\n',
  'im\\\nport a\n',
  'x = 1 import a\n',
  'x = import a\n',
]);

/** What Python 3.11.9 reads of each source: every import, by the name spec-guard gives it, and its line. */
const READ: Array<[source: string, imports: Array<[string, number]>]> = [
  // plain
  ['import a\n', [['a', 1]]],
  ['import a.b.c\n', [['a.b.c', 1]]],
  ['import a.b as c\n', [['a.b', 1]]],
  ['import a, b\n', [['a', 1], ['b', 1]]],
  ['import a as x, b.c as y\n', [['a', 1], ['b.c', 1]]],
  ['from a import b\n', [['a', 1]]],
  ['from a.b import c\n', [['a.b', 1]]],
  ['from a import b as c\n', [['a', 1]]],
  ['from a import b, c\n', [['a', 1]]],
  ['from a import *\n', [['a', 1]]],
  ['from . import a\n', [['.a', 1]]],
  ['from . import a, b\n', [['.a', 1], ['.b', 1]]],
  ['from .. import a\n', [['..a', 1]]],
  ['from ... import a\n', [['...a', 1]]],
  ['from .... import a\n', [['....a', 1]]],
  ['from .pkg import name\n', [['.pkg', 1]]],
  ['from ..pkg.sub import name\n', [['..pkg.sub', 1]]],
  ['from . import *\n', []],
  ['from . import a as b\n', [['.a', 1]]],
  ['import a1.b2\n', [['a1.b2', 1]]],
  ['import a,b as c,d\n', [['a', 1], ['b', 1], ['d', 1]]],
  ['from a import b as c,d as e\n', [['a', 1]]],
  ['from ...a.b.c import d\n', [['...a.b.c', 1]]],
  ['from . import a as b, c as d\n', [['.a', 1], ['.c', 1]]],
  // parentheses
  ['from a import (b)\n', [['a', 1]]],
  ['from a import(b)\n', [['a', 1]]],
  ['from a import(b, c)\n', [['a', 1]]],
  ['from a import( b , c )\n', [['a', 1]]],
  ['from a import(b as c, d as e)\n', [['a', 1]]],
  ['from a import (\n    b,\n    c\n)\n', [['a', 1]]],
  ['from a import(\n    b,\n    c\n)\n', [['a', 1]]],
  ['from . import (a)\n', [['.a', 1]]],
  ['from . import(a)\n', [['.a', 1]]],
  ['from . import(a, b)\n', [['.a', 1], ['.b', 1]]],
  ['from .. import(a)\n', [['..a', 1]]],
  ['from .pkg import(name)\n', [['.pkg', 1]]],
  ['from . import(\n    a,\n    b,\n)\nimport c\n', [['.a', 1], ['.b', 1], ['c', 5]]],
  ['from . import (a as x, b as y)\n', [['.a', 1], ['.b', 1]]],
  ['from a import(b); import c\n', [['a', 1], ['c', 1]]],
  ['x = (1,\n     2); import a\n', [['a', 2]]],
  ['from a import (b\n)\n', [['a', 1]]],
  ['from a import (\nb)\n', [['a', 1]]],
  ['from a import (b as c)\n', [['a', 1]]],
  // star
  ['from a import*\n', [['a', 1]]],
  ['from . import*\n', []],
  ['from .a import*\n', [['.a', 1]]],
  ['from a import*;import b\n', [['a', 1], ['b', 1]]],
  ['from ..a import *\n', [['..a', 1]]],
  // keyword
  ['importa\n', []],
  ['import\u00e9\n', []],
  ['x = 1; from\u00e9\n', []],
  ['importer = 1\nfrom_ = 2\n', []],
  // whitespace
  ['import  a\n', [['a', 1]]],
  ['import\ta\n', [['a', 1]]],
  ['import\fa\n', [['a', 1]]],
  ['\fimport a\n', [['a', 1]]],
  ['import a\f\n', [['a', 1]]],
  ['import a \n', [['a', 1]]],
  ['import a\t\n', [['a', 1]]],
  ['from\ta\timport\tb\n', [['a', 1]]],
  ['from\fa\fimport\fb\n', [['a', 1]]],
  ['from  a  import  b\n', [['a', 1]]],
  ['from a import b ,c\n', [['a', 1]]],
  ['from a import b,c\n', [['a', 1]]],
  ['import a ,b\n', [['a', 1], ['b', 1]]],
  ['import a,b\n', [['a', 1], ['b', 1]]],
  ['import a as b,c\n', [['a', 1], ['c', 1]]],
  ['import a\tas\tb\n', [['a', 1]]],
  ['from.a import b\n', [['.a', 1]]],
  ['from.import a\n', [['.a', 1]]],
  ['from.import(a)\n', [['.a', 1]]],
  ['from .import a\n', [['.a', 1]]],
  ['from..a import b\n', [['..a', 1]]],
  ['from...a import b\n', [['...a', 1]]],
  ['from . a import b\n', [['.a', 1]]],
  ['from . . import a\n', [['..a', 1]]],
  ['from .. . import a\n', [['...a', 1]]],
  ['from . .. import a\n', [['...a', 1]]],
  ['from .a . b import c\n', [['.a.b', 1]]],
  ['from a . b import c\n', [['a.b', 1]]],
  ['from a .b import c\n', [['a.b', 1]]],
  ['from a. b import c\n', [['a.b', 1]]],
  ['import a . b\n', [['a.b', 1]]],
  ['import a .b as c\n', [['a.b', 1]]],
  ['import a. b, c\n', [['a.b', 1], ['c', 1]]],
  ['if x:\n    import a\n', [['a', 2]]],
  ['if x:\n\timport a\n', [['a', 2]]],
  ['from a import(b) \n', [['a', 1]]],
  ['from a import ( b )\n', [['a', 1]]],
  ['from a import\t(b)\n', [['a', 1]]],
  ['from a import\f(b)\n', [['a', 1]]],
  ['from a import  b  as  c\n', [['a', 1]]],
  ['from\ta\timport\t(\tb\t,\tc\t)\t\n', [['a', 1]]],
  ['import a\tas b,\tc\n', [['a', 1], ['c', 1]]],
  ['import a as\\\n b\n', [['a', 1]]],
  ['from a import b as\\\n c\n', [['a', 1]]],
  // comments
  ['import a # why\n', [['a', 1]]],
  ['import a# why\n', [['a', 1]]],
  ['import a #, b\n', [['a', 1]]],
  ['# import a\n', []],
  ['from a import b # why\n', [['a', 1]]],
  ['from a import(b) # why\n', [['a', 1]]],
  ['from a import(b)# why\n', [['a', 1]]],
  ['from a import( # why\n    b, # this one\n    c # and that\n)\n', [['a', 1]]],
  ['from a import (  # import x\n    b,\n)\n', [['a', 1]]],
  ['from . import( # why\n    a,\n    # import x\n    b,\n)\n', [['.a', 1], ['.b', 1]]],
  ['from a import (\n    b,\n# c,\n)\n', [['a', 1]]],
  ['from a import ( # (\n    b)\n', [['a', 1]]],
  ['import a; # why\n', [['a', 1]]],
  ['x = 1 # ; import a\n', []],
  ['"""\nimport a\nfrom b import(c)\n"""\nimport d\n', [['d', 5]]],
  ['x = "import a"\n', []],
  ['x = \'from a import(b)\'; import c\n', [['c', 1]]],
  // continuation
  ['import a, \\\n    b\n', [['a', 1], ['b', 1]]],
  ['import \\\n    a\n', [['a', 1]]],
  ['import a \\\n    as b\n', [['a', 1]]],
  ['import a\\\n.b\n', [['a.b', 1]]],
  ['from a \\\n    import b\n', [['a', 1]]],
  ['from \\\n    a import b\n', [['a', 1]]],
  ['from a import \\\n    b\n', [['a', 1]]],
  ['from a import b, \\\n    c\n', [['a', 1]]],
  ['from a import\\\n    b\n', [['a', 1]]],
  ['from a import\\\n(b)\n', [['a', 1]]],
  ['from a import\\\nb\n', [['a', 1]]],
  ['from a \\\nimport(b)\n', [['a', 1]]],
  ['from . \\\n    import a\n', [['.a', 1]]],
  ['from . import \\\n    a, \\\n    b\n', [['.a', 1], ['.b', 1]]],
  ['from a import(b, \\\n    c)\n', [['a', 1]]],
  ['from a import \\\n    (b,\n     c)\n', [['a', 1]]],
  ['from a import (\n\n    b\n\n)\n', [['a', 1]]],
  ['from . import (\n\n    a,\n\n    b\n\n)\n', [['.a', 1], ['.b', 1]]],
  ['import a \\\n\nimport b\n', [['a', 1], ['b', 3]]],
  ['from a import b \\\n\n', [['a', 1]]],
  ['x = 1; \\\n    import a\n', [['a', 2]]],
  ['if x: \\\n    import a\n', [['a', 2]]],
  ['from a import (b,\n               c); import d\n', [['a', 1], ['d', 2]]],
  ['x = 1;\\\nimport a\n', [['a', 2]]],
  ['if x:\\\nimport a\n', [['a', 2]]],
  ['x = (1,\n2);import a\n', [['a', 2]]],
  ['x = (1,\n2)\nimport a\n', [['a', 3]]],
  // trailing comma
  ['from a import (b,)\n', [['a', 1]]],
  ['from a import(b,)\n', [['a', 1]]],
  ['from a import (b, c,)\n', [['a', 1]]],
  ['from a import (\n    b,\n    c,\n)\n', [['a', 1]]],
  ['from . import (a,)\n', [['.a', 1]]],
  ['from . import(a, b,)\n', [['.a', 1], ['.b', 1]]],
  ['from a import (b as c,)\n', [['a', 1]]],
  ['from a import (b as c, d,)\n', [['a', 1]]],
  ['from a import ( b , )\n', [['a', 1]]],
  ['from a import (b ,)\n', [['a', 1]]],
  ['from . import (a as b,)\n', [['.a', 1]]],
  // position
  ['x = 1; import a\n', [['a', 1]]],
  ['x = 1;import a\n', [['a', 1]]],
  ['import a; import b\n', [['a', 1], ['b', 1]]],
  ['import a;\n', [['a', 1]]],
  ['from a import b; from c import(d)\n', [['a', 1], ['c', 1]]],
  ['if x: import a\n', [['a', 1]]],
  ['if x:import a\n', [['a', 1]]],
  ['if x: import a; import b\n', [['a', 1], ['b', 1]]],
  ['if x: import a\nelse: import b\n', [['a', 1], ['b', 2]]],
  ['try: import a\nexcept ImportError: from b import(c)\n', [['a', 1], ['b', 2]]],
  ['class C: import a\n', [['a', 1]]],
  ['def f(): import a\n', [['a', 1]]],
  ['def f(x: int) -> int: import a\n', [['a', 1]]],
  ['with x: import a\n', [['a', 1]]],
  ['for i in x: import a\n', [['a', 1]]],
  ['while x: import a\n', [['a', 1]]],
  ['x = {1: from_a}\n', []],
  ['x = y[1:from_a]\n', []],
  ['def f():\n    yield from a\n', []],
  ['try:\n    pass\nexcept E as e:\n    raise X from e\n', []],
  ['importlib.import_module\n', []],
  ['from_ = 1\nimport_ = 2\n', []],
  ['x = [\n    import_a,\n    from_b,\n]\n', []],
  ['x: int = 1; import a\n', [['a', 1]]],
  ['import a;import b\n', [['a', 1], ['b', 1]]],
  ['from a import b;import c\n', [['a', 1], ['c', 1]]],
  ['from a import (b) ;import c\n', [['a', 1], ['c', 1]]],
  ['import a ; import b ; import c\n', [['a', 1], ['b', 1], ['c', 1]]],
  // names
  ['import m\u00f3dulo\n', [['m\u00f3dulo', 1]]],
  ['from m\u00f3dulo import x\n', [['m\u00f3dulo', 1]]],
  ['from .m\u00f3dulo import x\n', [['.m\u00f3dulo', 1]]],
  ['from . import m\u00f3dulo\n', [['.m\u00f3dulo', 1]]],
  ['from a import \u86c7\n', [['a', 1]]],
  ['from \u86c7 import(a)\n', [['\u86c7', 1]]],
  ['import a.\u86c7.b\n', [['a.\u86c7.b', 1]]],
  ['import _a, a1, _1\n', [['_a', 1], ['a1', 1], ['_1', 1]]],
  ['import \ufb01le\n', [['file', 1]]],
  ['from \ufb01le import x\n', [['file', 1]]],
  ['from . import \ufb01le\n', [['.file', 1]]],
  ['import match, case, type, _\n', [['match', 1], ['case', 1], ['type', 1], ['_', 1]]],
  ['from match import case\n', [['match', 1]]],
];

/** What Python 3.11.9 refuses, and reads no import of. */
const REFUSED: string[] = [
  // parentheses
  'from a import()\n',
  'from a import ()\n',
  'from a import(b\n',
  'from a import (b\nimport c\n',
  'from a import b)\n',
  'from a import(*)\n',
  'from a import (*)\n',
  'from a import (b), c\n',
  'from a import (b)(c)\n',
  'from a import((b))\n',
  'from a import(b)c\n',
  'from a import(b) as c\n',
  'from a import(b).c\n',
  'from (a) import b\n',
  'from(a)import b\n',
  'import(a)\n',
  'import (a)\n',
  'import (a, b)\n',
  'from . import (a.b)\n',
  'from a import [b]\n',
  'from a import (b))\n',
  'from a import )b(\n',
  'from a import b(\n',
  'from a import (b) as c\n',
  'import a, (b)\n',
  // star
  'from a import *, b\n',
  'from a import b, *\n',
  'from a import **\n',
  'from a import * as b\n',
  'from a import (*,)\n',
  'import *\n',
  'import a.*\n',
  'from * import a\n',
  'from a.* import b\n',
  // keyword
  'from a importb\n',
  'from a import_b\n',
  'from a import1\n',
  'from aimport b\n',
  'from a.import b\n',
  'froma import b\n',
  'from a import\n',
  'from a import \n',
  'import\n',
  'from\n',
  'from import a\n',
  'from a import 1\n',
  'from a import b c\n',
  'from a import b.c\n',
  'import a b\n',
  'import a.\n',
  'import .a\n',
  'import a..b\n',
  'import a as\n',
  'import a as b.c\n',
  'import a as b as c\n',
  'from a import b as\n',
  'import 1\n',
  'import a-b\n',
  'import a = 1\n',
  'Import a\n',
  'FROM a IMPORT b\n',
  'import\u00e9 a\n',
  'from\u00e9 a import b\n',
  'import_ a\n',
  'from_ a import b\n',
  'from a import\u00e9 b\n',
  // whitespace
  'import\u000ba\n',
  'import\u00a0a\n',
  'import a\u00a0\n',
  'from . import a . b\n',
  // comments
  'from a import b, # c\n',
  // continuation
  'im\\\nport a\n',
  'import a, \\ \n    b\n',
  // trailing comma
  'from a import b,\n',
  'from . import a,\n',
  'from . import a, b,\n',
  'import a,\n',
  'import a, b,\n',
  'from a import (b,,)\n',
  'from a import (,)\n',
  'from a import (,b)\n',
  'from . import (a,,b)\n',
  'from . import a,,b\n',
  'import a,,b\n',
  'from a import (b as,)\n',
  'from a import (b, as c)\n',
  // position
  'x = 1 import a\n',
  'x = import a\n',
  'import a import b\n',
  'import a from b import c\n',
  // names
  'from a import \u20ac\n',
  'import 1a\n',
  'from a import b\u2028c\n',
  // plain
  'from .1 import a\n',
  'from . import 1\n',
];

describe('an import statement Python reads', () => {
  it.each(READ)('%j is read as Python reads it, on the line it is on', (source, imports) => {
    expect(read(source)).toEqual(imports);
    // Python reads a line that ends in CRLF as it reads one that ends in LF.
    expect(read(source.replaceAll('\n', CRLF))).toEqual(imports);
    expect(said(source)).toEqual([]);
  });
});

describe('a statement Python refuses', () => {
  it.each(REFUSED)('%j is read as no import', (source) => {
    expect(read(source)).toEqual([]);
  });

  it.each(REFUSED.filter((source) => !NO_STATEMENT.has(source)))('%j, which starts as an import, is said on its line', (source) => {
    expect(said(source)).toEqual([1]);
    expect(said(source.replaceAll('\n', CRLF))).toEqual([1]);
  });

  it.each([...NO_STATEMENT])('%j, where no statement starts as an import, is said nowhere', (source) => {
    expect(said(source)).toEqual([]);
  });

  it('is said on the line its first word stands on, and with its file', () => {
    const notes = analyzeSource('import os\nx = (1,\n     2); from a import b,\n', 'pkg/m.py').notes;
    expect(notes.map(({ kind, file, line, column }) => [kind, file, line, column])).toEqual([['refused', 'pkg/m.py', 3, 1]]);
    expect(notes[0]?.detail).toBe('a statement that starts as an import is one Python refuses, and no module is read from it');
  });

  it('is said once a statement, and the statement after it is read', () => {
    expect(said('from a import b,; import c\nimport d e\nimport f\n')).toEqual([1, 2]);
    expect(read('from a import b,; import c\nimport d e\nimport f\n')).toEqual([['c', 1], ['f', 3]]);
  });
});

describe("Python 3.15's lazy imports", () => {
  // The grammar its language reference gives the import statement, as read
  // on 2026-10-14: `lazy` may stand before `import` and before `from`, and
  // not before a star import. Python 3.11.9 refuses each of these.
  const LAZY: Array<[source: string, imports: Array<[string, number]>]> = [
    ['lazy import a\n', [['a', 1]]],
    ['lazy import a.b as c, d\n', [['a.b', 1], ['d', 1]]],
    ['lazy from a import b\n', [['a', 1]]],
    ['lazy from a import(b)\n', [['a', 1]]],
    ['lazy from . import a, b\n', [['.a', 1], ['.b', 1]]],
    ['lazy from .pkg import (\n    a,\n)\n', [['.pkg', 1]]],
    ['lazy\timport a\n', [['a', 1]]],
    ['lazy\fimport a\n', [['a', 1]]],
    ['\flazy import a\n', [['a', 1]]],
    ['lazy  import a\n', [['a', 1]]],
    ['x = 1; lazy import a\n', [['a', 1]]],
    ['x = 1;lazy from a import b\n', [['a', 1]]],
    ['if x: lazy import a\n', [['a', 1]]],
  ];

  it.each(LAZY)('%j is read as the import it is', (source, imports) => {
    expect(read(source)).toEqual(imports);
  });

  it('is no import before a star, which the reference has Python refuse', () => {
    expect(read('lazy from a import *\n')).toEqual([]);
    expect(said('lazy from a import *\n')).toEqual([1]);
    expect(read('from a import *\n')).toEqual([['a', 1]]);
  });

  it('is reported on the line `lazy` stands on', () => {
    expect(read('lazy \\\n    import a\n')).toEqual([['a', 1]]);
    expect(read('x = (1,\n     2); lazy import a\n')).toEqual([['a', 2]]);
  });

  // Anywhere else `lazy` is a name, and Python 3.11.9 reads each of these so.
  const A_NAME: Array<[source: string, imports: Array<[string, number]>]> = [
    ['lazy = 1\nimport a\n', [['a', 2]]],
    ['lazy\nimport a\n', [['a', 2]]],
    ['lazy; import a\n', [['a', 1]]],
    ['lazy(import_a)\n', []],
    ['lazy.import_a\n', []],
    ['lazyimport a\n', []],
    ['lazy lazy import a\n', []],
    ['eager import a\n', []],
    ['x.lazy import a\n', []],
    ['lazy_import a\n', []],
  ];

  it.each(A_NAME)('%j is read as Python 3.11.9 reads it', (source, imports) => {
    expect(read(source)).toEqual(imports);
  });
});

describe('what is not asked of a statement', () => {
  it('is the scope it stands in, where Python refuses a star import and a lazy one', () => {
    expect(read('def f():\n    from a import *\n')).toEqual([['a', 2]]);
    expect(read('def f():\n    lazy import a\n')).toEqual([['a', 2]]);
    // An indent Python refuses at the head of a file.
    expect(read(' import a\n')).toEqual([['a', 1]]);
  });

  it('is whether a name is a keyword: async and await were names until Python 3.7', () => {
    expect(read('import pkg.async\n')).toEqual([['pkg.async', 1]]);
    expect(read('from pkg.async import task\n')).toEqual([['pkg.async', 1]]);
    expect(read('from pkg import await\n')).toEqual([['pkg', 1]]);
  });
});

describe('the line a statement is reported on', () => {
  it('is its own, where the statement before it on the logical line ran over several', () => {
    for (const ending of ['\n', CRLF]) {
      expect(read(['x = (1,', '     2); import a', 'import b', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 2], ['b', 3]]);
      expect(read(['from a import (b,', '    c); import d', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 1], ['d', 2]]);
      expect(read(['x = 1; \\', '    import a', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 2]]);
      expect(read(['if x: \\', '    import a; from b import(c)', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 2], ['b', 2]]);
      expect(read(['x = [', '  1,', ']; import a; y = (', ')', 'import b', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 3], ['b', 5]]);
    }
  });

  it('is the first line of a statement that runs over several', () => {
    for (const ending of ['\n', CRLF]) {
      expect(read(['from a import(', '    b,', '    c', ')', 'import d', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 1], ['d', 5]]);
      expect(read(['from . import (', '    a,', '    b,', ')', ''].join(ending)), JSON.stringify(ending)).toEqual([['.a', 1], ['.b', 1]]);
      expect(read(['import a, \\', '    b', ''].join(ending)), JSON.stringify(ending)).toEqual([['a', 1], ['b', 1]]);
    }
  });

  it('is at the head of that line, as an import always was', () => {
    const references = analyzeSource('x = (1,\n     2); import a\nif x:\n    import b\n', 'pkg/m.py').references;
    expect(references.map(({ specifier, line, column }) => [specifier, line, column])).toEqual([
      ['a', 2, 1],
      ['b', 4, 1],
    ]);
  });
});

describe('logicalLines', () => {
  it('says where each physical line of a statement begins, in its text and in the source', () => {
    expect(logicalLines('x = (1,\n  2); import a\nimport b\n')).toEqual([
      { text: 'x = (1,   2); import a', offset: 0, starts: [[0, 0], [8, 8]] },
      { text: 'import b', offset: 23, starts: [[0, 23]] },
    ]);
  });

  it('counts a CRLF as two characters of the source and one blank of the text', () => {
    expect(logicalLines(`x = (1,${CRLF}  2)${CRLF}y = 1 \\${CRLF}+ 2`)).toEqual([
      { text: 'x = (1,   2)', offset: 0, starts: [[0, 0], [8, 9]] },
      { text: 'y = 1   + 2', offset: 15, starts: [[0, 15], [8, 24]] },
    ]);
  });

  it('keeps nothing of a line it drops for the line after it', () => {
    expect(logicalLines('\n   \nimport a\n\nimport b')).toEqual([
      { text: 'import a', offset: 5, starts: [[0, 5]] },
      { text: 'import b', offset: 15, starts: [[0, 15]] },
    ]);
  });
});

describe('an import rule over Python', () => {
  const root = path.resolve('/virtual');
  const report = (source: string) =>
    runSpecGuard({
      root,
      patterns: ['docs/a.md'],
      io: memoryIo(root, {
        'docs/a.md': '<!-- @assert-import-absence target="src" module="forbidden" -->\n',
        'src/a.py': source,
      }),
    });

  it('fails for an import written with no blank before its parenthesis, as for one written with it', async () => {
    const spaced = await report('import os\nfrom forbidden import (thing)\n');
    expect([spaced.ok, spaced.results[0]?.actual]).toEqual([false, 1]);
    for (const source of ['import os\nfrom forbidden import(thing)\n', 'import os\nfrom forbidden import*\n', 'import os\nlazy import forbidden\n']) {
      const tight = await report(source);
      expect([tight.ok, tight.results[0]?.actual], source).toEqual([false, 1]);
      expect(tight.results[0]?.matches.map(({ file, line }) => [file, line]), source).toEqual([['src/a.py', 2]]);
    }
  });

  it('holds over a statement Python refuses, which names no module', async () => {
    for (const source of ['import os\nfrom forbidden import()\n', 'import os\nfrom forbidden importthing\n', 'import os\nimport (forbidden)\n']) {
      const refused = await report(source);
      expect([refused.ok, refused.results[0]?.actual], source).toEqual([true, 0]);
    }
  });

  it('says such a statement, and fails for it under --strict, as for every note of what could not be read', async () => {
    const io = memoryIo(root, {
      'docs/a.md': '<!-- @assert-import-absence target="src" module="forbidden" -->\n',
      'src/a.py': 'import os\nfrom forbidden import thing,\n',
    });
    const lenient = await runSpecGuard({ root, patterns: ['docs/a.md'], io });
    expect([lenient.ok, lenient.results[0]?.message, lenient.results[0]?.warnings]).toEqual([
      true,
      'expected no matches, found 0',
      ['1 module reference could not be resolved statically', '  src/a.py:2 a statement that starts as an import is one Python refuses, and no module is read from it'],
    ]);
    const strict = await runSpecGuard({ root, patterns: ['docs/a.md'], io, strictTargets: true });
    expect([strict.ok, strict.results[0]?.message]).toEqual([false, 'expected no matches, found 0; 1 reference could not be resolved']);
  });

  it('passes under --strict over statements Python reads, with nothing said', async () => {
    const io = memoryIo(root, {
      'docs/a.md': '<!-- @assert-import-absence target="src" module="forbidden" -->\n',
      'src/a.py': 'import os\nfrom allowed import(thing,)\nlazy import later\n',
    });
    const strict = await runSpecGuard({ root, patterns: ['docs/a.md'], io, strictTargets: true });
    expect([strict.ok, strict.results[0]?.warnings]).toEqual([true, []]);
  });
});
