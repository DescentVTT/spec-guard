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
  // measures (88.56%; the local Windows figure is higher because more mutants
  // hang there) so that losing ground fails the build, while ordinary
  // refactoring does not trip it.
  thresholds: { high: 90, low: 80, break: 87 },
};
