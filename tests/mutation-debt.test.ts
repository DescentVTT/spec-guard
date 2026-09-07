/**
 * Second pass over surviving mutants, working from the CI report rather than
 * the local one - CI is slower, so fewer mutants hang there and more of them
 * are reported honestly as survivors.
 *
 * The groups below are the structural causes that showed up, not a list of
 * individual mutants: which attribute name an error blames, which spellings of
 * "false" are accepted, which characters a validator's regex actually rejects,
 * and the ordering guarantees that only ripgrep's output can exercise.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isMissingBinary,
  javascriptEngine,
  runSearches,
  sortLocations,
  type SearchRequest,
} from '../src/engine.js';
import { parseDirectives } from '../src/parser.js';
import { formatReport } from '../src/reporter.js';
import { resolveDirective, runSpecGuard, type RunResult } from '../src/runner.js';
import { parseArgs, UsageError } from '../src/cli.js';
import type { Directive, DirectiveKind } from '../src/types.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const ESC = String.fromCharCode(27);
const parseContext = { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md' };

function directive(kind: DirectiveKind, attributes: Record<string, string>): Directive {
  return {
    kind,
    attributes,
    raw: `<!-- @${kind} -->`,
    location: { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md', line: 1, column: 1 },
  };
}

function resolve(kind: DirectiveKind, attributes: Record<string, string>) {
  return resolveDirective(directive(kind, attributes), { root: DEMO_REPO, excludeFiles: new Set<string>() });
}

function errorOf(kind: DirectiveKind, attributes: Record<string, string>): string {
  const resolved = resolve(kind, attributes);
  if (!('error' in resolved)) throw new Error('expected an error');
  return resolved.error.message;
}

/* ---------------------------------------------------------------- runner.ts */

describe('error messages name the attribute at fault', () => {
  it('blames max, not expected, when max is the bad one', () => {
    expect(errorOf('assert-absence', { symbol: 'X', max: 'lots' })).toBe(
      'Attribute "max" must be a non-negative integer, got "lots".',
    );
  });

  it('blames expected when expected is the bad one', () => {
    expect(errorOf('assert-absence', { symbol: 'X', expected: 'lots' })).toBe(
      'Attribute "expected" must be a non-negative integer, got "lots".',
    );
  });

  it.each([
    ['min', { symbol: 'X', min: 'lots' }],
    ['max', { symbol: 'X', max: 'lots' }],
    ['expected', { symbol: 'X', expected: 'lots' }],
  ] as Array<[string, Record<string, string>]>)('blames %s on a count assertion', (attribute, attributes) => {
    expect(errorOf('assert-count', attributes)).toContain(`Attribute "${attribute}"`);
  });

  it.each([
    ['regex', { symbol: 'X', expected: '1', regex: 'perhaps' }],
    ['word', { symbol: 'X', expected: '1', word: 'perhaps' }],
    ['ignore-case', { symbol: 'X', expected: '1', 'ignore-case': 'perhaps' }],
  ] as Array<[string, Record<string, string>]>)('blames the %s boolean', (attribute, attributes) => {
    expect(errorOf('assert-count', attributes)).toBe(
      `Attribute "${attribute}" must be true or false, got "perhaps".`,
    );
  });
});

describe('bound guards fire only when both bounds exist', () => {
  it('accepts a lone min or a lone max', () => {
    expect('assertion' in resolve('assert-count', { symbol: 'X', min: '3' })).toBe(true);
    expect('assertion' in resolve('assert-count', { symbol: 'X', max: '3' })).toBe(true);
  });

  it('accepts min equal to max', () => {
    expect('assertion' in resolve('assert-count', { symbol: 'X', min: '3', max: '3' })).toBe(true);
  });

  it('rejects only when min actually exceeds max', () => {
    expect(errorOf('assert-count', { symbol: 'X', min: '4', max: '3' })).toContain('greater than');
    expect('assertion' in resolve('assert-count', { symbol: 'X', min: '3', max: '4' })).toBe(true);
  });
});

