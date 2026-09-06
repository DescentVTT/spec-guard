import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for mutation runs.
 *
 * Identical to the normal one except that the end-to-end suite is excluded:
 * those tests spawn `node bin/spec-guard.js`, which loads the *built* dist/
 * rather than the mutated source, so they can never kill a mutant and would
 * only add process-spawn time to every single mutant run.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
