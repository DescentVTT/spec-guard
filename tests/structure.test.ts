/**
 * `@assert-structure`: names, required entries and partners. ADR-0013.
 *
 * Every rule that passes here sits beside the smallest change that makes it
 * fail - one letter of case, one missing file, one forgotten exclude - because
 * a structure rule that says yes to every tree passes every positive test ever
 * written for it. The trees are real directories, empty ones included, since
 * the one thing a structure rule most needs to see is the thing a list of files
 * cannot show.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { javascriptEngine } from '../src/engine.js';
import { defaultDirectoryReader, type DirectoryReader } from '../src/glob.js';
import { createImportIndex } from '../src/imports.js';
import { parseDirectives } from '../src/parser.js';
import { formatBaselines, formatJson, formatReport, formatSarif } from '../src/reporter.js';
import { createScopeProbe, executeAssertion, resolveDirective, runSpecGuard, type RunOptions, type RunResult } from '../src/runner.js';
import { DEFAULT_SCOPE, SCAN_EVERYTHING } from '../src/scope.js';
import {
  checkStructure,
  createTreeIndex,
  expandPartner,
  partnerTemplateIssue,
  requiredEntryIssue,
  type TreeIndex,
} from '../src/structure.js';
import type { Assertion, AssertionResult } from '../src/types.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

/** A scratch tree: files with content, and directories that are empty. */
async function tree(files: Record<string, string>, empty: readonly string[] = []): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  for (const directory of empty) await fs.mkdir(path.join(root, directory), { recursive: true });
  return root;
}

/**
 * Runs directives against a tree. The spec lives in a tree of its own, so a
 * rule over the whole root is not also a rule about the spec - except where a
 * test puts it there on purpose.
 */
async function run(root: string, directives: readonly string[], options: Partial<RunOptions> = {}): Promise<RunResult> {
  const specs = await tree({ 'rules.md': `${directives.join('\n')}\n` });
  return runSpecGuard({ patterns: [path.join(specs, 'rules.md')], root, engine: 'javascript', ...options });
}

/** What a reader acts on: pass or fail, the count, the message and the listed paths. */
function outcome(result: AssertionResult | undefined): { ok: boolean; actual: number; message: string; listed: string[] } {
  const found = result as AssertionResult;
  return {
    ok: found.ok,
    actual: found.actual,
    message: found.message,
    listed: found.matches.map((match) => `${match.file}  ${match.text}`),
  };
}

async function one(root: string, directive: string, options: Partial<RunOptions> = {}): Promise<ReturnType<typeof outcome>> {
  const report = await run(root, [directive], options);
  expect(report.errors).toEqual([]);
  return outcome(report.results[0]);
}

const LOCATION = { file: path.resolve('/virtual/docs/a.md'), relativeFile: 'docs/a.md' };

function resolve(directive: string, root = path.resolve('/virtual')): { assertion: Assertion } | { error: { message: string } } {
  const { directives, errors } = parseDirectives(directive, LOCATION);
  expect(errors).toEqual([]);
  return resolveDirective(directives[0] as NonNullable<(typeof directives)[0]>, { root, excludeFiles: new Set([LOCATION.file]), scope: DEFAULT_SCOPE });
}

function assertionOf(directive: string, root?: string): Assertion {
  const resolved = resolve(directive, root);
  if ('error' in resolved) throw new Error(resolved.error.message);
  return resolved.assertion;
}

/** What `executeAssertion` needs, as a run would set it up. */
function executeOptions(root: string): Parameters<typeof executeAssertion>[1] {
  return {
    root,
    engine: javascriptEngine,
    allowMissingTargets: false,
    strictTargets: false,
    allowEmptyScope: false,
    maxSnippets: 5,
    imports: createImportIndex(),
    hasFiles: createScopeProbe(),
    tree: createTreeIndex(root),
  };
}

function errorOf(directive: string): string {
  const resolved = resolve(directive);
  if (!('error' in resolved)) throw new Error('expected an error');
  return resolved.error.message;
}

/* ------------------------------------------------------------ the grammar */

describe('expandPartner', () => {
  it('fills [name] up to the last dot and [ext] after it, beside the file', () => {
    expect(expandPartner('[name].test.ts', 'src/user.ts', 'src')).toBe('src/user.test.ts');
    expect(expandPartner('[name].spec.[ext]', 'src/api/user.handler.tsx', 'src')).toBe('src/api/user.handler.spec.tsx');
    expect(expandPartner('test_[name].py', 'app/models.py', 'app')).toBe('app/test_models.py');
  });

  it('reads a name with no dot, a leading dot, or a trailing one, as all name or no extension', () => {
    expect(expandPartner('[name]|[ext]', 'x/Makefile', 'x')).toBe('x/Makefile|');
    expect(expandPartner('[name]|[ext]', 'x/.env', 'x')).toBe('x/.env|');
    expect(expandPartner('[name]|[ext]', 'x/a.', 'x')).toBe('x/a|');
    expect(expandPartner('[name]|[ext]', 'x/.eslintrc.json', 'x')).toBe('x/.eslintrc|json');
  });

  it('names a sibling at the root without a leading ./', () => {
    expect(expandPartner('[name].test.ts', 'a.ts', '.')).toBe('a.test.ts');
  });

  it('reads a template with a / as a path from the root, with [dir] the directory below the target', () => {
    expect(expandPartner('tests/[dir]/test_[name].py', 'app/api/v1/users.py', 'app')).toBe('tests/api/v1/test_users.py');
    expect(expandPartner('tests/[dir]/[name].test.[ext]', 'src/a.ts', '.')).toBe('tests/src/a.test.ts');
    expect(expandPartner('[dir]/[name].md', 'src/x/a.ts', 'src')).toBe('x/a.md');
  });

  it('leaves no separator behind an empty [dir], at the top of a target or for a target that is the file', () => {
    expect(expandPartner('tests/[dir]/test_[name].py', 'app/users.py', 'app')).toBe('tests/test_users.py');
    expect(expandPartner('tests/[dir]/[name].test.ts', 'src/a.ts', 'src/a.ts')).toBe('tests/a.test.ts');
    expect(expandPartner('[dir]/[name].md', 'src/a.ts', 'src')).toBe('a.md');
  });

  it('fills every occurrence, and nothing that only resembles a placeholder', () => {
    expect(expandPartner('[name]/[name].[ext].[ext]', 'src/a.ts', 'src')).toBe('a/a.ts.ts');
  });
});

