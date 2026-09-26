/**
 * `spec-guard impact`: who depends on a path, and the rules in play. ADR-0018.
 *
 * Over one tree in five languages: which references become edges, by the
 * resolution table ADR-0011 wrote for JavaScript and TypeScript and by path
 * arithmetic for a relative Python import; which are listed as unresolved;
 * which are counted as naming a module, and not followed. Then the walk back
 * from a path - depth, the import each step takes, cycles, a depth limit -
 * and the rules a query would show for each file reached.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, HELP, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import {
  buildReverseGraph,
  dependentsOf,
  formatImpact,
  formatImpactJson,
  impactOf,
  resolvePython,
  ImpactError,
  type ImpactOptions,
  type ImpactReport,
} from '../src/impact.js';
import { DEMO_REPO, FIXTURES_DIR, makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

const ROOT = path.resolve('/virtual/impact');

const TREE: Record<string, string> = {
  'docs/adr/0001-layers.md': [
    '# ADR-0001: Layers',
    '',
    '<!-- @assert-layers target="src" order="src/db, src/app, src/ui" reason="dependencies point down" -->',
    '<!-- @assert-absence target="src/ui" symbol="pg" -->',
    '<!-- @assert-import-cycle target="src" -->',
    '',
  ].join('\n'),
  'docs/adr/0002-draft.md': '# ADR-0002: Draft\n\n**Status:** proposed\n\n<!-- @assert-absence target="src/app" symbol="Date.now" -->\n',
  'docs/adr/0003-python.md': '# ADR-0003: Python\n\n<!-- @assert-import-absence target="py" module="requests" -->\n',
  // JavaScript and TypeScript, by ADR-0011's table.
  'src/db/client.ts': "export const client = 1;\n",
  'src/db/index.ts': "export * from './client.js';\n",
  'src/app/service.ts': "import { client } from '../db/index.js';\nimport type { T } from '../db/client';\nexport const service = client;\n",
  'src/app/cache.ts': "import { service } from './service.js';\nimport { ui } from '../ui/view.js';\nexport const cache = service;\n",
  'src/ui/view.tsx': "import { cache } from '../app/cache.js';\nimport '../app/styles.css';\nimport { gone } from './gone.js';\nimport { alias } from '@/db';\nimport react from 'react';\nexport const ui = cache;\nexport const lazy = (name: string) => import(name);\n",
  'src/app/styles.css': '.a {}\n',
  'src/ui/button.js': "const view = require('./view.tsx');\n",
  // Python: relative imports are followed, absolute ones counted.
  'py/pkg/__init__.py': 'VERSION = 1\n',
  'py/pkg/db.py': 'import requests\n',
  'py/pkg/api.py': 'from .db import connect\nfrom . import VERSION\nimport os\n',
  'py/pkg/sub/__init__.py': '',
  'py/pkg/sub/handlers.py': 'from ..api import route\nfrom .. import db\nfrom .missing import x\n',
  // Go, Rust and C#: every reference names a module.
  'go/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/db"\n)\n',
  'rs/src/lib.rs': 'use crate::db::pool;\nuse std::io;\n',
  'rs/src/db.rs': 'pub fn pool() {}\n',
  'cs/App.cs': 'using System;\nusing Shop.Domain;\n',
  // Out of scope.
  'node_modules/lib/index.js': "require('../../src/db/client.ts');\n",
  'build/out.js': "import '../src/db/client.js';\n",
  'README.txt': 'nothing\n',
};

async function impact(paths: string[], options: Partial<ImpactOptions> = {}, files: Record<string, string> = TREE): Promise<ImpactReport> {
  return impactOf({ patterns: ['docs/**/*.md'], root: ROOT, paths, exclude: ['build'], io: memoryIo(ROOT, files), ...options });
}

/** Each dependent as `depth file <- imports`. */
const dependents = (report: ImpactReport, index = 0): string[] =>
  (report.results[index]?.dependents ?? []).map((dependent) => `${dependent.depth} ${dependent.file} <- ${dependent.via.imports}:${dependent.via.line}`);

/* -------------------------------------------------------------------- graph */

