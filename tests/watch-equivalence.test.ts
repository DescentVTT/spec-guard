/**
 * A watch session, held to a fresh run of the same tree. ADR-0014.
 *
 * The session reuses facts, pure work and whole results between runs, and each
 * of those is a way to report a tree that no longer exists. Nothing about it is
 * argued here. A tree on disk is changed at random - files written, appended,
 * touched and deleted, directories created, removed, renamed and replaced, a
 * file swapped for a directory of its name, specs and package.json rewritten -
 * and after every change the session's report must equal what a fresh run of
 * the same tree says, field for field, durations aside.
 *
 * Each change reaches four sessions, each told about it differently, because
 * no operating system reports a change the same way twice:
 *   - every changed path;
 *   - only the topmost, as a renamed or removed directory is reported;
 *   - every changed path and a `change` for each directory above it, as
 *     Windows reports a save;
 *   - every changed path twice, in no particular order.
 *
 * Below that, six sessions with one deliberate defect each. Each must be caught,
 * or the property above proves less than it says.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { applyConfig, parseArgs } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { FACT_POLICY, type FactPolicy, type WatchEvent } from '../src/facts.js';
import { nodeIo, readText, type Io } from '../src/io.js';
import { createMemo } from '../src/memo.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { createSession, ruleCaches, type RuleCaches, type Session, type SessionOptions, type SessionSettings } from '../src/watch.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

/* -------------------------------------------------------------- the oracle */

/** A run's settings, the way `spec-guard --watch` decides them. */
async function settingsFor(root: string, io: Io): Promise<SessionSettings> {
  const options = parseArgs(['--watch'], root);
  const config = applyConfig(options, await loadConfig(root, (file) => readText(io, file)));
  return {
    patterns: options.patterns,
    run: {
      allowMissingTargets: options.allowMissingTargets,
      strictTargets: options.strictTargets,
      allowEmptyScope: options.allowEmptyScope,
      maxSnippets: options.maxSnippets,
      includeSpecs: options.includeSpecs,
      defaultSkips: options.defaultSkips,
      ignoreStatus: options.ignoreStatus,
      concurrency: options.concurrency,
    },
    ...(config === undefined ? {} : { config }),
  };
}

/** What a fresh run of the tree says, now. */
async function fresh(root: string): Promise<RunResult> {
  const settings = await settingsFor(root, nodeIo);
  const report = await runSpecGuard({ ...settings.run, patterns: settings.patterns, root, engine: 'javascript' });
  return settings.config === undefined ? report : { ...report, config: settings.config };
}

function comparable(report: RunResult): unknown {
  return JSON.parse(JSON.stringify(report, (key, value: unknown) => (key === 'durationMs' ? undefined : value)));
}

function session(root: string, overrides: Partial<SessionOptions> = {}): Session {
  return createSession({ root, settings: (io) => settingsFor(root, io), ...overrides });
}

/* ---------------------------------------------------------------- the tree */

const DIRECTIVES = [
  '<!-- @assert-absence target="src" symbol="MARK" -->',
  '<!-- @assert-count target="src, gone" symbol="User" min="1" allow-empty="true" -->',
  '<!-- @assert-count target="." symbol="MARK" max="3" comments="include" -->',
  '<!-- @assert-absence target="empty" symbol="X" -->',
  '<!-- @assert-absence target="src" symbol="MARK" glob="*.ts" exclude="src/infra" -->',
  '<!-- @assert-import-absence target="src" module="lodash, os" -->',
  '<!-- @assert-import-count target="src/app" module="src/domain/**" max="0" -->',
  '<!-- @assert-import-cycle target="src" -->',
  '<!-- @assert-layers target="src" order="src/domain, src/app, src/infra" -->',
  '<!-- @assert-structure target="src" glob="*.ts" pattern="user.ts, service.ts, db.ts" -->',
  '<!-- @assert-structure target="packages" dirs="*" required="package.json" -->',
  '<!-- @assert-structure target="src" exclude="*.py, *.bin, cycle-*" partner="tests/[name].test.ts" -->',
  '<!-- @assert-structure target="src/app" glob="*.ts" partner="[name].md" allow-empty="true" -->',
  '<!-- @assert-present file="README.md, gone.md" -->',
  '<!-- @assert-present file="src/domain" -->',
];

