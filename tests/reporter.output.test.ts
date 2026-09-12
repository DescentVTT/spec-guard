/**
 * Exact-output tests for the reporter.
 *
 * Mutation testing showed the original reporter tests were almost all
 * `toContain` against colourless output, which leaves blank-line placement,
 * colour selection and every "> 0" boundary completely unpinned: a mutant could
 * delete a separator line, drop a colour or turn `remaining > 0` into
 * `remaining >= 0` and no assertion would notice. These lock the rendered
 * output down exactly.
 */

import { describe, expect, it } from 'vitest';

import { formatJson, formatReport } from '../src/reporter.js';
import { EMPTY_LEDGER } from '../src/scope.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { DEMO_REPO } from './helpers.js';

const ESC = String.fromCharCode(27);

type Result = RunResult['results'][number];

const location = (line: number) => ({
  file: 'C:/repo/docs/a.md',
  relativeFile: 'docs/a.md',
  line,
  column: 1,
});

const passingResult: Result = {
  ok: true,
  kind: 'assert-count',
  location: location(3),
  description: '"Kept" must appear exactly 2 times in src',
  symbol: 'Kept',
  targets: ['src'],
  files: [],
  bounds: { min: 2, max: 2 },
  actual: 2,
  message: 'expected exactly 2 matches, found 2',
  matches: [],
  warnings: [],
  commentMatches: 0,
  unclassifiedFiles: 0,
  scope: EMPTY_LEDGER,
  baselinedMatches: 0,
  staleBaseline: [],
  fileMatches: [],
  engine: 'ripgrep',
  durationMs: 1,
};

const failingResult: Result = {
  ok: false,
  kind: 'assert-absence',
  location: location(4),
  description: '"Gone" must not appear in src',
  symbol: 'Gone',
  targets: ['src'],
  files: [],
  bounds: { max: 0 },
  actual: 3,
  message: 'expected no matches, found 3',
  matches: [{ file: 'src/a.ts', line: 7, column: 5, text: '    const Gone = 1;', count: 1 }],
  warnings: [],
  commentMatches: 0,
  unclassifiedFiles: 0,
  scope: EMPTY_LEDGER,
  baselinedMatches: 0,
  staleBaseline: [],
  fileMatches: [],
  engine: 'ripgrep',
  durationMs: 2,
};

function fixture(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: false,
    root: 'C:/repo',
    engine: 'ripgrep',
    durationMs: 12,
    summary: { specs: 1, total: 2, passed: 1, failed: 1, skipped: 0, inactive: 0 },
    specFiles: ['docs/a.md'],
    errors: [],
    warnings: [],
    inactiveSpecs: [],
    results: [passingResult, failingResult],
    ...overrides,
  };
}

function onlyFailure(overrides: Partial<Result> = {}): RunResult {
  return fixture({
    results: [{ ...failingResult, ...overrides }],
    summary: { specs: 1, total: 1, passed: 0, failed: 1, skipped: 0, inactive: 0 },
  });
}