describe('partnerTemplateIssue', () => {
  it('accepts the three placeholders, in a sibling or a path from the root', () => {
    for (const template of ['[name].test.ts', '[name].spec.[ext]', 'tests/[dir]/test_[name].py', 'docs/x.md']) {
      expect(partnerTemplateIssue(template), template).toBeNull();
    }
  });

  it('refuses any other placeholder, spelled in any other way', () => {
    expect(partnerTemplateIssue('[nam].ts')).toBe('Partner template "[nam].ts" uses [nam]; the placeholders are [name], [ext] and [dir].');
    expect(partnerTemplateIssue('[NAME].ts')).toBe('Partner template "[NAME].ts" uses [NAME]; the placeholders are [name], [ext] and [dir].');
    expect(partnerTemplateIssue('[name].[]')).toBe('Partner template "[name].[]" uses []; the placeholders are [name], [ext] and [dir].');
    // What is left once the placeholders are taken out is what is judged.
    expect(partnerTemplateIssue('[[name]]')).toBe('Partner template "[[name]]" uses []; the placeholders are [name], [ext] and [dir].');
  });

  it('refuses a glob, since a partner is one name and a glob is many', () => {
    for (const template of ['*.test.ts', '[name].test.?s', '[name].{ts,js}', '[name', 'name]']) {
      expect(partnerTemplateIssue(template), template).toBe(
        `Partner template "${template}" is a name, not a glob, so it cannot hold *, ?, [, ], { or }.`,
      );
    }
  });

  it('refuses a path that could leave the root or has a hole in it', () => {
    for (const template of ['../[name].ts', './[name].ts', 'tests/../[name].ts', 'tests//[name].ts', '/abs/[name].ts', 'tests/', '']) {
      expect(partnerTemplateIssue(template), template).toBe(
        `Partner template "${template}" must be a path inside the root, with no empty, "." or ".." segment.`,
      );
    }
  });
});

describe('requiredEntryIssue', () => {
  it('accepts a name, a path, a directory and a glob in the last segment', () => {
    for (const entry of ['README.md', 'src/', 'src/index.ts', '*.csproj', 'docs/*.md', 'src/*/']) {
      expect(requiredEntryIssue(entry), entry).toBeNull();
    }
  });

  it('refuses ".", "..", an empty segment and an absolute path', () => {
    for (const entry of ['.', '..', './x', '../x', 'a/../b', 'a//b', '/x', '/', '', 'a//']) {
      expect(requiredEntryIssue(entry), entry).toBe(
        `Required entry "${entry}" must be a path inside the directory, with no empty, "." or ".." segment.`,
      );
    }
  });

  it('refuses a glob anywhere but the last segment', () => {
    for (const entry of ['*/index.ts', 'src/**/x.ts', '{a,b}/x']) {
      expect(requiredEntryIssue(entry), entry).toBe(`Required entry "${entry}" can use a glob only in its last segment.`);
    }
  });
});

/* ---------------------------------------------------------- the listings */

/** A directory reader that counts, by path relative to the root. */
function countingReader(root: string, fail: readonly string[] = []): { reader: DirectoryReader; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const reader: DirectoryReader = async (directory) => {
    const relative = path.relative(root, directory).replace(/\\/g, '/') || '.';
    reads.set(relative, (reads.get(relative) ?? 0) + 1);
    if (fail.includes(relative)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return defaultDirectoryReader(directory);
  };
  return { reader, reads };
}

describe('createTreeIndex', () => {
  it('walks every file and every directory below a target, empty directories included', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/deep/b.ts': '', 'other/c.ts': '' }, ['src/empty/inner', 'src/deep/hollow']);
    const walked = await createTreeIndex(root).walk('src', DEFAULT_SCOPE);
    expect(walked).toEqual({
      files: ['src/a.ts', 'src/deep/b.ts'],
      directories: ['src/deep', 'src/deep/hollow', 'src/empty', 'src/empty/inner'],
      gaps: [],
    });
    expect((await createTreeIndex(root).walk('.', DEFAULT_SCOPE)).files).toEqual(['other/c.ts', 'src/a.ts', 'src/deep/b.ts']);
  });

  it('skips the default directories without calling them gaps, and walks them when asked to', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/node_modules/x/i.js': '', 'src/.git/HEAD': '' });
    expect(await createTreeIndex(root).walk('src', DEFAULT_SCOPE)).toEqual({ files: ['src/a.ts'], directories: [], gaps: [] });
    expect(await createTreeIndex(root).walk('src', SCAN_EVERYTHING)).toEqual({
      files: ['src/.git/HEAD', 'src/a.ts', 'src/node_modules/x/i.js'],
      directories: ['src/.git', 'src/node_modules', 'src/node_modules/x'],
      gaps: [],
    });
  });

  it('records a directory it cannot list as a gap, the target itself included', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/locked/b.ts': '' });
    const { reader } = countingReader(root, ['src/locked']);
    expect(await createTreeIndex(root, reader).walk('src', DEFAULT_SCOPE)).toEqual({
      files: ['src/a.ts'],
      directories: ['src/locked'],
      gaps: ['src/locked'],
    });
    const whole = countingReader(root, ['src']);
    expect(await createTreeIndex(root, whole.reader).walk('src', DEFAULT_SCOPE)).toEqual({ files: [], directories: [], gaps: ['src'] });
  });

  it('walks a target once per run and scope, and lists each directory once for walks and lookups alike', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/deep/b.ts': '' });
    const { reader, reads } = countingReader(root);
    const index = createTreeIndex(root, reader);
    const first = index.walk('src', DEFAULT_SCOPE);
    expect(index.walk('src', DEFAULT_SCOPE)).toBe(first);
    expect(index.walk('src', SCAN_EVERYTHING)).not.toBe(first);
    expect(index.walk('src/deep', DEFAULT_SCOPE)).not.toBe(first);
    await Promise.all([first, index.walk('src', SCAN_EVERYTHING), index.walk('src/deep', DEFAULT_SCOPE)]);
    expect(await index.listing('src')).toBe(await index.listing('src'));
    expect([...(reads.values())].every((count) => count === 1)).toBe(true);
    // The root is read too: a lookup of src has to find src in it first.
    expect([...reads.keys()].sort()).toEqual(['.', 'src', 'src/deep']);
  });

  it('answers null for a directory that is not there', async () => {
    const root = await tree({ 'a.ts': '' });
    const index = createTreeIndex(root);
    expect(await index.listing('missing')).toBeNull();
    expect(await index.listing('a.ts')).toBeNull();
    expect([...((await index.listing('.')) as Map<string, unknown>).keys()]).toEqual(['a.ts']);
  });
});

