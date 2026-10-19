/**
 * Another git work tree below the root is not this one. ADR-0007, amended
 * 2026-10-19.
 *
 * A desktop-app session keeps its worktree under `.claude/worktrees/<name>`,
 * which holds a `.git` file rather than a directory, so the walk read it as
 * any other directory: a rule over `.` counted the worktree's code with the
 * checkout's, `cites` counted its citations twice, and a stale citation in it
 * failed `cites --strict` in the checkout above it. A submodule holds a `.git` file too, and a
 * clone a `.git` directory with a `HEAD` in it.
 */

import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { findCitations } from '../src/cites.js';
import {
  buildWorkTreeArgs,
  compareWalkOrder,
  createCachedEngine,
  createJavaScriptEngine,
  javascriptEngine,
  parseWorkTreeTops,
  resolveEngine,
  setAsideWorkTrees,
  type SearchRequest,
} from '../src/engine.js';
import { expandSpecPatterns, isWorkTreeTop, walkPaths, type WalkOptions } from '../src/glob.js';
import type { Io } from '../src/io.js';
import { formatCites, formatCitesJson, formatReport } from '../src/reporter.js';
import { runSpecGuard } from '../src/runner.js';
import { DEFAULT_SCOPE, SCAN_EVERYTHING, type ScopePolicy } from '../src/scope.js';
import { createTreeIndex } from '../src/structure.js';
import type { SearchResult } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, memoryIo, removeTempRepo, searchOptions } from './helpers.js';

const ROOT = path.resolve('/virtual/checkout');
const NUL = String.fromCharCode(0);
/** The default scope, but walking other work trees: what tells the two apart in a key. */
const WALKING: ScopePolicy = { skippedDirectories: DEFAULT_SCOPE.skippedDirectories, otherWorkTrees: 'walk' };

/** A checkout with one of each kind of work tree below it, and a `.git` directory that is no repository. */
const TREE: Record<string, string> = {
  'src/a.ts': 'export const Marker = 1;\n',
  '.claude/worktrees/feature/.git': 'gitdir: ../../../.git/worktrees/feature\n',
  '.claude/worktrees/feature/src/a.ts': 'export const Marker = 2;\n',
  'modules/sub/.git': 'gitdir: ../../.git/modules/sub\n',
  'modules/sub/s.ts': 'export const Marker = 3;\n',
  'vendor/lib/.git/HEAD': 'ref: refs/heads/main\n',
  'vendor/lib/lib.ts': 'export const Marker = 4;\n',
  'fixtures/not-a-repo/.git/config': '[core]\n',
  'fixtures/not-a-repo/f.ts': 'export const Marker = 5;\n',
};
const LEFT = ['.claude/worktrees/feature', 'modules/sub', 'vendor/lib'];

/** A door that cannot list one directory, and reads everything else from memory. */
function locked(files: Record<string, string>, directory: string): Io {
  const io = memoryIo(ROOT, files);
  return {
    ...io,
    readDirectory: (at) => (path.resolve(at) === path.resolve(ROOT, directory) ? Promise.reject(new Error('EACCES')) : io.readDirectory(at)),
  };
}

async function walk(files: Record<string, string>, start = '', options: WalkOptions = {}) {
  const walked: string[] = [];
  const skipped: Array<[string, string]> = [];
  const walking = walkPaths(path.resolve(ROOT, start), { io: memoryIo(ROOT, files), onSkip: (at, reason) => skipped.push([at, reason]), ...options });
  for await (const entry of walking) walked.push(entry.relativePath);
  return { walked, skipped };
}

