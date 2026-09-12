/**
 * The reporter's output, written down in full.
 *
 * Two things here were tested only in pieces. The colours: nearly every
 * `paint(..., 'dim')` in the file could have named any colour at all, because
 * the assertions that read the rendered report almost all run with colour off,
 * and the two that do not check a fragment. And the SARIF document: its shape
 * was checked field by field, which pins the fields somebody thought to name
 * and leaves the tool block, the rule descriptions and the empty arrays free.
 *
 * A serialisation format is a contract with a machine that is not in the room.
 * The way to hold one still is to write the whole document down.
 */

import { describe, expect, it } from 'vitest';

import {
  createPainter,
  formatBaselines,
  formatJson,
  formatReport,
  formatSarif,
  shouldUseAscii,
} from '../src/reporter.js';
import { EMPTY_LEDGER } from '../src/scope.js';
import type { RunResult } from '../src/runner.js';

const ESC = String.fromCharCode(27);

type Result = RunResult['results'][number];

const location = (line: number) => ({
  file: 'C:/repo/docs/a.md',
  relativeFile: 'docs/a.md',
  line,
  column: 1,
});

const failing: Result = {
  ok: false,
  kind: 'assert-absence',
  location: location(4),
  description: '"Gone" must not appear in src',
  symbol: 'Gone',
  targets: ['src', 'lib'],
  files: [],
  bounds: { max: 0 },
  actual: 2,
  message: 'expected no matches, found 2',
  matches: [
    { file: 'src/a.ts', line: 7, column: 5, text: '    const Gone = 1;   ', count: 1 },
    { file: 'src/b.ts', line: 2, column: 1, text: 'Gone();', count: 1 },
  ],
  warnings: [],
  commentMatches: 0,
  unclassifiedFiles: 0,
  scope: EMPTY_LEDGER,
  baselinedMatches: 0,
  staleBaseline: [],
  fileMatches: [
    { file: 'src/a.ts', count: 1 },
    { file: 'src/b.ts', count: 1 },
  ],
  engine: 'ripgrep',
  durationMs: 2,
};

