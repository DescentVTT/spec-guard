import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { DEMO_REPO, PROJECT_ROOT } from './helpers.js';

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

describe('parseArgs', () => {
  it('defaults to docs/**/*.md with sensible options', () => {
    const options = parseArgs([], DEMO_REPO);
    expect(options).toMatchObject({
      patterns: ['docs/**/*.md'],
      root: DEMO_REPO,
      verbose: false,
      failFast: false,
      json: false,
      engine: 'auto',
      strictTargets: false,
      includeSpecs: false,
      allowEmpty: false,
      maxSnippets: 5,
      concurrency: 8,
    });
  });

  it('collects positional patterns', () => {
    expect(parseArgs(['docs/*.md', 'specs/*.md'], DEMO_REPO).patterns).toEqual(['docs/*.md', 'specs/*.md']);
  });

  it('parses every boolean flag', () => {
    const options = parseArgs(
      ['--verbose', '--fail-fast', '--json', '--strict', '--include-specs', '--allow-empty'],
      DEMO_REPO,
    );
    expect(options).toMatchObject({
      verbose: true,
      failFast: true,
      json: true,
      strictTargets: true,
      includeSpecs: true,
      allowEmpty: true,
    });
  });

  it('supports short flags', () => {
    expect(parseArgs(['-v', '-r', 'sub'], DEMO_REPO)).toMatchObject({
      verbose: true,
      root: path.resolve(DEMO_REPO, 'sub'),
    });
    expect(parseArgs(['-h'], DEMO_REPO).help).toBe(true);
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgs(['--root=sub'], DEMO_REPO).root).toBe(path.resolve(DEMO_REPO, 'sub'));
    expect(parseArgs(['--max-snippets=2'], DEMO_REPO).maxSnippets).toBe(2);
    expect(parseArgs(['--max-snippets', '3'], DEMO_REPO).maxSnippets).toBe(3);
  });

  it.each([
    ['auto', 'auto'],
    ['rg', 'ripgrep'],
    ['ripgrep', 'ripgrep'],
    ['js', 'javascript'],
    ['javascript', 'javascript'],
    ['node', 'javascript'],
    ['RG', 'ripgrep'],
  ])('maps engine %s to %s', (input, expected) => {
    expect(parseArgs(['--engine', input], DEMO_REPO).engine).toBe(expected);
  });

  it('handles colour flags', () => {
    expect(parseArgs(['--color'], DEMO_REPO).color).toBe(true);
    expect(parseArgs(['--no-color'], DEMO_REPO).color).toBe(false);
    expect(parseArgs([], DEMO_REPO).color).toBeUndefined();
  });

  it('treats everything after -- as a pattern', () => {
    expect(parseArgs(['--', '--weird-name.md'], DEMO_REPO).patterns).toEqual(['--weird-name.md']);
  });

  it('treats a lone dash as a pattern', () => {
    expect(parseArgs(['-'], DEMO_REPO).patterns).toEqual(['-']);
  });

  it('clamps concurrency to at least one', () => {
    expect(parseArgs(['--concurrency', '0'], DEMO_REPO).concurrency).toBe(1);
  });

  it.each([
    [['--nope'], 'Unknown option "--nope"'],
    [['--engine', 'grep'], 'Unknown engine "grep"'],
    [['--root'], 'Option --root requires a value'],
    [['--root', '--verbose'], 'Option --root requires a value'],
    [['--max-snippets', 'lots'], 'expects a non-negative integer'],
  ])('rejects %o', (argv, message) => {
    expect(() => parseArgs(argv, DEMO_REPO)).toThrow(UsageError);
    expect(() => parseArgs(argv, DEMO_REPO)).toThrow(message);
  });
});

