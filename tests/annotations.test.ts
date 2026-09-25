/**
 * GitLab Code Quality and GitHub workflow commands: the two formats, beside
 * SARIF, that put a finding on a line of a merge or pull request.
 *
 * Both are written from one list of findings per report, so what is pinned
 * here is that list - which findings a run and a proof have, where each sits,
 * how much it matters - and then exactly how each format spells one.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { proveSpecGuard } from '../src/prove.js';
import { formatGithub, formatGitlab, proveAnnotations, runAnnotations, type Annotation } from '../src/reporter.js';
import { runSpecGuard } from '../src/runner.js';
import { DEMO_REPO, memoryIo } from './helpers.js';

const ROOT = path.resolve('/virtual/annotations');

interface GitlabIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: string;
  location: { path: string; lines: { begin: number } };
}

const gitlab = (annotations: readonly Annotation[]): GitlabIssue[] => JSON.parse(formatGitlab(annotations)) as GitlabIssue[];

const sha256 = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');

const TREE = {
  'docs/rules.md': [
    '# Rules',
    '',
    '<!-- @assert-absence target="src" symbol="Legacy" -->',
    '<!-- @assert-present file="docs/gone.md" -->',
    '<!-- @assert-count symbol="X" -->',
    '<!-- @assert-absence target="src" symbol="Fine" -->',
    '',
  ].join('\n'),
  'docs/old.md': '# Old\n\n**Status:** Superseded by rules.md\n\n<!-- @assert-absence target="src" symbol="a" -->\n<!-- @assert-absence target="src" symbol="b" -->\n',
  'docs/older.md': '# Older\n\n**Status:** deprecated\n\n<!-- @assert-absence target="src" symbol="c" -->\n',
  'src/a.ts': 'export const ok = 1;\nconst x = Legacy;\nLegacy();\n',
};

async function run() {
  return runSpecGuard({ patterns: ['docs/*.md'], root: ROOT, io: memoryIo(ROOT, TREE) });
}

describe('a run\'s findings', () => {
  it('are each failing assertion on its first offending line, else on its directive; each invalid directive; each document not in force', async () => {
    expect(runAnnotations(await run())).toEqual([
      {
        rule: 'assert-absence',
        level: 'error',
        severity: 'critical',
        file: 'src/a.ts',
        line: 2,
        message: '"Legacy" must not appear in src: expected no matches, found 2 (docs/rules.md:3)',
      },
      {
        rule: 'assert-present',
        level: 'error',
        severity: 'critical',
        file: 'docs/rules.md',
        line: 4,
        message: 'docs/gone.md must exist: missing: docs/gone.md (docs/rules.md:4)',
      },
      {
        rule: 'invalid-directive',
        level: 'error',
        severity: 'major',
        file: 'docs/rules.md',
        line: 5,
        message: '@assert-count requires expected="...", min="..." or max="...".',
      },
      {
        rule: 'not-in-force',
        level: 'notice',
        severity: 'info',
        file: 'docs/old.md',
        line: 1,
        message: 'docs/old.md is Superseded by rules.md, so its 2 assertions were not executed.',
      },
      {
        rule: 'not-in-force',
        level: 'notice',
        severity: 'info',
        file: 'docs/older.md',
        line: 1,
        message: 'docs/older.md is deprecated, so its 1 assertion was not executed.',
      },
    ]);
  });

  it('put a directory missing an entry on the directive, since the directory has no line', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/*.md'],
      root: ROOT,
      io: memoryIo(ROOT, { 'docs/r.md': '<!-- @assert-structure target="pkgs" dirs="*" required="README.md" -->\n', 'pkgs/a/x.ts': '' }),
    });
    expect(runAnnotations(report).map(({ file, line }) => [file, line])).toEqual([['docs/r.md', 1]]);
  });

  it('are none when every assertion holds and every document is in force', async () => {
    const report = await runSpecGuard({ patterns: ['docs/*.md'], root: ROOT, io: memoryIo(ROOT, { 'docs/r.md': '<!-- @assert-absence target="src" symbol="Q" -->\n', 'src/a.ts': '' }) });
    expect(runAnnotations(report)).toEqual([]);
    expect(formatGitlab(runAnnotations(report))).toBe('[]');
    expect(formatGithub(runAnnotations(report))).toBe('');
  });
});

describe('a proof\'s findings', () => {
  it('are a survivor, critical, and an unprovable rule, minor, on their directives, with the directives that could not be read and the documents not in force', async () => {
    const io = memoryIo(ROOT, {
      'docs/rules.md': [
        '<!-- @assert-absence target="src" glob="*.js" symbol="Legacy" allow-empty="true" -->',
        '<!-- @assert-absence target="src" symbol="there" -->',
        '<!-- @assert-absence target="src" symbol="Legacy" -->',
        '<!-- @assert-bogus -->',
        '',
      ].join('\n'),
      'docs/draft.md': '**Status:** draft\n\n<!-- @assert-absence target="src" symbol="z" -->\n',
      'src/a.ts': 'const there = 1;\n',
    });
    const report = await proveSpecGuard({ patterns: ['docs/*.md'], root: ROOT, io });
    const annotations = proveAnnotations(report);
    expect(annotations.map(({ rule, level, severity, file, line }) => [rule, level, severity, file, line])).toEqual([
      ['rule-cannot-fail', 'error', 'critical', 'docs/rules.md', 1],
      ['rule-unprovable', 'notice', 'minor', 'docs/rules.md', 2],
      ['invalid-directive', 'error', 'major', 'docs/rules.md', 4],
      ['not-in-force', 'notice', 'info', 'docs/draft.md', 1],
    ]);
    expect(annotations[0]?.message).toBe(
      '"Legacy" must not appear in src: added src/spec-guard-prove.ts holding "Legacy", beside the code under src, none of which the rule reads, and it still passed: expected no matches, found 0',
    );
    expect(annotations[1]?.message).toBe(
      `"there" must not appear in src: ${report.results[1]?.unprovable as string}`,
    );
    expect(annotations[3]?.message).toBe('docs/draft.md is draft, so its 1 rule was not proved.');
  });
});

describe('GitLab Code Quality', () => {
  const annotation: Annotation = {
    rule: 'ghost-citation',
    level: 'error',
    severity: 'critical',
    file: 'src/ledger.rs',
    line: 12,
    message: 'src/ledger.rs:12 cites ADR-0099, which no document defines',
  };

  it('is an array of issues, each with a description, a check name, a fingerprint, a severity and a place', () => {
    expect(gitlab([annotation])).toEqual([
      {
        description: 'src/ledger.rs:12 cites ADR-0099, which no document defines',
        check_name: 'ghost-citation',
        fingerprint: sha256('ghost-citation', 'src/ledger.rs', 'src/ledger.rs:12 cites ADR-0099, which no document defines'),
        severity: 'critical',
        location: { path: 'src/ledger.rs', lines: { begin: 12 } },
      },
    ]);
  });

  it('fingerprints the rule, the file and the message, each of which tells two issues apart', () => {
    const fingerprints = gitlab([
      annotation,
      { ...annotation, rule: 'stale-citation' },
      { ...annotation, file: 'src/other.rs' },
      { ...annotation, message: 'another' },
      // The line is not part of it: GitLab places an issue by its location.
      { ...annotation, line: 13 },
    ]).map((issue) => issue.fingerprint);
    expect(fingerprints).toHaveLength(4);
    expect(new Set(fingerprints).size).toBe(4);
    expect(fingerprints[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the same issue once, and a finding about a whole file on its first line', () => {
    expect(gitlab([annotation, annotation])).toHaveLength(1);
    expect(gitlab([{ ...annotation, line: 0 }])[0]?.location).toEqual({ path: 'src/ledger.rs', lines: { begin: 1 } });
  });

  it('is written for a run, and is an empty array when no spec matched', async () => {
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };
    expect(await main(['docs/adr/0002-failing.md', '--engine', 'js', '--format', 'gitlab'], io)).toBe(EXIT_FAILED);
    const issues = JSON.parse(out.join('\n')) as GitlabIssue[];
    expect(issues.map((issue) => [issue.check_name, issue.severity, issue.location.path])).toEqual([
      ['assert-absence', 'critical', 'src/legacy/LegacyPaymentGateway.ts'],
      ['assert-count', 'critical', 'src/core/DeprecatedHelper.ts'],
      ['assert-count', 'critical', 'docs/adr/0002-failing.md'],
      ['assert-present', 'critical', 'docs/adr/0002-failing.md'],
    ]);

    const empty: string[] = [];
    const quiet: CliIO = { stdout: (text) => empty.push(text), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };
    expect(await main(['nowhere/*.md', '--format', 'gitlab'], quiet)).toBe(EXIT_ERROR);
    expect(empty).toEqual(['[]']);
  });
});

describe('GitHub workflow commands', () => {
  it('are one line per finding, at its level, with the file, line and rule as properties', () => {
    expect(
      formatGithub([
        { rule: 'assert-absence', level: 'error', severity: 'critical', file: 'src/a.ts', line: 2, message: 'no' },
        { rule: 'rule-unprovable', level: 'notice', severity: 'minor', file: 'docs/r.md', line: 0, message: 'why' },
        { rule: 'stale-citation', level: 'warning', severity: 'minor', file: 'src/b.ts', line: 7, message: 'old' },
      ]),
    ).toBe(
      [
        '::error file=src/a.ts,line=2,title=assert-absence::no',
        '::notice file=docs/r.md,line=1,title=rule-unprovable::why',
        '::warning file=src/b.ts,line=7,title=stale-citation::old',
      ].join('\n'),
    );
  });

  it('escape what would end a command early: a percent and line breaks everywhere, and a colon or comma in a property', () => {
    expect(
      formatGithub([{ rule: 'a:b,c', level: 'error', severity: 'critical', file: 'C:,x%.ts', line: 1, message: '50% done\r\nnext: a, b' }]),
    ).toBe('::error file=C%3A%2Cx%25.ts,line=1,title=a%3Ab%2Cc::50%25 done%0D%0Anext: a, b');
  });

  it('are written for a run, and nothing at all is written for a run with none', async () => {
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };
    expect(await main(['docs/adr/0002-failing.md', '--engine', 'js', '--format', 'github'], io)).toBe(EXIT_FAILED);
    expect(out).toHaveLength(1);
    expect(out[0]?.split('\n')).toHaveLength(4);
    expect(out[0]?.split('\n')[0]).toBe(
      '::error file=src/legacy/LegacyPaymentGateway.ts,line=2,title=assert-absence::"LegacyPaymentGateway" must not appear in src: expected no matches, found 2 (docs/adr/0002-failing.md:6)',
    );

    const clean: string[] = [];
    const quiet: CliIO = { stdout: (text) => clean.push(text), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };
    expect(await main(['docs/adr/0001-passing.md', '--engine', 'js', '--format', 'github'], quiet)).toBe(EXIT_OK);
    expect(clean).toEqual([]);
  });

  it('write nothing for a run that matched no spec, and say why on stderr', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, cwd: DEMO_REPO, isTTY: false };
    expect(await main(['nowhere/*.md', '--format', 'github'], io)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['spec-guard: no spec files matched "nowhere/*.md"']);
  });
});

describe('prove in both formats', () => {
  it('writes its findings, and for no spec an empty GitLab report or, for GitHub, the reason on stderr', async () => {
    const lines = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, cwd: DEMO_REPO, isTTY: false };
      return { code: await main(argv, io), out, err };
    };
    const survivor = await lines(['prove', 'docs/adr/0002-failing.md', '--format', 'gitlab']);
    expect(survivor.code).toBe(EXIT_OK);
    // Every rule in that spec fails on the tree as it stands, so each is unprovable.
    expect((JSON.parse(survivor.out.join('')) as GitlabIssue[]).map((issue) => issue.severity)).toEqual(['minor', 'minor', 'minor', 'minor']);

    const github = await lines(['prove', 'docs/adr/0002-failing.md', '--format', 'github']);
    expect(github.out.join('\n').split('\n').every((line) => line.startsWith('::notice file=docs/adr/0002-failing.md,line='))).toBe(true);

    const none = await lines(['prove', 'nowhere/*.md', '--format', 'gitlab']);
    expect([none.code, none.out, none.err]).toEqual([EXIT_ERROR, ['[]'], []]);
    const noneGithub = await lines(['prove', 'nowhere/*.md', '--format', 'github']);
    expect([noneGithub.code, noneGithub.out, noneGithub.err]).toEqual([EXIT_ERROR, [], ['spec-guard: no spec files matched "nowhere/*.md"']]);
    const allowed = await lines(['prove', 'nowhere/*.md', '--format', 'github', '--allow-empty']);
    expect(allowed.code).toBe(EXIT_OK);

    const clean = await lines(['prove', 'docs/adr/0001-passing.md', '--format', 'github']);
    expect([clean.code, clean.out]).toEqual([EXIT_OK, []]);
  });
});

describe('--format', () => {
  it('takes github and gitlab for a run and a proof, in any case', () => {
    expect(parseArgs(['--format', 'GitLab'], DEMO_REPO).format).toBe('gitlab');
    expect(parseArgs(['--format=github'], DEMO_REPO)).toMatchObject({ format: 'github', json: false });
    expect(parseArgs(['prove', '--format', 'gitlab'], DEMO_REPO).format).toBe('gitlab');
    expect(parseArgs(['prove', '--format', 'github'], DEMO_REPO).format).toBe('github');
  });

  it('refuses them for a query, which lists rules, and names what it has', () => {
    for (const format of ['sarif', 'github', 'gitlab']) {
      expect(() => parseArgs(['query', 'src', '--format', format], DEMO_REPO)).toThrow(
        new UsageError(`spec-guard query has no ${format} format: it lists rules, not results. Expected human or json.`),
      );
    }
  });

  it('names every format a command has when it is given one nobody has', () => {
    expect(() => parseArgs(['--format', 'xml'], DEMO_REPO)).toThrow(new UsageError('Unknown format "xml". Expected human, json, sarif, github or gitlab.'));
    expect(() => parseArgs(['prove', '--format', 'xml'], DEMO_REPO)).toThrow(new UsageError('Unknown format "xml". Expected human, json, sarif, github or gitlab.'));
    expect(() => parseArgs(['query', 'src', '--format', 'xml'], DEMO_REPO)).toThrow(new UsageError('Unknown format "xml". Expected human or json.'));
  });
});
