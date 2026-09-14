/**
 * The one door every read goes through. ADR-0014.
 *
 * The claim worth testing is not that `nodeIo` calls `node:fs` - it is that
 * nothing reads around the door. So every reader is handed a filesystem that
 * exists only in memory, at a root nothing on disk answers to, and a run through
 * it must say exactly what a run over the same tree on disk says. A reader that
 * went to the disk instead would find nothing at that root and change a result.
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createCachedEngine, createJavaScriptEngine, enumerateCandidates } from '../src/engine.js';
import { expandSpecPatterns, walkFiles } from '../src/glob.js';
import { createImportIndex } from '../src/imports.js';
import { nodeIo, readText, watchTree, type Io } from '../src/io.js';
import { resolveQueryPath } from '../src/query.js';
import {
  createScopeProbe,
  executeAssertion,
  planRun,
  reportRun,
  runSpecGuard,
  type RunResult,
} from '../src/runner.js';
import { readSpecs } from '../src/specs.js';
import { createTreeIndex } from '../src/structure.js';
import type { AssertionResult } from '../src/types.js';
import { DEMO_REPO, makeTempRepo, memoryIo, removeTempRepo, searchOptions } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

/** A root that is an absolute path no test ever creates. */
const VIRTUAL = path.resolve('/spec-guard-virtual-root');

describe('nodeIo', () => {
  it('stats a path that exists, following it to what it is', async () => {
    const stats = await nodeIo.stat(path.join(DEMO_REPO, 'src'));
    expect(stats?.isDirectory()).toBe(true);
  });

  it('answers null - not undefined, and not a rejection - for one that does not', async () => {
    // Every caller tests the result for falsiness, so the difference is
    // invisible from any of them and has to be stated here.
    expect(await nodeIo.stat(path.join(DEMO_REPO, 'no-such-path'))).toBeNull();
  });

  it('lists a directory with the kind of each entry, and rejects one that is not there', async () => {
    const entries = await nodeIo.readDirectory(DEMO_REPO);
    expect(entries.find((entry) => entry.name === 'src')?.isDirectory()).toBe(true);
    await expect(nodeIo.readDirectory(path.join(DEMO_REPO, 'no-such-path'))).rejects.toThrow();
  });

  it('reads bytes, and rejects a file that is not there', async () => {
    const root = await makeTempRepo({ 'a.bin': Buffer.from([0, 1, 2]) });
    temporary.push(root);
    expect([...(await nodeIo.readFile(path.join(root, 'a.bin')))]).toEqual([0, 1, 2]);
    await expect(nodeIo.readFile(path.join(root, 'gone'))).rejects.toThrow();
  });

  it('resolves a real path, and rejects one that is not there', async () => {
    expect(await nodeIo.realpath(DEMO_REPO)).toBe(await fs.realpath(DEMO_REPO));
    await expect(nodeIo.realpath(path.join(DEMO_REPO, 'no-such-path'))).rejects.toThrow();
  });
});

describe('readText', () => {
  it('decodes UTF-8 through whichever door it is given', async () => {
    const io = memoryIo(VIRTUAL, { 'a.md': 'naïve — ✓' });
    expect(await readText(io, path.join(VIRTUAL, 'a.md'))).toBe('naïve — ✓');
  });
});

/* ------------------------------------------------------ nothing reads around */

