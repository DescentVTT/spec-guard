/**
 * `^` and `$` read a line, with either engine. ADR-0007, amended 2026-10-19.
 *
 * A regex rule was matched against a file's whole text with no `m`, so `^`
 * and `$` met only the file's two ends, under the scanner and under ripgrep
 * alike, since ripgrep only names the files the scanner counts in: a rule
 * against `uses:` at the start of a line passed over a workflow that held one
 * on its fourth. JavaScript's `m` alone reads three lines ripgrep does not,
 * so the line is the one ripgrep reads with `--crlf`, and ripgrep is asked
 * with `--multiline` as well, since the scanner's matches may cross a line
 * end: the list ripgrep gives the scanner may hold more files than the
 * scanner counts in, never fewer.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { buildJsRegExp, scanContent } from '../src/engine.js';
import { runSpecGuard } from '../src/runner.js';
import type { SearchOptions } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** What a regex rule over one file's text counts, and on which lines. */
function read(symbol: string, content: string, options: Partial<SearchOptions> = {}): { count: number; lines: number[] } {
  const result = scanContent(content, 'a.txt', buildJsRegExp(symbol, searchOptions({ regex: true, ...options })));
  return { count: result.count, lines: result.locations.map((location) => location.line) };
}

describe('a line, as the scanner reads one', () => {
  it('starts after LF, after CRLF and after a lone CR, on the first line and on a middle one', () => {
    expect(read('^uses:', 'uses: a\nname\nuses: b\n')).toEqual({ count: 2, lines: [1, 3] });
    expect(read('^uses:', 'uses: a\r\nname\r\nuses: b\r\n')).toEqual({ count: 2, lines: [1, 3] });
    // Lines are numbered at LF, here as in every report, so a file of lone
    // CRs is one numbered line that holds three.
    expect(read('^uses:', 'uses: a\rname\ruses: b\r')).toEqual({ count: 2, lines: [1] });
    expect(read('^uses:', 'name: uses: a\n')).toEqual({ count: 0, lines: [] });
  });

  it('ends before LF, before CRLF and before a lone CR', () => {
    expect(read('a$', 'xa\nbx\nya')).toEqual({ count: 2, lines: [1, 3] });
    expect(read('a$', 'xa\r\nbx\r\n')).toEqual({ count: 1, lines: [1] });
    expect(read('a$', 'xa\rbx\r')).toEqual({ count: 1, lines: [1] });
    expect(read('a$', 'xab\n')).toEqual({ count: 0, lines: [] });
  });

  it('meets each line once: none between the CR and the LF of a CRLF, and none after the last line end', () => {
    expect(read('^', 'a\nb\nc\n')).toEqual({ count: 3, lines: [1, 2, 3] });
    expect(read('^', 'a\r\nb\r\nc\r\n')).toEqual({ count: 3, lines: [1, 2, 3] });
    expect(read('^', 'a\rb\rc\r')).toEqual({ count: 3, lines: [1] });
    expect(read('^', 'a\nb')).toEqual({ count: 2, lines: [1, 2] });
    expect(read('$', 'a\r\nb\r\n')).toEqual({ count: 2, lines: [1, 2] });
    expect(read('$', 'a\nb')).toEqual({ count: 2, lines: [1, 2] });
    // An empty line is a line; the text after the last line end is not one.
    expect(read('^$', 'a\n\nb\n')).toEqual({ count: 1, lines: [2] });
    expect(read('^$', 'a\r\n\r\nb\r\n')).toEqual({ count: 1, lines: [2] });
    expect(read('^$', '\n')).toEqual({ count: 1, lines: [1] });
    expect(read('^$', 'a\nb\n')).toEqual({ count: 0, lines: [] });
    expect(read('^$', '')).toEqual({ count: 0, lines: [] });
  });

  it('takes a line end for no trailing blank', () => {
    expect(read('\\s+$', 'a\nb\n')).toEqual({ count: 0, lines: [] });
    expect(read('\\s+$', 'a\r\nb\r\n')).toEqual({ count: 0, lines: [] });
    expect(read('\\s+$', 'a\rb\r')).toEqual({ count: 0, lines: [] });
    expect(read('\\s+$', 'a  \r\nb\r\n')).toEqual({ count: 1, lines: [1] });
    expect(read('\\s+$', 'a\nb \n')).toEqual({ count: 1, lines: [2] });
  });

  it('does not end at U+2028 or U+2029, as ripgrep does not', () => {
    expect(read('^b', `a${LS}b\n`)).toEqual({ count: 0, lines: [] });
    expect(read('^b', `a${PS}b\n`)).toEqual({ count: 0, lines: [] });
    expect(read('a$', `a${LS}b\n`)).toEqual({ count: 0, lines: [] });
    expect(read('a$', `a${PS}b\n`)).toEqual({ count: 0, lines: [] });
    expect(read('b$', `a${LS}b\n`)).toEqual({ count: 1, lines: [1] });
    expect(read('^a', `a${PS}b\n`)).toEqual({ count: 1, lines: [1] });
  });

  it('keeps `.` from a line end, as JavaScript does', () => {
    for (const end of ['\n', '\r\n', '\r', LS, PS]) {
      expect(read('a.b', `xa${end}bx\n`), JSON.stringify(end)).toEqual({ count: 0, lines: [] });
    }
    expect(read('a.b', 'xa-bx\n')).toEqual({ count: 1, lines: [1] });
  });

  it('reads a line with ignore-case and with word', () => {
    expect(read('^USES:', 'x\r\nuses: a\r\n', { ignoreCase: true })).toEqual({ count: 1, lines: [2] });
    expect(read('^USES:', 'x\r\nuses: a\r\n')).toEqual({ count: 0, lines: [] });
    expect(read('^uses', 'x\nuses: a\nusesb\n', { word: true })).toEqual({ count: 1, lines: [2] });
  });
});

