/**
 * An option beside its own opposite is refused.
 *
 * On 0.24.0 `--strict --no-strict` ran as `--no-strict` alone and
 * `--no-strict --strict` as `--strict` alone: the last of the two won and no
 * word was said of the other, for every pair the command line has but the one
 * that draws the marks. The family contract refuses two things of which one
 * would go unread (spec-core's ADR-0005), so each pair is exit 2 and one line
 * that names both, in either order, on every command that takes both
 * (ADR-0014, amended 2026-10-12).
 *
 * Beside each refusal is what must still be read: either alone, either given
 * twice, and the opposite alone over a configuration that sets the option,
 * which is what an opposite is for.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

function createIO(overrides: Partial<CliIO> = {}): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  // A terminal is named, so a report is drawn one way on every platform.
  const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1', WT_SESSION: '1' }, cwd: DEMO_REPO, isTTY: false, ...overrides };
  return { io, out, err };
}

const refusal = (on: string, off: string): string => `Option ${on} is given beside ${off}, and one of the two would go unread. Give one of the two.`;

const RUN = [[], ['--watch'], ['prove']];
const ASKS = [
  ['query', 'src'],
  ['impact', 'src'],
];

/** Every pair the command line has, and the commands that take both of it. */
const PAIRS: Array<[on: string, off: string, commands: string[][]]> = [
  ['--strict', '--no-strict', [...RUN, ['cites'], ['mcp']]],
  ['--allow-missing-targets', '--no-allow-missing-targets', [...RUN, ['mcp']]],
  ['--allow-empty-scope', '--no-allow-empty-scope', [...RUN, ['mcp']]],
  ['--default-skips', '--no-default-skips', [...RUN, ['cites'], ...ASKS, ['mcp']]],
  ['--ignore-status', '--no-ignore-status', [...RUN, ...ASKS, ['mcp']]],
  ['--include-specs', '--no-include-specs', [...RUN, ...ASKS, ['mcp']]],
  ['--color', '--no-color', [...RUN, ['cites']]],
  ['--ascii', '--no-ascii', [...RUN, ['cites']]],
];