describe('the graph, read backwards', () => {
  it('holds an edge for each relative import that names a file, by the resolution table, and none for anything else', async () => {
    const graph = await buildReverseGraph({ root: ROOT, exclude: ['build'], defaultSkips: true, io: memoryIo(ROOT, TREE) });
    const importers = Object.fromEntries(
      [...graph.importers].map(([target, edges]) => [target, edges.map(({ from, reference }) => `${from}:${reference.line} ${reference.specifier}`)]),
    );
    expect(importers).toEqual({
      'src/db/client.ts': ['src/app/service.ts:2 ../db/client', 'src/db/index.ts:1 ./client.js'],
      'src/db/index.ts': ['src/app/service.ts:1 ../db/index.js'],
      'src/app/service.ts': ['src/app/cache.ts:1 ./service.js'],
      'src/ui/view.tsx': ['src/app/cache.ts:2 ../ui/view.js', 'src/ui/button.js:1 ./view.tsx'],
      'src/app/cache.ts': ['src/ui/view.tsx:1 ../app/cache.js'],
      'py/pkg/db.py': ['py/pkg/api.py:1 .db', 'py/pkg/sub/handlers.py:2 ..db'],
      'py/pkg/__init__.py': ['py/pkg/api.py:2 .VERSION'],
      'py/pkg/api.py': ['py/pkg/sub/handlers.py:1 ..api'],
      'py/pkg/sub/__init__.py': ['py/pkg/sub/handlers.py:3 .missing'],
    });
    expect(graph.unresolved).toEqual([
      { file: 'src/ui/view.tsx', line: 3, specifier: './gone.js', reason: 'unresolved' },
      { file: 'src/ui/view.tsx', line: 4, specifier: '@/db', reason: 'unresolved' },
      { file: 'src/ui/view.tsx', line: 7, specifier: 'import(name)', reason: 'dynamic' },
    ]);
    expect(Object.fromEntries(graph.unfollowed)).toEqual({ 'absolute Python import': 2, 'Go import': 2, 'Rust use': 2, 'C# using': 2 });
    expect(graph.nodes.has('rs/src/lib.rs')).toBe(false);
    expect(graph.nodes.has('py/pkg/api.py')).toBe(true);
    expect(graph.files).not.toContain('build/out.js');
    expect(graph.files).not.toContain('node_modules/lib/index.js');
    expect(graph.gaps).toEqual([]);
  });

  it('reads node_modules too without the default skips, and names a file whose imports could not be read', async () => {
    const graph = await buildReverseGraph({
      root: ROOT,
      exclude: [],
      defaultSkips: false,
      io: memoryIo(ROOT, { 'a.ts': 'export {};\n', 'node_modules/x/i.js': "require('../../a.ts');\n", 'lost.ts': 'const s = `never closed' }),
    });
    expect(graph.importers.get('a.ts')?.map(({ from }) => from)).toEqual(['node_modules/x/i.js']);
    expect(graph.gaps.map(({ file }) => file)).toEqual(['lost.ts']);
  });

  it('keeps a file that imports itself out of its own dependents', async () => {
    const graph = await buildReverseGraph({ root: ROOT, exclude: [], defaultSkips: true, io: memoryIo(ROOT, { 'a.ts': "import './a.js';\n" }) });
    expect(graph.importers.size).toBe(0);
  });
});

describe('a relative Python import', () => {
  const files = new Set(['app/__init__.py', 'app/db.py', 'app/api/__init__.py', 'app/types.pyi', '__init__.py', 'top.py', 'app/sub/x.py', 'stubs/__init__.pyi', 'stubs/pkg/__init__.pyi']);

  it('names the module beside it, a package, a stub, or else the package the name comes from', () => {
    expect(resolvePython('.db', 'app/api.py', files)).toBe('app/db.py');
    expect(resolvePython('.api', 'app/x.py', files)).toBe('app/api/__init__.py');
    expect(resolvePython('.types', 'app/x.py', files)).toBe('app/types.pyi');
    expect(resolvePython('.NAME', 'app/x.py', files)).toBe('app/__init__.py');
    expect(resolvePython('..db', 'app/sub/x.py', files)).toBe('app/db.py');
    expect(resolvePython('..top', 'app/x.py', files)).toBe('top.py');
    expect(resolvePython('..NAME', 'app/x.py', files)).toBe('__init__.py');
    expect(resolvePython('.pkg', 'stubs/x.py', files)).toBe('stubs/pkg/__init__.pyi');
    expect(resolvePython('.NAME', 'stubs/x.py', files)).toBe('stubs/__init__.pyi');
  });

  it('names nothing when neither the module nor the package is a file the walk found', () => {
    expect(resolvePython('.db', 'lib/x.py', files)).toBeNull();
    expect(resolvePython('...db', 'app/x.py', files)).toBeNull();
    // One dot names the root's own package; two would climb out of it.
    expect(resolvePython('.top', 'x.py', files)).toBe('top.py');
    expect(resolvePython('..top', 'x.py', files)).toBeNull();
  });
});