describe('exact rendered output', () => {
  it('renders a failure report exactly, blank lines included', () => {
    expect(formatReport(fixture(), { color: false, verbose: false })).toBe(
      [
        'spec-guard 1 spec · 2 assertions · ripgrep',
        '',
        '✖ docs/a.md:4  @assert-absence',
        '    "Gone" must not appear in src',
        '    expected no matches, found 3',
        '      src/a.ts:7:5  const Gone = 1;',
        '      … 2 more matches not shown',
        '',
        '1 passed · 1 failed · 12ms',
      ].join('\n'),
    );
  });

  it('renders a verbose passing report exactly', () => {
    const passing = fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [passingResult],
    });

    expect(formatReport(passing, { color: false, verbose: true })).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '✔ docs/a.md:3  @assert-count "Kept" (2 matches) in src',
        '',
        '1 passed · 12ms',
        '✔ every spec assertion holds',
      ].join('\n'),
    );
  });

  it('renders an assert-present pass by listing its files', () => {
    const present = fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [
        {
          ...passingResult,
          kind: 'assert-present',
          symbol: undefined,
          targets: [],
          files: ['SECURITY.md', 'LICENSE'],
          engine: undefined,
        },
      ],
    });

    const output = formatReport(present, { color: false, verbose: true });
    expect(output).toContain('✔ docs/a.md:3  @assert-present SECURITY.md, LICENSE');
    // No search ran, so the engine label is meaningless and must be omitted.
    expect(output).toContain('spec-guard 1 spec · 1 assertion\n');
    expect(output).not.toContain('ripgrep');
  });

  it('omits the invalid and skipped segments when their counts are zero', () => {
    const output = formatReport(fixture(), { color: false, verbose: false });
    expect(output).not.toContain('invalid');
    expect(output).not.toContain('skipped');
    expect(output.endsWith('12ms')).toBe(true);
  });

  it('shows the skipped count when fail-fast stopped the run', () => {
    const stopped = fixture({ summary: { specs: 1, total: 2, passed: 1, failed: 1, skipped: 4, inactive: 0 } });
    expect(formatReport(stopped, { color: false, verbose: false })).toContain('4 skipped');
  });

  it('lists only passing assertions in the pass section', () => {
    const output = formatReport(fixture(), { color: false, verbose: true });
    expect(output).toContain('✔ docs/a.md:3');
    expect(output).not.toContain('✔ docs/a.md:4');
  });

  it('does not print a "more matches" line when every match is shown', () => {
    expect(formatReport(onlyFailure({ actual: 1 }), { color: false, verbose: false })).not.toContain('not shown');
  });

  it('counts hidden matches across multi-match lines', () => {
    const output = formatReport(
      onlyFailure({
        actual: 9,
        matches: [{ file: 'src/a.ts', line: 7, column: 5, text: 'const Gone = 1;', count: 4 }],
      }),
      { color: false, verbose: false },
    );

    expect(output).toContain('… 5 more matches not shown');
  });

  it('uses the singular form for a single hidden match', () => {
    expect(formatReport(onlyFailure({ actual: 2 }), { color: false, verbose: false })).toContain(
      '… 1 more match not shown',
    );
  });

  it('trims leading whitespace from snippets', () => {
    const output = formatReport(fixture(), { color: false, verbose: false });
    // The snippet's own four spaces of source indentation must be gone; only
    // the reporter's two-space separator remains.
    expect(output).toContain('      src/a.ts:7:5  const Gone = 1;');
    expect(output).not.toContain('src/a.ts:7:5      const Gone');
  });

  it('paints each part of a failure with its own colour', () => {
    const output = formatReport(fixture(), { color: true, verbose: false });

    expect(output).toContain(`${ESC}[31m${ESC}[1m✖${ESC}[0m`);
    expect(output).toContain(`${ESC}[35m@assert-absence${ESC}[0m`);
    expect(output).toContain(`${ESC}[31mexpected no matches, found 3${ESC}[0m`);
    expect(output).toContain(`${ESC}[36msrc/a.ts:7:5${ESC}[0m`);
    expect(output).toContain(`${ESC}[31m${ESC}[1m1 failed${ESC}[0m`);
  });

  it('paints the pass marker green and the headline bold blue', () => {
    const passing = fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [passingResult],
    });
    const output = formatReport(passing, { color: true, verbose: true });

    expect(output).toContain(`${ESC}[1m${ESC}[34mspec-guard${ESC}[0m`);
    expect(output).toContain(`${ESC}[32m✔${ESC}[0m`);
    expect(output).toContain(`${ESC}[32m1 passed${ESC}[0m`);
  });

  it('separates summary segments with a dim middot', () => {
    expect(formatReport(fixture(), { color: true, verbose: false })).toContain(`${ESC}[2m · ${ESC}[0m`);
  });

  it('switches every glyph to ASCII together', () => {
    const output = formatReport(fixture(), { color: false, verbose: false, ascii: true });

    expect(output).toContain('x docs/a.md:4');
    expect(output).toContain('... 2 more matches not shown');
    for (const glyph of ['✖', '✔', '⚠', '…']) expect(output).not.toContain(glyph);
  });

  it('renders warnings on a failing assertion', () => {
    const warned = onlyFailure({ warnings: ['target path not found: src/gone'] });
    expect(formatReport(warned, { color: false, verbose: false })).toContain(
      '    ⚠ target path not found: src/gone',
    );
  });

  it('renders run-level warnings above the failures, once', () => {
    const warned = fixture({ warnings: ['ripgrep failed, fell back'] });
    const output = formatReport(warned, { color: false, verbose: false });
    const lines = output.split('\n');

    expect(lines.filter((line) => line.includes('ripgrep failed, fell back'))).toHaveLength(1);
    expect(lines.indexOf('⚠ ripgrep failed, fell back')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('✖')),
    );
  });

  it('renders the reason line only when a reason exists', () => {
    expect(formatReport(onlyFailure({ reason: 'retired in ADR-7' }), { color: false, verbose: false })).toContain(
      '    reason: retired in ADR-7',
    );
    expect(formatReport(fixture(), { color: false, verbose: false })).not.toContain('reason:');
  });

  it('prints the invalid count and the raw directive for errors', () => {
    const invalid = fixture({
      errors: [{ location: location(9), raw: '<!-- @assert-count bad -->', message: 'Unknown attribute "bad".' }],
    });
    const output = formatReport(invalid, { color: false, verbose: false });

    expect(output).toContain('⚠ docs/a.md:9  invalid directive');
    expect(output).toContain('    Unknown attribute "bad".');
    expect(output).toContain('    <!-- @assert-count bad -->');
    expect(output).toContain('1 invalid');
  });

  it('shows only the first line of a multi-line raw directive', () => {
    const invalid = fixture({
      errors: [{ location: location(9), raw: '<!--\n  @assert-count bad\n-->', message: 'Unknown attribute.' }],
    });
    const output = formatReport(invalid, { color: false, verbose: false });

    expect(output).toContain('    <!--');
    expect(output).not.toContain('  @assert-count bad');
  });

  it('omits the raw line when the error has none', () => {
    const invalid = fixture({
      errors: [{ location: location(9), raw: '', message: 'Unable to read spec file.' }],
    });
    const lines = formatReport(invalid, { color: false, verbose: false }).split('\n');
    const index = lines.findIndex((line) => line.includes('Unable to read spec file.'));

    expect(index).toBeGreaterThan(-1);
    expect(lines[index + 1]).toBe('');
  });

  it.each([
    [0, '0ms'],
    [999, '999ms'],
    [999.6, '1000ms'],
    [1000, '1.00s'],
    [1500, '1.50s'],
    [65_000, '65.00s'],
  ])('formats %sms as %s', (durationMs, expected) => {
    expect(formatReport(fixture({ durationMs }), { color: false, verbose: false }).endsWith(expected)).toBe(true);
  });
});

