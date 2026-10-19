/**
 * An option that takes one value is refused where it is given two, and so is
 * a format asked for two ways.
 *
 * On 0.25.0 `--json --format sarif` wrote SARIF and `--format sarif --json`
 * wrote JSON: the later of the two was read and no word was said of the
 * earlier. So it was for `--format`, `--root`, `--engine`, `--max-snippets`,
 * `--concurrency` and `--depth` given twice with two values, on every command
 * that takes them. The family contract refuses two things of which one would
 * go unread (spec-core's ADR-0005), so each is exit 2 and one line that names
 * both as they were written, in the order they were given (ADR-0014, amended
 * 2026-10-14).
 *
 * Beside each refusal is what must still be read: the same value twice, one
 * thing spelled two ways, `--json` beside `--format json` and a list given
 * twice. `--help` and `--version` are no way round a refusal: a line with
 * two values is refused with either on it, as a line with a pair is.
 *
 * And `--help` beside `--version` asks for two answers to a line that gets
 * one. On 0.26.0 each order printed the help, on every command; each is now
 * refused the same way (ADR-0014, amended 2026-10-18).
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { comparedRoot, EXIT_ERROR, EXIT_OK, HELP, main, parseArgs, UsageError, version, type CliIO } from '../src/cli.js';
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
  const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1', WT_SESSION: '1' }, cwd: DEMO_REPO, isTTY: false, ...overrides };
  return { io, out, err };
}

const refusal = (first: string, second: string): string => `Option ${first} is given beside ${second}, and one of the two would go unread. Give one of the two.`;
const refused = (first: string, second: string): UsageError => new UsageError(refusal(first, second));

const RUN = [[], ['--watch']];
const ASKS = [
  ['query', 'src'],
  ['impact', 'src'],
];

/** Each option that takes one value, two values it takes, and the commands that take it. */
const OPTIONS: Array<[option: string, one: string, other: string, commands: string[][]]> = [
  ['--format', 'json', 'sarif', [[], ['prove'], ['cites']]],
  ['--format', 'github', 'gitlab', [[], ['prove'], ['cites']]],
  ['--format', 'human', 'json', [[], ['prove'], ['cites'], ...ASKS]],
  ['--root', 'here', 'there', [...RUN, ['prove'], ['cites'], ...ASKS, ['mcp']]],
  ['--engine', 'js', 'rg', [[], ['mcp']]],
  ['--engine', 'auto', 'js', [[], ['mcp']]],
  ['--max-snippets', '1', '7', [...RUN, ['mcp']]],
  ['--max-snippets', '0', '5', [...RUN, ['mcp']]],
  ['--concurrency', '1', '4', [...RUN, ['mcp']]],
  ['--depth', '1', '2', [['impact', 'src']]],
];

