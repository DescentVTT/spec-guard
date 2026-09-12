/**
 * The engine's own contracts, as opposed to its answers.
 *
 * Everything here was previously tested only through a search: if the count
 * came out right, the ordering, the caps, the size boundary, the concurrency
 * limit and the identity of a request were all assumed to be right too. They
 * were not. Four defects fell out of writing this file, and each of them is a
 * wrong answer rather than a missed optimisation:
 *
 *   - the result cache ignored `ignoreComments`, so two assertions on the same
 *     symbol were answered with each other's comment handling;
 *   - the grouping test ignored it as well, so those two assertions were also
 *     merged into a single pass;
 *   - neither considered the scope policy;
 *   - the adaptive engine dropped the walk's skip ledger on any tree small
 *     enough to be scanned in process, so an unreadable directory was reported
 *     or not depending on how big the repository was.
 *
 * The pure helpers are tested as functions because that is what they are. A
 * comparator that is only ever called with distinct inputs still has to say
 * what it does with equal ones, and a cap that is only reached by a file with
 * six hundred matching lines is still a cap.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildJsRegExp,
  comparePaths,
  createCachedEngine,
  enumerateCandidates,
  javascriptEngine,
  parseRipgrepFiles,
  readConcurrency,
  resolveEngine,
  ripgrepFailureMessage,
  runSearches,
  scanContent,
  smallTreeBudget,
  truncate,
  withinSizeLimit,
  MAX_COLLECTED_MATCHES,
  MAX_CONCURRENT_READS,
  MAX_FILE_SIZE,
  ROOT_TARGETS,
  SMALL_TREE_BUDGET,
  ANY_FILE_PROBE,
  type SearchRequest,
} from '../src/engine.js';
import { defaultDirectoryReader, type DirectoryReader } from '../src/glob.js';
import { DEFAULT_SCOPE, MAX_LEDGER_ENTRIES, SCAN_EVERYTHING } from '../src/scope.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo, searchOptions, wideTree } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
  vi.restoreAllMocks();
});

async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { root: DEMO_REPO, symbol: 'UserSessionManager', targets: ['src'], options: searchOptions(), ...overrides };
}

/* ------------------------------------------------------------ pure helpers */

describe('comparePaths', () => {
  it('orders byte-wise', () => {
    expect(comparePaths('a.ts', 'b.ts')).toBe(-1);
    expect(comparePaths('b.ts', 'a.ts')).toBe(1);
  });

  it('reports a tie as a tie', () => {
    // No call site can produce two equal paths, which is exactly why this has
    // to be stated: an ordering that answers -1 for equal inputs sorts every
    // real list identically and is still not an ordering.
    expect(comparePaths('src/a.ts', 'src/a.ts')).toBe(0);
  });

  it('puts a path before its own extension', () => {
    expect(comparePaths('src/a', 'src/a.ts')).toBe(-1);
  });
});

describe('withinSizeLimit', () => {
  it('admits a file of exactly the limit', () => {
    // Inclusive, because `--max-filesize` is inclusive. The two engines skip
    // the same file or the same tree answers differently depending on which
    // one looked at it.
    expect(withinSizeLimit(MAX_FILE_SIZE)).toBe(true);
  });

  it('refuses one byte more', () => {
    expect(withinSizeLimit(MAX_FILE_SIZE + 1)).toBe(false);
  });

  it('admits an empty file', () => {
    expect(withinSizeLimit(0)).toBe(true);
  });
});

