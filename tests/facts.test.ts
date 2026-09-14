/**
 * The facts a watch session knows about a tree. ADR-0014.
 *
 * Three promises: every read is served from one cache and recorded against
 * whoever made it; an event evicts what it may have changed and nothing it
 * cannot have; and a fact read again counts as changed only when something a
 * reader could observe is different.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createFactCache, FACT_POLICY, type FactKey, type WatchEvent } from '../src/facts.js';
import { nodeIo, type Io } from '../src/io.js';
import { contentHash } from '../src/memo.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** The filesystem, counting each read by kind and path. */
function counting(): { io: Io; reads: string[] } {
  const reads: string[] = [];
  const io: Io = {
    readDirectory: (directory) => {
      reads.push(`listing ${directory}`);
      return nodeIo.readDirectory(directory);
    },
    stat: (target) => {
      reads.push(`stat ${target}`);
      return nodeIo.stat(target);
    },
    readFile: (file) => {
      reads.push(`content ${file}`);
      return nodeIo.readFile(file);
    },
    realpath: (target) => {
      reads.push(`realpath ${target}`);
      return nodeIo.realpath(target);
    },
  };
  return { io, reads };
}

const change = (filename: string): WatchEvent => ({ type: 'change', filename: filename.split('/').join(path.sep) });
const rename = (filename: string): WatchEvent => ({ type: 'rename', filename: filename.split('/').join(path.sep) });

/** Reads all four kinds of fact about a small tree through one door. */
async function readEverything(root: string, door: Io): Promise<void> {
  await door.readDirectory(root);
  await door.readDirectory(path.join(root, 'src'));
  await door.readDirectory(path.join(root, 'src', 'deep'));
  await door.stat(path.join(root, 'src'));
  await door.stat(path.join(root, 'src', 'gone.ts'));
  await door.readFile(path.join(root, 'src', 'a.ts'));
  await door.readFile(path.join(root, 'src', 'deep', 'b.ts'));
  await door.realpath(path.join(root, 'src'));
}

/** The kind and root-relative path of every key, sorted, to read a set of facts at a glance. */
function named(root: string, keys: Iterable<FactKey>): string[] {
  const folded = path.resolve(root).normalize('NFC').toLowerCase();
  return [...keys]
    .map((key) => {
      const [kind, ...rest] = key.split(':');
      const relative = path.relative(folded, rest.join(':')).split(path.sep).join('/');
      return `${kind} ${relative || '.'}`;
    })
    .sort();
}