describe('an option that takes one value, given two', () => {
  it.each(OPTIONS)('refuses %s %s beside %s %s, and names both in the order they were given', (option, one, other, commands) => {
    const first = `${option} ${JSON.stringify(one)}`;
    const second = `${option} ${JSON.stringify(other)}`;
    for (const command of commands) {
      const said = command.join(' ');
      expect(() => parseArgs([...command, option, one, option, other], DEMO_REPO), said).toThrow(refused(first, second));
      expect(() => parseArgs([...command, option, other, option, one], DEMO_REPO), said).toThrow(refused(second, first));
      // Written with `=`, with another option between them, and a third time.
      expect(() => parseArgs([...command, `${option}=${one}`, '--spec', 'docs', option, other], DEMO_REPO), said).toThrow(refused(first, second));
      expect(() => parseArgs([...command, `${option}=${one}`, `${option}=${other}`], DEMO_REPO), said).toThrow(refused(first, second));
      expect(() => parseArgs([...command, option, one, option, one, option, other], DEMO_REPO), said).toThrow(refused(first, second));
      expect(() => parseArgs([...command, option, one, option, other, option, one], DEMO_REPO), said).toThrow(refused(first, second));
    }
  });

  it.each(OPTIONS)('reads %s %s given twice as once, and %s too', (option, one, other, commands) => {
    for (const command of commands) {
      const said = command.join(' ');
      const once = parseArgs([...command, option, one], DEMO_REPO);
      const another = parseArgs([...command, option, other], DEMO_REPO);
      expect(parseArgs([...command, option, one, option, one], DEMO_REPO), said).toEqual(once);
      expect(parseArgs([...command, `${option}=${other}`, option, other, option, other], DEMO_REPO), said).toEqual(another);
      // Two answers: were both read as one value, nothing would be left to refuse.
      expect(another, said).not.toEqual(once);
    }
  });

  it('reads one thing spelled two ways as one thing: it is what was read that is compared', () => {
    const same: Array<[string[], string[]]> = [
      [['--root', 'src'], ['--root', 'src/']],
      [['--root', 'src'], ['--root', './lib/../src']],
      [['--root', 'src'], ['-r', 'src']],
      [['--format', 'JSON'], ['--format', 'json']],
      [['--engine', 'JS'], ['--engine', 'js']],
      // Two of the names one engine goes by.
      [['--engine', 'js'], ['--engine', 'node']],
      [['--engine', 'rg'], ['--engine', 'ripgrep']],
      [['--max-snippets', '3'], ['--max-snippets', '03']],
      [['--concurrency', '2'], ['--concurrency', '002']],
    ];
    for (const [one, other] of same) {
      const said = [...one, ...other].join(' ');
      expect(parseArgs([...one, ...other], DEMO_REPO), said).toEqual(parseArgs(one, DEMO_REPO));
      expect(parseArgs([...other, ...one], DEMO_REPO), said).toEqual(parseArgs(one, DEMO_REPO));
    }
    expect(parseArgs(['impact', 'src', '--depth', '2', '--depth', '02'], DEMO_REPO)).toMatchObject({ depth: 2 });
  });

  it('refuses the short spelling beside the long one, each named as it was written', () => {
    expect(() => parseArgs(['-r', 'here', '--root', 'there'], DEMO_REPO)).toThrow(refused('-r "here"', '--root "there"'));
    expect(() => parseArgs(['--root', 'here', '-r', 'there'], DEMO_REPO)).toThrow(refused('--root "here"', '-r "there"'));
    expect(() => parseArgs(['-r', 'here', '-r', 'there'], DEMO_REPO)).toThrow(refused('-r "here"', '-r "there"'));
  });

  it('shows each value as it was written, where a blank in it can be seen', () => {
    expect(() => parseArgs(['--root', 'my docs', '--root', 'my  docs'], DEMO_REPO)).toThrow(refused('--root "my docs"', '--root "my  docs"'));
    expect(() => parseArgs(['--format', 'JSON', '--format', 'Sarif'], DEMO_REPO)).toThrow(refused('--format "JSON"', '--format "Sarif"'));
  });

  it('names the first two that ask one thing as two values, where a line holds more', () => {
    expect(() => parseArgs(['--root', 'here', '--format', 'json', '--root', 'there', '--format', 'sarif'], DEMO_REPO)).toThrow(refused('--root "here"', '--root "there"'));
    expect(() => parseArgs(['--format', 'json', '--root', 'here', '--format', 'sarif', '--root', 'there'], DEMO_REPO)).toThrow(refused('--format "json"', '--format "sarif"'));
    expect(() => parseArgs(['--format', 'json', '--format', 'sarif', '--format', 'github'], DEMO_REPO)).toThrow(refused('--format "json"', '--format "sarif"'));
  });

  it('takes two options that each take a value and ask for two things', () => {
    expect(parseArgs(['--root', 'src', '--format', 'sarif', '--engine', 'js', '--max-snippets', '2', '--concurrency', '2'], DEMO_REPO)).toMatchObject({
      format: 'sarif',
      engine: 'javascript',
      maxSnippets: 2,
      concurrency: 2,
    });
    // One number for two options is two things asked.
    expect(parseArgs(['--max-snippets', '2', '--concurrency', '3'], DEMO_REPO)).toMatchObject({ maxSnippets: 2, concurrency: 3 });
    expect(parseArgs(['impact', 'src', '--depth', '3', '--root', 'src'], DEMO_REPO)).toMatchObject({ depth: 3 });
  });
});