describe('the walk', () => {
  it('does not enter a directory holding a .git file, or a .git directory with a HEAD, and says so', async () => {
    expect(await walk(TREE)).toEqual({
      walked: ['fixtures/not-a-repo/f.ts', 'src/a.ts'],
      skipped: [
        ['.claude/worktrees/feature', 'worktree'],
        ['fixtures/not-a-repo/.git', 'vcs'],
        ['modules/sub', 'worktree'],
        ['vendor/lib', 'worktree'],
      ],
    });
  });

  it('walks where it starts, a root that is itself a linked worktree among them', async () => {
    expect((await walk({ '.git': 'gitdir: elsewhere\n', 'src/a.ts': '' })).walked).toEqual(['.git', 'src/a.ts']);
    expect(await walk(TREE, 'vendor/lib')).toEqual({ walked: ['lib.ts'], skipped: [['.git', 'vcs']] });
  });

  it('names the outermost work tree only, since it enters none', async () => {
    const nested = { 'a/.git': 'gitdir: x\n', 'a/b/.git': 'gitdir: y\n', 'a/b/c.ts': '' };
    expect(await walk(nested)).toEqual({ walked: [], skipped: [['a', 'worktree']] });
  });

  it('walks every one under a scope that walks them', async () => {
    for (const scope of [SCAN_EVERYTHING, WALKING]) {
      const { walked } = await walk(TREE, '', { scope });
      expect(walked).toEqual(expect.arrayContaining(['.claude/worktrees/feature/src/a.ts', 'modules/sub/s.ts', 'vendor/lib/lib.ts']));
    }
  });
});

describe('the top of a work tree', () => {
  const entry = (kind: 'file' | 'directory' | 'link') => ({
    name: '.git',
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'link',
  });
  const io = (head: boolean): Io => ({ ...memoryIo(ROOT, {}), stat: async (at) => (head && path.basename(at) === 'HEAD' ? ({ isFile: () => true } as never) : null) });
  const top = (kind: 'file' | 'directory' | 'link', head: boolean) => isWorkTreeTop(path.resolve(ROOT, 'd'), [entry(kind)] as never, io(head));

  it('is a .git file, or a .git directory with a HEAD in it', async () => {
    expect(await top('file', false)).toBe(true);
    expect(await top('directory', true)).toBe(true);
  });

  it('is not a .git directory without a HEAD, which git reads as no repository', async () => {
    expect(await top('directory', false)).toBe(false);
  });

  it('is not a link named .git, which neither engine follows', async () => {
    expect(await top('link', true)).toBe(false);
  });

  it('is not a directory with no .git in it', async () => {
    expect(await isWorkTreeTop(ROOT, [], io(true))).toBe(false);
  });
});

describe('what ripgrep lists', () => {
  const listing = (...entries: string[]) => entries.join(NUL) + NUL;

  it('reads each .git file and each HEAD of a .git directory as the top of a work tree, outermost first in walk order', () => {
    const listed = listing('.git/HEAD', 'vendor/lib/.git/HEAD', 'modules/sub/.git', 'a-b/x/.git', 'a/x/.git', 'a/x/y/.git', 'src/a.ts');
    expect(parseWorkTreeTops(listed, ROOT, '.', DEFAULT_SCOPE)).toEqual(['a/x', 'a-b/x', 'modules/sub', 'vendor/lib']);
  });

  it('leaves the target itself, what is above it, and what is under a name the scope leaves out', () => {
    expect(parseWorkTreeTops(listing('vendor/.git', 'vendor/lib/.git/HEAD'), ROOT, 'vendor', DEFAULT_SCOPE)).toEqual(['vendor/lib']);
    expect(parseWorkTreeTops(listing('modules/sub/.git'), ROOT, 'modules/sub/.git', DEFAULT_SCOPE)).toEqual([]);
    expect(parseWorkTreeTops(listing('.git/.git', 'node_modules/pkg/.git', './x/.git'), ROOT, '.', DEFAULT_SCOPE)).toEqual(['x']);
  });

  it('sorts as the walk meets directories: a name at a time', () => {
    expect(['a-b/x', 'a/x/y', 'b', 'a/x', 'a'].sort(compareWalkOrder)).toEqual(['a', 'a/x', 'a/x/y', 'a-b/x', 'b']);
  });

  it('asks ripgrep for every .git file and HEAD below a target, hidden and ignored ones too, entering a .git directory for its HEAD alone', () => {
    const args = buildWorkTreeArgs(DEFAULT_SCOPE, 'src');
    expect(args.slice(0, 2)).toEqual(['--files', '--null']);
    expect(args).toEqual(expect.arrayContaining(['--no-config', '--hidden', '--no-ignore']));
    expect(args.slice(-2)).toEqual(['--', 'src']);
    expect(args).not.toContain('!.git/');
  });

  it('sets aside what a search found in a work tree a target leaves out, and not what another target reaches', () => {
    const file = (relativePath: string) => ({ absolutePath: path.resolve(ROOT, relativePath), relativePath });
    const found = { files: [file('a.ts'), file('w/b.ts'), file('v/c.ts')], unreadable: ['./w/locked.ts', 'v/locked.ts', 'locked.ts'] };
    const trees = [
      { start: '', tops: ['v', 'w'] },
      { start: 'v', tops: [] },
    ];
    const kept = setAsideWorkTrees(trees, ROOT, found);
    expect(kept.files.map((entry) => entry.relativePath)).toEqual(['a.ts', 'v/c.ts']);
    expect(kept.unreadable).toEqual(['v/locked.ts', 'locked.ts']);
  });
});

