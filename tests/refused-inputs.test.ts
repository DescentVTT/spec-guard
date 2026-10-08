/**
 * An input that is set and names nothing is refused.
 *
 * Each case here ran on 0.20.1 as though the input had not been given, or as
 * its opposite: an empty `--spec` was every spec under the root, an empty
 * `--root` the working directory, `--strict=false` strict, a root that was not
 * there a clean `cites`. The family contract has a tool never fall back to
 * defaults and report clean (spec-core's ADR-0005), so each is exit 2 and one
 * line that names what was set. Beside every refusal is the input that must
 * still be read.
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, HELP, main, parseArgs, UsageError, version, type CliIO } from '../src/cli.js';
import { resetRipgrepProbe } from '../src/engine.js';
import { DEMO_REPO, makeTempRepo, pastEveryBudget, removeTempRepo } from './helpers.js';

const TAB = String.fromCharCode(9);
const temporary: string[] = [];
const originalRg = process.env.SPEC_GUARD_RG;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

function createIO(overrides: Partial<CliIO> = {}): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    cwd: DEMO_REPO,
    isTTY: false,
    ...overrides,
  };
  return { io, out, err };
}

/** A tree with a rule that holds, a file that is no directory, and nothing else. */
async function tree(extra: Record<string, string> = {}): Promise<string> {
  const root = await makeTempRepo({
    'src/a.ts': 'export const kept = 1;\n',
    'docs/a.md': '<!-- @assert-absence target="src" symbol="Removed" -->\n',
    'notes.txt': 'a file\n',
    ...extra,
  });
  temporary.push(root);
  return root;
}

const NO_DIRECTORY = 'Name one, or leave the option out to run in the working directory.';
const NO_VALUE = 'Give it alone or leave it out; an option a configuration can set has an opposite that turns it off, as --no-strict is to --strict.';
const NO_PATH = 'Give it paths or globs, or --exclude= with nothing to clear the list.';
const emptyPattern = (pattern: string): string =>
  `spec-guard: invalid spec pattern ${JSON.stringify(pattern)}: it is empty; write a file, a directory or a glob, or "." for every Markdown file under the root`;

