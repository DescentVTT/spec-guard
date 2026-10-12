/**
 * A spec pattern that matches no file, beside others that do.
 *
 * When every pattern matched nothing, a run has always said so and exited 2.
 * When one of several did, it was dropped without a word and the run reported
 * on the rest: a directory of specs that was renamed left its pattern behind,
 * every rule in it stopped running, and the check stayed green. Each such
 * pattern is now held to what the whole list was held to (ADR-0014, amended
 * 2026-10-11): refused by name where no spec at all is refused, let through
 * and still named where `--allow-empty` lets that through, and named by the
 * commands that carry on. Beside each refusal is the run that must not be.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findCitations } from '../src/cites.js';
import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, type CliIO } from '../src/cli.js';
import { expandSpecPatterns, expandSpecs } from '../src/glob.js';
import { impactOf } from '../src/impact.js';
import type { TreeListener } from '../src/io.js';
import { createMcpHandler, type McpServerOptions } from '../src/mcp.js';
import { proveSpecGuard } from '../src/prove.js';
import { queryRules } from '../src/query.js';
import { runSpecGuard } from '../src/runner.js';
import { createDocumentMemo, readSpecs, unmatchedSpecs } from '../src/specs.js';
import { makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

const RULE = '# ADR-0001: Kept\n\n<!-- @assert-absence target="src" symbol="Removed" -->\n';

/** A tree with one rule that holds, an import to follow, and a directory with no Markdown in it. */
async function tree(extra: Record<string, string> = {}): Promise<string> {
  const root = await makeTempRepo({
    'docs/a.md': RULE,
    'src/a.ts': "import { b } from './b.js';\nexport const kept = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'empty/notes.txt': 'no Markdown here\n',
    ...extra,
  });
  temporary.push(root);
  return root;
}

async function cli(root: string, argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  // A terminal that draws the marks is named, so a report is one text on
  // every platform: a Windows console that names none is drawn in ASCII.
  const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { WT_SESSION: '1' }, cwd: root, isTTY: false };
  return { code: await main(argv, io), out, err };
}

const REFUSED = 'Remove it, or give --allow-empty where a pattern is meant to match nothing.';
const refusal = (pattern: string): string => `spec-guard: the pattern "${pattern}" matched no spec file. ${REFUSED}`;
const allowed = (pattern: string): string => `spec-guard: the pattern "${pattern}" matched no spec file, which --allow-empty lets through.`;

/** What a pattern that matches nothing can be. */
const KINDS: Array<[string, string]> = [
  ['a glob nothing fits', 'gone/**/*.md'],
  ['a file that is not there', 'docs/gone.md'],
  ['a directory that is not there', 'gone'],
  ['a directory that holds no Markdown', 'empty'],
];

describe('the patterns that matched no file, as the specs are read', () => {
  const ROOT = path.resolve('/project');
  const io = memoryIo(ROOT, { 'docs/a.md': RULE, 'docs/adr/b.md': RULE, 'empty/notes.txt': 'no Markdown here\n' });

  it('names each, as written and in the order given, whatever kind of pattern it is', async () => {
    // The last as a Windows shell writes a path: read with forward slashes, named as written.
    const patterns = ['gone', 'docs/**/*.md', 'empty', 'docs/gone.md', 'gone/**/*.md', 'old\\adr'];
    const found = await expandSpecs(patterns, ROOT, undefined, io);

    expect(found.unmatched).toEqual(['gone', 'empty', 'docs/gone.md', 'gone/**/*.md', 'old\\adr']);
    expect(found.files).toEqual([path.join(ROOT, 'docs/a.md'), path.join(ROOT, 'docs/adr/b.md')]);
    // The files alone, as they always were, for a caller that asks for them.
    expect(await expandSpecPatterns(patterns, ROOT, undefined, io)).toEqual(found.files);
  });

  it('names a pattern once, however often it was written', async () => {
    expect((await expandSpecs(['gone', 'docs', 'gone'], ROOT, undefined, io)).unmatched).toEqual(['gone']);
  });

  it('names none that found a file, though another pattern found the same one', async () => {
    // `docs` holds docs/a.md, and each of the others names it or a file beside it again.
    const found = await expandSpecs(['docs', 'docs/a.md', 'docs/*.md', 'docs/adr'], ROOT, undefined, io);

    expect(found.unmatched).toEqual([]);
    expect(found.files).toEqual([path.join(ROOT, 'docs/a.md'), path.join(ROOT, 'docs/adr/b.md')]);
  });

  it('reaches the spec set, read once or through a memo of parsed documents', async () => {
    expect((await readSpecs(['docs', 'gone/*.md'], ROOT, io)).unmatched).toEqual(['gone/*.md']);
    expect((await createDocumentMemo().read(['docs', 'gone/*.md'], ROOT, io)).unmatched).toEqual(['gone/*.md']);
    expect((await readSpecs(['docs'], ROOT, io)).unmatched).toEqual([]);
  });

  it('is a key on a report only when there is a pattern to name', () => {
    const named = ['gone/*.md'];
    const carried = unmatchedSpecs({ unmatched: named });

    expect(carried).toEqual({ unmatchedSpecs: ['gone/*.md'] });
    // A copy: a report is not changed by what is done to the spec set later.
    expect(carried.unmatchedSpecs).not.toBe(named);
    expect(unmatchedSpecs({ unmatched: [] })).toEqual({});
    // A spec set a caller of the API built before the field was there.
    expect(unmatchedSpecs({})).toEqual({});
  });
});

