import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Scratch repositories live under tests/fixtures/.tmp and can contain files
    // named *.test.ts. Vitest would collect them and fail with "no test suite
    // found" - a broken run caused by leftovers from a previous one.
    exclude: ['tests/fixtures/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is type-only: it compiles to an empty module.
      exclude: ['src/types.ts'],
      reporter: ['text', 'lcov'],
      // Floors, not targets - but a floor five points under the measurement is
      // not a floor. Re-anchored against 100% lines, 99.73% statements, 99.64%
      // functions and 98.02% branches, measured on Windows, which is the lower
      // of the two: the POSIX-only tests (chmod, file symlinks) skip there and
      // run in CI.
      //
      // What is left uncovered is branches, and specifically the ones a test
      // would have to manufacture a broken subprocess or an unreadable
      // filesystem to reach. Coverage is the weaker of the two measurements
      // this project keeps; the one that decides whether the tests are any good
      // is the mutation score, and ADR-0003 is where that argument lives.
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 99,
        branches: 97,
      },
    },
  },
});