/* ------------------------------------------------------------ the claims */

describe('pattern', () => {
  it('passes when every file in scope has an allowed name, and fails on the first that has not', async () => {
    const root = await tree({ 'src/domain/user.entity.ts': '', 'src/domain/index.ts': '' });
    const directive = '<!-- @assert-structure target="src/domain" pattern="*.entity.ts, index.ts" -->';
    expect(await one(root, directive)).toEqual({ ok: true, actual: 0, message: 'expected no misnamed files, found 0', listed: [] });

    await fs.writeFile(path.join(root, 'src/domain/helpers.ts'), '');
    await fs.mkdir(path.join(root, 'src/domain/deep'));
    await fs.writeFile(path.join(root, 'src/domain/deep/order.ts'), '');
    expect(await one(root, directive)).toEqual({
      ok: false,
      actual: 2,
      message: 'expected no misnamed files, found 2',
      listed: ['src/domain/deep/order.ts  matches none of *.entity.ts, index.ts', 'src/domain/helpers.ts  matches none of *.entity.ts, index.ts'],
    });
  });

  it('applies to the files glob chooses and not to those exclude removes', async () => {
    const root = await tree({ 'src/a.entity.ts': '', 'src/a.test.ts': '', 'src/README.md': '', 'src/legacy/old.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" glob="*.ts" exclude="*.test.ts, legacy" pattern="*.entity.ts" -->')).toMatchObject({ ok: true, actual: 0 });
    expect(await one(root, '<!-- @assert-structure target="src" glob="*.ts" exclude="legacy" pattern="*.entity.ts" -->')).toMatchObject({
      ok: false,
      listed: ['src/a.test.ts  matches none of *.entity.ts'],
    });
  });

  it('matches a pattern with a / against the path from the root', async () => {
    const root = await tree({ 'src/api/a.ts': '', 'src/web/b.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" pattern="src/api/*.ts" -->')).toMatchObject({
      ok: false,
      listed: ['src/web/b.ts  matches none of src/api/*.ts'],
    });
  });

  it('holds a target that is a file to the rule, when glob lets it in', async () => {
    const root = await tree({ 'src/index.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src/index.ts" pattern="*.js" -->')).toMatchObject({ ok: false, actual: 1 });
    expect(await one(root, '<!-- @assert-structure target="src/index.ts" glob="*.md" pattern="*.js" -->')).toMatchObject({
      ok: false,
      message: 'no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
    });
  });

  it('counts the spec files, which every other rule leaves out', async () => {
    const root = await tree({ 'docs/adr/0001-first.md': '', 'docs/adr/notes.md': '' });
    await fs.writeFile(path.join(root, 'docs/adr/0002-rules.md'), '<!-- @assert-structure target="docs/adr" pattern="[0-9][0-9][0-9][0-9]-*.md" -->\n');
    await fs.writeFile(path.join(root, 'docs/adr/rules.md'), '<!-- @assert-absence target="docs/adr" symbol="assert-structure" comments="include" -->\n');
    const report = await runSpecGuard({ patterns: ['docs/adr/*rules.md'], root, engine: 'javascript' });
    expect(report.results.map(outcome)).toEqual([
      { ok: false, actual: 2, message: 'expected no misnamed files, found 2', listed: ['docs/adr/notes.md  matches none of [0-9][0-9][0-9][0-9]-*.md', 'docs/adr/rules.md  matches none of [0-9][0-9][0-9][0-9]-*.md'] },
      // The control: a text rule over the same directory does not find either spec.
      { ok: true, actual: 0, message: 'expected no matches, found 0', listed: [] },
    ]);
  });

  it('is not about what a file holds, only what it is called', async () => {
    const root = await tree({ 'src/a.entity.ts': '\u0000binary\u0000', 'src/b.entity.ts': 'text' });
    expect(await one(root, '<!-- @assert-structure target="src" pattern="*.entity.ts" -->', { strictTargets: true })).toMatchObject({ ok: true, actual: 0 });
  });
});