describe('readConcurrency', () => {
  it('never starts more readers than there are files', () => {
    expect(readConcurrency(0)).toBe(0);
    expect(readConcurrency(1)).toBe(1);
    expect(readConcurrency(MAX_CONCURRENT_READS - 1)).toBe(MAX_CONCURRENT_READS - 1);
  });

  it('caps at the concurrency limit', () => {
    expect(readConcurrency(MAX_CONCURRENT_READS + 1)).toBe(MAX_CONCURRENT_READS);
    expect(readConcurrency(100_000)).toBe(MAX_CONCURRENT_READS);
  });

  it('really holds that many files open at once, and no more', async () => {
    // The number above is only a number until something counts the reads that
    // are actually in flight. Every worker is started synchronously and
    // increments before its first await, so the peak is exact rather than
    // timing-dependent.
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_CONCURRENT_READS + 4; index++) files[`src/f${index}.ts`] = 'Widget\n';
    const root = await repo(files);

    let inFlight = 0;
    let peak = 0;
    const real = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await real(...args);
      } finally {
        inFlight -= 1;
      }
    });

    const result = await javascriptEngine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });

    expect(result.count).toBe(MAX_CONCURRENT_READS + 4);
    expect(peak).toBe(MAX_CONCURRENT_READS);
  });

  it('reads a single file without starting sixteen workers', async () => {
    const root = await repo({ 'src/only.ts': 'Widget\n' });
    let peak = 0;
    let inFlight = 0;
    const real = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await real(...args);
      } finally {
        inFlight -= 1;
      }
    });

    await javascriptEngine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });

    expect(peak).toBe(1);
  });
});

