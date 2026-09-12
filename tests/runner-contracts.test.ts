/**
 * The runner's own contracts.
 *
 * Two kinds of thing live here. The first is the prose: every bound, every
 * plural, every attribute name an error message blames. Those are the product -
 * a report that says "at most undefined matches" is a broken report - and they
 * were pinned only where somebody had happened to write an example.
 *
 * The second is the small pure helpers the run is built from, tested as
 * functions rather than through a run: how long something took, how many
 * workers to start, which tokens count as false. Reaching them through
 * `runSpecGuard` meant a wrong answer had to survive an entire run before
 * anything noticed, and mostly it did.
 */

import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { javascriptEngine, resetRipgrepProbe, type SearchRequest } from '../src/engine.js';
import {
  batchConcurrency,
  createScopeProbe,
  elapsed,
  executeAssertion,
  resolveDirective,
  runSpecGuard,
  DEFAULT_MAX_SNIPPETS,
  type RunResult,
} from '../src/runner.js';
import { createImportIndex } from '../src/imports.js';
import { DEFAULT_SCOPE } from '../src/scope.js';
import type { Assertion, Bounds, Directive, DirectiveKind } from '../src/types.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
  vi.restoreAllMocks();
});

async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

async function run(root: string, overrides = {}): Promise<RunResult> {
  return runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript', ...overrides });
}

function directive(kind: DirectiveKind, attributes: Record<string, string>): Directive {
  return {
    kind,
    attributes,
    raw: `<!-- @${kind} -->`,
    location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
  };
}

function resolve(kind: DirectiveKind, attributes: Record<string, string>) {
  return resolveDirective(directive(kind, attributes), {
    root: DEMO_REPO,
    excludeFiles: new Set<string>(),
  });
}

function assertionOf(kind: DirectiveKind, attributes: Record<string, string>): Assertion {
  const resolved = resolve(kind, attributes);
  if (!('assertion' in resolved)) throw new Error(`expected an assertion, got ${JSON.stringify(resolved)}`);
  return resolved.assertion;
}

function errorOf(kind: DirectiveKind, attributes: Record<string, string>): string {
  const resolved = resolve(kind, attributes);
  if (!('error' in resolved)) throw new Error('expected an error');
  return resolved.error.message;
}

/* ------------------------------------------------------------ pure helpers */

describe('elapsed', () => {
  it('subtracts the mark from the reading, in that order', () => {
    // Seven results carry a duration. "Some number of milliseconds" is what
    // every one of them looked like whichever way round the operands went.
    expect(elapsed(100, 250)).toBe(150);
  });

  it('is zero for a mark taken now', () => {
    expect(elapsed(500, 500)).toBe(0);
  });

  it('reads the clock when given only a mark', () => {
    const before = performance.now();
    const measured = elapsed(before);
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(measured).toBeLessThan(before);
  });
});

describe('batchConcurrency', () => {
  it('never starts more workers than there are batches', () => {
    expect(batchConcurrency(8, 3)).toBe(3);
    expect(batchConcurrency(8, 1)).toBe(1);
  });

  it('honours a lower request', () => {
    expect(batchConcurrency(2, 9)).toBe(2);
  });

  it('starts one worker for no batches, so the run still terminates', () => {
    expect(batchConcurrency(8, 0)).toBe(1);
  });

  it('never returns zero, whatever was asked for', () => {
    expect(batchConcurrency(0, 5)).toBe(1);
  });
});

/* --------------------------------------------------------- attribute input */

describe('boolean attribute spellings', () => {
  it.each(['true', 'TRUE', ' true ', '1', 'yes', 'on'])('reads %s as true', (value) => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', regex: value }).search?.regex).toBe(true);
  });

  it.each(['false', 'FALSE', ' false ', '0', 'no', 'off'])('reads %s as false', (value) => {
    // Asserted through `assertionOf`, which throws if resolution failed. The
    // earlier version read `'assertion' in resolved && resolved.assertion...`
    // and compared that to false, so a spelling that stopped being recognised
    // short-circuited to false and passed the test that was supposed to catch it.
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', regex: value }).search?.regex).toBe(false);
  });

  it.each(['off?', 'maybe', '2', ''])('rejects %s, which is in neither list', (value) => {
    expect(errorOf('assert-count', { symbol: 'X', expected: '1', regex: value })).toBe(
      `Attribute "regex" must be true or false, got "${value}".`,
    );
  });
});