describe('boolean attribute spellings', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %s as true', (value) => {
    const resolved = resolve('assert-count', { symbol: 'X', expected: '1', regex: value });
    expect('assertion' in resolved && resolved.assertion.search?.regex).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('reads %s as false', (value) => {
    const resolved = resolve('assert-count', { symbol: 'X', expected: '1', regex: value });
    expect('assertion' in resolved && resolved.assertion.search?.regex).toBe(false);
  });

  it('rejects a spelling that is in neither list', () => {
    expect(errorOf('assert-count', { symbol: 'X', expected: '1', regex: 'off?' })).toContain('true or false');
  });
});

describe('the run-level engine label', () => {
  it('names the engine that ran when nothing fell back', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });

    expect(report.warnings).toEqual([]);
    expect(report.engine).toBe('javascript');
    expect(formatReport(report, { color: false, verbose: false })).toContain('· javascript');
  });

  it('reports javascript once a fallback has happened', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });
    const fellBack: RunResult = { ...report, engine: 'ripgrep', warnings: ['ripgrep failed, fell back'] };

    // The reporter shows whatever the runner concluded; the runner's own rule is
    // covered by the engine tests.
    expect(formatReport(fellBack, { color: false, verbose: false })).toContain('ripgrep failed, fell back');
  });
});

/* ---------------------------------------------------------------- parser.ts */

describe('every allowed attribute is actually allowed', () => {
  const allowed: Record<DirectiveKind, string[]> = {
    'assert-absence': ['target', 'symbol', 'expected', 'max', 'glob', 'regex', 'word', 'ignore-case', 'reason'],
    'assert-count': ['target', 'symbol', 'expected', 'min', 'max', 'glob', 'regex', 'word', 'ignore-case', 'reason'],
    'assert-present': ['file', 'reason'],
  };

  for (const [kind, attributes] of Object.entries(allowed)) {
    for (const attribute of attributes) {
      it(`@${kind} accepts ${attribute}`, () => {
        const source = `<!-- @${kind} ${attribute}="1" -->`;
        const { directives, errors } = parseDirectives(source, parseContext);

        expect(errors).toEqual([]);
        expect(directives[0]?.attributes[attribute]).toBe('1');
      });
    }
  }

  it('names every known directive when rejecting an unknown one', () => {
    const { errors } = parseDirectives('<!-- @assert-nonsense -->', parseContext);
    const message = errors[0]?.message ?? '';

    expect(message).toContain('@assert-absence');
    expect(message).toContain('@assert-count');
    expect(message).toContain('@assert-present');
  });

  it('lists the allowed attributes when rejecting an unknown one', () => {
    const { errors } = parseDirectives('<!-- @assert-present file="a.md" nope="1" -->', parseContext);
    const message = errors[0]?.message ?? '';

    expect(message).toContain('Allowed: file, reason');
  });
});

describe('code masking boundaries', () => {
  it('blanks exactly the code span and nothing after it', () => {
    const source = '`x`<!-- @assert-present file="a.md" -->';
    const { directives } = parseDirectives(source, parseContext);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.location.column).toBe(4);
  });

  it('blanks exactly the fence and nothing after it', () => {
    const fence = '`'.repeat(3);
    const source = [fence, 'code', fence, '<!-- @assert-present file="a.md" -->'].join('\n');
    const { directives } = parseDirectives(source, parseContext);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.location.line).toBe(4);
    expect(directives[0]?.location.column).toBe(1);
  });

  it('does not treat a fence as nested inside an earlier one', () => {
    const fence = '`'.repeat(3);
    const source = [
      fence,
      'first',
      fence,
      '',
      fence,
      '<!-- @assert-absence target="src" symbol="Documented" -->',
      fence,
      '',
      '<!-- @assert-present file="real.md" -->',
    ].join('\n');

    const { directives } = parseDirectives(source, parseContext);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.kind).toBe('assert-present');
  });
});

/* ------------------------------------------------------------------- cli.ts */

