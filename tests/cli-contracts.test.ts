/**
 * The command line's edges.
 *
 * Three things here are only visible from outside the process, and so were
 * only half-tested: the version the tool reports (and puts in its SARIF), what
 * it prints when it was invoked wrongly, and the default it takes when nobody
 * passes it an argv at all.
 */

import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { main, parseArgs, version, EXIT_ERROR, EXIT_OK, type CliIO } from '../src/cli.js';
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

  it('is 0.0.0 from a manifest that is missing or names no version, rather than a crash', () => {
    expect(version('../tests/fixtures/does-not-exist.json')).toBe('0.0.0');
    expect(version('../tests/fixtures/manifest-without-version.json')).toBe('0.0.0');
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
      'Unknown format "yaml". Expected human, json, sarif, github or gitlab.',
    );
  });
});

describe('when the invocation is wrong', () => {
  it('prints the message, a blank line, then the help', async () => {
    const { io, err } = createIO();

    expect(await main(['--nonsense'], io)).toBe(EXIT_ERROR);
    // The blank line is what separates the complaint from the wall of help
    // text; without it the two run together and the reason is lost.
    expect(err).toEqual(['spec-guard: Unknown option "--nonsense". Run spec-guard --help.']);
  });
});

describe('an error spec-guard did not expect', () => {
  // The family contract's 2: the answer cannot be trusted. Left to reject, it
  // reached the launcher as Node's uncaught error, exit 1 - "an assertion
  // failed" to a script. A stdout that throws stands for every such error:
  // nothing in a command expects the stream to refuse a write.
  const gone = (): never => {
    throw new Error('the stream is gone');
  };

  it.each([
    ['--help', ['--help']],
    ['--version', ['--version']],
    ['a run', ['docs/adr/0001-passing.md', '--engine', 'js']],
    ['a run, as JSON', ['docs/adr/0001-passing.md', '--engine', 'js', '--json']],
    ['query', ['query', 'src']],
    ['prove', ['prove', 'docs/adr/0001-passing.md']],
    ['cites', ['cites']],
    ['impact', ['impact', 'src']],
  ])('ends %s with exit 2 and its stack on stderr', async (_name, argv) => {
    const { io, out, err } = createIO({ stdout: gone });

    expect(await main(argv, io)).toBe(EXIT_ERROR);
    expect(err).toHaveLength(1);
    // The stack, so a report of it says where: the message alone names no line.
    expect(err[0]).toMatch(/^spec-guard: unexpected error: Error: the stream is gone\n {4}at /);
    expect(out).toEqual([]);
  });

  it('ends the server with exit 2 when its input fails', async () => {
    const stdin = new PassThrough();
    const out: string[] = [];
    const err: string[] = [];
    const { io } = createIO({
      stdin,
      stdout: (text) => out.push(text),
      stderr: (text) => {
        err.push(text);
        // The server says it is up once it listens; its input fails after that.
        if (err.length === 1) setImmediate(() => stdin.destroy(new Error('the pipe broke')));
      },
    });

    expect(await main(['mcp'], io)).toBe(EXIT_ERROR);
    expect(err).toHaveLength(2);
    expect(err[0]).toContain('MCP server on stdio');
    expect(err[1]).toMatch(/^spec-guard: unexpected error: Error: the pipe broke\n {4}at /);
    expect(out).toEqual([]);
  });

  it('reports the message of an error that has no stack', async () => {
    const bare = new Error('no stack on this one');
    delete bare.stack;
    const { io, err } = createIO({
      stdout: () => {
        throw bare;
      },
    });

    expect(await main(['--version'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard: unexpected error: no stack on this one']);
  });

  it('reports a thrown value that is no Error as it reads', async () => {
    const { io, err } = createIO({
      stdout: () => {
        throw 'only a string';
      },
    });

    expect(await main(['--version'], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard: unexpected error: only a string']);
  });
});

describe('a reader that closed the output', () => {
  // `spec-guard impact src --json | head`: the write fails with EPIPE once
  // head has left. The answer was not delivered, which is still 2, and
  // nothing in spec-guard is at fault, so no stack says a defect was found.
  const refused = (code: string) => (): never => {
    throw Object.assign(new Error(`${code}: the write failed`), { code, syscall: 'write' });
  };

  it.each([
    ['--version', ['--version']],
    ['a run', ['docs/adr/0001-passing.md', '--engine', 'js']],
    ['impact, as JSON', ['impact', 'src', '--json']],
  ])('ends %s with exit 2 and one line that says so', async (_name, argv) => {
    const { io, out, err } = createIO({ stdout: refused('EPIPE') });

    expect(await main(argv, io)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard: stdout was closed before all of the output was written']);
    expect(out).toEqual([]);
  });

  it('keeps the stack of a write that failed for any other reason', async () => {
    // A disk that filled up under `> report.json` is not a reader that left.
    const { io, err } = createIO({ stdout: refused('ENOSPC') });

    expect(await main(['--version'], io)).toBe(EXIT_ERROR);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^spec-guard: unexpected error: Error: ENOSPC: the write failed\n {4}at /);
  });

  it('reads the code of the error, not its words', async () => {
    const { io, err } = createIO({
      stdout: () => {
        throw new Error('EPIPE: broken pipe, write');
      },
    });

    expect(await main(['--version'], io)).toBe(EXIT_ERROR);
    expect(err[0]).toMatch(/^spec-guard: unexpected error: Error: EPIPE: broken pipe, write\n {4}at /);
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
