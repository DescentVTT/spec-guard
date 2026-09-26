/**
 * End-to-end tests against the real published entrypoint (bin/spec-guard.js),
 * covering the parts unit tests cannot reach: process exit codes, stdio and the
 * shim's own error handling. Requires `npm run build`.
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEMO_REPO, findTestRipgrep, makeTempRepo, PROJECT_ROOT, removeTempRepo } from './helpers.js';

const BIN = path.join(PROJECT_ROOT, 'bin', 'spec-guard.js');
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'cli.js');
const built = existsSync(DIST_ENTRY);
const rgPath = findTestRipgrep();
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; bin?: string } = {}): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.bin ?? BIN, ...args], {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe.skipIf(!built)('spec-guard executable', () => {
  it('exits 0 and reports success for a spec that holds', async () => {
    const result = await run(['docs/adr/0001-passing.md', '--root', DEMO_REPO]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('8 passed');
    expect(result.stdout).toContain('every spec assertion holds');
    expect(result.stderr).toBe('');
  });

  it('exits 1 and prints actionable failures', async () => {
    const result = await run(['docs/adr/0002-failing.md', '--root', DEMO_REPO]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('docs/adr/0002-failing.md:6');
    expect(result.stdout).toContain('expected no matches, found 2');
    expect(result.stdout).toContain('src/legacy/LegacyPaymentGateway.ts:2:14');
  });

  it('exits 2 on a usage error', async () => {
    const result = await run(['--not-a-flag']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown option');
  });

  it('prints help', async () => {
    const result = await run(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Executable architecture assertions');
  });

  it('emits parseable JSON', async () => {
    const result = await run(['docs/**/*.md', '--root', DEMO_REPO, '--json', '--engine', 'js']);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary).toMatchObject({ specs: 5, total: 19, failed: 5 });
  });

  it('passes the comment paradox, and says why it passed', async () => {
    // The whole feature, through the real binary: a symbol that exists only in
    // the comment recording its removal.
    const root = await makeTempRepo({
      'src/note.ts': '// LegacyThing was removed in ADR-398; do not reintroduce it.\nexport const ok = 1;\n',
      'docs/adr.md': '<!-- @assert-absence target="src" symbol="LegacyThing" -->\n',
    });
    temporary.push(root);

    const result = await run(['docs/adr.md', '--root', root]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 match inside comments was not counted');
    expect(result.stdout).toContain('every spec assertion holds');
  });

  it('fails on a real use of the same symbol', async () => {
    const root = await makeTempRepo({
      'src/note.ts': '// LegacyThing was removed in ADR-398\nexport const value = LegacyThing;\n',
      'docs/adr.md': '<!-- @assert-absence target="src" symbol="LegacyThing" -->\n',
    });
    temporary.push(root);

    const result = await run(['docs/adr.md', '--root', root]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('expected no matches, found 1');
    expect(result.stdout).toContain('src/note.ts:2:22');
  });

  it.runIf(rgPath)('produces the same report with ripgrep as with the fallback', async () => {
    // Both engines are forced explicitly: the demo repo is small enough that
    // `auto` would pick the scanner in both cases and the comparison would be
    // vacuous.
    const withRipgrep = await run(['docs/**/*.md', '--root', DEMO_REPO, '--json', '--engine', 'rg'], {
      env: { SPEC_GUARD_RG: rgPath as string },
    });
    const withFallback = await run(['docs/**/*.md', '--root', DEMO_REPO, '--json', '--engine', 'js'], {
      env: { SPEC_GUARD_RG: path.join(DEMO_REPO, 'definitely-not-ripgrep') },
    });

    const normalise = (raw: string) => {
      const parsed = JSON.parse(raw);
      return {
        ...parsed,
        durationMs: 0,
        engine: 'ignored',
        results: parsed.results.map((result: Record<string, unknown>) => ({
          ...result,
          durationMs: 0,
          engine: 'ignored',
        })),
      };
    };

    expect(JSON.parse(withRipgrep.stdout).engine).toBe('ripgrep');
    expect(JSON.parse(withFallback.stdout).engine).toBe('javascript');
    expect(normalise(withRipgrep.stdout)).toEqual(normalise(withFallback.stdout));
    expect(withRipgrep.code).toBe(withFallback.code);
  });

  it('runs spec-guard against its own documentation', async () => {
    const result = await run(['docs/**/*.md', 'README.md', '--verbose']);

    expect(result.stdout).toContain('spec-guard');
    expect(result.code).toBe(0);
  });
});

describe('launcher', () => {
  it('explains how to build when dist is missing', async () => {
    const root = await makeTempRepo({ 'placeholder.txt': '' });
    temporary.push(root);
    const copied = path.join(root, 'bin', 'spec-guard.js');
    await fs.mkdir(path.dirname(copied), { recursive: true });
    await fs.copyFile(BIN, copied);

    const result = await run(['--help'], { bin: copied });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('npm run build');
  });
});