describe('--json beside --format', () => {
  const DOCUMENTS = [[], ['prove'], ['cites']];

  it('is taken with --format json, in either order and any case: one thing asked twice', () => {
    for (const command of [...DOCUMENTS, ...ASKS]) {
      const said = command.join(' ');
      const json = parseArgs([...command, '--json'], DEMO_REPO);
      expect(json, said).toMatchObject({ format: 'json', json: true });
      expect(parseArgs([...command, '--json', '--format', 'json'], DEMO_REPO), said).toEqual(json);
      expect(parseArgs([...command, '--format=JSON', '--json'], DEMO_REPO), said).toEqual(json);
      expect(parseArgs([...command, '--json', '--json'], DEMO_REPO), said).toEqual(json);
      expect(parseArgs([...command, '--format', 'json'], DEMO_REPO), said).toEqual(json);
    }
  });

  it.each(['sarif', 'github', 'gitlab', 'human'])('is refused with --format %s, in either order, on every command that writes both', (format) => {
    for (const command of DOCUMENTS) {
      const said = command.join(' ');
      expect(() => parseArgs([...command, '--json', '--format', format], DEMO_REPO), said).toThrow(refused('--json', `--format "${format}"`));
      expect(() => parseArgs([...command, '--format', format, '--json'], DEMO_REPO), said).toThrow(refused(`--format "${format}"`, '--json'));
      expect(() => parseArgs([...command, '--json', '--spec', 'docs', `--format=${format}`, '--json'], DEMO_REPO), said).toThrow(refused('--json', `--format "${format}"`));
    }
  });

  it('is refused with --format human by a command that lists, which writes those two', () => {
    for (const command of ASKS) {
      expect(() => parseArgs([...command, '--json', '--format', 'human'], DEMO_REPO)).toThrow(refused('--json', '--format "human"'));
      expect(() => parseArgs([...command, '--format', 'human', '--json'], DEMO_REPO)).toThrow(refused('--format "human"', '--json'));
    }
  });
});

describe('what a line is refused for first', () => {
  it('is a value that is refused by itself, and an option the command does not take', () => {
    expect(() => parseArgs(['--format', 'json', '--format', 'yaml'], DEMO_REPO)).toThrow(/^Unknown format "yaml"\./);
    expect(() => parseArgs(['--concurrency', '1', '--concurrency', '0'], DEMO_REPO)).toThrow(/^Option --concurrency expects 1 or more/);
    expect(() => parseArgs(['--max-snippets', '1', '--max-snippets', 'many'], DEMO_REPO)).toThrow(/^Option --max-snippets expects a non-negative integer/);
    expect(() => parseArgs(['--engine', 'js', '--engine', 'grep'], DEMO_REPO)).toThrow(UsageError);
    expect(() => parseArgs(['--root', 'here', '--root', ''], DEMO_REPO)).toThrow(/^Option --root expects a directory/);
    expect(() => parseArgs(['--root', 'here', '--root', 'there', '--bogus'], DEMO_REPO)).toThrow(/^Unknown option "--bogus"\./);
    expect(() => parseArgs(['mcp', '--json', '--format', 'sarif'], DEMO_REPO)).toThrow(new UsageError('Option --json does not apply to spec-guard mcp.'));
    expect(() => parseArgs(['mcp', '--format', 'sarif', '--json'], DEMO_REPO)).toThrow(new UsageError('Option --format does not apply to spec-guard mcp.'));
    expect(() => parseArgs(['query', 'src', '--json', '--format', 'sarif'], DEMO_REPO)).toThrow(/^spec-guard query has no sarif format/);
    expect(() => parseArgs(['--depth', '1', '--depth', '2'], DEMO_REPO)).toThrow(new UsageError('Option --depth applies only to spec-guard impact.'));
    expect(() => parseArgs(['prove', '--engine', 'js', '--engine', 'rg'], DEMO_REPO)).toThrow(new UsageError('Option --engine does not apply to spec-guard prove.'));
  });

  it('is an option beside its own opposite, and then two values, and then what a watch session does not take', () => {
    expect(() => parseArgs(['--format', 'json', '--no-strict', '--format', 'sarif', '--strict'], DEMO_REPO)).toThrow(
      new UsageError('Option --strict is given beside --no-strict, and one of the two would go unread. Give one of the two.'),
    );
    expect(() => parseArgs(['--watch', '--format', 'human', '--format', 'json'], DEMO_REPO)).toThrow(refused('--format "human"', '--format "json"'));
    expect(() => parseArgs(['--watch', '--format', 'human', '--json'], DEMO_REPO)).toThrow(refused('--format "human"', '--json'));
    // One format asked twice, which a session does not take, is refused for that.
    expect(() => parseArgs(['--watch', '--json', '--format', 'json'], DEMO_REPO)).toThrow(/^Option --json does not apply to spec-guard --watch: /);
    expect(parseArgs(['--watch', '--format', 'human', '--format', 'HUMAN'], DEMO_REPO)).toMatchObject({ watch: true, format: 'human' });
  });
});