describe('a door onto the cache', () => {
  it('reads each fact once, however many doors ask, and records it against every one of them', async () => {
    const root = await tree({ 'src/a.ts': 'a', 'src/deep/b.ts': 'b' });
    const { io, reads } = counting();
    const cache = createFactCache(root, io);
    const first = new Set<FactKey>();
    const second = new Set<FactKey>();

    await readEverything(root, cache.view(first));
    await readEverything(root, cache.view(second));

    expect(reads).toHaveLength(8);
    expect(cache.size).toBe(8);
    expect(named(root, first)).toEqual(['content src/a.ts', 'content src/deep/b.ts', 'listing .', 'listing src', 'listing src/deep', 'realpath src', 'stat src', 'stat src/gone.ts']);
    expect([...second]).toEqual([...first]);
  });

  it('answers what the filesystem answered, a failure included, without asking again', async () => {
    const root = await tree({ 'src/a.ts': 'contents' });
    const { io, reads } = counting();
    const door = createFactCache(root, io).view(new Set());

    expect((await door.readFile(path.join(root, 'src/a.ts'))).toString()).toBe('contents');
    expect(await door.stat(path.join(root, 'src/gone.ts'))).toBeNull();
    expect((await door.stat(path.join(root, 'src')))?.isDirectory()).toBe(true);
    expect((await door.readDirectory(path.join(root, 'src'))).map((entry) => entry.name)).toEqual(['a.ts']);
    expect(await door.realpath(path.join(root, 'src'))).toBe(await fs.realpath(path.join(root, 'src')));

    const missing = path.join(root, 'src/gone.ts');
    await expect(door.readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(door.readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(door.readDirectory(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(door.realpath(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(reads.filter((read) => read.endsWith('gone.ts'))).toHaveLength(4);
  });

  it('treats two spellings of one path as one fact', async () => {
    const root = await tree({ 'src/a.ts': 'a' });
    const { io, reads } = counting();
    const record = new Set<FactKey>();
    const door = createFactCache(root, io).view(record);
    await door.readFile(path.join(root, 'src', 'a.ts'));
    await door.readFile(`${root}/src/./a.ts`);
    expect(reads).toHaveLength(1);
    expect(record.size).toBe(1);
  });
});

describe('evict', () => {
  async function evicted(events: WatchEvent[], files: Record<string, string> = { 'src/a.ts': 'a', 'src/deep/b.ts': 'b' }): Promise<string[]> {
    const root = await tree(files);
    const cache = createFactCache(root, nodeIo);
    await readEverything(root, cache.view(new Set()));
    const before = cache.size;
    const gone = cache.evict(events);
    expect(cache.size).toBe(before - gone.size);
    return named(root, gone.keys());
  }

  it('evicts a file, the listing of the directory it is in, and nothing else, for a change', async () => {
    expect(await evicted([change('src/a.ts')])).toEqual(['content src/a.ts', 'listing src']);
  });

  it('evicts everything beneath a path that was renamed, and its parent listing', async () => {
    expect(await evicted([rename('src/deep')])).toEqual(['content src/deep/b.ts', 'listing src', 'listing src/deep']);
    expect(await evicted([rename('src')])).toEqual([
      'content src/a.ts',
      'content src/deep/b.ts',
      'listing .',
      'listing src',
      'listing src/deep',
      'realpath src',
      'stat src',
      'stat src/gone.ts',
    ]);
  });

  it('evicts only a directory and its parent listing for a change to a directory whose listing it knows', async () => {
    // Windows reports this on every save inside src. The files beneath have
    // events of their own, and re-reading all of them would cost the run.
    expect(await evicted([change('src')])).toEqual(['listing .', 'listing src', 'realpath src', 'stat src']);
  });

  it('evicts beneath a directory it has no listing of, even for a change', async () => {
    const root = await tree({ 'lib/a.ts': 'a' });
    const cache = createFactCache(root, nodeIo);
    await cache.view(new Set()).readFile(path.join(root, 'lib/a.ts'));
    expect(named(root, cache.evict([change('lib')]).keys())).toEqual(['content lib/a.ts']);
  });

  it('evicts a path that is not there yet, so a negative answer is not kept', async () => {
    expect(await evicted([rename('src/gone.ts')])).toEqual(['listing src', 'stat src/gone.ts']);
  });

  it('evicts nothing for a path it holds no facts near', async () => {
    expect(await evicted([rename('elsewhere/x.ts'), change('node_modules/y/z.js')])).toEqual([]);
  });

  it('evicts everything for an event that could not name a path', async () => {
    expect(await evicted([change('src/a.ts'), { type: 'change', filename: null }])).toHaveLength(8);
  });

  it('matches an event to a fact whatever the case of either', async () => {
    expect(await evicted([change('SRC/A.TS')])).toEqual(['content src/a.ts', 'listing src']);
  });

  it('does not evict a sibling whose name merely starts with the path', async () => {
    const root = await tree({ 'src/a.ts': 'a', 'src-old/b.ts': 'b' });
    const cache = createFactCache(root, nodeIo);
    const door = cache.view(new Set());
    await door.readFile(path.join(root, 'src/a.ts'));
    await door.readFile(path.join(root, 'src-old/b.ts'));
    expect(named(root, cache.evict([rename('src')]).keys())).toEqual(['content src/a.ts']);
  });

  it('forgets everything on request', async () => {
    const root = await tree({ 'src/a.ts': 'a', 'src/deep/b.ts': 'b' });
    const cache = createFactCache(root, nodeIo);
    await readEverything(root, cache.view(new Set()));
    expect(cache.evictAll().size).toBe(8);
    expect(cache.size).toBe(0);
  });
});

describe('refresh', () => {
  async function refreshed(
    files: Record<string, string>,
    read: (root: string, door: Io) => Promise<unknown>,
    edit: (root: string) => Promise<unknown>,
    events: WatchEvent[],
    used: (key: FactKey) => boolean = () => true,
  ): Promise<{ changed: string[]; reads: string[]; size: number }> {
    const root = await tree(files);
    const { io, reads } = counting();
    const cache = createFactCache(root, io);
    await read(root, cache.view(new Set()));
    await edit(root);
    reads.length = 0;
    const changed = await cache.refresh(cache.evict(events), used);
    return { changed: named(root, changed), reads: reads.map((entry) => entry.replace(root, '').split(path.sep).join('/')), size: cache.size };
  }

  it('finds no change in a file saved with the same bytes, or only a new timestamp', async () => {
    const outcome = await refreshed(
      { 'a.ts': 'same' },
      (root, door) => Promise.all([door.readFile(path.join(root, 'a.ts')), door.stat(path.join(root, 'a.ts')), door.readDirectory(root)]),
      async (root) => {
        await fs.writeFile(path.join(root, 'a.ts'), 'same');
        await fs.utimes(path.join(root, 'a.ts'), new Date(), new Date(Date.now() + 60_000));
      },
      [change('a.ts')],
    );
    expect(outcome).toMatchObject({ changed: [], size: 3 });
    expect(outcome.reads.sort()).toEqual(['content /a.ts', 'listing ', 'stat /a.ts']);
  });

  it('finds a change in different bytes, even of the same size', async () => {
    const outcome = await refreshed(
      { 'a.ts': 'aaaa' },
      (root, door) => door.readFile(path.join(root, 'a.ts')),
      (root) => fs.writeFile(path.join(root, 'a.ts'), 'bbbb'),
      [change('a.ts')],
    );
    expect(outcome.changed).toEqual(['content a.ts']);
  });

  it('finds a change in a file that grew, or disappeared, by its stat', async () => {
    const grew = await refreshed(
      { 'a.ts': 'a' },
      (root, door) => door.stat(path.join(root, 'a.ts')),
      (root) => fs.writeFile(path.join(root, 'a.ts'), 'aa'),
      [change('a.ts')],
    );
    expect(grew.changed).toEqual(['stat a.ts']);
    const gone = await refreshed({ 'a.ts': 'a' }, (root, door) => door.stat(path.join(root, 'a.ts')), (root) => fs.rm(path.join(root, 'a.ts')), [rename('a.ts')]);
    expect(gone.changed).toEqual(['stat a.ts']);
  });

  it('finds no change in a directory whose size its filesystem reports differently, only in one that stopped being one', async () => {
    const same = await refreshed(
      { 'd/a.ts': 'a' },
      (root, door) => door.stat(path.join(root, 'd')),
      (root) => fs.writeFile(path.join(root, 'd/b.ts'), 'many more bytes than before'),
      [rename('d')],
    );
    expect(same.changed).toEqual([]);
    const replaced = await refreshed(
      { 'd/a.ts': 'a' },
      (root, door) => door.stat(path.join(root, 'd')),
      async (root) => {
        await fs.rm(path.join(root, 'd'), { recursive: true });
        await fs.writeFile(path.join(root, 'd'), 'now a file');
      },
      [rename('d')],
    );
    expect(replaced.changed).toEqual(['stat d']);
  });

  it('finds a change in a listing when a name comes or goes, or changes kind, and not otherwise', async () => {
    const list = (root: string, door: Io): Promise<unknown> => door.readDirectory(path.join(root, 'd'));
    expect((await refreshed({ 'd/a.ts': 'a' }, list, (root) => fs.writeFile(path.join(root, 'd/b.ts'), ''), [rename('d/b.ts')])).changed).toEqual(['listing d']);
    expect((await refreshed({ 'd/a.ts': 'a' }, list, (root) => fs.rm(path.join(root, 'd/a.ts')), [rename('d/a.ts')])).changed).toEqual(['listing d']);
    expect(
      (
        await refreshed(
          { 'd/a.ts': 'a' },
          list,
          async (root) => {
            await fs.rm(path.join(root, 'd/a.ts'));
            await fs.mkdir(path.join(root, 'd/a.ts'));
          },
          [rename('d/a.ts')],
        )
      ).changed,
    ).toEqual(['listing d']);
    expect((await refreshed({ 'd/a.ts': 'a' }, list, (root) => fs.writeFile(path.join(root, 'd/a.ts'), 'longer now'), [change('d/a.ts')])).changed).toEqual([]);
  });

  it('finds a change in why a file could not be read, and none in why a directory could not be listed', async () => {
    const unreadable = await refreshed(
      { 'a.ts': 'a' },
      (root, door) => door.readFile(path.join(root, 'gone.ts')).catch(() => null),
      (root) => fs.mkdir(path.join(root, 'gone.ts')),
      [rename('gone.ts')],
    );
    // ENOENT, then EISDIR: the import index reports the message.
    expect(unreadable.changed).toEqual(['content gone.ts']);
    const unlistable = await refreshed(
      { 'a.ts': 'a' },
      (root, door) => door.readDirectory(path.join(root, 'gone')).catch(() => null),
      (root) => fs.writeFile(path.join(root, 'gone'), 'a file'),
      [rename('gone')],
    );
    expect(unlistable.changed).toEqual([]);
  });

  it('finds no change in a real path resolved again to the same place', async () => {
    const outcome = await refreshed({ 'd/a.ts': 'a' }, (root, door) => door.realpath(path.join(root, 'd')), async () => {}, [rename('d')]);
    expect(outcome).toMatchObject({ changed: [], reads: ['realpath /d'], size: 1 });
  });

  it('reads again only what somebody used, and forgets the rest', async () => {
    const outcome = await refreshed(
      { 'a.ts': 'a', 'b.ts': 'b' },
      (root, door) => Promise.all([door.readFile(path.join(root, 'a.ts')), door.readFile(path.join(root, 'b.ts'))]),
      (root) => Promise.all([fs.writeFile(path.join(root, 'a.ts'), 'A'), fs.writeFile(path.join(root, 'b.ts'), 'B')]),
      [change('a.ts'), change('b.ts')],
      (key) => key.endsWith(`${path.sep}a.ts`.toLowerCase()),
    );
    expect(outcome).toMatchObject({ changed: ['content a.ts'], reads: ['content /a.ts'], size: 1 });
  });

  it('compares with a fact read again since the eviction, rather than reading it a third time', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const { io, reads } = counting();
    const cache = createFactCache(root, io);
    const door = cache.view(new Set());
    await door.readFile(path.join(root, 'a.ts'));
    await fs.writeFile(path.join(root, 'a.ts'), 'changed');
    const gone = cache.evict([change('a.ts')]);
    await door.readFile(path.join(root, 'a.ts'));
    expect(named(root, await cache.refresh(gone, () => true))).toEqual(['content a.ts']);
    expect(reads).toHaveLength(2);
  });
});

describe('FACT_POLICY', () => {
  const ok = (value: unknown) => ({ ok: true as const, value });
  const failed = (message: string) => ({ ok: false as const, error: new Error(message) });
  const entry = (name: string, kind: 'file' | 'directory' | 'link' | 'other') => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'link',
  });
  const stats = (kind: 'file' | 'directory' | 'other', size: number) => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'directory', size });
  const { fingerprint } = FACT_POLICY;

  it('sees a listing as its names and the kind of each, in no particular order', () => {
    const listing = (...entries: unknown[]) => fingerprint('listing', ok(entries));
    expect(listing(entry('b', 'file'), entry('a', 'directory'), entry('c', 'link'))).toBe(listing(entry('c', 'link'), entry('a', 'directory'), entry('b', 'file')));
    const kinds = ['file', 'directory', 'link', 'other'] as const;
    expect(new Set(kinds.map((kind) => listing(entry('a', kind)))).size).toBe(4);
    expect(listing(entry('a', 'file'))).not.toBe(listing(entry('b', 'file')));
    expect(listing(entry('ab', 'file'))).not.toBe(listing(entry('a', 'file'), entry('b', 'file')));
    // An empty directory and one that could not be listed are different answers.
    expect(listing()).not.toBe(fingerprint('listing', failed('EACCES')));
  });

  it('sees a stat as present or missing, its kind, and a file\'s size only', () => {
    const stat = (value: unknown) => fingerprint('stat', ok(value));
    expect(new Set([stat(null), stat(stats('file', 0)), stat(stats('directory', 0)), stat(stats('other', 0))]).size).toBe(4);
    expect(stat(stats('file', 1))).not.toBe(stat(stats('file', 2)));
    expect(stat(stats('directory', 1))).toBe(stat(stats('directory', 4096)));
    expect(stat(stats('other', 1))).toBe(stat(stats('other', 2)));
  });

  it('sees contents by a hash, not by the bytes, and a failure to read them by its message', () => {
    const big = Buffer.alloc(1_000_000, 1);
    expect(fingerprint('content', ok(big))).toBe(JSON.stringify(contentHash(big)));
    expect(fingerprint('content', ok(Buffer.from('a')))).not.toBe(fingerprint('content', ok(Buffer.from('b'))));
    expect(fingerprint('content', failed('ENOENT: x'))).not.toBe(fingerprint('content', failed('EISDIR: x')));
    expect(fingerprint('content', failed('x'))).not.toBe(fingerprint('content', ok(Buffer.from('x'))));
  });

  it('sees a real path by its value, and a failure to resolve one only as a failure', () => {
    expect(fingerprint('realpath', ok('/a'))).not.toBe(fingerprint('realpath', ok('/b')));
    expect(fingerprint('realpath', failed('x'))).toBe(fingerprint('realpath', failed('y')));
    expect(fingerprint('listing', failed('x'))).toBe(fingerprint('listing', failed('y')));
    expect(fingerprint('realpath', failed('x'))).not.toBe(fingerprint('realpath', ok('x')));
  });
});
