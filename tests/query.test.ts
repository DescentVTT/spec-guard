/**
 * `spec-guard query`: reading the rules, resolving a path, and saying what
 * governs it.
 *
 * The human output is pinned in full, line by line. It is the answer an agent
 * or a person acts on, and a report that drops the reason, misnumbers a layer
 * or forgets to mention a draft is wrong in a way no structural assertion would
 * notice.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, HELP, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { nodeIo } from '../src/io.js';
import { overlayIo } from '../src/overlay.js';
import { parseDocument, parseTitle } from '../src/parser.js';
import {
  answerQuery,
  formatQuery,
  formatQueryJson,
  inQueriedPaths,
  loadRuleSet,
  queryRules,
  resolveQueryPath,
  QueryPathError,
  type QueryReport,
} from '../src/query.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

let root: string;

const ADR = [
  '---',
  'title: not this one',
  '---',
  '',
  '# ADR-0007: Layers and a legacy client ##',
  '',
  '## Status',
  '',
  'Accepted (0.7.0)',
  '',
  '<!-- @assert-layers target="src" order="src/domain, src/app, src/infra" baseline="src/domain/bad.ts" reason="dependencies point inward" -->',
  '<!-- @assert-absence target="src" symbol="LegacyClient" baseline="src/app/old.ts:2" -->',
  '<!-- @assert-layers target="src" order="src, src/app" allow-empty -->',
  '',
].join('\n');

const DRAFT = ['# ADR-0008: Clocks', '', '**Status:** Proposed by the platform team', '', '<!-- @assert-absence target="src/domain" symbol="Date.now" -->', ''].join('\n');
const UNTITLED = 'No heading.\n\n<!-- @assert-present file="src/domain/user.ts" reason="the aggregate root" -->\n<!-- @assert-count symbol="X" -->\n';

beforeAll(async () => {
  root = await makeTempRepo({
    'docs/adr/0007-layers.md': ADR,
    'docs/adr/0008-clocks.md': DRAFT,
    'docs/untitled.md': UNTITLED,
    'src/domain/user.ts': 'export const user = 1;\n',
    'src/app/old.ts': 'LegacyClient; LegacyClient;\n',
  });
});

afterAll(async () => {
  await removeTempRepo(root);
});

const rootPosix = (): string => root.replace(/\\/g, '/');

describe('parseTitle', () => {
  it('is the first level-one heading, without its closing hashes', () => {
    expect(parseTitle('# ADR-0001: A title\n# Another\n')).toBe('ADR-0001: A title');
    expect(parseTitle('   # Indented ###   \n')).toBe('Indented');
    expect(parseTitle('# C# is a language\n')).toBe('C# is a language');
    expect(parseTitle('#\tTabbed\n')).toBe('Tabbed');
  });

  it('takes any run of spaces after the hash and before a closing sequence, and keeps none of them', () => {
    expect(parseTitle('#   Three  spaces in\n')).toBe('Three  spaces in');
    expect(parseTitle('# Spaced close \t ###\n')).toBe('Spaced close');
  });

  it('is not a deeper heading, a heading without a space, one indented four spaces, or an empty one', () => {
    expect(parseTitle('## Section\n#NoSpace\n    # Code\n#\n# \nprose\n')).toBeUndefined();
    expect(parseTitle('## Section\n# Real\n')).toBe('Real');
  });

  it('is not inside a fence or in front-matter', () => {
    expect(parseTitle('```md\n# Example\n```\n# Actual\n')).toBe('Actual');
    expect(parseTitle('---\n# not: a heading\n---\n# Actual\n')).toBe('Actual');
    expect(parseTitle('---\ntitle: x\n---\nno heading\n')).toBeUndefined();
  });

  it('reads CRLF documents the same', () => {
    expect(parseTitle('# Windows\r\n\r\ntext\r\n')).toBe('Windows');
  });

  it('comes with the directives from parseDocument, which masks once', () => {
    const context = { file: '/x/a.md', relativeFile: 'a.md' };
    expect(parseDocument('# T\n\n**Status:** draft\n\n<!-- @assert-absence symbol="X" -->\n', context)).toMatchObject({
      title: 'T',
      status: { value: 'draft', active: false },
      directives: [{ kind: 'assert-absence' }],
      errors: [],
    });
    expect(parseDocument('<!-- @assert-absence symbol="X" -->\n', context)).not.toHaveProperty('title');
  });
});

describe('resolveQueryPath', () => {
  it('takes a relative path, POSIX or Windows, and says whether it exists', async () => {
    expect(await resolveQueryPath('src/domain/user.ts', root)).toEqual({
      path: 'src/domain/user.ts',
      shape: 'file',
      exists: true,
      absolutePath: path.join(root, 'src/domain/user.ts'),
    });
    // Backslashes become separators on every platform, as they do in a spec's
    // own targets - a path an agent sends from Windows means the same file here.
    expect(await resolveQueryPath('src\\domain\\user.ts', root)).toMatchObject({ path: 'src/domain/user.ts', exists: true, absolutePath: path.join(root, 'src/domain/user.ts') });
    expect(await resolveQueryPath('./src/app/../domain/new.ts', root)).toMatchObject({ path: 'src/domain/new.ts', shape: 'file', exists: false });
  });

  it('reads an existing directory as a directory, and a missing one only when written with a slash', async () => {
    expect(await resolveQueryPath('src/domain', root)).toMatchObject({ path: 'src/domain', shape: 'directory', exists: true });
    expect(await resolveQueryPath('src/ports', root)).toMatchObject({ path: 'src/ports', shape: 'file', exists: false });
    expect(await resolveQueryPath('src/ports/', root)).toMatchObject({ path: 'src/ports', shape: 'directory', exists: false });
    expect(await resolveQueryPath('.', root)).toMatchObject({ path: '.', shape: 'directory', exists: true });
    expect(await resolveQueryPath(root, root)).toMatchObject({ path: '.', shape: 'directory' });
  });

  it('takes an absolute path inside the root', async () => {
    expect(await resolveQueryPath(path.join(root, 'src', 'app', 'old.ts'), root)).toMatchObject({ path: 'src/app/old.ts', exists: true });
  });

  it('refuses a path outside the root, or none at all', async () => {
    await expect(resolveQueryPath('../x.ts', root)).rejects.toThrow(new QueryPathError(`"../x.ts" is outside the root ${rootPosix()}.`));
    await expect(resolveQueryPath('..', root)).rejects.toThrow(QueryPathError);
    await expect(resolveQueryPath(path.dirname(root), root)).rejects.toThrow(/is outside the root/);
    await expect(resolveQueryPath('   ', root)).rejects.toThrow(new QueryPathError('A path to query must not be empty.'));
    // A name that merely starts with two dots is inside.
    expect(await resolveQueryPath('..hidden', root)).toMatchObject({ path: '..hidden' });
  });
});

describe('loadRuleSet and answerQuery', () => {
  it('resolves every rule with its document, and every error in file order', async () => {
    const ruleSet = await loadRuleSet({ patterns: ['docs/**/*.md'], root });
    expect(ruleSet.specFiles).toEqual(['docs/adr/0007-layers.md', 'docs/adr/0008-clocks.md', 'docs/untitled.md']);
    expect(ruleSet.rules.map(({ assertion, document }) => [document.file, assertion.location.line, document.inForce])).toEqual([
      ['docs/adr/0007-layers.md', 11, true],
      ['docs/adr/0007-layers.md', 12, true],
      ['docs/adr/0007-layers.md', 13, true],
      ['docs/adr/0008-clocks.md', 5, false],
      ['docs/untitled.md', 3, true],
    ]);
    expect(ruleSet.errors.map((error) => [error.location.relativeFile, error.location.line, error.message])).toEqual([
      ['docs/untitled.md', 4, '@assert-count requires expected="...", min="..." or max="...".'],
    ]);
  });

  it('finds and reads the specs through the door it is given, as a run does', async () => {
    // The tree on disk holds no spec and no src/new.ts. The door adds both,
    // and a query that read the disk would find no spec files at all.
    const empty = await makeTempRepo({ 'README.txt': 'nothing here\n' });
    try {
      const door = overlayIo(nodeIo, empty, {
        write: new Map([
          ['docs/adr/0001-x.md', '# ADR-0001: X\n\n<!-- @assert-absence target="src" symbol="Legacy" -->\n'],
          ['src/new.ts', 'export {};\n'],
        ]),
        remove: new Set(),
      });
      const ruleSet = await loadRuleSet({ patterns: ['docs/**/*.md'], root: empty, io: door });
      expect(ruleSet.specFiles).toEqual(['docs/adr/0001-x.md']);
      expect(ruleSet.rules.map(({ document }) => document.title)).toEqual(['ADR-0001: X']);

      const report = await queryRules({ patterns: ['docs/**/*.md'], root: empty, paths: ['src/new.ts', 'src/'], io: door });
      expect(report.results.map((result) => [result.path, result.shape, result.exists, result.rules.length])).toEqual([
        ['src/new.ts', 'file', true, 1],
        ['src', 'directory', true, 1],
      ]);
      // And without the door, the same question finds the disk as it is.
      const plain = await queryRules({ patterns: ['docs/**/*.md'], root: empty, paths: ['src/new.ts'] });
      expect(plain.specFiles).toEqual([]);
      expect(plain.results[0]?.exists).toBe(false);
    } finally {
      await removeTempRepo(empty);
    }
  });

  it('sorts errors by file and then by line, however they arrived', async () => {
    const broken = await makeTempRepo({
      'docs/b.md': '<!-- @assert-count symbol="X" -->\n<!-- @assert-bogus -->\n<!-- @assert-count symbol="Y" -->\n',
      'docs/a.md': '\n\n<!-- @assert-count symbol="Z" -->\n',
    });
    try {
      const ruleSet = await loadRuleSet({ patterns: ['docs/*.md'], root: broken });
      expect(ruleSet.errors.map((error) => `${error.location.relativeFile}:${error.location.line}`)).toEqual(['docs/a.md:3', 'docs/b.md:1', 'docs/b.md:2', 'docs/b.md:3']);
    } finally {
      await removeTempRepo(broken);
    }
  });

  it('applies --include-specs and --no-default-skips the way a run does', async () => {
    const tree = await makeTempRepo({ 'docs/a.md': '<!-- @assert-absence symbol="X" -->\n' });
    try {
      const query = [{ path: 'docs/a.md', shape: 'file' as const, absolutePath: path.join(tree, 'docs/a.md'), exists: true }];
      const skipped = [{ path: 'node_modules/p.js', shape: 'file' as const, absolutePath: path.join(tree, 'node_modules/p.js'), exists: false }];
      const count = async (options: object, paths: typeof query): Promise<number> =>
        answerQuery(await loadRuleSet({ patterns: ['docs/*.md'], root: tree, ...options }), paths, false).results[0]?.rules.length as number;

      expect(await count({}, query)).toBe(0);
      expect(await count({ includeSpecs: true }, query)).toBe(1);
      expect(await count({}, skipped)).toBe(0);
      expect(await count({ defaultSkips: false }, skipped)).toBe(1);
    } finally {
      await removeTempRepo(tree);
    }
  });

  it('cites the documents behind the rules and the withheld counts, and nothing else', async () => {
    const report = await queryRules({ patterns: ['docs/**/*.md'], root, paths: ['src/app/old.ts', 'src/domain/user.ts'] });
    expect(report.documents.map((document) => document.file)).toEqual(['docs/adr/0007-layers.md', 'docs/adr/0008-clocks.md', 'docs/untitled.md']);
    expect(report.results.map((result) => [result.path, result.rules.length, result.withheld])).toEqual([
      ['src/app/old.ts', 3, { rules: 0, documents: [] }],
      ['src/domain/user.ts', 4, { rules: 1, documents: ['docs/adr/0008-clocks.md'] }],
    ]);

    const infra = await queryRules({ patterns: ['docs/**/*.md'], root, paths: ['src/infra/db.ts'] });
    expect(infra.documents.map((document) => document.file)).toEqual(['docs/adr/0007-layers.md']);
  });

  it('lists withheld rules when asked, still counting them', async () => {
    const report = await queryRules({ patterns: ['docs/**/*.md'], root, paths: ['src/domain/user.ts'], includeInactive: true });
    expect(report.results[0]?.rules.map((rule) => [rule.document, rule.inForce])).toEqual([
      ['docs/adr/0007-layers.md', true],
      ['docs/adr/0007-layers.md', true],
      ['docs/adr/0007-layers.md', true],
      ['docs/adr/0008-clocks.md', false],
      ['docs/untitled.md', true],
    ]);
    expect(report.results[0]?.withheld).toEqual({ rules: 1, documents: ['docs/adr/0008-clocks.md'] });
  });

  it('lists cited documents in path order, whichever path cited them first', async () => {
    const tree = await makeTempRepo({
      'docs/a.md': '<!-- @assert-absence target="lib" symbol="X" -->\n',
      'docs/b.md': '<!-- @assert-absence target="src" symbol="X" -->\n',
    });
    try {
      const report = await queryRules({ patterns: ['docs/*.md'], root: tree, paths: ['src/x.ts', 'lib/y.ts'] });
      expect(report.results.map((result) => result.rules.map((rule) => rule.document))).toEqual([['docs/b.md'], ['docs/a.md']]);
      expect(report.documents.map((document) => document.file)).toEqual(['docs/a.md', 'docs/b.md']);
    } finally {
      await removeTempRepo(tree);
    }
  });

  it('counts the same withheld document once, however many of its rules apply', async () => {
    const tree = await makeTempRepo({ 'docs/a.md': '**Status:** draft\n\n<!-- @assert-absence symbol="X" -->\n<!-- @assert-absence symbol="Y" -->\n' });
    try {
      const report = await queryRules({ patterns: ['docs/*.md'], root: tree, paths: ['src/a.ts'] });
      expect(report.results[0]?.withheld).toEqual({ rules: 2, documents: ['docs/a.md'] });
    } finally {
      await removeTempRepo(tree);
    }
  });

  it('knows which locations lie in the queried paths', () => {
    const paths = [
      { path: 'src/app', shape: 'directory' as const, absolutePath: '' },
      { path: 'README.md', shape: 'file' as const, absolutePath: '' },
    ];
    expect(inQueriedPaths('src/app/x.ts', paths)).toBe(true);
    expect(inQueriedPaths('README.md', paths)).toBe(true);
    expect(inQueriedPaths('src/apple.ts', paths)).toBe(false);
    expect(inQueriedPaths('src/app/x.ts', [])).toBe(false);
  });
});