function fixture(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: false,
    root: 'C:/repo',
    engine: 'ripgrep',
    durationMs: 12,
    summary: { specs: 1, total: 1, passed: 0, failed: 1, skipped: 0 },
    specFiles: ['docs/a.md'],
    errors: [],
    warnings: [],
    results: [failing],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ colour */

describe('the painter', () => {
  it('is the identity when colour is off', () => {
    const paint = createPainter(false);
    expect(paint('text', 'red', 'bold')).toBe('text');
  });

  it('wraps in every style given, and resets once', () => {
    const paint = createPainter(true);
    expect(paint('text', 'red', 'bold')).toBe(`${ESC}[31m${ESC}[1mtext${ESC}[0m`);
  });

  it('leaves text with no style alone, rather than emitting a bare reset', () => {
    expect(createPainter(true)('text')).toBe('text');
  });
});

describe('a coloured report, exactly', () => {
  it('paints a failure block', () => {
    // Every colour name in the failure block at once. With colour off - which
    // is how nearly every other test reads this output - each of these could
    // have said anything.
    const withReason: RunResult = fixture({
      results: [{ ...failing, reason: 'legacy gateway removed in 3.0', warnings: ['target path not found: lib'] }],
    });

    expect(formatReport(withReason, { color: true, verbose: false })).toBe(
      [
        `${ESC}[1m${ESC}[34mspec-guard${ESC}[0m ${ESC}[2m1 spec · 1 assertion · ripgrep${ESC}[0m`,
        '',
        `${ESC}[31m${ESC}[1m✖${ESC}[0m ${ESC}[1mdocs/a.md:4${ESC}[0m  ${ESC}[35m@assert-absence${ESC}[0m`,
        '    "Gone" must not appear in src',
        `    ${ESC}[31mexpected no matches, found 2${ESC}[0m`,
        `    ${ESC}[2mreason: legacy gateway removed in 3.0${ESC}[0m`,
        `    ${ESC}[33m⚠ target path not found: lib${ESC}[0m`,
        `      ${ESC}[36msrc/a.ts:7:5${ESC}[0m  ${ESC}[90mconst Gone = 1;${ESC}[0m`,
        `      ${ESC}[36msrc/b.ts:2:1${ESC}[0m  ${ESC}[90mGone();${ESC}[0m`,
        '',
        `${ESC}[32m0 passed${ESC}[0m${ESC}[2m · ${ESC}[0m${ESC}[31m${ESC}[1m1 failed${ESC}[0m` +
          `${ESC}[2m · ${ESC}[0m${ESC}[2m12ms${ESC}[0m`,
      ].join('\n'),
    );
  });

  it('paints a passing line and the all-clear', () => {
    const passing: Result = { ...failing, ok: true, actual: 0, matches: [], fileMatches: [] };
    const report = fixture({
      ok: true,
      results: [passing],
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0 },
    });

    expect(formatReport(report, { color: true, verbose: true })).toBe(
      [
        `${ESC}[1m${ESC}[34mspec-guard${ESC}[0m ${ESC}[2m1 spec · 1 assertion · ripgrep${ESC}[0m`,
        '',
        `${ESC}[32m✔${ESC}[0m ${ESC}[2mdocs/a.md:4${ESC}[0m  ${ESC}[2m@assert-absence${ESC}[0m ` +
          `"Gone" ${ESC}[2m(0 matches)${ESC}[0m in src, lib`,
        '',
        `${ESC}[32m1 passed${ESC}[0m${ESC}[2m · ${ESC}[0m${ESC}[2m12ms${ESC}[0m`,
        `${ESC}[32m✔ every spec assertion holds${ESC}[0m`,
      ].join('\n'),
    );
  });

  it('paints an error block, a truncated match list and the notes under a pass', () => {
    // The other half of the palette. Every colour here sits on a path the
    // failure block above does not take: the invalid-directive marker and the
    // raw line it quotes, the "not shown" tail, the note under a passing
    // assertion, and the run-level summary note.
    const passing: Result = {
      ...failing,
      ok: true,
      actual: 0,
      matches: [],
      fileMatches: [],
      commentMatches: 2,
    };
    const report = fixture({
      ok: false,
      results: [passing, { ...failing, actual: 9, matches: [failing.matches[0] as Result['matches'][number]] }],
      summary: { specs: 1, total: 2, passed: 1, failed: 1, skipped: 0 },
      errors: [
        {
          location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 9, column: 1 },
          raw: '<!-- @assert-nothing -->',
          message: 'unknown directive',
        },
      ],
    });
    const output = formatReport(report, { color: true, verbose: true });

    expect(output).toContain(`${ESC}[33m${ESC}[1m⚠${ESC}[0m ${ESC}[1mdocs/a.md:9${ESC}[0m  ${ESC}[33minvalid directive${ESC}[0m`);
    expect(output).toContain(`    ${ESC}[2m<!-- @assert-nothing -->${ESC}[0m`);
    expect(output).toContain(`      ${ESC}[2m… 8 more matches not shown${ESC}[0m`);
    expect(output).toContain(
      `${ESC}[33m⚠${ESC}[0m ${ESC}[33mdocs/a.md:4  2 matches inside comments were not counted; ` +
        `add comments="include" to count them${ESC}[0m`,
    );
    expect(output).toContain(`${ESC}[33m1 invalid${ESC}[0m`);
  });

  it('paints the run-level summary note, which is a different line from the per-result one', () => {
    // Totalled across *passing* assertions and printed once at the end. The
    // per-result note above sits inside a failure block and takes a different
    // code path, so neither one covers the other.
    const passing: Result = {
      ...failing,
      ok: true,
      matches: [],
      fileMatches: [],
      scope: { skipped: [{ path: 'src/a.bin', reason: 'binary', matches: 1 }] },
    };
    const report = fixture({
      ok: true,
      results: [passing],
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0 },
    });

    expect(formatReport(report, { color: true, verbose: false })).toContain(
      `${ESC}[33m⚠${ESC}[0m ${ESC}[33m1 match in 1 binary file not counted: src/a.bin${ESC}[0m`,
    );
  });

  it('paints a note under a failing assertion yellow', () => {
    const report = fixture({
      results: [{ ...failing, scope: { skipped: [{ path: 'src/x.ts', reason: 'unreadable' }] } }],
    });

    expect(formatReport(report, { color: true, verbose: false })).toContain(
      `    ${ESC}[33m⚠ 1 path could not be read: src/x.ts${ESC}[0m`,
    );
  });

  it('paints a skipped count when there is one', () => {
    const report = fixture({
      ok: true,
      results: [],
      summary: { specs: 1, total: 0, passed: 0, failed: 0, skipped: 3 },
    });

    expect(formatReport(report, { color: true, verbose: false })).toContain(`${ESC}[2m3 skipped${ESC}[0m`);
  });
});

