import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
