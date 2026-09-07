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
      // Floors, not targets. The remainder is defensive error handling that
      // only a broken ripgrep or an unreadable directory can reach, plus a few
      // POSIX-only paths (chmod, file symlinks) that skip on Windows.
      thresholds: {
        lines: 97,
        statements: 96,
        functions: 94,
        branches: 90,
      },
    },
  },
});