const BASE: Record<string, string> = {
  'package.json': '{"name":"t"}\n',
  'docs/rules.md': `# Rules\n\n${DIRECTIVES.join('\n')}\n`,
  'docs/draft.md': '# Draft\n\n## Status\n\nProposed.\n\n<!-- @assert-absence target="src" symbol="User" -->\n',
  'src/domain/user.ts': 'export class User {}\n',
  'src/app/service.ts': "import { User } from '../domain/user';\nexport const s = MARK;\n",
  'src/app/cycle-a.ts': "import './cycle-b';\n",
  'src/app/cycle-b.ts': "import './cycle-a';\n",
  'src/infra/db.ts': "import { s } from '../app/service';\n",
  'src/lib.py': 'import os\n',
  'tests/user.test.ts': '',
  'packages/a/package.json': '{}',
  'packages/b/README.md': '',
  'README.md': '',
  'node_modules/x/index.ts': 'MARK\n',
};

const FILES = [
  'src/domain/user.ts',
  'src/domain/order.ts',
  'src/app/service.ts',
  'src/app/cycle-a.ts',
  'src/app/new.ts',
  'src/app/service.md',
  'src/infra/db.ts',
  'src/infra/cache.ts',
  'src/lib.py',
  'src/data.bin',
  'src/extra/deep/x.ts',
  'tests/user.test.ts',
  'tests/order.test.ts',
  'tests/service.test.ts',
  'packages/a/package.json',
  'packages/c/package.json',
  'packages/b/README.md',
  'README.md',
  'gone.md',
  'empty/x.ts',
  'node_modules/x/index.ts',
  'src/node_modules/y.ts',
  'docs/extra.md',
  'docs/sub/deep.md',
  'notes.txt',
];

const DIRECTORIES = ['src/extra', 'src/app', 'src/domain', 'src/infra', 'packages/c', 'packages/d', 'tests', 'empty', 'docs/sub', 'node_modules/x'];

const CONTENTS = [
  '',
  'export const s = MARK;\n',
  '// MARK, in a comment\n',
  "import { User } from '../domain/user';\n",
  "import './cycle-a';\n",
  "import { s } from '../app/service';\nimport lodash from 'lodash';\n",
  'import os\nimport lodash\n',
  'MARK\u0000binary',
  '<!-- @assert-absence target="src" symbol="User" -->\n',
  'export class User {}\n',
];

const CONFIGS = [
  { name: 't' },
  { name: 't', specGuard: { ignoreStatus: true } },
  { name: 't', specGuard: { includeSpecs: true, strict: true } },
  { name: 't', specGuard: { allowEmptyScope: true, allowMissingTargets: true } },
  { name: 't', specGuard: { defaultSkips: false } },
  { name: 't', specGuard: { specs: ['docs/rules.md'] } },
  { name: 't', specGuard: { maxSnippets: 1, engine: 'rg' } },
];

/** A small, seedable, reproducible generator: mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- changes */

type Change = { path: string; what: 'created' | 'removed' | 'modified' };

/** What happened, in the order it happened, and the topmost part of it. */
interface Happened {
  label: string;
  every: Change[];
  topmost: Change[];
}

async function exists(file: string): Promise<'file' | 'directory' | null> {
  const stats = await fs.lstat(file).catch(() => null);
  return stats === null ? null : stats.isDirectory() ? 'directory' : 'file';
}

/** Everything under a directory, deepest first, as the paths removing it would report. */
async function beneath(root: string, relative: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await beneath(root, child)));
    found.push(child);
  }
  return found;
}

/** Creates a file, and whichever directories above it did not exist. */
async function write(root: string, relative: string, content: string): Promise<Change[]> {
  const changes: Change[] = [];
  const segments = relative.split('/');
  for (let depth = 1; depth < segments.length; depth++) {
    const directory = segments.slice(0, depth).join('/');
    const kind = await exists(path.join(root, directory));
    if (kind === 'file') {
      await fs.rm(path.join(root, directory));
      changes.push({ path: directory, what: 'removed' });
    }
    if (kind !== 'directory') {
      await fs.mkdir(path.join(root, directory));
      changes.push({ path: directory, what: 'created' });
    }
  }
  const before = await exists(path.join(root, relative));
  if (before === 'directory') {
    for (const child of await beneath(root, relative)) changes.push({ path: child, what: 'removed' });
    await fs.rm(path.join(root, relative), { recursive: true });
    changes.push({ path: relative, what: 'removed' });
  }
  await fs.writeFile(path.join(root, relative), content);
  changes.push({ path: relative, what: before === 'file' ? 'modified' : 'created' });
  return changes;
}

