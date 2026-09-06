/**
 * Behaviour of the `auto` engine.
 *
 * The whole point of the adaptive engine is that it changes *which* engine runs
 * without changing *what* it answers, so these tests do two things: pin the
 * choice it makes at each end of the budget, and assert that the answer is
 * identical whichever way the choice went.
 */

import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  enumerateCandidates,
  javascriptEngine,
  resolveEngine,
  resetRipgrepProbe,
  SMALL_TREE_BUDGET,
  type SearchRequest,
} from '../src/engine.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { DEMO_REPO, findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;
const temporary: string[] = [];

afterAll(cleanUpBigRepo);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/**
 * A tree comfortably past SMALL_TREE_BUDGET on every platform (the Windows
 * budget is 1MB). Built once and shared: the tests only read it, and rebuilding
 * a megabyte per test made the suite four times slower.
 */
let bigRepoOnce: Promise<string> | undefined;

function bigRepo(): Promise<string> {
  bigRepoOnce ??= (async () => {
    const filler = 'const padding = 1;\n'.repeat(20_000);
    const root = await makeTempRepo({
      'src/a.ts': filler,
      'src/b.ts': filler,
      'src/c.ts': `${filler}export class Needle {}\n`,
    });
    return root;
  })();
  return bigRepoOnce;
}

async function cleanUpBigRepo(): Promise<void> {
  if (!bigRepoOnce) return;
  const root = await bigRepoOnce;
  bigRepoOnce = undefined;
  await removeTempRepo(root);
}

function query(root: string, symbol = 'Needle', overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { root, symbol, targets: ['src'], options: searchOptions(), ...overrides };
}