describe('required', () => {
  it('holds the target to its entries and lists only the entries it lacks, in the order written', async () => {
    const root = await tree({ 'pkg/package.json': '', 'pkg/LICENSE': '' });
    expect(await one(root, '<!-- @assert-structure target="pkg" required="package.json, LICENSE" -->')).toEqual({
      ok: true,
      actual: 0,
      message: 'expected no directories missing an entry, found 0',
      listed: [],
    });
    expect(await one(root, '<!-- @assert-structure target="pkg" required="README.md, package.json, SECURITY.md" -->')).toEqual({
      ok: false,
      actual: 1,
      message: 'expected no directories missing an entry, found 1',
      listed: ['pkg  missing README.md, SECURITY.md'],
    });
  });

  it('with dirs="*", holds every child directory - an empty one too - and neither the target nor a grandchild', async () => {
    const root = await tree(
      { 'packages/api/package.json': '', 'packages/api/nested/x.ts': '', 'packages/web/index.ts': '' },
      ['packages/empty'],
    );
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->')).toMatchObject({
      ok: false,
      actual: 2,
      listed: ['packages/empty  missing package.json', 'packages/web  missing package.json'],
    });
  });

  it('with dirs="**", holds directories at every depth, and a glob of a path matches from the target', async () => {
    const root = await tree({ 'svc/a/Dockerfile': '', 'svc/a/b/Dockerfile': '', 'svc/a/b/c/x.ts': '', 'svc/d/Dockerfile': '' });
    expect(await one(root, '<!-- @assert-structure target="svc" dirs="**" required="Dockerfile" -->')).toMatchObject({
      ok: false,
      listed: ['svc/a/b/c  missing Dockerfile'],
    });
    expect(await one(root, '<!-- @assert-structure target="svc" dirs="a/*" required="Dockerfile" -->')).toMatchObject({ ok: true, actual: 0 });
    expect(await one(root, '<!-- @assert-structure target="svc" dirs="./*/" required="Dockerfile" -->')).toMatchObject({ ok: true, actual: 0 });
  });

  it('wants a file for a name and a directory for a name ending in /', async () => {
    const root = await tree({ 'x/src/index.ts': '', 'x/docs': '' });
    expect(await one(root, '<!-- @assert-structure target="x" required="src/, docs" -->')).toMatchObject({ ok: true });
    expect(await one(root, '<!-- @assert-structure target="x" required="src, docs/" -->')).toMatchObject({
      ok: false,
      listed: ['x  missing src, docs/'],
    });
  });

  it('takes a path to an entry, and a glob in its last segment that any one entry satisfies', async () => {
    const root = await tree({ 'app/src/index.ts': '', 'app/App.csproj': '', 'lib/src/main.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="app, lib" required="src/index.ts" -->')).toMatchObject({
      ok: false,
      listed: ['lib  missing src/index.ts'],
    });
    expect(await one(root, '<!-- @assert-structure target="app, lib" required="*.csproj, src/*.ts" -->')).toMatchObject({
      ok: false,
      listed: ['lib  missing *.csproj'],
    });
    // A glob under a directory that is not there matches nothing at all.
    expect(await one(root, '<!-- @assert-structure target="app" required="docs/*, docs/*/" -->')).toMatchObject({
      ok: false,
      listed: ['app  missing docs/*, docs/*/'],
    });
  });

  it('compares names exactly, on every platform - which a lookup by path does not', async () => {
    const root = await tree({ 'pkg/Readme.md': '', 'pkg/Src/index.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="pkg" required="README.md, src/index.ts" -->')).toMatchObject({
      ok: false,
      listed: ['pkg  missing README.md, src/index.ts'],
    });
    // The control: the names as they are written on disk.
    expect(await one(root, '<!-- @assert-structure target="pkg" required="Readme.md, Src/index.ts" -->')).toMatchObject({ ok: true });
  });

  it('does not select a directory exclude removes, or one the run skips', async () => {
    const root = await tree({ 'packages/a/package.json': '', 'packages/shared/x.ts': '', 'packages/node_modules/dep/index.js': '' });
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" exclude="shared" required="package.json" -->')).toMatchObject({ ok: true });
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->', { defaultSkips: false })).toMatchObject({
      ok: false,
      listed: ['packages/node_modules  missing package.json', 'packages/shared  missing package.json'],
    });
  });

  it('fails when nothing is selected, unless an empty selection is allowed', async () => {
    const root = await tree({ 'packages/README.md': '', 'lib/x.ts': '' });
    const empty = {
      ok: false,
      actual: 0,
      message: 'no directories were selected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
      listed: [],
    };
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->')).toEqual(empty);
    expect(await one(root, '<!-- @assert-structure target="lib" exclude="lib" required="package.json" -->')).toEqual(empty);
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" allow-empty="true" -->')).toMatchObject({ ok: true });
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->', { allowEmptyScope: true })).toMatchObject({ ok: true });
  });

  it('fails on a target that is a file, which holds nothing, however the run treats missing targets', async () => {
    const root = await tree({ 'README.md': '', 'LICENSE': '', 'pkg/package.json': '' });
    expect(await one(root, '<!-- @assert-structure target="README.md, pkg" required="package.json" -->', { allowMissingTargets: true })).toEqual({
      ok: false,
      actual: 0,
      message: 'required="..." is about directories, and this target is a file: README.md',
      listed: [],
    });
    expect(await one(root, '<!-- @assert-structure target="README.md, LICENSE" dirs="*" required="x" -->')).toMatchObject({
      message: 'required="..." is about directories, and these targets are files: README.md, LICENSE',
    });
  });
});