describe('a key', () => {
  it('tells a scope that walks other work trees from one that does not', async () => {
    const engine = createCachedEngine(createJavaScriptEngine(memoryIo(ROOT, TREE)));
    const request = (scope: ScopePolicy): SearchRequest => ({ root: ROOT, symbol: 'Marker', targets: ['.'], options: searchOptions({ scope }) });
    expect((await engine.search(request(DEFAULT_SCOPE))).count).toBe(2);
    expect((await engine.search(request(WALKING))).count).toBe(5);
    const index = createTreeIndex(ROOT, memoryIo(ROOT, TREE));
    expect((await index.walk('.', DEFAULT_SCOPE)).files).toHaveLength(2);
    expect((await index.walk('.', WALKING)).files).toHaveLength(7);
  });
});

const rgPath = findTestRipgrep();

describe.skipIf(!rgPath)('both engines', () => {
  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.map(removeTempRepo));
  });

  async function repo(files: Record<string, string>): Promise<string> {
    const root = await makeTempRepo(files);
    temporary.push(root);
    return root;
  }

  const verdict = (result: SearchResult) => ({ count: result.count, files: [...result.fileCounts.keys()], skipped: result.scope.skipped });

  async function both(root: string, overrides: Partial<SearchRequest> = {}) {
    process.env.SPEC_GUARD_RG = rgPath as string;
    const request: SearchRequest = { root, symbol: 'Marker', targets: ['.'], options: searchOptions(), ...overrides };
    const ripgrep = await resolveEngine('ripgrep');
    return { scanner: verdict(await javascriptEngine.search(request)), ripgrep: verdict(await ripgrep.search(request)) };
  }

  const MORE = {
    ...TREE,
    'a/x/.git': 'gitdir: a\n',
    'a/x/m.ts': 'export const Marker = 6;\n',
    'a-b/x/.git/HEAD': 'ref: refs/heads/main\n',
    'a-b/x/m.ts': 'export const Marker = 7;\n',
    'node_modules/pkg/.git': 'gitdir: b\n',
    'node_modules/pkg/m.ts': 'export const Marker = 8;\n',
    'src/lib/.git/HEAD': 'ref: refs/heads/main\n',
    'src/lib/m.ts': 'export const Marker = 9;\n',
  };
  const ALL_LEFT = ['.claude/worktrees/feature', 'a/x', 'a-b/x', 'modules/sub', 'src/lib', 'vendor/lib'];

  it('leave out the same work trees, read the same files and name the same tops in the same order', async () => {
    const root = await repo(MORE);
    const { scanner, ripgrep } = await both(root);
    expect(scanner).toEqual({ count: 2, files: ['fixtures/not-a-repo/f.ts', 'src/a.ts'], skipped: ALL_LEFT.map((at) => ({ path: at, reason: 'worktree' })) });
    expect(ripgrep).toEqual(scanner);
  });

  it('read a work tree a target names, a file in one, and a target that holds none', async () => {
    const root = await repo(MORE);
    const named = await both(root, { targets: ['.', 'src/lib'] });
    expect(named.scanner.files).toEqual(['fixtures/not-a-repo/f.ts', 'src/a.ts', 'src/lib/m.ts']);
    expect(named.ripgrep).toEqual(named.scanner);
    const file = await both(root, { targets: ['vendor/lib/lib.ts'] });
    expect(file.scanner).toEqual({ count: 1, files: ['vendor/lib/lib.ts'], skipped: [] });
    expect(file.ripgrep).toEqual(file.scanner);
    const none = await both(root, { targets: ['fixtures'] });
    expect(none.scanner).toEqual({ count: 1, files: ['fixtures/not-a-repo/f.ts'], skipped: [] });
    expect(none.ripgrep).toEqual(none.scanner);
  });

  it('do not name a work tree whose .git the rule\'s own exclude covers', async () => {
    const root = await repo(MORE);
    const { scanner, ripgrep } = await both(root, { options: searchOptions({ excludeGlobs: ['.claude', 'vendor/lib/**'] }) });
    expect(scanner.skipped.map((entry) => entry.path)).toEqual(['a/x', 'a-b/x', 'modules/sub', 'src/lib']);
    expect(ripgrep).toEqual(scanner);
  });

  it('read every one under a scope that skips nothing', async () => {
    const root = await repo(MORE);
    const { scanner, ripgrep } = await both(root, { options: searchOptions({ scope: SCAN_EVERYTHING }) });
    expect(scanner.count).toBe(9);
    expect(scanner.skipped).toEqual([]);
    expect(ripgrep).toEqual(scanner);
  });
});