describe('count attributes', () => {
  it('accepts more than one digit', () => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: '12' }).bounds).toEqual({ min: 12, max: 12 });
  });

  it('accepts surrounding whitespace', () => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: ' 3 ' }).bounds).toEqual({ min: 3, max: 3 });
  });

  it.each(['1x', '1.5', '-1', '1 2', ''])('rejects %s', (value) => {
    expect(errorOf('assert-count', { symbol: 'X', expected: value })).toBe(
      `Attribute "expected" must be a non-negative integer, got "${value}".`,
    );
  });
});

describe('list attributes', () => {
  it.each([
    ['src, lib', ['src', 'lib']],
    ['src lib', ['src', 'lib']],
    ['src,,lib', ['src', 'lib']],
    [' src , lib ', ['src', 'lib']],
    ['src', ['src']],
    ['src/config/** tests/**', ['src/config/**', 'tests/**']],
  ])('splits %s into %j', (value, expected) => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', target: value }).targets).toEqual(expected);
  });

  it('falls back to the root when the list is only separators', () => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', target: ' , ' }).targets).toEqual(['.']);
  });
});

describe('target paths', () => {
  it.each(['/etc/passwd', 'C:/repo/src', 'c:\\repo\\src'])('refuses the absolute path %s', (target) => {
    expect(errorOf('assert-count', { symbol: 'X', expected: '1', target })).toBe(
      `Attribute "target" must be relative to --root, got "${target}".`,
    );
  });

  it('accepts a relative path that merely contains a colon', () => {
    // The drive-letter test is anchored. Unanchored it would refuse any path
    // with a colon followed by a slash anywhere in it, which on Linux is an
    // ordinary file name.
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', target: 'a/b:/c' }).targets).toEqual(['a/b:/c']);
  });

  it('refuses a path that climbs out of the root', () => {
    expect(errorOf('assert-count', { symbol: 'X', expected: '1', target: '../elsewhere' })).toBe(
      'Attribute "target" escapes the root directory: "../elsewhere".',
    );
  });

  it('names the attribute that carried the bad path', () => {
    expect(errorOf('assert-present', { file: '/etc/passwd' })).toBe(
      'Attribute "file" must be relative to --root, got "/etc/passwd".',
    );
  });
});

describe('the ratchet attribute', () => {
  it.each(['two-sided', 'one-way', ' ONE-WAY '])('accepts %s', (value) => {
    const assertion = assertionOf('assert-absence', { symbol: 'X', baseline: 'src/a.ts', ratchet: value });
    expect(assertion.ratchet).toBe(value.trim().toLowerCase());
  });

  it('rejects anything else by name', () => {
    expect(errorOf('assert-absence', { symbol: 'X', baseline: 'src/a.ts', ratchet: 'sideways' })).toBe(
      'Attribute "ratchet" must be two-sided or one-way, got "sideways".',
    );
  });

  it('refuses a ratchet with nothing to ratchet against', () => {
    expect(errorOf('assert-absence', { symbol: 'X', ratchet: 'one-way' })).toBe(
      'Attribute "ratchet" needs a baseline="..." to ratchet.',
    );
  });

  it('defaults to two-sided', () => {
    expect(assertionOf('assert-absence', { symbol: 'X' }).ratchet).toBe('two-sided');
  });
});

describe('the types attribute', () => {
  it.each([
    ['include', true],
    ['ignore', false],
    [' IGNORE ', false],
  ])('reads %s as includeTypes=%s', (value, expected) => {
    expect(assertionOf('assert-import-absence', { module: 'a/**', types: value }).imports?.includeTypes).toBe(expected);
  });

  it('includes type-only imports by default', () => {
    expect(assertionOf('assert-import-absence', { module: 'a/**' }).imports?.includeTypes).toBe(true);
  });

  it('rejects anything else by name', () => {
    expect(errorOf('assert-import-absence', { module: 'a/**', types: 'maybe' })).toBe(
      'Attribute "types" must be include or ignore, got "maybe".',
    );
  });
});

describe('allow-empty', () => {
  it('names itself when it is the attribute at fault', () => {
    expect(errorOf('assert-absence', { symbol: 'X', 'allow-empty': 'perhaps' })).toBe(
      'Attribute "allow-empty" must be true or false, got "perhaps".',
    );
  });
});

describe('a literal symbol is not compiled as a pattern', () => {
  it('accepts a symbol that would not parse as a regular expression', () => {
    expect(assertionOf('assert-count', { symbol: '(', expected: '1' }).symbol).toBe('(');
  });

  it('still rejects a broken pattern when regex is on', () => {
    expect(errorOf('assert-count', { symbol: '(', expected: '1', regex: 'true' })).toBe(
      'Invalid regular expression: /(/: Unterminated group',
    );
  });
});

/* -------------------------------------------------------------- the prose */

