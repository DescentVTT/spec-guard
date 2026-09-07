/**
 * The import analyser and the assertions built on it.
 *
 * The tokenizer tests are grouped by what a regular expression would get wrong,
 * because that is the entire justification for having a tokenizer: comments,
 * strings, template substitutions and regular expressions that contain quotes.
 * Two of the cases here (a decorator, a JSX closing tag) come from bugs that
 * only appeared when the analyser was pointed at 49 MB of real code.
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeSource, createImportIndex, resolveSpecifier, tokenize } from '../src/imports.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const specifiers = (source: string): string[] =>
  analyzeSource(source, 'src/a.ts').references.map((reference) => reference.specifier);

describe('what a regular expression gets wrong', () => {
  it('ignores an import inside a line comment', () => {
    expect(specifiers("// import { A } from './commented.js';\nconst x = 1;\n")).toEqual([]);
  });

  it('ignores an import inside a block comment', () => {
    expect(specifiers("/*\n import { A } from './commented.js';\n*/\nconst x = 1;\n")).toEqual([]);
  });

  it('ignores an import inside a string', () => {
    expect(specifiers(`const doc = "import { A } from './stringed.js'";\n`)).toEqual([]);
  });

  it('ignores an import inside a template literal', () => {
    expect(specifiers("const doc = `import { A } from './templated.js'`;\n")).toEqual([]);
  });

  it('finds a real import after a template substitution', () => {
    const source = ['const a = `x ${y + 1} z`;', "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  it('survives nested template substitutions', () => {
    const source = ['const a = `${`${inner}`} outer`;', "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  it('survives a regular expression containing quotes', () => {
    const source = ["const re = /['\"]/g;", "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  it('survives division that is not a regular expression', () => {
    const source = ['const ratio = width / height / 2;', "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  it('is not fooled by a variable named from', () => {
    expect(specifiers("export const from = './not-an-import.js';\n")).toEqual([]);
  });

  it('does not treat import.meta as a module reference', () => {
    expect(specifiers('const url = import.meta.url;\n')).toEqual([]);
  });

  it('ignores a require that is a property access', () => {
    expect(specifiers("const x = loader.require('./not-cjs.js');\n")).toEqual([]);
  });

  // Found by running over node_modules: a decorator used to produce a
  // zero-length token and hang the scanner.
  it('handles decorators without hanging', () => {
    const source = ['@Injectable()', 'export class A {}', "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  it('handles private class fields', () => {
    const source = ['class A { #secret = 1; }', "import { B } from './real.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });

  // Also from the corpus: every JSX closing tag is `</`, which was being read
  // as the start of a regular expression.
  it('does not read a JSX closing tag as a regular expression', () => {
    const source = [
      "const el = <div className='x'>text</div>;",
      "import { B } from './real.js';",
    ].join('\n');
    expect(specifiers(source)).toEqual(['./real.js']);
  });
});

describe('what counts as a dependency', () => {
  it.each([
    ["import { A } from './x.js';", './x.js', 'import', false],
    ["import A from './x.js';", './x.js', 'import', false],
    ["import * as ns from './x.js';", './x.js', 'import', false],
    ["import './x.js';", './x.js', 'import', false],
    ["import type { A } from './x.js';", './x.js', 'import', true],
    ["export * from './x.js';", './x.js', 'export', false],
    ["export { A } from './x.js';", './x.js', 'export', false],
    ["export * as ns from './x.js';", './x.js', 'export', false],
    ["export type { A } from './x.js';", './x.js', 'export', true],
    ["const a = require('./x.js');", './x.js', 'require', false],
    ["const a = await import('./x.js');", './x.js', 'dynamic-import', false],
  ] as Array<[string, string, string, boolean]>)('%s', (source, specifier, kind, typeOnly) => {
    const [reference] = analyzeSource(source, 'src/a.ts').references;

    expect(reference?.specifier).toBe(specifier);
    expect(reference?.kind).toBe(kind);
    expect(reference?.typeOnly).toBe(typeOnly);
  });

  it('treats an import of a binding named type as a value import', () => {
    const [reference] = analyzeSource("import type from './x.js';", 'src/a.ts').references;
    expect(reference?.typeOnly).toBe(false);
  });

  it('does not count a plain export', () => {
    expect(specifiers('export const a = 1;\nexport default function b() {}\n')).toEqual([]);
  });
});

describe('what it admits it cannot answer', () => {
  it('reports a dynamic import specifier', () => {
    const { references, notes } = analyzeSource('const a = await import(name);\n', 'src/a.ts');

    expect(references).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'dynamic', file: 'src/a.ts', line: 1, detail: 'import(name)' });
  });

  it('reports a dynamic require specifier', () => {
    const { notes } = analyzeSource('const a = require(name);\n', 'src/a.ts');
    expect(notes[0]).toMatchObject({ kind: 'dynamic', detail: 'require(name)' });
  });

  it('reports a computed specifier as an expression', () => {
    const { notes } = analyzeSource("const a = await import('./' + name);\n", 'src/a.ts');
    expect(notes[0]?.detail).toBe('import(expression)');
  });

  it.each([
    ['unterminated template', 'const a = `never closed;\n'],
    ['unterminated block comment', '/* never closed\n'],
    ['unterminated string', "const a = 'never closed;\n"],
  ])('reports %s as unreadable rather than as clean', (_name, source) => {
    const { notes } = analyzeSource(source, 'src/a.ts');
    expect(notes.some((note) => note.kind === 'unreadable')).toBe(true);
  });

  it('does not call a file ending in a line comment unreadable', () => {
    // A file with no trailing newline after // ends inside a comment, which is
    // entirely benign. Treating it as lost sync once put the failure rate at
    // 29% instead of 0.09%.
    const { notes } = analyzeSource("import { A } from './x.js';\n// trailing", 'src/a.ts');
    expect(notes).toEqual([]);
  });

  it('flags nothing for ordinary source', () => {
    expect(tokenize("import { A } from './x.js';\n").desynced).toBe(false);
  });
});

describe('resolveSpecifier', () => {
  it.each([
    ['./widget.js', 'src/ui/panel.ts', 'src/ui/widget.js'],
    ['../db/client.js', 'src/ui/panel.ts', 'src/db/client.js'],
    ['../../shared.js', 'src/ui/deep/panel.ts', 'src/shared.js'],
    ['react', 'src/ui/panel.ts', 'react'],
    ['@scope/pkg', 'src/ui/panel.ts', '@scope/pkg'],
    ['node:fs', 'src/ui/panel.ts', 'node:fs'],
  ])('%s from %s -> %s', (specifier, file, expected) => {
    expect(resolveSpecifier(specifier, file)).toBe(expected);
  });
});

describe('the import index', () => {
  it('reads and analyses each file exactly once', async () => {
    const root = await repo({ 'src/a.ts': "import { A } from './b.js';\n" });
    const index = createImportIndex();
    const absolute = path.join(root, 'src/a.ts');

    const [first, second] = await Promise.all([
      index.analyze(absolute, 'src/a.ts'),
      index.analyze(absolute, 'src/a.ts'),
    ]);

    expect(first).toBe(second);
    expect(index.size).toBe(1);
  });

  it('turns an unreadable file into a note rather than a throw', async () => {
    const index = createImportIndex();
    const result = await index.analyze(path.join('does', 'not', 'exist.ts'), 'does/not/exist.ts');

    expect(result.references).toEqual([]);
    expect(result.notes[0]?.kind).toBe('unreadable');
  });
});

describe('@assert-import-absence', () => {
  async function layered(spec: string): Promise<string> {
    return repo({
      'docs/adr.md': spec,
      'src/ui/panel.ts': "import { Client } from '../db/client.js';\nexport const a = 1;\n",
      'src/ui/list.ts': "import type { Row } from '../db/client.js';\nexport const b = 1;\n",
      'src/ui/barrel.ts': "export * from '../db/client.js';\n",
      'src/ui/clean.ts': "import { helper } from './helper.js';\n",
      'src/ui/helper.ts': 'export const helper = 1;\n',
      'src/db/client.ts': 'export class Client {}\n',
    });
  }

  it('counts value imports, type imports and re-exports alike', async () => {
    const root = await layered('<!-- @assert-import-absence target="src/ui" module="src/db" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.actual).toBe(3);
    expect(report.results[0]?.matches.map((match) => match.file).sort()).toEqual([
      'src/ui/barrel.ts',
      'src/ui/list.ts',
      'src/ui/panel.ts',
    ]);
  });

  it('drops type-only dependencies when asked', async () => {
    const root = await layered('<!-- @assert-import-absence target="src/ui" module="src/db" types="ignore" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results[0]?.actual).toBe(2);
  });

  it('passes when the dependency is genuinely absent', async () => {
    const root = await layered(
      '<!-- @assert-import-absence target="src/ui" module="src/db" exclude="src/ui/panel.ts src/ui/list.ts src/ui/barrel.ts" -->\n',
    );
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.actual).toBe(0);
  });

  it('describes the rule in the assertion, exclusions included', async () => {
    const root = await layered(
      '<!-- @assert-import-absence target="src/ui" module="src/db" exclude="src/ui/barrel.ts" -->\n',
    );
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results[0]?.description).toBe(
      'src/ui must not import "src/db" (excluding src/ui/barrel.ts)',
    );
  });

  it('reports a dynamic import in scope but still answers', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/loader.ts': 'const mod = await import(name);\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.actual).toBe(0);
    expect(report.results[0]?.warnings.join('\n')).toContain('could not be resolved statically');
    expect(report.results[0]?.warnings.join('\n')).toContain('src/loader.ts:1 import(name)');
  });

  it('turns that warning into a failure under strict', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/loader.ts': 'const mod = await import(name);\n',
    });

    const report = await runSpecGuard({
      patterns: ['docs/adr.md'],
      root,
      engine: 'javascript',
      strictTargets: true,
    });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('could not be resolved');
  });

  it('says how many files it could not analyse', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/script.py': 'import os\n',
      'src/notes.txt': 'text\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results[0]?.warnings.join('\n')).toContain(
      'analysed 1 of 3 files; 2 are not JavaScript or TypeScript',
    );
  });
});

