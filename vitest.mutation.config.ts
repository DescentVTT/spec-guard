import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for mutation runs.
 *
 * Identical to the normal one except for two suites that read the build, which
 * a mutation run does not have. The end-to-end suite spawns
 * `node bin/spec-guard.js`, which loads the *built* dist/ rather than the
 * mutated source, so it can never kill a mutant and would only add
 * process-spawn time to every single mutant run. The suite that holds the
 * replay scripts to the source (tests/replay-scripts.test.ts) runs one of them
 * against dist/ too, and reads `src/parser.ts` as text: in Stryker's sandbox
 * that file carries every mutant of every pattern at once, none of which is on
 * the script's table.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e.test.ts', 'tests/replay-scripts.test.ts', 'tests/fixtures/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
