/**
 * Tests written to close gaps that mutation testing exposed.
 *
 * Each block here corresponds to mutants that survived the first Stryker run:
 * behaviour that executed under test but that no assertion actually pinned
 * down. They are grouped by the source file they protect rather than mixed
 * into the existing suites, so the reason they exist stays obvious.
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildJsRegExp,
  buildRipgrepArgs,
  javascriptEngine,
  runSearches,
  scanContent,
  type SearchRequest,
} from '../src/engine.js';
import { createGlobMatcher, globBase, globToRegExp, walkFiles } from '../src/glob.js';
import { parseDirectives } from '../src/parser.js';
import { resolveDirective, runSpecGuard } from '../src/runner.js';
import type { Directive, DirectiveKind } from '../src/types.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const parseContext = { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md' };
const fence = '`'.repeat(3);

function directive(kind: DirectiveKind, attributes: Record<string, string>): Directive {
  return {
    kind,
    attributes,
    raw: `<!-- @${kind} -->`,
    location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
  };
}

function describeOf(kind: DirectiveKind, attributes: Record<string, string>): string {
  const resolved = resolveDirective(directive(kind, attributes), {
    root: DEMO_REPO,
    excludeFiles: new Set<string>(),
  });
  if (!('assertion' in resolved)) throw new Error(`expected an assertion: ${JSON.stringify(resolved)}`);
  return resolved.assertion.description;
}

/* -------------------------------------------------------------- runner.ts */

describe('bounds wording', () => {
  it.each([
    ['assert-absence', { symbol: 'X' }, '"X" must not appear in .'],
    ['assert-absence', { symbol: 'X', expected: '1' }, '"X" must appear at most 1 time in .'],
    ['assert-absence', { symbol: 'X', expected: '3' }, '"X" must appear at most 3 times in .'],
    ['assert-count', { symbol: 'X', expected: '0' }, '"X" must appear exactly 0 times in .'],
    ['assert-count', { symbol: 'X', expected: '1' }, '"X" must appear exactly 1 time in .'],
    ['assert-count', { symbol: 'X', expected: '2' }, '"X" must appear exactly 2 times in .'],
    ['assert-count', { symbol: 'X', min: '1' }, '"X" must appear at least 1 time in .'],
    ['assert-count', { symbol: 'X', min: '2' }, '"X" must appear at least 2 times in .'],
    ['assert-count', { symbol: 'X', max: '1' }, '"X" must appear at most 1 time in .'],
    ['assert-count', { symbol: 'X', min: '1', max: '3' }, '"X" must appear between 1 and 3 times in .'],
    ['assert-count', { symbol: 'X', min: '2', max: '2' }, '"X" must appear exactly 2 times in .'],
  ] as Array<[DirectiveKind, Record<string, string>, string]>)(
    '@%s %o reads as "%s"',
    (kind, attributes, expected) => {
      expect(describeOf(kind, attributes)).toBe(expected);
    },
  );
});