describe('formatQuery', () => {
  it('groups the rules by document, with layer, baseline and reason under each', async () => {
    const report = await queryRules({ patterns: ['docs/**/*.md'], root, paths: ['src/domain/user.ts'] });
    expect(formatQuery({ ...report, durationMs: 1.25 })).toBe(
      [
        'src/domain/user.ts',
        '  4 rules from 2 documents',
        '',
        '  ADR-0007: Layers and a legacy client  (docs/adr/0007-layers.md, accepted)',
        '    :11 @assert-layers  src must keep its layers in order, src/domain < src/app < src/infra',
        '      layer: src/domain (1 of 3)',
        '      may import: src/domain',
        '      must not import: src/app, src/infra',
        '      reason: dependencies point inward',
        '    :12 @assert-absence  "LegacyClient" must not appear in src',
        '    :13 @assert-layers  src must keep its layers in order, src < src/app',
        '      layer: src (1 of 2)',
        '      may import: src',
        '      must not import: src/app',
        '',
        '  docs/untitled.md  (docs/untitled.md)',
        '    :3 @assert-present  src/domain/user.ts must exist',
        '      reason: the aggregate root',
        '',
        '  1 more rule would govern this path if docs/adr/0008-clocks.md (proposed) were in force; --ignore-status lists it',
        '',
        '1 directive could not be read, so its rule governs nothing:',
        '  docs/untitled.md:4 @assert-count requires expected="...", min="..." or max="...".',
        '',
        '3 spec files read in 1.3ms',
      ].join('\n'),
    );
  });

  it('shows an ambiguous layer, a path in no layer, a baseline, and a directory not yet created', async () => {
    const report = await queryRules({ patterns: ['docs/adr/0007-layers.md'], root, paths: ['src/app/old.ts', 'lib/', 'src/infra', 'src/infra/'] });
    expect(formatQuery({ ...report, durationMs: 0.04 })).toBe(
      [
        'src/app/old.ts',
        '  3 rules from 1 document',
        '',
        '  ADR-0007: Layers and a legacy client  (docs/adr/0007-layers.md, accepted)',
        '    :11 @assert-layers  src must keep its layers in order, src/domain < src/app < src/infra',
        '      layer: src/app (2 of 3)',
        '      may import: src/domain, src/app',
        '      must not import: src/infra',
        '      reason: dependencies point inward',
        '    :12 @assert-absence  "LegacyClient" must not appear in src',
        '      baseline: src/app/old.ts (2)',
        '    :13 @assert-layers  src must keep its layers in order, src < src/app',
        '      layer: ambiguous - "src" and "src/app" all match, and the rule fails until one does',
        '',
        'lib (directory, does not exist yet)',
        '  no rules in force govern this path',
        '',
        'src/infra (does not exist yet)',
        '  1 rule from 1 document',
        '',
        '  ADR-0007: Layers and a legacy client  (docs/adr/0007-layers.md, accepted)',
        '    :12 @assert-absence  "LegacyClient" must not appear in src',
        '',
        'src/infra (directory, does not exist yet)',
        '  3 rules from 1 document',
        '',
        '  ADR-0007: Layers and a legacy client  (docs/adr/0007-layers.md, accepted)',
        '    :11 @assert-layers  src must keep its layers in order, src/domain < src/app < src/infra',
        '      layer: src/infra (3 of 3)',
        '      may import: src/domain, src/app, src/infra',
        '      reason: dependencies point inward',
        '    :12 @assert-absence  "LegacyClient" must not appear in src',
        '    :13 @assert-layers  src must keep its layers in order, src < src/app',
        '      layer: src (1 of 2)',
        '      may import: src',
        '      must not import: src/app',
        '',
        '1 spec file read in 0.0ms',
      ].join('\n'),
    );
  });

  it('shows what a structure rule asks of a file about to be created: its name and its partner', async () => {
    const tree = await makeTempRepo({
      'docs/structure.md': [
        '# Layout',
        '',
        '<!-- @assert-structure target="src/domain" exclude="*.test.ts" pattern="*.entity.ts, *.value.ts" -->',
        '<!-- @assert-structure target="src" exclude="*.test.ts" partner="[name].test.[ext], tests/[dir]/[name].test.[ext]" reason="every module is tested" -->',
        '<!-- @assert-structure target="src" dirs="*" required="index.ts" -->',
        '',
      ].join('\n'),
    });
    try {
      const report = await queryRules({ patterns: ['docs/structure.md'], root: tree, paths: ['src/domain/user.ts', 'src/domain/order.entity.ts', 'src/domain/'] });
      expect(formatQuery({ ...report, durationMs: 0.5 })).toBe(
        [
          'src/domain/user.ts (does not exist yet)',
          '  3 rules from 1 document',
          '',
          '  Layout  (docs/structure.md)',
          '    :3 @assert-structure  files in src/domain must be named *.entity.ts or *.value.ts (excluding *.test.ts)',
          '      name: not allowed - it matches none of *.entity.ts, *.value.ts',
          '    :4 @assert-structure  files in src must each have a partner [name].test.[ext] or tests/[dir]/[name].test.[ext] (excluding *.test.ts)',
          '      partner: src/domain/user.test.ts or tests/domain/user.test.ts',
          '      reason: every module is tested',
          '    :5 @assert-structure  directories matching * under src must contain index.ts',
          '',
          'src/domain/order.entity.ts (does not exist yet)',
          '  3 rules from 1 document',
          '',
          '  Layout  (docs/structure.md)',
          '    :3 @assert-structure  files in src/domain must be named *.entity.ts or *.value.ts (excluding *.test.ts)',
          '      name: allowed',
          '    :4 @assert-structure  files in src must each have a partner [name].test.[ext] or tests/[dir]/[name].test.[ext] (excluding *.test.ts)',
          '      partner: src/domain/order.entity.test.ts or tests/domain/order.entity.test.ts',
          '      reason: every module is tested',
          '    :5 @assert-structure  directories matching * under src must contain index.ts',
          '',
          'src/domain (directory, does not exist yet)',
          '  3 rules from 1 document',
          '',
          '  Layout  (docs/structure.md)',
          '    :3 @assert-structure  files in src/domain must be named *.entity.ts or *.value.ts (excluding *.test.ts)',
          '    :4 @assert-structure  files in src must each have a partner [name].test.[ext] or tests/[dir]/[name].test.[ext] (excluding *.test.ts)',
          '      reason: every module is tested',
          '    :5 @assert-structure  directories matching * under src must contain index.ts',
          '',
          '1 spec file read in 0.5ms',
        ].join('\n'),
      );
    } finally {
      await removeTempRepo(tree);
    }
  });

  it('says a listed rule is not in force, and does not count it again as withheld', async () => {
    const report = await queryRules({ patterns: ['docs/adr/0008-clocks.md'], root, paths: ['src/domain/user.ts'], includeInactive: true });
    expect(formatQuery({ ...report, durationMs: 2 })).toBe(
      [
        'src/domain/user.ts',
        '  1 rule from 1 document',
        '',
        '  ADR-0008: Clocks  (docs/adr/0008-clocks.md, proposed - not in force)',
        '    :5 @assert-absence  "Date.now" must not appear in src/domain',
        '',
        '1 spec file read in 2.0ms',
      ].join('\n'),
    );
  });

  it('names a path in no layer, several withheld rules, and several errors, in the plural', () => {
    const report: QueryReport = {
      root: '/r',
      specFiles: ['a.md', 'b.md'],
      exclude: [],
      documents: [
        { file: 'b.md', title: null, status: 'draft', label: 'Draft', inForce: false },
        { file: 'c.md', title: null, status: 'superseded', label: 'Superseded', inForce: false },
      ],
      results: [
        {
          path: 'src/x.ts',
          shape: 'file',
          exists: true,
          rules: [
            {
              document: 'a.md',
              line: 1,
              kind: 'assert-layers',
              description: 'd',
              reason: null,
              inForce: true,
              bounds: { max: 0 },
              order: ['p', 'q'],
              position: { layer: null, position: null, matches: [], mayImport: [], mustNotImport: [] },
              baseline: [
                { path: 'src/x.ts', declared: 2 },
                { path: 'src/x.ts/y', declared: 1 },
              ],
            },
          ],
          withheld: { rules: 2, documents: ['b.md', 'c.md'] },
          excluded: { project: [], rules: [] },
        },
      ],
      errors: [
        { file: 'a.md', line: 3, message: 'one' },
        { file: 'b.md', line: 4, message: 'two' },
      ],
      durationMs: 5,
    };
    report.documents.unshift({ file: 'a.md', title: 'A', status: null, label: null, inForce: true });
    expect(formatQuery(report)).toBe(
      [
        'src/x.ts',
        '  1 rule from 1 document',
        '',
        '  A  (a.md)',
        '    :1 @assert-layers  d',
        '      layer: none - no layer matches this path',
        '      baseline: src/x.ts (2), src/x.ts/y (1)',
        '',
        '  2 more rules would govern this path if b.md (draft), c.md (superseded) were in force; --ignore-status lists them',
        '',
        '2 directives could not be read, so their rules govern nothing:',
        '  a.md:3 one',
        '  b.md:4 two',
        '',
        '2 spec files read in 5.0ms',
      ].join('\n'),
    );
  });

  it('writes JSON with the duration rounded to microseconds', async () => {
    const report = await queryRules({ patterns: ['docs/untitled.md'], root, paths: ['src/domain/user.ts'] });
    const json = JSON.parse(formatQueryJson({ ...report, durationMs: 1.23456789 })) as Record<string, unknown>;
    expect(json).toEqual({ formatVersion: 1, ...report, durationMs: 1.235 });
    // First, where a reader looks before deciding how to read the rest.
    expect(Object.keys(json)[0]).toBe('formatVersion');
    expect(formatQueryJson(report)).toContain('\n  "root": ');
  });
});