async function remove(root: string, relative: string): Promise<Change[]> {
  const changes = (await beneath(root, relative)).map((child): Change => ({ path: child, what: 'removed' }));
  await fs.rm(path.join(root, relative), { recursive: true, force: true });
  return [...changes, { path: relative, what: 'removed' }];
}

function topmost(changes: readonly Change[]): Change[] {
  const paths = changes.map((change) => change.path);
  return changes.filter((change) => !paths.some((other) => other !== change.path && change.path.startsWith(`${other}/`)));
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** One random change to the tree. */
async function mutate(root: string, next: () => number): Promise<Happened> {
  const roll = Math.floor(next() * 13);
  const file = pick(next, FILES);
  const directory = pick(next, DIRECTORIES);
  const happened = (label: string, every: Change[]): Happened => ({ label, every, topmost: topmost(every) });

  switch (roll) {
    case 0:
    case 1: {
      const content = pick(next, CONTENTS);
      return happened(`write ${file}`, await write(root, file, content));
    }
    case 2: {
      if ((await exists(path.join(root, file))) !== 'file') return happened(`write ${file}`, await write(root, file, 'MARK\n'));
      await fs.appendFile(path.join(root, file), pick(next, CONTENTS));
      return happened(`append ${file}`, [{ path: file, what: 'modified' }]);
    }
    case 3: {
      if ((await exists(path.join(root, file))) === null) return happened(`nothing at ${file}`, []);
      return happened(`remove ${file}`, await remove(root, file));
    }
    case 4: {
      if ((await exists(path.join(root, file))) !== 'file') return happened(`nothing to touch at ${file}`, []);
      const later = new Date(Date.now() + Math.floor(next() * 100_000));
      await fs.utimes(path.join(root, file), later, later);
      return happened(`touch ${file}`, [{ path: file, what: 'modified' }]);
    }
    case 5:
      return happened(`remove ${directory}`, (await exists(path.join(root, directory))) === null ? [] : await remove(root, directory));
    case 6: {
      // A directory renamed reports its old and new names and nothing inside.
      const to = `${directory}-moved`;
      if ((await exists(path.join(root, directory))) !== 'directory' || (await exists(path.join(root, to))) !== null) return happened(`nothing to rename at ${directory}`, []);
      const inside = await beneath(root, directory);
      await fs.rename(path.join(root, directory), path.join(root, to));
      const every: Change[] = [
        ...inside.map((child): Change => ({ path: child, what: 'removed' })),
        { path: directory, what: 'removed' },
        { path: to, what: 'created' },
        ...inside.map((child): Change => ({ path: `${to}${child.slice(directory.length)}`, what: 'created' })),
      ];
      return { label: `rename ${directory} to ${to}`, every, topmost: [{ path: directory, what: 'removed' }, { path: to, what: 'created' }] };
    }
    case 7: {
      // Replaced: the same names beneath it, different bytes.
      if ((await exists(path.join(root, directory))) !== 'directory') return happened(`write under ${directory}`, await write(root, `${directory}/a.ts`, 'MARK\n'));
      const files: string[] = [];
      for (const child of await beneath(root, directory)) if ((await exists(path.join(root, child))) === 'file') files.push(child);
      const every = await remove(root, directory);
      for (const child of files) every.push(...(await write(root, child, pick(next, CONTENTS))));
      if (files.length === 0) every.push(...(await write(root, `${directory}/a.ts`, 'MARK\n')));
      return { label: `replace ${directory}`, every, topmost: [{ path: directory, what: 'created' }] };
    }
    case 8: {
      // A file becomes a directory of the same name, or the other way round.
      const kind = await exists(path.join(root, file));
      if (kind === 'file') {
        const every = await remove(root, file);
        every.push(...(await write(root, `${file}/inner.ts`, 'export const s = MARK;\n')));
        return { label: `file ${file} to directory`, every, topmost: [{ path: file, what: 'created' }] };
      }
      if (kind === 'directory') return { label: `directory ${file} to file`, every: await write(root, file, 'MARK\n'), topmost: [{ path: file, what: 'created' }] };
      return happened(`write ${file}`, await write(root, file, pick(next, CONTENTS)));
    }
    case 9: {
      const chosen = DIRECTIVES.filter(() => next() < 0.6);
      return happened('rewrite docs/rules.md', await write(root, 'docs/rules.md', `# Rules\n\n${chosen.join('\n')}\n`));
    }
    case 10:
      return happened('rewrite package.json', await write(root, 'package.json', `${JSON.stringify(pick(next, CONFIGS))}\n`));
    case 11: {
      const target = `${directory}/made/here.ts`;
      return happened(`write ${target}`, await write(root, target, pick(next, CONTENTS)));
    }
    default: {
      const from = file;
      const to = pick(next, FILES);
      if ((await exists(path.join(root, from))) !== 'file' || (await exists(path.join(root, to))) !== null || from === to) return happened(`nothing to move from ${from}`, []);
      const every: Change[] = [];
      for (const segment of to.split('/').slice(0, -1).map((_, depth, all) => all.slice(0, depth + 1).join('/'))) {
        if ((await exists(path.join(root, segment))) === null) {
          await fs.mkdir(path.join(root, segment));
          every.push({ path: segment, what: 'created' });
        }
      }
      if ((await exists(path.join(root, path.dirname(to)))) !== 'directory') return happened(`nothing to move to ${to}`, []);
      await fs.rename(path.join(root, from), path.join(root, to));
      every.push({ path: from, what: 'removed' }, { path: to, what: 'created' });
      return happened(`move ${from} to ${to}`, every);
    }
  }
}

/* ------------------------------------------------------ what a watcher says */

const eventOf = (change: Change): WatchEvent => ({ type: change.what === 'modified' ? 'change' : 'rename', filename: change.path.split('/').join(path.sep) });

const FORMS: Record<string, (happened: Happened, next: () => number) => WatchEvent[]> = {
  every: (happened) => happened.every.map(eventOf),
  topmost: (happened) => happened.topmost.map(eventOf),
  'with every directory above': (happened) =>
    happened.every.flatMap((change) => {
      const above = change.path.split('/').slice(0, -1).map((_, depth, all) => all.slice(0, depth + 1).join(path.sep));
      return [eventOf(change), ...above.map((directory): WatchEvent => ({ type: 'change', filename: directory }))];
    }),
  'twice, in any order': (happened, next) =>
    [...happened.every, ...happened.every]
      .map((change) => ({ change, order: next() }))
      .sort((a, b) => a.order - b.order)
      .map(({ change }) => eventOf(change)),
};

/* ------------------------------------------------------------ the property */

/**
 * Drives sessions through changes and returns, for each, the first step at
 * which its report and a fresh run's disagreed, or null.
 */
async function drive(
  root: string,
  sessions: Record<string, { session: Session; form: keyof typeof FORMS }>,
  steps: Array<(next: () => number) => Promise<Happened>>,
  next: () => number,
): Promise<Record<string, string | null>> {
  const disagreed: Record<string, string | null> = Object.fromEntries(Object.keys(sessions).map((name) => [name, null]));
  const compare = async (label: string): Promise<void> => {
    const expected = comparable(await fresh(root));
    for (const [name, { session: watched }] of Object.entries(sessions)) {
      if (disagreed[name] !== null) continue;
      const actual = comparable((await watched.run()).report);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        disagreed[name] = label;
        if (process.env['SPEC_GUARD_WATCH_DEBUG']) expect(actual, `${name} after ${label}`).toEqual(expected);
      }
    }
  };

  await compare('the first run');
  for (const [index, step] of steps.entries()) {
    const happened = await step(next);
    for (const { session: watched, form } of Object.values(sessions)) {
      await watched.observe((FORMS[form] as (typeof FORMS)[string])(happened, next));
    }
    await compare(`step ${index + 1}: ${happened.label}`);
  }
  return disagreed;
}

