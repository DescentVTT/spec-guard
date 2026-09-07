/**
 * The `exclude` attribute.
 *
 * The centrepiece here is the parity matrix. ripgrep's `-g !pattern` follows
 * gitignore rules - a bare name matches a directory at any depth, and a
 * directory match takes everything under it - while the include matcher used
 * for `glob` compares basenames. Wire `exclude` to both naively and the two
 * engines disagree on exactly the patterns people write most (`tests`,
 * `src/config`), producing different counts for the same assertion rather than
 * a failure anyone would notice.
 */

import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { javascriptEngine, resolveEngine, resetRipgrepProbe, type SearchRequest } from '../src/engine.js';
import { createExcludeMatcher } from '../src/glob.js';
import { parseDirectives } from '../src/parser.js';
import { resolveDirective, runSpecGuard } from '../src/runner.js';
import type { Directive } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

afterAll(() => {
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

/** One tree shared by the parity cases, covering every shape of exclusion. */
let treeOnce: Promise<string> | undefined;

function tree(): Promise<string> {
  treeOnce ??= makeTempRepo({
    'src/config/secrets.ts': 'const a = process.env.TOKEN;\n',
    'src/config/nested/deep.ts': 'const b = process.env.TOKEN;\n',
    'src/core/service.ts': 'const c = process.env.TOKEN;\n',
    'src/core/service.test.ts': 'const d = process.env.TOKEN;\n',
    'src/ui/widget.tsx': 'const e = process.env.TOKEN;\n',
    'tests/helper.ts': 'const f = process.env.TOKEN;\n',
    'src/tests/inner.ts': 'const g = process.env.TOKEN;\n',
  });
  return treeOnce;
}

afterAll(async () => {
  if (!treeOnce) return;
  const root = await treeOnce;
  treeOnce = undefined;
  await removeTempRepo(root);
});

function request(root: string, excludeGlobs: string[], globs: string[] = []): SearchRequest {
  return {
    root,
    symbol: 'process.env',
    targets: ['.'],
    options: searchOptions({ excludeGlobs, globs }),
  };
}

/** Every file in the tree contains exactly one match, so counts are file counts. */
const TOTAL = 7;

const cases: Array<{ name: string; exclude: string[]; globs?: string[]; expected: number }> = [
  { name: 'nothing excluded', exclude: [], expected: TOTAL },
  // A bare name is a directory at any depth: both tests/ and src/tests/ go.
  { name: 'bare directory name', exclude: ['tests'], expected: TOTAL - 2 },
  // An anchored path takes the directory and everything under it.
  { name: 'anchored directory', exclude: ['src/config'], expected: TOTAL - 2 },
  { name: 'anchored directory with /**', exclude: ['src/config/**'], expected: TOTAL - 2 },
  { name: 'anchored directory with trailing slash', exclude: ['src/config/'], expected: TOTAL - 2 },
  { name: 'file extension anywhere', exclude: ['*.test.ts'], expected: TOTAL - 1 },
  { name: 'a single file', exclude: ['src/core/service.ts'], expected: TOTAL - 1 },
  { name: 'several patterns at once', exclude: ['src/config', 'tests', '*.test.ts'], expected: TOTAL - 5 },
  { name: 'a pattern matching nothing', exclude: ['does/not/exist/**'], expected: TOTAL },
  // *.ts matches six of the seven files (widget.tsx is not one), and excluding
  // src/config removes two of those.
  { name: 'exclude combined with an include glob', exclude: ['src/config'], globs: ['*.ts'], expected: 4 },
  { name: 'everything excluded', exclude: ['**'], expected: 0 },
];

describe.each(rgPath ? ['javascript', 'ripgrep'] : ['javascript'])('%s engine', (engineName) => {
  it.each(cases)('$name -> $expected files', async ({ exclude, globs, expected }) => {
    process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
    resetRipgrepProbe();
    const engine = await resolveEngine(engineName === 'ripgrep' ? 'ripgrep' : 'javascript');

    const result = await engine.search(request(await tree(), exclude, globs ?? []));
    expect(result.count).toBe(expected);
  });
});

describe.runIf(rgPath)('parity', () => {
  it.each(cases)('both engines agree on $name', async ({ exclude, globs }) => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    const query = request(await tree(), exclude, globs ?? []);

    const [fromJs, fromRipgrep] = await Promise.all([
      javascriptEngine.search(query),
      (await resolveEngine('ripgrep')).search(query),
    ]);

    expect(fromJs.count).toBe(fromRipgrep.count);
    expect(fromJs.matches.map((match) => match.file)).toEqual(
      fromRipgrep.matches.map((match) => match.file),
    );
  });
});

describe('createExcludeMatcher', () => {
  it('excludes nothing when given no patterns', () => {
    expect(createExcludeMatcher([])('anything.ts')).toBe(false);
  });

  it.each([
    ['tests', 'tests/a.ts', true],
    ['tests', 'src/tests/a.ts', true],
    ['tests', 'src/tests.ts', false],
    ['tests', 'src/core/a.ts', false],
    ['src/config', 'src/config/a.ts', true],
    ['src/config', 'src/config/deep/a.ts', true],
    ['src/config', 'src/configuration/a.ts', false],
    ['src/config', 'other/src/config/a.ts', false],
    ['*.test.ts', 'src/a.test.ts', true],
    ['*.test.ts', 'src/a.ts', false],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['**', 'anything/at/all.ts', true],
  ])('pattern %s against %s is %s', (pattern, file, expected) => {
    expect(createExcludeMatcher([pattern])(file)).toBe(expected);
  });

  it('excludes a path matching any one of several patterns', () => {
    const matcher = createExcludeMatcher(['tests', 'src/config']);
    expect(matcher('tests/a.ts')).toBe(true);
    expect(matcher('src/config/a.ts')).toBe(true);
    expect(matcher('src/core/a.ts')).toBe(false);
  });
});

describe('directive syntax', () => {
  function directive(attributes: Record<string, string>): Directive {
    return {
      kind: 'assert-absence',
      attributes,
      raw: '<!-- @assert-absence -->',
      location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
    };
  }

  function excludeGlobsOf(value: string): string[] {
    const resolved = resolveDirective(directive({ symbol: 'X', exclude: value }), {
      root: process.cwd(),
      excludeFiles: new Set<string>(),
    });
    if (!('assertion' in resolved)) throw new Error('expected an assertion');
    return resolved.assertion.search?.excludeGlobs ?? [];
  }

  it.each([
    ['src/config/**', ['src/config/**']],
    ['src/config/**,tests/**', ['src/config/**', 'tests/**']],
    ['src/config/**, tests/**', ['src/config/**', 'tests/**']],
    ['src/config/** tests/**', ['src/config/**', 'tests/**']],
    ['  src/config/**   tests/**  ', ['src/config/**', 'tests/**']],
    ['a, b c,d', ['a', 'b', 'c', 'd']],
  ])('splits %s into %j', (value, expected) => {
    expect(excludeGlobsOf(value)).toEqual(expected);
  });

  it('names the exclusions in the assertion description', () => {
    const resolved = resolveDirective(
      directive({ symbol: 'process.env', target: 'src', exclude: 'src/config/**' }),
      { root: process.cwd(), excludeFiles: new Set<string>() },
    );
    if (!('assertion' in resolved)) throw new Error('expected an assertion');

    expect(resolved.assertion.description).toBe(
      '"process.env" must not appear in src (excluding src/config/**)',
    );
  });

  it('says nothing about exclusions when there are none', () => {
    const resolved = resolveDirective(directive({ symbol: 'X', target: 'src' }), {
      root: process.cwd(),
      excludeFiles: new Set<string>(),
    });
    if (!('assertion' in resolved)) throw new Error('expected an assertion');

    expect(resolved.assertion.description).not.toContain('excluding');
  });

  it('is rejected on @assert-present, which has no search scope', () => {
    const source = '<!-- @assert-present file="a.md" exclude="src/**" -->';
    const { errors } = parseDirectives(source, { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md' });

    expect(errors[0]?.message).toContain('Unknown attribute "exclude"');
  });
});

describe('the flagship rule', () => {
  it('expresses "no secret outside src/config" as one assertion', async () => {
    const root = await makeTempRepo({
      'docs/adr.md':
        '<!-- @assert-absence target="src" symbol="process.env" exclude="src/config/**" reason="secrets load in one place" -->\n',
      'src/config/load.ts': 'export const token = process.env.TOKEN;\n',
      'src/core/service.ts': 'export const clean = 1;\n',
    });
    temporary.push(root);

    const passing = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    expect(passing.ok).toBe(true);
    expect(passing.results[0]?.actual).toBe(0);

    // A leak outside the allowed directory is what the rule is for.
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(path.join(root, 'src/core/service.ts'), 'const leak = process.env.SECRET;\n', 'utf8');

    const failing = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    expect(failing.ok).toBe(false);
    expect(failing.results[0]?.actual).toBe(1);
    expect(failing.results[0]?.matches[0]?.file).toBe('src/core/service.ts');
    expect(failing.results[0]?.description).toContain('(excluding src/config/**)');
  });

  it('keeps groups apart when only the exclusions differ', async () => {
    const root = await makeTempRepo({
      'docs/adr.md': [
        '<!-- @assert-count target="src" symbol="process.env" expected="2" -->',
        '<!-- @assert-count target="src" symbol="process.env" expected="1" exclude="src/config/**" -->',
        '',
      ].join('\n'),
      'src/config/load.ts': 'export const token = process.env.TOKEN;\n',
      'src/core/service.ts': 'export const other = process.env.OTHER;\n',
    });
    temporary.push(root);

    // Sharing an enumeration or a batch between these would give both the same
    // answer, and one of them would be wrong.
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.results.map((result) => result.actual)).toEqual([2, 1]);
    expect(report.ok).toBe(true);
  });
});