describe('a run', () => {
  const RULES = [
    '<!-- @assert-absence symbol="LegacyThing" -->',
    '<!-- @assert-count target="." symbol="Marker" max="100" -->',
  ].join('\n');
  const files = {
    ...TREE,
    'docs/rules.md': `# Rules\n\n${RULES}\n`,
    '.claude/worktrees/feature/src/b.ts': 'export const LegacyThing = 1;\n',
    '.claude/worktrees/feature/docs/rules.md': `# Rules\n\n${RULES}\n`,
  };

  it('passes a checkout whose worktree breaks its rule, says which work trees it did not read, and --strict passes over them', async () => {
    for (const strictTargets of [false, true]) {
      const report = await runSpecGuard({ root: ROOT, patterns: ['**/*.md'], io: memoryIo(ROOT, files), strictTargets });
      expect(report.ok, `strict ${strictTargets}`).toBe(true);
      expect(report.specFiles).toEqual(['docs/rules.md']);
      expect(report.results.map((result) => result.actual)).toEqual([0, 2]);
      expect(report.results[1]?.scope.skipped.map((entry) => entry.path)).toEqual(LEFT);
      expect(formatReport(report, { color: false, ascii: true, verbose: false })).toContain(`3 other git work trees not read: ${LEFT.join(', ')}`);
    }
  });

  it('says nothing of work trees where it left none out', async () => {
    const report = await runSpecGuard({ root: ROOT, patterns: ['docs/rules.md'], io: memoryIo(ROOT, { 'docs/rules.md': `# Rules\n\n${RULES}\n`, 'src/a.ts': 'export const Marker = 1;\n' }) });
    expect(report.ok).toBe(true);
    expect(formatReport(report, { color: false, ascii: true, verbose: true })).not.toContain('work tree');
  });

  it('passes a structure rule over them under --strict, where only a gap fails it', async () => {
    const tree = { ...TREE, 'docs/rules.md': '<!-- @assert-structure target="." glob="*.ts" pattern="*.ts" -->\n' };
    const report = await runSpecGuard({ root: ROOT, patterns: ['docs/rules.md'], io: memoryIo(ROOT, tree), strictTargets: true });
    expect(report.results.map((result) => [result.ok, result.scope.skipped.length])).toEqual([[true, 3]]);
  });

  it('names three of more than three, as it names three of any paths', async () => {
    const report = await runSpecGuard({ root: ROOT, patterns: ['docs/rules.md'], io: memoryIo(ROOT, { ...files, 'z/.git': 'gitdir: z\n' }) });
    const said = formatReport(report, { color: false, ascii: true, verbose: false });
    expect(said).toContain(`4 other git work trees not read: ${LEFT.join(', ')}\n`);
    expect(said).not.toContain(', z');
  });

  it('says which work trees a scope that holds no file left out, and as before nothing of what it could not read', async () => {
    const tree = { ...TREE, 'docs/rules.md': '<!-- @assert-absence target=".claude" symbol="x" -->\n', '.claude/settings/a/b.ts': '' };
    const report = await runSpecGuard({ root: ROOT, patterns: ['docs/rules.md'], io: locked(tree, '.claude/settings/a') });
    const [result] = report.results;
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('no files were inspected');
    expect(result?.scope.skipped).toEqual([{ path: '.claude/worktrees/feature', reason: 'worktree' }]);
  });

  it('leaves them out of an import rule, a structure rule and the specs a pattern finds', async () => {
    const tree = {
      ...TREE,
      'docs/rules.md': [
        '<!-- @assert-import-absence target="." module="forbidden" -->',
        '<!-- @assert-structure target="." glob="*.ts" pattern="a.ts,f.ts" -->',
        '<!-- @assert-structure target="." glob="*.ts" exclude="vendor/lib/**" pattern="a.ts,f.ts" -->',
      ].join('\n'),
      'vendor/lib/uses.ts': "import 'forbidden';\n",
      'src/locked/c.ts': "import 'forbidden';\n",
    };
    for (const strictTargets of [false, true]) {
      const report = await runSpecGuard({ root: ROOT, patterns: ['docs/rules.md'], io: locked(tree, 'src/locked'), strictTargets });
      // The import rule says nothing of the directory it could not list, as
      // before; the structure rule names it as a gap, and fails for it under
      // --strict, as before.
      expect(report.results.map((result) => [result.ok, result.scope.skipped.map((entry) => `${entry.path} ${entry.reason}`)])).toEqual([
        [true, LEFT.map((at) => `${at} worktree`)],
        [!strictTargets, ['src/locked unreadable', ...LEFT.map((at) => `${at} worktree`)]],
        [!strictTargets, ['src/locked unreadable', '.claude/worktrees/feature worktree', 'modules/sub worktree']],
      ]);
    }
    expect(await expandSpecPatterns(['**/*.md'], ROOT, undefined, memoryIo(ROOT, { ...TREE, 'docs/a.md': '', 'vendor/lib/docs/b.md': '' }))).toEqual([
      path.resolve(ROOT, 'docs/a.md'),
    ]);
  });
});