describe('the walk back from a path', () => {
  const importers = new Map([
    ['a', [{ from: 'b', reference: { specifier: './a', kind: 'import' as const, typeOnly: false, line: 1, column: 1 } }]],
    [
      'b',
      [
        { from: 'd', reference: { specifier: './b', kind: 'import' as const, typeOnly: false, line: 4, column: 1 } },
        { from: 'c', reference: { specifier: './b', kind: 'import' as const, typeOnly: false, line: 2, column: 1 } },
      ],
    ],
    ['c', [{ from: 'a', reference: { specifier: './c', kind: 'import' as const, typeOnly: false, line: 3, column: 1 } }]],
    ['d', [{ from: 'e', reference: { specifier: './d', kind: 'import' as const, typeOnly: false, line: 5, column: 1 } }]],
  ]);

  it('gives each file its shortest distance and the import one step closer, once, through a cycle', () => {
    expect(dependentsOf({ importers }, ['a'])).toEqual([
      { file: 'b', depth: 1, via: { imports: 'a', line: 1, specifier: './a' } },
      { file: 'c', depth: 2, via: { imports: 'b', line: 2, specifier: './b' } },
      { file: 'd', depth: 2, via: { imports: 'b', line: 4, specifier: './b' } },
      { file: 'e', depth: 3, via: { imports: 'd', line: 5, specifier: './d' } },
    ]);
  });

  it('stops at the depth asked for', () => {
    expect(dependentsOf({ importers }, ['a'], 1).map(({ file }) => file)).toEqual(['b']);
    expect(dependentsOf({ importers }, ['a'], 2).map(({ file }) => file)).toEqual(['b', 'c', 'd']);
  });

  it('leaves the starting files out, and takes the first import in path order and then line order', () => {
    expect(dependentsOf({ importers }, ['b', 'a']).map(({ file, depth }) => `${depth}${file}`)).toEqual(['1c', '1d', '2e']);
    const twice = new Map([
      [
        'x',
        [
          { from: 'y', reference: { specifier: './x', kind: 'import' as const, typeOnly: false, line: 9, column: 1 } },
          { from: 'y', reference: { specifier: './x.js', kind: 'import' as const, typeOnly: false, line: 3, column: 1 } },
        ],
      ],
    ]);
    expect(dependentsOf({ importers: twice }, ['x'])).toEqual([{ file: 'y', depth: 1, via: { imports: 'x', line: 3, specifier: './x.js' } }]);
    expect(dependentsOf({ importers: new Map() }, ['x'])).toEqual([]);
  });

  it('walks each step in path order, so a file reached from two is reached through the first of them by path', () => {
    const edge = (from: string, line: number) => ({ from, reference: { specifier: 'x', kind: 'import' as const, typeOnly: false, line, column: 1 } });
    // t1 is imported by z and t2 by a, so the next step is found as z, a; m
    // imports both, and is reached through a, which comes first by path.
    const graph = new Map([
      ['t1', [edge('z', 1)]],
      ['t2', [edge('a', 1)]],
      ['z', [edge('m', 5)]],
      ['a', [edge('m', 9)]],
    ]);
    expect(dependentsOf({ importers: graph }, ['t1', 't2'])).toEqual([
      { file: 'a', depth: 1, via: { imports: 't2', line: 1, specifier: 'x' } },
      { file: 'z', depth: 1, via: { imports: 't1', line: 1, specifier: 'x' } },
      { file: 'm', depth: 2, via: { imports: 'a', line: 9, specifier: 'x' } },
    ]);
  });
});

/* ------------------------------------------------------------------- report */

