import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createGlobMatcher,
  expandSpecPatterns,
  globBase,
  globToRegExp,
  isGlob,
  toPosix,
  walkFiles,
} from '../src/glob.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

describe('globToRegExp', () => {
  const cases: Array<[string, string, boolean]> = [
    ['*.ts', 'a.ts', true],
    ['*.ts', 'a.tsx', false],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['**/*.ts', 'a.ts', true],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'lib/a.ts', false],
    ['a?c.ts', 'abc.ts', true],
    ['a?c.ts', 'ac.ts', false],
    ['{a,b}.ts', 'b.ts', true],
    ['{a,b}.ts', 'c.ts', false],
    ['[ab].ts', 'a.ts', true],
    ['[!ab].ts', 'c.ts', true],
    ['[!ab].ts', 'a.ts', false],
    ['a.b+c.ts', 'a.b+c.ts', true],
    ['a.b+c.ts', 'aXbYc.ts', false],
  ];

  it.each(cases)('matches %s against %s -> %s', (pattern, candidate, expected) => {
    expect(globToRegExp(pattern).test(candidate)).toBe(expected);
  });

  it('supports case-insensitive matching', () => {
    expect(globToRegExp('*.TS', { ignoreCase: true }).test('a.ts')).toBe(true);
    expect(globToRegExp('*.TS').test('a.ts')).toBe(false);
  });

  it('treats unterminated bracket and brace groups literally', () => {
    expect(globToRegExp('a[bc.ts').test('a[bc.ts')).toBe(true);
    expect(globToRegExp('a{b.ts').test('a{b.ts')).toBe(true);
  });

  it('normalises windows separators', () => {
    expect(globToRegExp('src\\**\\*.ts').test('src/a/b.ts')).toBe(true);
  });
});

describe('createGlobMatcher', () => {
  it('matches bare patterns against the basename, like ripgrep -g', () => {
    const matcher = createGlobMatcher(['*.ts']);
    expect(matcher('src/deep/a.ts')).toBe(true);
    expect(matcher('src/deep/a.js')).toBe(false);
  });

  it('matches patterns containing a slash against the whole path', () => {
    const matcher = createGlobMatcher(['src/**/*.ts']);
    expect(matcher('src/deep/a.ts')).toBe(true);
    expect(matcher('lib/deep/a.ts')).toBe(false);
  });

  it('expands a trailing slash to a directory match', () => {
    const matcher = createGlobMatcher(['src/']);
    expect(matcher('src/a.ts')).toBe(true);
    expect(matcher('lib/a.ts')).toBe(false);
  });

  it('accepts any file when no pattern is given', () => {
    expect(createGlobMatcher([])('anything.bin')).toBe(true);
  });

  it('accepts a file matching any of several patterns', () => {
    const matcher = createGlobMatcher(['*.ts', '*.tsx']);
    expect(matcher('a.tsx')).toBe(true);
    expect(matcher('a.md')).toBe(false);
  });

  it('ignores a leading ./', () => {
    expect(createGlobMatcher(['./src/*.ts'])('src/a.ts')).toBe(true);
  });
});

describe('walkFiles', () => {
  it('yields files depth-first in sorted order', async () => {
    const root = await repo({ 'b.ts': '', 'a.ts': '', 'nested/c.ts': '' });
    const found = [];
    for await (const file of walkFiles(root)) found.push(file.relativePath);
    expect(found).toEqual(['a.ts', 'b.ts', 'nested/c.ts']);
  });

  it('skips ignored directories and hidden entries', async () => {
    const root = await repo({
      'a.ts': '',
      'node_modules/pkg/index.js': '',
      'dist/out.js': '',
      '.hidden/secret.ts': '',
      '.env': '',
    });
    const found = [];
    for await (const file of walkFiles(root)) found.push(file.relativePath);
    expect(found).toEqual(['a.ts']);
  });

  it('can include hidden entries on request', async () => {
    const root = await repo({ 'a.ts': '', '.github/workflows/ci.yml': '' });
    const found = [];
    for await (const file of walkFiles(root, { includeHidden: true })) found.push(file.relativePath);
    expect(found).toEqual(['.github/workflows/ci.yml', 'a.ts']);
  });

  it('reports file sizes and absolute paths', async () => {
    const root = await repo({ 'a.ts': 'hello' });
    const files = [];
    for await (const entry of walkFiles(root)) files.push(entry);
    expect(files).toHaveLength(1);
    expect(files[0]?.size).toBe(5);
    expect(files[0]?.absolutePath).toBe(path.join(root, 'a.ts'));
  });

  it('yields nothing for a missing root or a file root', async () => {
    const root = await repo({ 'a.ts': '' });
    const missing = [];
    for await (const file of walkFiles(path.join(root, 'nope'))) missing.push(file);
    for await (const file of walkFiles(path.join(root, 'a.ts'))) missing.push(file);
    expect(missing).toEqual([]);
  });
});

describe('globBase', () => {
  it('splits the static prefix from the pattern', () => {
    expect(globBase('docs/adr/*.md')).toEqual({ base: 'docs/adr', rest: '*.md' });
    expect(globBase('docs/**/*.md')).toEqual({ base: 'docs', rest: '**/*.md' });
    expect(globBase('*.md')).toEqual({ base: '', rest: '*.md' });
  });
});