describe('main', () => {
  it('prints help and exits 0', async () => {
    const { io, out } = createIO();
    expect(await main(['--help'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toBe(HELP);
  });

  it('prints the version and exits 0', async () => {
    const { io, out } = createIO();
    expect(await main(['--version'], io)).toBe(EXIT_OK);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 0 when every assertion holds', async () => {
    const { io, out } = createIO();
    const code = await main(['docs/adr/0001-passing.md', '--engine', 'js'], io);

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('8 passed');
  });

  it('exits 1 when an assertion fails', async () => {
    const { io, out } = createIO();
    const code = await main(['docs/adr/0002-failing.md', '--engine', 'js'], io);

    expect(code).toBe(EXIT_FAILED);
    expect(out.join('\n')).toContain('expected no matches, found 2');
  });

  it('exits 1 when a directive is invalid', async () => {
    const { io } = createIO();
    expect(await main(['docs/adr/0003-invalid.md', '--engine', 'js'], io)).toBe(EXIT_FAILED);
  });

  it('honours --root from another working directory', async () => {
    const { io, out } = createIO({ cwd: PROJECT_ROOT });
    const code = await main(
      ['docs/adr/0001-passing.md', '--root', path.relative(PROJECT_ROOT, DEMO_REPO), '--engine', 'js'],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('8 passed');
  });

  it('emits JSON with --json', async () => {
    const { io, out } = createIO();
    const code = await main(['docs/adr/0002-failing.md', '--engine', 'js', '--json'], io);

    expect(code).toBe(EXIT_FAILED);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.summary.failed).toBe(4);
  });

  it('stops early with --fail-fast', async () => {
    const { io, out } = createIO();
    await main(['docs/adr/0002-failing.md', '--engine', 'js', '--fail-fast', '--json'], io);
    expect(JSON.parse(out.join('\n')).summary).toMatchObject({ total: 1, skipped: 3 });
  });

  it('prints passing assertions with --verbose', async () => {
    const { io, out } = createIO();
    await main(['docs/adr/0001-passing.md', '--engine', 'js', '--verbose'], io);
    expect(out.join('\n')).toContain('@assert-present config/production.json');
  });

  it('errors when no spec file matches', async () => {
    const { io, err } = createIO();
    const code = await main(['docs/**/*.rst', '--engine', 'js'], io);

    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('no spec files matched "docs/**/*.rst"');
  });

  it('tolerates an empty match with --allow-empty', async () => {
    const { io } = createIO();
    expect(await main(['docs/**/*.rst', '--engine', 'js', '--allow-empty'], io)).toBe(EXIT_OK);
  });

  it('still emits JSON when no spec file matches', async () => {
    const { io, out } = createIO();
    const code = await main(['docs/**/*.rst', '--engine', 'js', '--json'], io);

    expect(code).toBe(EXIT_ERROR);
    expect(JSON.parse(out.join('\n')).summary.specs).toBe(0);
  });

  it('exits 2 with usage help on a bad flag', async () => {
    const { io, err } = createIO();
    const code = await main(['--nope'], io);

    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('Unknown option "--nope"');
    expect(err.join('\n')).toContain('Usage');
  });

  it('exits 2 when the requested engine is unavailable', async () => {
    const previous = process.env.SPEC_GUARD_RG;
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    const { resetRipgrepProbe } = await import('../src/engine.js');
    resetRipgrepProbe();

    try {
      const { io, err } = createIO();
      const code = await main(['docs/adr/0001-passing.md', '--engine', 'rg'], io);

      expect(code).toBe(EXIT_ERROR);
      expect(err.join('\n')).toContain('not available on PATH');
    } finally {
      if (previous === undefined) delete process.env.SPEC_GUARD_RG;
      else process.env.SPEC_GUARD_RG = previous;
      resetRipgrepProbe();
    }
  });

  it('colours output when the stream is a TTY', async () => {
    const { io, out } = createIO({ isTTY: true });
    await main(['docs/adr/0002-failing.md', '--engine', 'js'], io);
    expect(out.join('\n')).toContain(String.fromCharCode(27));
  });

  it('honours NO_COLOR from the environment', async () => {
    const { io, out } = createIO({ isTTY: true, env: { NO_COLOR: '1' } });
    await main(['docs/adr/0002-failing.md', '--engine', 'js'], io);
    expect(out.join('\n')).not.toContain(String.fromCharCode(27));
  });

  it('respects --max-snippets', async () => {
    const { io, out } = createIO();
    await main(['docs/adr/0002-failing.md', '--engine', 'js', '--max-snippets', '1'], io);
    expect(out.join('\n')).toContain('1 more match not shown');
  });
});

describe('default IO', () => {
  it('writes to the real stdout when no IO is injected', async () => {
    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalCwd = process.cwd();

    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      process.chdir(DEMO_REPO);
      const code = await main(['--version']);
      expect(code).toBe(EXIT_OK);
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }

    expect(written.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('writes usage errors to the real stderr', async () => {
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(await main(['--definitely-not-a-flag'])).toBe(EXIT_ERROR);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(written.join('')).toContain('Unknown option');
  });
});
