/**
 * The documents a long-running server keeps between requests. ADR-0012's
 * amendment of 2026-09-27.
 *
 * A memo can be wrong in two ways that matter: it answers with something a
 * fresh parse would not, or it keeps what it should have let go. So these hold
 * it to a fresh parse - the same rule set, run, impact report and tool answer,
 * with an edit between requests seen by the next one - and to holding only the
 * documents of the spec set read last. `prove` and `cites` read the specs once
 * per command and take no memo, so a fresh parse is all they ever see.
 */

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { impactOf } from '../src/impact.js';
import { nodeIo } from '../src/io.js';
import { createMcpHandler } from '../src/mcp.js';
import { loadRuleSet, queryRules } from '../src/query.js';
import { runSpecGuard } from '../src/runner.js';
import { createDocumentMemo, readSpecs, type DocumentMemo } from '../src/specs.js';
import { makeTempRepo, PROJECT_ROOT, removeTempRepo } from './helpers.js';

const ADR = (n: number, symbol: string) => `# ADR-000${n}: No ${symbol}\n\n<!-- @assert-absence target="src" symbol="${symbol}" -->\n`;

/** A report as a fresh one would be written: durations are the one field two runs never share. */
function comparable(value: unknown): string {
  return JSON.stringify(value, (key, field: unknown) => (key === 'durationMs' ? 0 : field));
}

let root: string;

