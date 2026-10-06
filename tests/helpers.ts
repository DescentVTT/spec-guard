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

import { smallTreeBudget } from '../src/engine.js';
import { nodeIo, type DirectoryReader, type Io } from '../src/io.js';
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

/**
 * Creates a throwaway repo under tests/fixtures/.tmp and returns its path.
 *
 * Every directory is made once and every file written at once: one after
 * another, a tree of a few hundred files took long enough to fail a suite
 * running beside other work.
 */
export async function makeTempRepo(files: Record<string, string | Buffer>): Promise<string> {
  const root = path.join(TEMP_ROOT, `t${process.pid}-${Date.now().toString(36)}-${counter++}`);
  const entries = Object.entries(files).map(([relative, content]) => ({ target: path.join(root, relative), content }));
  const directories = new Set([root, ...entries.map(({ target }) => path.dirname(target))]);
  await Promise.all([...directories].map((directory) => fs.mkdir(directory, { recursive: true })));
  await Promise.all(entries.map(({ target, content }) => (typeof content === 'string' ? fs.writeFile(target, content, 'utf8') : fs.writeFile(target, content))));
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

/**
 * Files enough to put `prefix` past the adaptive engine's budget on every
 * platform, so that `auto` hands a search of it to ripgrep: one more than the
 * most files any platform scans in process (ADR-0004).
 *
 * By count and not by size. The budgets differ most in bytes, and megabytes
 * written for a test are time the suite does not have; a few hundred files of
 * one line are written at once.
 */
export function pastEveryBudget(prefix = 'src'): Record<string, string> {
  const most = Math.max(...(['win32', 'darwin', 'linux'] as const).map((platform) => smallTreeBudget(platform).maxFiles));
  return Object.fromEntries(Array.from({ length: most + 1 }, (_, index) => [`${prefix}/filler/f${index}.ts`, 'const padding = 1;\n']));
}

/** The filesystem, with every directory listing answered by `readDirectory`. */
export function reading(readDirectory: DirectoryReader): Io {
  return { ...nodeIo, readDirectory };
}

/**
 * A filesystem that exists only in memory, rooted at `root`.
 *
 * Its root is a path nothing on disk answers to, so a reader that went around
 * the door it was handed would find nothing there and change its answer.
 * `files` maps root-relative paths to contents; `directories` adds empty ones.
 */
export function memoryIo(root: string, files: Record<string, string | Buffer>, directories: readonly string[] = []): Io {
  type Node = { kind: 'file'; content: Buffer } | { kind: 'directory' };
  const nodes = new Map<string, Node>([[path.resolve(root), { kind: 'directory' }]]);
  const addDirectory = (absolute: string): void => {
    for (let current = absolute; !nodes.has(current); current = path.dirname(current)) {
      nodes.set(current, { kind: 'directory' });
    }
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.resolve(root, relative);
    addDirectory(path.dirname(absolute));
    nodes.set(absolute, { kind: 'file', content: Buffer.from(content) });
  }
  for (const directory of directories) addDirectory(path.resolve(root, directory));

  const missing = (target: string): Error => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  const nodeAt = (target: string): Node | undefined => nodes.get(path.resolve(target));

  return {
    async readDirectory(directory) {
      const absolute = path.resolve(directory);
      if (nodeAt(absolute)?.kind !== 'directory') throw missing(directory);
      return [...nodes]
        .filter(([candidate]) => candidate !== absolute && path.dirname(candidate) === absolute)
        .map(([candidate, node]) => ({
          name: path.basename(candidate),
          isDirectory: () => node.kind === 'directory',
          isFile: () => node.kind === 'file',
          isSymbolicLink: () => false,
        })) as never;
    },
    async stat(target) {
      const node = nodeAt(target);
      if (!node) return null;
      return {
        isDirectory: () => node.kind === 'directory',
        isFile: () => node.kind === 'file',
        size: node.kind === 'file' ? node.content.length : 0,
      } as never;
    },
    async readFile(file) {
      const node = nodeAt(file);
      if (node?.kind !== 'file') throw missing(file);
      return node.content;
    },
    async realpath(target) {
      if (!nodeAt(target)) throw missing(target);
      return path.resolve(target);
    },
  };
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