describe('a list, and an option that takes no value, given twice', () => {
  it('keeps every spec pattern, a pattern given twice among them', () => {
    expect(parseArgs(['--spec', 'docs', '--spec', 'adr'], DEMO_REPO).patterns).toEqual(['docs', 'adr']);
    expect(parseArgs(['--spec', 'docs', '--spec', 'docs'], DEMO_REPO).patterns).toEqual(['docs', 'docs']);
    expect(parseArgs(['docs', '--spec', 'docs', 'adr'], DEMO_REPO).patterns).toEqual(['docs', 'adr', 'docs']);
    expect(parseArgs(['query', 'src', '--spec', 'docs', '--spec=adr'], DEMO_REPO).patterns).toEqual(['docs', 'adr']);
  });

  it('keeps every exclusion, and --exclude= beside one adds nothing to the list it clears', () => {
    expect(parseArgs(['--exclude', 'dist', '--exclude', 'gen,tmp'], DEMO_REPO).exclude).toEqual(['dist', 'gen', 'tmp']);
    expect(parseArgs(['--exclude', 'dist', '--exclude', 'dist'], DEMO_REPO).exclude).toEqual(['dist', 'dist']);
    for (const line of [['--exclude=', '--exclude', 'dist'], ['--exclude', 'dist', '--exclude=']]) {
      const read = parseArgs(line, DEMO_REPO);
      expect([read.exclude, read.fromCommandLine.has('exclude')], line.join(' ')).toEqual([['dist'], true]);
    }
  });

  it('reads an option that takes no value as once', () => {
    for (const option of ['--verbose', '--fail-fast', '--allow-empty', '--print-baseline', '--watch', '--help', '--version']) {
      expect(parseArgs([option, option], DEMO_REPO), option).toEqual(parseArgs([option], DEMO_REPO));
    }
    expect(parseArgs(['-v', '--verbose'], DEMO_REPO)).toEqual(parseArgs(['--verbose'], DEMO_REPO));
    expect(parseArgs(['-h', '--help'], DEMO_REPO)).toEqual(parseArgs(['--help'], DEMO_REPO));
  });
});