describe('a watch session against a fresh run', () => {
  it.each([1, 2, 3])(
    'agrees after every random change, however the change is reported (seed %i)',
    async (seed) => {
      const root = await makeTempRepo(BASE);
      temporary.push(root);
      await fs.mkdir(path.join(root, 'empty'));
      const next = random(seed);
      const sessions = Object.fromEntries(Object.keys(FORMS).map((form) => [form, { session: session(root), form }]));
      const steps = Array.from({ length: 30 }, () => (generator: () => number) => mutate(root, generator));

      const disagreed = await drive(root, sessions, steps, next);
      expect(disagreed, `seed ${seed}; rerun with SPEC_GUARD_WATCH_DEBUG=1 to see the difference`).toEqual(
        Object.fromEntries(Object.keys(FORMS).map((form) => [form, null])),
      );
    },
    240_000,
  );

  it('re-executes nothing when nothing it read changed, and everything after forget', async () => {
    const root = await makeTempRepo(BASE);
    temporary.push(root);
    const watched = session(root);
    const first = await watched.run();
    expect(first.executed).toBe(first.report.summary.total);
    expect(first.report.summary.total).toBeGreaterThan(10);

    // A file in a directory no rule lists, and a save that changed no bytes -
    // reported the way Windows reports one, with its directories above it.
    await fs.writeFile(path.join(root, 'node_modules/x/other.js'), 'MARK');
    await fs.utimes(path.join(root, 'src/domain/user.ts'), new Date(), new Date(Date.now() + 5000));
    expect(
      await watched.observe([
        { type: 'rename', filename: path.join('node_modules', 'x', 'other.js') },
        { type: 'change', filename: path.join('src', 'domain', 'user.ts') },
        { type: 'change', filename: path.join('src', 'domain') },
        { type: 'change', filename: 'src' },
      ]),
    ).toBe(0);
    expect((await watched.run()).executed).toBe(0);

    // A new name at the root changes the root's listing, and exactly the rules
    // that listed the root run again: the count over "." and the structure
    // rules, which find their targets by name from the root.
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    expect(await watched.observe([{ type: 'rename', filename: 'notes.txt' }])).toBe(1);
    const second = await watched.run();
    expect(second.executed).toBe(first.report.results.filter((result) => result.kind === 'assert-structure' || result.targets.includes('.')).length);
    expect(comparable(second.report)).toEqual(comparable(await fresh(root)));

    watched.forget();
    expect((await watched.run()).executed).toBe(first.report.summary.total);
  });

  it('re-executes only the rules that read a changed file', async () => {
    const root = await makeTempRepo(BASE);
    temporary.push(root);
    const watched = session(root);
    const first = await watched.run();
    await fs.writeFile(path.join(root, 'packages/a/package.json'), '{"changed":true}');
    await watched.observe([{ type: 'change', filename: path.join('packages', 'a', 'package.json') }]);
    const second = await watched.run();
    expect(second.executed).toBeGreaterThan(0);
    expect(second.executed).toBeLessThan(first.report.summary.total / 2);
    expect(comparable(second.report)).toEqual(comparable(await fresh(root)));
  });
});