describe('the answer for a path', () => {
  it('is every file that depends on it, at its depth, through type-only imports and re-exports, and across a cycle', async () => {
    const report = await impact(['src/db/client.ts']);
    expect(dependents(report)).toEqual([
      '1 src/app/service.ts <- src/db/client.ts:2',
      '1 src/db/index.ts <- src/db/client.ts:1',
      '2 src/app/cache.ts <- src/app/service.ts:1',
      '3 src/ui/view.tsx <- src/app/cache.ts:1',
      '4 src/ui/button.js <- src/ui/view.tsx:1',
    ]);
    expect(report.results[0]).toMatchObject({ path: 'src/db/client.ts', shape: 'file', files: ['src/db/client.ts'] });
    expect(report.results[0]).not.toHaveProperty('note');
    expect(report.depth).toBeNull();
    expect(report.scanned).toBe(Object.keys(TREE).length - 2);
  });

  it('for a directory, is what depends on any file under it from outside it', async () => {
    const report = await impact(['src/db', 'src/app/']);
    expect(report.results.map(({ path: asked, shape, files }) => [asked, shape, files])).toEqual([
      ['src/db', 'directory', ['src/db/client.ts', 'src/db/index.ts']],
      ['src/app', 'directory', ['src/app/cache.ts', 'src/app/service.ts']],
    ]);
    expect(dependents(report, 0)).toEqual([
      '1 src/app/service.ts <- src/db/client.ts:2',
      '2 src/app/cache.ts <- src/app/service.ts:1',
      '3 src/ui/view.tsx <- src/app/cache.ts:1',
      '4 src/ui/button.js <- src/ui/view.tsx:1',
    ]);
    expect(dependents(report, 1)).toEqual(['1 src/ui/view.tsx <- src/app/cache.ts:1', '2 src/ui/button.js <- src/ui/view.tsx:1']);
    // A file both paths reach is governed once.
    expect(report.rules.find((rule) => rule.kind === 'assert-absence')?.governs).toEqual(['src/ui/view.tsx', 'src/ui/button.js']);
  });

  it('counts what it does not follow most first', async () => {
    const report = await impact(['src/db/client.ts'], {}, { ...TREE, 'rs/src/more.rs': 'use a::b;\nuse c::d;\n' });
    expect(report.unfollowed.map(({ kind, references }) => [kind, references])).toEqual([
      ['Rust use', 4],
      ['C# using', 2],
      ['Go import', 2],
      ['absolute Python import', 2],
    ]);
  });

  it('follows relative Python imports, and counts the absolute ones', async () => {
    const report = await impact(['py/pkg/db.py']);
    expect(dependents(report)).toEqual(['1 py/pkg/api.py <- py/pkg/db.py:1', '1 py/pkg/sub/handlers.py <- py/pkg/db.py:2']);
    expect(report.unfollowed).toEqual([
      { kind: 'C# using', references: 2 },
      { kind: 'Go import', references: 2 },
      { kind: 'Rust use', references: 2 },
      { kind: 'absolute Python import', references: 2 },
    ]);
  });

  it('stops at --depth', async () => {
    const report = await impact(['src/db/client.ts'], { depth: 2 });
    expect(dependents(report)).toEqual([
      '1 src/app/service.ts <- src/db/client.ts:2',
      '1 src/db/index.ts <- src/db/client.ts:1',
      '2 src/app/cache.ts <- src/app/service.ts:1',
    ]);
    expect(report.depth).toBe(2);
  });

  it('says why no dependent can be shown: a language imported by module name, a file out of scope, no code, or none under a directory', async () => {
    const report = await impact(['rs/src/db.rs', 'go/main.go', 'cs/App.cs', 'README.txt', 'build/out.js', 'go', 'src/app/styles.css'], {}, { ...TREE, 'py/skip/x.py': '' });
    expect(report.results.map(({ path: asked, note, dependents: found }) => [asked, note, found.length])).toEqual([
      ['rs/src/db.rs', 'a Rust file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)', 0],
      ['go/main.go', 'a Go file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)', 0],
      ['cs/App.cs', 'a C# file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)', 0],
      ['README.txt', 'it is not JavaScript, TypeScript or Python, so no import names it as a file', 0],
      ['build/out.js', "it is not in scope: the project's exclude, or a directory the walk skips, leaves it out", 0],
      ['go', 'no JavaScript, TypeScript or Python file under it is in scope', 0],
      ['src/app/styles.css', 'it is not JavaScript, TypeScript or Python, so no import names it as a file', 0],
    ]);
    const python = await impact(['py/skip/x.py'], { exclude: ['py/skip'] }, { ...TREE, 'py/skip/x.py': '' });
    expect(python.results[0]?.note).toBe("it is not in scope: the project's exclude, or a directory the walk skips, leaves it out");
  });

  it('lists what could not be resolved, in path and line order, since any of it may depend on the path', async () => {
    const report = await impact(['src/db/client.ts'], {}, { ...TREE, 'src/a.ts': "import x from '#internal/db';\n" });
    expect(report.unresolved.map(({ file, line, specifier }) => `${file}:${line} ${specifier}`)).toEqual([
      'src/a.ts:1 #internal/db',
      'src/ui/view.tsx:3 ./gone.js',
      'src/ui/view.tsx:4 @/db',
      'src/ui/view.tsx:7 import(name)',
    ]);
  });

  it('refuses a path that is not there, or is outside the root', async () => {
    await expect(impact(['src/new.ts'])).rejects.toThrow(new ImpactError('"src/new.ts" does not exist, so nothing depends on it yet'));
    await expect(impact(['../x.ts'])).rejects.toThrow('is outside the root');
  });
});

