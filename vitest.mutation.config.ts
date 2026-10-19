import { relative } from 'node:path';

import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * The order a mutant's test files run in: a file that failed in the worker's
 * last run first, as vitest has it, then the quickest first, where vitest
 * runs the longest first.
 *
 * Stryker runs a mutant's files one after another in one worker and stops at
 * the first test that fails. A static mutant runs every file, so what it
 * costs is the files that run before the one that kills it. Vitest's order
 * suits a run that reports every failure and wants the long files started
 * early; here it puts `tests/watch-equivalence.test.ts`,
 * `tests/glob-core.test.ts`, `tests/cites.test.ts` and `tests/impact.test.ts`,
 * half the suite's seconds between them, ahead of the file that kills the
 * mutant in milliseconds. In main's sweep of d498e24 one static mutant in
 * seven, 294 of 2,109, was killed only after other files had run, 1,189 of
 * the suite's 3,968 tests on average (ADR-0003, amended 2026-10-11).
 *
 * No test leaves the run and none is added: a mutant survives when every
 * file has passed, in any order. Two sweeps in this order left the survivors
 * of the two before them and one more, a mutant recorded as equivalent that
 * a test's 30-second clock had been killing, and their eight shards took 67
 * and 71 minutes where they had taken 103 and 106: about a fifth less once
 * the runners each drew are taken out.
 *
 * A file the worker has not run yet has no time to go by. It runs after
 * those that have, the smaller first, and has a time from then on.
 */
export class QuickestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { cache, config } = this.ctx;
    const rank = (file: TestSpecification): [number, number] => {
      // The key vitest's own sequencer reads its cache by; a test holds the two together.
      const key = `${file.project.name}:${relative(config.root, file.moduleId).replaceAll('\\', '/')}`;
      const last = cache.getFileTestResults(key);
      if (last === undefined) return [2, cache.getFileStats(key)?.size ?? 0];
      return [last.failed ? 0 : 1, last.duration];
    };
    const ranked = files.map((file) => ({ file, rank: rank(file) }));
    return ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map(({ file }) => file);
  }
}

/**
 * Vitest configuration for mutation runs.
 *
 * The normal one, less four suites, with the order above, a shorter
 * timeout and a reporter named. Two of the suites read the build, which a
 * mutation run does not have. The end-to-end suite spawns
 * `node bin/spec-guard.js`, which loads the *built* dist/ rather than the
 * mutated source, so it can never kill a mutant and would only add
 * process-spawn time to every single mutant run. The suite that holds the
 * replay scripts to the source (tests/replay-scripts.test.ts) runs one of them
 * against dist/ too, and reads `src/parser.ts` as text: in Stryker's sandbox
 * that file carries every mutant of every pattern at once, none of which is on
 * the script's table.
 *
 * The third, tests/mutation-order.test.ts, holds the order above. It reaches
 * nothing under `src/`, so it can kill no mutant, and it loads this file and
 * vitest's own sequencer with it, which every static mutant that survives
 * would wait for.
 *
 * The fourth, tests/mutation-unmeasured.test.ts, holds the count of what a
 * sweep does not read. It counts in `src/` as text, where the sandbox has
 * every mutant written at once, and it loads Stryker's instrumenter.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e.test.ts', 'tests/replay-scripts.test.ts', 'tests/mutation-order.test.ts', 'tests/mutation-unmeasured.test.ts', 'tests/fixtures/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { sequencer: QuickestFirst },
    // Named, so that vitest adds none of its own. A suite that names none
    // gets vitest's github-actions reporter beside the default one on a
    // runner. It appends a summary of each run to the step's, about 200
    // bytes a mutant: some 2,570 of them in the largest shard of main's sweep
    // of 3b65529. And it writes an `::error` command for each failed test to
    // the worker's output, which Stryker logs for a worker that exits
    // unexpectedly, and GitHub makes an annotation of each: shard 3 of that
    // sweep passed with two of them (run 39136659069). The default reporter
    // writes to the worker's output, as it did.
    reporters: ['default'],
  },
});