/** A tree with something for every kind of rule to find, and for every kind to miss. */
const FILES: Record<string, string> = {
  'docs/rules.md': [
    '# Rules',
    '<!-- @assert-absence target="src" symbol="Widget" -->',
    '<!-- @assert-count target="src, gone" symbol="User" min="1" -->',
    '<!-- @assert-count target="." symbol="Widget" expected="2" comments="include" -->',
    '<!-- @assert-absence target="empty" symbol="X" -->',
    '<!-- @assert-import-absence target="src" module="lodash" -->',
    '<!-- @assert-import-count target="src/app" module="src/domain/**" max="0" -->',
    '<!-- @assert-import-cycle target="src" -->',
    '<!-- @assert-layers target="src" order="src/domain, src/app, src/infra" -->',
    '<!-- @assert-structure target="src" glob="*.ts" pattern="user.ts, service.ts" -->',
    '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->',
    '<!-- @assert-structure target="src" exclude="*.bin" partner="tests/[name].test.ts" -->',
    '<!-- @assert-present file="SECURITY.md, gone.md" -->',
    '',
  ].join('\n'),
  'docs/draft.md': '# Draft\n\n## Status\n\nProposed.\n\n<!-- @assert-absence target="src" symbol="User" -->\n',
  'README.md': '<!-- @assert-present file="src/domain" -->\n',
  'notes/extra.md': '<!-- @assert-absence target="src/domain" symbol="Widget" -->\n',
  'src/domain/user.ts': 'export class User {}\n// a Widget, in a comment\n',
  'src/app/service.ts': "import { User } from '../domain/user';\nimport lodash from 'lodash';\nexport const w = Widget;\n",
  'src/app/cycle-a.ts': "import './cycle-b';\n",
  'src/app/cycle-b.ts': "import './cycle-a';\n",
  'src/infra/db.ts': "import { w } from '../app/service';\n",
  'src/data.bin': 'Widget\u0000',
  'tests/user.test.ts': '',
  'packages/a/package.json': '{}',
  'packages/b/README.md': '',
  'SECURITY.md': '',
  'node_modules/x/index.ts': 'Widget\n',
};
const PATTERNS = ['docs/**/*.md', 'README.md', 'notes'];

/** A run, the way a watch session makes one: every read through `io`. */
async function runThrough(io: Io, root: string): Promise<RunResult> {
  const startedAt = performance.now();
  const plan = planRun(await readSpecs(PATTERNS, root, io), root, {});
  const results: AssertionResult[] = [];
  for (const assertion of plan.assertions) {
    const engine = createJavaScriptEngine(io);
    results.push(
      await executeAssertion(assertion, {
        root,
        io,
        engine: createCachedEngine(engine, engine),
        allowMissingTargets: false,
        strictTargets: false,
        allowEmptyScope: false,
        maxSnippets: 5,
        imports: createImportIndex(io),
        hasFiles: createScopeProbe(io),
        tree: createTreeIndex(root, io),
      }),
    );
  }
  return reportRun(plan, results, { name: 'javascript', fallbacks: [] }, startedAt);
}

/** A report with its root spelled out of it and its timings taken out. */
function comparable(report: RunResult): unknown {
  const text = JSON.stringify(report, (key, value: unknown) => (key === 'durationMs' ? undefined : value));
  const roots = [report.root, report.root.replaceAll('\\', '/')].map((root) => JSON.stringify(root).slice(1, -1));
  return JSON.parse(roots.reduce((result, root) => result.split(root).join('<root>'), text));
}

describe('every read goes through the door', () => {
  it('a run through a filesystem in memory says what a run over the same tree on disk says', async () => {
    const onDisk = await makeTempRepo(FILES);
    temporary.push(onDisk);
    await fs.mkdir(path.join(onDisk, 'empty'));

    const expected = await runSpecGuard({ patterns: PATTERNS, root: onDisk, engine: 'javascript' });
    const actual = await runThrough(memoryIo(VIRTUAL, FILES, ['empty']), VIRTUAL);

    // The tree has to exercise what it claims to: every kind, a pass and a
    // failure, and a withheld document, or agreeing would prove little.
    expect(new Set(expected.results.map((result) => result.kind)).size).toBe(8);
    expect(expected.results.some((result) => result.ok)).toBe(true);
    expect(expected.results.filter((result) => !result.ok).length).toBeGreaterThan(5);
    expect(expected.summary).toMatchObject({ specs: 4, inactive: 1 });

    expect(comparable(actual)).toEqual(comparable(expected));
  });

  it('and a filesystem that is empty makes every one of those readers find nothing', async () => {
    // The negative control: the same run through a door onto nothing. Were
    // any reader to ignore its door, the tree above would still be on disk at
    // the root it read, and this would not be an empty run.
    const onDisk = await makeTempRepo(FILES);
    temporary.push(onDisk);
    const report = await runThrough(memoryIo(onDisk, {}), onDisk);
    expect(report.summary).toMatchObject({ specs: 0, total: 0 });
  });

  it('reaches the walk, the enumeration, the scanner, the import index, the tree index and a query', async () => {
    const io = memoryIo(VIRTUAL, FILES, ['empty']);
    const at = (relative: string): string => path.join(VIRTUAL, relative);

    const walked: string[] = [];
    for await (const file of walkFiles(at('src/app'), { io })) walked.push(file.relativePath);
    expect(walked).toEqual(['cycle-a.ts', 'cycle-b.ts', 'service.ts']);

    expect((await expandSpecPatterns(['README.md', 'notes', 'docs/*.md'], VIRTUAL, undefined, io)).map((file) => path.relative(VIRTUAL, file))).toEqual(
      [path.join('README.md'), path.join('docs', 'draft.md'), path.join('docs', 'rules.md'), path.join('notes', 'extra.md')].sort(),
    );

    const request = { root: VIRTUAL, symbol: 'Widget', targets: ['src', 'README.md'], options: searchOptions() };
    expect((await enumerateCandidates(request, undefined, io)).files.map((file) => file.relativePath)).toEqual([
      'README.md',
      'src/app/cycle-a.ts',
      'src/app/cycle-b.ts',
      'src/app/service.ts',
      'src/data.bin',
      'src/domain/user.ts',
      'src/infra/db.ts',
    ]);
    expect((await createJavaScriptEngine(io).search(request)).count).toBe(2);
    expect(await createScopeProbe(io)({ ...request, targets: ['empty'] })).toBe(false);
    expect(await createScopeProbe(io)(request)).toBe(true);

    const analysis = await createImportIndex(io).analyze(at('src/app/service.ts'), 'src/app/service.ts');
    expect(analysis.references.map((reference) => reference.specifier)).toEqual(['../domain/user', 'lodash']);

    const index = createTreeIndex(VIRTUAL, io);
    expect([...((await index.listing('packages')) ?? new Map()).keys()].sort()).toEqual(['a', 'b']);
    expect((await index.walk('src/infra', searchOptions().scope)).files).toEqual(['src/infra/db.ts']);

    expect(await resolveQueryPath('src/domain', VIRTUAL, io)).toMatchObject({ shape: 'directory', exists: true });
    expect(await resolveQueryPath('src/gone.ts', VIRTUAL, io)).toMatchObject({ shape: 'file', exists: false });
  });
});