describe('the rules in play', () => {
  it('are those in force that govern the path or a dependent, each with the files it governs, and the rest are counted', async () => {
    const report = await impact(['src/db/client.ts']);
    expect(report.rules.map((rule) => [rule.document, rule.line, rule.kind, rule.governs])).toEqual([
      ['docs/adr/0001-layers.md', 3, 'assert-layers', ['src/db/client.ts', 'src/app/service.ts', 'src/db/index.ts', 'src/app/cache.ts', 'src/ui/view.tsx', 'src/ui/button.js']],
      ['docs/adr/0001-layers.md', 4, 'assert-absence', ['src/ui/view.tsx', 'src/ui/button.js']],
      ['docs/adr/0001-layers.md', 5, 'assert-import-cycle', ['src/db/client.ts', 'src/app/service.ts', 'src/db/index.ts', 'src/app/cache.ts', 'src/ui/view.tsx', 'src/ui/button.js']],
    ]);
    expect(report.withheld).toEqual({ rules: 1, documents: ['docs/adr/0002-draft.md'] });
    expect(report.documents.map((document) => document.file)).toEqual(['docs/adr/0001-layers.md', 'docs/adr/0002-draft.md']);
    const inactive = await impact(['src/db/client.ts'], { includeInactive: true });
    expect(inactive.rules.map((rule) => [rule.line, rule.inForce])).toEqual([
      [3, true],
      [4, true],
      [5, true],
      [5, false],
    ]);
    expect(inactive.withheld).toEqual({ rules: 1, documents: ['docs/adr/0002-draft.md'] });
  });

  it('govern a directory asked about as a query would, and none when no spec matched', async () => {
    const report = await impact(['py']);
    expect(report.rules.map((rule) => [rule.kind, rule.governs])).toEqual([['assert-import-absence', ['py']]]);
    const none = await impact(['py'], { patterns: ['nowhere/*.md'] });
    expect([none.specFiles, none.rules, none.withheld, none.documents]).toEqual([[], [], { rules: 0, documents: [] }, []]);
  });

  it('lists the rules of documents not in force, when asked, and says whose they are', async () => {
    const report = await impact(['src/app/cache.ts'], { includeInactive: true, depth: 1 });
    expect(formatImpact(report)).toContain(
      '\n  ADR-0002: Draft  (docs/adr/0002-draft.md, proposed - not in force)\n    :5 @assert-absence  "Date.now" must not appear in src/app\n      governs: src/app/cache.ts\n',
    );
    const two = await impact(['src/app/cache.ts'], { depth: 1 }, { ...TREE, 'docs/adr/0004-old.md': '**Status:** superseded\n\n<!-- @assert-absence target="src" symbol="x" -->\n' });
    expect(formatImpact(two)).toContain(
      '\n  2 more rules would govern them if docs/adr/0002-draft.md, docs/adr/0004-old.md were in force; --ignore-status lists them\n',
    );
  });

  it('reports the directives that could not be read', async () => {
    const report = await impact(['src/db'], {}, { ...TREE, 'docs/bad.md': '<!-- @assert-count symbol="X" -->\n' });
    expect(report.errors).toEqual([{ file: 'docs/bad.md', line: 1, message: '@assert-count requires expected="...", min="..." or max="...".' }]);
  });
});