describe('partner', () => {
  it('passes when every file has its partner beside it, and names the one it looked for when not', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/a.test.ts': '' });
    const directive = '<!-- @assert-structure target="src" exclude="*.test.ts" partner="[name].test.ts" -->';
    expect(await one(root, directive)).toEqual({ ok: true, actual: 0, message: 'expected no files without a partner, found 0', listed: [] });

    await fs.writeFile(path.join(root, 'src/b.ts'), '');
    expect(await one(root, directive)).toEqual({
      ok: false,
      actual: 1,
      message: 'expected no files without a partner, found 1',
      listed: ['src/b.ts  has no partner src/b.test.ts'],
    });
  });

  it('is satisfied by any one of several templates, and names them all when none exists', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/a.spec.ts': '', 'src/b.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" glob="a.ts, b.ts" partner="[name].test.[ext], [name].spec.[ext]" -->')).toMatchObject({
      ok: false,
      actual: 1,
      listed: ['src/b.ts  has no partner src/b.test.ts or src/b.spec.ts'],
    });
  });

  it('names the first file, in path order, that expects a partner which has none of its own', async () => {
    // a/x.js and a/x.ts both expect t/a/x.md, which exists and so is in scope.
    const root = await tree({ 'a/x.ts': '', 'a/x.js': '', 't/a/x.md': '' });
    expect(await one(root, '<!-- @assert-structure partner="t/[dir]/[name].md" -->')).toMatchObject({
      ok: false,
      actual: 1,
      listed: ['t/a/x.md  has no partner t/t/a/x.md (it is the partner of a/x.js - exclude it?)'],
    });
  });

  it('says when a file without a partner is itself a partner, because the exclude was forgotten', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/a.test.ts': '', 'src/lonely.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" partner="[name].test.ts" -->')).toMatchObject({
      ok: false,
      actual: 2,
      listed: [
        'src/a.test.ts  has no partner src/a.test.test.ts (it is the partner of src/a.ts - exclude it?)',
        'src/lonely.ts  has no partner src/lonely.test.ts',
      ],
    });
  });

  it('refuses a template that names the file itself, before any partner is looked up', async () => {
    const root = await tree({ 'src/Makefile': '', 'src/a.ts': '', 'src/b.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" partner="[name].[ext]" max="100" -->')).toEqual({
      ok: false,
      actual: 0,
      message: 'partner template [name].[ext] names src/a.ts itself, so every file would be its own partner',
      listed: [],
    });
    // Whichever of several templates it is.
    expect(await one(root, '<!-- @assert-structure target="src" partner="[name].md, [name].[ext]" glob="b.ts" -->')).toMatchObject({
      message: 'partner template [name].[ext] names src/b.ts itself, so every file would be its own partner',
    });
    // And only where it does: for a name with no extension, the same template names another file.
    expect(await one(root, '<!-- @assert-structure target="src" partner="[name].[ext]" glob="Makefile" -->')).toMatchObject({
      ok: false,
      actual: 1,
      listed: ['src/Makefile  has no partner src/Makefile.'],
    });
  });

  it('finds a partner in a mirrored tree, from the target the file was found in', async () => {
    const root = await tree({ 'app/users.py': '', 'app/api/v1/orders.py': '', 'tests/test_users.py': '', 'tests/api/v1/test_orders.py': '' });
    expect(await one(root, '<!-- @assert-structure target="app" partner="tests/[dir]/test_[name].py" -->')).toMatchObject({ ok: true, actual: 0 });
    // Two targets that overlap: the first one listed decides [dir].
    expect(await one(root, '<!-- @assert-structure target="app/api, app" partner="tests/[dir]/test_[name].py" -->')).toMatchObject({
      ok: false,
      listed: ['app/api/v1/orders.py  has no partner tests/v1/test_orders.py'],
    });
  });

  it('wants the partner to be a file with exactly that name, in directories with exactly those names', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '', 'src/A.test.ts': '', 'src/b.test.ts/x': '', 'Tests/c.test.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" glob="a.ts, b.ts" partner="[name].test.ts" -->')).toMatchObject({
      ok: false,
      listed: ['src/a.ts  has no partner src/a.test.ts', 'src/b.ts  has no partner src/b.test.ts'],
    });
    expect(await one(root, '<!-- @assert-structure target="src" glob="c.ts" partner="tests/[name].test.ts" -->')).toMatchObject({
      ok: false,
      listed: ['src/c.ts  has no partner tests/c.test.ts'],
    });
    expect(await one(root, '<!-- @assert-structure target="src" glob="c.ts" partner="Tests/[name].test.ts" -->')).toMatchObject({ ok: true });
    expect(await one(root, '<!-- @assert-structure target="src" glob="c.ts" partner="src/c.ts/[name].ts" -->')).toMatchObject({ ok: false, actual: 1 });
  });

  it('fails an empty scope, and a missing target, as every rule does', async () => {
    const root = await tree({ 'src/README.md': '' });
    expect(await one(root, '<!-- @assert-structure target="src" glob="*.ts" partner="[name].test.ts" -->')).toMatchObject({
      ok: false,
      message: 'no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
    });
    const report = await run(root, ['<!-- @assert-structure target="gone, src" partner="[name].x" -->']);
    expect(outcome(report.results[0])).toMatchObject({ ok: false, message: 'target path does not exist: gone' });
    expect(report.results[0]?.warnings).toEqual(['target path not found: gone']);
  });
});

/* ------------------------------------------------ what the rules share */