describe('numeric option validation', () => {
  // Written as --max-snippets=VALUE: in the two-argument form anything starting
  // with "-" is rejected as a missing value before the number check runs, so
  // those cases would have passed without the validator doing anything.
  it.each(['1a', 'a1', '', ' ', '1.5', '-1', '+1', '1 2', 'Infinity', '0x10', '1e3'])(
    'rejects --max-snippets=%s',
    (value) => {
      expect(() => parseArgs([`--max-snippets=${value}`], DEMO_REPO)).toThrow(UsageError);
      expect(() => parseArgs([`--max-snippets=${value}`], DEMO_REPO)).toThrow(/non-negative integer/);
    },
  );

  it.each(['0', '1', '42', '007'])('accepts --max-snippets %s', (value) => {
    expect(parseArgs(['--max-snippets', value], DEMO_REPO).maxSnippets).toBe(Number.parseInt(value, 10));
  });

  it('anchors the check at both ends of the value', () => {
    // An unanchored /\d+/ would accept these.
    expect(() => parseArgs(['--max-snippets', 'x9'], DEMO_REPO)).toThrow(UsageError);
    expect(() => parseArgs(['--max-snippets', '9x'], DEMO_REPO)).toThrow(UsageError);
  });
});

/* ---------------------------------------------------------------- engine.ts */

describe('isMissingBinary', () => {
  it.each(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'UNKNOWN'])('treats %s as a missing binary', (code) => {
    expect(isMissingBinary(Object.assign(new Error('spawn failed'), { code }))).toBe(true);
  });

  it.each(['EBUSY', 'EPIPE', 'ETIMEDOUT', 'EAGAIN'])('treats %s as a real failure', (code) => {
    expect(isMissingBinary(Object.assign(new Error('spawn failed'), { code }))).toBe(false);
  });

  it('treats a code-less error as a real failure', () => {
    expect(isMissingBinary(new Error('ripgrep exited with code 2'))).toBe(false);
    expect(isMissingBinary(null)).toBe(false);
    expect(isMissingBinary({ code: 42 })).toBe(false);
  });
});