describe('the blank line after the list of passes', () => {
  it('separates the passes from what follows', () => {
    const passing: Result = { ...failing, ok: true, matches: [], fileMatches: [] };

    expect(
      formatReport(
        fixture({ ok: true, results: [passing], summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0 } }),
        { color: false, verbose: true },
      ),
    ).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '✔ docs/a.md:4  @assert-absence "Gone" (2 matches) in src, lib',
        '',
        '1 passed · 12ms',
        '✔ every spec assertion holds',
      ].join('\n'),
    );
  });

  it('is absent when there were no passes to separate', () => {
    // Written as the whole document, because the defect this catches is a
    // second blank line - which every `toContain` in the suite is blind to.
    expect(formatReport(fixture(), { color: false, verbose: true })).toBe(
      [
        'spec-guard 1 spec · 1 assertion · ripgrep',
        '',
        '✖ docs/a.md:4  @assert-absence',
        '    "Gone" must not appear in src',
        '    expected no matches, found 2',
        '      src/a.ts:7:5  const Gone = 1;',
        '      src/b.ts:2:1  Gone();',
        '',
        '0 passed · 1 failed · 12ms',
      ].join('\n'),
    );
  });
});

/* ------------------------------------------------------------- ascii glyphs */

describe('shouldUseAscii', () => {
  it('is false anywhere but Windows', () => {
    expect(shouldUseAscii({}, 'linux')).toBe(false);
    expect(shouldUseAscii({}, 'darwin')).toBe(false);
  });

  it('is true on a bare Windows console', () => {
    expect(shouldUseAscii({}, 'win32')).toBe(true);
  });

  it.each(['WT_SESSION', 'TERM', 'TERM_PROGRAM'])('is false when %s says the terminal is modern', (name) => {
    // Three separate signals, each of which has to be read. Two of the three
    // could have been misspelled and every test still passed.
    expect(shouldUseAscii({ [name]: 'something' }, 'win32')).toBe(false);
  });

  it('degrades every glyph, not just the tick', () => {
    const report = fixture({
      results: [{ ...failing, warnings: ['a warning'] }],
      errors: [
        {
          location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 9, column: 1 },
          raw: '<!-- @assert-nothing -->',
          message: 'unknown directive',
        },
      ],
    });
    const ascii = formatReport(report, { color: false, verbose: false, ascii: true });

    expect(ascii).toContain('x docs/a.md:4');
    expect(ascii).toContain('! a warning');
    expect(ascii).toContain('! docs/a.md:9');
    expect(ascii).not.toMatch(/[✔✖⚠…]/);
  });

  it('marks unshown matches with an ascii ellipsis too', () => {
    const many: Result = {
      ...failing,
      actual: 9,
      matches: [failing.matches[0] as Result['matches'][number]],
    };

    expect(formatReport(fixture({ results: [many] }), { color: false, verbose: false, ascii: true })).toContain(
      '... 8 more matches not shown',
    );
  });
});

/* ------------------------------------------------------- what was not looked at */

describe('the scope note', () => {
  it('names up to three unreadable paths, and counts them all', () => {
    const report = fixture({
      results: [
        {
          ...failing,
          scope: {
            skipped: ['a', 'b', 'c', 'd'].map((name) => ({ path: `src/${name}.ts`, reason: 'unreadable' as const })),
          },
        },
      ],
    });

    expect(formatReport(report, { color: false, verbose: false })).toContain(
      '4 paths could not be read: src/a.ts, src/b.ts, src/c.ts',
    );
  });

  it('names one unreadable path in the singular', () => {
    const report = fixture({
      results: [{ ...failing, scope: { skipped: [{ path: 'src/a.ts', reason: 'unreadable' }] } }],
    });

    expect(formatReport(report, { color: false, verbose: false })).toContain(
      '1 path could not be read: src/a.ts',
    );
  });

  it('does not list a binary file among the unreadable ones', () => {
    // Two different reasons, two different sentences. Dropping the filter puts
    // a file that was searched into the list of files that were not.
    const report = fixture({
      results: [
        {
          ...failing,
          scope: {
            skipped: [
              { path: 'src/a.bin', reason: 'binary', matches: 2 },
              { path: 'src/b.ts', reason: 'unreadable' },
            ],
          },
        },
      ],
    });
    const output = formatReport(report, { color: false, verbose: false });

    expect(output).toContain('1 path could not be read: src/b.ts');
    expect(output).toContain('2 matches in 1 binary file not counted: src/a.bin');
  });

  it('marks the passing glyph in ascii too', () => {
    const report = fixture({
      ok: true,
      results: [{ ...failing, ok: true, matches: [], fileMatches: [] }],
      summary: { specs: 1, total: 1, passed: 1, failed: 0, skipped: 0 },
    });
    const ascii = formatReport(report, { color: false, verbose: true, ascii: true });

    expect(ascii).toContain('+ docs/a.md:4');
    expect(ascii).toContain('+ every spec assertion holds');
  });

  it('names up to three binary files, and totals the matches across all of them', () => {
    const report = fixture({
      results: [
        {
          ...failing,
          scope: {
            skipped: ['a', 'b', 'c', 'd'].map((name) => ({
              path: `src/${name}.bin`,
              reason: 'binary' as const,
              matches: 1,
            })),
          },
        },
      ],
    });

    // The whole line, so the sample really stops at three. `toContain` on the
    // first three names passes just as well when all four are listed.
    const line = formatReport(report, { color: false, verbose: false })
      .split('\n')
      .find((text) => text.includes('binary files'));

    expect(line).toBe('    ⚠ 4 matches in 4 binary files not counted: src/a.bin, src/b.bin, src/c.bin');
  });
});