/* ------------------------------------------------- a session's own contracts */

describe('what a session holds to besides the tree', () => {
  /** A session whose settings are fixed, rather than read from a package.json. */
  function fixed(root: string, run: SessionSettings['run'], overrides: Partial<SessionOptions> = {}): Session {
    return createSession({ root, settings: async () => ({ patterns: ['docs/**/*.md'], run }), ...overrides });
  }

  async function freshWith(root: string, run: SessionSettings['run']): Promise<unknown> {
    return comparable(await runSpecGuard({ ...run, patterns: ['docs/**/*.md'], root, engine: 'javascript' }));
  }

  it('executes with a run\'s defaults when its settings leave them out', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': [
        '<!-- @assert-absence target="src, gone" symbol="MARK" -->',
        '<!-- @assert-absence target="empty" symbol="X" -->',
        '<!-- @assert-absence target="src" symbol="Gone" -->',
        '<!-- @assert-absence target="src" symbol="MARK" -->',
        '',
      ].join('\n'),
      'src/a.ts': Array.from({ length: 8 }, () => 'MARK').join('\n'),
      'src/b.bin': 'Gone\u0000',
    });
    temporary.push(root);
    await fs.mkdir(path.join(root, 'empty'));
    const watched = await fixed(root, {}).run();
    expect(comparable(watched.report)).toEqual(await freshWith(root, {}));
    // A missing target and an empty scope fail, a match only in a binary file is
    // not a strict failure, and a failure shows five snippets.
    expect(watched.report.results.map((result) => result.message)).toEqual([
      'target path does not exist: gone',
      'no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)',
      'expected no matches, found 0',
      'expected no matches, found 8',
    ]);
    expect(watched.report.results[3]?.matches).toHaveLength(5);
    expect(watched.maxSnippets).toBe(5);
  });

  it('executes with the options its settings give', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': '<!-- @assert-absence target="src" symbol="MARK" -->\n<!-- @assert-absence target="src" symbol="Gone" -->\n',
      'src/a.ts': 'MARK\nMARK\nMARK\n',
      'src/b.bin': 'Gone\u0000',
    });
    temporary.push(root);
    const options = { strictTargets: true, maxSnippets: 1 };
    const watched = await fixed(root, options).run();
    expect(comparable(watched.report)).toEqual(await freshWith(root, options));
    expect(watched.maxSnippets).toBe(1);
    expect(watched.report.results[0]?.matches).toHaveLength(1);
    expect(watched.report.results[1]?.ok).toBe(false);
  });

  it('reports no results for specs that hold no rules', async () => {
    const root = await makeTempRepo({ 'docs/empty.md': '# Nothing to hold\n' });
    temporary.push(root);
    const watched = await fixed(root, {}).run();
    expect(watched.report.results).toEqual([]);
    expect(watched.report.summary).toMatchObject({ specs: 1, total: 0 });
  });

  it('executes as many rules at once as its concurrency allows', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': Array.from({ length: 5 }, (_, index) => `<!-- @assert-absence target="src" symbol="S${index}" -->`).join('\n'),
      'src/a.ts': '',
    });
    temporary.push(root);
    const peakWith = async (concurrency: number | undefined): Promise<number> => {
      let inFlight = 0;
      let peak = 0;
      const caches = (at: string, door: Io, memo: Parameters<typeof ruleCaches>[2]): RuleCaches => {
        const own = ruleCaches(at, door, memo);
        return {
          ...own,
          engine: {
            ...own.engine,
            search: async (request) => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 10));
              try {
                return await own.engine.search(request);
              } finally {
                inFlight -= 1;
              }
            },
          },
        };
      };
      await fixed(root, concurrency === undefined ? {} : { concurrency }, { caches }).run();
      return peak;
    };
    expect(await peakWith(2)).toBe(2);
    expect(await peakWith(1)).toBe(1);
    expect(await peakWith(undefined)).toBe(5);
  });

  it('sweeps its memo once a run, so a session left open does not keep every version of every file', async () => {
    const root = await makeTempRepo({ 'docs/rules.md': '<!-- @assert-absence target="src" symbol="MARK" -->\n', 'src/a.ts': '' });
    temporary.push(root);
    const real = createMemo();
    let sweeps = 0;
    const memo = {
      remember: real.remember,
      sweep: () => {
        sweeps += 1;
        real.sweep();
      },
      get size(): number {
        return real.size;
      },
    };
    const watched = fixed(root, {}, { memo });
    await watched.run();
    await watched.run();
    expect(sweeps).toBe(2);
  });

  it('reads the tree again after forget, even where no event said it changed', async () => {
    const root = await makeTempRepo({ 'docs/rules.md': '<!-- @assert-absence target="src" symbol="MARK" -->\n', 'src/a.ts': 'clean' });
    temporary.push(root);
    const watched = fixed(root, {});
    expect((await watched.run()).report.ok).toBe(true);
    expect(watched.facts).toBeGreaterThan(0);
    await fs.writeFile(path.join(root, 'src/a.ts'), 'MARK');
    expect((await watched.run()).report.ok).toBe(true);
    watched.forget();
    expect((await watched.run()).report.ok).toBe(false);
  });

  it('lets go of what only a removed rule read', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': '<!-- @assert-absence target="src" symbol="MARK" -->\n<!-- @assert-absence target="lib" symbol="MARK" -->\n',
      'src/a.ts': '',
      'lib/b.ts': '',
    });
    temporary.push(root);
    const watched = fixed(root, {});
    await watched.run();
    const before = watched.facts;
    await fs.writeFile(path.join(root, 'docs/rules.md'), '<!-- @assert-absence target="src" symbol="MARK" -->\n');
    await watched.observe([{ type: 'change', filename: path.join('docs', 'rules.md') }]);
    await watched.run();
    // The rule over lib is gone. An event there evicts what it read, and nothing
    // reads it again, because nobody uses it any more.
    await watched.observe([{ type: 'rename', filename: 'lib' }]);
    expect(watched.facts).toBeLessThan(before);
    expect(comparable((await watched.run()).report)).toEqual(await freshWith(root, {}));
  });

  it('re-executes a rule whose excluded specs changed, though no file it read did', async () => {
    const root = await makeTempRepo({
      'package.json': '{}',
      'docs/rules.md': '<!-- @assert-absence target="src" symbol="MARK" -->\n',
      'src/notes.md': 'MARK\n',
      'src/a.ts': '',
    });
    temporary.push(root);
    const watched = session(root);
    expect((await watched.run()).report.ok).toBe(false);
    // src/notes.md becomes a spec, so the rule over src stops counting it.
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ specGuard: { specs: ['docs/**/*.md', 'src/*.md'] } }));
    await watched.observe([{ type: 'change', filename: 'package.json' }]);
    const after = await watched.run();
    expect(comparable(after.report)).toEqual(comparable(await fresh(root)));
    expect(after.report.results[0]?.ok).toBe(true);
  });

  it('re-executes a rule whose skipped directories changed, though no file it read did', async () => {
    const root = await makeTempRepo({
      'package.json': '{}',
      // Over lib, not the root: a rule that read package.json would run again
      // because package.json changed, and prove nothing about its scope.
      'docs/rules.md': '<!-- @assert-absence target="lib" symbol="MARK" -->\n',
      'lib/a.js': '',
      'lib/node_modules/x/index.js': 'MARK\n',
    });
    temporary.push(root);
    const watched = session(root);
    expect((await watched.run()).report.ok).toBe(true);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ specGuard: { defaultSkips: false } }));
    await watched.observe([{ type: 'change', filename: 'package.json' }]);
    const after = await watched.run();
    expect(comparable(after.report)).toEqual(comparable(await fresh(root)));
    expect(after.report.ok).toBe(false);
  });
});