describe('failure messages', () => {
  async function messageFor(spec: string, files: Record<string, string> = {}): Promise<string> {
    const root = await repo({ 'docs/a.md': spec, 'src/a.ts': 'const nothing = 1;\n', ...files });
    const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' });
    return report.results[0]?.message ?? '';
  }

  it.each([
    ['<!-- @assert-count target="src" symbol="Zzz" expected="1" -->', 'expected exactly 1 match, found 0'],
    ['<!-- @assert-count target="src" symbol="Zzz" expected="2" -->', 'expected exactly 2 matches, found 0'],
    ['<!-- @assert-count target="src" symbol="Zzz" min="1" -->', 'expected at least 1 match, found 0'],
    ['<!-- @assert-count target="src" symbol="Zzz" min="3" -->', 'expected at least 3 matches, found 0'],
    ['<!-- @assert-count target="src" symbol="const" max="0" -->', 'expected no matches, found 1'],
    ['<!-- @assert-count target="src" symbol="const" min="2" max="5" -->', 'expected between 2 and 5 matches, found 1'],
    ['<!-- @assert-absence target="src" symbol="const" expected="1" -->', 'expected at most 1 match, found 1'],
  ])('%s reports "%s"', async (spec, expected) => {
    expect(await messageFor(spec)).toBe(expected);
  });

  it('pluralises the missing-target warning', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="gone" symbol="X" -->\n<!-- @assert-absence target="a,b" symbol="X" -->\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' });

    expect(report.results[0]?.warnings).toEqual(['target path not found: gone']);
    expect(report.results[1]?.warnings).toEqual(['target paths not found: a, b']);
  });

  it('pluralises the strict-mode failure', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="gone" symbol="X" -->\n<!-- @assert-absence target="a,b" symbol="X" -->\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript', strictTargets: true });

    expect(report.results[0]?.message).toBe('target path does not exist: gone');
    expect(report.results[1]?.message).toBe('target paths do not exist: a, b');
  });

  it('passes under --strict when every target exists', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-absence target="src" symbol="X" -->\n', 'src/a.ts': '' });
    const report = await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript', strictTargets: true });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.warnings).toEqual([]);
  });

  it('reports a plausible duration rather than a sum of timestamps', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });

    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.durationMs).toBeLessThan(60_000);
    for (const result of report.results) {
      expect(result.durationMs).toBeLessThan(60_000);
    }
  });
});

describe('attribute parsing edge cases', () => {
  it('trims whitespace around booleans and numbers', () => {
    const resolved = resolveDirective(
      directive('assert-count', { symbol: 'X', expected: ' 2 ', regex: ' TRUE ' }),
      { root: DEMO_REPO, excludeFiles: new Set<string>() },
    );

    expect('assertion' in resolved && resolved.assertion.bounds).toEqual({ min: 2, max: 2 });
    expect('assertion' in resolved && resolved.assertion.search?.regex).toBe(true);
  });

  it('drops empty entries from comma separated lists', () => {
    const resolved = resolveDirective(
      directive('assert-count', { symbol: 'X', expected: '1', target: 'src,,  ,src/ui', glob: '*.ts,,*.tsx' }),
      { root: DEMO_REPO, excludeFiles: new Set<string>() },
    );

    expect('assertion' in resolved && resolved.assertion.targets).toEqual(['src', 'src/ui']);
    expect('assertion' in resolved && resolved.assertion.search?.globs).toEqual(['*.ts', '*.tsx']);
  });

  it('orders directive errors by file and then by line', async () => {
    const root = await repo({
      'docs/b.md': '<!-- @assert-count symbol="X" bad="1" -->\n',
      'docs/a.md': '\n\n<!-- @assert-count symbol="X" bad="1" -->\n<!-- @assert-absence -->\n',
    });
    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.errors.map((error) => `${error.location.relativeFile}:${error.location.line}`)).toEqual([
      'docs/a.md:3',
      'docs/a.md:4',
      'docs/b.md:1',
    ]);
  });
});

/* -------------------------------------------------------------- engine.ts */

describe('search grouping', () => {
  function requestFor(root: string, symbol: string, overrides = {}): SearchRequest {
    return { root, symbol, targets: ['src'], options: searchOptions(overrides) };
  }

  it('never merges requests whose options differ', async () => {
    const root = await repo({ 'src/a.ts': 'PrimaryButton PrimaryButtonTestId primarybutton\n' });

    // Same symbol, different flags: batching these together would be wrong.
    const results = await runSearches(javascriptEngine, [
      requestFor(root, 'PrimaryButton'),
      requestFor(root, 'PrimaryButton', { word: true }),
      requestFor(root, 'PrimaryButton', { ignoreCase: true }),
      requestFor(root, 'PrimaryButton', { globs: ['*.tsx'] }),
      requestFor(root, 'Primary.*', { regex: true }),
    ]);

    expect(results.map((result) => result.count)).toEqual([2, 1, 3, 0, 1]);
  });

  it('keeps per-request answers when only the symbol differs', async () => {
    const root = await repo({ 'src/a.ts': 'alpha bravo alpha\n' });
    const results = await runSearches(javascriptEngine, [
      requestFor(root, 'alpha'),
      requestFor(root, 'bravo'),
      requestFor(root, 'charlie'),
    ]);

    expect(results.map((result) => result.count)).toEqual([2, 1, 0]);
  });

  it('does not merge requests rooted in different directories', async () => {
    const first = await repo({ 'src/a.ts': 'alpha\n' });
    const second = await repo({ 'src/a.ts': 'alpha alpha\n' });

    const results = await runSearches(javascriptEngine, [requestFor(first, 'alpha'), requestFor(second, 'alpha')]);
    expect(results.map((result) => result.count)).toEqual([1, 2]);
  });
});