describe('the report', () => {
  it('reads, for a person, each path, its dependents, the rules, and what could not be followed', async () => {
    const report = await impact(['src/db/client.ts', 'rs/src/db.rs'], { depth: 3 });
    expect(formatImpact({ ...report, durationMs: 4.2 })).toBe(
      [
        'src/db/client.ts',
        '  4 files depend on it, 2 directly, up to 3 imports away',
        '    1  src/app/service.ts  imports src/db/client.ts (line 2)',
        '    1  src/db/index.ts     imports src/db/client.ts (line 1)',
        '    2  src/app/cache.ts    imports src/app/service.ts (line 1)',
        '    3  src/ui/view.tsx     imports src/app/cache.ts (line 1)',
        '',
        'rs/src/db.rs',
        '  no dependents shown: a Rust file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)',
        '',
        'only dependents up to 3 imports away are shown (--depth 3)',
        '',
        '3 rules govern these files, from 1 document',
        '',
        '  ADR-0001: Layers  (docs/adr/0001-layers.md)',
        '    :3 @assert-layers  src must keep its layers in order, src/db < src/app < src/ui',
        '      governs: src/db/client.ts, src/app/service.ts, src/db/index.ts, src/app/cache.ts, src/ui/view.tsx',
        '      reason: dependencies point down',
        '    :4 @assert-absence  "pg" must not appear in src/ui',
        '      governs: src/ui/view.tsx',
        '    :5 @assert-import-cycle  src must have no import cycles',
        '      governs: src/db/client.ts, src/app/service.ts, src/db/index.ts, src/app/cache.ts, src/ui/view.tsx',
        '',
        '  1 more rule would govern them if docs/adr/0002-draft.md were in force; --ignore-status lists it',
        '',
        'not followed: 2 C# usings, 2 Go imports, 2 Rust uses, 2 absolute Python imports name modules rather than files, so a file that depends on these paths through one is not shown (ADR-0018)',
        '',
        '3 imports could not be resolved, and may depend on these paths:',
        '  src/ui/view.tsx:3  ./gone.js (names no file)',
        '  src/ui/view.tsx:4  @/db (names no file)',
        '  src/ui/view.tsx:7  import(name)',
        '',
        'exclude from the command line: build',
        '',
        `${Object.keys(TREE).length - 2} files and 3 spec files read in 4.2ms`,
      ].join('\n'),
    );
  });

  it('says so when nothing imports a path, no rule governs, or no spec matched, and lists at most ten unresolved imports', async () => {
    const lonely = await impact(['src/ui/button.js'], { patterns: ['docs/adr/0003-python.md'] });
    const text = formatImpact({ ...lonely, durationMs: 1 });
    expect(text).toContain('src/ui/button.js\n  nothing in scope imports it\n');
    expect(text).toContain('\nno rules in force govern these files\n');
    expect(formatImpact({ ...lonely, specFiles: [], durationMs: 1 })).toContain('\nno spec files matched, so no rules are shown\n');
    const many = { ...lonely, unresolved: Array.from({ length: 12 }, (_, line) => ({ file: 'a.ts', line: line + 1, specifier: '@/x', reason: 'unresolved' as const })) };
    const listed = formatImpact(many).split('\n');
    expect(listed).toContain('12 imports could not be resolved, and may depend on these paths:');
    expect(listed.filter((line) => line.startsWith('  a.ts:'))).toHaveLength(10);
    expect(listed).toContain('  and 2 more; --json lists them all');
    // Six files under one rule: five named, and the rest counted.
    expect(formatImpact(await impact(['src/db/client.ts']))).toContain(
      '      governs: src/db/client.ts, src/app/service.ts, src/db/index.ts, src/app/cache.ts, src/ui/view.tsx and 1 more\n',
    );
    expect(formatImpact({ ...many, unresolved: many.unresolved.slice(0, 10) })).not.toContain('--json lists them all');
  });

  it('names the files it could not read, the directives it could not read, a dependent file in the singular, and the options it took', async () => {
    const report = await impact(['src/one.ts'], {}, { 'docs/x.md': '<!-- @assert-bogus -->\n', 'src/one.ts': '', 'src/two.ts': "import './one.js';\n", 'src/lost.ts': 'const s = `open' });
    const text = formatImpact({ ...report, durationMs: 1, config: { file: '.spec-guard.json', applied: ['exclude'], overridden: [] } });
    expect(text).toContain('src/one.ts\n  1 file depends on it, 1 directly\n    1  src/two.ts  imports src/one.ts (line 1)\n');
    expect(text).toContain('\n1 file whose imports could not all be read:\n  src/lost.ts: ');
    expect(text).toContain('\n1 directive could not be read, so its rule governs nothing:\n  docs/x.md:1 ');
    expect(text).toContain('\noptions from .spec-guard.json: exclude (build)\n');
    expect(text).toContain(' and 1 spec file read in ');
  });

  it('is versioned JSON for a script, with every field', async () => {
    const report = await impact(['src/db/client.ts']);
    const json = JSON.parse(formatImpactJson({ ...report, durationMs: 2.34567 })) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'formatVersion',
      'root',
      'specFiles',
      'exclude',
      'depth',
      'results',
      'rules',
      'withheld',
      'documents',
      'unresolved',
      'unfollowed',
      'gaps',
      'errors',
      'scanned',
      'durationMs',
    ]);
    expect(json['formatVersion']).toBe(1);
    expect(json['durationMs']).toBe(2.346);
  });

  it('gives the same answer every time', async () => {
    const first = await impact(['src/db', 'py/pkg/db.py']);
    const second = await impact(['src/db', 'py/pkg/db.py']);
    expect(formatImpactJson({ ...second, durationMs: 0 })).toBe(formatImpactJson({ ...first, durationMs: 0 }));
  });
});

