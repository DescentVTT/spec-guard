/**
 * The command line's edges.
 *
 * Three things here are only visible from outside the process, and so were
 * only half-tested: the version the tool reports (and puts in its SARIF), what
 * it prints when it was invoked wrongly, and the default it takes when nobody
 * passes it an argv at all.
 */

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

import { main, parseArgs, version, EXIT_ERROR, EXIT_OK, HELP, type CliIO } from '../src/cli.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
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

const packageVersion = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

describe('the version it reports', () => {
  it('is the one in package.json, not a placeholder', () => {
    // `pkg.version ?? '0.0.0'` reads as a fallback and mutates into
    // `pkg.version && '0.0.0'`, which reports 0.0.0 for every install that
    // works. A SARIF consumer keys alert history off this.
    expect(version()).toBe(packageVersion);
    expect(version()).not.toBe('0.0.0');
  });

  it('reaches the sarif document', async () => {
    const { io, out } = createIO();
    await main(['docs/adr/0001-passing.md', '--format', 'sarif'], io);
    const parsed = JSON.parse(out.join('\n')) as { runs: Array<{ tool: { driver: { version: string } } }> };

    expect(parsed.runs[0]?.tool.driver.version).toBe(packageVersion);
  });

  it('reaches the sarif document even when no spec matched', async () => {
    const { io, out } = createIO();
    await main(['docs/**/*.rst', '--format', 'sarif'], io);
    const parsed = JSON.parse(out.join('\n')) as { runs: Array<{ tool: { driver: { version: string } } }> };

    expect(parsed.runs[0]?.tool.driver.version).toBe(packageVersion);
  });
});

describe('--format', () => {
  it.each([
    ['human', false],
    ['json', true],
    ['sarif', false],
  ] as Array<[string, boolean]>)('%s sets the legacy json flag to %s', (format, json) => {
    // `--json` is the old spelling of `--format json` and the two have to agree,
    // or a caller that reads `options.json` and a caller that reads
    // `options.format` disagree about the same invocation.
    const options = parseArgs(['--format', format], DEMO_REPO);
    expect(options.format).toBe(format);
    expect(options.json).toBe(json);
  });

  it('is case-insensitive', () => {
    expect(parseArgs(['--format', 'JSON'], DEMO_REPO).json).toBe(true);
  });

  it('names the formats it has when given one it does not', () => {
    expect(() => parseArgs(['--format', 'yaml'], DEMO_REPO)).toThrow(
      'Unknown format "yaml". Expected human, json or sarif.',
    );
  });
});

describe('when the invocation is wrong', () => {
  it('prints the message, a blank line, then the help', async () => {
    const { io, err } = createIO();

    expect(await main(['--nonsense'], io)).toBe(EXIT_ERROR);
    // The blank line is what separates the complaint from the wall of help
    // text; without it the two run together and the reason is lost.
    expect(err).toEqual(['Unknown option "--nonsense". Run spec-guard --help.', '', HELP]);
  });
});

describe('when nothing matched', () => {
  it('lists every pattern it tried, separated', async () => {
    const { io, err } = createIO();

    expect(await main(['docs/**/*.rst', 'adr/**/*.rst'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard: no spec files matched "docs/**/*.rst", "adr/**/*.rst"']);
  });

  it('exits cleanly when that was allowed', async () => {
    const { io } = createIO();
    expect(await main(['docs/**/*.rst', '--allow-empty'], io)).toBe(EXIT_OK);
  });
});

describe('the default argv', () => {
  it('is the arguments after the interpreter and the script', async () => {
    // `process.argv.slice(2)`. Without the slice the interpreter path becomes
    // the first spec pattern, and every invocation that relies on the default
    // silently searches for a file named after node.
    const original = process.argv;
    process.argv = [process.execPath, 'spec-guard', '--version'];
    try {
      const { io, out } = createIO();

      expect(await main(undefined, io)).toBe(EXIT_OK);
      expect(out).toEqual([packageVersion]);
    } finally {
      process.argv = original;
    }
  });
});

describe('--print-baseline', () => {
  it('prints the baseline rather than writing it anywhere', async () => {
    const root = await makeTempRepo({
      'src/a.ts': 'const g = LegacyGateway;\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
    });
    temporary.push(root);
    const { io, out } = createIO({ cwd: root });

    await main(['docs/a.md', '--root', root, '--print-baseline', '--engine', 'js'], io);

    expect(out.join('\n')).toContain('baseline="src/a.ts"');
  });
});