describe('ripgrep arguments', () => {
  const base: SearchRequest = { root: DEMO_REPO, symbol: 'X', targets: ['src'], options: searchOptions() };

  it('omits every optional flag by default', () => {
    const args = buildRipgrepArgs(base);

    expect(args).not.toContain('--ignore-case');
    expect(args).not.toContain('--word-regexp');
    expect(args).not.toContain('--glob');
    expect(args).toContain('--fixed-strings');
  });

  it('adds --ignore-case only when asked', () => {
    expect(buildRipgrepArgs({ ...base, options: searchOptions({ ignoreCase: true }) })).toContain('--ignore-case');
  });

  it('adds --word-regexp only when asked', () => {
    expect(buildRipgrepArgs({ ...base, options: searchOptions({ word: true }) })).toContain('--word-regexp');
  });

  it('passes one --regexp per pattern, in order', () => {
    const args = buildRipgrepArgs(base, ['alpha', 'bravo']);
    const patterns = args.filter((_, index) => args[index - 1] === '--regexp');

    expect(patterns).toEqual(['alpha', 'bravo']);
  });
});

describe('scanning details', () => {
  it('counts adjacent matches without skipping a character', () => {
    const result = scanContent('aaaa', 'a.ts', buildJsRegExp('aa', searchOptions()));
    expect(result.count).toBe(2);
  });

  it('reports the whole line when the match starts the line', () => {
    const result = scanContent('first\nGone = 1;\n', 'a.ts', buildJsRegExp('Gone', searchOptions()));

    expect(result.locations[0]).toMatchObject({ line: 2, column: 1, text: 'Gone = 1;' });
  });

  it('keeps a line exactly at the snippet limit intact', () => {
    const line = `${'x'.repeat(196)}Gone`;
    const result = scanContent(line, 'a.ts', buildJsRegExp('Gone', searchOptions()));

    expect(line).toHaveLength(200);
    expect(result.locations[0]?.text).toBe(line);
    expect(result.locations[0]?.text).not.toContain('…');
  });

  it('truncates one character past the limit', () => {
    const line = `${'x'.repeat(197)}Gone`;
    const result = scanContent(line, 'a.ts', buildJsRegExp('Gone', searchOptions()));

    expect(line).toHaveLength(201);
    expect(result.locations[0]?.text).toHaveLength(201);
    expect(result.locations[0]?.text.endsWith('…')).toBe(true);
  });

  it('sorts snippets by line number', () => {
    const content = ['Gone', 'x', 'Gone', 'x', 'Gone'].join('\n');
    const result = scanContent(content, 'a.ts', buildJsRegExp('Gone', searchOptions()));

    expect(result.locations.map((location) => location.line)).toEqual([1, 3, 5]);
  });

  it('only inspects the first 8KB when deciding a file is binary', async () => {
    // A NUL byte this far in is past the sniff window, so the file is text.
    const late = Buffer.concat([
      Buffer.from(`${'a'.repeat(9000)}\nLateSymbol\n`, 'utf8'),
      Buffer.from([0]),
      Buffer.from('\ntail\n', 'utf8'),
    ]);
    const root = await repo({ 'src/late.bin': late, 'src/early.bin': Buffer.from([0, 1, 2, 69, 97, 114, 108, 121]) });

    const result = await javascriptEngine.search({
      root,
      symbol: 'LateSymbol',
      targets: ['src'],
      options: searchOptions(),
    });

    expect(result.count).toBe(1);
  });
});