describe('@assert-import-count', () => {
  async function counted(spec: string): Promise<string> {
    return repo({
      'docs/adr.md': spec,
      'src/a.ts': "import axios from 'axios';\n",
      'src/b.ts': "import axios from 'axios';\n",
      'src/c.ts': 'export const c = 1;\n',
    });
  }

  it('counts the files that depend on a package', async () => {
    const root = await counted('<!-- @assert-import-count target="src" module="axios" expected="2" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.actual).toBe(2);
  });

  it('fails with the observed count when the bound is wrong', async () => {
    const root = await counted('<!-- @assert-import-count target="src" module="axios" max="1" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toBe('expected at most 1 match, found 2');
  });

  it('rejects a bad types value rather than guessing', async () => {
    const root = await counted('<!-- @assert-import-count target="src" module="axios" min="1" types="maybe" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.errors[0]?.message).toContain('must be include or ignore');
  });

  it('requires a module attribute', async () => {
    const root = await counted('<!-- @assert-import-count target="src" min="1" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.errors[0]?.message).toContain('requires a non-empty module');
  });
});

/**
 * Positions, which the first round of tests ignored entirely.
 *
 * Every assertion above checks *which* specifier was found and none check
 * *where*, so every mutant that only corrupts line tracking survived. Those
 * numbers are what a failure report points the reader at, so a wrong line is a
 * real defect, not a cosmetic one.
 */
describe('line and column tracking', () => {
  const firstReference = (source: string) => analyzeSource(source, 'src/a.ts').references[0];

  it('reports the line of a plain import', () => {
    const source = ['const a = 1;', 'const b = 2;', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)).toMatchObject({ line: 3, column: 1 });
  });

  it('reports the column of an indented import', () => {
    const source = ['if (x) {', "  import('./c.js');", '}'].join('\n');
    expect(firstReference(source)).toMatchObject({ line: 2, column: 3 });
  });

  it('counts the lines a block comment spans', () => {
    const source = ['/*', ' one', ' two', ' three', '*/', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)?.line).toBe(6);
  });

  it('counts the lines a template literal spans', () => {
    const source = ['const t = `', 'one', 'two', '`;', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)?.line).toBe(5);
  });

  it('counts the lines a template with substitutions spans', () => {
    const source = ['const t = `', '${value}', 'tail', '`;', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)?.line).toBe(5);
  });

  it('counts lines through nested template substitutions', () => {
    const source = ['const t = `a ${`b', '${inner}', 'c`} d`;', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)?.line).toBe(4);
  });

  it('counts lines through line comments', () => {
    const source = ['// one', '// two', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)?.line).toBe(3);
  });

  it('reports the line of a dynamic note', () => {
    const source = ['const a = 1;', '', 'const b = await import(name);'].join('\n');
    const { notes } = analyzeSource(source, 'src/a.ts');
    expect(notes[0]).toMatchObject({ line: 3, column: 17 });
  });

  it('keeps positions right after a regular expression', () => {
    const source = ['const re = /a\/b/g;', "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)).toMatchObject({ line: 2, column: 1 });
  });

  it('keeps positions right after an escaped quote in a string', () => {
    // The analysed source is:  const s = 'it\'s';
    const source = [String.raw`const s = 'it\'s';`, "import { C } from './c.js';"].join('\n');
    expect(firstReference(source)).toMatchObject({ line: 2, column: 1 });
  });
});