describe('truncate', () => {
  it('takes the carriage return off a CRLF line', () => {
    // The caller slices up to the newline, so CR is the only terminator that
    // can reach here. Left in, it reaches the terminal and returns the cursor
    // to column 0, overwriting the line that spec-guard just printed.
    expect(truncate('const a = Foo;\r')).toBe('const a = Foo;');
  });

  it('leaves a carriage return that is not at the end alone', () => {
    expect(truncate('a\rb')).toBe('a\rb');
  });

  it('leaves a line at exactly the snippet length alone', () => {
    const line = 'x'.repeat(200);
    expect(truncate(line)).toBe(line);
  });

  it('marks a longer line with an ellipsis', () => {
    const cut = truncate('x'.repeat(500));
    expect(cut).toHaveLength(201);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('does not carry a carriage return into a snippet', () => {
    const result = scanContent('const a = Foo;\r\nnext\r\n', 'a.ts', buildJsRegExp('Foo', searchOptions()));
    expect(result.locations[0]?.text).toBe('const a = Foo;');
  });
});

/* -------------------------------------------------------- ripgrep's output */

describe('parseRipgrepFiles', () => {
  const none = new Set<string>();

  it('splits on NUL, not on newline', () => {
    // A file name may contain a newline. It may not contain a NUL, which is
    // why --null is passed in the first place.
    const files = parseRipgrepFiles('src/a.ts\0src/b\nc.ts\0', DEMO_REPO, none);
    expect(files.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b\nc.ts']);
  });

  it('ignores the empty entry after the final separator', () => {
    expect(parseRipgrepFiles('src/a.ts\0', DEMO_REPO, none)).toHaveLength(1);
  });

  it('reports nothing when ripgrep matched nothing', () => {
    expect(parseRipgrepFiles('', DEMO_REPO, none)).toEqual([]);
  });

  it('drops a path the assertion excluded', () => {
    const excluded = new Set([path.resolve(DEMO_REPO, 'src/a.ts')]);
    const files = parseRipgrepFiles('src/a.ts\0src/b.ts\0', DEMO_REPO, excluded);
    expect(files.map((file) => file.relativePath)).toEqual(['src/b.ts']);
  });

  it('sorts by path, because ripgrep searches in parallel and does not', () => {
    const files = parseRipgrepFiles('src/z.ts\0src/a.ts\0lib/m.ts\0', DEMO_REPO, none);
    expect(files.map((file) => file.relativePath)).toEqual(['lib/m.ts', 'src/a.ts', 'src/z.ts']);
  });

  it('normalises the separators ripgrep uses on Windows', () => {
    const [file] = parseRipgrepFiles('src\\deep\\a.ts\0', DEMO_REPO, none);
    expect(file?.relativePath).toBe('src/deep/a.ts');
  });

  it('resolves each path against the root', () => {
    const [file] = parseRipgrepFiles('src/a.ts\0', DEMO_REPO, none);
    expect(file?.absolutePath).toBe(path.resolve(DEMO_REPO, 'src/a.ts'));
  });

  it('keeps a non-ASCII path intact', () => {
    // The output is held as bytes and decoded once, so a multi-byte character
    // cannot be split across two chunks of ripgrep's stdout.
    const [file] = parseRipgrepFiles('src/日本語.ts\0', DEMO_REPO, none);
    expect(file?.relativePath).toBe('src/日本語.ts');
  });
});

/* ------------------------------------------------------- caps on collection */

describe('the cap on collected snippets', () => {
  it('stops listing lines from one file at the cap, and keeps counting', () => {
    const lines = Array.from({ length: MAX_COLLECTED_MATCHES + 20 }, (_, index) => `const v${index} = Foo;`);
    const result = scanContent(lines.join('\n'), 'a.ts', buildJsRegExp('Foo', searchOptions()));

    // The count is the answer to the assertion; the locations are only what
    // the report has room to show. Capping the first would be a wrong result.
    expect(result.count).toBe(MAX_COLLECTED_MATCHES + 20);
    expect(result.locations).toHaveLength(MAX_COLLECTED_MATCHES);
  });

  it('stops listing across files at the cap too', async () => {
    // Two hundred per file, so no single file reaches the cap and only the
    // merge can enforce it.
    const perFile = 200;
    const body = Array.from({ length: perFile }, (_, index) => `const v${index} = Foo;`).join('\n');
    const root = await repo({ 'src/a.ts': body, 'src/b.ts': body, 'src/c.ts': body });

    const result = await javascriptEngine.search({ root, symbol: 'Foo', targets: ['src'], options: searchOptions() });

    expect(result.count).toBe(perFile * 3);
    expect(result.matches).toHaveLength(MAX_COLLECTED_MATCHES);
  });
});

describe('snippet boundaries', () => {
  it('takes the whole line when the match ends it', () => {
    // Searching backwards from one *past* the match finds the newline that
    // follows a single-character match and reports the next line instead.
    const result = scanContent('ab\nX\ncd', 'a.ts', buildJsRegExp('X', searchOptions()));
    expect(result.locations[0]).toMatchObject({ line: 2, column: 1, text: 'X' });
  });

  it('takes the whole line when the match is the entire file', () => {
    const result = scanContent('X', 'a.ts', buildJsRegExp('X', searchOptions()));
    expect(result.locations[0]).toMatchObject({ line: 1, column: 1, text: 'X' });
  });
});

/* ------------------------------------------- when two requests are the same */

describe('two requests are the same question only when they are', () => {
  const body = '// Widget mentioned in a comment\nconst x = Widget;\n';

  it('does not answer a comments-included search from a comments-stripped cache', async () => {
    // Both assertions name the same symbol and the same target and differ only
    // in `comments`. Whichever ran first used to answer for both.
    const root = await repo({ 'src/a.ts': body });
    const engine = createCachedEngine(javascriptEngine);
    const base = { root, symbol: 'Widget', targets: ['src'] };

    const stripped = await engine.search({ ...base, options: searchOptions({ ignoreComments: true }) });
    const included = await engine.search({ ...base, options: searchOptions({ ignoreComments: false }) });

    expect([stripped.count, included.count]).toEqual([1, 2]);
  });

  it('does not merge those two into one pass either', async () => {
    const root = await repo({ 'src/a.ts': body });
    const shared = new Set<string>();
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, ignoreComments: true }) },
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, ignoreComments: false }) },
    ]);

    expect(results.map((result) => result.count)).toEqual([1, 2]);
  });

  it('does not merge requests that walk under different scope policies', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/node_modules/b.ts': 'Widget\n' });
    const shared = new Set<string>();
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, scope: DEFAULT_SCOPE }) },
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, scope: SCAN_EVERYTHING }) },
    ]);

    expect(results.map((result) => result.count)).toEqual([1, 2]);
  });

  it('does not merge requests whose glob list is a prefix of the other', async () => {
    // The old field-by-field comparison checked the lengths and then checked
    // each element against the same index of the first request, so a shorter
    // list that happened to be a prefix agreed with itself.
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/b.md': 'Widget\n' });
    const shared = new Set<string>();
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, globs: ['*.ts'] }) },
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, globs: ['*.ts', '*.md'] }) },
    ]);

    expect(results.map((result) => result.count)).toEqual([1, 2]);
  });

  it('does not merge requests whose exclude-glob list is a prefix of the other', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/b.md': 'Widget\n' });
    const shared = new Set<string>();
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, excludeGlobs: ['*.md'] }) },
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: shared, excludeGlobs: ['*.md', '*.ts'] }) },
    ]);

    expect(results.map((result) => result.count)).toEqual([1, 0]);
  });

  it('does not merge requests that exclude different files', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/b.ts': 'Widget\n' });
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions({ excludeFiles: new Set<string>() }) },
      {
        root,
        symbol: 'Widget',
        targets: ['src'],
        options: searchOptions({ excludeFiles: new Set([path.resolve(root, 'src/b.ts')]) }),
      },
    ]);

    expect(results.map((result) => result.count)).toEqual([2, 1]);
  });

  it('does not answer a word search from a substring search cache', async () => {
    const root = await repo({ 'src/a.ts': 'Widgetry and Widget\n' });
    const engine = createCachedEngine(javascriptEngine);
    const base = { root, symbol: 'Widget', targets: ['src'] };

    const loose = await engine.search({ ...base, options: searchOptions() });
    const whole = await engine.search({ ...base, options: searchOptions({ word: true }) });

    expect([loose.count, whole.count]).toEqual([2, 1]);
  });
});

