/**
 * The glob compiler's output, and the walk's edges.
 *
 * `globToRegExp` is a compiler, and the tests for it all ran its result against
 * a handful of paths. That pins the cases somebody thought of and leaves the
 * translation itself free: an anchor dropped, a `**` read as a `*`, a `{a,b}`
 * split on the wrong character - each of those still matches the examples in
 * the suite. A compiler is held still by asserting what it emits.
 *
 * The walk's edges are the other half: a root that is not a directory, an entry
 * that is neither file nor directory, a caller that passed no `onSkip`. Every
 * one of those is a path a real repository produces and no test took.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createExcludeMatcher,
  createGlobMatcher,
  expandSpecPatterns,
  globToRegExp,
  statOrNull,
  walkFiles,
  type DirectoryReader,
} from '../src/glob.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo } from './helpers.js';

/* ---------------------------------------------------------- the translation */

describe('what a glob compiles to', () => {
  it.each([
    ['a.ts', '^a\\.ts$'],
    ['*.ts', '^[^/]*\\.ts$'],
    ['?.ts', '^[^/]\\.ts$'],
    // `**/` crosses directory boundaries; a bare `**` also matches slashes.
    ['**/*.ts', '^(?:[^/]*\\/)*[^/]*\\.ts$'],
    ['src/**/*.ts', '^src\\/(?:[^/]*\\/)*[^/]*\\.ts$'],
    ['src/**', '^src\\/.*$'],
    ['[abc].ts', '^[abc]\\.ts$'],
    ['[!abc].ts', '^[^abc]\\.ts$'],
    ['{a,b}.ts', '^(?:a|b)\\.ts$'],
    ['{a,b,c}', '^(?:a|b|c)$'],
    ['{*.ts,*.js}', '^(?:[^/]*\\.ts|[^/]*\\.js)$'],
    // Every regex metacharacter a path can contain, escaped.
    ['a.b+c^d$e(f)g|h', '^a\\.b\\+c\\^d\\$e\\(f\\)g\\|h$'],
    // An unclosed group is a literal, not a syntax error.
    ['a[b', '^a\\[b$'],
    ['a{b', '^a\\{b$'],
    // Windows separators are normalised before anything else happens, so a
    // backslash never reaches the escaper.
    ['src\\a.ts', '^src\\/a\\.ts$'],
  ])('%s becomes %s', (pattern, source) => {
    expect(globToRegExp(pattern).source).toBe(source);
  });

  it('is anchored at both ends', () => {
    const regexp = globToRegExp('a.ts');
    expect(regexp.test('xa.ts')).toBe(false);
    expect(regexp.test('a.tsx')).toBe(false);
  });

  it('takes a case-insensitive flag, and defaults to case-sensitive', () => {
    expect(globToRegExp('A.ts').flags).toBe('');
    expect(globToRegExp('A.ts', { ignoreCase: true }).flags).toBe('i');
    expect(globToRegExp('A.ts', { ignoreCase: true }).test('a.ts')).toBe(true);
  });

  it('reads a leading ** even though nothing precedes it', () => {
    // Looking one character *back* instead of forward compiles this to
    // something that still matches every example anyone writes.
    const regexp = globToRegExp('**/*.ts');
    expect(regexp.test('a/b/c.ts')).toBe(true);
    expect(regexp.test('c.ts')).toBe(true);
  });
});

describe('the include matcher', () => {
  it('matches a pattern without a slash against the basename', () => {
    const matches = createGlobMatcher(['*.ts']);
    expect(matches('src/deep/a.ts')).toBe(true);
    expect(matches('src/deep/a.js')).toBe(false);
  });

  it('matches a pattern with a slash against the whole path', () => {
    const matches = createGlobMatcher(['src/*.ts']);
    expect(matches('src/a.ts')).toBe(true);
    expect(matches('src/deep/a.ts')).toBe(false);
  });

  it('strips a leading ./ only from the front', () => {
    // Unanchored, the same replacement turns `a/./b` into `a/b` and quietly
    // matches a path the pattern did not name.
    expect(createGlobMatcher(['./src/a.ts'])('src/a.ts')).toBe(true);
    expect(createGlobMatcher(['src/./a.ts'])('src/a.ts')).toBe(false);
  });

  it('reads a trailing slash as "everything under here"', () => {
    const matches = createGlobMatcher(['src/']);
    expect(matches('src/a.ts')).toBe(true);
    expect(matches('src/deep/a.ts')).toBe(true);
    expect(matches('other/a.ts')).toBe(false);
  });

  it('admits everything when given no pattern at all', () => {
    expect(createGlobMatcher([])('anything/at/all.xyz')).toBe(true);
  });
});

describe('the exclude matcher', () => {
  it('excludes nothing when given no pattern', () => {
    expect(createExcludeMatcher([])('anything')).toBe(false);
  });

  it('tests a pattern without a slash against every segment', () => {
    const excluded = createExcludeMatcher(['tests']);
    expect(excluded('tests/a.ts')).toBe(true);
    expect(excluded('src/tests/a.ts')).toBe(true);
    expect(excluded('src/a.ts')).toBe(false);
  });

  it('tests a pattern with a slash against the path and its ancestors', () => {
    const excluded = createExcludeMatcher(['src/config']);
    expect(excluded('src/config')).toBe(true);
    expect(excluded('src/config/deep/a.ts')).toBe(true);
    expect(excluded('other/src/config/a.ts')).toBe(false);
  });

  it('strips every trailing slash, not just the last one', () => {
    expect(createExcludeMatcher(['src/config//'])('src/config/a.ts')).toBe(true);
  });

  it('never tests the empty prefix of a path', () => {
    // The ancestor loop stops at depth 1. Running it to depth 0 tests the empty
    // string, which an empty pattern matches - so every path would be excluded.
    expect(createExcludeMatcher([''])('src/a.ts')).toBe(false);
  });
});