describe('enumerateCandidates', () => {
  it('lists every candidate when given no budget', async () => {
    const root = await repo({ 'src/a.ts': 'x', 'src/b.ts': 'x', 'src/c.ts': 'x' });
    const enumeration = await enumerateCandidates(query(root));

    expect(enumeration.exceeded).toBe(false);
    expect(enumeration.files.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(enumeration.bytes).toBe(3);
  });

  it('abandons the walk once the file budget is passed', async () => {
    const root = await repo(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${i}.ts`, 'x'])));
    const enumeration = await enumerateCandidates(query(root), { maxFiles: 4, maxBytes: 1024 });

    expect(enumeration.exceeded).toBe(true);
    expect(enumeration.files.length).toBeLessThanOrEqual(5);
  });

  it('abandons the walk once the byte budget is passed', async () => {
    const root = await repo({ 'src/a.ts': 'x'.repeat(200), 'src/b.ts': 'x'.repeat(200) });
    const enumeration = await enumerateCandidates(query(root), { maxFiles: 1000, maxBytes: 100 });

    expect(enumeration.exceeded).toBe(true);
  });

  it('reports a tree exactly at the budget as fitting', async () => {
    const root = await repo({ 'src/a.ts': 'xx', 'src/b.ts': 'xx' });
    const enumeration = await enumerateCandidates(query(root), { maxFiles: 2, maxBytes: 4 });

    expect(enumeration.exceeded).toBe(false);
    expect(enumeration.files).toHaveLength(2);
  });

  it('honours glob filters and exclusions while enumerating', async () => {
    const root = await repo({ 'src/a.ts': 'x', 'src/b.js': 'x', 'src/c.ts': 'x' });

    const globbed = await enumerateCandidates(query(root, 'x', { options: searchOptions({ globs: ['*.ts'] }) }));
    expect(globbed.files.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/c.ts']);

    const excluded = await enumerateCandidates(
      query(root, 'x', {
        options: searchOptions({ excludeFiles: new Set([path.resolve(root, 'src/a.ts')]) }),
      }),
    );
    expect(excluded.files.map((file) => file.relativePath)).toEqual(['src/b.js', 'src/c.ts']);
  });
});

describe('engine selection', () => {
  it('scans a small tree in process even when ripgrep is installed', async () => {
    process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
    resetRipgrepProbe();
    const engine = await resolveEngine('auto');
    const result = await engine.search(query(DEMO_REPO, 'UserSessionManager'));

    expect(result.engine).toBe('javascript');
    expect(result.count).toBe(1);
  });

  it.runIf(rgPath)('hands a big tree to ripgrep', async () => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    const engine = await resolveEngine('auto');
    const result = await engine.search(query(await bigRepo()));

    expect(result.engine).toBe('ripgrep');
    expect(result.count).toBe(1);
  });

  it('decides per group, not once per run', async () => {
    process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
    resetRipgrepProbe();
    const root = await bigRepo();
    const engine = await resolveEngine('auto');

    // A single file is under budget; the whole of src/ is over it.
    const single = await engine.search(query(root, 'Needle', { targets: ['src/c.ts'] }));
    expect(single.engine).toBe('javascript');
    expect(single.count).toBe(1);

    const whole = await engine.search(query(root));
    expect(whole.count).toBe(1);
    if (rgPath) expect(whole.engine).toBe('ripgrep');
  });

  it('does not reuse an enumeration across different exclusions', async () => {
    // Same targets, different exclude sets: caching on targets alone would hand
    // the second search the first search's file list.
    const root = await repo({ 'src/a.ts': 'Needle\n', 'src/b.ts': 'Needle\n' });
    const engine = await resolveEngine('auto');

    const all = await engine.search(query(root));
    const partial = await engine.search(
      query(root, 'Needle', {
        options: searchOptions({ excludeFiles: new Set([path.resolve(root, 'src/a.ts')]) }),
      }),
    );

    expect(all.count).toBe(2);
    expect(partial.count).toBe(1);
    expect(partial.matches.map((match) => match.file)).toEqual(['src/b.ts']);
  });
});

describe('the choice never changes the answer', () => {
  const engines = rgPath ? (['javascript', 'ripgrep', 'auto'] as const) : (['javascript', 'auto'] as const);

  it.each(['docs/adr/0001-passing.md', 'docs/adr/0002-failing.md', 'docs/adr/0004-search-options.md'])(
    'reports %s identically under every engine setting',
    async (spec) => {
      process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
      resetRipgrepProbe();

      const reports: RunResult[] = [];
      for (const engine of engines) {
        reports.push(await runSpecGuard({ patterns: [spec], root: DEMO_REPO, engine }));
      }

      const shape = (report: RunResult) =>
        report.results.map((result) => ({
          ok: result.ok,
          actual: result.actual,
          message: result.message,
          matches: result.matches,
        }));

      const [reference] = reports as [RunResult, ...RunResult[]];
      for (const report of reports.slice(1)) {
        expect(shape(report)).toEqual(shape(reference));
        expect(report.summary).toEqual(reference.summary);
      }
    },
  );

  it.runIf(rgPath)('agrees with both engines on a tree that crosses the budget', async () => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    const root = await bigRepo();
    const request = query(root);

    const adaptive = await (await resolveEngine('auto')).search(request);
    const js = await javascriptEngine.search(request);
    const rg = await (await resolveEngine('ripgrep')).search(request);

    expect(adaptive.count).toBe(js.count);
    expect(adaptive.count).toBe(rg.count);
    expect(adaptive.matches).toEqual(js.matches);
    expect(adaptive.matches).toEqual(rg.matches);
  });
});

describe('SMALL_TREE_BUDGET', () => {
  it('is larger on Windows, where spawning a process costs more', () => {
    expect(SMALL_TREE_BUDGET.maxFiles).toBeGreaterThan(0);
    expect(SMALL_TREE_BUDGET.maxBytes).toBeGreaterThan(0);
    expect(SMALL_TREE_BUDGET.maxFiles).toBe(process.platform === 'win32' ? 512 : 32);
  });
});
