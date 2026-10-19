/**
 * The order the mutation sweep runs a mutant's test files in
 * (vitest.mutation.config.ts): the file that failed last, then the quickest.
 *
 * The order reads what vitest recorded of each file's last run, by the key
 * vitest files it under. A key vitest stopped using would find nothing, every
 * file would count as never run, and the sweep would quietly go by size, at
 * the cost the order was written to remove and with nothing failing. So the
 * keys are held here to those vitest's own sequencer asks for, in the version
 * installed.
 *
 * What the sweep reports is held here too, as vitest resolves it from the
 * same file.
 *
 * Not part of a mutation run: it reaches nothing under `src/`, and no mutant
 * is under the order.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { BaseSequencer, resolveConfig, type TestSpecification, type Vitest } from 'vitest/node';

import unitSuite from '../vitest.config.js';
import mutationSuite, { QuickestFirst } from '../vitest.mutation.config.js';

// What a worker knows of each file after its last run, by the key vitest
// files it under: this repository's two longest files and two of its
// shortest. The long ones take more milliseconds than the smallest file has
// bytes, so a file never run cannot pass for a quick one by its size.
const TIMED: Record<string, { duration: number; failed: boolean }> = {
  ':tests/watch-equivalence.test.ts': { duration: 6_900, failed: false },
  ':tests/glob-core.test.ts': { duration: 6_000, failed: false },
  ':tests/scope.test.ts': { duration: 10, failed: false },
  ':tests/text.test.ts': { duration: 8, failed: false },
};
// The files as vitest finds them, by their bytes; two the worker has not run.
const SIZES: Record<string, number> = {
  ':tests/watch-equivalence.test.ts': 41_000,
  ':tests/glob-core.test.ts': 96_000,
  ':tests/cli.test.ts': 14_000,
  ':tests/scope.test.ts': 7_000,
  ':tests/text.test.ts': 5_000,
  ':tests/specs.test.ts': 4_000,
};
const FOUND = Object.keys(SIZES).map((key) => key.slice(1));

function worker(timed: typeof TIMED, found = FOUND, root = '/work/spec-guard') {
  const asked: string[] = [];
  const ctx = {
    config: { root, shard: { index: 1, count: 2 } },
    cache: {
      getFileTestResults: (key: string) => {
        asked.push(key);
        return timed[key];
      },
      getFileStats: (key: string) => (key in SIZES ? { size: SIZES[key]! } : undefined),
    },
  } as unknown as Vitest;
  const files = found.map(
    (file) => ({ moduleId: `${root}/${file}`, project: { name: '', config: { isolate: true, sequence: { groupOrder: 0 } } } }) as unknown as TestSpecification,
  );
  return { ctx, files, asked };
}

const names = (files: TestSpecification[]) => files.map((file) => /tests\/(.+)\.test\.ts$/.exec(file.moduleId)![1]);

/**
 * The reporters vitest gives a run of a suite on a GitHub runner, where every
 * step has GITHUB_ACTIONS set to true, resolved by vitest itself, as Stryker's
 * runner has it resolve them: it names none of its own.
 */