describe('formatJson rounding', () => {
  it('rounds durations to three decimals rather than scaling them', async () => {
    const result = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });
    const parsed = JSON.parse(formatJson({ ...result, durationMs: 12.3456789 }));

    expect(parsed.durationMs).toBe(12.346);
    expect(parsed.results[0].durationMs).toBeLessThan(1000);
    expect(parsed.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Comment exclusion is the one thing that can turn a red run green without a
 * line of code changing, so the report has to say it happened - and say it in
 * the default output, not behind --verbose, which nobody passes on a green run.
 */
describe('comment exclusion notes', () => {
  const passedByExclusion = (commentMatches: number, unclassifiedFiles = 0): RunResult =>
    fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [{ ...passingResult, commentMatches, unclassifiedFiles }],
    });

  it('states on a passing run that comment matches were dropped', () => {
    expect(formatReport(passedByExclusion(1), { color: false, verbose: false })).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '⚠ 1 match inside comments was not counted; add comments="include" to count it',
        '',
        '1 passed · 12ms',
        '✔ every spec assertion holds',
      ].join('\n'),
    );
  });

  it('pluralises the note', () => {
    expect(formatReport(passedByExclusion(3), { color: false, verbose: false })).toContain(
      '⚠ 3 matches inside comments were not counted; add comments="include" to count them',
    );
  });

  it('says when a language could not be read, which pushes the other way', () => {
    const report = formatReport(passedByExclusion(0, 2), { color: false, verbose: false });
    expect(report).toContain('⚠ comment syntax unknown for 2 matching files; comments in them counted as code');
    expect(report).not.toContain('inside comments');
  });

  it('stays quiet when nothing was excluded', () => {
    expect(formatReport(passedByExclusion(0), { color: false, verbose: false })).not.toContain('⚠');
  });

  it('attaches the note to a failure instead of repeating it at the end', () => {
    const report = formatReport(onlyFailure({ commentMatches: 2 }), { color: false, verbose: false });

    // Indented under the failure it belongs to...
    expect(report).toContain('    ⚠ 2 matches inside comments were not counted');
    // ...and not again as a run-level line, which covers passes only.
    expect(report.split('\n').filter((line) => line.startsWith('⚠'))).toEqual([]);
  });

  it('totals the note across passing assertions only', () => {
    const report = formatReport(
      fixture({
        results: [
          { ...passingResult, commentMatches: 2 },
          { ...failingResult, commentMatches: 7 },
        ],
      }),
      { color: false, verbose: false },
    );

    expect(report).toContain('⚠ 2 matches inside comments were not counted');
    expect(report).not.toContain('9 matches');
  });

  it('names a single unreadable file in the singular', () => {
    const report = formatReport(passedByExclusion(0, 1), { color: false, verbose: false });
    expect(report).toContain('comment syntax unknown for 1 matching file; comments in it counted as code');
  });

  it('lists the notes per assertion under --verbose, location and all', () => {
    // The verbose branch had no test at all: every mutant that emptied it
    // survived, which means the whole block could have been deleted unnoticed.
    const report = fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [{ ...passingResult, commentMatches: 2, warnings: ['target path not found: src/gone'] }],
    });

    expect(formatReport(report, { color: false, verbose: true })).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '✔ docs/a.md:3  @assert-count "Kept" (2 matches) in src',
        '',
        '⚠ docs/a.md:3  2 matches inside comments were not counted; add comments="include" to count them',
        '⚠ docs/a.md:3  target path not found: src/gone',
        '⚠ 2 matches inside comments were not counted; add comments="include" to count them',
        '',
        '1 passed · 12ms',
        '✔ every spec assertion holds',
      ].join('\n'),
    );
  });

  it('separates run-level warnings from what follows', () => {
    const report = fixture({
      ok: true,
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0, inactive: 0 },
      results: [passingResult],
      warnings: ['ripgrep failed, falling back to the scanner'],
    });

    expect(formatReport(report, { color: false, verbose: false })).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '⚠ ripgrep failed, falling back to the scanner',
        '',
        '1 passed · 12ms',
        '✔ every spec assertion holds',
      ].join('\n'),
    );
  });

  it('carries the counts into JSON', () => {
    const parsed = JSON.parse(formatJson(passedByExclusion(4, 1)));

    expect(parsed.results[0].commentMatches).toBe(4);
    expect(parsed.results[0].unclassifiedFiles).toBe(1);
  });
});

