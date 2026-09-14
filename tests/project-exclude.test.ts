/**
 * A project's exclusions: `exclude` in package.json or .spec-guard.json, or
 * `--exclude`. ADR-0014.
 *
 * Found on a polyglot monorepo, where build output (target, bin, obj, dist)
 * took a whole-repository scan from 3,000 files to 37,000 and every rule had to
 * repeat the same exclude="..." to get them back. The claims: every rule that
 * takes `exclude` leaves the project's paths out, under both engines, in a
 * query as in a run; `@assert-present`, which names its files, does not; and a
 * rule's description still names only its own exclusions, since the project's
 * are named once, in the line that says which options came from the file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, HELP, main, type CliIO } from '../src/cli.js';
import { resetRipgrepProbe } from '../src/engine.js';
import { formatQuery, queryRules } from '../src/query.js';
import { resolveDirective, runSpecGuard } from '../src/runner.js';
import type { Directive } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;
/** Both engines must leave the same paths out; ripgrep where it is installed. */
const ENGINES = rgPath ? (['javascript', 'ripgrep'] as const) : (['javascript'] as const);

beforeAll(() => {
  if (rgPath) process.env.SPEC_GUARD_RG = rgPath;
  resetRipgrepProbe();
});

afterAll(() => {
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

async function only(root: string, options: { exclude?: string[]; engine?: 'javascript' | 'ripgrep' } = {}) {
  const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript', ...options });
  expect(report.errors).toEqual([]);
  expect(report.results).toHaveLength(1);
  return report.results[0] as (typeof report.results)[number];
}

describe.each(ENGINES)('a text rule under the project exclusions [%s engine]', (engine) => {
  it('leaves the excluded paths out, and counts what is left', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence symbol="LegacyClient" -->\n',
      'src/a.ts': 'export const a = 1;\n',
      'target/debug/gen.ts': 'LegacyClient;\n',
      'bin/Release/gen.ts': 'LegacyClient;\n',
    });

    expect((await only(root, { engine })).actual).toBe(2);
    const excluded = await only(root, { engine, exclude: ['target', 'bin'] });
    expect(excluded.ok).toBe(true);
    expect(excluded.actual).toBe(0);
    expect((await only(root, { engine, exclude: ['target'] })).matches.map((match) => match.file)).toEqual(['bin/Release/gen.ts']);
  });

  it("adds to a rule's own exclude rather than replacing it", async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence symbol="LegacyClient" exclude="vendor" -->\n',
      'vendor/lib.ts': 'LegacyClient;\n',
      'dist/bundle.ts': 'LegacyClient;\n',
      'src/a.ts': 'LegacyClient;\n',
    });

    const result = await only(root, { engine, exclude: ['dist'] });
    expect(result.matches.map((match) => match.file)).toEqual(['src/a.ts']);
    expect(result.description).toBe('"LegacyClient" must not appear in . (excluding vendor)');
  });
});

describe('the other rules under the project exclusions', () => {
  it('leaves an excluded importer out of an import rule', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence module="src/db" -->\n',
      'src/db/client.ts': 'export const client = 1;\n',
      'src/app.ts': 'export const app = 1;\n',
      'obj/generated.ts': "import { client } from '../src/db/client.js';\n",
    });

    expect((await only(root)).ok).toBe(false);
    expect((await only(root, { exclude: ['obj'] })).ok).toBe(true);
  });

  it('breaks a cycle through an excluded file', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-cycle -->\n',
      'src/a.ts': "import { b } from '../dist/b.js';\nexport const a = 1;\n",
      'dist/b.ts': "import { a } from '../src/a.js';\nexport const b = 2;\n",
    });

    expect((await only(root)).actual).toBe(1);
    expect((await only(root, { exclude: ['dist'] })).actual).toBe(0);
  });

  it('leaves an excluded file out of a layer rule', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-layers order="src/domain, src/infra" -->\n',
      'src/domain/user.ts': 'export const user = 1;\n',
      'src/infra/db.ts': "import { user } from '../domain/user.js';\nexport const db = user;\n",
      'src/domain/generated/bad.ts': "import { db } from '../../infra/db.js';\nexport const bad = db;\n",
    });

    expect((await only(root)).ok).toBe(false);
    expect((await only(root, { exclude: ['generated'] })).ok).toBe(true);
  });

  it('leaves an excluded file out of a structure rule', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-structure target="src" pattern="*.ts" -->\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/dist/bundle.js': 'var a = 1;\n',
    });

    expect((await only(root)).ok).toBe(false);
    expect((await only(root, { exclude: ['dist'] })).ok).toBe(true);
  });

  it('does not touch @assert-present, which names its files', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-present file="dist/index.js" -->\n',
      'dist/index.js': 'export {};\n',
    });

    expect((await only(root, { exclude: ['dist'] })).ok).toBe(true);
  });
});