describe('a run with a pattern that matched no file beside one that did', () => {
  it.each(KINDS)('is refused in one line that names it, with nothing on stdout: %s', async (_, pattern) => {
    const root = await tree();

    expect(await cli(root, ['docs', pattern])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal(pattern)] });
    expect(await cli(root, ['--spec', pattern, '--spec', 'docs/a.md'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal(pattern)] });
  });

  it('names every such pattern in the one line', async () => {
    const root = await tree();

    expect((await cli(root, ['gone', 'docs', 'old/*.md'])).err).toEqual([
      'spec-guard: the patterns "gone", "old/*.md" matched no spec file. Remove them, or give --allow-empty where a pattern is meant to match nothing.',
    ]);
  });

  it('says where to remove it from when a configuration wrote it', async () => {
    const own = await tree({ '.spec-guard.json': JSON.stringify({ specs: ['docs/**/*.md', 'gone/**/*.md'] }) });
    const manifest = await tree({ 'package.json': JSON.stringify({ specGuard: { specs: ['docs', 'gone'] } }) });

    expect(await cli(own, [])).toEqual({
      code: EXIT_ERROR,
      out: [],
      err: ['spec-guard: the pattern "gone/**/*.md" matched no spec file. Remove it from "specs" in .spec-guard.json, or give --allow-empty where a pattern is meant to match nothing.'],
    });
    expect((await cli(manifest, [])).err).toEqual([
      'spec-guard: the pattern "gone" matched no spec file. Remove it from "specs" in package.json, or give --allow-empty where a pattern is meant to match nothing.',
    ]);
    // Patterns on the command line replace the configuration's, and are not its to remove.
    expect((await cli(own, ['docs', 'gone'])).err).toEqual([refusal('gone')]);
  });

  it('is no less refused under --strict, and is not what --allow-empty-scope allows', async () => {
    const root = await tree();

    expect(await cli(root, ['docs', 'gone', '--strict'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    expect(await cli(root, ['docs', 'gone', '--allow-empty-scope'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
  });

  it('is let through by --allow-empty, which still names it, and the rest decides the exit code', async () => {
    const holds = await tree();
    const fails = await tree({ 'docs/b.md': '<!-- @assert-absence target="src" symbol="kept" -->\n' });

    const passed = await cli(holds, ['docs', 'gone', '--allow-empty', '--engine', 'js']);
    expect([passed.code, passed.err]).toEqual([EXIT_OK, [allowed('gone')]]);
    expect(passed.out.join('\n')).toContain('every spec assertion holds');
    const failed = await cli(fails, ['docs', 'gone', '--allow-empty', '--engine', 'js']);
    expect([failed.code, failed.err]).toEqual([EXIT_FAILED, [allowed('gone')]]);
    expect(failed.out.join('\n')).toContain('1 passed · 1 failed');
  });

  it('still writes the document a script reads, with the patterns in it, and exits 2', async () => {
    const root = await tree();

    const json = await cli(root, ['docs', 'gone', 'old/*.md', '--json', '--engine', 'js']);
    expect([json.code, json.err]).toEqual([
      EXIT_ERROR,
      ['spec-guard: the patterns "gone", "old/*.md" matched no spec file. Remove them, or give --allow-empty where a pattern is meant to match nothing.'],
    ]);
    const report = JSON.parse(json.out.join('\n')) as Record<string, unknown>;
    expect(report).toMatchObject({ formatVersion: 1, ok: true, summary: { specs: 1, total: 1, passed: 1 }, specFiles: ['docs/a.md'], unmatchedSpecs: ['gone', 'old/*.md'] });
    // After the files that were read, where a reader of one looks for the other.
    expect(Object.keys(report).slice(6, 8)).toEqual(['specFiles', 'unmatchedSpecs']);

    const sarif = await cli(root, ['docs', 'gone', '--format', 'sarif', '--engine', 'js']);
    expect([sarif.code, sarif.err]).toEqual([EXIT_ERROR, [refusal('gone')]]);
    expect(JSON.parse(sarif.out.join('\n'))).toMatchObject({ version: '2.1.0' });
    const gitlab = await cli(root, ['docs', 'gone', '--format', 'gitlab', '--engine', 'js']);
    expect([gitlab.code, gitlab.out, gitlab.err]).toEqual([EXIT_ERROR, ['[]'], [refusal('gone')]]);

    const through = await cli(root, ['docs', 'gone', '--json', '--allow-empty', '--engine', 'js']);
    expect([through.code, through.err]).toEqual([EXIT_OK, [allowed('gone')]]);
    expect(JSON.parse(through.out.join('\n'))).toMatchObject({ ok: true, unmatchedSpecs: ['gone'] });
  });

  it('gives a person the line alone, though a rule of the rest fails: no report, and none of GitHub\'s commands', async () => {
    const root = await tree({ 'docs/b.md': '<!-- @assert-absence target="src" symbol="kept" -->\n' });

    expect(await cli(root, ['docs', 'gone', '--engine', 'js'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    // A log a person reads, as a terminal is: an annotation for the failing
    // rule would be the report of the rest under another name.
    expect(await cli(root, ['docs', 'gone', '--format', 'github', '--engine', 'js'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    const through = await cli(root, ['docs', 'gone', '--format', 'github', '--engine', 'js', '--allow-empty']);
    expect([through.code, through.err]).toEqual([EXIT_FAILED, [allowed('gone')]]);
    expect(through.out.join('\n')).toContain('::error file=src/a.ts,line=2,title=assert-absence::"kept" must not appear in src');
  });

  it('prints no baseline for a run it refuses, and prints one for a run let through', async () => {
    const root = await tree({ 'docs/b.md': '<!-- @assert-absence target="src" symbol="kept" -->\n' });

    expect(await cli(root, ['docs', 'gone', '--print-baseline', '--engine', 'js'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    // A baseline is text to paste, whatever format the run was asked for.
    expect(await cli(root, ['docs', 'gone', '--print-baseline', '--json', '--engine', 'js'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    const through = await cli(root, ['docs', 'gone', '--print-baseline', '--allow-empty', '--engine', 'js']);
    expect([through.code, through.err]).toEqual([EXIT_FAILED, [allowed('gone')]]);
    expect(through.out).toEqual(['# docs/b.md:1  "kept" must not appear in src\nbaseline="src/a.ts"']);
  });

  it('runs as it did when every pattern matched, and its document has no key for the patterns', async () => {
    const root = await tree();

    const text = await cli(root, ['docs', 'docs/a.md', '--engine', 'js']);
    expect([text.code, text.err]).toEqual([EXIT_OK, []]);
    const json = await cli(root, ['docs', 'docs/*.md', '--json', '--engine', 'js']);
    expect([json.code, json.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(json.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
  });

  it('answers no spec at all as it always has, and its document now holds the patterns', async () => {
    const root = await tree();

    expect(await cli(root, ['gone', 'old/*.md'])).toEqual({ code: EXIT_ERROR, out: [], err: ['spec-guard: no spec files matched "gone", "old/*.md"'] });
    expect(await cli(root, ['gone', '--allow-empty'])).toEqual({ code: EXIT_OK, out: [], err: ['spec-guard: no spec files matched "gone"'] });
    const json = await cli(root, ['gone', 'old/*.md', '--json']);
    expect([json.code, json.err]).toEqual([EXIT_ERROR, []]);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ summary: { specs: 0 }, specFiles: [], unmatchedSpecs: ['gone', 'old/*.md'] });
  });

  it('leaves the pattern spec-guard reads when none is given as it was', async () => {
    const root = await tree();
    await fs.rm(path.join(root, 'docs'), { recursive: true });

    expect(await cli(root, [])).toEqual({ code: EXIT_ERROR, out: [], err: ['spec-guard: no spec files matched "docs/**/*.md"'] });
    expect((await cli(root, ['--allow-empty'])).code).toBe(EXIT_OK);
  });
});

describe('a proof with a pattern that matched no file beside one that did', () => {
  it('is refused as a run is, and let through by --allow-empty', async () => {
    const root = await tree();

    expect(await cli(root, ['prove', 'docs', 'gone'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    const through = await cli(root, ['prove', 'docs', 'gone', '--allow-empty']);
    expect([through.code, through.err]).toEqual([EXIT_OK, [allowed('gone')]]);
    expect(through.out.join('\n')).toContain('every rule in force was seen to fail');
  });

  it('writes none of GitHub\'s commands for a proof it refuses, though it has one to write', async () => {
    // A rule that fails as the tree stands cannot be shown a violation, which a proof notes.
    const root = await tree({ 'docs/b.md': '<!-- @assert-absence target="src" symbol="kept" -->\n' });

    expect(await cli(root, ['prove', 'docs', 'gone', '--format', 'github'])).toEqual({ code: EXIT_ERROR, out: [], err: [refusal('gone')] });
    const through = await cli(root, ['prove', 'docs', 'gone', '--format', 'github', '--allow-empty']);
    expect([through.code, through.err]).toEqual([EXIT_OK, [allowed('gone')]]);
    expect(through.out.join('\n')).toContain('::notice file=docs/b.md,line=1,title=rule-unprovable::');
  });

  it('still writes its document, with the patterns in it, and exits 2', async () => {
    const root = await tree();

    const json = await cli(root, ['prove', 'docs', 'gone', '--json']);
    expect([json.code, json.err]).toEqual([EXIT_ERROR, [refusal('gone')]]);
    const report = JSON.parse(json.out.join('\n')) as Record<string, unknown>;
    expect(report).toMatchObject({ formatVersion: 1, ok: true, summary: { specs: 1, killed: 1 }, specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });
    expect(Object.keys(report).slice(5, 7)).toEqual(['specFiles', 'unmatchedSpecs']);
    const gitlab = await cli(root, ['prove', 'docs', 'gone', '--format', 'gitlab']);
    expect([gitlab.code, gitlab.out, gitlab.err]).toEqual([EXIT_ERROR, ['[]'], [refusal('gone')]]);
  });

  it('proves as it did when every pattern matched, and answers no spec at all as it always has', async () => {
    const root = await tree();

    const all = await cli(root, ['prove', 'docs', 'docs/a.md', '--json']);
    expect([all.code, all.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(all.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
    expect(await cli(root, ['prove', 'gone', 'old'])).toEqual({ code: EXIT_ERROR, out: [], err: ['spec-guard: no spec files matched "gone", "old"'] });
    const none = await cli(root, ['prove', 'gone', '--json', '--allow-empty']);
    expect([none.code, none.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(none.out.join('\n'))).toMatchObject({ summary: { specs: 0 }, unmatchedSpecs: ['gone'] });
  });
});

describe('impact with a pattern that matched no file beside one that did', () => {
  it('writes the dependents, which no spec decides, and is refused for the rules it could not read', async () => {
    const root = await tree();

    const refused = await cli(root, ['impact', 'src/b.ts', '--spec', 'docs', '--spec', 'gone']);
    expect([refused.code, refused.err]).toEqual([EXIT_ERROR, [refusal('gone')]]);
    expect(refused.out.join('\n')).toContain('1 file depends on it, 1 directly');
    const through = await cli(root, ['impact', 'src/b.ts', '--spec', 'docs', '--spec', 'gone', '--allow-empty']);
    expect([through.code, through.err]).toEqual([EXIT_OK, [allowed('gone')]]);
    // The same answer, less how long it took.
    expect(through.out).toHaveLength(1);
    expect(through.out[0]?.split(' read in ')[0]).toBe(refused.out[0]?.split(' read in ')[0]);
  });

  it('writes its document with the patterns in it', async () => {
    const root = await tree();

    const json = await cli(root, ['impact', 'src/b.ts', '--spec', 'docs', '--spec', 'gone', '--json']);
    expect([json.code, json.err]).toEqual([EXIT_ERROR, [refusal('gone')]]);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ formatVersion: 1, specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });
  });

  it('answers as it did when every pattern matched, and when none did', async () => {
    const root = await tree();

    const all = await cli(root, ['impact', 'src/b.ts', '--spec', 'docs', '--spec', 'docs/a.md', '--json']);
    expect([all.code, all.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(all.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
    const none = await cli(root, ['impact', 'src/b.ts', '--spec', 'gone', '--spec', 'old']);
    expect([none.code, none.err]).toEqual([EXIT_ERROR, ['spec-guard: no spec files matched "gone", "old"']]);
    expect(none.out.join('\n')).toContain('no spec files matched, so no rules are shown');
  });
});

describe('a query with a pattern that matched no file beside one that did', () => {
  // A query takes no --allow-empty, and its refusal offers none.
  const final = 'spec-guard: the pattern "gone" matched no spec file. Remove it.';

  it('is refused in one line, since "no rules govern this path" would read the same with its rules and without', async () => {
    const root = await tree();

    expect(await cli(root, ['query', 'src/a.ts', '--spec', 'docs', '--spec', 'gone'])).toEqual({ code: EXIT_ERROR, out: [], err: [final] });
  });

  it('says where to remove it from when a configuration wrote it', async () => {
    const root = await tree({ '.spec-guard.json': JSON.stringify({ specs: ['docs', 'gone', 'old'] }) });

    expect((await cli(root, ['query', 'src/a.ts'])).err).toEqual(['spec-guard: the patterns "gone", "old" matched no spec file. Remove them from "specs" in .spec-guard.json.']);
  });

  it('still writes its document, with the rules it read and the patterns it did not, and exits 2', async () => {
    const root = await tree();

    const json = await cli(root, ['query', 'src/a.ts', '--spec', 'docs', '--spec', 'gone', '--json']);
    expect([json.code, json.err]).toEqual([EXIT_ERROR, [final]]);
    const report = JSON.parse(json.out.join('\n')) as { results: Array<{ rules: unknown[] }> };
    expect(report).toMatchObject({ formatVersion: 1, specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });
    expect(Object.keys(report).slice(2, 4)).toEqual(['specFiles', 'unmatchedSpecs']);
    expect(report.results[0]?.rules).toHaveLength(1);
  });

  it('answers as it did when every pattern matched, and when none did', async () => {
    const root = await tree();

    const all = await cli(root, ['query', 'src/a.ts', '--spec', 'docs', '--spec', 'docs/a.md', '--json']);
    expect([all.code, all.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(all.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
    expect(await cli(root, ['query', 'src/a.ts', '--spec', 'gone'])).toEqual({ code: EXIT_ERROR, out: [], err: ['spec-guard: no spec files matched "gone"'] });
  });
});

describe('a watch session with a pattern that matched no file beside one that did', () => {
  function driven(root: string): { io: CliIO; lines: string[]; stop: () => void; emit: TreeListener } {
    const lines: string[] = [];
    let interrupt = (): void => {};
    let listener: TreeListener = () => {};
    const io: CliIO = {
      stdout: (text) => lines.push(text),
      stderr: (text) => lines.push(`stderr: ${text}`),
      // A terminal is named, as in `cli` above.
      env: { NO_COLOR: '1', WT_SESSION: '1' },
      cwd: root,
      isTTY: false,
      watch: (_root, given) => {
        listener = given;
        return { close: () => {} };
      },
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
    };
    return { io, lines, stop: () => interrupt(), emit: (type, filename) => listener(type, filename) };
  }

  async function until(what: string, condition: () => boolean): Promise<void> {
    for (let waited = 0; !condition(); waited++) {
      if (waited > 4000) throw new Error(`never: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const WAITING = 'spec-guard: the pattern "later/*.md" matched no spec file, watching for one to appear';

  it('carries on, says which pattern it is under the report of the rest, and stops saying so once a file appears', async () => {
    const root = await tree();
    const { io, lines, stop, emit } = driven(root);
    const exit = main(['--watch', 'docs', 'later/*.md'], io);

    await until('the first report', () => lines.length === 1);
    expect(lines[0]).toContain(`every spec assertion holds\n\n${WAITING}\n\nwatching 1 spec · first run · 1 of 1 rule executed`);

    await fs.mkdir(path.join(root, 'later'));
    await fs.writeFile(path.join(root, 'later/b.md'), '<!-- @assert-absence target="src" symbol="Gone" -->\n');
    // What a watcher says of a directory made and a file written into it.
    emit('rename', 'later');
    emit('rename', path.join('later', 'b.md'));
    await until('the second report', () => lines.length === 2);
    expect(lines[1]).toContain('watching 2 specs');
    expect(lines[1]).toContain('2 passed');
    expect(lines[1]).not.toContain('matched no spec file');

    stop();
    expect(await exit).toBe(130);
    expect(lines.join('')).not.toContain('stderr:');
  });

  it('says nothing of patterns when each matched, and waits for a spec as it did when none matched', async () => {
    const root = await tree();
    const all = driven(root);
    const allExit = main(['--watch', 'docs', 'docs/a.md'], all.io);
    await until('the report', () => all.lines.length === 1);
    all.stop();
    expect(await allExit).toBe(130);
    expect(all.lines[0]).not.toContain('matched no spec file');

    const none = driven(root);
    const noneExit = main(['--watch', 'later/*.md', 'gone'], none.io);
    await until('the report', () => none.lines.length === 1);
    none.stop();
    expect(await noneExit).toBe(130);
    expect(none.lines[0]).toContain('spec-guard: no spec files matched, watching for one to appear\n\nwatching 0 specs');
    expect(none.lines[0]).not.toContain('the pattern');
  });
});

describe('the MCP server with a pattern that matched no file beside one that did', () => {
  interface ToolResult {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }

  async function server(root: string, patterns: string[]): Promise<{ tool: (name: string, args: unknown) => Promise<ToolResult>; rules: () => Promise<Record<string, unknown>> }> {
    const options: McpServerOptions = { root, patterns, version: '9.9.9', run: { engine: 'javascript' } };
    const ask = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = (await createMcpHandler(options)({ jsonrpc: '2.0', id: 1, method, params })) as { result: Record<string, unknown> };
      expect(response).toHaveProperty('result');
      return response.result;
    };
    return {
      tool: async (name, args) => (await ask('tools/call', { name, arguments: args })) as unknown as ToolResult,
      rules: async () => JSON.parse(((await ask('resources/read', { uri: 'spec://rules' })) as { contents: Array<{ text: string }> }).contents[0]?.text as string) as Record<string, unknown>,
    };
  }

  const note = (root: string): string =>
    `\n\nNote: the pattern "gone" matched no spec file under ${root}, so this answer holds no rule from it. A --spec the server was started with, or the project's "specs", names documents that are not there.`;

  it('answers from the rest, and says in each answer which pattern it has no rule from', async () => {
    const root = await tree();
    const { tool, rules } = await server(root, ['docs', 'gone']);

    const governing = await tool('get_architectural_rules', { path: 'src/a.ts' });
    expect(governing.isError).toBeUndefined();
    expect(governing.content[0]?.text.endsWith(note(root))).toBe(true);
    expect(governing.content[0]?.text).toContain('docs/a.md');
    expect(governing.structuredContent).toMatchObject({ specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });

    const checked = await tool('check_architecture', {});
    expect(checked.isError).toBeUndefined();
    expect(checked.content[0]?.text.startsWith('Checked all 1 rules in force.')).toBe(true);
    expect(checked.content[0]?.text.endsWith(note(root))).toBe(true);
    expect(checked.structuredContent).toMatchObject({ ok: true, rules: { inForce: 1, checked: 1, passed: 1, failed: 0 }, unmatchedSpecs: ['gone'] });

    const dependents = await tool('get_dependents', { paths: ['src/b.ts'] });
    expect(dependents.content[0]?.text.endsWith(note(root))).toBe(true);
    expect(dependents.structuredContent).toMatchObject({ specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });

    expect(await rules()).toMatchObject({ specFiles: ['docs/a.md'], unmatchedSpecs: ['gone'] });
  });

  it('names several, and none when each matched', async () => {
    const root = await tree();
    const several = await server(root, ['old/*.md', 'docs', 'gone']);
    const all = await server(root, ['docs', 'docs/a.md']);

    expect((await several.tool('get_architectural_rules', { path: 'src/a.ts' })).content[0]?.text).toContain(
      `\n\nNote: the patterns "old/*.md", "gone" matched no spec file under ${root}, so this answer holds no rule from them. `,
    );
    for (const [name, args] of [
      ['get_architectural_rules', { path: 'src/a.ts' }],
      ['check_architecture', {}],
      ['get_dependents', { paths: ['src/b.ts'] }],
    ] as Array<[string, unknown]>) {
      const answer = await all.tool(name, args);
      expect(answer.content[0]?.text).not.toContain('Note:');
      expect(answer.structuredContent).not.toHaveProperty('unmatchedSpecs');
    }
    expect(await all.rules()).not.toHaveProperty('unmatchedSpecs');
  });

  it('answers no spec at all as it always has: an error from two tools, and the dependents with no note', async () => {
    const root = await tree();
    const { tool } = await server(root, ['gone']);
    const none = `No spec files matched "gone" under ${root}. Start the server with --spec <glob> or --root <dir> pointing at the project.`;

    expect(await tool('get_architectural_rules', { path: 'src/a.ts' })).toMatchObject({ isError: true, content: [{ text: none }] });
    expect(await tool('check_architecture', {})).toMatchObject({ isError: true, content: [{ text: none }] });
    const dependents = await tool('get_dependents', { paths: ['src/b.ts'] });
    expect(dependents.content[0]?.text).toContain('no spec files matched, so no rules are shown');
    expect(dependents.content[0]?.text).not.toContain('Note:');
  });
});

describe('cites with a pattern that matched no file beside one that did', () => {
  // A check of citations goes on where a run stops: with no spec at all it
  // has always exited 0 with a note, and 1 under --strict, so one pattern
  // among several is held to that (ADR-0017, amended 2026-10-11).
  const SPECS = ['--spec', 'docs/**/*.md', '--spec', 'rfcs/*.md'];
  const STRICT = ', which --strict refuses';
  const lost = (strict = ''): string =>
    `spec-guard: the pattern "rfcs/*.md" matched no spec file, so no citation of a document under it was looked for${strict}. Remove it.`;
  const ADRS = { id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' };

  /** Two directories of numbered documents, each titled with an id, and a comment that cites one of each. */
  async function kept(extra: Record<string, string> = {}, rfcs = 'rfcs'): Promise<string> {
    const root = await makeTempRepo({
      'docs/adr/0001-kept.md': '# ADR-0001: Kept\n',
      [`${rfcs}/0001-proposed.md`]: '# RFC-0001: Proposed\n',
      'src/a.ts': '// ADR-0001 and RFC-0001\nexport const a = 1;\n',
      ...extra,
    });
    temporary.push(root);
    return root;
  }

  /** The same after `rfcs` was renamed, and its pattern left behind. */
  const renamed = (extra: Record<string, string> = {}): Promise<string> => kept(extra, 'proposals');

  /** A comment citing an RFC nobody wrote: a ghost for as long as the RFCs are a family. */
  const GHOST = { 'src/ghost.ts': '// RFC-0099\n' };

  it('names the pattern after a report that no longer looks for its documents, where it said nothing', async () => {
    const whole = await cli(await kept(GHOST), ['cites', ...SPECS]);
    expect([whole.code, whole.err]).toEqual([EXIT_FAILED, []]);
    expect(whole.out.join('\n')).toContain('src/ghost.ts:1 cites RFC-0099, which no document defines');

    // The ghost is still in the code, and the family it was a ghost of is gone.
    const left = await cli(await renamed(GHOST), ['cites', ...SPECS]);
    expect([left.code, left.err]).toEqual([EXIT_OK, [lost()]]);
    expect(left.out).toHaveLength(1);
    expect(left.out[0]).toMatch(/^spec-guard cites ADR-\{n\} \(1 document matching docs\/adr\/\{n\}\*\.md, read off the specs' titles\)\n/);
    expect(left.out[0]).toMatch(/ every citation names a document in force$/);
  });

  it('fails under --strict, in a line that says why, and passes there when every pattern matched', async () => {
    const strict = await cli(await renamed(), ['cites', ...SPECS, '--strict']);
    expect([strict.code, strict.err]).toEqual([EXIT_FAILED, [lost(STRICT)]]);
    // The report ends on why the check failed, in the clause the line has,
    // where it ended as the report of a check that passed.
    expect(strict.out[0]).toMatch(/\n. the pattern "rfcs\/\*\.md" matched no spec file, so no citation of a document under it was looked for, which --strict refuses$/);
    expect(strict.out[0]).not.toContain('every citation names a document in force');

    expect(await cli(await kept(), ['cites', ...SPECS, '--strict'])).toMatchObject({ code: EXIT_OK, err: [] });
  });

  it('leaves the exit code to what was found when --strict is not given', async () => {
    const root = await renamed({ 'src/ghost.ts': '// ADR-0099\n' });

    expect(await cli(root, ['cites', ...SPECS])).toMatchObject({ code: EXIT_FAILED, err: [lost()] });
    expect(await cli(root, ['cites', 'src/a.ts', ...SPECS])).toMatchObject({ code: EXIT_OK, err: [lost()] });
  });

  it('names every such pattern, and says where to remove them from when a configuration wrote them', async () => {
    const own = await renamed({ '.spec-guard.json': JSON.stringify({ specs: ['old', 'docs/**/*.md', 'rfcs/*.md'] }) });

    expect((await cli(own, ['cites'])).err).toEqual([
      'spec-guard: the patterns "old", "rfcs/*.md" matched no spec file, so no citation of a document under them was looked for. Remove them from "specs" in .spec-guard.json.',
    ]);
    expect((await cli(own, ['cites', '--strict'])).err).toEqual([
      'spec-guard: the patterns "old", "rfcs/*.md" matched no spec file, so no citation of a document under them was looked for, which --strict refuses. Remove them from "specs" in .spec-guard.json.',
    ]);
    // Patterns on the command line replace the configuration's, and are not its to remove.
    expect((await cli(own, ['cites', ...SPECS])).err).toEqual([lost()]);
  });

  it('still writes each document a script reads, the JSON one with the patterns in it', async () => {
    const root = await renamed();

    const json = await cli(root, ['cites', ...SPECS, '--json']);
    expect([json.code, json.err]).toEqual([EXIT_OK, [lost()]]);
    const report = JSON.parse(json.out.join('\n')) as Record<string, unknown>;
    expect(report).toMatchObject({ formatVersion: 1, ok: true, families: [{ id: 'ADR-{n}', source: 'derived' }], unmatchedSpecs: ['rfcs/*.md'] });
    // After the families, which are what the pattern left short.
    expect(Object.keys(report).slice(4, 6)).toEqual(['families', 'unmatchedSpecs']);
    // Nothing failed for it, so nothing says that it did.
    expect(report).not.toHaveProperty('unreadFamily');

    const strict = await cli(root, ['cites', ...SPECS, '--json', '--strict']);
    expect([strict.code, strict.err]).toEqual([EXIT_FAILED, [lost(STRICT)]]);
    const refused = JSON.parse(strict.out.join('\n')) as Record<string, unknown>;
    // Beside `ok`, which of the document's lists the check failed for.
    expect(refused).toMatchObject({ ok: false, unreadFamily: true, unmatchedSpecs: ['rfcs/*.md'], findings: [], gaps: [] });
    expect(Object.keys(refused).slice(0, 4)).toEqual(['formatVersion', 'ok', 'unreadFamily', 'root']);
    // A source file was read, and all of it: this is neither of the other two.
    expect(refused).not.toHaveProperty('nothingRead');
    expect(refused).not.toHaveProperty('unreadComments');

    // Every format that places findings has one for a strict check that
    // failed, on the first spec's first line, with what the line on stderr
    // says and what to do. Each had none, and a red job nothing to show.
    const found = 'the pattern "rfcs/*.md" matched no spec file, so no citation of a document under it was looked for, which --strict refuses';
    const todo = 'remove the pattern, or name the documents comments cite in "cites", which finds each family by its own files';
    const sarif = await cli(root, ['cites', ...SPECS, '--format', 'sarif', '--strict']);
    expect([sarif.code, sarif.err]).toEqual([EXIT_FAILED, [lost(STRICT)]]);
    expect(JSON.parse(sarif.out.join('\n'))).toMatchObject({
      version: '2.1.0',
      runs: [
        {
          results: [
            {
              ruleId: 'unread-family',
              level: 'error',
              message: { text: `${found}\n${todo}` },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'docs/adr/0001-kept.md' }, region: { startLine: 1 } } }],
            },
          ],
        },
      ],
    });
    expect(JSON.parse((await cli(root, ['cites', ...SPECS, '--format', 'sarif'])).out.join('\n'))).toMatchObject({ runs: [{ results: [] }] });
    expect(await cli(root, ['cites', ...SPECS, '--format', 'gitlab'])).toEqual({ code: EXIT_OK, out: ['[]'], err: [lost()] });
    const gitlab = await cli(root, ['cites', ...SPECS, '--format', 'gitlab', '--strict']);
    expect([gitlab.code, gitlab.err]).toEqual([EXIT_FAILED, [lost(STRICT)]]);
    expect(JSON.parse(gitlab.out.join('\n'))).toMatchObject([
      { check_name: 'unread-family', severity: 'major', description: `${found}. ${todo}`, location: { path: 'docs/adr/0001-kept.md', lines: { begin: 1 } } },
    ]);
    expect(await cli(root, ['cites', ...SPECS, '--format', 'github'])).toEqual({ code: EXIT_OK, out: [], err: [lost()] });
    expect(await cli(root, ['cites', ...SPECS, '--format', 'github', '--strict'])).toEqual({
      code: EXIT_FAILED,
      out: [`::error file=docs/adr/0001-kept.md,line=1,title=unread-family::${found}. ${todo}`],
      err: [lost(STRICT)],
    });
  });

  it('only names the pattern where "cites" names the families, which lose nothing by it, under --strict too', async () => {
    const named = 'spec-guard: the pattern "rfcs/*.md" matched no spec file. Remove it from "specs" in .spec-guard.json.';
    const root = await renamed({ '.spec-guard.json': JSON.stringify({ specs: ['docs/**/*.md', 'rfcs/*.md'], cites: [ADRS] }) });

    expect(await cli(root, ['cites'])).toMatchObject({ code: EXIT_OK, err: [named] });
    const strict = await cli(root, ['cites', '--strict', '--json']);
    expect([strict.code, strict.err]).toEqual([EXIT_OK, [named]]);
    expect(JSON.parse(strict.out.join('\n'))).toMatchObject({ ok: true, families: [{ id: 'ADR-{n}', source: 'config' }], unmatchedSpecs: ['rfcs/*.md'] });
    expect(JSON.parse(strict.out.join('\n'))).not.toHaveProperty('unreadFamily');
    // So no format places a finding, and the report ends as one that passed does.
    expect(await cli(root, ['cites', '--strict', '--format', 'gitlab'])).toEqual({ code: EXIT_OK, out: ['[]'], err: [named] });
    expect((await cli(root, ['cites', '--strict'])).out[0]).toMatch(/ every citation names a document in force$/);

    // A family that lost its documents to the rename is refused by its own glob, as it always was.
    const gone = await renamed({
      '.spec-guard.json': JSON.stringify({ specs: ['docs/**/*.md', 'rfcs/*.md'], cites: [ADRS, { id: 'RFC-{n}', files: 'rfcs/{n}-*.md' }] }),
    });
    expect(await cli(gone, ['cites'])).toEqual({
      code: EXIT_ERROR,
      out: [],
      err: ["spec-guard: no document matches rfcs/{n}-*.md, so every citation of RFC-{n} would be reported as a ghost; check the files pattern against the documents' names"],
    });
  });

  it('checks as it did when every pattern matched, and its document has no key for the patterns', async () => {
    const root = await kept();

    // `docs` and the file under it name one document twice, and nothing in vain.
    const json = await cli(root, ['cites', ...SPECS, '--spec', 'docs/adr/0001-kept.md', '--json', '--strict']);
    expect([json.code, json.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(json.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
  });

  it('answers no spec at all as it always has: a note, exit 1 under --strict, and no pattern named', async () => {
    const root = await renamed();
    const NONE = ['--spec', 'gone', '--spec', 'old/*.md'];

    const none = await cli(root, ['cites', ...NONE]);
    expect([none.code, none.err]).toEqual([EXIT_OK, []]);
    expect(none.out[0]).toContain('nothing to look for: "cites" names no documents');
    const json = await cli(root, ['cites', ...NONE, '--json', '--strict']);
    expect([json.code, json.err]).toEqual([EXIT_FAILED, []]);
    const report = JSON.parse(json.out.join('\n')) as Record<string, unknown>;
    expect(report).toMatchObject({ ok: false, nothingRead: true, families: [] });
    expect(report).not.toHaveProperty('unmatchedSpecs');
    // One pattern written twice is one pattern, and matched alone it is no spec at all.
    expect((await cli(root, ['cites', '--spec', 'gone', '--spec', 'gone'])).err).toEqual([]);

    // The pattern spec-guard reads when none is given is nobody's to remove.
    await fs.rm(path.join(root, 'docs'), { recursive: true });
    expect(await cli(root, ['cites'])).toMatchObject({ code: EXIT_OK, err: [] });

    // Families "cites" names need no spec, and a strict check of them passes without one, as it did.
    const configured = await kept({ '.spec-guard.json': JSON.stringify({ specs: ['gone', 'old'], cites: [ADRS] }) });
    const strict = await cli(configured, ['cites', '--strict', '--json']);
    expect([strict.code, strict.err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(strict.out.join('\n'))).not.toHaveProperty('unmatchedSpecs');
  });

  it('takes no --allow-empty, since it refuses nothing for that to let through', async () => {
    expect(await cli(await renamed(), ['cites', ...SPECS, '--allow-empty'])).toEqual({
      code: EXIT_ERROR,
      out: [],
      err: ['spec-guard: Option --allow-empty does not apply to spec-guard cites.'],
    });
  });
});

describe('the package, whose caller reads the report', () => {
  it('names the patterns on each report, and refuses nothing', async () => {
    const root = await tree();
    const patterns = ['docs', 'gone', 'old/*.md'];
    const named = ['gone', 'old/*.md'];

    const run = await runSpecGuard({ patterns, root, engine: 'javascript' });
    expect([run.ok, run.summary.specs, run.unmatchedSpecs]).toEqual([true, 1, named]);
    const proof = await proveSpecGuard({ patterns, root });
    expect([proof.ok, proof.summary.killed, proof.unmatchedSpecs]).toEqual([true, 1, named]);
    const query = await queryRules({ patterns, root, paths: ['src/a.ts'] });
    expect([query.results[0]?.rules.length, query.unmatchedSpecs]).toEqual([1, named]);
    const impact = await impactOf({ patterns, root, paths: ['src/b.ts'] });
    expect([impact.rules.length, impact.unmatchedSpecs]).toEqual([1, named]);
  });

  it('gives a report no key for them when each pattern matched', async () => {
    const root = await tree();
    const patterns = ['docs', 'docs/a.md'];

    expect(await runSpecGuard({ patterns, root, engine: 'javascript' })).not.toHaveProperty('unmatchedSpecs');
    expect(await proveSpecGuard({ patterns, root })).not.toHaveProperty('unmatchedSpecs');
    expect(await queryRules({ patterns, root, paths: ['src/a.ts'] })).not.toHaveProperty('unmatchedSpecs');
    expect(await impactOf({ patterns, root, paths: ['src/b.ts'] })).not.toHaveProperty('unmatchedSpecs');
  });

  it('names them on a check of citations, which a strict one fails for only where it read its families off the specs', async () => {
    const root = await tree({ 'docs/adr/0001-kept.md': '# ADR-0001: Kept\n', 'src/c.ts': '// ADR-0001\n' });
    const patterns = ['docs', 'gone', 'old/*.md'];
    const named = ['gone', 'old/*.md'];
    const families = [{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }];

    const plain = await findCitations({ root, patterns });
    expect([plain.ok, plain.summary.citations, plain.unmatchedSpecs]).toEqual([true, 1, named]);
    const strict = await findCitations({ root, patterns, strict: true });
    expect([strict.ok, strict.summary.citations, strict.unmatchedSpecs]).toEqual([false, 1, named]);
    expect(strict).not.toHaveProperty('nothingRead');
    const configured = await findCitations({ root, patterns, families, strict: true });
    expect([configured.ok, configured.unmatchedSpecs]).toEqual([true, named]);

    // Each pattern matched, and then none did: neither report has the key.
    const whole = await findCitations({ root, patterns: ['docs', 'docs/a.md'], strict: true });
    expect(whole.ok).toBe(true);
    expect(whole).not.toHaveProperty('unmatchedSpecs');
    const none = await findCitations({ root, patterns: ['gone', 'old/*.md'], families, strict: true });
    expect(none.ok).toBe(true);
    expect(none).not.toHaveProperty('unmatchedSpecs');
  });
});

describe('the help', () => {
  it('says what a pattern that matches nothing does, and what --allow-empty lets through', () => {
    expect(HELP).toContain(
      [
        '      --allow-empty       Let a run, prove or impact through when no spec file matched, or when',
        '                          one pattern matched none beside others that did (not an assertion)',
      ].join('\n'),
    );
    expect(HELP).toContain(
      [
        '  A spec pattern that matches no file, beside others that do, is refused the',
        '  same way and by name, since none of its rules was read: a run, prove, impact',
        '  and query exit 2. --allow-empty lets the first three through and still names',
        '  it; --watch and mcp carry on, and say which pattern it is; cites names it',
        '  and goes on, and exits 1 for it under --strict (see cites, below).',
      ].join('\n'),
    );
    expect(HELP).toContain(
      [
        'document exits 2. A spec pattern that matches no file beside others that do is',
        'named on stderr. Without "cites" in the configuration the families are read off',
        'the specs, so one kept under that pattern was not read and no citation of it',
        'was looked for: exit 1 under --strict. Families "cites" names lose nothing.',
      ].join('\n'),
    );
  });
});
