/**
 * The scanner and ripgrep, on the pattern shapes their readings of a glob
 * once split over. ADR-0015.
 *
 * ripgrep's globset and spec-core parse the same syntax. Handed the pattern
 * as spec-guard normalised it, ripgrep still read braces, `.` segments, a
 * lone `}` and a leading `/` differently, and applied no filter at all to a
 * target it was handed by name. Every file in the tree holds one match, so a
 * count is a file count, and each case states the files it expects: agreeing
 * with each other is not enough, since the two used to agree on nothing at all
 * for `glob="*.{ts"`.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { javascriptEngine, resetRipgrepProbe, resolveEngine, type SearchRequest } from '../src/engine.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;

let treeOnce: Promise<string> | undefined;

function tree(): Promise<string> {
  treeOnce ??= makeTempRepo(
    Object.fromEntries(
      [
        'a.ts',
        'README.md',
        'x.log',
        '}a.ts',
        'c/d.log',
        'docs/a.md',
        'docs/x/b.md',
        'src/a.ts',
        'src/b.md',
        'src/!a',
        'src/x}y',
        'src/deep/c.ts',
        'src/tests/t.ts',
        'tests/u.ts',
      ].map((file) => [file, 'TOKEN\n']),
    ),
  );
  return treeOnce;
}

afterAll(async () => {
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
  if (treeOnce) await removeTempRepo(await treeOnce);
});

interface Case {
  name: string;
  globs?: string[];
  exclude?: string[];
  targets?: string[];
  files: string[];
}

const EVERY = [
  'README.md',
  'a.ts',
  'c/d.log',
  'docs/a.md',
  'docs/x/b.md',
  'src/!a',
  'src/a.ts',
  'src/b.md',
  'src/deep/c.ts',
  'src/tests/t.ts',
  'src/x}y',
  'tests/u.ts',
  'x.log',
  '}a.ts',
];
const without = (...files: string[]): string[] => EVERY.filter((file) => !files.includes(file));

const cases: Case[] = [
  {
    name: 'braces whose alternatives are anchored differently',
    globs: ['{src/*.ts,*.md}'],
    files: ['README.md', 'docs/a.md', 'docs/x/b.md', 'src/a.ts', 'src/b.md'],
  },
  {
    name: 'the same braces, excluded',
    exclude: ['{src/tests,*.log}'],
    files: without('c/d.log', 'src/tests/t.ts', 'x.log'),
  },
  { name: 'an empty alternative', globs: ['{,src/}a.ts'], files: ['a.ts', 'src/a.ts'] },
  { name: 'nested braces', globs: ['{a,{b,c}}.ts'], files: ['a.ts', 'src/a.ts', 'src/deep/c.ts'] },
  { name: 'a . segment', globs: ['src/./a.ts'], files: ['src/a.ts'] },
  { name: 'a . segment, excluded', exclude: ['src/./tests'], files: without('src/tests/t.ts') },
  { name: 'an empty segment', globs: ['src//a.ts'], files: ['src/a.ts'] },
  { name: 'a } that closes nothing', globs: ['}a.ts', 'src/x}y'], files: ['src/x}y', '}a.ts'] },
  { name: 'a } that closes nothing, excluded', exclude: ['}a.ts'], files: without('}a.ts') },
  { name: 'an alternative that starts with !', globs: ['{!a,x.log}'], files: ['src/!a', 'x.log'] },
  { name: 'an alternative that starts with !, excluded', exclude: ['{!a,tests}'], files: without('src/!a', 'src/tests/t.ts', 'tests/u.ts') },
  { name: 'a leading / on a name', globs: ['/*.ts'], files: ['a.ts', '}a.ts'] },
  { name: 'a leading / on a path', globs: ['/src/*.ts'], files: ['src/a.ts'] },
  { name: 'a leading / on braces', globs: ['/{a,src/a}.ts'], files: ['a.ts', 'src/a.ts'] },
  // ripgrep applies no glob to a path it is handed by name.
  { name: 'a file target the glob does not match', targets: ['src/a.ts'], globs: ['*.md'], files: [] },
  { name: 'a target inside an excluded directory', targets: ['src/tests'], exclude: ['tests'], files: [] },
  { name: 'a target the exclusion names, anchored', targets: ['tests', 'src'], exclude: ['/tests'], files: without('tests/u.ts').filter((file) => file.startsWith('src/')) },
];

function request(root: string, entry: Case): SearchRequest {
  return {
    root,
    symbol: 'TOKEN',
    targets: entry.targets ?? ['.'],
    options: searchOptions({ globs: entry.globs ?? [], excludeGlobs: entry.exclude ?? [] }),
  };
}

const filesOf = (result: { matches: Array<{ file: string }> }): string[] => [...new Set(result.matches.map((match) => match.file))].sort();

describe('the scanner', () => {
  it.each(cases)('$name', async (entry) => {
    const result = await javascriptEngine.search(request(await tree(), entry));
    expect(filesOf(result)).toEqual([...entry.files].sort());
    expect(result.count).toBe(entry.files.length);
  });
});

describe.runIf(rgPath)('ripgrep', () => {
  it.each(cases)('$name', async (entry) => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    const result = await (await resolveEngine('ripgrep')).search(request(await tree(), entry));
    expect(result.engine).toBe('ripgrep');
    expect(filesOf(result)).toEqual([...entry.files].sort());
    expect(result.count).toBe(entry.files.length);
  });
});
