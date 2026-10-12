/**
 * A Python file is read the same whatever ends its lines.
 *
 * On 0.24.0 a line ended at LF alone, so every line of a file with CRLF
 * endings kept its carriage return. The pattern that reads a `from` statement
 * cannot reach the end of such a line: no `from` import was read from the
 * file, and an import rule that fails over it with LF endings passed with
 * CRLF. A backslash before the carriage return continued nothing, so the
 * statement after it was read as a module called `\`. A Windows checkout with
 * `core.autocrlf` on has every Python file that way (ADR-0008, amended
 * 2026-10-12).
 *
 * Found by replaying a survivor of the mutation sweep by hand: the `$` taken
 * off that pattern read those files right, and no test read Python with CRLF.
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

/** Statements in each shape the reader knows, with what each imports and where. */
const STATEMENTS: Array<[string, string, Array<[string, number]>]> = [
  ['a from statement', 'x = 1\nfrom a import b\n', [['a', 2]]],
  ['a relative from statement that names modules', 'from . import a, b\n', [['.a', 1], ['.b', 1]]],
  ['names in parentheses over four lines', 'from . import (\n  a,\n  b,\n)\nimport c\n', [['.a', 1], ['.b', 1], ['c', 5]]],
  ['an import continued with a backslash', 'import a, \\\n  b\nimport c\n', [['a', 1], ['b', 1], ['c', 3]]],
  ['a from statement continued with a backslash', 'from a \\\n  import b\n', [['a', 1]]],
  ['two import statements', 'import a\nimport b.c as d\n', [['a', 1], ['b.c', 2]]],
  ['a last line with nothing after it', 'import a\nfrom b import c', [['a', 1], ['b', 2]]],
];

describe('a Python file with CRLF line endings', () => {
  it.each(STATEMENTS)('reads %s as it reads it with LF, on the same lines', (_name, source, imports) => {
    expect(read(source)).toEqual(imports);
    expect(read(source.replaceAll('\n', CRLF))).toEqual(imports);
  });

  it('fails the import rule that the same file fails with LF', async () => {
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
    const source = 'from forbidden import thing\nimport os\n';
    const lf = await report(source);
    const crlf = await report(source.replaceAll('\n', CRLF));
    expect([lf.ok, lf.results[0]?.actual]).toEqual([false, 1]);
    expect([crlf.ok, crlf.results[0]?.actual]).toEqual([false, 1]);
    expect(crlf.results[0]?.matches).toEqual(lf.results[0]?.matches);
  });
});

describe('a Python file whose lines end in a lone carriage return', () => {
  it('reads each line as a line, as Python does', () => {
    // Where it is reported is another matter: a line number counts LF, here as
    // in every report, so such a file is one line to it.
    const source = `import a${CR}from b import c${CR}from . import d${CR}`;
    expect(read(source).map(([specifier]) => specifier)).toEqual(['a', 'b', '.d']);
  });
});

describe('logicalLines', () => {
  it('ends a line at LF, at CRLF and at a lone CR, and keeps no carriage return', () => {
    for (const ending of ['\n', CRLF, CR]) {
      const lines = logicalLines(['import a', 'x = (1,', '  2)', 'import b'].join(ending));
      expect(lines.map((line) => line.text), JSON.stringify(ending)).toEqual(['import a', 'x = (1,   2)', 'import b']);
    }
  });

  it('counts a CRLF as one line ending: a backslash before it continues the statement', () => {
    expect(logicalLines(`import a, \\${CRLF}  b${CRLF}c`).map((line) => line.text)).toEqual(['import a,     b', 'c']);
    // Two line endings are two: the empty line between ends nothing it did not end before.
    expect(logicalLines(`a${CR}${CR}b\n${CR}c`).map((line) => line.text)).toEqual(['a', 'b', 'c']);
  });

  it('continues a statement onto the next line and no further, whatever ends the lines', () => {
    // The empty line is the one the backslash continued onto, and it ends the
    // statement: two line endings are two, and only a CRLF is one.
    for (const ending of ['\n', CRLF, CR]) {
      const lines = logicalLines(['import a, \\', '', '  b'].join(ending));
      expect(lines.map((line) => line.text.trim()), JSON.stringify(ending)).toEqual(['import a,', 'b']);
    }
  });

  it('says where each line starts in the source, past the whole of a CRLF', () => {
    const source = `import a${CRLF}import b${CRLF}`;
    expect(logicalLines(source).map((line) => [line.text, line.offset])).toEqual([
      ['import a', 0],
      ['import b', 10],
    ]);
  });
});