describe('a line with two values, run', () => {
  const FILES = {
    'docs/adr/0001-kept.md': '# ADR-0001: Kept\n\n<!-- @assert-absence target="src" symbol="Removed" -->\n',
    'src/a.ts': '// As ADR-0001 has it.\nexport const kept = 1;\n',
  };

  it('is exit 2 and the one line, with nothing run, for each command', async () => {
    const root = await tree(FILES);
    const cases: Array<[string[], string, string]> = [
      [['--json', '--format', 'sarif'], '--json', '--format "sarif"'],
      [['--format', 'sarif', '--json'], '--format "sarif"', '--json'],
      [['prove', '--format', 'github', '--format', 'gitlab'], '--format "github"', '--format "gitlab"'],
      [['cites', '--format', 'json', '--format', 'human'], '--format "json"', '--format "human"'],
      [['query', 'src/a.ts', '--json', '--format', 'human'], '--json', '--format "human"'],
      [['impact', 'src/a.ts', '--depth', '1', '--depth', '2'], '--depth "1"', '--depth "2"'],
      [['mcp', '--max-snippets', '1', '--max-snippets', '2'], '--max-snippets "1"', '--max-snippets "2"'],
      [['--engine', 'js', '--engine', 'auto'], '--engine "js"', '--engine "auto"'],
    ];
    for (const [line, first, second] of cases) {
      const { io, out, err } = createIO({ cwd: root });
      expect(await main([...line, '--root', root], io), line.join(' ')).toBe(EXIT_ERROR);
      expect([out, err], line.join(' ')).toEqual([[], [`spec-guard: ${refusal(first, second)}`]]);
    }
  });

  it('runs in neither root where two are named, and starts no session', async () => {
    const here = await tree(FILES);
    const there = await tree({ ...FILES, 'src/a.ts': 'export const Removed = 1;\n' });
    for (const command of [[], ['prove'], ['cites'], ['query', 'src/a.ts'], ['impact', 'src/a.ts'], ['mcp']]) {
      const { io, out, err } = createIO({ cwd: here });
      expect(await main([...command, '--root', here, '--root', there], io), command.join(' ')).toBe(EXIT_ERROR);
      expect([out, err], command.join(' ')).toEqual([[], [`spec-guard: ${refusal(`--root ${JSON.stringify(here)}`, `--root ${JSON.stringify(there)}`)}`]]);
    }
    let watched = 0;
    const { io, out, err } = createIO({
      cwd: here,
      watch: () => {
        watched += 1;
        return { close: () => {} };
      },
    });
    expect(await main(['--watch', '--root', here, '--root', there], io)).toBe(EXIT_ERROR);
    expect([out, err.length, watched]).toEqual([[], 1, 0]);
  });

  it('runs once where the one root is named twice, and writes the one document where one format is', async () => {
    const root = await tree(FILES);
    const once = createIO({ cwd: root });
    expect(await main(['--root', root, '--json'], once.io)).toBe(EXIT_OK);
    const twice = createIO({ cwd: root });
    expect(await main(['--root', root, '--root', `${root}/`, '--json', '--format', 'json'], twice.io)).toBe(EXIT_OK);
    const document = (out: string[]): unknown => ({ ...(JSON.parse(out.join('\n')) as { results: Array<Record<string, unknown>> }), durationMs: 0, results: [] });
    expect(twice.out).toHaveLength(1);
    expect(document(twice.out)).toEqual(document(once.out));
    expect(twice.err).toEqual([]);
  });
});