/* ----------------------------------------------------------------------- CLI */

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd: root, isTTY: false };
  return { cli, out, err };
}

describe('parseArgs for the commands', () => {
  it('reads a run by default, with --spec adding to the positional patterns', () => {
    expect(parseArgs(['docs/a.md', '--spec', 'README.md'], root)).toMatchObject({ command: 'check', patterns: ['docs/a.md', 'README.md'], paths: [] });
    expect(parseArgs(['--spec=README.md'], root).patterns).toEqual(['README.md']);
    expect(parseArgs([], root).patterns).toEqual(['docs/**/*.md']);
  });

  it('reads query paths as paths and specs only from --spec', () => {
    expect(parseArgs(['query', 'src/a.ts', 'src/b', '--spec', 'adr/*.md', '--json'], root)).toMatchObject({
      command: 'query',
      paths: ['src/a.ts', 'src/b'],
      patterns: ['adr/*.md'],
      format: 'json',
    });
    expect(parseArgs(['query', 'src/a.ts'], root)).toMatchObject({ patterns: ['docs/**/*.md'], format: 'human' });
    expect(parseArgs(['query', '--', '--odd-name.ts'], root).paths).toEqual(['--odd-name.ts']);
    expect(parseArgs(['query', 'a', '--format', 'JSON', '--root', 'x', '--ignore-status', '--include-specs', '--no-default-skips'], root)).toMatchObject({
      format: 'json',
      root: path.resolve(root, 'x'),
      ignoreStatus: true,
      includeSpecs: true,
      defaultSkips: false,
    });
  });

  it('reads the word query or mcp as a command only in first place', () => {
    expect(parseArgs(['docs/a.md', 'query'], root)).toMatchObject({ command: 'check', patterns: ['docs/a.md', 'query'] });
    expect(parseArgs(['--', 'mcp'], root)).toMatchObject({ command: 'check', patterns: ['mcp'] });
  });

  it('needs a path to query, unless help or the version was asked for', () => {
    expect(() => parseArgs(['query'], root)).toThrow(new UsageError('spec-guard query needs a path to ask about, e.g. spec-guard query src/domain/user.ts.'));
    expect(() => parseArgs(['query', '--json'], root)).toThrow(UsageError);
    expect(parseArgs(['query', '--help'], root).help).toBe(true);
    expect(parseArgs(['query', '--version'], root).version).toBe(true);
  });

  it('refuses the options that mean nothing to a query', () => {
    for (const option of ['--verbose', '-v', '--fail-fast', '--engine=js', '--strict', '--allow-missing-targets', '--allow-empty-scope', '--print-baseline', '--allow-empty', '--max-snippets=1', '--concurrency=1', '--color']) {
      const name = option.split('=')[0] as string;
      expect(() => parseArgs(['query', 'src', option], root), option).toThrow(new UsageError(`Option ${name} does not apply to spec-guard query.`));
    }
    expect(() => parseArgs(['query', 'src', '--format', 'sarif'], root)).toThrow(
      new UsageError('spec-guard query has no sarif format: it lists rules, not results. Expected human or json.'),
    );
    expect(() => parseArgs(['query', 'src', '--format', 'xml'], root)).toThrow(new UsageError('Unknown format "xml". Expected human or json.'));
  });

  // A script that passes --no-color to every command it runs was refused here.
  it('takes --no-color, which a query is already, and answers exactly as without it', async () => {
    expect(parseArgs(['query', 'src', '--no-color'], root)).toMatchObject({ command: 'query', color: false, paths: ['src'] });

    const plain = io();
    const told = io();
    expect(await main(['query', 'src/domain/user.ts', '--spec', 'docs/adr/*.md'], plain.cli)).toBe(EXIT_OK);
    expect(await main(['query', 'src/domain/user.ts', '--spec', 'docs/adr/*.md', '--no-color'], told.cli)).toBe(EXIT_OK);
    const timeless = (lines: string[]) => lines.join('\n').replace(/read in [\d.]+ms/, '');
    expect(timeless(told.out)).toBe(timeless(plain.out));
    expect(timeless(told.out)).toContain('@assert-layers');
  });

  it('refuses the options that mean nothing to a server, and any argument', () => {
    for (const option of ['--verbose', '-v', '--fail-fast', '--json', '--format=json', '--print-baseline', '--allow-empty', '--color', '--no-color']) {
      const name = option.split('=')[0] as string;
      expect(() => parseArgs(['mcp', option], root), option).toThrow(new UsageError(`Option ${name} does not apply to spec-guard mcp.`));
    }
    expect(() => parseArgs(['mcp', 'docs/*.md'], root)).toThrow(new UsageError('spec-guard mcp takes no arguments, got "docs/*.md". Name specs with --spec.'));
    expect(parseArgs(['mcp', '--engine', 'js', '--strict', '--allow-missing-targets', '--allow-empty-scope', '--max-snippets', '2', '--concurrency', '3', '--spec', 'a.md'], root)).toMatchObject({
      command: 'mcp',
      engine: 'javascript',
      strictTargets: true,
      allowMissingTargets: true,
      allowEmptyScope: true,
      maxSnippets: 2,
      concurrency: 3,
      patterns: ['a.md'],
    });
  });

  it('still refuses an unknown option under a command', () => {
    expect(() => parseArgs(['query', 'src', '--nonsense'], root)).toThrow(new UsageError('Unknown option "--nonsense". Run spec-guard --help.'));
  });
});

