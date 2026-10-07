/**
 * The scripts that replay mutants by hand still find what they replay.
 *
 * ADR-0003 names `scripts/mutation-regex.mjs`, `scripts/mutation-equivalence.mjs`
 * and `scripts/mutation-probe.mjs` as what keeps its measurements
 * reproducible, and asserted only that the files were there. They were, and
 * none of them ran: the regex harness refused from 0.12.0, when six of its
 * nine patterns left `src/parser.ts`, the probe threw from 0.6.0, on a report
 * written by hand that the reporter had outgrown, and the equivalence harness
 * could not read a report page from 0.9.0. Nothing ran them, so nothing said.
 *
 * Each now has a `--check` that holds its inputs to the source, or to the
 * build, and replays nothing. This runs the three, and shows each a tree it
 * has to refuse, since a check that passes everything holds nothing.
 *
 * Not part of a mutation run (vitest.mutation.config.ts): the source there
 * carries every mutant at once, and there is no build.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { reportHtml, type Report } from '../scripts/mutation-shards.mjs';
import { makeTempRepo, PROJECT_ROOT, removeTempRepo } from './helpers.js';

const DIST = join(PROJECT_ROOT, 'dist');
const built = existsSync(join(DIST, 'cli.js'));
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** One run of a script: how it exited and what it said was wrong. */
function check(script: string, ...args: string[]): { code: number | null; err: string; out: string } {
  const run = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts', script), ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true });
  return { code: run.status, err: run.stderr, out: run.stdout };
}

const read = (file: string): string => readFileSync(join(PROJECT_ROOT, file), 'utf8');

describe('scripts/mutation-regex.mjs --check', () => {
  const parser = read('src/parser.ts');
  const against = async (source: string) => check('mutation-regex.mjs', '--check', '--source', join(await tree({ 'parser.ts': source }), 'parser.ts'));

  it('finds each pattern on its table once in src/parser.ts, and no pattern there that the table lacks', () => {
    const { code, err, out } = check('mutation-regex.mjs', '--check');
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toMatch(/\d+ patterns, every one src\/parser\.ts holds, and \d+ mutants of them/);
  });

  it('refuses a source its patterns have gone from, which is how it stood from 0.12.0 to 0.19.1', async () => {
    const { code, err } = await against('export const nothing = 1;\n');
    expect(code).toBe(2);
    expect(err).toContain('appears 0 times as a literal in');
    expect(err).toContain('update the table');
  });

  it('refuses a source with a pattern the table does not have, whose mutants it would never replay', async () => {
    const { code, err } = await against(`${parser}\nexport const EXTRA = /made-up[0-9]+/;\n`);
    expect(code).toBe(2);
    expect(err).toContain('holds /made-up[0-9]+/, which is not on the table');
  });

  it('refuses a pattern the source writes twice, since it could not say which one it mutated', async () => {
    const first = /^const [A-Z_]+ = (\/.+\/[a-z]*);$/m.exec(parser)?.[1];
    expect(first).toBeDefined();
    const { code, err } = await against(`${parser}\nexport const AGAIN = ${first};\n`);
    expect(code).toBe(2);
    expect(err).toContain('appears 2 times as a literal in');
  });

  it('takes a pattern for one only where the source has one: not in a comment, and not in a string', async () => {
    const { code, err } = await against(`${parser}\n// const NOT = /in-a-comment/;\nexport const TEXT = '/in-a-string/';\n`);
    expect({ code, err }).toEqual({ code: 0, err: '' });
  });
});

describe('scripts/mutation-equivalence.mjs --check', () => {
  const engine = read('src/engine.ts');
  /** A report with one survivor and one mutant killed in src/engine.ts, as swept from `source`. */
  const report = (source: string): Report => ({
    schemaVersion: '1',
    thresholds: { high: 98, low: 95, break: 97 },
    files: {
      'src/engine.ts': {
        language: 'typescript',
        source,
        mutants: [
          { id: '1', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Survived', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } } },
          { id: '2', mutatorName: 'ConditionalExpression', replacement: 'false', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } } },
        ],
      },
    },
    // The page holds the tests' sources, and this one quotes the two lines the
    // report sits between.
    testFiles: { 'tests/mutation-shards.test.ts': { source: read('tests/mutation-shards.test.ts'), tests: [] } },
  });

  it('finds the control it runs before any survivor', () => {
    expect(check('mutation-equivalence.mjs', '--check')).toMatchObject({ code: 0, err: '' });
  });

  it('reads the page the merge writes, though a test in it quotes the lines the report sits between', async () => {
    const root = await tree({ 'index.html': reportHtml(report(engine), '/* elements */') });
    const { code, err, out } = check('mutation-equivalence.mjs', '--check', join(root, 'index.html'));
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain('1 survivors in 1 files');
  });

  it('reads the JSON the merge writes beside the page', async () => {
    const root = await tree({ 'mutation.json': JSON.stringify(report(engine)) });
    const { code, err, out } = check('mutation-equivalence.mjs', '--check', join(root, 'mutation.json'));
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain('1 survivors in 1 files');
  });

  it('refuses a report made from another source, whose spans would land on other code', async () => {
    const root = await tree({ 'mutation.json': JSON.stringify(report(`// a line the sweep had and this tree does not\n${engine}`)) });
    const { code, err } = check('mutation-equivalence.mjs', '--check', join(root, 'mutation.json'));
    expect(code).toBe(2);
    expect(err).toContain('src/engine.ts is not the source the report was made from (line 1 differs)');
  });

  it('refuses a file that holds no report', async () => {
    const root = await tree({ 'index.html': '<html>no report here</html>' });
    const { code, err } = check('mutation-equivalence.mjs', '--check', join(root, 'index.html'));
    expect(code).toBe(2);
    expect(err).toContain('is neither a mutation report nor the page that carries one');
  });
});

// Against the build, as the equivalence harness runs it. Requires `npm run build`.
// A run is seven seconds on a quiet machine and was a minute beside two
// replays, so each test has the two minutes the tests that read the whole
// repository have.
describe.skipIf(!built)('scripts/mutation-probe.mjs --check', () => {
  it('runs to its end against the build, every input finding its subject', () => {
    const { code, err, out } = check('mutation-probe.mjs', DIST, '--corpus', PROJECT_ROOT, '--check');
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toMatch(/\d+ observations of /);
  }, 120_000);

  it('refuses a build without an export it reads, where it would have printed "undefined" for both builds', async () => {
    // The build, re-exported module for module, with one module's exports gone.
    const modules = readdirSync(DIST).filter((name) => name.endsWith('.js'));
    const root = await tree(
      Object.fromEntries(modules.map((name) => [name, name === 'text.js' ? 'export {};\n' : `export * from ${JSON.stringify(pathToFileURL(join(DIST, name)).href)};\n`])),
    );
    const { code, err } = check('mutation-probe.mjs', root, '--corpus', PROJECT_ROOT, '--check');
    expect(code).toBe(2);
    expect(err).toMatch(/^mutation-probe: text\.js exports no \w+, which the probe reads$/m);
  }, 120_000);
});