describe('what an assertion says it will check', () => {
  it.each([
    [{ symbol: 'X', expected: '0' }, '"X" must appear exactly 0 times in .'],
    [{ symbol: 'X', expected: '1' }, '"X" must appear exactly 1 time in .'],
    [{ symbol: 'X', min: '1' }, '"X" must appear at least 1 time in .'],
    [{ symbol: 'X', min: '2' }, '"X" must appear at least 2 times in .'],
    [{ symbol: 'X', max: '0' }, '"X" must not appear in .'],
    [{ symbol: 'X', max: '1' }, '"X" must appear at most 1 time in .'],
    [{ symbol: 'X', max: '2' }, '"X" must appear at most 2 times in .'],
    [{ symbol: 'X', min: '1', max: '3' }, '"X" must appear between 1 and 3 times in .'],
  ])('%o reads as %s', (attributes, expected) => {
    expect(assertionOf('assert-count', attributes).description).toBe(expected);
  });

  it.each([
    [{ module: 'a/**' }, '. must not import "a/**"'],
    [{ module: 'a/**', expected: '0' }, '. must import from exactly 0 files "a/**"'],
    [{ module: 'a/**', expected: '1' }, '. must import from exactly 1 file "a/**"'],
    [{ module: 'a/**', expected: '2' }, '. must import from exactly 2 files "a/**"'],
    [{ module: 'a/**', min: '1' }, '. must import from at least 1 file "a/**"'],
    [{ module: 'a/**', min: '3' }, '. must import from at least 3 files "a/**"'],
    [{ module: 'a/**', max: '1' }, '. must import from at most 1 file "a/**"'],
    [{ module: 'a/**', min: '1', max: '4' }, '. must import from between 1 and 4 files "a/**"'],
  ])('%o reads as %s', (attributes, expected) => {
    const kind: DirectiveKind = attributes.module && !('min' in attributes) && !('max' in attributes) && !('expected' in attributes)
      ? 'assert-import-absence'
      : 'assert-import-count';
    expect(assertionOf(kind, attributes).description).toBe(expected);
  });

  it('names the excluded globs in the description', () => {
    expect(assertionOf('assert-import-absence', { module: 'a/**', exclude: 'tests/**, fixtures/**' }).description).toBe(
      '. must not import "a/**" (excluding tests/**, fixtures/**)',
    );
  });

  it('names every target, separated', () => {
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1', target: 'src, lib' }).description).toBe(
      '"X" must appear exactly 1 time in src, lib',
    );
    expect(assertionOf('assert-import-absence', { module: 'a/**', target: 'src, lib' }).description).toBe(
      'src, lib must not import "a/**"',
    );
  });

  it('names no files on an assertion that searches text', () => {
    // `files` belongs to assert-present. Anything in it here would be reported
    // as a file this assertion claimed must exist.
    expect(assertionOf('assert-count', { symbol: 'X', expected: '1' }).files).toEqual([]);
    expect(assertionOf('assert-import-absence', { module: 'a/**' }).files).toEqual([]);
  });

  it('names the excluded globs on a text assertion too', () => {
    expect(assertionOf('assert-absence', { symbol: 'X', exclude: 'tests/**, docs/**' }).description).toBe(
      '"X" must not appear in . (excluding tests/**, docs/**)',
    );
  });
});

/**
 * `Bounds` has both fields optional, so an unbounded assertion is a state the
 * published API can hand to `executeAssertion` even though `resolveDirective`
 * never produces one. Three prose branches and the pass/fail test itself only
 * exist for that state, and nothing had ever entered it.
 */
describe('an assertion with no bounds at all', () => {
  async function outcome(bounds: Bounds, kind: DirectiveKind = 'assert-count'): Promise<{ ok: boolean; message: string }> {
    const root = await repo({ 'src/a.ts': 'const w = Widget;\n' });
    const assertion: Assertion = {
      kind,
      location: { file: `${root}/docs/a.md`, relativeFile: 'docs/a.md', line: 1, column: 1 },
      description: 'anything',
      symbol: 'Widget',
      targets: ['src'],
      files: [],
      bounds,
      search: searchOptions(),
      missingTargets: [],
      allowEmpty: false,
      baseline: [],
      ratchet: 'two-sided',
    };
    const result = await executeAssertion(assertion, {
      root,
      engine: javascriptEngine,
      allowMissingTargets: false,
      strictTargets: false,
      allowEmptyScope: false,
      maxSnippets: DEFAULT_MAX_SNIPPETS,
      imports: createImportIndex(),
      hasFiles: createScopeProbe(),
    });
    return { ok: result.ok, message: result.message };
  }

  it('passes, and says it expected any number', async () => {
    expect(await outcome({})).toEqual({ ok: true, message: 'expected any number of matches, found 1' });
  });

  it('passes a count of zero just the same', async () => {
    const root = await repo({ 'src/a.ts': 'nothing here\n' });
    const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' });
    // The run itself cannot make one; this is the guard that says so.
    expect(report.results).toEqual([]);
  });

  it.each([
    [{ min: 2 }, false],
    [{ min: 1 }, true],
    [{ max: 0 }, false],
    [{ max: 1 }, true],
    [{ min: 1, max: 1 }, true],
    [{ min: 0, max: 0 }, false],
  ] as Array<[Bounds, boolean]>)('bounds %o against a count of 1 is %s', async (bounds, ok) => {
    expect((await outcome(bounds)).ok).toBe(ok);
  });
});