describe('resolving a directive under the project exclusions', () => {
  const directive = (attributes: Record<string, string>): Directive => ({
    kind: 'assert-absence',
    attributes: { symbol: 'X', ...attributes },
    raw: '<!-- @assert-absence -->',
    location: { file: '/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
  });
  const resolved = (attributes: Record<string, string>, exclude?: string[]) => {
    const outcome = resolveDirective(directive(attributes), { root: '/repo', excludeFiles: new Set(), ...(exclude ? { exclude } : {}) });
    if (!('assertion' in outcome)) throw new Error('expected an assertion');
    return outcome.assertion;
  };

  it("puts the project's first, names each path once, and describes only the rule's own", () => {
    const assertion = resolved({ exclude: 'dist, tests' }, ['target', 'dist']);
    expect(assertion.search?.excludeGlobs).toEqual(['target', 'dist', 'tests']);
    expect(assertion.description).toBe('"X" must not appear in . (excluding dist, tests)');
    expect(resolved({}, ['target']).description).toBe('"X" must not appear in .');
    expect(resolved({}).search?.excludeGlobs).toEqual([]);
  });

  it("refuses a directive's own exclude pattern that could never exclude anything, for every kind that takes one", () => {
    const refused = (kind: Directive['kind'], attributes: Record<string, string>) => {
      const outcome = resolveDirective({ ...directive(attributes), kind }, { root: '/repo', excludeFiles: new Set() });
      return 'error' in outcome ? outcome.error.message : 'resolved';
    };

    expect(refused('assert-absence', { exclude: 'build !build/keep.ts' })).toBe(
      'Attribute "exclude" has an invalid exclude pattern "!build/keep.ts": negation patterns are not supported in exclude.',
    );
    expect(refused('assert-import-cycle', { exclude: '../vendor' })).toBe(
      'Attribute "exclude" has an invalid exclude pattern "../vendor": ".." leads out of the root, and only paths inside it are searched.',
    );
    expect(refused('assert-structure', { pattern: '*.ts', exclude: './' })).toBe(
      'Attribute "exclude" has an invalid exclude pattern "./": it names the root itself rather than a path under it.',
    );
    expect(refused('assert-absence', { exclude: '/build ./dist src\\gen' })).toBe('resolved');
  });
});

describe('the project exclusions through the API', () => {
  it('are on every report, and empty when there were none', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-absence symbol="LegacyClient" -->\n', 'src/a.ts': 'export {};\n' });
    expect((await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' })).exclude).toEqual([]);
    expect((await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript', exclude: ['target', 'dist'] })).exclude).toEqual(['target', 'dist']);
    expect((await queryRules({ patterns: ['docs/*.md'], root, paths: ['src/a.ts'] })).exclude).toEqual([]);
  });

  it('refuse a pattern that could never exclude anything, as the command line does', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-absence symbol="LegacyClient" -->\n' });
    const message = 'invalid exclude pattern "!dist/keep.js": negation patterns are not supported in exclude.';
    await expect(runSpecGuard({ patterns: ['docs/*.md'], root, exclude: ['dist', '!dist/keep.js'] })).rejects.toThrow(message);
    await expect(queryRules({ patterns: ['docs/*.md'], root, paths: ['dist'], exclude: ['!dist/keep.js'] })).rejects.toThrow(message);
  });
});

describe('a query under the project exclusions', () => {
  it('does not list a rule for a path the project excludes', async () => {
    const root = await repo({ 'docs/a.md': '<!-- @assert-absence symbol="LegacyClient" -->\n' });
    const ask = (exclude?: string[]) => queryRules({ patterns: ['docs/*.md'], root, paths: ['target/gen.ts'], ...(exclude ? { exclude } : {}) });

    expect((await ask()).results[0]?.rules).toHaveLength(1);
    expect((await ask(['target'])).results[0]?.rules).toEqual([]);
  });
});

describe('a query, saying why nothing governs a path', () => {
  const RULES = [
    '# Rules',
    '',
    '<!-- @assert-absence target="src" symbol="LegacyClient" exclude="src/legacy" -->',
    '<!-- @assert-layers target="src" order="src/domain, src/legacy" exclude="src/legacy/generated" -->',
    '<!-- @assert-present file="dist/index.js" -->',
    '',
  ].join('\n');
  const DRAFT = '# Draft\n\n**Status:** draft\n\n<!-- @assert-absence target="src" symbol="Date.now" exclude="src/legacy" -->\n';

  async function ask(paths: string[], options: { exclude?: string[]; includeInactive?: boolean } = {}) {
    const root = await repo({ 'docs/rules.md': RULES, 'docs/draft.md': DRAFT });
    return queryRules({ patterns: ['docs/*.md'], root, paths, ...options });
  }

  it("names the project's patterns that match the path, and no others", async () => {
    const report = await ask(['dist/assets/app.js', 'dist', 'src/a.ts', '.'], { exclude: ['target', 'dist', '*.map'] });
    expect(report.results.map((result) => [result.path, result.excluded.project])).toEqual([
      ['dist/assets/app.js', ['dist']],
      ['dist', ['dist']],
      ['src/a.ts', []],
      ['.', []],
    ]);
  });

  it("lists the rules whose own exclude leaves the path out, as a query lists rules, and only those in force unless asked", async () => {
    const report = await ask(['src/legacy/generated/api.ts']);
    expect(report.results[0]?.rules).toEqual([]);
    expect(report.results[0]?.excluded.rules.map((rule) => [rule.document, rule.line, rule.kind, rule.inForce])).toEqual([
      ['docs/rules.md', 3, 'assert-absence', true],
      ['docs/rules.md', 4, 'assert-layers', true],
    ]);
    expect(report.documents.map((document) => document.file)).toEqual(['docs/rules.md']);

    const withDrafts = await ask(['src/legacy/a.ts'], { includeInactive: true });
    expect(withDrafts.results[0]?.excluded.rules.map((rule) => [rule.document, rule.line])).toEqual([
      ['docs/draft.md', 5],
      ['docs/rules.md', 3],
    ]);
    // The layer rule governs src/legacy/a.ts: only src/legacy/generated is its exclusion.
    expect(withDrafts.results[0]?.rules.map((rule) => rule.line)).toEqual([4]);
  });

  it("counts a pattern the project lists as the project's, even when the directive lists it too", async () => {
    const report = await ask(['src/legacy/a.ts'], { exclude: ['src/legacy'] });
    expect(report.results[0]?.excluded).toEqual({ project: ['src/legacy'], rules: [] });
  });

  it('says why in the human answer: the project, a rule of its own, or nothing at all', async () => {
    const report = await ask(['target/out.ts', 'src/legacy/generated/api.ts', 'dist/index.js', 'lib/x.ts'], { exclude: ['target', 'dist'] });
    expect(formatQuery({ ...report, durationMs: 1 })).toBe(
      [
        'target/out.ts (does not exist yet)',
        "  no rules in force govern this path: the project's exclude leaves it out (target)",
        '',
        'src/legacy/generated/api.ts (does not exist yet)',
        '  no rules in force govern this path: exclude="..." leaves it out of 2 rules',
        '',
        '  left out by exclude="...":',
        '    docs/rules.md:3 @assert-absence  "LegacyClient" must not appear in src (excluding src/legacy)',
        '    docs/rules.md:4 @assert-layers  src must keep its layers in order, src/domain < src/legacy (excluding src/legacy/generated)',
        '',
        'dist/index.js (does not exist yet)',
        '  1 rule from 1 document',
        '',
        '  Rules  (docs/rules.md)',
        '    :5 @assert-present  dist/index.js must exist',
        '',
        "  the project's exclude leaves this path out of every rule that takes one (dist)",
        '',
        'lib/x.ts (does not exist yet)',
        '  no rules in force govern this path',
        '',
        'exclude from the command line: target, dist',
        '',
        '2 spec files read in 1.0ms',
      ].join('\n'),
    );
  });

  it('names one rule in the singular, and a rule of its own under the project headline', async () => {
    // A layer rule reads no plain text, so only the text rule would reach this file.
    const report = await ask(['src/legacy/generated/notes.txt']);
    expect(formatQuery({ ...report, durationMs: 1 }).split('\n').slice(0, 6)).toEqual([
      'src/legacy/generated/notes.txt (does not exist yet)',
      '  no rules in force govern this path: exclude="..." leaves it out of 1 rule',
      '',
      '  left out by exclude="...":',
      '    docs/rules.md:3 @assert-absence  "LegacyClient" must not appear in src (excluding src/legacy)',
      '',
    ]);
    const excludedOnce = await ask(['src/legacy/generated/api.ts'], { exclude: ['src/legacy/generated'] });
    expect(formatQuery({ ...excludedOnce, durationMs: 1 }).split('\n').slice(0, 6)).toEqual([
      'src/legacy/generated/api.ts (does not exist yet)',
      "  no rules in force govern this path: the project's exclude leaves it out (src/legacy/generated)",
      '',
      '  left out by exclude="...":',
      '    docs/rules.md:3 @assert-absence  "LegacyClient" must not appear in src (excluding src/legacy)',
      '',
    ]);
  });
});

describe('.spec-guard.json, from the command line', () => {
  function io(cwd: string): { cli: CliIO; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { cli: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd, isTTY: false }, out, err };
  }

  const PROJECT = {
    'rules/a.md': '<!-- @assert-absence symbol="LegacyClient" -->\n',
    'Cargo.toml': '[package]\nname = "x"\n',
    'src/main.rs': 'fn main() {}\n',
    'target/debug/build.rs': '// LegacyClient\nLegacyClient;\n',
  };

  it('runs the specs it names with the exclusions it lists, and says where they came from', async () => {
    const root = await repo({ ...PROJECT, '.spec-guard.json': JSON.stringify({ specs: ['rules/*.md'], exclude: ['target'] }) });
    const { cli, out, err } = io(root);

    expect(await main(['--engine', 'js'], cli)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join('\n')).toMatch(/\noptions from \.spec-guard\.json: specs, exclude \(target\)\n\n1 passed/);

    const cleared = io(root);
    expect(await main(['--engine', 'js', '--exclude='], cleared.cli)).toBe(1);
    expect(cleared.out.join('\n')).toMatch(/\noptions from \.spec-guard\.json: specs; overridden on the command line: exclude \(none\)\n\n0 passed/);
  });

  it('names the exclusions in a JSON report, from a file, the command line, or nowhere', async () => {
    const root = await repo({ ...PROJECT, '.spec-guard.json': JSON.stringify({ specs: ['rules/*.md'], exclude: ['target'] }) });
    const json = async (...args: string[]) => {
      const { cli, out } = io(root);
      await main(['--engine', 'js', '--json', ...args], cli);
      return JSON.parse(out.join('\n')) as { exclude: string[]; config?: unknown };
    };

    expect(await json()).toMatchObject({ exclude: ['target'], config: { file: '.spec-guard.json', applied: ['specs', 'exclude'], overridden: [] } });
    expect(await json('--exclude', 'target, dist')).toMatchObject({ exclude: ['target', 'dist'], config: { applied: ['specs'], overridden: ['exclude'] } });
    expect(await json('--exclude=')).toMatchObject({ exclude: [] });
  });

  it('names exclusions given only on the command line, which used to leave no trace in the report', async () => {
    const root = await repo(PROJECT);
    const { cli, out, err } = io(root);

    expect(await main(['--engine', 'js', '--spec', 'rules/*.md', '--exclude', 'target'], cli)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join('\n')).toMatch(/\n\nexclude from the command line: target\n\n1 passed/);

    const plain = io(root);
    expect(await main(['--engine', 'js', '--spec', 'rules/*.md'], plain.cli)).toBe(1);
    expect(plain.out.join('\n')).not.toContain('exclude from');

    const query = io(root);
    expect(await main(['query', 'target/debug/build.rs', '--spec', 'rules/*.md', '--exclude', 'target'], query.cli)).toBe(EXIT_OK);
    expect(query.out.join('\n')).toMatch(
      /^target\/debug\/build\.rs\n {2}no rules in force govern this path: the project's exclude leaves it out \(target\)\n\nexclude from the command line: target\n\n1 spec file read in/,
    );
  });

  it('exits 2 for an exclude pattern that could never exclude anything, before reading a spec', async () => {
    const root = await repo(PROJECT);
    const { cli, out, err } = io(root);

    expect(await main(['--spec', 'rules/*.md', '--exclude', 'target, !target/keep.rs'], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['Option --exclude has an invalid exclude pattern "!target/keep.rs": negation patterns are not supported in exclude.', '', HELP]);

    const configured = await repo({ ...PROJECT, '.spec-guard.json': JSON.stringify({ specs: ['rules/*.md'], exclude: ['../target'] }) });
    const fromFile = io(configured);
    expect(await main(['query', 'src/main.rs'], fromFile.cli)).toBe(EXIT_ERROR);
    expect(fromFile.err).toEqual([
      'spec-guard: .spec-guard.json: "exclude" has an invalid exclude pattern "../target": ".." leads out of the root, and only paths inside it are searched.',
    ]);
  });

  it('refuses a root with options in package.json and .spec-guard.json both', async () => {
    const root = await repo({
      ...PROJECT,
      'package.json': JSON.stringify({ specGuard: { specs: ['rules/*.md'] } }),
      '.spec-guard.json': JSON.stringify({ exclude: ['target'] }),
    });
    const { cli, out, err } = io(root);

    expect(await main(['--engine', 'js'], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'spec-guard: Options are set in both package.json ("specGuard") and .spec-guard.json. Keep them in one of the two, so that no option is written somewhere nothing reads.',
    ]);
  });

  it('gives a query the exclusions too', async () => {
    const root = await repo({ ...PROJECT, '.spec-guard.json': JSON.stringify({ specs: ['rules/*.md'], exclude: ['target'] }) });
    const { cli, out } = io(root);

    expect(await main(['query', 'target/debug/build.rs'], cli)).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain("  no rules in force govern this path: the project's exclude leaves it out (target)\n");
    expect(text).toContain('\noptions from .spec-guard.json: specs, exclude (target)\n');
  });
});