describe('template substitution shapes', () => {
  it('reads code inside a substitution as code', () => {
    // The import here is real: it sits inside ${...}, which is code.
    const source = 'const t = `${await import("./inside.js")}`;';
    expect(specifiers(source)).toEqual(['./inside.js']);
  });

  it('does not read the literal part of a template as code', () => {
    expect(specifiers('const t = `import { A } from "./fake.js"`;')).toEqual([]);
  });

  it('handles a brace inside a substitution', () => {
    const source = ['const t = `${ {a: 1}.a }`;', "import { C } from './c.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./c.js']);
  });

  it('handles a template immediately followed by another', () => {
    const source = ['const a = `x`; const b = `y`;', "import { C } from './c.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./c.js']);
  });

  it('handles a substitution containing a string with a brace', () => {
    const source = ['const t = `${ f("}") }`;', "import { C } from './c.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./c.js']);
  });
});

describe('extraction guards', () => {
  it('keeps scanning after import.meta', () => {
    const source = ['const u = import.meta.url;', "import { C } from './c.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./c.js']);
  });

  it('stops looking for from at a semicolon', () => {
    // Two statements: the export has no specifier and must not borrow the next.
    const source = ["export const a = 1; const b = from; const c = './not-mine.js';"].join('\n');
    expect(specifiers(source)).toEqual([]);
  });

  it('ignores require that is not a call', () => {
    expect(specifiers("const r = require;\nconst s = 'x';\n")).toEqual([]);
  });

  it('accepts a require with a trailing comma argument', () => {
    expect(specifiers("const r = require('./c.js',);\n")).toEqual(['./c.js']);
  });

  it('does not treat a word ending in import as an import', () => {
    expect(specifiers("const reimport = './x.js';\nconst y = 1;\n")).toEqual([]);
  });

  it('finds an import that follows a class body', () => {
    const source = ['class A { m() { return 1; } }', "import { C } from './c.js';"].join('\n');
    expect(specifiers(source)).toEqual(['./c.js']);
  });
});

describe('how an import rule reads', () => {
  async function describeRule(attributes: string): Promise<string> {
    const root = await repo({
      'docs/adr.md': `<!-- @assert-import-absence target="src" module="x" ${attributes} -->\n`,
      'src/a.ts': 'export const a = 1;\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    return report.results[0]?.description ?? report.errors[0]?.message ?? '';
  }

  it.each([
    ['', 'src must not import "x"'],
    ['expected="0"', 'src must not import "x"'],
    // On an absence directive `expected` is an upper bound, exactly as it is on
    // @assert-absence - it is not an exact count there either.
    ['expected="1"', 'src must import from at most 1 file "x"'],
    ['expected="2"', 'src must import from at most 2 files "x"'],
    ['max="1"', 'src must import from at most 1 file "x"'],
    ['max="3"', 'src must import from at most 3 files "x"'],
  ])('%s reads as %s', async (attributes, expected) => {
    expect(await describeRule(attributes)).toBe(expected);
  });

  it.each([
    ['min="1"', 'src must import from at least 1 file "x"'],
    ['min="2"', 'src must import from at least 2 files "x"'],
    ['min="1" max="3"', 'src must import from between 1 and 3 files "x"'],
    ['min="2" max="2"', 'src must import from exactly 2 files "x"'],
  ])('%s reads as %s on a count assertion', async (attributes, expected) => {
    const root = await repo({
      'docs/adr.md': `<!-- @assert-import-count target="src" module="x" ${attributes} -->\n`,
      'src/a.ts': 'export const a = 1;\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    expect(report.results[0]?.description).toBe(expected);
  });
});

describe('what a violation shows', () => {
  it('labels an import and a re-export differently', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/imports.ts': "import { C } from './db/client.js';\n",
      'src/reexports.ts': "export * from './db/client.js';\n",
      'src/db/client.ts': 'export class C {}\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    const shown = report.results[0]?.matches.map((match) => `${match.file} ${match.text}`).sort();

    expect(shown).toEqual([
      'src/imports.ts import ./db/client.js',
      'src/reexports.ts export ./db/client.js',
    ]);
  });

  it('points at the line the dependency is on', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/a.ts': ['// one', '// two', "import { C } from './db/client.js';"].join('\n'),
      'src/db/client.ts': 'export class C {}\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results[0]?.matches[0]).toMatchObject({ file: 'src/a.ts', line: 3, column: 1 });
  });

  it('counts a file once even when it depends on the module twice', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="src" module="src/db" -->\n',
      'src/a.ts': ["import { C } from './db/client.js';", "export * from './db/client.js';"].join('\n'),
      'src/db/client.ts': 'export class C {}\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results[0]?.actual).toBe(1);
  });
});

/**
 * Cases aimed at specific guards in the extractor, each written after checking
 * which mutant it would kill. The point of naming them this precisely is that a
 * guard nobody can construct a failing input for is dead weight, and should be
 * deleted rather than covered.
 */
describe('extractor guards, precisely', () => {
  it('does not let a plain export borrow the next statement specifier', () => {
    // Without the semicolon break the export scans on, finds `from`, and claims
    // ./b.js as a re-export. The count is unchanged; only the kind gives it away.
    const source = "export const a = 1; import b from './b.js';";
    const [reference] = analyzeSource(source, 'src/a.ts').references;

    expect(reference?.specifier).toBe('./b.js');
    expect(reference?.kind).toBe('import');
  });

  it('treats a default type import as type-only', () => {
    // `import type A from 'x'` imports a default *type*, unlike
    // `import type from 'x'` which imports a value binding named type.
    const [reference] = analyzeSource("import type A from './x.js';", 'src/a.ts').references;

    expect(reference?.typeOnly).toBe(true);
    expect(reference?.kind).toBe('import');
  });

  it('does not mistake a statement import for a call', () => {
    // If the call branch is entered for `import {`, the statement is skipped and
    // a spurious "cannot resolve" note is produced instead.
    const { references, notes } = analyzeSource("import { A } from './x.js';", 'src/a.ts');

    expect(references).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it('produces no notes for a file of ordinary imports', () => {
    const source = [
      "import a from './a.js';",
      "import { b } from './b.js';",
      "export * from './c.js';",
      "const d = require('./d.js');",
    ].join('\n');
    const { references, notes } = analyzeSource(source, 'src/a.ts');

    expect(references).toHaveLength(4);
    expect(notes).toEqual([]);
  });

  it('keeps the specifier attached to the right statement kind', () => {
    const source = ["export { a } from './a.js';", "import { b } from './b.js';"].join('\n');
    const kinds = analyzeSource(source, 'src/a.ts').references.map((reference) => reference.kind);

    expect(kinds).toEqual(['export', 'import']);
  });
});