describe('--help and --version beside a line with two values', () => {
  const LINES: Array<[command: string[], options: string[], first: string, second: string]> = [
    [[], ['--json', '--format', 'sarif'], '--json', '--format "sarif"'],
    [['prove'], ['--format', 'json', '--format', 'sarif'], '--format "json"', '--format "sarif"'],
    [['cites'], ['--root', 'here', '--root', 'there'], '--root "here"', '--root "there"'],
    [['impact', 'src'], ['--depth', '1', '--depth', '2'], '--depth "1"', '--depth "2"'],
  ];

  it('are not answered: the line is refused first, wherever on it they stand', async () => {
    for (const [command, options, first, second] of LINES) {
      for (const asked of ['--help', '-h', '--version']) {
        for (const argv of [[...command, ...options, asked], [...command, asked, ...options]]) {
          const { io, out, err } = createIO();
          expect(await main(argv, io), argv.join(' ')).toBe(EXIT_ERROR);
          expect([out, err], argv.join(' ')).toEqual([[], [`spec-guard: ${refusal(first, second)}`]]);
        }
      }
    }
  });

  it('are refused the same way beside a pair: one rule for every wrong command line', async () => {
    const pair = 'spec-guard: Option --strict is given beside --no-strict, and one of the two would go unread. Give one of the two.';
    for (const asked of ['--help', '-h', '--version']) {
      for (const argv of [['--strict', '--no-strict', asked], [asked, '--no-strict', '--strict']]) {
        const { io, out, err } = createIO();
        expect(await main(argv, io), argv.join(' ')).toBe(EXIT_ERROR);
        expect([out, err], argv.join(' ')).toEqual([[], [pair]]);
      }
    }
  });

  it('are answered for a line that asks one thing twice, which is no wrong line', async () => {
    const lines = [
      ['--json', '--format', 'json'],
      ['--format', 'sarif', '--format', 'SARIF'],
      ['--root', 'here', '--root', 'here'],
      ['--spec', 'docs', '--spec', 'docs'],
    ];
    for (const line of lines) {
      for (const [asked, answer] of [['--help', HELP], ['-h', HELP], ['--version', version()]] as const) {
        for (const argv of [[...line, asked], [asked, ...line]]) {
          const { io, out, err } = createIO();
          expect(await main(argv, io), argv.join(' ')).toBe(EXIT_OK);
          expect([out, err], argv.join(' ')).toEqual([[answer], []]);
        }
      }
    }
  });

  it('are not answered for a line refused for anything else', () => {
    expect(() => parseArgs(['--format', 'json', '--format', 'yaml', '--help'], DEMO_REPO)).toThrow(/^Unknown format "yaml"\./);
    expect(() => parseArgs(['--version', '--concurrency', '1', '--concurrency', '0'], DEMO_REPO)).toThrow(/^Option --concurrency expects 1 or more/);
  });
});

describe('--help beside --version', () => {
  const COMMANDS = [[], ['--watch'], ['prove'], ['cites'], ['query', 'src'], ['impact', 'src'], ['mcp']];
  const PAIRS = [
    ['--help', '--version'],
    ['--version', '--help'],
    ['-h', '--version'],
    ['--version', '-h'],
  ];

  it('is refused, in either order, on every command and wherever on the line the two stand', async () => {
    for (const command of COMMANDS) {
      for (const [first, second] of PAIRS) {
        for (const argv of [
          [...command, first!, second!],
          [...command, first!, '--root', DEMO_REPO, second!],
          [...command, '--root', DEMO_REPO, first!, second!],
        ]) {
          const { io, out, err } = createIO();
          expect(await main(argv, io), argv.join(' ')).toBe(EXIT_ERROR);
          expect([out, err], argv.join(' ')).toEqual([[], [`spec-guard: ${refusal(first!, second!)}`]]);
        }
      }
    }
  });

  it('answers either alone, given twice, or beside its other spelling', async () => {
    for (const [argv, answer] of [
      [['--help'], HELP],
      [['--help', '--help'], HELP],
      [['-h', '--help'], HELP],
      [['--version'], version()],
      [['--version', '--version'], version()],
      [['query', '--version', 'src', '--version'], version()],
    ] as const) {
      const { io, out, err } = createIO();
      expect(await main(argv, io), argv.join(' ')).toBe(EXIT_OK);
      expect([out, err], argv.join(' ')).toEqual([[answer], []]);
    }
  });

  it('is refused after what is wrong with one option and after a pair, and named where it comes first of two values', () => {
    expect(() => parseArgs(['--help', '--version', '--bogus'], DEMO_REPO)).toThrow(/^Unknown option "--bogus"\./);
    expect(() => parseArgs(['--help', '--version', '--strict', '--no-strict'], DEMO_REPO)).toThrow(refused('--strict', '--no-strict'));
    expect(() => parseArgs(['--root', 'a', '--root', 'b', '--help', '--version'], DEMO_REPO)).toThrow(refused('--root "a"', '--root "b"'));
    expect(() => parseArgs(['--help', '--version', '--root', 'a', '--root', 'b'], DEMO_REPO)).toThrow(refused('--help', '--version'));
    expect(() => parseArgs(['--watch', '--json', '--help', '--version'], DEMO_REPO)).toThrow(refused('--help', '--version'));
  });
});