describe('the baseline spelling of a failure', () => {
  it('writes a file that matched once as a bare path, and one that matched more with its count', () => {
    // The count is what makes a baseline a ratchet rather than a mute button:
    // "this file, and no more than this many" only tightens.
    const report = fixture({
      results: [
        {
          ...failing,
          fileMatches: [
            { file: 'src/b.ts', count: 3 },
            { file: 'src/a.ts', count: 1 },
          ],
        },
      ],
    });

    expect(formatBaselines(report)).toBe(
      [
        '# docs/a.md:4  "Gone" must not appear in src',
        'baseline="src/a.ts',
        '          src/b.ts:3"',
      ].join('\n'),
    );
  });

  it('says so plainly when there is nothing to baseline', () => {
    expect(formatBaselines(fixture({ results: [{ ...failing, fileMatches: [] }] }))).toBe(
      '# nothing to baseline: no failing assertion had a match to exempt',
    );
  });
});

/* -------------------------------------------------------------------- json */

describe('the json document', () => {
  it('rounds a duration to three decimal places rather than dividing it', () => {
    const report = fixture({ results: [{ ...failing, durationMs: 1.23456789 }] });
    const parsed = JSON.parse(formatJson(report)) as { results: Array<{ durationMs: number }> };

    expect(parsed.results[0]?.durationMs).toBe(1.235);
  });

  it('leaves a whole number alone', () => {
    const report = fixture({ results: [{ ...failing, durationMs: 7 }] });
    const parsed = JSON.parse(formatJson(report)) as { results: Array<{ durationMs: number }> };

    expect(parsed.results[0]?.durationMs).toBe(7);
  });
});

/* ------------------------------------------------------------------- sarif */