/* --------------------------------------------------------------- the walk */

function dirent(name: string, kind: 'file' | 'directory'): never {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  } as never;
}

describe('enumerateCandidates', () => {
  it('passes over a target that does not exist', async () => {
    const enumeration = await enumerateCandidates(request({ targets: ['no-such-directory'] }));
    expect(enumeration.files).toEqual([]);
  });

  it('still lists the targets that do exist alongside one that does not', async () => {
    const enumeration = await enumerateCandidates(request({ targets: ['no-such-directory', 'src'] }));
    expect(enumeration.files.length).toBeGreaterThan(0);
  });

  it('records a directory the walk could not list', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n' });
    const reader: DirectoryReader = async (directory) => {
      if (directory === path.join(root, 'src')) return [dirent('locked', 'directory')];
      throw new Error('EACCES');
    };

    const enumeration = await enumerateCandidates(
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions() },
      undefined,
      reader,
    );

    expect(enumeration.skipped).toEqual([{ path: 'src/locked', reason: 'unreadable' }]);
  });

  it('leaves a policy skip out of the ledger', async () => {
    // `.git` and `node_modules` are the same on every run and are documented.
    // Listing them each time would bury the entries that mean something, and
    // ripgrep is never asked about them, so reporting them would also make the
    // two engines disagree.
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/node_modules/b.ts': 'Widget\n' });

    const enumeration = await enumerateCandidates({
      root,
      symbol: 'Widget',
      targets: ['src'],
      options: searchOptions(),
    });

    expect(enumeration.skipped).toEqual([]);
    expect(enumeration.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
  });

  it('caps the sample of skipped paths', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n' });
    const names = Array.from({ length: MAX_LEDGER_ENTRIES + 5 }, (_, index) => `d${index}`);
    const reader: DirectoryReader = async (directory) => {
      if (directory === path.join(root, 'src')) return names.map((name) => dirent(name, 'directory')) as never;
      throw new Error('EACCES');
    };

    const enumeration = await enumerateCandidates(
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions() },
      undefined,
      reader,
    );

    expect(enumeration.skipped).toHaveLength(MAX_LEDGER_ENTRIES);
  });

  it('keeps going to the next target after admitting a file that fits', async () => {
    // The budget check reads "stop if this file did *not* fit". Without the
    // negation the walk stops on the first file it accepts, and a two-file
    // target list silently becomes a one-file one.
    const root = await repo({ 'a.ts': 'Widget\n', 'b.ts': 'Widget\n' });

    const enumeration = await enumerateCandidates(
      { root, symbol: 'Widget', targets: ['a.ts', 'b.ts'], options: searchOptions() },
      { maxFiles: 10, maxBytes: 1024 },
    );

    expect(enumeration.files.map((file) => file.relativePath)).toEqual(['a.ts', 'b.ts']);
    expect(enumeration.exceeded).toBe(false);
  });

  it('stops at the first file target once the budget is spent', async () => {
    const root = await repo({ 'a.ts': 'Widget\n', 'b.ts': 'Widget\n' });

    const enumeration = await enumerateCandidates(
      { root, symbol: 'Widget', targets: ['a.ts', 'b.ts'], options: searchOptions() },
      { maxFiles: 0, maxBytes: 0 },
    );

    expect(enumeration.exceeded).toBe(true);
    expect(enumeration.files).toHaveLength(1);
  });

  it('searches the root when a request names no target', async () => {
    const root = await repo({ 'a.ts': 'Widget\n', 'nested/b.ts': 'Widget\n' });

    const enumeration = await enumerateCandidates({ root, symbol: 'Widget', targets: [], options: searchOptions() });

    expect(enumeration.files.map((file) => file.relativePath)).toEqual(['a.ts', 'nested/b.ts']);
    expect(ROOT_TARGETS).toEqual(['.']);
  });
});