/* ---------------------------------------------------------------- glob.ts */

describe('glob details', () => {
  it('keeps the final segment out of the static base', () => {
    expect(globBase('docs/adr/index.md')).toEqual({ base: 'docs/adr', rest: 'index.md' });
    expect(globBase('index.md')).toEqual({ base: '', rest: 'index.md' });
    expect(globBase('a/b/c/d.md')).toEqual({ base: 'a/b/c', rest: 'd.md' });
  });

  it('negates a character class only when it starts with !', () => {
    expect(globToRegExp('[ab].ts').test('a.ts')).toBe(true);
    expect(globToRegExp('[ab].ts').test('c.ts')).toBe(false);
    expect(globToRegExp('[!ab].ts').test('a.ts')).toBe(false);
    expect(globToRegExp('[!ab].ts').test('c.ts')).toBe(true);
  });

  it('reads ** only when both stars are adjacent', () => {
    expect(globToRegExp('a**b').test('axxb')).toBe(true);
    expect(globToRegExp('a*b').test('a/b')).toBe(false);
    expect(globToRegExp('**/a.ts').test('deep/nested/a.ts')).toBe(true);
    expect(globToRegExp('**/a.ts').test('a.ts')).toBe(true);
  });

  it('only appends ** for a trailing slash', () => {
    expect(createGlobMatcher(['src/'])('src/deep/a.ts')).toBe(true);
    expect(createGlobMatcher(['src'])('src/deep/a.ts')).toBe(false);
    expect(createGlobMatcher(['src'])('src')).toBe(true);
  });

  it('walks a directory whose entries are not returned in order', async () => {
    const root = await repo({ 'zebra.ts': '', 'alpha.ts': '', 'middle.ts': '' });
    const found = [];
    for await (const file of walkFiles(root)) found.push(file.relativePath);

    expect(found).toEqual(['alpha.ts', 'middle.ts', 'zebra.ts']);
  });
});

/* -------------------------------------------------------------- parser.ts */

describe('fence handling', () => {
  it('does not let a tilde fence close a backtick fence', () => {
    const source = [
      `${fence}md`,
      '~~~',
      '<!-- @assert-absence target="src" symbol="Documented" -->',
      '~~~',
      fence,
      '',
      '<!-- @assert-present file="real.md" -->',
    ].join('\n');

    const { directives, errors } = parseDirectives(source, parseContext);

    expect(errors).toEqual([]);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.kind).toBe('assert-present');
  });

  it('requires the closing fence to be at least as long as the opening one', () => {
    const source = [
      '````md',
      fence,
      '<!-- @assert-absence target="src" symbol="Documented" -->',
      fence,
      '````',
      '',
      '<!-- @assert-present file="real.md" -->',
    ].join('\n');

    const { directives } = parseDirectives(source, parseContext);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.kind).toBe('assert-present');
  });

  it('resumes parsing directly after a closed code span', () => {
    const source = '`code` <!-- @assert-present file="real.md" -->';
    const { directives } = parseDirectives(source, parseContext);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.location.column).toBe(8);
  });

  it('reports the column of a directive that does not start the line', () => {
    const source = 'text <!-- @assert-present file="real.md" -->';
    expect(parseDirectives(source, parseContext).directives[0]?.location.column).toBe(6);
  });
});

/* ---------------------------------------------------------------- cli.ts */

describe('spec file discovery', () => {
  it('resolves patterns against --root, not the working directory', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-present file="docs/a.md" -->\n' });
    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.specFiles).toEqual(['docs/a.md']);
    expect(report.root).toBe(path.resolve(root));
    expect(report.ok).toBe(true);
  });
});