describe('watchTree', () => {
  /** A stand-in for Node's watch, recording how it was asked and handing back an emitter. */
  function fake(): { start: Parameters<typeof watchTree>[3]; calls: unknown[][]; emitter: EventEmitter & { close(): void; closed: boolean }; listener: () => (type: string, filename: unknown) => void } {
    const calls: unknown[][] = [];
    const emitter = Object.assign(new EventEmitter(), {
      closed: false,
      close(): void {
        emitter.closed = true;
      },
    });
    let given: (type: string, filename: unknown) => void = () => {};
    const start = ((root: string, options: unknown, listener: (type: string, filename: unknown) => void) => {
      calls.push([root, options]);
      given = listener;
      return emitter;
    }) as unknown as Parameters<typeof watchTree>[3];
    return { start, calls, emitter, listener: () => given };
  }

  it('watches the whole tree with one recursive watcher, and passes each event on', () => {
    const { start, calls, emitter, listener } = fake();
    const seen: unknown[][] = [];
    const errors: Error[] = [];
    const watcher = watchTree('/repo', (type, filename) => seen.push([type, filename]), (error) => errors.push(error), start);

    expect(calls).toEqual([['/repo', { recursive: true }]]);
    listener()('change', `src${path.sep}a.ts`);
    listener()('rename', null);
    expect(seen).toEqual([
      ['change', `src${path.sep}a.ts`],
      ['rename', null],
    ]);

    const failure = new Error('EPERM');
    emitter.emit('error', failure);
    expect(errors).toEqual([failure]);

    watcher.close();
    expect(emitter.closed).toBe(true);
  });

  it('reports a filename Node could not give as null, not as undefined', () => {
    const { start, listener } = fake();
    const seen: unknown[] = [];
    watchTree('/repo', (_type, filename) => seen.push(filename), () => {}, start);
    listener()('change', undefined);
    expect(seen).toEqual([null]);
  });

  it('hears a real change under a real directory', async () => {
    const root = await makeTempRepo({ 'src/a.ts': 'a' });
    temporary.push(root);
    const seen: string[] = [];
    const watcher = watchTree(root, (_type, filename) => seen.push(String(filename)), () => {});
    try {
      for (let attempt = 0; attempt < 100 && !seen.some((name) => name.endsWith('b.ts')); attempt++) {
        if (attempt % 20 === 0) await fs.writeFile(path.join(root, 'src/b.ts'), String(attempt));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      watcher.close();
    }
    expect(seen.some((name) => name.endsWith('b.ts'))).toBe(true);
  });
});