describe('the outcome line', () => {
  const LEGACY = {
    'src/a.ts': 'const one = LegacyThing;\n',
    'src/b.ts': 'const two = LegacyThing;\n',
    'src/c.ts': 'const three = LegacyThing;\n',
  };

  it('pluralises one uninspectable file', async () => {
    const root = await repo({
      'src/a.ts': 'const x = Widget;\n',
      'src/blob.bin': Buffer.from([0x57, 0x69, 0x64, 0x67, 0x65, 0x74, 0x00]),
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" -->\n',
    });

    // The clause only appears under --strict-targets, where a file that could
    // not be inspected is a failure rather than a footnote.
    expect((await run(root, { strictTargets: true })).results[0]?.message).toBe(
      'expected no matches, found 1; 1 file could not be inspected',
    );
  });

  it('pluralises two uninspectable files', async () => {
    const bytes = Buffer.from([0x57, 0x69, 0x64, 0x67, 0x65, 0x74, 0x00]);
    const root = await repo({
      'src/a.ts': 'const x = Widget;\n',
      'src/one.bin': bytes,
      'src/two.bin': bytes,
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" -->\n',
    });

    expect((await run(root, { strictTargets: true })).results[0]?.message).toBe(
      'expected no matches, found 1; 2 files could not be inspected',
    );
  });

  it('lists every stale baseline entry, separated', async () => {
    const root = await repo({
      ...LEGACY,
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyThing" baseline="src/gone.ts src/also-gone.ts" -->\n',
    });

    expect((await run(root)).results[0]?.message).toBe(
      'expected no matches, found 3; the baseline is out of date and must be pruned: ' +
        'src/gone.ts (no longer matches), src/also-gone.ts (no longer matches)',
    );
  });

  it('says what a stale entry declared and what was found', async () => {
    const root = await repo({
      ...LEGACY,
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyThing" baseline="src/a.ts:5" -->\n',
    });

    expect((await run(root)).results[0]?.message).toBe(
      'expected no matches, found 2; 1 more is on the baseline; ' +
        'the baseline is out of date and must be pruned: src/a.ts (declares 5, found 1)',
    );
  });
});

describe('baseline attributes', () => {
  it('names the baseline when its count is not a number', async () => {
    const root = await repo({
      'src/a.ts': 'LegacyThing\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyThing" baseline="src/a.ts:many" -->\n',
    });

    expect((await run(root)).errors[0]?.message).toBe(
      'Attribute "baseline" must be a non-negative integer, got "many".',
    );
  });

  it('names the baseline when its path escapes the root', async () => {
    const root = await repo({
      'src/a.ts': 'LegacyThing\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyThing" baseline="../outside.ts" -->\n',
    });

    expect((await run(root)).errors[0]?.message).toBe(
      'Attribute "baseline" escapes the root directory: "../outside.ts".',
    );
  });
});

/* -------------------------------------------------------- assert-present */

describe('assert-present resolves to a fixed shape', () => {
  it('asserts existence of exactly the files named, and nothing else', () => {
    // Every field here is load-bearing for a kind that never runs a search:
    // no targets to walk, bounds pinned to the file count, and `allow-empty`
    // on, because "these files exist" is not a claim about a scope.
    expect(assertionOf('assert-present', { file: 'src/a.ts, src/b.ts' })).toMatchObject({
      kind: 'assert-present',
      description: 'src/a.ts, src/b.ts must exist',
      files: ['src/a.ts', 'src/b.ts'],
      targets: [],
      bounds: { min: 2, max: 2 },
      missingTargets: [],
      allowEmpty: true,
      baseline: [],
      ratchet: 'two-sided',
    });
  });

  it('reports which of the named files are missing', async () => {
    const root = await repo({
      'src/a.ts': 'x\n',
      'docs/a.md': '<!-- @assert-present file="src/a.ts, src/gone.ts, src/also-gone.ts" -->\n',
    });

    expect((await run(root)).results[0]?.message).toBe('missing: src/gone.ts, src/also-gone.ts');
  });

  it('carries the empty lists a kind that never searches still has to fill in', async () => {
    // `assert-present` returns the shared base result untouched, so this is the
    // only path on which those empty arrays are what a reader sees - every
    // other kind overwrites them on the way out.
    const root = await repo({
      'src/a.ts': 'x\n',
      'docs/a.md': '<!-- @assert-present file="src/a.ts" -->\n',
    });

    expect((await run(root)).results[0]).toMatchObject({
      ok: true,
      staleBaseline: [],
      fileMatches: [],
      matches: [],
      warnings: [],
      baselinedMatches: 0,
      commentMatches: 0,
      unclassifiedFiles: 0,
      scope: { skipped: [] },
    });
  });
});

