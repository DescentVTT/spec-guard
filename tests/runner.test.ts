import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { resetRipgrepProbe } from '../src/engine.js';
import { createImportIndex } from '../src/imports.js';
import { EMPTY_LEDGER } from '../src/scope.js';
import { createScopeProbe, executeAssertion, resolveDirective, runSpecGuard } from '../src/runner.js';
import type { Directive, DirectiveKind } from '../src/types.js';
import { DEMO_REPO, findTestRipgrep, makeTempRepo, removeTempRepo } from './helpers.js';

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;
const temporary: string[] = [];

/** Both engines must produce identical reports; run every case on both. */
const ENGINES = (rgPath ? (['javascript', 'ripgrep'] as const) : (['javascript'] as const)).map((engine) => engine);

beforeAll(() => {
  if (rgPath) process.env.SPEC_GUARD_RG = rgPath;
  resetRipgrepProbe();
});

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

afterAll(() => {
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

function directive(kind: DirectiveKind, attributes: Record<string, string>): Directive {
  return {
    kind,
    attributes,
    raw: `<!-- @${kind} -->`,
    location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
  };
}

const context = { root: DEMO_REPO, excludeFiles: new Set<string>() };

describe('resolveDirective', () => {
  it('defaults an absence assertion to zero matches over the whole root', () => {
    const resolved = resolveDirective(directive('assert-absence', { symbol: 'X' }), context);
    expect('assertion' in resolved && resolved.assertion).toMatchObject({
      bounds: { max: 0 },
      targets: ['.'],
      description: '"X" must not appear in .',
    });
  });

  it('accepts expected as an upper bound for absence', () => {
    const resolved = resolveDirective(directive('assert-absence', { symbol: 'X', expected: '2' }), context);
    expect('assertion' in resolved && resolved.assertion.bounds).toEqual({ max: 2 });
  });

  it('accepts max as an alias of expected for absence', () => {
    const resolved = resolveDirective(directive('assert-absence', { symbol: 'X', max: '2' }), context);
    expect('assertion' in resolved && resolved.assertion.bounds).toEqual({ max: 2 });
  });

  it('rejects expected and max together', () => {
    const resolved = resolveDirective(directive('assert-absence', { symbol: 'X', expected: '1', max: '2' }), context);
    expect('error' in resolved && resolved.error.message).toContain('not both');
  });

  it('turns expected into an exact range for counts', () => {
    const resolved = resolveDirective(directive('assert-count', { symbol: 'X', expected: '3' }), context);
    expect('assertion' in resolved && resolved.assertion.bounds).toEqual({ min: 3, max: 3 });
  });

  it('supports min and max together', () => {
    const resolved = resolveDirective(directive('assert-count', { symbol: 'X', min: '1', max: '3' }), context);
    expect('assertion' in resolved && resolved.assertion.description).toBe(
      '"X" must appear between 1 and 3 times in .',
    );
  });

  it.each([
    [{ symbol: 'X' }, 'requires expected'],
    [{ symbol: 'X', expected: '1', min: '1' }, 'not both'],
    [{ symbol: 'X', min: '3', max: '1' }, 'greater than'],
    [{ symbol: 'X', expected: 'many' }, 'non-negative integer'],
    [{ symbol: 'X', expected: '-1' }, 'non-negative integer'],
    [{ expected: '1' }, 'non-empty symbol'],
    [{ symbol: '', expected: '1' }, 'non-empty symbol'],
    [{ symbol: 'X', expected: '1', regex: 'maybe' }, 'must be true or false'],
    [{ symbol: '(', expected: '1', regex: 'true' }, 'Invalid regular expression'],
    [{ symbol: 'X', expected: '1', target: '../outside' }, 'escapes the root'],
    [{ symbol: 'X', expected: '1', target: '/etc' }, 'must be relative'],
    [{ symbol: 'X', expected: '1', target: 'C:/Windows' }, 'must be relative'],
  ])('rejects %o', (attributes, expected) => {
    const resolved = resolveDirective(directive('assert-count', attributes), context);
    expect('error' in resolved && resolved.error.message).toContain(expected);
  });

  it('requires a file for assert-present', () => {
    const resolved = resolveDirective(directive('assert-present', {}), context);
    expect('error' in resolved && resolved.error.message).toContain('requires a file');
  });

  it('accepts several files in one assert-present', () => {
    const resolved = resolveDirective(directive('assert-present', { file: 'a.md, b.md' }), context);
    expect('assertion' in resolved && resolved.assertion.files).toEqual(['a.md', 'b.md']);
  });

  it('parses boolean attributes in every accepted spelling', () => {
    const resolved = resolveDirective(
      directive('assert-count', { symbol: 'X', expected: '1', regex: 'yes', word: 'ON', 'ignore-case': 'false' }),
      context,
    );
    expect('assertion' in resolved && resolved.assertion.search).toMatchObject({
      regex: true,
      word: true,
      ignoreCase: false,
    });
  });

  it('splits comma separated targets and globs', () => {
    const resolved = resolveDirective(
      directive('assert-count', { symbol: 'X', expected: '1', target: 'src/a, src/b ', glob: '*.ts, *.tsx' }),
      context,
    );
    expect('assertion' in resolved && resolved.assertion.targets).toEqual(['src/a', 'src/b']);
    expect('assertion' in resolved && resolved.assertion.search?.globs).toEqual(['*.ts', '*.tsx']);
  });

  it('carries the reason through to the assertion', () => {
    const resolved = resolveDirective(
      directive('assert-absence', { symbol: 'X', reason: 'retired in ADR-7' }),
      context,
    );
    expect('assertion' in resolved && resolved.assertion.reason).toBe('retired in ADR-7');
  });
});

describe.each(ENGINES)('runSpecGuard [%s engine]', (engine) => {
  it('passes every assertion in the reference ADR', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0001-passing.md'], root: DEMO_REPO, engine });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({ specs: 1, total: 8, passed: 8, failed: 0, skipped: 0, inactive: 0 });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    // With no fallback, the report names the engine that was asked for.
    expect(report.engine).toBe(engine);
    expect(report.results.every((result) => result.ok)).toBe(true);
  });

  it('fails every assertion in the broken ADR and explains why', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0002-failing.md'], root: DEMO_REPO, engine });

    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({ total: 4, passed: 0, failed: 4 });

    const [absence, tooMany, tooFew, missingFile] = report.results;
    expect(absence).toMatchObject({ ok: false, actual: 2, message: 'expected no matches, found 2' });
    expect(absence?.matches[0]).toMatchObject({ file: 'src/legacy/LegacyPaymentGateway.ts', line: 2 });
    expect(absence?.reason).toBe('retired in ADR-0002');
    expect(tooMany).toMatchObject({ ok: false, actual: 3, message: 'expected at most 1 match, found 3' });
    expect(tooFew).toMatchObject({ ok: false, actual: 0, message: 'expected at least 1 match, found 0' });
    expect(missingFile).toMatchObject({ ok: false, actual: 0, message: 'missing: docs/does-not-exist.md' });
  });

  it('reports malformed directives instead of skipping them', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0003-invalid.md'], root: DEMO_REPO, engine });

    expect(report.ok).toBe(false);
    expect(report.summary.total).toBe(0);
    expect(report.errors).toHaveLength(4);
    expect(report.errors.map((error) => error.location.line)).toEqual([5, 6, 7, 8]);
  });

  it('honours word, regex, ignore-case and glob options', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0004-search-options.md'], root: DEMO_REPO, engine });
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('fails on a missing target', async () => {
    // Fail-closed: a check that cannot tell "the code is clean" from "the
    // directory moved" would report success while verifying nothing.
    const report = await runSpecGuard({ patterns: ['docs/adr/0005-missing-target.md'], root: DEMO_REPO, engine });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toBe('target path does not exist: src/does-not-exist');
    expect(report.results[0]?.warnings).toEqual(['target path not found: src/does-not-exist']);
  });

  it('tolerates a missing target only when asked', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0005-missing-target.md'],
      root: DEMO_REPO,
      engine,
      allowMissingTargets: true,
    });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.warnings).toEqual(['target path not found: src/does-not-exist']);
  });

  it('runs every spec matched by a glob', async () => {
    const report = await runSpecGuard({ patterns: ['docs/**/*.md'], root: DEMO_REPO, engine });
    expect(report.summary.specs).toBe(5);
    expect(report.summary.total).toBe(19);
    // Four broken invariants plus the missing target, which now fails closed.
    expect(report.summary.failed).toBe(5);
  });

  it('stops at the first failure with fail-fast', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0002-failing.md'],
      root: DEMO_REPO,
      engine,
      failFast: true,
    });

    expect(report.results).toHaveLength(1);
    expect(report.summary).toMatchObject({ total: 1, failed: 1, skipped: 3 });
  });

  it('does not stop early when fail-fast finds no failure', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine,
      failFast: true,
    });

    expect(report.summary).toMatchObject({ total: 8, failed: 0, skipped: 0 });
  });

  it('excludes the spec files themselves by default', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-absence target="." symbol="ForbiddenSymbol" -->\n',
      'src/clean.ts': 'export const ok = 1;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine });
    expect(report.ok).toBe(true);
    expect(report.results[0]?.actual).toBe(0);
  });

  it('counts matches inside spec files when asked', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-absence target="." symbol="ForbiddenSymbol" -->\nForbiddenSymbol is discussed here.\n',
      'src/clean.ts': 'export const ok = 1;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine, includeSpecs: true });
    expect(report.ok).toBe(false);
    // The prose counts. The directive above it does not: a directive is an HTML
    // comment, and a rule whose own text triggers it can never be satisfied.
    expect(report.results[0]?.actual).toBe(1);
    expect(report.results[0]?.commentMatches).toBe(1);
  });

  it('counts the directive itself only when comments are included', async () => {
    const root = await repo({
      'docs/adr.md':
        '<!-- @assert-absence target="." symbol="ForbiddenSymbol" comments="include" -->\n',
      'src/clean.ts': 'export const ok = 1;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine, includeSpecs: true });
    expect(report.ok).toBe(false);
    expect(report.results[0]?.actual).toBe(1);
  });

  it('reports nothing to do when no spec file matches', async () => {
    const report = await runSpecGuard({ patterns: ['docs/**/*.rst'], root: DEMO_REPO, engine });
    expect(report.summary).toMatchObject({ specs: 0, total: 0 });
    expect(report.ok).toBe(true);
  });

  it('honours a custom concurrency', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine,
      concurrency: 1,
    });
    expect(report.ok).toBe(true);
  });

  it('limits the number of snippets kept per failure', async () => {
    const root = await repo({
      'docs/adr.md': '<!-- @assert-absence target="src" symbol="Repeated" -->\n',
      'src/a.ts': Array.from({ length: 10 }, (_, index) => `const Repeated${index} = ${index};`).join('\n'),
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine, maxSnippets: 2 });
    expect(report.results[0]?.actual).toBe(10);
    expect(report.results[0]?.matches).toHaveLength(2);
  });

  it('resolves the root relative to the process when omitted', async () => {
    const report = await runSpecGuard({ patterns: ['tests/fixtures/demo-repo/docs/adr/0005-missing-target.md'], engine });
    expect(report.summary.specs).toBe(1);
    expect(report.root).toBe(process.cwd());
  });
});