describe('an option that is set and names nothing', () => {
  it.each([
    // An empty path resolves to the working directory.
    [['--root', ''], `Option --root expects a directory, got "". ${NO_DIRECTORY}`],
    [['--root= '], `Option --root expects a directory, got " ". ${NO_DIRECTORY}`],
    [['-r', TAB], `Option -r expects a directory, got "\\t". ${NO_DIRECTORY}`],
    // Separators with nothing between them cleared the configuration's list.
    [['--exclude', ','], `Option --exclude names no path in ",". ${NO_PATH}`],
    [['--exclude', ` ,${TAB}, `], `Option --exclude names no path in " ,\\t, ". ${NO_PATH}`],
    [['--concurrency', '0'], 'Option --concurrency expects 1 or more: a concurrency of 0 would run no search.'],
    // On when given, whatever came after the "=".
    [['--strict=false'], `Option --strict takes no value, got "false". ${NO_VALUE}`],
    [['--no-strict=true'], `Option --no-strict takes no value, got "true". ${NO_VALUE}`],
    [['--default-skips=false'], `Option --default-skips takes no value, got "false". ${NO_VALUE}`],
    [['--allow-empty=false'], `Option --allow-empty takes no value, got "false". ${NO_VALUE}`],
    [['--json=0'], `Option --json takes no value, got "0". ${NO_VALUE}`],
    [['--color=never'], `Option --color takes no value, got "never". ${NO_VALUE}`],
    [['--color='], `Option --color takes no value, got "". ${NO_VALUE}`],
    [['-v=1'], `Option -v takes no value, got "1". ${NO_VALUE}`],
    [['--help=no'], `Option --help takes no value, got "no". ${NO_VALUE}`],
    [['--version=1'], `Option --version takes no value, got "1". ${NO_VALUE}`],
  ])('the command line refuses %j', (argv, message) => {
    expect(() => parseArgs(argv, DEMO_REPO)).toThrow(new UsageError(message));
  });

  it('is told as every wrong invocation is: the line, a blank line, the help', async () => {
    const { io, out, err } = createIO();

    expect(await main(['docs/adr/0001-passing.md', '--strict=false'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual([`spec-guard: Option --strict takes no value, got "false". ${NO_VALUE}`]);
    expect(out).toEqual([]);
  });

  it('takes a value that names something, written either way', () => {
    expect(parseArgs(['--root', 'src'], DEMO_REPO).root).toBe(path.join(DEMO_REPO, 'src'));
    expect(parseArgs(['--root=.'], DEMO_REPO).root).toBe(DEMO_REPO);
    // "=" hands a value to an option that takes one.
    expect(
      parseArgs(['--format=json', '--engine=js', '--max-snippets=0', '--concurrency=2', '--spec=docs/a.md', '--exclude=dist', '--root=src'], DEMO_REPO),
    ).toMatchObject({ format: 'json', engine: 'javascript', maxSnippets: 0, concurrency: 2, patterns: ['docs/a.md'], exclude: ['dist'], root: path.join(DEMO_REPO, 'src') });
    expect(parseArgs(['impact', 'src', '--depth=1'], DEMO_REPO).depth).toBe(1);
  });

  it('still clears the exclusions for --exclude given nothing, which the README says it does', () => {
    // Whitespace alone is nothing: only separators around nothing are a list
    // that was meant to name something.
    for (const nothing of [['--exclude='], ['--exclude', ''], ['--exclude', ' '], ['--exclude', TAB]]) {
      const options = parseArgs(nothing, DEMO_REPO);
      expect(options.exclude).toEqual([]);
      expect(options.fromCommandLine.has('exclude')).toBe(true);
    }
  });

  it('says so in the help, where each option is', () => {
    expect(HELP).toContain('  -r, --root <path>       Codebase root that assertions are resolved against, a directory (default: cwd)');
    expect(HELP).toContain('      --concurrency <n>   Assertions executed in parallel, 1 or more (default: 8)');
    expect(HELP).toContain(
      [
        '      --engine <name>     auto | rg | js  (default: auto - scanner for small trees, ripgrep for big ones)',
        '                          ripgrep is rg on PATH, or the program SPEC_GUARD_RG names; where that',
        '                          is no ripgrep that runs, rg is exit 2 and auto leaves it to the scanner',
      ].join('\n'),
    );
    expect(HELP).toContain('      --color/--no-color  Force colour on or off (NO_COLOR, FORCE_COLOR and TERM=dumb are honoured)');
    expect(HELP).toContain(
      [
        '  An option that is set and names nothing is refused, exit 2, never read as if',
        '  it were not there: an empty --root or spec pattern, --exclude "," (--exclude=',
        '  with nothing clears the list), --concurrency 0, a root that is no directory,',
        '  and a value given to an option that takes none, as in --strict=false.',
      ].join('\n'),
    );
  });
});

describe('a spec pattern that is empty', () => {
  // Read as a path it is the root, and every Markdown file under it.
  it.each([
    ['a run', ['--spec', '']],
    ['a run that names a spec beside it', ['docs/adr/0001-passing.md', '--spec', '']],
    ['a run given it as its pattern', ['']],
    ['a proof', ['prove', '']],
    ['a query', ['query', 'src', '--spec', '']],
    ['a citation check', ['cites', '--spec', '']],
    ['impact', ['impact', 'src', '--spec', '']],
    ['the server', ['mcp', '--spec', '']],
  ] as Array<[string, string[]]>)('is refused in one line before anything runs, for %s', async (_, argv) => {
    const { io, out, err } = createIO();

    expect(await main(argv, io)).toBe(EXIT_ERROR);
    expect(err).toEqual([emptyPattern('')]);
    expect(out).toEqual([]);
  });

  it('is one of whitespace alone too, shown so that it can be seen', async () => {
    const { io, err } = createIO();

    expect(await main(['docs/adr/0001-passing.md', '--spec', ` ${TAB}`], io)).toBe(EXIT_ERROR);
    expect(err).toEqual([emptyPattern(` ${TAB}`)]);
    expect(err[0]).toContain('invalid spec pattern " \\t":');
  });

  it('leaves "." meaning what the refusal says it means: every Markdown file under the root', async () => {
    const root = await tree({ 'README.md': '<!-- @assert-absence target="src" symbol="Gone" -->\n' });
    const { io, out } = createIO({ cwd: root });

    expect(await main(['.', '--engine', 'js', '--json'], io)).toBe(EXIT_OK);
    expect((JSON.parse(out.join('\n')) as { specFiles: string[] }).specFiles).toEqual(['README.md', 'docs/a.md']);
  });
});

describe('a root that is not a directory', () => {
  const refusal = (root: string): string =>
    `spec-guard: the root ${root.replaceAll('\\', '/')} is not a directory. Give --root one that exists, or leave it out to run in the working directory.`;

  it.each([
    ['a run', []],
    // "No spec matched" is what --allow-empty forgives, and a mistyped root is not that.
    ['a run allowed to match nothing', ['--allow-empty']],
    ['a run that writes a document', ['--json']],
    ['a proof allowed to match nothing', ['prove', '--allow-empty']],
    ['a query', ['query', 'src']],
    // Exit 0 on 0.20.1: nothing to look for.
    ['a citation check', ['cites']],
    ['impact', ['impact', 'src', '--allow-empty']],
    // Served on 0.20.1, every answer from a tree that was not there.
    ['the server', ['mcp']],
  ] as Array<[string, string[]]>)('is refused in one line, for %s', async (_, argv) => {
    const root = await tree();
    for (const named of [path.join(root, 'nowhere'), path.join(root, 'notes.txt')]) {
      const { io, out, err } = createIO({ cwd: root });

      expect(await main([...argv, '--root', named], io)).toBe(EXIT_ERROR);
      expect(err).toEqual([refusal(named)]);
      expect(out).toEqual([]);
    }
  });

  it('is not asked of --help and --version, which answer wherever they are run', async () => {
    const root = await tree();
    const { io, out } = createIO({ cwd: root });

    expect(await main(['--root', path.join(root, 'nowhere'), '--version'], io)).toBe(EXIT_OK);
    expect(await main(['--root', path.join(root, 'nowhere'), '--help'], io)).toBe(EXIT_OK);
    expect(out).toEqual([version(), HELP]);
  });

  it('runs in a root that is one, named from the working directory', async () => {
    const root = await tree();
    const { io, out, err } = createIO({ cwd: path.dirname(root) });

    expect(await main(['--root', path.basename(root), '--engine', 'js', '--json'], io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect((JSON.parse(out.join('\n')) as { specFiles: string[] }).specFiles).toEqual(['docs/a.md']);
  });
});

describe('ripgrep asked for, and a variable that names none', () => {
  const refusal = (value: string): string =>
    `spec-guard: SPEC_GUARD_RG is "${value}", which did not answer --version as ripgrep does, and the rg engine was asked for. Set it to the path of an rg that runs, or unset it to use the rg on PATH.`;

  it('is refused for a program that is not ripgrep, where the scanner used to answer with exit 0', async () => {
    // node(1) answers --version, which was all that was asked of it. Past
    // every budget, so that nothing but ripgrep was ever going to search.
    const root = await tree(pastEveryBudget());
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const { io, out, err } = createIO({ cwd: root });

    expect(await main(['docs/a.md', '--engine', 'rg', '--json'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual([refusal(process.execPath)]);
    expect(out).toEqual([]);
  });

  it('is refused the same way when the configuration asked', async () => {
    const root = await tree({ '.spec-guard.json': '{ "engine": "rg" }' });
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const { io, out, err } = createIO({ cwd: root });

    expect(await main(['docs/a.md'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual([refusal(process.execPath)]);
    expect(out).toEqual([]);
  });

  it('does not stop a run that never asked for ripgrep', async () => {
    // --engine js never reads the variable, and neither does a query.
    const root = await tree();
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const scanned = createIO({ cwd: root });
    const asked = createIO({ cwd: root });

    expect(await main(['docs/a.md', '--engine', 'js'], scanned.io)).toBe(EXIT_OK);
    expect(await main(['query', 'src/a.ts', '--spec', 'docs/a.md'], asked.io)).toBe(EXIT_OK);
    expect([...scanned.err, ...asked.err]).toEqual([]);
  });

  it('leaves auto to the scanner, with a warning where a search was handed over and failed', async () => {
    // As documented: under auto a binary that cannot be used is no refusal.
    // A tree under the budget never starts it, so there is nothing to say.
    const small = await tree();
    const big = await tree(pastEveryBudget());
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const under = createIO({ cwd: small });
    const over = createIO({ cwd: big });

    expect(await main(['docs/a.md', '--json'], under.io)).toBe(EXIT_OK);
    expect(await main(['docs/a.md', '--json'], over.io)).toBe(EXIT_OK);
    const quiet = JSON.parse(under.out.join('\n')) as { engine: string; warnings: string[] };
    const warned = JSON.parse(over.out.join('\n')) as { engine: string; warnings: string[] };
    expect(quiet).toMatchObject({ engine: 'javascript', warnings: [] });
    expect(warned.engine).toBe('javascript');
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings[0]).toMatch(/^ripgrep failed, fell back to the JavaScript engine \(ripgrep exited with code \d+: /);
  });
});

describe('colour, as the family reads the conventions', () => {
  const ESC = String.fromCharCode(27);
  const coloured = async (env: NodeJS.ProcessEnv, isTTY: boolean, ...flags: string[]): Promise<boolean> => {
    const { io, out } = createIO({ env, isTTY });
    expect(await main(['docs/adr/0001-passing.md', '--engine', 'js', ...flags], io)).toBe(EXIT_OK);
    return out.join('\n').includes(ESC);
  };

  it('is off for FORCE_COLOR=0 on a terminal, where it used to decide nothing', async () => {
    expect(await coloured({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(await coloured({}, true)).toBe(true);
    // The flag still wins over the variable.
    expect(await coloured({ FORCE_COLOR: '0' }, false, '--color')).toBe(true);
  });

  it('is off for TERM=dumb on a terminal, which was written escapes it had said it does not draw', async () => {
    expect(await coloured({ TERM: 'dumb' }, true)).toBe(false);
    // Unless colour is forced, by the variable or by the flag.
    expect(await coloured({ TERM: 'dumb', FORCE_COLOR: '1' }, true)).toBe(true);
    expect(await coloured({ TERM: 'dumb' }, true, '--color')).toBe(true);
    expect(await coloured({ TERM: 'xterm' }, true)).toBe(true);
  });
});