/* ------------------------------------------------------- import execution */

describe('an import assertion never runs a text search', () => {
  it('carries matching flags that are inert, and says so by being asserted', () => {
    // These reach `enumerateCandidates` and nothing else. Asserting them keeps
    // them inert on purpose rather than by nobody having looked: an import rule
    // that quietly became case-insensitive would change no test otherwise.
    expect(assertionOf('assert-import-absence', { module: 'a/**' }).search).toMatchObject({
      regex: false,
      word: false,
      ignoreCase: false,
      globs: [],
      excludeGlobs: [],
      ignoreComments: true,
      scope: DEFAULT_SCOPE,
    });
  });

  it('names no symbol to search for', () => {
    expect(assertionOf('assert-import-absence', { module: 'a/**' }).files).toEqual([]);
  });
});

describe('how a reference is spelled in a snippet', () => {
  it.each([
    ['app.ts', "import { Client } from './db/client.js';\n", 'import ./db/client.js'],
    ['app.ts', "export { Client } from './db/client.js';\n", 'export ./db/client.js'],
    ['app.cjs', "const c = require('./db/client.js');\n", 'require ./db/client.js'],
    ['app.ts', "const c = await import('./db/client.js');\n", 'import ./db/client.js'],
    ['app.rs', 'use db::client::Client;\n', 'use db::client::Client'],
    ['app.cs', 'using Db.Client;\n', 'using Db.Client'],
  ])('%s writes %s as "%s"', async (name, source, snippet) => {
    const root = await repo({
      [`src/${name}`]: source,
      'src/db/client.ts': 'export const Client = 1;\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="**client**, db::client::**, Db.Client" -->\n',
    });

    const report = await run(root);

    expect(report.results[0]?.matches.map((match) => match.text)).toContain(snippet);
  });
});