describe('the help', () => {
  it('says it beside the other inputs that are refused', () => {
    expect(HELP).toContain(
      [
        '  So is an option that takes one value and is given two, since the first of',
        '  them would go unread: --root a --root b, --format json --format sarif, and',
        '  --json beside a --format that names another format. The same value given',
        '  twice is read as once, as --json beside --format json is, and on Windows',
        '  a drive letter names its volume in either case, so --root C:\\x beside',
        '  --root c:\\x is one root. --spec and --exclude are lists, and each use adds',
        '  to its list. Such a line is refused with --help or --version on it too, as',
        '  a line with a pair is. And --help beside --version is refused, in either',
        '  order: a line gets one answer.',
      ].join('\n'),
    );
  });
});

describe('a drive letter', () => {
  // A Windows path, on whichever host the suite runs.
  const windows = (drive: string, ...names: string[]): string => path.win32.join(`${drive}:${path.win32.sep}`, ...names);
  /** The same path with its drive letter in the other case. */
  const otherCase = (root: string): string => `${root[0] === root[0]!.toUpperCase() ? root[0]!.toLowerCase() : root[0]!.toUpperCase()}${root.slice(1)}`;
  const FILES = {
    'docs/adr/0001-kept.md': '# ADR-0001: Kept\n\n<!-- @assert-absence target="src" symbol="Removed" -->\n',
    'src/a.ts': 'export const kept = 1;\n',
  };

  it('names its volume in either case, and the rest of the path is compared as it resolves', () => {
    // spec-core's ADR-0005, amended 2026-10-19, from Microsoft's Naming
    // Files, Paths, and Namespaces: D:\ and d:\ name one volume, and NTFS
    // can be made to tell other names apart by case.
    expect(comparedRoot(windows('C', 'x'))).toBe(comparedRoot(windows('c', 'x')));
    expect(comparedRoot(windows('C', 'x'))).not.toBe(comparedRoot(windows('C', 'X')));
    expect(comparedRoot(windows('c', 'x'))).not.toBe(comparedRoot(windows('d', 'x')));
    expect(comparedRoot('/srv/x')).not.toBe(comparedRoot('/srv/X'));
  });

  it.runIf(process.platform === 'win32')('takes a root named with its drive letter in each case as one root, in either order, on every command', async () => {
    const root = await tree(FILES);
    const other = otherCase(root);
    for (const command of [[], ['prove'], ['cites'], ['query', 'src/a.ts'], ['impact', 'src/a.ts']]) {
      for (const [first, second] of [
        [root, other],
        [other, root],
      ]) {
        const { io, err } = createIO({ cwd: root });
        expect(await main([...command, '--root', first!, '--root', second!], io), command.join(' ')).toBe(EXIT_OK);
        expect(err, command.join(' ')).toEqual([]);
      }
    }
    expect(parseArgs(['--root', windows('C', 'x'), '--root', windows('c', 'x')], DEMO_REPO)).toMatchObject({ root: windows('c', 'x') });
    // Two directories, and one written with the rest of its path in another
    // case, are refused as they were.
    const second = (written: string) => `--root ${JSON.stringify(written)}`;
    expect(() => parseArgs(['--root', windows('C', 'x'), '--root', windows('C', 'X')], DEMO_REPO)).toThrow(refused(second(windows('C', 'x')), second(windows('C', 'X'))));
    expect(() => parseArgs(['--root', windows('C', 'x'), '--root', windows('d', 'x')], DEMO_REPO)).toThrow(refused(second(windows('C', 'x')), second(windows('d', 'x'))));
  });

  it.runIf(process.platform !== 'win32')('is no drive letter elsewhere, where the two are two names in the working directory', () => {
    const second = (written: string) => `--root ${JSON.stringify(written)}`;
    expect(() => parseArgs(['--root', windows('C', 'x'), '--root', windows('c', 'x')], DEMO_REPO)).toThrow(refused(second(windows('C', 'x')), second(windows('c', 'x'))));
  });
});