describe.skipIf(!built)('spec-guard mcp, as a client launches it', () => {
  /** Starts the server, feeds it lines, closes its stdin, and collects what it wrote. */
  function converse(lines: readonly string[], args: readonly string[] = []): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'mcp', ...args], { cwd: PROJECT_ROOT, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(lines.map((line) => `${line}\n`).join(''));
    });
  }

  const SPECS = ['--spec', 'docs/**/*.md', '--spec', 'README.md'];

  it('answers a legacy session over real pipes, writes only protocol to stdout, and exits 0 on EOF', async () => {
    const outcome = await converse(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_architectural_rules","arguments":{"path":"src/runner.ts"}}}',
        '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_dependents","arguments":{"paths":["src/impact.ts"],"depth":1}}}',
      ],
      SPECS,
    );

    expect(outcome.code).toBe(0);
    const messages = outcome.stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(outcome.stdout.endsWith('\n')).toBe(true);
    expect(messages.map((message) => message.id).sort()).toEqual([1, 2, 3, 4]);
    const byId = new Map(messages.map((message) => [message.id, message.result]));
    expect(byId.get(1)).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'spec-guard' } });
    expect((byId.get(2)?.['tools'] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(['get_architectural_rules', 'check_architecture', 'get_dependents']);
    const rules = byId.get(3)?.['structuredContent'] as { results: Array<{ rules: Array<{ kind: string }> }> };
    expect(rules.results[0]?.rules.map((rule) => rule.kind)).toContain('assert-layers');
    // The server's own dependents: the command line and the server import impact.
    const dependents = byId.get(4)?.['structuredContent'] as { results: Array<{ dependents: Array<{ file: string }> }> };
    expect(dependents.results[0]?.dependents.map((dependent) => dependent.file)).toEqual(expect.arrayContaining(['src/cli.ts', 'src/mcp.ts']));
    expect(outcome.stderr).toContain('MCP server on stdio');
  });

  it('answers a modern client that probes with server/discover first', async () => {
    const meta = '"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}';
    const outcome = await converse([
      `{"jsonrpc":"2.0","id":"probe","method":"server/discover","params":{${meta}}}`,
      `{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"get_architectural_rules","arguments":{"path":"src/mcp.ts"},${meta}}}`,
    ], SPECS);

    expect(outcome.code).toBe(0);
    const messages = outcome.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: string; result: Record<string, unknown> });
    const probe = messages.find((message) => message.id === 'probe');
    expect(probe?.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], ttlMs: 0, cacheScope: 'private' });
    expect(messages.find((message) => message.id === 'call')?.result).toMatchObject({ resultType: 'complete', content: [{ type: 'text' }] });
  });
});

describe.skipIf(!built)('spec-guard query, as a process', () => {
  it('prints the rules governing a path and exits 0', async () => {
    const result = await run(['query', 'src/parser.ts', '--spec', 'docs/**/*.md']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('src/parser.ts\n');
    expect(result.stdout).toContain('layer: src/parser.ts');
  });

  it('exits 2 for a path outside the root', async () => {
    const result = await run(['query', '../somewhere-else.ts']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is outside the root');
  });
});

/**
 * The one test of watch mode with the operating system's own watcher in it
 * (ADR-0014). Everything else about a session is driven by fakes; this is where
 * Windows, macOS and Linux each get to report real changes their own way, and
 * the last report a session prints has to be the report a fresh run prints.
 */
describe.skipIf(!built)('spec-guard --watch, with a real watcher', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A report without its timings, which are the one thing two runs may differ in. */
  const untimed = (text: string): string => text.replace(/ · \d+(?:ms|\.\d+s)$/m, '').trim();

  it('reports again after real changes, ends on what a fresh run says, and exits 130 on SIGINT', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': [
        '# Rules',
        '',
        '<!-- @assert-absence target="src" symbol="Legacy" -->',
        '<!-- @assert-structure target="src" glob="*.ts" partner="[name].md" -->',
        '<!-- @assert-present file="README.md" -->',
        '<!-- @assert-import-absence target="src" module="lodash" -->',
        '',
      ].join('\n'),
      'src/a.ts': 'export const a = 1;\n',
      'src/a.md': '',
      'README.md': '',
    });
    temporary.push(root);

    const child = spawn(process.execPath, [BIN, '--watch', '--root', root], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    try {
      const waitFor = async (what: string, predicate: () => boolean): Promise<void> => {
        for (let tries = 0; !predicate(); tries++) {
          if (tries > 1200) throw new Error(`timed out waiting for ${what}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
          await sleep(50);
        }
      };
      await waitFor('the first run', () => stdout.includes('· first run ·'));
      expect(stdout).toContain('4 passed');

      // An in-place edit, a new file, an import, and a deletion.
      await fs.writeFile(path.join(root, 'src/a.ts'), "import _ from 'lodash';\nexport const a = Legacy;\n");
      await fs.mkdir(path.join(root, 'src/deep'));
      await fs.writeFile(path.join(root, 'src/deep/b.ts'), '');
      await fs.rm(path.join(root, 'README.md'));

      await waitFor('a report of all four changes', () => stdout.includes('0 passed · 4 failed'));
      // Then quiet: nothing more for a while, so the last report is the last.
      for (let quiet = 0, seen = stdout.length; quiet < 15; ) {
        await sleep(100);
        if (stdout.length === seen) quiet += 1;
        else [seen, quiet] = [stdout.length, 0];
      }

      const reports = stdout.split(/^--- \d\d:\d\d:\d\d ---$/m).filter((segment) => segment.includes('spec-guard '));
      const last = (reports.at(-1) as string).split('\n\nwatching ')[0] as string;
      const fresh = await run(['--root', root, '--engine', 'js'], { cwd: root });
      expect(fresh.code).toBe(1);
      expect(untimed(last)).toBe(untimed(fresh.stdout));
    } finally {
      if (process.platform === 'win32') {
        // Windows has no SIGINT to send another process; kill() ends it outright.
        child.kill();
        await exited;
      } else {
        child.kill('SIGINT');
        expect(await exited).toEqual({ code: 130, signal: null });
      }
    }
  }, 120_000);
});