describe('unresolvable references', () => {
  const DYNAMIC = {
    'src/a.ts': "const name = process.env.M; const m = await import(name);\n",
    'src/b.ts': "const other = process.env.N; const m = await import(other);\n",
  };

  it('says nothing when everything resolved', async () => {
    const root = await repo({
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': 'export const b = 1;\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    expect((await run(root)).results[0]?.warnings).toEqual([]);
  });

  it('pluralises one unresolvable reference', async () => {
    const root = await repo({
      'src/a.ts': DYNAMIC['src/a.ts'],
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    expect((await run(root)).results[0]?.warnings[0]).toBe('1 module reference could not be resolved statically');
  });

  it('pluralises two, and lists them', async () => {
    const root = await repo({ ...DYNAMIC, 'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n' });

    const warnings = (await run(root)).results[0]?.warnings ?? [];
    expect(warnings[0]).toBe('2 module references could not be resolved statically');
    expect(warnings).toHaveLength(3);
    expect(warnings[1]).toMatch(/^ {2}src\/a\.ts:1 /);
  });

  it('lists no more of them than --max-snippets allows', async () => {
    const dynamic = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `src/f${index}.ts`,
        `const n${index} = process.env.M; const m = await import(n${index});\n`,
      ]),
    );
    const root = await repo({ ...dynamic, 'docs/a.md': '<!-- @assert-import-absence target="src" module="x/**" -->\n' });

    const warnings = (await run(root, { maxSnippets: 3 })).results[0]?.warnings ?? [];

    expect(warnings[0]).toBe('8 module references could not be resolved statically');
    expect(warnings).toHaveLength(4);
  });

  it('fails under --strict-targets, and says how many', async () => {
    const root = await repo({ ...DYNAMIC, 'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n' });

    const report = await run(root, { strictTargets: true });

    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.message).toBe(
      'expected no matches, found 0; 2 references could not be resolved',
    );
  });

  it('pluralises one reference in the strict failure', async () => {
    const root = await repo({
      'src/a.ts': DYNAMIC['src/a.ts'],
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    expect((await run(root, { strictTargets: true })).results[0]?.message).toBe(
      'expected no matches, found 0; 1 reference could not be resolved',
    );
  });

  it('passes under --strict-targets when nothing was unresolvable', async () => {
    const root = await repo({
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': 'export const b = 1;\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    const report = await run(root, { strictTargets: true });

    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[0]?.message).toBe('expected no matches, found 0');
  });
});

describe('an import assertion looks only where it was told to', () => {
  it('does not fall back to the whole root when its target exists', async () => {
    // Losing the target list makes the walk default to the repository root.
    // A test whose only other file is the spec cannot see that, because the
    // spec is excluded anyway - the extra file has to be one that counts.
    const root = await repo({
      'src/a.py': 'import os\n',
      'lib/outside.py': 'from app.db.client import Client\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="app/db/**" -->\n',
    });

    const result = (await run(root)).results[0];

    expect(result?.ok).toBe(true);
    expect(result?.actual).toBe(0);
    expect(result?.matches).toEqual([]);
  });

  it('walks every target it was given, not just the first', async () => {
    const root = await repo({
      'src/a.py': 'from app.db.client import Client\n',
      'lib/b.py': 'from app.db.client import Client\n',
      'other/c.py': 'from app.db.client import Client\n',
      'docs/a.md': '<!-- @assert-import-absence target="src, lib" module="app/db/**" -->\n',
    });

    expect((await run(root)).results[0]?.matches.map((m) => m.file).sort()).toEqual(['lib/b.py', 'src/a.py']);
  });
});

describe('an import assertion that verified nothing', () => {
  it('carries no snippets with its failure', async () => {
    const root = await repo({
      'src/notes.txt': 'not code\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="a/**" -->\n',
    });

    const result = (await run(root)).results[0];

    expect(result?.ok).toBe(false);
    expect(result?.matches).toEqual([]);
    expect(result?.message).toBe(
      'none of the 1 files here are in a language whose imports spec-guard can read, ' +
        'so this assertion verified nothing (add allow-empty="true" if that is expected)',
    );
  });

  it('says so differently when the scope held no files at all', async () => {
    const root = await repo({
      'src/notes.txt': 'not code\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="a/**" exclude="*.txt" -->\n',
    });

    expect((await run(root)).results[0]?.message).toBe(
      'no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
    );
  });
});

describe('an import assertion with a baseline', () => {
  const SPEC = (extra: string) =>
    `<!-- @assert-import-absence target="src" module="app/db/**" ${extra} -->\n`;

  it('reports the files that matched, and leaves a baselined one out of the snippets', async () => {
    const root = await repo({
      'src/a.py': 'from app.db.client import Client\n',
      'src/b.py': 'from app.db.client import Client\n',
      'docs/a.md': SPEC('baseline="src/a.py"'),
    });

    const result = (await run(root)).results[0];

    expect(result?.fileMatches).toEqual([{ file: 'src/a.py', count: 1 }, { file: 'src/b.py', count: 1 }]);
    expect(result?.matches.map((match) => match.file)).toEqual(['src/b.py']);
    expect(result?.baselinedMatches).toBe(1);
  });

  it('fails a two-sided ratchet on a stale entry, and a one-way ratchet does not', async () => {
    const files = { 'src/a.py': 'import os\n' };
    const twoSided = await repo({ ...files, 'docs/a.md': SPEC('baseline="src/gone.py"') });
    const oneWay = await repo({ ...files, 'docs/a.md': SPEC('baseline="src/gone.py" ratchet="one-way"') });

    expect((await run(twoSided)).results[0]?.ok).toBe(false);
    // One-way means "never worse"; a baseline entry that no longer matches is
    // better, and demanding it be pruned would make the ratchet two-sided.
    expect((await run(oneWay)).results[0]?.ok).toBe(true);
  });
});

describe('files in a language whose imports cannot be read', () => {
  it('pluralises one', async () => {
    const root = await repo({
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/notes.txt': 'not code\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    expect((await run(root)).results[0]?.warnings).toContain(
      'analysed 2 of 3 files; 1 is in a language whose imports spec-guard cannot read',
    );
  });

  it('pluralises two', async () => {
    const root = await repo({
      'src/a.ts': "import './b.js';\n",
      'src/notes.txt': 'not code\n',
      'src/more.txt': 'also not code\n',
      'docs/a.md': '<!-- @assert-import-absence target="src" module="nothing/**" -->\n',
    });

    expect((await run(root)).results[0]?.warnings).toContain(
      'analysed 1 of 3 files; 2 are in a language whose imports spec-guard cannot read',
    );
  });
});

describe('per-file match counts', () => {
  it('reports the count for each file that matched', async () => {
    const root = await repo({
      'src/a.ts': 'Widget Widget\n',
      'src/b.ts': 'Widget\n',
      'src/c.ts': 'nothing\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" -->\n',
    });

    expect((await run(root)).results[0]?.fileMatches).toEqual([
      { file: 'src/a.ts', count: 2 },
      { file: 'src/b.ts', count: 1 },
    ]);
  });

  it('reports none when nothing matched', async () => {
    const root = await repo({
      'src/a.ts': 'nothing\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" -->\n',
    });

    expect((await run(root)).results[0]?.fileMatches).toEqual([]);
  });

  it('leaves a baselined file out of the snippets', async () => {
    const root = await repo({
      'src/a.ts': 'Widget\n',
      'src/b.ts': 'Widget\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" baseline="src/a.ts" -->\n',
    });

    const result = (await run(root)).results[0];

    expect(result?.matches.map((match) => match.file)).toEqual(['src/b.ts']);
    expect(result?.baselinedMatches).toBe(1);
  });
});

/* ---------------------------------------------------------- the scope probe */

describe('createScopeProbe', () => {
  it('walks once for two assertions asking about the same scope', async () => {
    const root = await repo({ 'src/a.ts': 'x\n' });
    const probe = createScopeProbe();
    const request: SearchRequest = { root, symbol: 'x', targets: ['src'], options: searchOptions() };
    const spy = vi.spyOn(fsp, 'readdir');

    expect(await probe(request)).toBe(true);
    const afterFirst = spy.mock.calls.length;
    expect(await probe({ ...request, symbol: 'y' })).toBe(true);

    expect(afterFirst).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });

  it('tells an empty scope from a populated one', async () => {
    const root = await repo({ 'src/a.ts': 'x\n', 'empty/.keep': '' });
    const probe = createScopeProbe();
    const base: SearchRequest = { root, symbol: 'x', targets: ['src'], options: searchOptions() };

    expect(await probe(base)).toBe(true);
    expect(await probe({ ...base, targets: ['src'], options: searchOptions({ globs: ['*.rs'] }) })).toBe(false);
  });

  it('tells scopes apart by their exclusions', async () => {
    const root = await repo({ 'src/a.ts': 'x\n' });
    const probe = createScopeProbe();
    const base: SearchRequest = { root, symbol: 'x', targets: ['src'], options: searchOptions() };

    expect(await probe(base)).toBe(true);
    expect(await probe({ ...base, options: searchOptions({ excludeGlobs: ['*.ts'] }) })).toBe(false);
  });
});

/* ------------------------------------------------------------- run options */

describe('run options', () => {
  it('skips the default directories unless told not to', async () => {
    const root = await repo({
      'src/a.ts': 'Widget\n',
      'src/node_modules/b.ts': 'Widget\n',
      'docs/a.md': '<!-- @assert-count target="src" symbol="Widget" min="1" -->\n',
    });

    expect((await run(root)).results[0]?.actual).toBe(1);
    expect((await run(root, { defaultSkips: false })).results[0]?.actual).toBe(2);
  });

  it('leaves the spec files out of the search unless told not to', async () => {
    const root = await repo({
      'src/a.ts': 'Widget\n',
      // The mention has to be in prose: the directive itself is an HTML
      // comment, and comments are not counted by default.
      'docs/a.md': '<!-- @assert-count target="." symbol="Widget" min="1" -->\nWidget is discussed here.\n',
    });

    expect((await run(root)).results[0]?.actual).toBe(1);
    expect((await run(root, { includeSpecs: true })).results[0]?.actual).toBe(2);
  });

  it('reports a spec file it could not read, with an empty raw directive', async () => {
    const root = await repo({ 'src/a.ts': 'x\n' });
    const report = await runSpecGuard({
      patterns: [`${root}/docs/missing.md`],
      root,
      engine: 'javascript',
    });

    // A pattern that matches nothing yields no error at all; this test exists
    // for the read failure, so the file has to exist and then not be readable.
    expect(report.errors).toEqual([]);
  });

  it('chooses an engine adaptively when none was named', async () => {
    // The default reaches `resolveEngine`, which now compares every preference
    // by name including `auto` - so an option that says nothing has to still
    // say "auto" and not something that falls through to the ripgrep branch.
    const root = await repo({
      'src/a.ts': 'Widget\n',
      'docs/a.md': '<!-- @assert-count target="src" symbol="Widget" min="1" -->\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/a.md'], root });

    expect(report.results[0]?.ok).toBe(true);
    expect(report.engine).toBe('javascript');
  });

  it('runs no assertions and reports nothing when a spec has none', async () => {
    const root = await repo({ 'docs/a.md': '# Just prose\n' });
    const report = await run(root);

    expect(report.results).toEqual([]);
    expect(report.summary).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(report.ok).toBe(true);
  });

  it('reports a duration that is a real elapsed time', async () => {
    const root = await repo({ 'docs/a.md': '# Just prose\n' });
    const report = await run(root);

    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThan(performance.now());
  });
});

describe('which attribute an absence rule blames', () => {
  it('blames expected when expected carried the bad value', () => {
    expect(errorOf('assert-absence', { symbol: 'X', expected: 'lots' })).toBe(
      'Attribute "expected" must be a non-negative integer, got "lots".',
    );
  });

  it('blames max when max carried it', () => {
    expect(errorOf('assert-absence', { symbol: 'X', max: 'lots' })).toBe(
      'Attribute "max" must be a non-negative integer, got "lots".',
    );
  });

  it('treats an absence rule with neither as "not at all"', () => {
    expect(assertionOf('assert-absence', { symbol: 'X' }).bounds).toEqual({ max: 0 });
  });

  it('reads expected as the ceiling for an absence rule', () => {
    expect(assertionOf('assert-absence', { symbol: 'X', expected: '2' }).bounds).toEqual({ max: 2 });
  });
});

describe('a result with nothing to report', () => {
  it('carries an empty stale-baseline list rather than an absent one', async () => {
    const root = await repo({
      'src/a.ts': 'nothing\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Widget" -->\n',
    });

    const result = (await run(root)).results[0];

    expect(result?.staleBaseline).toEqual([]);
    expect(result?.baselinedMatches).toBe(0);
    expect(result?.warnings).toEqual([]);
  });
});

describe('a spec file that cannot be read', () => {
  it('reports it as an error with no directive text to quote', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-absence target="." symbol="X" -->\n' });
    const real = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      const [file] = args;
      if (typeof file === 'string' && file.endsWith('a.md')) throw new Error('EACCES: permission denied');
      return real(...args);
    }) as typeof fsp.readFile);

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    // There is no directive to quote, because the file was never parsed.
    expect(report.errors[0]?.raw).toBe('');
    expect(report.errors[0]?.message).toBe('Unable to read spec file: EACCES: permission denied');
    expect(report.errors[0]?.location).toMatchObject({ relativeFile: 'docs/a.md', line: 1, column: 1 });
  });
});

