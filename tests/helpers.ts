/**
 * Test helpers.
 *
 * Every path used by the suite lives under tests/fixtures/, including the
 * scratch repos: tests never write outside the project.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');
export const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');
export const DEMO_REPO = path.join(FIXTURES_DIR, 'demo-repo');
export const TEMP_ROOT = path.join(FIXTURES_DIR, '.tmp');

/** Absolute path to a real ripgrep binary, or null when none is installed. */
export function findTestRipgrep(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string };
    return rgPath;
    /* c8 ignore next 3 */
  } catch {
    return null;
  }
}

let counter = 0;

/** Creates a throwaway repo under tests/fixtures/.tmp and returns its path. */
export async function makeTempRepo(files: Record<string, string | Buffer>): Promise<string> {
  const root = path.join(TEMP_ROOT, `t${process.pid}-${Date.now().toString(36)}-${counter++}`);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (typeof content === 'string') {
      await fs.writeFile(target, content, 'utf8');
    } else {
      await fs.writeFile(target, content);
    }
  }
  await fs.mkdir(root, { recursive: true });
  return root;
}

export async function removeTempRepo(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
}

/** Convenience: an empty SearchOptions with the given overrides. */
export function searchOptions(overrides: Partial<import('../src/types.js').SearchOptions> = {}) {
  return {
    regex: false,
    word: false,
    ignoreCase: false,
    globs: [],
    excludeGlobs: [],
    excludeFiles: new Set<string>(),
    ...overrides,
  };
}
