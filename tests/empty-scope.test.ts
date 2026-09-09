/**
 * Assertions that cover nothing.
 *
 * The fourth silent false green. The three in ADR-0007 were about files the
 * walk refused to look at; this one is about a scope that holds no files to
 * look at in the first place. Both produce the same report line - a pass - and
 * only one of them means anything.
 *
 * Every test here has a negative control: the same rule over a scope that does
 * contain files must still pass, or the check is just breaking working specs.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILED, EXIT_OK, main, type CliIO } from '../src/cli.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const run = (root: string, patterns = ['docs/*.md'], options = {}) =>
  runSpecGuard({ patterns, root, engine: 'javascript', ...options });

describe('an assertion whose scope holds no files', () => {
  it('fails when the target directory is empty', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Legacy" -->\n',
      'src/.keep': '',
      'src/notes.md': 'x\n',
    });
    // Narrow it to nothing: the directory exists and has files, but none of
    // them is a .ts file.
    const report = await run(root, ['docs/a.md']);
    expect(report.ok).toBe(true);

    const narrowed = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Legacy" glob="*.ts" -->\n',
      'src/notes.md': 'x\n',
    });
    const narrowedReport = await run(narrowed, ['docs/a.md']);

    expect(narrowedReport.ok).toBe(false);
    expect(narrowedReport.results[0]?.message).toContain('no files were inspected');
    expect(narrowedReport.results[0]?.message).toContain('allow-empty');
  });

  it('fails when exclude has swallowed the whole target', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Legacy" exclude="src/**" -->\n',
      'src/app.ts': 'const x = 1;\n',
    });

    const report = await run(root, ['docs/a.md']);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('no files were inspected');
  });

  it('still passes when the scope holds something', async () => {
    // The negative control. Without this the check above could be satisfied by
    // failing every assertion in the world.
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="Legacy" glob="*.ts" -->\n',
      'src/app.ts': 'const x = 1;\n',
    });

    expect((await run(root, ['docs/a.md'])).ok).toBe(true);
  });

  it('is allowed per assertion with allow-empty', async () => {
    const root = await repo({
      'docs/a.md':
        '<!-- @assert-absence target="services" symbol="Legacy" glob="*.ts" allow-empty="true" reason="no services yet" -->\n',
      'services/README.md': 'coming soon\n',
    });

    expect((await run(root, ['docs/a.md'])).ok).toBe(true);
  });

  it('is allowed for a whole run with allowEmptyScope', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="services" symbol="Legacy" glob="*.ts" -->\n',
      'services/README.md': 'coming soon\n',
    });

    expect((await run(root, ['docs/a.md'])).ok).toBe(false);
    expect((await run(root, ['docs/a.md'], { allowEmptyScope: true })).ok).toBe(true);
  });

  it('rejects a non-boolean allow-empty', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="L" allow-empty="maybe" -->\n',
      'src/app.ts': 'const x = 1;\n',
    });

    const report = await run(root, ['docs/a.md']);

    expect(report.ok).toBe(false);
    expect(report.errors[0]?.message).toContain('must be true or false');
  });
});

describe('an import assertion whose scope holds nothing it can read', () => {
  it('fails when the target has no analysable file', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence target="config" module="app/db/**" -->\n',
      'config/values.yaml': 'key: value\n',
      'config/notes.txt': 'text\n',
    });

    const report = await run(root, ['docs/a.md']);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain(
      'none of the 2 files here are in a language whose imports spec-guard can read',
    );
  });

  it('fails when the target is empty of files entirely', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence target="svc" module="app/db/**" exclude="svc/**" -->\n',
      'svc/handler.py': 'import os\n',
    });

    const report = await run(root, ['docs/a.md']);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('no files were inspected');
  });

  it('still passes when there is something to analyse', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence target="svc" module="app/db/**" -->\n',
      'svc/handler.py': 'import os\n',
    });

    expect((await run(root, ['docs/a.md'])).ok).toBe(true);
  });

  it('is allowed with allow-empty', async () => {
    const root = await repo({
      'docs/a.md':
        '<!-- @assert-import-absence target="config" module="app/db/**" allow-empty="true" -->\n',
      'config/values.yaml': 'key: value\n',
    });

    expect((await run(root, ['docs/a.md'])).ok).toBe(true);
  });
});

describe('the spec file itself is not what makes a scope non-empty', () => {
  it('does not count an excluded spec file as something inspected', async () => {
    // The spec lives inside the target, and is excluded from searching. If
    // exclusion happened after the walk it would still make the scope look
    // populated, and this assertion would pass having read nothing.
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="docs" symbol="Legacy" -->\n',
    });

    const report = await run(root, ['docs/a.md']);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('no files were inspected');
  });

  it('counts it when --include-specs puts it back in scope', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="docs" symbol="Legacy" -->\n',
    });

    expect((await run(root, ['docs/a.md'], { includeSpecs: true })).ok).toBe(true);
  });
});

describe('--allow-empty-scope', () => {
  function createIO(root: string): { io: CliIO; out: string[] } {
    const out: string[] = [];
    return {
      out,
      io: { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: root, isTTY: false },
    };
  }

  it('reaches the run', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="L" glob="*.ts" -->\n',
      'src/notes.md': 'x\n',
    });

    const strict = createIO(root);
    expect(await main(['docs/a.md', '--root', root, '--engine', 'js'], strict.io)).toBe(EXIT_FAILED);
    expect(strict.out.join('\n')).toContain('no files were inspected');

    const lenient = createIO(root);
    expect(
      await main(['docs/a.md', '--root', root, '--engine', 'js', '--allow-empty-scope'], lenient.io),
    ).toBe(EXIT_OK);
  });
});
