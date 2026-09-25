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
  excludeListError,
  excludePatternError,
  expandSpecPatterns,
  globToRegExp,
  normalizeExclude,
  normalizeGlob,
  walkFiles,
} from '../src/glob.js';
import type { DirectoryReader } from '../src/io.js';
import { DEMO_REPO, makeTempRepo, memoryIo, reading, removeTempRepo } from './helpers.js';

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
    // Two groups side by side. Searching for the second's close from one place
    // early finds the first's, and the compiler never gets past it: the ADR
    // naming rule `[0-9][0-9][0-9][0-9]-*.md` held this until spec-core read
    // it instead (ADR-0015), so the compiler now holds it for itself.
    ['[0-9][0-9]-*.md', '^[0-9][0-9]-[^/]*\\.md$'],
    ['{a,b}{c,d}', '^(?:a|b)(?:c|d)$'],
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

  it('reads a . segment as no segment, wherever it is', () => {
    // It used to strip only a leading ./ and read `src/./a.ts` as a literal
    // that matched nothing, as ripgrep did. spec-core drops a `.` segment
    // anywhere, since `src/./a.ts` names `src/a.ts` and nothing else, and
    // ripgrep is handed the pattern without it (ADR-0015).
    expect(createGlobMatcher(['./src/a.ts'])('src/a.ts')).toBe(true);
    expect(createGlobMatcher(['src/./a.ts'])('src/a.ts')).toBe(true);
    expect(createGlobMatcher(['src/./a.ts'])('src/b/a.ts')).toBe(false);
  });

  it('anchors a glob with a leading slash to the root, as ripgrep reads -g /src', () => {
    // spec-core's ripgrep dialect reads the slash as the filesystem's root,
    // under which no relative path lies: the scanner matched nothing for it
    // while ripgrep matched the root's files.
    expect(createGlobMatcher(['/*.ts'])('a.ts')).toBe(true);
    expect(createGlobMatcher(['/*.ts'])('src/a.ts')).toBe(false);
    expect(createGlobMatcher(['/src/*.ts'])('src/a.ts')).toBe(true);
    expect(createGlobMatcher(['//src/*.ts'])('src/a.ts')).toBe(true);
    // A literal names the one file, as without the slash.
    expect(createGlobMatcher(['/README.md'])('README.md')).toBe(true);
    expect(createGlobMatcher(['/README.md'])('docs/README.md')).toBe(false);
    expect(createGlobMatcher(['/src'])('src/a.ts')).toBe(false);
  });

  it('reads ** inside a segment as *, never across directories', () => {
    // As .gitignore, bash, minimatch and ripgrep read it. The RegExp this
    // replaced read `src/**.ts` as `src/.*\.ts` and matched src/deep/a.ts,
    // which ripgrep did not.
    expect(createGlobMatcher(['src/**.ts'])('src/a.ts')).toBe(true);
    expect(createGlobMatcher(['src/**.ts'])('src/deep/a.ts')).toBe(false);
    expect(createExcludeMatcher(['src/**.ts'])('src/deep/a.ts')).toBe(false);
  });

  it('decides for each alternative of a brace group whether it is anchored', () => {
    const matches = createGlobMatcher(['{src/*.ts,*.md}']);
    expect(matches('src/a.ts')).toBe(true);
    expect(matches('docs/deep/a.md')).toBe(true);
    expect(matches('lib/a.ts')).toBe(false);
  });

  it('is case-sensitive on every host', () => {
    expect(createGlobMatcher(['*.TS'])('a.ts')).toBe(false);
    expect(createExcludeMatcher(['Tests'])('tests/a.ts')).toBe(false);
  });

  it('refuses a pattern it cannot read, naming it', () => {
    expect(() => createGlobMatcher(['*.ts', 'src/[a.ts'])).toThrow('invalid glob pattern "src/[a.ts": a "[" is never closed');
    expect(() => createExcludeMatcher(['+(a|b)'])).toThrow(
      'invalid exclude pattern "+(a|b)": extended globs such as "+(a|b)" are not supported',
    );
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

  it('reads a . segment as no segment, here too', () => {
    expect(createExcludeMatcher(['./src/a.ts'])('src/a.ts')).toBe(true);
    expect(createExcludeMatcher(['src/./a.ts'])('src/a.ts')).toBe(true);
    expect(createExcludeMatcher(['src/./a.ts'])('lib/src/a.ts')).toBe(false);
  });

  it('anchors a pattern with a leading slash to the root, as .gitignore and ripgrep do', () => {
    const excluded = createExcludeMatcher(['/tests']);
    expect(excluded('tests')).toBe(true);
    expect(excluded('tests/a.ts')).toBe(true);
    expect(excluded('src/tests/a.ts')).toBe(false);
    expect(createExcludeMatcher(['/src/config'])('src/config/a.ts')).toBe(true);
    expect(createExcludeMatcher(['/**/tests'])('src/tests/a.ts')).toBe(true);
  });

  it('reads a backslash as a separator', () => {
    expect(createExcludeMatcher(['src\\config'])('src/config/a.ts')).toBe(true);
    expect(createExcludeMatcher(['src\\config'])('other/src/config/a.ts')).toBe(false);
  });

  it('refuses an alternative that names no path, rather than excluding everything', () => {
    // `{dist/**,}` is an ordinary typo, and its empty alternative matches the
    // empty string. The ancestor loop this replaced had to stop short of the
    // empty prefix, or that alternative excluded every file in the tree and an
    // assertion inspected nothing and passed. spec-core refuses it outright.
    expect(excludePatternError('{dist/**,}')).toBe('invalid exclude pattern "{dist/**,}": the pattern names no path');
    expect(() => createExcludeMatcher(['{dist/**,}'])).toThrow('invalid exclude pattern "{dist/**,}"');
  });
});

