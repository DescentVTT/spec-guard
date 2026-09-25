/**
 * The overlay `prove` makes its violations in, and the door that reads the
 * disk once for it. ADR-0016.
 *
 * Every read a run makes goes through an `Io`, so a tree changed in memory is
 * a door that answers from a map before it asks the disk. What has to hold is
 * that a walk, a stat, a read and a listing all see the same changed tree, and
 * that nothing reaches the disk but reads.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkFiles } from '../src/glob.js';
import { nodeIo, readText, type Io } from '../src/io.js';
import { overlayIo, readOnce, type TreeEdit } from '../src/overlay.js';
import { makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

const ROOT = path.resolve('/virtual/overlay');
const BASE = memoryIo(ROOT, {
  'src/a.ts': 'a\n',
  'src/b.ts': 'b\n',
  'src/deep/c.ts': 'c\n',
  'docs/x.md': 'x\n',
});

const edit = (write: Record<string, string>, remove: string[] = []): TreeEdit => ({ write: new Map(Object.entries(write)), remove: new Set(remove) });
const at = (relative: string): string => path.join(ROOT, relative);

async function walked(io: Io, root = ROOT): Promise<string[]> {
  const files: string[] = [];
  for await (const file of walkFiles(root, { io })) files.push(`${file.relativePath}:${file.size}`);
  return files;
}

describe('a tree changed in memory', () => {
  it('adds a file, and every directory above it the base does not have', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'src/new/deeper/d.ts': 'dd\n' }));
    expect(await walked(io)).toEqual(['docs/x.md:2', 'src/a.ts:2', 'src/b.ts:2', 'src/deep/c.ts:2', 'src/new/deeper/d.ts:3']);
    expect(await readText(io, at('src/new/deeper/d.ts'))).toBe('dd\n');
    expect((await io.stat(at('src/new')))?.isDirectory()).toBe(true);
    expect((await io.stat(at('src/new')))?.isFile()).toBe(false);
    expect((await io.stat(at('src/new/deeper/d.ts')))?.isFile()).toBe(true);
    expect((await io.stat(at('src/new/deeper/d.ts')))?.isDirectory()).toBe(false);
    expect(await io.realpath(at('src/new/deeper'))).toBe(at('src/new/deeper'));
    expect(await io.realpath(at('src/new/deeper/d.ts'))).toBe(at('src/new/deeper/d.ts'));
    const listed = await io.readDirectory(at('src/new/deeper'));
    expect(listed.map((item) => [item.name, item.isFile(), item.isDirectory(), item.isSymbolicLink()])).toEqual([['d.ts', true, false, false]]);
  });

  it('replaces a file, listing it once with its new size', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'src/a.ts': 'replaced\n' }));
    expect(await walked(io)).toEqual(['docs/x.md:2', 'src/a.ts:9', 'src/b.ts:2', 'src/deep/c.ts:2']);
    expect(await readText(io, at('src/a.ts'))).toBe('replaced\n');
  });

  it('removes a file, and a directory with everything beneath it', async () => {
    const io = overlayIo(BASE, ROOT, edit({}, ['src/a.ts', 'src/deep']));
    expect(await walked(io)).toEqual(['docs/x.md:2', 'src/b.ts:2']);
    expect(await io.stat(at('src/a.ts'))).toBeNull();
    expect(await io.stat(at('src/deep/c.ts'))).toBeNull();
    await expect(io.readFile(at('src/deep/c.ts'))).rejects.toThrow('ENOENT');
    await expect(io.readDirectory(at('src/deep'))).rejects.toThrow('ENOENT');
    await expect(io.realpath(at('src/a.ts'))).rejects.toThrow('ENOENT');
    // A name that only starts like a removed one is still there.
    expect(await overlayIo(BASE, ROOT, edit({}, ['src/a'])).stat(at('src/a.ts'))).not.toBeNull();
  });

  it('writes a file back into a directory it removes, and lists only that', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'src/deep/new.ts': 'n\n' }, ['src/deep']));
    expect(await walked(io, at('src/deep'))).toEqual(['new.ts:2']);
    expect(await io.stat(at('src/deep/c.ts'))).toBeNull();
  });

  it('reads everything else from the base, as the base answers it', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'src/x.ts': '' }));
    expect(await readText(io, at('docs/x.md'))).toBe('x\n');
    expect((await io.stat(at('src/b.ts')))?.size).toBe(2);
    expect(await io.realpath(at('docs/x.md'))).toBe(at('docs/x.md'));
    await expect(io.readDirectory(at('nowhere'))).rejects.toThrow('ENOENT');
    await expect(io.readFile(at('nowhere.ts'))).rejects.toThrow('ENOENT');
    expect(await io.stat(at('nowhere'))).toBeNull();
  });

  it('answers a read of what it removed as the filesystem answers a missing path', async () => {
    const io = overlayIo(BASE, ROOT, edit({}, ['src/a.ts']));
    const gone = { code: 'ENOENT', message: `ENOENT: no such file or directory, '${at('src/a.ts')}' (removed in memory)` };
    await expect(io.readFile(at('src/a.ts'))).rejects.toMatchObject(gone);
    await expect(io.realpath(at('src/a.ts'))).rejects.toMatchObject(gone);
  });

  it('lists a directory it adds nothing to exactly as the base does', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'src/x.ts': '' }));
    const listed = await io.readDirectory(at('docs'));
    expect(listed.map((item) => [item.name, item.isFile()])).toEqual([['x.md', true]]);
  });

  it('lists a directory the base has, beside what the edit adds to it', async () => {
    const io = overlayIo(BASE, ROOT, edit({ 'docs/y.md': 'y' }));
    expect((await io.readDirectory(at('docs'))).map((item) => item.name).sort()).toEqual(['x.md', 'y.md']);
  });
});

describe('reading once', () => {
  it('asks the base about each path once, and hands out listings a walk may sort', async () => {
    const asked: string[] = [];
    const counting: Io = {
      readDirectory: async (directory) => {
        asked.push(`list ${path.relative(ROOT, directory).split(path.sep).join('/')}`);
        return BASE.readDirectory(directory);
      },
      stat: async (target) => {
        asked.push(`stat ${path.relative(ROOT, target).split(path.sep).join('/')}`);
        return BASE.stat(target);
      },
      readFile: async (file) => {
        asked.push(`read ${path.relative(ROOT, file).split(path.sep).join('/')}`);
        return BASE.readFile(file);
      },
      realpath: async (target) => {
        asked.push(`real ${path.relative(ROOT, target).split(path.sep).join('/')}`);
        return BASE.realpath(target);
      },
    };
    const io = readOnce(counting);
    for (let round = 0; round < 2; round += 1) {
      const listing = await io.readDirectory(at('src'));
      listing.reverse();
      expect((await io.readDirectory(at('src'))).map((item) => item.name)).toEqual(['a.ts', 'b.ts', 'deep']);
      await io.stat(at('src/a.ts'));
      await io.readFile(at('src/a.ts'));
      await io.realpath(at('src'));
    }
    expect(asked).toEqual(['list src', 'stat src/a.ts', 'read src/a.ts', 'real src']);
  });
});

describe('on disk', () => {
  let root: string;
  const snapshot = async (): Promise<string[]> => {
    const files: string[] = [];
    for await (const file of walkFiles(root)) {
      files.push(`${file.relativePath} ${createHash('sha256').update(await fs.readFile(file.absolutePath)).digest('hex')}`);
    }
    return files;
  };

  beforeAll(async () => {
    root = await makeTempRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  });
  afterAll(async () => {
    await removeTempRepo(root);
  });

  it('changes nothing on the disk it reads', async () => {
    const before = await snapshot();
    const io = overlayIo(nodeIo, root, edit({ 'src/a.ts': 'changed\n', 'src/new/c.ts': 'c\n' }, ['src/b.ts']));
    expect(await readText(io, path.join(root, 'src/a.ts'))).toBe('changed\n');
    expect(await readText(io, path.join(root, 'src/new/c.ts'))).toBe('c\n');
    expect(await io.stat(path.join(root, 'src/b.ts'))).toBeNull();
    expect(await snapshot()).toEqual(before);
  });
});
