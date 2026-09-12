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

import { DEFAULT_SCOPE } from '../src/scope.js';

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

/**
 * A tree wide enough that walking it and abandoning it are different numbers.
 *
 * Exists for the cost contracts: an assertion that a probe reads two
 * directories says nothing on a repository that only has two. Here the file
 * count and the directory count are both known, so the bound can be stated
 * against the traversal it is supposed to be cheaper than.
 */
export function wideTree(directories: number, filesPerDirectory: number, prefix = 'src'): Record<string, string> {
  const files: Record<string, string> = {};
  for (let directory = 0; directory < directories; directory++) {
    const name = `d${String(directory).padStart(2, '0')}`;
    for (let file = 0; file < filesPerDirectory; file++) {
      files[`${prefix}/${name}/f${file}.ts`] = 'Widget\n';
    }
  }
  return files;
}

/** Convenience: an empty SearchOptions with the given overrides. */
export function searchOptions(overrides: Partial<import('../src/types.js').SearchOptions> = {}) {
  return {
    regex: false,
    word: false,
    ignoreCase: false,
    globs: [],
    excludeGlobs: [],
    ignoreComments: false,
    scope: DEFAULT_SCOPE,
    excludeFiles: new Set<string>(),
    ...overrides,
  };
}