describe('the fixtures on disk', () => {
  it('in the demo repository, a controller depends on the service it imports, and the rules over both are shown', async () => {
    const report = await impactOf({ patterns: ['docs/**/*.md'], root: DEMO_REPO, paths: ['src/services/BillingService.ts'] });
    expect(dependents(report)).toEqual(['1 src/controllers/PaymentController.ts <- src/services/BillingService.ts:1']);
    expect(report.rules.length).toBeGreaterThan(0);
    expect(report.rules.every((rule) => rule.governs.includes('src/controllers/PaymentController.ts') || rule.governs.includes('src/services/BillingService.ts'))).toBe(true);
    expect(report.unfollowed).toEqual([]);
  });

  it('in the Rust workspace, a crate file is not computed, and its uses are counted', async () => {
    const report = await impactOf({ patterns: ['docs/**/*.md'], root: path.join(FIXTURES_DIR, 'cites-corpus'), paths: ['crates/ledger/src/journal.rs'] });
    expect(report.results[0]?.note).toBe('a Rust file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)');
    expect(report.unfollowed).toEqual([{ kind: 'Rust use', references: 1 }]);
  });
});

/* -------------------------------------------------------------- command line */

describe('spec-guard impact', () => {
  async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, cwd: process.cwd(), isTTY: false };
    return { code: await main(argv, io), out, err };
  }

  it('answers for this repository, in both formats', async () => {
    const human = await run(['impact', 'src/graph.ts', '--depth', '1']);
    expect([human.code, human.err]).toEqual([EXIT_OK, []]);
    expect(human.out[0]).toMatch(/^src\/graph\.ts\n {2}\d+ files depend on it, \d+ directly\n/);
    expect(human.out[0]).toContain('    1  src/rules.ts');
    const json = await run(['impact', 'src/graph.ts', '--json', '--depth=1']);
    const parsed = JSON.parse(json.out[0] as string) as { formatVersion: number; depth: number; config?: unknown };
    expect([parsed.formatVersion, parsed.depth]).toEqual([1, 1]);
    expect(parsed.config).toMatchObject({ file: 'package.json', applied: ['specs', 'exclude'] });
  });

  it('passes the options it takes on: the specs, the exclusions, the default skips and --ignore-status', async () => {
    const root = await makeTempRepo({
      'rules/a.md': '**Status:** draft\n\n<!-- @assert-absence target="src" symbol="x" -->\n',
      'src/a.ts': 'export {};\n',
      'src/b.ts': "import './a.js';\n",
      'gen/c.ts': "import '../src/a.js';\n",
      'node_modules/d/i.js': "require('../../src/a.ts');\n",
    });
    try {
      const at = async (...argv: string[]) => {
        const out: string[] = [];
        const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: {}, cwd: root, isTTY: false };
        expect(await main(['impact', 'src/a.ts', '--json', ...argv], io)).toBe(EXIT_OK);
        const json = JSON.parse(out[0] as string) as ImpactReport;
        return { dependents: json.results[0]?.dependents.map(({ file }) => file), rules: json.rules.length, specs: json.specFiles };
      };
      expect(await at()).toEqual({ dependents: ['gen/c.ts', 'src/b.ts'], rules: 0, specs: [] });
      expect(await at('--spec', 'rules/*.md')).toEqual({ dependents: ['gen/c.ts', 'src/b.ts'], rules: 0, specs: ['rules/a.md'] });
      expect(await at('--spec', 'rules/*.md', '--ignore-status')).toEqual({ dependents: ['gen/c.ts', 'src/b.ts'], rules: 1, specs: ['rules/a.md'] });
      expect(await at('--exclude', 'gen')).toMatchObject({ dependents: ['src/b.ts'] });
      expect(await at('--no-default-skips')).toMatchObject({ dependents: ['gen/c.ts', 'node_modules/d/i.js', 'src/b.ts'] });
    } finally {
      await removeTempRepo(root);
    }
  });

  it('exits 2 for a path that is not there', async () => {
    const { code, out, err } = await run(['impact', 'src/nothing-here.ts']);
    expect([code, out, err]).toEqual([EXIT_ERROR, [], ['spec-guard: "src/nothing-here.ts" does not exist, so nothing depends on it yet']]);
  });

  it('takes paths and --depth, needs a path, and refuses what means nothing to it', () => {
    expect(parseArgs(['impact', 'src/a.ts', 'lib', '--depth', '3', '--ignore-status', '--exclude', 'dist'], ROOT)).toMatchObject({
      command: 'impact',
      paths: ['src/a.ts', 'lib'],
      depth: 3,
      ignoreStatus: true,
      exclude: ['dist'],
    });
    expect(parseArgs(['impact', 'a.ts'], ROOT).depth).toBeUndefined();
    expect(() => parseArgs(['impact'], ROOT)).toThrow(new UsageError('spec-guard impact needs a path to ask about, e.g. spec-guard impact src/db/client.ts.'));
    expect(parseArgs(['impact', '--help'], ROOT).help).toBe(true);
    expect(() => parseArgs(['impact', 'a.ts', '--depth', '0'], ROOT)).toThrow(new UsageError('Option --depth expects 1 or more: a depth of 0 would follow no import.'));
    expect(() => parseArgs(['impact', 'a.ts', '--depth', 'x'], ROOT)).toThrow(new UsageError('Option --depth expects a non-negative integer, got "x".'));
    for (const argv of [['--depth', '2'], ['query', 'a', '--depth', '2'], ['cites', '--depth=2'], ['prove', '--depth', '1']]) {
      expect(() => parseArgs(argv, ROOT), argv.join(' ')).toThrow(new UsageError('Option --depth applies only to spec-guard impact.'));
    }
    for (const option of ['--verbose', '--watch', '--fail-fast', '--engine=js', '--strict', '--allow-missing-targets', '--allow-empty-scope', '--print-baseline', '--allow-empty', '--max-snippets=1', '--concurrency=1', '--color']) {
      const name = option.split('=')[0] as string;
      expect(() => parseArgs(['impact', 'a.ts', option], ROOT), option).toThrow(new UsageError(`Option ${name} does not apply to spec-guard impact.`));
    }
    for (const format of ['sarif', 'github', 'gitlab']) {
      expect(() => parseArgs(['impact', 'a.ts', '--format', format], ROOT)).toThrow(
        new UsageError(`spec-guard impact has no ${format} format: it lists files and rules, not results. Expected human or json.`),
      );
    }
    expect(parseArgs(['impact', 'a.ts', '--format', 'json'], ROOT)).toMatchObject({ format: 'json', json: true });
  });

  it('is in the help', () => {
    expect(HELP).toContain('spec-guard impact <paths...> [options]');
    expect(HELP).toContain('--depth <n>');
  });
});