/**
 * The skipped-file notes.
 *
 * This is the output that decides whether a green run can be trusted, and the
 * first mutation run after it was written found twenty-six mutants in it that
 * no test executed at all: every reporter fixture carried an empty ledger, so
 * the prose that explains a skip had never been rendered once.
 */
describe('what was not inspected', () => {
  const withLedger = (skipped: RunResult['results'][number]['scope']['skipped'], ok = true): RunResult =>
    fixture({
      ok,
      summary: { specs: 1, total: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0, inactive: 0 },
      results: [{ ...(ok ? passingResult : failingResult), scope: { skipped } }],
    });

  it('names a file it could not read', () => {
    const report = formatReport(withLedger([{ path: 'src/locked.ts', reason: 'unreadable' }]), {
      color: false,
      verbose: false,
    });

    expect(report).toContain('⚠ 1 path could not be read: src/locked.ts');
  });

  it('pluralises, and lists only the first few', () => {
    const report = formatReport(
      withLedger([
        { path: 'a.ts', reason: 'unreadable' },
        { path: 'b.ts', reason: 'unreadable' },
        { path: 'c.ts', reason: 'unreadable' },
        { path: 'd.ts', reason: 'unreadable' },
      ]),
      { color: false, verbose: false },
    );

    // The count is the whole truth; the sample is three, so one line stays one line.
    expect(report).toContain('⚠ 4 paths could not be read: a.ts, b.ts, c.ts');
    expect(report).not.toContain('d.ts');
  });

  it('reports the matches hiding in a binary file, not just the file', () => {
    const report = formatReport(withLedger([{ path: 'build/app.bin', reason: 'binary', matches: 3 }]), {
      color: false,
      verbose: false,
    });

    expect(report).toContain('⚠ 3 matches in 1 binary file not counted: build/app.bin');
  });

  it('totals the matches across several binary files', () => {
    const report = formatReport(
      withLedger([
        { path: 'a.bin', reason: 'binary', matches: 2 },
        { path: 'b.bin', reason: 'binary', matches: 1 },
      ]),
      { color: false, verbose: false },
    );

    expect(report).toContain('⚠ 3 matches in 2 binary files not counted: a.bin, b.bin');
  });

  it('says both things when both happened', () => {
    const report = formatReport(
      withLedger([
        { path: 'locked.ts', reason: 'unreadable' },
        { path: 'app.bin', reason: 'binary', matches: 1 },
      ]),
      { color: false, verbose: false },
    );

    expect(report).toContain('could not be read: locked.ts');
    expect(report).toContain('1 match in 1 binary file not counted: app.bin');
  });

  it('stays quiet when nothing was skipped', () => {
    expect(formatReport(withLedger([]), { color: false, verbose: false })).not.toContain('⚠');
  });

  it('attaches the note to the failure it belongs to', () => {
    const report = formatReport(withLedger([{ path: 'app.bin', reason: 'binary', matches: 1 }], false), {
      color: false,
      verbose: false,
    });

    expect(report).toContain('    ⚠ 1 match in 1 binary file not counted: app.bin');
  });

  it('carries the ledger into JSON', () => {
    const parsed = JSON.parse(formatJson(withLedger([{ path: 'a.bin', reason: 'binary', matches: 2 }])));
    expect(parsed.results[0].skipped).toEqual([{ path: 'a.bin', reason: 'binary', matches: 2 }]);
  });
});