describe('an option beside its own opposite', () => {
  it.each(PAIRS)('refuses %s beside %s, in either order, on every command that takes both', (on, off, commands) => {
    const both = new UsageError(refusal(on, off));
    for (const command of commands) {
      const said = command.join(' ');
      expect(() => parseArgs([...command, on, off], DEMO_REPO), said).toThrow(both);
      expect(() => parseArgs([...command, off, on], DEMO_REPO), said).toThrow(both);
      // Not only side by side, and not only once each.
      expect(() => parseArgs([...command, off, '--root', '.', on], DEMO_REPO), said).toThrow(both);
      expect(() => parseArgs([...command, on, on, off], DEMO_REPO), said).toThrow(both);
    }
  });

  it.each(PAIRS)('reads %s alone and %s alone, and each given twice as once', (on, off, commands) => {
    for (const command of commands) {
      const said = command.join(' ');
      const alone = parseArgs([...command, on], DEMO_REPO);
      const opposite = parseArgs([...command, off], DEMO_REPO);
      expect(parseArgs([...command, on, on], DEMO_REPO), said).toEqual(alone);
      expect(parseArgs([...command, off, off], DEMO_REPO), said).toEqual(opposite);
      // Two answers: were the opposite read as its option, nothing would be left to refuse.
      expect(opposite, said).not.toEqual(alone);
    }
  });

  it('names the first pair it meets where a line holds two of them, and the option before its opposite', () => {
    expect(() => parseArgs(['--no-color', '--strict', '--no-strict', '--color'], DEMO_REPO)).toThrow(new UsageError(refusal('--color', '--no-color')));
    expect(() => parseArgs(['--no-strict', '--no-color', '--color', '--strict'], DEMO_REPO)).toThrow(new UsageError(refusal('--strict', '--no-strict')));
  });

  it('takes two options that are no pair, and an opposite beside another option of its kind', () => {
    expect(parseArgs(['--strict', '--no-color', '--ascii', '--no-default-skips', '--ignore-status'], DEMO_REPO)).toMatchObject({
      strictTargets: true,
      color: false,
      ascii: true,
      defaultSkips: false,
      ignoreStatus: true,
    });
    expect(parseArgs(['--no-strict', '--no-allow-empty-scope', '--allow-missing-targets'], DEMO_REPO)).toMatchObject({
      strictTargets: false,
      allowEmptyScope: false,
      allowMissingTargets: true,
    });
  });

  it('refuses an option a command does not take for that, before it is refused for its company', () => {
    const not = (option: string, command: string): UsageError => new UsageError(`Option ${option} does not apply to spec-guard ${command}.`);
    for (const command of ['query', 'impact']) {
      expect(() => parseArgs([command, 'src', '--strict', '--no-strict'], DEMO_REPO)).toThrow(not('--strict', command));
      expect(() => parseArgs([command, 'src', '--no-strict', '--strict'], DEMO_REPO)).toThrow(not('--no-strict', command));
      // One of the pair is taken there, and the other is what is refused.
      expect(() => parseArgs([command, 'src', '--no-color', '--color'], DEMO_REPO)).toThrow(not('--color', command));
      expect(() => parseArgs([command, 'src', '--color', '--no-color'], DEMO_REPO)).toThrow(not('--color', command));
    }
    expect(() => parseArgs(['mcp', '--no-color', '--color'], DEMO_REPO)).toThrow(not('--no-color', 'mcp'));
    expect(() => parseArgs(['cites', '--ignore-status', '--no-ignore-status'], DEMO_REPO)).toThrow(not('--ignore-status', 'cites'));
  });

  it('refuses a value given to either before it looks at the pair', () => {
    expect(() => parseArgs(['--strict=true', '--no-strict'], DEMO_REPO)).toThrow(/^Option --strict takes no value, got "true"\./);
  });

  it('is exit 2 and the one line, with nothing run, for each command', async () => {
    const root = await tree({
      'docs/adr/0001-kept.md': '# ADR-0001: Kept\n\n<!-- @assert-absence target="src" symbol="Removed" -->\n',
      'src/a.ts': '// As ADR-0001 has it.\nexport const kept = 1;\n',
    });
    const cases: Array<[string[], string, string]> = [
      [[], '--strict', '--no-strict'],
      [[], '--color', '--no-color'],
      [['prove'], '--allow-empty-scope', '--no-allow-empty-scope'],
      [['cites'], '--default-skips', '--no-default-skips'],
      [['query', 'src/a.ts'], '--ignore-status', '--no-ignore-status'],
      [['impact', 'src/a.ts'], '--include-specs', '--no-include-specs'],
      [['mcp'], '--allow-missing-targets', '--no-allow-missing-targets'],
    ];
    for (const [command, on, off] of cases) {
      for (const pair of [[on, off], [off, on]]) {
        const { io, out, err } = createIO({ cwd: root });
        expect(await main([...command, ...pair, '--root', root], io), [...command, ...pair].join(' ')).toBe(EXIT_ERROR);
        expect([out, err]).toEqual([[], [`spec-guard: ${refusal(on, off)}`]]);
      }
    }
  });

  it('starts no session for a pair given with --watch', async () => {
    const root = await tree({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    let watched = 0;
    const { io, out, err } = createIO({
      cwd: root,
      watch: () => {
        watched += 1;
        return { close: () => {} };
      },
    });
    expect(await main(['--watch', '--no-default-skips', '--default-skips', '--root', root], io)).toBe(EXIT_ERROR);
    expect([out, err, watched]).toEqual([[], [`spec-guard: ${refusal('--default-skips', '--no-default-skips')}`], 0]);
  });

  it('is said in the help, beside the other inputs that are refused', () => {
    expect(HELP).toContain(
      [
        '  An option given beside its own opposite is refused the same way, in either',
        '  order, since one of the two would go unread: --strict beside --no-strict,',
        '  --color beside --no-color, and each other pair. The same option given twice',
        '  is read as once.',
      ].join('\n'),
    );
  });
});

describe('the opposite of an option, alone over a configuration that sets it', () => {
  const LIVE = '# ADR-0001: Live\n\n## Status\n\nAccepted.\n';
  // For each key: a tree in which the option decides the exit code, and the
  // exit code with the option on.
  const KEYS: Array<[key: string, on: string, off: string, files: Record<string, string>, whenOn: number, whenOff: number]> = [
    ['strict', '--strict', '--no-strict', { 'docs/adr/0001-live.md': LIVE, 'src/a.ts': 'export const a = 1;\n' }, EXIT_FAILED, EXIT_OK],
    [
      'allowMissingTargets',
      '--allow-missing-targets',
      '--no-allow-missing-targets',
      { 'docs/adr/0001-live.md': `${LIVE}\n<!-- @assert-absence target="src, lib" symbol="Needle" -->\n`, 'src/a.ts': 'export const a = 1;\n' },
      EXIT_OK,
      EXIT_FAILED,
    ],
    [
      'allowEmptyScope',
      '--allow-empty-scope',
      '--no-allow-empty-scope',
      { 'docs/adr/0001-live.md': `${LIVE}\n<!-- @assert-absence target="src" glob="*.rs" symbol="Needle" -->\n`, 'src/a.ts': 'export const a = 1;\n' },
      EXIT_OK,
      EXIT_FAILED,
    ],
    [
      'defaultSkips',
      '--default-skips',
      '--no-default-skips',
      { 'docs/adr/0001-live.md': `${LIVE}\n<!-- @assert-absence target="." symbol="Needle" -->\n`, 'node_modules/x/a.js': 'export const Needle = 1;\n', 'src/a.ts': 'export const a = 1;\n' },
      EXIT_OK,
      EXIT_FAILED,
    ],
    [
      'ignoreStatus',
      '--ignore-status',
      '--no-ignore-status',
      { 'docs/adr/0001-draft.md': '# ADR-0001: Draft\n\n## Status\n\nDraft.\n\n<!-- @assert-absence target="src" symbol="Needle" -->\n', 'src/a.ts': 'export const Needle = 1;\n' },
      EXIT_FAILED,
      EXIT_OK,
    ],
    [
      'includeSpecs',
      '--include-specs',
      '--no-include-specs',
      { 'docs/adr/0001-live.md': `${LIVE}\nNeedle is gone from the tree.\n\n<!-- @assert-absence target="." symbol="Needle" -->\n`, 'src/a.ts': 'export const a = 1;\n' },
      EXIT_FAILED,
      EXIT_OK,
    ],
  ];

  it.each(KEYS)('%s: %s and %s each win over the file, and the report says which lost', async (key, on, off, files, whenOn, whenOff) => {
    for (const [value, opposite, configured, overridden] of [
      [true, off, whenOn, whenOff],
      [false, on, whenOff, whenOn],
    ] as const) {
      const root = await tree({ ...files, '.spec-guard.json': JSON.stringify({ [key]: value }) });
      const said = `"${key}": ${value}`;

      const file = createIO({ cwd: root });
      expect(await main(['--root', root, '--engine', 'js'], file.io), said).toBe(configured);
      expect(file.out.join('\n'), said).toContain(`\noptions from .spec-guard.json: ${key}\n`);

      const line = createIO({ cwd: root });
      expect(await main(['--root', root, '--engine', 'js', opposite], line.io), `${said} ${opposite}`).toBe(overridden);
      expect(line.out.join('\n'), `${said} ${opposite}`).toContain(`\noptions from .spec-guard.json: none; overridden on the command line: ${key}\n`);
      expect(line.err).toEqual([]);
    }
  });
});
