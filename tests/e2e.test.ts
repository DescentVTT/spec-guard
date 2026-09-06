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
    expect(parsed.summary).toMatchObject({ specs: 5, total: 19, failed: 4 });
  });

  it.runIf(rgPath)('produces the same report with ripgrep as with the fallback', async () => {
    const withRipgrep = await run(['docs/**/*.md', '--root', DEMO_REPO, '--json'], {
      env: { SPEC_GUARD_RG: rgPath as string },
    });
    const withFallback = await run(['docs/**/*.md', '--root', DEMO_REPO, '--json'], {
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