describe('what every structure rule shares with the others', () => {
  it('fails on missing targets unless told not to, and then an empty scope fails in their place', async () => {
    const root = await tree({ 'src/a.ts': '' });
    const both = '<!-- @assert-structure target="gone, lost" pattern="*.ts" -->';
    expect(await one(root, both)).toMatchObject({ ok: false, message: 'target paths do not exist: gone, lost' });
    expect(await one(root, both, { allowMissingTargets: true })).toMatchObject({
      ok: false,
      message: 'no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
    });
    expect(await one(root, both, { allowMissingTargets: true, allowEmptyScope: true })).toMatchObject({ ok: true });
    expect(await one(root, '<!-- @assert-structure target="gone, src" pattern="*.ts" -->', { allowMissingTargets: true })).toMatchObject({ ok: true, actual: 0 });
  });

  it('does not find a target by a name spelled differently from the one on disk', async () => {
    const root = await tree({ 'src/a.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="Src" pattern="*.ts" -->')).toMatchObject({ ok: false, message: 'target path does not exist: Src' });
  });

  it('warns about nothing when every target is there, and records the ones that are not on the assertion', async () => {
    const root = await tree({ 'src/a.ts': '' });
    const report = await run(root, ['<!-- @assert-structure target="src" pattern="*.ts" -->']);
    expect(report.results[0]?.warnings).toEqual([]);

    const assertion = assertionOf('<!-- @assert-structure target="src, gone, lost" pattern="*.ts" -->', root);
    await executeAssertion(assertion, { ...executeOptions(root), allowMissingTargets: true });
    expect(assertion.missingTargets).toEqual(['gone', 'lost']);
  });

  it('fails rather than breaks on a target below a directory that cannot be listed', async () => {
    const root = await tree({ 'packages/a/package.json': '' });
    const result = await executeAssertion(assertionOf('<!-- @assert-structure target="packages/a" required="package.json" -->', root), {
      ...executeOptions(root),
      tree: createTreeIndex(root, countingReader(root, ['packages']).reader),
    });
    expect(result).toMatchObject({ ok: false, message: 'target path does not exist: packages/a' });
  });

  it('lists violations in path order, whatever order the targets and the walk found them in', async () => {
    const root = await tree({ 'src/a/x.ts': '', 'src/a.ts': '', 'lib/b.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src, lib" pattern="*.x" -->')).toMatchObject({
      listed: ['lib/b.ts  matches none of *.x', 'src/a.ts  matches none of *.x', 'src/a/x.ts  matches none of *.x'],
    });
  });

  it('shows no more violations than --max-snippets allows, and counts them all', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" pattern="*.x" -->', { maxSnippets: 2 })).toMatchObject({
      actual: 3,
      listed: ['src/a.ts  matches none of *.x', 'src/b.ts  matches none of *.x'],
    });
  });

  it('counts against max, and fails when the count is over it', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/b.ts': '' });
    expect(await one(root, '<!-- @assert-structure target="src" pattern="*.x" max="2" -->')).toMatchObject({ ok: true, actual: 2, message: 'expected at most 2 misnamed files, found 2' });
    expect(await one(root, '<!-- @assert-structure target="src" pattern="*.x" expected="1" -->')).toMatchObject({ ok: false, actual: 2, message: 'expected at most 1 misnamed file, found 2' });
  });

  it('exempts what the baseline lists, fails a stale entry, and lets a one-way ratchet shrink', async () => {
    const root = await tree({ 'packages/a/x.ts': '', 'packages/b/package.json': '' });
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" baseline="packages/a" -->')).toMatchObject({
      ok: true,
      actual: 0,
      message: 'expected no directories missing an entry, found 0; 1 more is on the baseline',
      listed: [],
    });
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" baseline="packages/a, packages/b" -->')).toMatchObject({
      ok: false,
      message: 'expected no directories missing an entry, found 0; 1 more is on the baseline; the baseline is out of date and must be pruned: packages/b (no longer matches)',
    });
    expect(
      await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" baseline="packages/a, packages/b" ratchet="one-way" -->'),
    ).toMatchObject({ ok: true });
  });

  it('fails under --strict when a directory in scope could not be listed, and says so', async () => {
    const root = await tree({ 'src/a.entity.ts': '', 'src/locked/b.entity.ts': '' });
    const assertion = (): Assertion => assertionOf('<!-- @assert-structure target="src" pattern="*.entity.ts" -->', root);
    const execute = (strictTargets: boolean, tree: TreeIndex): Promise<AssertionResult> =>
      executeAssertion(assertion(), { ...executeOptions(root), strictTargets, tree });

    const lenient = await execute(false, createTreeIndex(root, countingReader(root, ['src/locked']).reader));
    expect(lenient).toMatchObject({ ok: true, message: 'expected no misnamed files, found 0', scope: { skipped: [{ path: 'src/locked', reason: 'unreadable' }] } });
    const strict = await execute(true, createTreeIndex(root, countingReader(root, ['src/locked']).reader));
    expect(strict).toMatchObject({ ok: false, message: 'expected no misnamed files, found 0; 1 file could not be inspected' });
    // The control: the same run, with every directory readable.
    expect(await execute(true, createTreeIndex(root))).toMatchObject({ ok: true, scope: { skipped: [] } });
  });

  it('lists every directory once across all the structure rules of a run', async () => {
    const root = await tree({ 'src/a.ts': '', 'src/a.test.ts': '', 'src/deep/b.ts': '', 'src/deep/b.test.ts': '' }, ['src/empty']);
    const { reader, reads } = countingReader(root);
    const options = { ...executeOptions(root), tree: createTreeIndex(root, reader) };
    const results = await Promise.all(
      [
        '<!-- @assert-structure target="src" glob="*.ts" exclude="*.test.ts" partner="[name].test.ts" -->',
        '<!-- @assert-structure target="src" pattern="*.ts" -->',
        '<!-- @assert-structure target="src" dirs="**" required="*.ts" -->',
        '<!-- @assert-structure target="src/deep" required="b.ts" -->',
      ].map((directive) => executeAssertion(assertionOf(directive, root), options)),
    );
    expect(results.map((result) => [result.ok, result.actual])).toEqual([[true, 0], [true, 0], [false, 1], [true, 0]]);
    expect(Object.fromEntries(reads)).toEqual({ '.': 1, src: 1, 'src/deep': 1, 'src/empty': 1 });
  });

  it('holds a subject once when two targets reach it', async () => {
    const root = await tree({ 'src/api/a.ts': '' });
    const check = await checkStructure(
      { claim: 'pattern', values: ['*.x'] },
      { targets: ['src', 'src/api', 'src/api/a.ts'], globs: [], excludeGlobs: [], scope: DEFAULT_SCOPE },
      createTreeIndex(root),
    );
    expect(check).toEqual({
      missing: [],
      notDirectories: [],
      inspected: 1,
      violations: [{ path: 'src/api/a.ts', text: 'matches none of *.x' }],
      scope: { skipped: [] },
    });
  });

  it('follows no symbolic link, as a file in scope or as an entry that satisfies a rule', async (context) => {
    const root = await tree({ 'real/package.json': '', 'packages/a/package.json': '', 'packages/a/src/x.ts': '' });
    try {
      await fs.symlink(path.join(root, 'real'), path.join(root, 'packages', 'linked'), 'junction');
      await fs.symlink(path.join(root, 'real'), path.join(root, 'packages', 'a', 'lib'), 'junction');
    } catch {
      context.skip();
    }
    expect(await one(root, '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->')).toMatchObject({ ok: true, actual: 0 });
    expect(await one(root, '<!-- @assert-structure target="packages/a" required="lib/package.json" -->')).toMatchObject({
      ok: false,
      listed: ['packages/a  missing lib/package.json'],
    });
    expect(await one(root, '<!-- @assert-structure target="packages/a/lib" pattern="*" -->')).toMatchObject({
      ok: false,
      message: 'target path does not exist: packages/a/lib',
    });
  });
});