describe('the sarif document, in full', () => {
  it('is exactly this', () => {
    const report = fixture({
      errors: [
        {
          location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 9, column: 3 },
          raw: '<!-- @assert-nothing -->',
          message: 'unknown directive "assert-nothing"',
        },
      ],
    });

    expect(JSON.parse(formatSarif(report, { version: '1.2.3' }))).toEqual({
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'spec-guard',
              informationUri: 'https://github.com/DescentVTT/spec-guard',
              version: '1.2.3',
              rules: [
                {
                  id: 'assert-absence',
                  name: 'assert-absence',
                  shortDescription: { text: 'A symbol that must not appear in a part of the codebase.' },
                },
                {
                  id: 'assert-count',
                  name: 'assert-count',
                  shortDescription: { text: 'A symbol that must appear an exact number of times.' },
                },
                {
                  id: 'assert-present',
                  name: 'assert-present',
                  shortDescription: { text: 'A file or directory the specification says must exist.' },
                },
                {
                  id: 'assert-import-absence',
                  name: 'assert-import-absence',
                  shortDescription: { text: 'A dependency one part of the codebase must not have.' },
                },
                {
                  id: 'assert-import-count',
                  name: 'assert-import-count',
                  shortDescription: { text: 'A dependency count one part of the codebase must hold to.' },
                },
                {
                  id: 'invalid-directive',
                  name: 'invalid-directive',
                  shortDescription: { text: 'A directive that could not be parsed, so nothing was checked.' },
                },
              ],
            },
          },
          results: [
            {
              ruleId: 'assert-absence',
              level: 'error',
              message: { text: '"Gone" must not appear in src: expected no matches, found 2' },
              // The primary location is the offending code, so the annotation
              // lands there; the directive follows the remaining matches.
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/a.ts' },
                    region: { startLine: 7, startColumn: 5 },
                  },
                  // Trimmed: the snippet is a line of source, and its leading
                  // indentation is not part of what the alert is about.
                  message: { text: 'const Gone = 1;' },
                },
              ],
              relatedLocations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/b.ts' },
                    region: { startLine: 2, startColumn: 1 },
                  },
                  message: { text: 'Gone();' },
                },
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'docs/a.md' },
                    region: { startLine: 4, startColumn: 1 },
                  },
                  message: { text: 'the assertion that failed' },
                },
              ],
              partialFingerprints: { specGuardAssertion: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string },
            },
            {
              ruleId: 'invalid-directive',
              level: 'error',
              message: { text: 'unknown directive "assert-nothing"' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'docs/a.md' },
                    region: { startLine: 9, startColumn: 3 },
                  },
                },
              ],
              relatedLocations: [],
              partialFingerprints: { specGuardAssertion: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string },
            },
          ],
        },
      ],
    });
  });

  it('says 0.0.0 when it was not told a version', () => {
    const parsed = JSON.parse(formatSarif(fixture())) as {
      runs: Array<{ tool: { driver: { version: string } } }>;
    };

    expect(parsed.runs[0]?.tool.driver.version).toBe('0.0.0');
  });

  it('gives a fixed assertion a fixed fingerprint, across versions', () => {
    // Pinned deliberately. A code-scanning service treats `partialFingerprints`
    // as the identity of an alert: change how one is derived and every open
    // alert closes and a new one opens in its place, which is a worse outcome
    // than most of the changes that would cause it. Anything that moves these
    // two values is a decision, and this is where it gets made.
    const report = fixture({
      results: [{ ...failing, matches: [], fileMatches: [], description: 'd', message: 'm', actual: 1 }],
      errors: [
        {
          location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 9, column: 1 },
          raw: '<!-- @x -->',
          message: 'unknown directive',
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(report)) as {
      runs: Array<{ results: Array<{ ruleId: string; partialFingerprints: { specGuardAssertion: string } }> }>;
    };

    expect(parsed.runs[0]?.results.map((r) => [r.ruleId, r.partialFingerprints.specGuardAssertion])).toEqual([
      ['assert-absence', '0cb6fa74e5d77b5da7bb402a905cd949'],
      ['invalid-directive', 'fb3833b92384c9998504212683068631'],
    ]);
  });

  it('separates the target list of a fingerprint the same way', () => {
    // `targets.join(',')`, like the file list above: two targets named `a` and
    // `b` must not be the same assertion as one target named `a,b`.
    const withTargets = (targets: string[]): RunResult =>
      fixture({ results: [{ ...failing, targets, matches: [], fileMatches: [] }] });

    expect(fingerprintOf(withTargets(['a', 'b']))).not.toBe(fingerprintOf(withTargets(['ab'])));
  });

  it('separates the parts of a fingerprint, so two spellings of one string differ', () => {
    // Joined without a separator, ["Gone", "src"] and ["Gones", "rc"] hash the
    // same bytes and two unrelated assertions become one alert that opens and
    // closes as either of them changes.
    const one = fingerprintOf(fixture({ results: [{ ...failing, symbol: 'Gone', targets: ['src'] }] }));
    const two = fingerprintOf(fixture({ results: [{ ...failing, symbol: 'Gones', targets: ['rc'] }] }));

    expect(one).not.toBe(two);
  });

  it('separates the file list of an assert-present the same way', () => {
    // `files.join(',')` stands in for the symbol an assert-present does not
    // have. Joined with nothing, two files named `a` and `b` are the same
    // assertion as one file named `ab`.
    const present = (files: string[]): Result => ({
      ...failing,
      kind: 'assert-present',
      symbol: undefined,
      files,
      matches: [],
      fileMatches: [],
    });

    expect(fingerprintOf(fixture({ results: [present(['a', 'b'])] }))).not.toBe(
      fingerprintOf(fixture({ results: [present(['ab'])] })),
    );
  });

  it('gives an assertion and an invalid directive in the same spec different identities', () => {
    const report = fixture({
      errors: [
        {
          location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 9, column: 3 },
          raw: '<!-- @x -->',
          message: 'unknown',
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(report)) as {
      runs: Array<{ results: Array<{ partialFingerprints: { specGuardAssertion: string } }> }>;
    };
    const [first, second] = parsed.runs[0]?.results ?? [];

    expect(first?.partialFingerprints.specGuardAssertion).not.toBe(second?.partialFingerprints.specGuardAssertion);
  });
});

function fingerprintOf(report: RunResult): string {
  const parsed = JSON.parse(formatSarif(report)) as {
    runs: Array<{ results: Array<{ partialFingerprints: { specGuardAssertion: string } }> }>;
  };
  return parsed.runs[0]?.results[0]?.partialFingerprints.specGuardAssertion ?? '';
}
