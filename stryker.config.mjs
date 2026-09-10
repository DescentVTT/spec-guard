// @ts-check
/**
 * Mutation testing configuration.
 *
 * Coverage says a line ran; mutation testing says a line's behaviour is
 * actually pinned down by an assertion. For a tool whose whole premise is
 * "assertions that really catch drift", that distinction is the product.
 *
 * See docs/adr/0003-mutation-testing.md for why vitest is pinned to 4.x.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',

  // The e2e suite is excluded: it spawns `node bin/spec-guard.js`, which loads
  // the built dist/ rather than the mutated source, so it can never kill a
  // mutant and would only add process-spawn time to every run.
  vitest: { configFile: 'vitest.mutation.config.ts' },

  // perTest is what makes this practical: ~12 relevant tests per mutant
  // instead of all 248.
  coverageAnalysis: 'perTest',

  // types.ts is type-only and index.ts is pure re-exports: nothing to mutate.
  mutate: ['src/**/*.ts', '!src/types.ts', '!src/index.ts'],

  // Stryker's sandbox rewrites relative paths in a tsconfig that reaches
  // outside the project. Ours does not (no external `extends` or
  // `references`), and the rewriter calls ts.parseConfigFileTextToJson, which
  // TypeScript 7's native port no longer exposes. Pointing it at a file that
  // is not part of the project makes that step a no-op.
  tsconfigFile: 'tsconfig.stryker-noop.json',

  // Stryker prepends "// @ts-nocheck" to every file it copies, because a
  // mutant can easily produce a type error. Its default glob covers tests/ as
  // well, which rewrites the fixture codebase and shifts every line number the
  // suite asserts on. Only the mutated sources need it.
  disableTypeChecks: 'src/**/*.ts',

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  clearTextReporter: { allowColor: false, maxTestsToLog: 0 },

  // Deliberately generous. Stryker counts a timeout as a kill, so this value is
  // a dial that silently sets the score: dropping it from 60s to 15s moved 220
  // mutants from "survived" to "timed out" and lifted the score from 88.76% to
  // 94.48% without adding a single test. Those mutants finish inside 60s and
  // the suite passes when they do, so they had survived - the shorter clock was
  // just calling slow code dead. 60s is roughly five times the whole suite, so
  // reaching it means a mutant genuinely hangs.
  timeoutMS: 60000,
  concurrency: 8,
  // `break` is a regression guard, not an aspiration: it sits below the score CI
  // measures so that losing ground fails the build, while ordinary refactoring
  // does not trip it.
  //
  // Re-anchored to 89 in 0.5.1 against a CI measurement of 89.84%. The move from
  // 85 is almost entirely one file: src/imports.ts went from 73.74% to 92.42%
  // once the tokenizer was tested as a thing with an output rather than as a
  // step towards a list of module references. Every file is now above 83%,
  // where the spread used to run from 73% to 96%.
  //
  // 0.84 of headroom, in line with the 0.61 and 0.63 used for the previous two
  // settings: tight enough that a marginal regression trips it. If run-to-run
  // variance trips it instead, the honest fix is to lower it again with that
  // evidence recorded, not to widen it now against a problem that has not
  // happened. See ADR-0003.
  thresholds: { high: 90, low: 80, break: 89 },
};