describe('what is no anchor', () => {
  it('leaves an escaped ^ or $ the character it names', () => {
    expect(read('a\\$', 'a$b\na\n')).toEqual({ count: 1, lines: [1] });
    expect(read('\\^a', 'b^a\na\n')).toEqual({ count: 1, lines: [1] });
  });

  it('reads an anchor after an escaped backslash', () => {
    expect(read('\\\\$', 'a\\\nb\\c\n')).toEqual({ count: 1, lines: [1] });
  });

  it('leaves a character class whole, its ^ and its $ included', () => {
    expect(read('[$^]', 'a$b^c\n')).toEqual({ count: 2, lines: [1] });
    expect(read('[^a]$', 'ab\nba\n')).toEqual({ count: 1, lines: [1] });
    // JavaScript ends a class at its first unescaped ], straight after the
    // [ too: [^] is any character, and the $ after it an anchor.
    expect(read('[^]$', 'ab\ncd\n')).toEqual({ count: 2, lines: [1, 2] });
    expect(read('[\\]$]x', 'a$x\n]x\n')).toEqual({ count: 2, lines: [1, 2] });
    // An escaped space in a class is the class's too, and the $ beside it.
    expect(read('[\\ $]x', 'a x\nb$x\nc\n')).toEqual({ count: 2, lines: [1, 2] });
  });

  it('leaves a group name and a reference to it, which may hold a $', () => {
    expect(read('(?<$a>x)\\k<$a>$', 'xx\nxxy\n')).toEqual({ count: 1, lines: [1] });
  });

  it('reads an anchor inside a look-behind, which is no group name however a > follows', () => {
    expect(read('(?<=^)a', 'ba\na\n')).toEqual({ count: 1, lines: [2] });
    expect(read('(?<=^)a>', `b${LS}a>\na>\n`)).toEqual({ count: 1, lines: [2] });
    expect(read('(?<!^)a>', `b${LS}a>\na>\n`)).toEqual({ count: 1, lines: [1] });
  });

  it('reads an anchor inside the word boundaries a word rule puts round it', () => {
    expect(read('^b', `a${LS}b\nb\n`, { word: true })).toEqual({ count: 1, lines: [2] });
  });
});