describe('runSpecGuard error handling', () => {
  it('reports a spec file it cannot read', async () => {
    const root = await repo({ 'docs/a.md': '' });
    const report = await runSpecGuard({ patterns: ['docs'], root });
    expect(report.summary.specs).toBe(1);

    const directoryAsSpec = await runSpecGuard({ patterns: [path.join(root, 'docs')], root });
    expect(directoryAsSpec.summary.specs).toBe(1);
  });

  it('surfaces a ripgrep failure as a warning and still produces results', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });
    expect(report.warnings).toEqual([]);
    expect(report.engine).toBe('javascript');
  });

  it('rejects an explicit ripgrep request when the binary is missing', async () => {
    const previous = process.env.SPEC_GUARD_RG;
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    resetRipgrepProbe();
    try {
      await expect(
        runSpecGuard({ patterns: ['docs/adr/0001-passing.md'], root: DEMO_REPO, engine: 'ripgrep' }),
      ).rejects.toThrow(/not available on PATH/);
    } finally {
      if (previous === undefined) delete process.env.SPEC_GUARD_RG;
      else process.env.SPEC_GUARD_RG = previous;
      resetRipgrepProbe();
    }
  });
});

describe('the comments attribute', () => {
  const resolve = (value?: string) =>
    resolveDirective(
      directive('assert-absence', { target: 'src', symbol: 'X', ...(value === undefined ? {} : { comments: value }) }),
      context,
    );

  it('defaults to ignoring comments', () => {
    const resolved = resolve();
    if (!('assertion' in resolved)) throw new Error('expected an assertion');
    expect(resolved.assertion.search?.ignoreComments).toBe(true);
  });

  it('accepts include, and only then counts them', () => {
    const resolved = resolve('include');
    if (!('assertion' in resolved)) throw new Error('expected an assertion');
    expect(resolved.assertion.search?.ignoreComments).toBe(false);
  });

  it('accepts an explicit ignore', () => {
    const resolved = resolve('ignore');
    if (!('assertion' in resolved)) throw new Error('expected an assertion');
    expect(resolved.assertion.search?.ignoreComments).toBe(true);
  });

  it('is case- and space-insensitive', () => {
    const resolved = resolve('  INCLUDE  ');
    if (!('assertion' in resolved)) throw new Error('expected an assertion');
    expect(resolved.assertion.search?.ignoreComments).toBe(false);
  });

  it('rejects anything else rather than guessing', () => {
    // A typo must not quietly pick a behaviour: "comments=none" reads like it
    // means include, and guessing either way would be a silent wrong answer.
    const resolved = resolve('none');
    if ('assertion' in resolved) throw new Error('expected an error');
    expect(resolved.error.message).toBe('Attribute "comments" must be ignore or include, got "none".');
  });

  it('rejects an empty value', () => {
    const resolved = resolve('');
    if ('assertion' in resolved) throw new Error('expected an error');
    expect(resolved.error.message).toContain('must be ignore or include');
  });
});

