/**
 * Tests for the parts of the engine that a real ripgrep cannot be made to
 * exercise on demand.
 *
 * The first mutation run left 117 survivors in engine.ts, almost all of them in
 * two places: the ripgrep JSON handling, which lived inside a spawn callback,
 * and the batching decision, which is invisible from the outside by design -
 * a correct batch and a correct set of separate passes return the same answer.
 *
 * Both were extracted into pure functions (`createRipgrepSink`,
 * `shouldBatchPatterns`) so the behaviour can be asserted as data rather than
 * provoked out of a subprocess.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRipgrepSink, shouldBatchPatterns, type SearchRequest } from '../src/engine.js';
import { searchOptions } from './helpers.js';

const ROOT = path.resolve('C:/repo');

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { root: ROOT, symbol: 'Alpha', targets: ['src'], options: searchOptions(), ...overrides };
}

/** Builds one ripgrep `match` event as it appears on stdout. */
function matchEvent(options: {
  file?: string;
  line?: number | undefined;
  text?: string;
  submatches?: Array<{ text: string; start: number }>;
  pathBytes?: string;
  textBytes?: string;
}): string {
  const data: Record<string, unknown> = {};
  data['path'] = options.pathBytes ? { bytes: options.pathBytes } : { text: options.file ?? 'src/a.ts' };
  data['lines'] = options.textBytes ? { bytes: options.textBytes } : { text: `${options.text ?? 'const Alpha = 1;'}\n` };
  if (options.line !== undefined) data['line_number'] = options.line;
  data['submatches'] = (options.submatches ?? [{ text: 'Alpha', start: 6 }]).map((submatch) => ({
    match: { text: submatch.text },
    start: submatch.start,
  }));
  return JSON.stringify({ type: 'match', data });
}

function feed(lines: string[], patterns: string[] = ['Alpha'], overrides: Partial<SearchRequest> = {}) {
  const sink = createRipgrepSink(request(overrides), patterns);
  for (const line of lines) sink.line(line);
  return sink;
}