const rgPath = findTestRipgrep();

describe.skipIf(!rgPath)('one set of anchored rules, through both engines', () => {
  const RULES: Array<{ directive: string; places: string[]; count: number }> = [
    { directive: 'symbol="^\\s*-?\\s*uses:"', places: ['data/cr.yml:1', 'data/crlf.yml:2', 'data/first.yml:1', 'data/lf.yml:2'], count: 4 },
    { directive: 'symbol="uses: .$"', places: ['data/cr.yml:1', 'data/crlf.yml:2', 'data/first.yml:1', 'data/lf.yml:2', 'data/separator.txt:1'], count: 5 },
    { directive: 'symbol="^\\s*-\\s*USES:" ignore-case="true"', places: ['data/cr.yml:1', 'data/crlf.yml:2', 'data/lf.yml:2'], count: 3 },
    { directive: 'symbol="^$"', places: ['data/blank.txt:2'], count: 1 },
    // A match may cross a line end, and \s matches one: the LF before an
    // empty line is a blank at the end of its line. [ \t]+$ reads only the
    // blanks a line ends with.
    { directive: 'symbol="\\s+$"', places: ['data/blank.txt:1', 'data/trailing.txt:1'], count: 2 },
    { directive: 'symbol="[ \\t]+$"', places: ['data/trailing.txt:1'], count: 1 },
    { directive: 'symbol="a.b"', places: ['data/dot.txt:2'], count: 1 },
    { directive: 'symbol="foo\\s+bar"', places: ['data/cross.txt:1'], count: 1 },
    { directive: 'symbol="^" target="data/crlf.yml"', places: ['data/crlf.yml:1', 'data/crlf.yml:2', 'data/crlf.yml:3'], count: 3 },
  ];

  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.map(removeTempRepo));
  });

  it('counts the same matches in the same places, and they are the lines a reader sees', async () => {
    const directives = RULES.map(({ directive }) => {
      const target = directive.includes('target=') ? '' : 'target="data" ';
      return `<!-- @assert-count ${target}${directive} regex="true" max="100" -->`;
    });
    const root = await makeTempRepo({
      'docs/rules.md': `# Rules\n\n${directives.join('\n')}\n`,
      'data/lf.yml': 'name: ci\n  - uses: a\nend\n',
      'data/crlf.yml': 'name: ci\r\n  - uses: a\r\nend\r\n',
      'data/cr.yml': 'name: ci\r  - uses: a\rend\r',
      'data/first.yml': 'uses: b\nname: x\n',
      'data/separator.txt': `name${LS}uses: c\nx${PS}uses: d e\n`,
      'data/blank.txt': 'a\n\nb\n',
      'data/trailing.txt': 'a  \r\nb\r\n',
      'data/dot.txt': 'xa\r\nbx\rxa-b\n',
      'data/cross.txt': 'foo\nbar\n',
      'data/empty.txt': '',
    });
    temporary.push(root);

    const answers = [];
    for (const engine of ['javascript', 'ripgrep'] as const) {
      process.env.SPEC_GUARD_RG = rgPath as string;
      const report = await runSpecGuard({ root, patterns: ['docs/rules.md'], engine, maxSnippets: 50 });
      // A search ripgrep refused is answered by the scanner and named as
      // such, and a comparison of the scanner with itself holds nothing.
      expect(report.engine, engine).toBe(engine);
      expect(report.warnings, engine).toEqual([]);
      answers.push(report.results.map((result) => ({ count: result.actual, places: result.matches.map((match) => `${match.file}:${match.line}`) })));
    }

    const expected = RULES.map(({ count, places }) => ({ count, places }));
    expect(answers[0]).toEqual(expected);
    expect(answers[1]).toEqual(expected);
  });
});
