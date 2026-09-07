/**
 * Ordering and escaping guarantees in the walker.
 *
 * The ordering test here exists because the obvious version of it is a false
 * green on Windows: NTFS returns directory entries already sorted, so deleting
 * `entries.sort(...)` changes nothing locally and the mutant survives. Feeding
 * the walker a deliberately unordered reader makes the guarantee testable
 * everywhere, which is the whole reason `readDirectory` is injectable.
 */

import type { Dirent } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { javascriptEngine } from '../src/engine.js';
import { compareDirents, expandSpecPatterns, globToRegExp, toPosix, walkFiles } from '../src/glob.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** A Dirent stand-in; only the four members the walker touches are real. */
function dirent(name: string, kind: 'file' | 'directory' = 'file'): Dirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
  } as unknown as Dirent;
}

describe('compareDirents', () => {
  it.each([
    ['a', 'b', -1],
    ['b', 'a', 1],
    ['a', 'a', 0],
    ['B', 'a', -1], // byte-wise: uppercase sorts first
    ['a10', 'a9', -1], // lexicographic, not numeric
  ])('orders %s against %s as %d', (left, right, expected) => {
    expect(compareDirents({ name: left }, { name: right })).toBe(expected);
  });

  it('produces a total order that Array#sort can rely on', () => {
    const names = ['zeta', 'Alpha', 'beta', 'alpha', 'Zeta'];
    const sorted = names.map((name) => ({ name })).sort(compareDirents);
    expect(sorted.map((entry) => entry.name)).toEqual(['Alpha', 'Zeta', 'alpha', 'beta', 'zeta']);
  });
});

describe('walkFiles ordering', () => {
  it('sorts entries the filesystem returned out of order', async () => {
    const root = await repo({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });

    const shuffled = async (): Promise<Dirent[]> => [dirent('c.ts'), dirent('a.ts'), dirent('b.ts')];
    const found = [];
    for await (const file of walkFiles(root, { readDirectory: shuffled })) found.push(file.relativePath);

    expect(found).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('sorts directories and files together, then recurses in order', async () => {
    const root = await repo({ 'm.ts': '', 'zdir/inner.ts': '', 'adir/inner.ts': '' });

    const shuffled = async (directory: string): Promise<Dirent[]> => {
      if (directory === root) return [dirent('zdir', 'directory'), dirent('m.ts'), dirent('adir', 'directory')];
      return [dirent('inner.ts')];
    };

    const found = [];
    for await (const file of walkFiles(root, { readDirectory: shuffled })) found.push(file.relativePath);

    expect(found).toEqual(['adir/inner.ts', 'm.ts', 'zdir/inner.ts']);
  });

  it('still yields nothing when the injected reader throws', async () => {
    const root = await repo({ 'a.ts': '' });
    const broken = async (): Promise<Dirent[]> => {
      throw new Error('EACCES');
    };

    const found = [];
    for await (const file of walkFiles(root, { readDirectory: broken })) found.push(file.relativePath);

    expect(found).toEqual([]);
  });
});

describe('search result ordering across targets', () => {
  it('orders matches by path even when targets are given out of order', async () => {
    // src/ui sorts after src/core, so an unsorted concatenation would put the
    // ui matches first.
    const result = await javascriptEngine.search({
      root: DEMO_REPO,
      symbol: 'export',
      targets: ['src/ui', 'src/core'],
      options: searchOptions(),
    });

    expect(result.matches.length).toBeGreaterThan(1);
    expect(result.matches.map((match) => match.file)).toEqual(
      [...result.matches.map((match) => match.file)].sort(),
    );
    expect(result.matches[0]?.file).toContain('src/core/');
  });
});

describe('glob metacharacter escaping', () => {
  // Every character in REGEXP_SPECIALS must be matched literally rather than
  // interpreted as a regular expression.
  it.each([
    ['a.ts', 'aXts'],
    ['a+b.ts', 'ab.ts'],
    ['^a.ts', 'a.ts'],
    ['a$.ts', 'a.ts'],
    ['(a).ts', 'a.ts'],
    ['a|b.ts', 'a.ts'],
  ])('treats the specials in %s literally', (pattern, shouldNotMatch) => {
    expect(globToRegExp(pattern).test(pattern)).toBe(true);
    expect(globToRegExp(pattern).test(shouldNotMatch)).toBe(false);
  });

  it('matches a literal backslash once separators are normalised', () => {
    // toPosix turns "\" into "/", so a backslash can only appear as a separator.
    expect(globToRegExp('a\\b.ts').test('a/b.ts')).toBe(true);
  });

  it('does not let a dot behave as "any character"', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('aXts')).toBe(false);
  });
});

describe('hidden paths in spec discovery', () => {
  it('finds specs in hidden directories, whatever the pattern looks like', async () => {
    const root = await repo({
      '.github/workflows/ci.yml': '',
      '.github/notes.md': '',
      'docs/plain.md': '',
      'docs/.secret.md': '',
    });

    const hiddenDirectory = await expandSpecPatterns(['.github/*.md'], root);
    expect(hiddenDirectory.map((file) => toPosix(path.relative(root, file)))).toEqual(['.github/notes.md']);

    const hiddenFile = await expandSpecPatterns(['docs/.*.md'], root);
    expect(hiddenFile.map((file) => toPosix(path.relative(root, file)))).toEqual(['docs/.secret.md']);

    // A hidden file is an ordinary file now. `docs/*.md` matches `docs/.secret.md`
    // because it is a .md file in docs, which is what the pattern says; the walk
    // no longer decides on the reader's behalf that a leading dot means private.
    const both = await expandSpecPatterns(['docs/*.md'], root);
    expect(both.map((file) => toPosix(path.relative(root, file)))).toEqual(['docs/.secret.md', 'docs/plain.md']);
  });

  it('checks every segment, not just the first', async () => {
    const root = await repo({ 'docs/.drafts/a.md': '', 'docs/final/b.md': '' });

    const nested = await expandSpecPatterns(['docs/.drafts/*.md'], root);
    expect(nested.map((file) => toPosix(path.relative(root, file)))).toEqual(['docs/.drafts/a.md']);
  });

  it('still honours the directory the pattern names', async () => {
    // Hidden directories are walked, but `docs/*.md` still means docs.
    const root = await repo({ 'docs/a.md': '', '.hidden/b.md': '' });

    const dotted = await expandSpecPatterns(['docs/*.md'], root);
    expect(dotted.map((file) => toPosix(path.relative(root, file)))).toEqual(['docs/a.md']);
  });

  it('reaches a spec that only exists in a hidden directory', async () => {
    const root = await repo({ '.github/rules.md': '', 'docs/a.md': '' });

    const all = await expandSpecPatterns(['**/*.md'], root);
    expect(all.map((file) => toPosix(path.relative(root, file)))).toEqual(['.github/rules.md', 'docs/a.md']);
  });
});