describe('sortLocations', () => {
  // ripgrep searches in parallel and emits files in no fixed order, so this is
  // the function that makes snippet output stable. Driving it through a real
  // ripgrep would only prove whatever order that particular run produced.
  const at = (file: string, line: number) => ({ file, line, column: 1, text: '', count: 1 });

  it('orders by path first', () => {
    const sorted = sortLocations([at('src/zebra.ts', 1), at('src/alpha.ts', 9), at('src/middle.ts', 5)]);
    expect(sorted.map((location) => location.file)).toEqual(['src/alpha.ts', 'src/middle.ts', 'src/zebra.ts']);
  });

  it('orders by line within one path', () => {
    const sorted = sortLocations([at('src/a.ts', 9), at('src/a.ts', 2), at('src/a.ts', 5)]);
    expect(sorted.map((location) => location.line)).toEqual([2, 5, 9]);
  });

  it('prefers path order over line order', () => {
    const sorted = sortLocations([at('src/b.ts', 1), at('src/a.ts', 2)]);
    expect(sorted.map((location) => location.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('leaves an already ordered list alone', () => {
    const ordered = [at('src/a.ts', 1), at('src/a.ts', 2), at('src/b.ts', 1)];
    expect(sortLocations([...ordered])).toEqual(ordered);
  });
});

describe('grouping requires every field to agree', () => {
  /**
   * Every request here shares one exclude set on purpose. `sharesOnePass`
   * compares that set by identity and it is the last condition checked, so a
   * fresh `new Set()` per request makes the group differ for that reason alone
   * and none of the earlier comparisons ever run. Tests written that way pass
   * whatever those comparisons do.
   */
  const shared = new Set<string>();
  const options = (overrides = {}) => searchOptions({ excludeFiles: shared, ...overrides });

  async function counts(requests: SearchRequest[]): Promise<number[]> {
    const results = await runSearches(javascriptEngine, requests);
    return results.map((result) => result.count);
  }

  it('does not merge different roots', async () => {
    const other = await makeTempRepo({ 'src/a.ts': 'UserSessionManager\n' });
    try {
      expect(
        await counts([
          { root: DEMO_REPO, symbol: 'UserSessionManager', targets: ['src'], options: options() },
          { root: other, symbol: 'UserSessionManager', targets: ['src'], options: options() },
        ]),
      ).toEqual([1, 1]);
    } finally {
      await removeTempRepo(other);
    }
  });

  it('does not merge different targets', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui'], options: options() },
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/core'], options: options() },
      ]),
    ).toEqual([2, 0]);
  });

  it('does not merge different numbers of targets', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui'], options: options() },
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui', 'src/core'], options: options() },
      ]),
    ).toEqual([2, 2]);
  });

  it('does not merge different word settings', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui'], options: options() },
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui'], options: options({ word: true }) },
      ]),
    ).toEqual([2, 1]);
  });

  it('does not merge different case sensitivity', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'primarybutton', targets: ['src/ui'], options: options() },
        { root: DEMO_REPO, symbol: 'primarybutton', targets: ['src/ui'], options: options({ ignoreCase: true }) },
      ]),
    ).toEqual([0, 2]);
  });

  it('does not merge literal with regex', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'class [A-Z][A-Za-z]+', targets: ['src'], options: options() },
        { root: DEMO_REPO, symbol: 'class [A-Z][A-Za-z]+', targets: ['src'], options: options({ regex: true }) },
      ]),
    ).toEqual([0, 4]);
  });

  it('does not merge different glob filters', async () => {
    const [tsx, ts] = await counts([
      { root: DEMO_REPO, symbol: 'export', targets: ['src'], options: options({ globs: ['*.tsx'] }) },
      { root: DEMO_REPO, symbol: 'export', targets: ['src'], options: options({ globs: ['*.ts'] }) },
    ]);

    expect(tsx).toBe(2);
    expect(ts).toBeGreaterThan(2);
  });

  it('does not merge different numbers of glob filters', async () => {
    const [one, two] = await counts([
      { root: DEMO_REPO, symbol: 'export', targets: ['src'], options: options({ globs: ['*.tsx'] }) },
      { root: DEMO_REPO, symbol: 'export', targets: ['src'], options: options({ globs: ['*.tsx', '*.ts'] }) },
    ]);

    expect(one).toBe(2);
    expect(two).toBeGreaterThan(2);
  });

  it('does not merge different exclude sets', async () => {
    const excluded = new Set([path.resolve(DEMO_REPO, 'src/services/UserSessionManager.ts')]);
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'UserSessionManager', targets: ['src'], options: options() },
        {
          root: DEMO_REPO,
          symbol: 'UserSessionManager',
          targets: ['src'],
          options: searchOptions({ excludeFiles: excluded }),
        },
      ]),
    ).toEqual([1, 0]);
  });

  it('does merge when every field agrees', async () => {
    expect(
      await counts([
        { root: DEMO_REPO, symbol: 'PrimaryButton', targets: ['src/ui'], options: options() },
        { root: DEMO_REPO, symbol: 'DeprecatedHelper', targets: ['src/ui'], options: options() },
      ]),
    ).toEqual([2, 0]);
  });
});

/* -------------------------------------------------------------- reporter.ts */

describe('colour on the error block', () => {
  it('paints the invalid-directive marker and its raw line', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0003-invalid.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });
    const output = formatReport(report, { color: true, verbose: false });

    expect(output).toContain(`${ESC}[33m${ESC}[1m⚠${ESC}[0m`);
    expect(output).toContain(`${ESC}[33minvalid directive${ESC}[0m`);
    expect(output).toContain(`${ESC}[33m4 invalid${ESC}[0m`);
  });

  it('paints run-level warnings yellow', async () => {
    const report = await runSpecGuard({
      patterns: ['docs/adr/0001-passing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });
    const warned: RunResult = { ...report, warnings: ['fell back'] };
    const output = formatReport(warned, { color: true, verbose: false });

    expect(output).toContain(`${ESC}[33m⚠${ESC}[0m`);
    expect(output).toContain(`${ESC}[33mfell back${ESC}[0m`);
  });
});

describe('inline values versus the missing-value heuristic', () => {
  it('still catches an option whose value was swallowed', () => {
    expect(() => parseArgs(['--root', '--verbose'], DEMO_REPO)).toThrow(/requires a value/);
    expect(() => parseArgs(['--engine'], DEMO_REPO)).toThrow(/requires a value/);
  });

  it('accepts a legitimate inline value that starts with a dash', () => {
    expect(parseArgs(['--root=-weird-dir'], DEMO_REPO).root).toContain('-weird-dir');
  });
});