describe('createRipgrepSink', () => {
  it('counts a single match and records its location', () => {
    const sink = feed([matchEvent({ line: 3 })]);
    const tally = sink.tallies.get('Alpha');

    expect(sink.failure).toBeNull();
    expect(tally?.count).toBe(1);
    expect(tally?.locations).toEqual([
      { file: 'src/a.ts', line: 3, column: 7, text: 'const Alpha = 1;', count: 1 },
    ]);
  });

  it('reports column as a one-based offset', () => {
    const sink = feed([matchEvent({ line: 1, submatches: [{ text: 'Alpha', start: 0 }] })]);
    expect(sink.tallies.get('Alpha')?.locations[0]?.column).toBe(1);
  });

  it('defaults a missing line number to zero rather than dropping the match', () => {
    const sink = feed([matchEvent({ line: undefined })]);
    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.tallies.get('Alpha')?.locations[0]?.line).toBe(0);
  });

  it('collapses several matches on one line into a single location', () => {
    const sink = feed([
      matchEvent({
        line: 4,
        text: 'Alpha Alpha Alpha',
        submatches: [
          { text: 'Alpha', start: 0 },
          { text: 'Alpha', start: 6 },
          { text: 'Alpha', start: 12 },
        ],
      }),
    ]);
    const tally = sink.tallies.get('Alpha');

    expect(tally?.count).toBe(3);
    expect(tally?.locations).toHaveLength(1);
    expect(tally?.locations[0]?.count).toBe(3);
  });

  it('keeps separate locations for the same file on different lines', () => {
    const sink = feed([matchEvent({ line: 2 }), matchEvent({ line: 9 })]);
    expect(sink.tallies.get('Alpha')?.locations.map((location) => location.line)).toEqual([2, 9]);
  });

  it('keeps separate locations for the same line number in different files', () => {
    const sink = feed([matchEvent({ file: 'src/a.ts', line: 2 }), matchEvent({ file: 'src/b.ts', line: 2 })]);
    expect(sink.tallies.get('Alpha')?.locations.map((location) => location.file)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('ignores blank lines and anything that is not a match event', () => {
    const sink = feed([
      '',
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'match' }),
      matchEvent({ line: 1 }),
    ]);

    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.failure).toBeNull();
  });

  it('ignores a match event carrying no submatches', () => {
    const sink = feed([matchEvent({ line: 1, submatches: [] })]);
    expect(sink.tallies.get('Alpha')?.count).toBe(0);
  });

  it('survives malformed JSON without losing later matches', () => {
    const sink = feed(['{not json', matchEvent({ line: 1 })]);
    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.failure).toBeNull();
  });

  it('decodes base64 paths and lines for non-UTF-8 output', () => {
    const sink = feed([
      matchEvent({
        line: 5,
        pathBytes: Buffer.from('src/wéird.ts', 'utf8').toString('base64'),
        textBytes: Buffer.from('const Alpha = "é";\n', 'utf8').toString('base64'),
      }),
    ]);
    const location = sink.tallies.get('Alpha')?.locations[0];

    expect(location?.file).toBe('src/wéird.ts');
    expect(location?.text).toBe('const Alpha = "é";');
  });

  it('treats a path with neither text nor bytes as the root itself', () => {
    const line = JSON.stringify({
      type: 'match',
      data: { path: {}, lines: {}, line_number: 1, submatches: [{ match: { text: 'Alpha' }, start: 0 }] },
    });
    const sink = feed([line]);

    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.tallies.get('Alpha')?.locations[0]?.text).toBe('');
  });

  it('drops matches from excluded files without counting them', () => {
    const excluded = path.resolve(ROOT, 'docs/adr.md');
    const sink = feed([matchEvent({ file: 'docs/adr.md', line: 1 }), matchEvent({ file: 'src/a.ts', line: 1 })], ['Alpha'], {
      options: searchOptions({ excludeFiles: new Set([excluded]) }),
    });

    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.tallies.get('Alpha')?.locations.map((location) => location.file)).toEqual(['src/a.ts']);
  });

  it('normalises a path that ripgrep echoed with a ./ prefix', () => {
    const sink = feed([matchEvent({ file: './src/a.ts', line: 1 })]);
    expect(sink.tallies.get('Alpha')?.locations[0]?.file).toBe('src/a.ts');
  });

  it('strips only a trailing newline from the snippet', () => {
    expect(feed([matchEvent({ line: 1, text: 'a' })]).tallies.get('Alpha')?.locations[0]?.text).toBe('a');

    const crlf = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/a.ts' },
        lines: { text: 'const Alpha = 1;\r\n' },
        line_number: 1,
        submatches: [{ match: { text: 'Alpha' }, start: 6 }],
      },
    });
    expect(feed([crlf]).tallies.get('Alpha')?.locations[0]?.text).toBe('const Alpha = 1;');

    const inner = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/a.ts' },
        lines: { text: 'a\nb' },
        line_number: 1,
        submatches: [{ match: { text: 'Alpha' }, start: 0 }],
      },
    });
    expect(feed([inner]).tallies.get('Alpha')?.locations[0]?.text).toBe('a\nb');
  });

  it('truncates a very long line at the snippet limit', () => {
    const long = 'x'.repeat(400);
    const sink = feed([matchEvent({ line: 1, text: long })]);
    const text = sink.tallies.get('Alpha')?.locations[0]?.text as string;

    expect(text).toHaveLength(201);
    expect(text.endsWith('…')).toBe(true);
  });

  it('attributes each submatch to its own pattern when batched', () => {
    const sink = feed(
      [
        matchEvent({
          line: 1,
          text: 'Alpha and Bravo',
          submatches: [
            { text: 'Alpha', start: 0 },
            { text: 'Bravo', start: 10 },
          ],
        }),
      ],
      ['Alpha', 'Bravo'],
    );

    expect(sink.tallies.get('Alpha')?.count).toBe(1);
    expect(sink.tallies.get('Bravo')?.count).toBe(1);
    expect(sink.tallies.get('Alpha')?.locations[0]?.column).toBe(1);
    expect(sink.tallies.get('Bravo')?.locations[0]?.column).toBe(11);
  });

  it('ignores the reported match text when only one pattern was requested', () => {
    // A single-pattern pass attributes by position, so a surprising match text
    // (case-insensitive or regex mode) still counts.
    const sink = feed([matchEvent({ line: 1, submatches: [{ text: 'ALPHA', start: 0 }] })], ['Alpha']);
    expect(sink.tallies.get('Alpha')?.count).toBe(1);
  });

  it('fails the batch when a match cannot be attributed to any pattern', () => {
    const sink = feed(
      [matchEvent({ line: 1, submatches: [{ text: 'Charlie', start: 0 }] })],
      ['Alpha', 'Bravo'],
    );

    expect(sink.failure).toBeInstanceOf(Error);
    expect(sink.failure?.message).toContain('Charlie');
  });

  it('stops consuming input once the batch has failed', () => {
    const sink = feed(
      [
        matchEvent({ line: 1, submatches: [{ text: 'Charlie', start: 0 }] }),
        matchEvent({ line: 2, submatches: [{ text: 'Alpha', start: 0 }] }),
      ],
      ['Alpha', 'Bravo'],
    );

    expect(sink.failure).not.toBeNull();
    expect(sink.tallies.get('Alpha')?.count).toBe(0);
  });
});

describe('shouldBatchPatterns', () => {
  it.each([
    [['Alpha', 'Bravo'], {}, true],
    [['Alpha'], {}, false],
    [[], {}, false],
    [['Alpha', 'Bravo'], { regex: true }, false],
    [['Alpha', 'Bravo'], { ignoreCase: true }, false],
    [['Alpha', 'Bravo'], { word: true }, true],
    [['Alpha', 'Bravo'], { globs: ['*.ts'] }, true],
    // Containment: an alternation would report the shorter match only.
    [['Primary', 'PrimaryButton'], {}, false],
    // Dovetailing: "abc" and "cd" both match inside "abcd".
    [['abc', 'cd'], {}, false],
    [['abc', 'def'], {}, true],
  ] as Array<[string[], Record<string, unknown>, boolean]>)(
    'patterns %o with %o -> %s',
    (patterns, overrides, expected) => {
      expect(shouldBatchPatterns(patterns, searchOptions(overrides))).toBe(expected);
    },
  );

  it('is not fooled by word mode into thinking overlaps are safe', () => {
    // Word boundaries would in fact make these safe, but the rule stays
    // conservative: correctness first, speed second.
    expect(shouldBatchPatterns(['Primary', 'PrimaryButton'], searchOptions({ word: true }))).toBe(false);
  });
});