/* ------------------------------------------------------- negative controls */

/**
 * One defective session against one correct one, over a change chosen to
 * expose the defect. The correct session must agree throughout, so a control
 * that "passes" because the scenario broke everything is caught too.
 */
async function control(
  defect: Partial<SessionOptions>,
  form: keyof typeof FORMS,
  files: Record<string, string>,
  change: (root: string) => Promise<Happened>,
): Promise<{ defective: string | null; correct: string | null }> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  const disagreed = await drive(
    root,
    { defective: { session: session(root, defect), form }, correct: { session: session(root), form } },
    [() => change(root)],
    random(7),
  );
  return { defective: disagreed['defective'] ?? null, correct: disagreed['correct'] ?? null };
}

const RULES = (...directives: string[]): Record<string, string> => ({ 'docs/rules.md': `${directives.join('\n')}\n` });

describe('each deliberate defect is caught', () => {
  it('rules sharing their caches, so the second reader never records a read', async () => {
    let shared: RuleCaches | undefined;
    const sharing = (root: string, door: Io, memo: Parameters<typeof ruleCaches>[2]): RuleCaches => (shared ??= ruleCaches(root, door, memo));
    const outcome = await control(
      { caches: sharing },
      'every',
      {
        ...RULES('<!-- @assert-structure target="src" pattern="*.ts" -->', '<!-- @assert-structure target="src" glob="*.ts" partner="[name].md" -->'),
        'src/a.ts': '',
        'src/a.md': '',
      },
      async (root) => ({ label: 'create src/b.ts', every: await write(root, 'src/b.ts', ''), topmost: [] }),
    );
    expect(outcome).toEqual({ defective: 'step 1: create src/b.ts', correct: null });
  });

  it('eviction that forgets the parent directory\'s listing', async () => {
    const forgetful: FactPolicy = {
      ...FACT_POLICY,
      evictions: (events, root, known) => {
        const inner = FACT_POLICY.evictions(events, root, known);
        const named = new Set(events.map((event) => path.resolve(root, event.filename as string).normalize('NFC').toLowerCase()));
        return (fact) => inner(fact) && (fact.kind !== 'listing' || named.has(fact.folded));
      },
    };
    const outcome = await control({ policy: forgetful }, 'every', { ...RULES('<!-- @assert-absence target="src" symbol="MARK" -->'), 'src/a.ts': '' }, async (root) => ({
      label: 'create src/b.ts',
      every: await write(root, 'src/b.ts', 'MARK\n'),
      topmost: [],
    }));
    expect(outcome).toEqual({ defective: 'step 1: create src/b.ts', correct: null });
  });

  it('eviction that forgets what lies beneath a replaced directory', async () => {
    const shallow: FactPolicy = {
      ...FACT_POLICY,
      evictions: (events, root, known) => {
        const inner = FACT_POLICY.evictions(events, root, known);
        const named = new Set(events.map((event) => path.resolve(root, event.filename as string).normalize('NFC').toLowerCase()));
        const parents = new Set([...named].map((target) => path.dirname(target)));
        return (fact) => inner(fact) && (named.has(fact.folded) || (fact.kind === 'listing' && parents.has(fact.folded)));
      },
    };
    const outcome = await control({ policy: shallow }, 'topmost', { ...RULES('<!-- @assert-absence target="src" symbol="MARK" -->'), 'src/app/a.ts': '' }, async (root) => {
      const every = await remove(root, 'src/app');
      every.push(...(await write(root, 'src/app/a.ts', 'MARK\n')));
      return { label: 'replace src/app', every, topmost: [{ path: 'src/app', what: 'created' }] };
    });
    expect(outcome).toEqual({ defective: 'step 1: replace src/app', correct: null });
  });

  it('a listing compared by its names and not their kinds', async () => {
    const namesOnly: FactPolicy = {
      ...FACT_POLICY,
      fingerprint: (kind, outcome) =>
        kind === 'listing' && outcome.ok
          ? (outcome.value as Array<{ name: string }>).map((entry) => entry.name).sort().join('\n')
          : FACT_POLICY.fingerprint(kind, outcome),
    };
    const outcome = await control({ policy: namesOnly }, 'every', { ...RULES('<!-- @assert-structure target="src" pattern="*.ts" -->'), 'src/a.ts': '', 'src/x.md': '' }, async (root) => {
      const every = await remove(root, 'src/x.md');
      every.push(...(await write(root, 'src/x.md/inner.ts', '')));
      return { label: 'src/x.md becomes a directory', every, topmost: [] };
    });
    expect(outcome).toEqual({ defective: 'step 1: src/x.md becomes a directory', correct: null });
  });

  it('a memo keyed without the path of the file its bytes came from', async () => {
    const real = createMemo();
    const pathless = {
      remember: <T>(bytes: Buffer, inputs: readonly string[], compute: () => T): T => real.remember(bytes, inputs.slice(0, -1), compute),
      sweep: () => real.sweep(),
      get size(): number {
        return real.size;
      },
    };
    const outcome = await control(
      { memo: pathless },
      'every',
      { ...RULES('<!-- @assert-absence target="src" symbol="MARK" -->'), 'src/a.ts': 'MARK\n', 'src/b.ts': 'MARK\n' },
      async () => ({ label: 'nothing', every: [], topmost: [] }),
    );
    // Two files with the same bytes: without their paths in the key, the second
    // is reported with the first one's name before anything has even changed.
    expect(outcome).toEqual({ defective: 'the first run', correct: null });
  });

  it('a result reused although its directive changed', async () => {
    const byPlace = (assertion: Parameters<NonNullable<SessionOptions['identify']>>[0]): string => JSON.stringify(assertion.location);
    const outcome = await control(
      { identify: byPlace },
      'every',
      { ...RULES('<!-- @assert-absence target="src" symbol="MARK" -->'), 'src/a.ts': 'MARK\n' },
      async (root) => ({ label: 'MARK becomes User', every: await write(root, 'docs/rules.md', '<!-- @assert-absence target="src" symbol="User" -->\n'), topmost: [] }),
    );
    expect(outcome).toEqual({ defective: 'step 1: MARK becomes User', correct: null });
  });
});