/* ------------------------------------------------------- the any-file probe */

describe('ANY_FILE_PROBE', () => {
  // One readdir for the target, one per directory beneath it if the walk runs
  // to the end. 24 and 8 are arbitrary; that 24 is much larger than 2 is not.
  const DIRECTORIES = 24;
  const FILES_PER_DIRECTORY = 8;

  function counting(): { reader: DirectoryReader; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      reader: (directory) => {
        calls.push(directory);
        return defaultDirectoryReader(directory);
      },
    };
  }

  it('abandons the walk at the first file instead of traversing the tree', async () => {
    // The only question anyone asks this budget is `files.length > 0`, and that
    // answer survives having no budget at all: a walk with no ceiling finds the
    // same first file, having read every directory on the way to it. So the
    // cost *is* the contract, and the cost is what is asserted here - there is
    // nothing else about this constant that an output can disagree with, which
    // is exactly why an emptied `{}` sat in the mutation report as a survivor.
    const root = await repo(wideTree(DIRECTORIES, FILES_PER_DIRECTORY));
    const request: SearchRequest = { root, symbol: 'Widget', targets: ['src'], options: searchOptions() };

    const probe = counting();
    const enumeration = await enumerateCandidates(request, ANY_FILE_PROBE, probe.reader);

    expect(enumeration.files).toHaveLength(1);
    expect(enumeration.exceeded).toBe(true);
    expect(probe.calls).toHaveLength(2);

    // The other half of the claim. Without this the bound above would pass on a
    // repository that simply had two directories in it, and the test would be
    // measuring the fixture rather than the budget.
    const whole = counting();
    const full = await enumerateCandidates(request, undefined, whole.reader);

    expect(full.files).toHaveLength(DIRECTORIES * FILES_PER_DIRECTORY);
    expect(full.exceeded).toBe(false);
    expect(whole.calls).toHaveLength(DIRECTORIES + 1);
  });

  it('is a budget of zero on both axes, so either one alone would stop the walk', async () => {
    // Stated against the walk rather than against the literal: a probe that
    // capped files but not bytes would still abandon at the first file, and a
    // test reading `maxFiles === 0` could not tell the two apart. Each field is
    // shown to be sufficient on its own by neutralising the other.
    const root = await repo(wideTree(DIRECTORIES, FILES_PER_DIRECTORY));
    const request: SearchRequest = { root, symbol: 'Widget', targets: ['src'], options: searchOptions() };

    const byFiles = counting();
    const filesOnly = await enumerateCandidates(
      request,
      { maxFiles: ANY_FILE_PROBE.maxFiles, maxBytes: Number.POSITIVE_INFINITY },
      byFiles.reader,
    );

    const byBytes = counting();
    const bytesOnly = await enumerateCandidates(
      request,
      { maxFiles: Number.POSITIVE_INFINITY, maxBytes: ANY_FILE_PROBE.maxBytes },
      byBytes.reader,
    );

    expect(filesOnly.exceeded).toBe(true);
    expect(byFiles.calls).toHaveLength(2);
    expect(bytesOnly.exceeded).toBe(true);
    expect(byBytes.calls).toHaveLength(2);
  });
});