async function onARunner(suite: typeof unitSuite): Promise<string[]> {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  try {
    const { vitestConfig } = await resolveConfig({ ...suite.test, config: false, root: resolve(import.meta.dirname, '..') });
    return vitestConfig.reporters.map((reporter) => (Array.isArray(reporter) ? String(reporter[0]) : 'inline'));
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("the order a mutant's test files run in", () => {
  it('runs the quickest file first, and a file the worker has not timed after those it has, the smaller first', async () => {
    const { ctx, files } = worker(TIMED);
    const order = names(await new QuickestFirst(ctx).sort(files));
    expect(order).toEqual(['text', 'scope', 'glob-core', 'watch-equivalence', 'specs', 'cli']);
    expect(names(await new QuickestFirst(ctx).sort([...files].reverse()))).toEqual(order);
  });

  it('runs a file that failed in the last run before any that passed, however long it takes', async () => {
    const failed = { ...TIMED, ':tests/watch-equivalence.test.ts': { duration: 6_900, failed: true } };
    const { ctx, files } = worker(failed);
    expect(names(await new QuickestFirst(ctx).sort(files))).toEqual(['watch-equivalence', 'text', 'scope', 'glob-core', 'specs', 'cli']);
  });

  it('differs from the order vitest would give in that alone, and reads what vitest recorded by the keys vitest reads', async () => {
    const failed = { ...TIMED, ':tests/scope.test.ts': { duration: 10, failed: true } };
    const timed = Object.keys(TIMED).map((key) => key.slice(1));

    // A checkout on Windows has a drive in its root, and vitest writes both
    // with forward slashes.
    for (const root of ['/work/spec-guard', 'C:/work/spec-guard']) {
      // Vitest's own: the failed file, then the longest, which is why a mutant
      // that a short file kills waited for the long ones.
      const theirs = worker(failed, timed, root);
      expect(names(await new BaseSequencer(theirs.ctx).sort(theirs.files))).toEqual(['scope', 'watch-equivalence', 'glob-core', 'text']);
      const ours = worker(failed, timed, root);
      expect(names(await new QuickestFirst(ours.ctx).sort(ours.files))).toEqual(['scope', 'text', 'glob-core', 'watch-equivalence']);

      expect(new Set(ours.asked)).toEqual(new Set(theirs.asked));
      expect(new Set(ours.asked)).toEqual(new Set(Object.keys(TIMED)));
    }
  });

  it('gives a shard of the suite the files vitest gives it', async () => {
    const { ctx, files } = worker(TIMED);
    const theirs = names(await new BaseSequencer(ctx).shard(files));
    expect(theirs).toHaveLength(3);
    expect(names(await new QuickestFirst(ctx).shard(files))).toEqual(theirs);
  });
});

describe('this repository', () => {
  it('gives the order to the sweep, both tiers of it, and leaves `npm test` with vitest\'s own', async () => {
    // One Stryker configuration serves the full sweep and a pull request's
    // incremental one; each shard spreads it (stryker.shard.config.mjs).
    const stryker = ((await import(pathToFileURL(resolve('stryker.config.mjs')).href)) as { default: { vitest: unknown } }).default;
    expect(stryker.vitest).toEqual({ configFile: 'vitest.mutation.config.ts', related: false });
    expect(mutationSuite.test?.sequence).toEqual({ sequencer: QuickestFirst });

    // `npm test` reports every failure and runs its files side by side: the
    // long files started early is the right order there.
    expect(unitSuite.test?.sequence).toBeUndefined();
  });

  it("names the sweep's reporter, and leaves `npm test` with those vitest gives it", () => {
    expect(mutationSuite.test?.reporters).toEqual(['default']);
    expect(unitSuite.test?.reporters).toBeUndefined();
  });

  it("has the sweep report through vitest's default reporter alone on a runner, so that no mutant's run adds a summary or an annotation", async () => {
    // Where a suite names none, vitest adds its github-actions reporter on a
    // runner: it appended a summary of every run to the step's own, some
    // 2,570 of them in the largest shard of main's sweep of 3b65529, and its
    // `::error` commands in a crashed worker's output became two annotations
    // on shard 3 of that sweep, which passed (vitest.mutation.config.ts).
    expect(await onARunner(mutationSuite)).toEqual(['default']);
    // The suite `npm test` runs keeps the annotations and the summary vitest
    // gives a run on a runner.
    expect(await onARunner(unitSuite)).toContain('github-actions');
  });

  it('adds no test to a mutation run and takes none out of it but the four that can kill nothing', () => {
    expect(mutationSuite.test?.include).toEqual(unitSuite.test?.include);
    expect(mutationSuite.test?.exclude).toEqual([
      'tests/e2e.test.ts',
      'tests/replay-scripts.test.ts',
      'tests/mutation-order.test.ts',
      'tests/mutation-unmeasured.test.ts',
      ...unitSuite.test!.exclude!,
    ]);
  });
});