/* ------------------------------------------------------------ resolution */

describe('resolving @assert-structure', () => {
  it('reads each claim into an assertion whose scope keeps the spec files in', () => {
    const assertion = assertionOf('<!-- @assert-structure target="src/domain" glob="*.ts" exclude="*.test.ts" pattern="*.entity.ts, index.ts" reason="entities are named" -->');
    expect(assertion).toEqual({
      kind: 'assert-structure',
      location: { ...LOCATION, line: 1, column: 1 },
      description: 'files in src/domain matching *.ts must be named *.entity.ts or index.ts (excluding *.test.ts)',
      reason: 'entities are named',
      targets: ['src/domain'],
      files: [],
      bounds: { max: 0 },
      search: {
        regex: false,
        word: false,
        ignoreCase: false,
        globs: ['*.ts'],
        excludeGlobs: ['*.test.ts'],
        ignoreComments: false,
        scope: DEFAULT_SCOPE,
        excludeFiles: new Set(),
      },
      structure: { claim: 'pattern', values: ['*.entity.ts', 'index.ts'] },
      missingTargets: [],
      allowEmpty: false,
      baseline: [],
      ratchet: 'two-sided',
    });
    expect(assertion.search?.excludeFiles.size).toBe(0);
    expect(assertion.structure).not.toHaveProperty('dirs');
  });

  it('describes each claim as a sentence', () => {
    const described = (directive: string): string => assertionOf(directive).description;
    expect(described('<!-- @assert-structure partner="[name].test.ts" -->')).toBe('files in . must each have a partner [name].test.ts');
    expect(described('<!-- @assert-structure target="src, lib" glob="*.ts, *.tsx" exclude="legacy, gen" partner="[name].test.ts, [name].spec.ts" max="2" -->')).toBe(
      'files in src, lib matching *.ts, *.tsx must each have a partner [name].test.ts or [name].spec.ts, with at most 2 files without a partner (excluding legacy, gen)',
    );
    expect(described('<!-- @assert-structure target="packages" required="package.json, README.md" expected="1" -->')).toBe(
      'packages must contain package.json, README.md, with at most 1 directory missing an entry',
    );
    expect(described('<!-- @assert-structure target="packages" dirs="*/" exclude="shared" required="package.json" -->')).toBe(
      'directories matching * under packages must contain package.json (excluding shared)',
    );
  });

  it('keeps dirs, normalised, only on a required claim', () => {
    expect(assertionOf('<!-- @assert-structure target="svc" dirs=" ./*/src/ " required="x" -->').structure).toEqual({ claim: 'required', values: ['x'], dirs: '*/src' });
    // Only a leading ./ and every trailing slash.
    expect(assertionOf('<!-- @assert-structure dirs="v1./" required="x" -->').structure?.dirs).toBe('v1.');
    expect(assertionOf('<!-- @assert-structure dirs="*//" required="x" -->').structure?.dirs).toBe('*');
    expect(assertionOf('<!-- @assert-structure required="x" -->').structure).toEqual({ claim: 'required', values: ['x'] });
  });

  it('takes a baseline, a ratchet and allow-empty like every rule that forbids something', () => {
    expect(assertionOf('<!-- @assert-structure pattern="*.ts" baseline="src/a.md, src/b.md:2" ratchet="one-way" allow-empty -->')).toMatchObject({
      baseline: [
        { path: 'src/a.md', declared: 1 },
        { path: 'src/b.md', declared: 2 },
      ],
      ratchet: 'one-way',
      allowEmpty: true,
    });
  });

  it('refuses a directive with no claim, or with more than one', () => {
    expect(errorOf('<!-- @assert-structure target="src" -->')).toBe('@assert-structure requires one of pattern="...", required="..." or partner="...".');
    expect(errorOf('<!-- @assert-structure pattern="*.ts" partner="[name].x" -->')).toBe('@assert-structure makes one claim per directive, got pattern and partner.');
    expect(errorOf('<!-- @assert-structure pattern="*.ts" required="x" partner="[name].x" -->')).toBe(
      '@assert-structure makes one claim per directive, got pattern and required and partner.',
    );
  });

  it('refuses a claim that lists nothing', () => {
    expect(errorOf('<!-- @assert-structure pattern="" -->')).toBe('@assert-structure requires a non-empty pattern="..." attribute.');
    expect(errorOf('<!-- @assert-structure required=" , " -->')).toBe('@assert-structure requires a non-empty required="..." attribute.');
  });

  it('refuses an attribute the claim would read and ignore', () => {
    expect(errorOf('<!-- @assert-structure dirs="*" pattern="*.ts" -->')).toBe('Attribute "dirs" chooses the directories of required="...", and this directive claims pattern="...".');
    expect(errorOf('<!-- @assert-structure dirs="*" partner="[name].x" -->')).toBe('Attribute "dirs" chooses the directories of required="...", and this directive claims partner="...".');
    expect(errorOf('<!-- @assert-structure glob="*.ts" required="x" -->')).toBe('Attribute "glob" chooses files, and required="..." is about directories; dirs="..." chooses those.');
    for (const dirs of ['', ' ', '/', './']) {
      expect(errorOf(`<!-- @assert-structure dirs="${dirs}" required="x" -->`), dirs).toBe('Attribute "dirs" must not be empty.');
    }
  });

  it('refuses the first entry or template that cannot be used, with its reason', () => {
    expect(errorOf('<!-- @assert-structure required="README.md, ../x, ./y" -->')).toBe(
      'Required entry "../x" must be a path inside the directory, with no empty, "." or ".." segment.',
    );
    expect(errorOf('<!-- @assert-structure partner="[name].x, [base].x" -->')).toBe(
      'Partner template "[base].x" uses [base]; the placeholders are [name], [ext] and [dir].',
    );
    // A pattern is a glob, so nothing in it is refused the way a partner's brackets are.
    expect(resolve('<!-- @assert-structure pattern="[0-9]*.md, ../x" -->')).toHaveProperty('assertion');
  });

  it('refuses both expected and max, as the other rules do', () => {
    expect(errorOf('<!-- @assert-structure pattern="*.ts" expected="1" max="1" -->')).toBe('@assert-structure accepts either expected="..." or max="...", not both.');
  });
});