describe('the adaptive engine', () => {
  it('carries the walk ledger out of its small-tree branch', async () => {
    // The branch that scans in process had the ledger in hand and returned
    // without it, so an unreadable directory was a reported gap on a large
    // repository and silence on a small one. The reader is intercepted rather
    // than the permissions changed, because Windows has no chmod and a
    // permission bit a failed test leaves behind is worse than no test.
    const root = await repo({ 'src/a.ts': 'Widget\n', 'src/locked/b.ts': 'Widget\n' });
    const real = fsp.readdir.bind(fsp);
    vi.spyOn(fsp, 'readdir').mockImplementation((async (...args: Parameters<typeof fsp.readdir>) => {
      const [directory] = args;
      if (typeof directory === 'string' && directory.endsWith('locked')) throw new Error('EACCES');
      return real(...args);
    }) as typeof fsp.readdir);

    const engine = await resolveEngine('auto');
    const result = await engine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });

    expect(result.engine).toBe('javascript');
    expect(result.scope.skipped).toEqual([{ path: 'src/locked', reason: 'unreadable' }]);
  });

  it('reports nothing skipped when there was nothing to skip', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n' });
    const engine = await resolveEngine('auto');

    const result = await engine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });

    expect(result.scope.skipped).toEqual([]);
  });

  it('reports a directory it could not read even on a tree small enough to scan in process', async () => {
    // The small-tree branch had the walk's ledger in hand and returned without
    // it, so the same unreadable directory was a reported gap on a large
    // repository and silence on a small one.
    const root = await repo({ 'src/a.ts': 'Widget\n' });
    const reader: DirectoryReader = async (directory) => {
      if (directory === path.join(root, 'src')) return [dirent('locked', 'directory')];
      throw new Error('EACCES');
    };
    const enumeration = await enumerateCandidates(
      { root, symbol: 'Widget', targets: ['src'], options: searchOptions() },
      undefined,
      reader,
    );

    const [result] = await javascriptEngine.searchFiles(
      enumeration.files,
      [{ root, symbol: 'Widget', targets: ['src'], options: searchOptions() }],
      [],
      enumeration.skipped,
    );

    expect(result?.scope.skipped).toEqual([{ path: 'src/locked', reason: 'unreadable' }]);
  });

  it('walks the tree once for two questions that share a walk', async () => {
    const root = await repo({ 'src/a.ts': 'Widget and Gadget\n' });
    const engine = await resolveEngine('auto');
    const spy = vi.spyOn(fsp, 'readdir');

    await engine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });
    const afterFirst = spy.mock.calls.length;
    await engine.search({ root, symbol: 'Gadget', targets: ['src'], options: searchOptions() });

    expect(afterFirst).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBe(afterFirst);
  });

  it('walks again when the second question is about a different tree', async () => {
    const root = await repo({ 'src/a.ts': 'Widget\n', 'lib/b.ts': 'Widget\n' });
    const engine = await resolveEngine('auto');
    const spy = vi.spyOn(fsp, 'readdir');

    await engine.search({ root, symbol: 'Widget', targets: ['src'], options: searchOptions() });
    const afterFirst = spy.mock.calls.length;
    await engine.search({ root, symbol: 'Widget', targets: ['lib'], options: searchOptions() });

    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('resolveEngine', () => {
  it('returns the javascript engine itself, not something that answers to its name', async () => {
    // The adaptive engine also calls itself "javascript" until it has used
    // ripgrep, so asserting the name proved nothing about which engine came
    // back.
    expect(await resolveEngine('javascript')).toBe(javascriptEngine);
  });

  it('chooses adaptively when asked for nothing in particular', async () => {
    const engine = await resolveEngine();
    expect(engine).not.toBe(javascriptEngine);
    expect(engine.name).toBe('javascript');
  });

  it('chooses adaptively when asked for auto by name', async () => {
    expect(await resolveEngine('auto')).not.toBe(javascriptEngine);
  });
});

describe('the small-tree budget', () => {
  it('is larger on Windows, where spawning a process costs an order of magnitude more', () => {
    // Both branches asserted on whichever platform the suite runs on. Read
    // from `process.platform` instead, each branch was verified on exactly one
    // operating system and taken on trust everywhere else.
    expect(smallTreeBudget('win32')).toEqual({ maxFiles: 512, maxBytes: 1024 * 1024 });
    expect(smallTreeBudget('linux')).toEqual({ maxFiles: 32, maxBytes: 64 * 1024 });
    expect(smallTreeBudget('darwin')).toEqual(smallTreeBudget('linux'));
  });

  it('is the budget this process actually uses', () => {
    expect(SMALL_TREE_BUDGET).toEqual(smallTreeBudget(process.platform));
  });
});

describe('ripgrepFailureMessage', () => {
  it('names the exit code', () => {
    expect(ripgrepFailureMessage(2, '')).toBe('ripgrep exited with code 2');
  });

  it('appends what ripgrep said, without its trailing newline', () => {
    // Every command-line tool ends its diagnostics with a newline, and left in
    // it lands in the middle of a one-line report.
    expect(ripgrepFailureMessage(2, 'rg: unknown flag\n')).toBe('ripgrep exited with code 2: rg: unknown flag');
  });

  it('says nothing extra when ripgrep said nothing', () => {
    expect(ripgrepFailureMessage(101, '')).toBe('ripgrep exited with code 101');
  });

  it('reports a signal death as a null code', () => {
    expect(ripgrepFailureMessage(null, 'killed\n')).toBe('ripgrep exited with code null: killed');
  });
});

describe('an empty batch is answered without searching', () => {
  it('for the javascript engine', async () => {
    expect(await javascriptEngine.searchBatch([])).toEqual([]);
  });

  it('for an already-enumerated file list', async () => {
    expect(await javascriptEngine.searchFiles([], [])).toEqual([]);
  });

  it('for the adaptive engine', async () => {
    const engine = await resolveEngine('auto');
    expect(await (engine.searchBatch as NonNullable<typeof engine.searchBatch>)([])).toEqual([]);
  });

  it('for runSearches, whatever the engine', async () => {
    expect(await runSearches(javascriptEngine, [])).toEqual([]);
  });
});

describe('createCachedEngine', () => {
  it('records no fallback when the javascript engine is the one that failed', async () => {
    // There is nothing to fall back to, so a fallback note would be a claim
    // that a second engine had been tried.
    const engine = createCachedEngine(javascriptEngine);

    await expect(
      engine.search(request({ symbol: '(', options: searchOptions({ regex: true }) })),
    ).rejects.toThrow();
    expect(engine.fallbacks).toEqual([]);
  });

  it('answers an empty batch without consulting the engine', async () => {
    let calls = 0;
    const engine = createCachedEngine({
      name: 'javascript',
      async search(searchRequest) {
        calls += 1;
        return javascriptEngine.search(searchRequest);
      },
    });

    expect(await engine.searchBatch([])).toEqual([]);
    expect(calls).toBe(0);
  });
});