describe('spec-guard query', () => {
  it('prints the rules and exits 0', async () => {
    const { cli, out, err } = io();
    expect(await main(['query', 'src/app/old.ts', '--spec', 'docs/adr/*.md'], cli)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^src\/app\/old\.ts\n {2}3 rules from 1 document\n/);
    expect(out[0]).toMatch(/\n2 spec files read in \d+\.\dms$/);
  });

  it('prints JSON with --json, and lists withheld rules with --ignore-status', async () => {
    const { cli, out } = io();
    expect(await main(['query', 'src/domain/user.ts', '--spec', 'docs/adr/*.md', '--json', '--ignore-status'], cli)).toBe(EXIT_OK);
    const json = JSON.parse(out[0] as string) as QueryReport;
    expect(json.results[0]?.rules.map((rule) => rule.inForce)).toEqual([true, true, true, false]);
  });

  it('exits 2 for a path outside the root', async () => {
    const { cli, out, err } = io();
    expect(await main(['query', '../elsewhere.ts'], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual([`spec-guard: "../elsewhere.ts" is outside the root ${rootPosix()}.`]);
  });

  it('exits 2 when no spec matched, printing the empty JSON report under --json', async () => {
    const human = io();
    expect(await main(['query', 'src', '--spec', 'nowhere/*.md', '--spec', 'x.md'], human.cli)).toBe(EXIT_ERROR);
    expect(human.out).toEqual([]);
    expect(human.err).toEqual(['spec-guard: no spec files matched "nowhere/*.md", "x.md"']);

    const json = io();
    expect(await main(['query', 'src', '--spec', 'nowhere/*.md', '--json'], json.cli)).toBe(EXIT_ERROR);
    expect(json.err).toEqual([]);
    expect(JSON.parse(json.out[0] as string)).toMatchObject({ specFiles: [], results: [{ path: 'src', rules: [] }] });
  });

  it('prints help for a usage error, like every other command', async () => {
    const { cli, err } = io();
    expect(await main(['query'], cli)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard query needs a path to ask about, e.g. spec-guard query src/domain/user.ts.', '', HELP]);
  });

  it('documents both commands in the help', () => {
    expect(HELP).toContain('spec-guard query <paths...> [options]  list the rules in force for files or directories');
    expect(HELP).toContain('spec-guard mcp [options]               serve the rules to an AI agent over MCP on stdio');
    expect(HELP).toContain('--spec <pattern>    A spec glob or path; repeatable (default: "docs/**/*.md")');
  });
});