/* ----------------------------------------------------------------- the walk */

describe('statOrNull', () => {
  it('returns the stats for a path that exists', async () => {
    const stats = await statOrNull(path.join(DEMO_REPO, 'src'));
    expect(stats?.isDirectory()).toBe(true);
  });

  it('returns null - not undefined - for one that does not', async () => {
    // Every caller tests the result for falsiness, so the difference is
    // invisible from any of them and has to be stated here.
    expect(await statOrNull(path.join(DEMO_REPO, 'no-such-path'))).toBeNull();
  });
});

function dirent(name: string, kind: 'file' | 'directory' | 'other'): never {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  } as never;
}

describe('walkFiles at its edges', () => {
  const temporary: string[] = [];

  async function repo(files: Record<string, string>): Promise<string> {
    const root = await makeTempRepo(files);
    temporary.push(root);
    return root;
  }

  it('yields nothing for a root that is a file', async () => {
    const root = await repo({ 'a.ts': 'x\n' });
    const found = [];
    for await (const file of walkFiles(path.join(root, 'a.ts'))) found.push(file.relativePath);
    expect(found).toEqual([]);
  });

  it('yields nothing for a root that does not exist', async () => {
    const found = [];
    for await (const file of walkFiles(path.join(DEMO_REPO, 'no-such-directory'))) found.push(file);
    expect(found).toEqual([]);
  });

  it('passes over an entry that is neither a file nor a directory', async () => {
    // A socket, a device node, a FIFO. Not a file, so not searchable; not a
    // gap either, because there is nothing in it to have missed.
    const root = await repo({ 'a.ts': 'x\n' });
    const skipped: Array<[string, string]> = [];
    const reader: DirectoryReader = async () => [dirent('a.ts', 'file'), dirent('pipe', 'other')];

    const found = [];
    for await (const file of walkFiles(root, { readDirectory: reader, onSkip: (p, r) => skipped.push([p, r]) })) {
      found.push(file.relativePath);
    }

    expect(found).toEqual(['a.ts']);
    expect(skipped).toEqual([]);
  });

  it('reports a skip even when the caller passed no handler', async () => {
    // The call is optional-chained. Without that it throws, and a walk that
    // crashes on the first unreadable directory reports nothing at all.
    const root = await repo({ 'a.ts': 'x\n' });
    const reader: DirectoryReader = async (directory) =>
      directory === root ? [dirent('locked', 'directory')] : Promise.reject(new Error('EACCES'));

    const found = [];
    for await (const file of walkFiles(root, { readDirectory: reader })) found.push(file.relativePath);

    expect(found).toEqual([]);
  });

  it('sorts entries a filesystem handed back in any order', async () => {
    // The files have to exist: the walk stats each one, and a name it cannot
    // stat is a gap rather than a file out of order.
    const root = await repo({ 'a.ts': 'x\n', 'm.ts': 'x\n', 'z.ts': 'x\n' });
    const reader: DirectoryReader = async () => [dirent('z.ts', 'file'), dirent('a.ts', 'file'), dirent('m.ts', 'file')];

    const found = [];
    for await (const file of walkFiles(root, { readDirectory: reader })) found.push(file.relativePath);

    expect(found).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('cleans up', async () => {
    await Promise.all(temporary.splice(0).map(removeTempRepo));
  });
});

describe('expandSpecPatterns', () => {
  const temporary: string[] = [];

  async function repo(files: Record<string, string>): Promise<string> {
    const root = await makeTempRepo(files);
    temporary.push(root);
    return root;
  }

  it('returns paths in order however the patterns were given', async () => {
    // Two patterns, the later one naming the earlier file. A Set preserves
    // insertion order, so without the sort the list comes back backwards.
    const root = await repo({ 'docs/a.md': '#\n', 'docs/z.md': '#\n' });

    const found = await expandSpecPatterns(['docs/z.md', 'docs/a.md'], root);

    expect(found.map((file) => path.basename(file))).toEqual(['a.md', 'z.md']);
  });

  it('lists a file once when two patterns both name it', async () => {
    const root = await repo({ 'docs/a.md': '#\n' });
    expect(await expandSpecPatterns(['docs/a.md', 'docs/*.md'], root)).toHaveLength(1);
  });

  it('finds nothing for a path that is neither a file nor a directory', async () => {
    const root = await repo({ 'docs/a.md': '#\n' });
    expect(await expandSpecPatterns(['docs/nope.md'], root)).toEqual([]);
  });

  it('expands a directory to the markdown it contains, and nothing else', async () => {
    const root = await repo({
      'docs/a.md': '#\n',
      'docs/b.markdown': '#\n',
      'docs/c.mdx': '#\n',
      'docs/d.txt': 'x\n',
    });

    const found = await expandSpecPatterns(['docs'], root);

    expect(found.map((file) => path.basename(file))).toEqual(['a.md', 'b.markdown', 'c.mdx']);
  });

  it('cleans up', async () => {
    await Promise.all(temporary.splice(0).map(removeTempRepo));
  });
});