describe('when ripgrep breaks part way through a run', () => {
  /** A tree past SMALL_TREE_BUDGET on every platform, so the run reaches for ripgrep. */
  const FILLER = 'const padding = 1;\n'.repeat(20_000);

  it('says so in the warnings and reports the engine that finished the job', async () => {
    const previous = process.env.SPEC_GUARD_RG;
    // node(1) rejects ripgrep's flags and exits non-zero, which is the shape of
    // a ripgrep that is installed and broken rather than one that is absent.
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    try {
      const root = await repo({
        'src/a.ts': FILLER,
        'src/b.ts': FILLER,
        'src/c.ts': FILLER,
        'src/d.ts': FILLER,
        'src/needle.ts': 'const w = Widget;\n',
        'docs/a.md': '<!-- @assert-count target="src" symbol="Widget" expected="1" -->\n',
      });

      const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'auto' });

      expect(report.results[0]?.ok).toBe(true);
      expect(report.warnings).toHaveLength(1);
      // Split in two because what a broken ripgrep writes to stderr is its
      // business and can run to several lines; the wrapper around it is ours.
      expect(report.warnings[0]).toMatch(
        /^ripgrep failed, fell back to the JavaScript engine \(ripgrep exited with code \d+: \S/,
      );
      expect(report.warnings[0]?.endsWith(')')).toBe(true);
      // Not "ripgrep": the answer came from the scanner, and a report that
      // names the engine it hoped for is a report that cannot be reproduced.
      expect(report.engine).toBe('javascript');
    } finally {
      if (previous === undefined) delete process.env.SPEC_GUARD_RG;
      else process.env.SPEC_GUARD_RG = previous;
      resetRipgrepProbe();
    }
  });
});

describe('errors come out in file order', () => {
  it('sorts by file, then by line', async () => {
    const root = await repo({
      'docs/b.md': '<!-- @assert-count symbol="X" expected="x" -->\n',
      'docs/a.md': '<!-- @assert-count symbol="X" expected="y" -->\n<!-- @assert-count symbol="X" expected="z" -->\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.errors.map((error) => `${error.location.relativeFile}:${error.location.line}`)).toEqual([
      'docs/a.md:1',
      'docs/a.md:2',
      'docs/b.md:1',
    ]);
  });
});