beforeEach(async () => {
  root = await makeTempRepo({
    'docs/adr/0001-a.md': ADR(1, 'Alpha'),
    'docs/adr/0002-b.md': ADR(2, 'Beta'),
    'src/app.ts': "import { b } from './b.js';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  });
});

afterEach(async () => {
  await removeTempRepo(root);
});

const edit = (relative: string, content: string) => fs.writeFile(path.join(root, relative), content, 'utf8');

describe('createDocumentMemo', () => {
  it('parses a document again only when its bytes change', async () => {
    const memo = createDocumentMemo();
    const first = await memo.read(['docs/**/*.md'], root);
    const second = await memo.read(['docs/**/*.md'], root);
    // The same parse, not an equal one: the file was read again, and its bytes
    // were the bytes it was parsed from.
    expect(second.documents[0]?.directives).toBe(first.documents[0]?.directives);
    expect(second.documents[1]?.directives).toBe(first.documents[1]?.directives);

    await edit('docs/adr/0001-a.md', ADR(1, 'Gamma'));
    const third = await memo.read(['docs/**/*.md'], root);
    expect(third.documents[0]?.directives).not.toBe(first.documents[0]?.directives);
    expect(third.documents[0]?.directives[0]?.attributes['symbol']).toBe('Gamma');
    expect(third.documents[1]?.directives).toBe(first.documents[1]?.directives);
  });

  it('reads as readSpecs reads, document for document, before and after an edit', async () => {
    const memo = createDocumentMemo();
    const read = async () => [comparable(await memo.read(['docs/**/*.md'], root)), comparable(await readSpecs(['docs/**/*.md'], root))];
    const [cold, fresh] = await read();
    expect(cold).toBe(fresh);
    const [warm] = await read();
    expect(warm).toBe(fresh);
    await edit('docs/adr/0002-b.md', `${ADR(2, 'Beta')}<!-- @assert-absence target="src" symbol="Delta" -->\n`);
    const [edited, freshEdited] = await read();
    expect(edited).toBe(freshEdited);
    expect(edited).not.toBe(fresh);
  });

  it('holds the documents of the spec set read last, and forgets one that leaves it', async () => {
    const memo = createDocumentMemo();
    expect(memo.size).toBe(0);
    await memo.read(['docs/**/*.md'], root);
    expect(memo.size).toBe(2);

    // Removed from the tree.
    await fs.rm(path.join(root, 'docs/adr/0002-b.md'));
    await memo.read(['docs/**/*.md'], root);
    expect(memo.size).toBe(1);

    // Edited: the parse of the old bytes goes with the read that did not ask for it.
    await edit('docs/adr/0001-a.md', ADR(1, 'Gamma'));
    await memo.read(['docs/**/*.md'], root);
    expect(memo.size).toBe(1);

    // Left out by the patterns, though still on disk.
    await edit('docs/adr/0003-c.md', ADR(3, 'Delta'));
    await memo.read(['docs/**/*.md'], root);
    expect(memo.size).toBe(2);
    await memo.read(['docs/adr/0003-c.md'], root);
    expect(memo.size).toBe(1);
    await memo.read(['nowhere/*.md'], root);
    expect(memo.size).toBe(0);
  });

  it('keeps each path its own locations when two documents hold the same bytes', async () => {
    await edit('docs/adr/0002-b.md', ADR(1, 'Alpha'));
    const memo = createDocumentMemo();
    await memo.read(['docs/**/*.md'], root);
    const warm = await memo.read(['docs/**/*.md'], root);
    expect(warm.documents.map((document) => document.directives[0]?.location.relativeFile)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0002-b.md']);
    expect(memo.size).toBe(2);
  });

  it('keeps what concurrent reads asked for, since each sweeps in the turn it parsed', async () => {
    // Every file of both reads is released at once, so the two parses run in
    // one turn of the event loop, one after the other. A sweep that waited for
    // a later turn would let the second read's sweep drop what both had asked
    // for, and the memo would be empty.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const io = {
      ...nodeIo,
      readFile: async (file: string) => {
        const bytes = await fs.readFile(file);
        asked += 1;
        if (asked === 4) release();
        await gate;
        return bytes;
      },
    };
    const memo = createDocumentMemo();
    const [a, b] = await Promise.all([memo.read(['docs/**/*.md'], root, io), memo.read(['docs/**/*.md'], root, io)]);
    expect(comparable(a)).toBe(comparable(b));
    expect(memo.size).toBe(2);
    const after = await memo.read(['docs/**/*.md'], root);
    expect(after.documents[0]?.directives).toBe(b.documents[0]?.directives);
  });

  it('reports an unreadable spec on every read, and keeps nothing for it', async () => {
    const memo = createDocumentMemo();
    const io = {
      ...nodeIo,
      readFile: async (file: string) => {
        if (file.endsWith('0002-b.md')) throw new Error('EACCES');
        return fs.readFile(file);
      },
    };
    for (let round = 0; round < 2; round += 1) {
      const specs = await memo.read(['docs/**/*.md'], root, io);
      expect(specs.errors.map((error) => error.message)).toEqual(['Unable to read spec file: EACCES']);
      expect(specs.documents.map((document) => document.relativeFile)).toEqual(['docs/adr/0001-a.md']);
      expect(memo.size).toBe(1);
    }
  });
});

describe('what a caller given the memo answers', () => {
  it('is read from the memo, not beside it', async () => {
    // A memo that answers for one document of the two. Each caller must answer
    // from what the memo read; one that read the specs itself as well, and
    // kept its own reading, would count both rules.
    const one: DocumentMemo = { read: (_patterns, at, io) => readSpecs(['docs/adr/0001-a.md'], at, io), size: 0 };
    const patterns = ['docs/**/*.md'];
    expect((await loadRuleSet({ patterns, root, documents: one })).rules).toHaveLength(1);
    expect((await queryRules({ patterns, root, paths: ['src/app.ts'], documents: one })).results[0]?.rules).toHaveLength(1);
    expect((await runSpecGuard({ patterns, root, engine: 'javascript', documents: one })).summary.total).toBe(1);
    expect((await impactOf({ patterns, root, paths: ['src/b.ts'], documents: one })).rules).toHaveLength(1);
    expect((await runSpecGuard({ patterns, root, engine: 'javascript' })).summary.total).toBe(2);
  });

  it('is what it answers without one, for a query, a run and impact, before and after an edit', async () => {
    const documents = createDocumentMemo();
    const answers = async (memo: typeof documents | undefined) => ({
      rules: comparable(await loadRuleSet({ patterns: ['docs/**/*.md'], root, documents: memo })),
      query: comparable(await queryRules({ patterns: ['docs/**/*.md'], root, paths: ['src/app.ts'], documents: memo })),
      run: comparable(await runSpecGuard({ patterns: ['docs/**/*.md'], root, engine: 'javascript', documents: memo })),
      impact: comparable(await impactOf({ patterns: ['docs/**/*.md'], root, paths: ['src/b.ts'], documents: memo })),
    });

    const fresh = await answers(undefined);
    expect(await answers(documents)).toEqual(fresh);
    expect(await answers(documents)).toEqual(fresh);

    await edit('src/b.ts', 'export const b = "Alpha";\n');
    await edit('docs/adr/0002-b.md', ADR(2, 'Gamma'));
    const freshEdited = await answers(undefined);
    expect(freshEdited.run).not.toBe(fresh.run);
    expect(freshEdited.rules).not.toBe(fresh.rules);
    expect(await answers(documents)).toEqual(freshEdited);
  });

  it('is what it answers without one over this repository\'s own specs', async () => {
    const config = (JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { specGuard: { specs: string[]; exclude: string[] } }).specGuard;
    const options = { patterns: config.specs, root: PROJECT_ROOT, exclude: config.exclude, paths: ['src/parser.ts', 'src'] };
    const documents = createDocumentMemo();
    const fresh = comparable(await queryRules(options));
    expect(comparable(await queryRules({ ...options, documents }))).toBe(fresh);
    expect(comparable(await queryRules({ ...options, documents }))).toBe(fresh);
    expect(documents.size).toBe(JSON.parse(fresh).specFiles.length);
  });
});

describe('the MCP server', () => {
  interface Called {
    result: { structuredContent: { results?: Array<{ rules: Array<{ symbol?: string }> }>; rules?: { checked: number } } };
  }
  const call = async (handle: ReturnType<typeof createMcpHandler>, id: number, name: string, args: Record<string, unknown>): Promise<Called> =>
    (await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })) as unknown as Called;

  it('keeps the documents between requests, whichever tool or resource read them', async () => {
    for (const request of [
      { method: 'tools/call', params: { name: 'get_architectural_rules', arguments: { path: 'src/app.ts' } } },
      { method: 'tools/call', params: { name: 'check_architecture', arguments: {} } },
      { method: 'tools/call', params: { name: 'get_dependents', arguments: { paths: ['src/b.ts'] } } },
      { method: 'resources/list' },
      { method: 'resources/read', params: { uri: 'spec://rules' } },
    ]) {
      const documents = createDocumentMemo();
      const handle = createMcpHandler({ root, patterns: ['docs/**/*.md'], version: '0.0.0', run: { engine: 'javascript' }, documents });
      const answer = await handle({ jsonrpc: '2.0', id: 1, ...request });
      expect(answer, request.method).not.toHaveProperty('error');
      expect(documents.size, JSON.stringify(request)).toBe(2);
    }
  });

  it('answers a request after an edit as the edit reads, in a server that has answered before', async () => {
    const handle = createMcpHandler({ root, patterns: ['docs/**/*.md'], version: '0.0.0', run: { engine: 'javascript' } });
    const symbols = async (id: number) =>
      (await call(handle, id, 'get_architectural_rules', { path: 'src/app.ts' })).result.structuredContent.results?.[0]?.rules.map((rule) => rule.symbol);

    expect(await symbols(1)).toEqual(['Alpha', 'Beta']);
    expect(await symbols(2)).toEqual(['Alpha', 'Beta']);
    await edit('docs/adr/0002-b.md', `${ADR(2, 'Beta')}<!-- @assert-absence target="src" symbol="Gamma" -->\n`);
    expect(await symbols(3)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect((await call(handle, 4, 'check_architecture', {})).result.structuredContent.rules?.checked).toBe(3);
    await fs.rm(path.join(root, 'docs/adr/0001-a.md'));
    expect(await symbols(5)).toEqual(['Beta', 'Gamma']);
    expect((await call(handle, 6, 'check_architecture', {})).result.structuredContent.rules?.checked).toBe(2);
  });
});