describe('cites', () => {
  const files = {
    'docs/adr/0001-the-rule.md': '# ADR-0001: The rule\n\n## Status\n\nAccepted.\n',
    'docs/adr/0002-old.md': '# ADR-0002: An old one\n\n## Status\n\nSuperseded by ADR-0001.\n',
    'src/a.ts': '// ADR-0001\nexport const a = 1;\n',
    '.claude/worktrees/feature/.git': 'gitdir: x\n',
    '.claude/worktrees/feature/src/a.ts': '// ADR-0002\nexport const a = 2;\n',
    'modules/sub/.git': 'gitdir: z\n',
    'modules/sub/s.ts': '// ADR-0002\n',
    'reports/old/.git': 'gitdir: y\n',
    'reports/old/a.ts': '// ADR-0002\n',
    'fixtures/not-a-repo/.git/config': '[core]\n',
  };
  const io = () => memoryIo(ROOT, files);

  it('reads no comment of another work tree, and names each one the project does not exclude, once', async () => {
    const report = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], exclude: ['reports'], strict: true, io: io() });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.citations).toBe(1);
    expect(report.workTrees).toEqual(['.claude/worktrees/feature', 'modules/sub']);
    const twice = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], exclude: ['reports'], paths: ['.', 'modules'], io: io() });
    expect(twice.workTrees).toEqual(['.claude/worktrees/feature', 'modules/sub']);
    expect(formatCites(report, { color: false, ascii: true, verbose: false })).toContain('2 other git work trees not read: .claude/worktrees/feature, modules/sub');
    expect(JSON.parse(formatCitesJson(report)).workTrees).toEqual(['.claude/worktrees/feature', 'modules/sub']);
  });

  it('names a work tree below a path it was given, from the root', async () => {
    const report = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], paths: ['modules'], io: io() });
    expect(report.workTrees).toEqual(['modules/sub']);
  });

  it('reads them all under a scope that skips nothing', async () => {
    const report = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], defaultSkips: false, io: io() });
    expect(report.findings.map((finding) => finding.message.split(' ')[0])).toEqual(['.claude/worktrees/feature/src/a.ts:1', 'modules/sub/s.ts:1', 'reports/old/a.ts:1']);
    expect(report.workTrees).toEqual([]);
  });
});
