/**
 * A report asked for in ASCII is ASCII.
 *
 * On 0.24.0 `--ascii` drew a report's four marks in ASCII and left two
 * characters of the report's own beyond it: the `·` between the counts of a
 * line, in a run's, a proof's, a citation check's and a watch session's, and
 * the `…` that ends a snippet whose line was cut. Both are drawn in ASCII
 * now, `-` and `...`, wherever the marks are (ADR-0014, amended 2026-10-12).
 *
 * What a project wrote is not the report's to redraw: a line that ends in an
 * ellipsis of its own, and fits, is written as it is.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILED, main, type CliIO } from '../src/cli.js';
import { truncate } from '../src/engine.js';
import { formatReport } from '../src/reporter.js';
import { EMPTY_LEDGER } from '../src/scope.js';
import type { RunResult } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

type Result = RunResult['results'][number];
type Match = Result['matches'][number];

const ASCII = { color: false, verbose: false, ascii: true };
const MARKS = { color: false, verbose: false, ascii: false };

/** A run with one failing rule, whose matches are the ones given. */
function failing(matches: Match[], kind: Result['kind'] = 'assert-absence'): RunResult {
  const result: Result = {
    ok: false,
    kind,
    location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 4, column: 1 },
    description: '"Gone" must not appear in src',
    symbol: 'Gone',
    targets: ['src'],
    files: [],
    bounds: { max: 0 },
    actual: matches.length,
    message: `expected no matches, found ${matches.length}`,
    matches,
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
  return {
    ok: false,
    root: 'C:/repo',
    engine: 'ripgrep',
    durationMs: 12,
    summary: { specs: 1, total: 1, passed: 0, failed: 1, skipped: 0, inactive: 0 },
    specFiles: ['docs/a.md'],
    errors: [],
    warnings: [],
    inactiveSpecs: [],
    exclude: [],
    results: [result],
  };
}

const at = (text: string): Match => ({ file: 'src/a.ts', line: 7, column: 5, text, count: 1 });

/** The one snippet line of a report with one match. */
const snippet = (report: RunResult, options: typeof ASCII): string => formatReport(report, options).split('\n')[5] as string;

describe('what separates the counts of a line', () => {
  it('is - in a report asked for in ASCII, and · in one that draws the marks', () => {
    const report = failing([at('const Gone = 1;')]);
    const drawn = (options: typeof ASCII): string[] => {
      const lines = formatReport(report, options).split('\n');
      return [lines[0] as string, lines.at(-1) as string];
    };
    expect(drawn(ASCII)).toEqual(['spec-guard 1 spec - 1 assertion - ripgrep', '0 passed - 1 failed - 12ms']);
    expect(drawn(MARKS)).toEqual(['spec-guard 1 spec · 1 assertion · ripgrep', '0 passed · 1 failed · 12ms']);
    // Left out, as a caller of the package leaves it out, it is the marks' way.
    expect(drawn({ color: false, verbose: false } as typeof ASCII)).toEqual(drawn(MARKS));
  });
});

describe('a snippet whose line was cut', () => {
  // Four spaces of indentation count towards the length a line is cut at, and
  // the report takes them off afterwards.
  const cut = truncate(`    ${'x'.repeat(400)}`);
  const shown = 'x'.repeat(196);

  it('ends in three dots in a report asked for in ASCII, and in the mark otherwise', () => {
    expect(cut).toBe(`    ${shown}…`);
    expect(snippet(failing([at(cut)]), ASCII)).toBe(`      src/a.ts:7:5  ${shown}...`);
    expect(snippet(failing([at(cut)]), MARKS)).toBe(`      src/a.ts:7:5  ${shown}…`);
  });

  it('leaves a line that ends in an ellipsis of its own, and fits, as the project wrote it', () => {
    const written = 'const more = "and so on…";';
    const exact = `${'y'.repeat(199)}…`;
    for (const text of [written, 'and so on…', exact]) {
      expect(truncate(text)).toBe(text);
      expect(snippet(failing([at(text)]), ASCII)).toBe(`      src/a.ts:7:5  ${text}`);
      expect(snippet(failing([at(text)]), MARKS)).toBe(`      src/a.ts:7:5  ${text}`);
    }
  });

  it('leaves what is no line of a file as it ends, at the length a cut line has', () => {
    // An import rule's match is written by the runner, at any length.
    const imported = `imports ${'m'.repeat(193)}`;
    expect(imported).toHaveLength(cut.length);
    expect(snippet(failing([at(imported)], 'assert-import-absence'), ASCII)).toBe(`      src/a.ts:7:5  ${imported}`);
    // And one that ends in the mark is still no cut line when it is longer than one.
    const chain = `${'c'.repeat(201)}…`;
    expect(snippet(failing([at(chain)], 'assert-import-cycle'), ASCII)).toBe(`      src/a.ts:7:5  ${chain}`);
  });
});