describe('expandSpecPatterns', () => {
  it('expands globs relative to the root', async () => {
    const files = await expandSpecPatterns(['docs/**/*.md'], DEMO_REPO);
    expect(files.map((file) => toPosix(path.relative(DEMO_REPO, file)))).toEqual([
      'docs/adr/0001-passing.md',
      'docs/adr/0002-failing.md',
      'docs/adr/0003-invalid.md',
      'docs/adr/0004-search-options.md',
      'docs/adr/0005-missing-target.md',
    ]);
  });

  it('accepts a literal file path', async () => {
    const files = await expandSpecPatterns(['docs/adr/0001-passing.md'], DEMO_REPO);
    expect(files).toHaveLength(1);
  });

  it('expands a directory to the markdown files it contains', async () => {
    const root = await repo({ 'docs/a.md': '', 'docs/b.markdown': '', 'docs/c.txt': '', 'docs/nested/d.mdx': '' });
    const files = await expandSpecPatterns(['docs'], root);
    expect(files.map((file) => toPosix(path.relative(root, file)))).toEqual([
      'docs/a.md',
      'docs/b.markdown',
      'docs/nested/d.mdx',
    ]);
  });

  it('de-duplicates overlapping patterns', async () => {
    const files = await expandSpecPatterns(
      ['docs/adr/0001-passing.md', 'docs/**/*.md', 'docs/adr/0001-passing.md'],
      DEMO_REPO,
    );
    expect(new Set(files).size).toBe(files.length);
  });

  it('returns nothing when a pattern matches nothing', async () => {
    expect(await expandSpecPatterns(['does/not/exist/**/*.md'], DEMO_REPO)).toEqual([]);
    expect(await expandSpecPatterns(['nope.md'], DEMO_REPO)).toEqual([]);
  });

  it('finds specs inside dot-directories when the pattern asks for them', async () => {
    const root = await repo({ '.github/notes.md': '', 'plain.md': '' });
    const files = await expandSpecPatterns(['.github/*.md'], root);
    expect(files.map((file) => toPosix(path.relative(root, file)))).toEqual(['.github/notes.md']);
  });

  it('supports absolute glob patterns', async () => {
    const root = await repo({ 'docs/a.md': '' });
    const files = await expandSpecPatterns([`${toPosix(root)}/docs/*.md`], process.cwd());
    expect(files.map((file) => toPosix(path.relative(root, file)))).toEqual(['docs/a.md']);
  });
});

describe('helpers', () => {
  it('detects glob metacharacters', () => {
    expect(isGlob('src/**/*.ts')).toBe(true);
    expect(isGlob('src/index.ts')).toBe(false);
  });

  it('converts windows separators', () => {
    expect(toPosix('src\\a\\b.ts')).toBe('src/a/b.ts');
  });
});

/**
 * Directory links use "junction", which Node maps to a real symlink on POSIX
 * and to a junction on Windows, so those cases run everywhere. File symlinks
 * need elevation on Windows, so they are gated on an actual probe rather than
 * silently passing.
 */
const fileSymlinksWork = await (async (): Promise<boolean> => {
  const probe = await makeTempRepo({ 'target.txt': 'x' });
  try {
    await fsp.symlink(path.join(probe, 'target.txt'), path.join(probe, 'link.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    await removeTempRepo(probe);
  }
})();

describe('walkFiles with symlinks', () => {
  it('skips linked directories by default and follows them on request', async () => {
    const root = await repo({ 'real/a.ts': 'const a = 1;', 'plain.ts': '' });
    await fsp.symlink(path.join(root, 'real'), path.join(root, 'linked'), 'junction');

    const skipped = [];
    for await (const file of walkFiles(root)) skipped.push(file.relativePath);
    expect(skipped).toEqual(['plain.ts', 'real/a.ts']);

    // "linked" and "real" are the same physical directory, so it is walked
    // once - under whichever name is reached first - and never double-counted.
    const followed = [];
    for await (const file of walkFiles(root, { followSymlinks: true })) followed.push(file.relativePath);
    expect(followed).toEqual(['linked/a.ts', 'plain.ts']);
  });

  it('does not loop forever on a link cycle', async () => {
    const root = await repo({ 'nested/a.ts': 'const a = 1;' });
    await fsp.symlink(root, path.join(root, 'nested', 'loop'), 'junction');

    const found = [];
    for await (const file of walkFiles(root, { followSymlinks: true })) found.push(file.relativePath);

    expect(found).toContain('nested/a.ts');
    expect(found.length).toBeLessThan(20);
  });

  it.runIf(fileSymlinksWork)('follows a link that points at a file', async () => {
    const root = await repo({ 'real.ts': 'const a = 1;' });
    await fsp.symlink(path.join(root, 'real.ts'), path.join(root, 'alias.ts'), 'file');

    const found = [];
    for await (const file of walkFiles(root, { followSymlinks: true })) found.push(file.relativePath);
    expect(found).toEqual(['alias.ts', 'real.ts']);
  });

  it.runIf(fileSymlinksWork)('ignores a broken link even when following', async () => {
    const root = await repo({ 'real.ts': '' });
    await fsp.symlink(path.join(root, 'missing.ts'), path.join(root, 'broken.ts'), 'file');

    const found = [];
    for await (const file of walkFiles(root, { followSymlinks: true })) found.push(file.relativePath);
    expect(found).toEqual(['real.ts']);
  });
});