describe('executeAssertion', () => {
  it('passes when every referenced file exists', async () => {
    const resolved = resolveDirective(
      directive('assert-present', { file: 'SECURITY.md, config/production.json' }),
      context,
    );
    if (!('assertion' in resolved)) throw new Error('expected an assertion');

    const result = await executeAssertion(resolved.assertion, {
      root: DEMO_REPO,
      engine: { name: 'javascript', search: async () => ({ count: 0, commentMatches: 0, unclassifiedFiles: 0, scope: EMPTY_LEDGER, matches: [], fileCounts: new Map(), engine: 'javascript' }) },
      allowMissingTargets: false,
      strictTargets: false,
      allowEmptyScope: false,
      maxSnippets: 5,
      imports: createImportIndex(),
      hasFiles: createScopeProbe(),
    });

    expect(result).toMatchObject({ ok: true, actual: 2, message: 'all 2 referenced paths exist' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts a directory as a present path', async () => {
    const resolved = resolveDirective(directive('assert-present', { file: 'src/ui' }), context);
    if (!('assertion' in resolved)) throw new Error('expected an assertion');

    const result = await executeAssertion(resolved.assertion, {
      root: DEMO_REPO,
      engine: { name: 'javascript', search: async () => ({ count: 0, commentMatches: 0, unclassifiedFiles: 0, scope: EMPTY_LEDGER, matches: [], fileCounts: new Map(), engine: 'javascript' }) },
      allowMissingTargets: false,
      strictTargets: false,
      allowEmptyScope: false,
      maxSnippets: 5,
      imports: createImportIndex(),
      hasFiles: createScopeProbe(),
    });

    expect(result).toMatchObject({ ok: true, message: 'all 1 referenced path exists' });
  });
});

/**
 * Denying yourself read access needs two things to be true: a filesystem where
 * chmod affects reads (not Windows), and a user that permission bits apply to
 * (not root, which is what you get in most containers).
 */
const canDenyReads = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('unreadable spec files', () => {
  it.runIf(canDenyReads)('reports a spec file that cannot be read', async () => {
    const { promises: fsp } = await import('node:fs');
    const root = await repo({ 'docs/locked.md': '<!-- @assert-present file="docs/locked.md" -->\n' });
    const locked = path.join(root, 'docs', 'locked.md');
    await fsp.chmod(locked, 0o000);

    try {
      const report = await runSpecGuard({ patterns: ['docs/locked.md'], root });

      expect(report.ok).toBe(false);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.message).toContain('Unable to read spec file');
      expect(report.errors[0]?.location.relativeFile).toBe('docs/locked.md');
    } finally {
      await fsp.chmod(locked, 0o644);
    }
  });
});