describe('each report a person reads, asked for in ASCII', () => {
  const LONG = `export const long = '${'a'.repeat(120)} Needle ${'b'.repeat(120)}';`;
  // ASCII throughout, so a character beyond it in a report is the report's own.
  const FILES = {
    'docs/adr/0001-live.md': [
      '# ADR-0001: Live',
      '',
      '<!-- @assert-absence target="src" symbol="Absent" -->',
      '<!-- @assert-absence target="src" symbol="Needle" reason="it was removed" -->',
      '<!-- @assert-count target="src" symbol="x" -->',
      '',
    ].join('\n'),
    'docs/adr/0002-old.md': '# ADR-0002: Old\n\n**Status:** superseded by ADR-0001\n\n<!-- @assert-absence target="src" symbol="Gone" -->\n',
    'src/a.ts': ['// see ADR-0002 and ADR-0099', 'export const Needle = 1;', LONG, 'export const again = Needle;', ''].join('\n'),
  };

  async function written(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const root = await makeTempRepo(FILES);
    temporary.push(root);
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => out.push(`stderr: ${text}`), env: { NO_COLOR: '1', ...env }, cwd: root, isTTY: false };
    expect(await main([...argv, '--root', root, '--spec', 'docs/adr/*.md'], io)).toBe(EXIT_FAILED);
    return out.join('\n').replace(/\d+(?:\.\d+)?m?s$/gm, 'Nms');
  }

  const TERMINAL = { WT_SESSION: '1' };
  const beyondAscii = (text: string): string[] => [...new Set([...text].filter((character) => (character.codePointAt(0) as number) > 127))];
  const ends = (text: string): string[] => [text.split('\n')[0] as string, ...text.split('\n').filter((line) => line.endsWith('Nms'))];

  const REPORTS: Array<[string, string[], string[]]> = [
    ['a run', ['--engine', 'js', '--verbose', '--max-snippets', '2'], ['spec-guard 2 specs - 2 assertions - javascript', '1 passed - 1 failed - 1 invalid - 1 not in force - Nms']],
    ['prove', ['prove', '--verbose'], ['spec-guard prove 2 specs - 2 rules', '1 seen to fail - 1 unprovable - 1 invalid - 1 not in force - Nms']],
    ['cites', ['cites'], ['spec-guard cites ADR-{n} (2 documents matching docs/adr/{n}*.md, read off the specs\' titles)', '2 citations in 1 file - 1 ghost - 1 stale - Nms']],
  ];

  it.each(REPORTS)('%s holds no character beyond ASCII, and - between its counts', async (_name, argv, lines) => {
    const asked = await written([...argv, '--ascii'], TERMINAL);
    expect(beyondAscii(asked)).toEqual([]);
    expect(ends(asked)).toEqual(lines);
    // The variable asks for the same report as the option.
    expect(await written(argv, { ...TERMINAL, SPEC_GUARD_ASCII: '1' })).toBe(asked);
  });

  it.each(REPORTS)('%s draws · there where the marks are drawn, and is the same report otherwise', async (_name, argv, lines) => {
    const marked = await written([...argv, '--no-ascii'], {});
    expect(ends(marked)).toEqual(lines.map((line) => line.replaceAll(' - ', ' · ')));
    const plain = (text: string): string =>
      text
        .replace(/^( *)[✔+] /gm, '$1P ')
        .replace(/^( *)[✖x] /gm, '$1F ')
        .replace(/^( *)[⚠!] /gm, '$1W ')
        .replace(/^( *)[○o] /gm, '$1S ')
        .replace(/…|\.\.\./g, 'M')
        .replace(/ [·-] /g, ' B ');
    expect(plain(await written([...argv, '--ascii'], {}))).toBe(plain(marked));
  });

  it('cuts a long line of a run with three dots, and counts what it does not show the same way', async () => {
    const asked = await written(['--engine', 'js', '--max-snippets', '2', '--ascii'], TERMINAL);
    expect(asked).toContain(`\n      src/a.ts:3:143  ${LONG.slice(0, 200)}...\n      ... 1 more match not shown\n`);
    const marked = await written(['--engine', 'js', '--max-snippets', '2'], TERMINAL);
    expect(marked).toContain(`\n      src/a.ts:3:143  ${LONG.slice(0, 200)}…\n      … 1 more match not shown\n`);
  });
});