/* --------------------------------------------------------------- reports */

describe('reporting a structure violation', () => {
  async function failing(): Promise<RunResult> {
    const root = await tree({ 'src/a.ts': '', 'packages/web/index.ts': '' });
    return run(root, [
      '<!-- @assert-structure target="src" pattern="*.entity.ts" -->',
      '<!-- @assert-structure target="packages" dirs="*" required="package.json, README.md" -->',
      '<!-- @assert-structure target="src" pattern="*.ts" -->',
    ]);
  }

  it('shows the path without a line, and a pass with its count of violations', async () => {
    const report = await failing();
    expect(report.results[0]?.matches).toEqual([{ file: 'src/a.ts', line: 0, column: 0, text: 'matches none of *.entity.ts', count: 1 }]);
    const text = formatReport(report, { color: false, verbose: true, ascii: true });
    expect(text).toContain('\n      src/a.ts  matches none of *.entity.ts\n');
    expect(text).toContain('\n      packages/web  missing package.json, README.md\n');
    expect(text).toContain('@assert-structure files in src must be named *.ts (0 violations)');
    expect(text).not.toContain(':0:0');
  });

  it('carries the claim in JSON, and nothing for a rule that has none', async () => {
    const report = await failing();
    const json = JSON.parse(formatJson(report)) as { results: Array<{ claim?: string }> };
    expect(json.results.map((result) => result.claim)).toEqual(['pattern', 'required', 'pattern']);
    const root = await tree({ 'src/a.ts': '' });
    const plain = JSON.parse(formatJson(await run(root, ['<!-- @assert-absence target="src" symbol="x" -->']))) as { results: object[] };
    expect(plain.results[0]).not.toHaveProperty('claim');
  });

  it('annotates a file at its top in SARIF, and puts a directory in the message at the directive', async () => {
    const report = await failing();
    const sarif = JSON.parse(formatSarif(report)) as {
      runs: Array<{ results: Array<{ message: { text: string }; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: object } }>; relatedLocations: unknown[] }> }>;
    };
    const [naming, required] = sarif.runs[0]?.results ?? [];
    expect(naming?.locations[0]?.physicalLocation).toEqual({ artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 1, startColumn: 1 } });
    expect(naming?.message.text).toBe('files in src must be named *.entity.ts: expected no misnamed files, found 1');
    expect(required?.locations[0]?.physicalLocation.artifactLocation.uri).toMatch(/rules\.md$/);
    expect(required?.locations[0]?.physicalLocation.region).toEqual({ startLine: 2, startColumn: 1 });
    expect(required?.relatedLocations).toEqual([]);
    expect(required?.message.text).toBe(
      'directories matching * under packages must contain package.json, README.md: expected no directories missing an entry, found 1\npackages/web  missing package.json, README.md',
    );
  });

  it('prints a baseline of the violating paths', async () => {
    const report = await failing();
    expect(formatBaselines(report)).toContain('baseline="src/a.ts"');
    expect(formatBaselines(report)).toContain('baseline="packages/web"');
  });
});