/* ----------------------------------------------- one pattern for both engines */

describe('the patterns both engines are given', () => {
  it.each([
    ['./src/*.ts', 'src/*.ts'],
    ['src/', 'src/**'],
    ['src\\*.ts', 'src/*.ts'],
    // Only a leading ./ goes, and only one.
    ['src/./a.ts', 'src/./a.ts'],
    ['././a.ts', './a.ts'],
    ['*.ts', '*.ts'],
  ])('include glob %s is %s', (pattern, normalized) => {
    expect(normalizeGlob(pattern)).toBe(normalized);
  });

  it.each([
    ['./build', 'build'],
    ['build/', 'build'],
    ['build//', 'build'],
    ['src\\gen\\', 'src/gen'],
    // A leading slash anchors, so it stays for ripgrep to read.
    ['/target', '/target'],
    ['src/./a.ts', 'src/./a.ts'],
    ['./', ''],
    ['/', ''],
  ])('exclude pattern %s is %s', (pattern, normalized) => {
    expect(normalizeExclude(pattern)).toBe(normalized);
  });
});

describe('an exclude pattern that could never exclude anything', () => {
  const NEGATION = 'negation patterns are not supported in exclude';
  const OUTSIDE = '".." leads out of the root, and only paths inside it are searched';
  const DRIVE = 'exclusions are relative to the root, and a drive path is not';
  const ROOT = 'it names the root itself rather than a path under it';

  it.each([
    ['!build/generated/needed.ts', NEGATION],
    ['!build', NEGATION],
    ['./!build', NEGATION],
    ['../shared', OUTSIDE],
    ['..', OUTSIDE],
    ['src/../lib', OUTSIDE],
    ['src/..', OUTSIDE],
    ['C:/repo/build', DRIVE],
    ['d:\\repo\\build', DRIVE],
    ['.', ROOT],
    ['/', ROOT],
    ['./', ROOT],
  ])('refuses %s', (pattern, reason) => {
    expect(excludePatternError(pattern)).toBe(`invalid exclude pattern "${pattern}": ${reason}`);
  });

  it.each([['build'], ['/build'], ['./build'], ['build/'], ['**'], ['*.test.ts'], ['src/**'], ['..hidden'], ['a..b/c'], ['src/C:/x'], ['C:build'], ['[!a]b'], ['a!b']])(
    'accepts %s',
    (pattern) => {
      expect(excludePatternError(pattern)).toBeNull();
    },
  );

  it('names the first of a list that cannot be used, or nothing', () => {
    expect(excludeListError(['target', '!target/keep', '../x'])).toBe(`invalid exclude pattern "!target/keep": ${NEGATION}`);
    expect(excludeListError(['target', 'dist'])).toBeNull();
    expect(excludeListError([])).toBeNull();
  });
});

/* ----------------------------------------------------------------- the walk */

function dirent(name: string, kind: 'file' | 'directory' | 'other'): never {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  } as never;
}

describe('walkFiles at its edges', () => {
  it('walks each directory whose real path cannot be resolved, under its own name', async () => {
    // A failed realpath falls back to the path itself. Falling back to nothing
    // would give every such directory one identity, and the guard against
    // visiting a directory twice would then skip all of them but the first.
    const root = path.resolve('/spec-guard-virtual-root');
    const io = {
      ...memoryIo(root, { 'a/x.ts': '', 'b/y.ts': '' }),
      realpath: async (): Promise<string> => {
        throw new Error('EPERM');
      },
    };
    const found: string[] = [];
    for await (const file of walkFiles(root, { io, followSymlinks: true })) found.push(file.relativePath);
    expect(found).toEqual(['a/x.ts', 'b/y.ts']);
  });

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
    for await (const file of walkFiles(root, { io: reading(reader), onSkip: (p, r) => skipped.push([p, r]) })) {
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
    for await (const file of walkFiles(root, { io: reading(reader) })) found.push(file.relativePath);

    expect(found).toEqual([]);
  });

  it('sorts entries a filesystem handed back in any order', async () => {
    // The files have to exist: the walk stats each one, and a name it cannot
    // stat is a gap rather than a file out of order.
    const root = await repo({ 'a.ts': 'x\n', 'm.ts': 'x\n', 'z.ts': 'x\n' });
    const reader: DirectoryReader = async () => [dirent('z.ts', 'file'), dirent('a.ts', 'file'), dirent('m.ts', 'file')];

    const found = [];
    for await (const file of walkFiles(root, { io: reading(reader) })) found.push(file.relativePath);

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
