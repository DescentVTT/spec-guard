/**
 * A tree changed in memory, read through the one door (ADR-0014).
 *
 * `spec-guard prove` shows that a rule can fail by making the violation it
 * forbids and running the rule over it (ADR-0016). The violation is made here:
 * files added, replaced or removed in a map, in front of the door a run would
 * otherwise read the disk through. Nothing is written, so a run that is
 * interrupted, or a violation nobody meant to keep, leaves the working tree as
 * it was - which is the only acceptable way for a tool that promises never to
 * write the tree to try breaking it.
 */

import path from 'node:path';

import type { Io } from './io.js';

/** Changes to a tree, by root-relative path. */
export interface TreeEdit {
  /** Files added or replaced, with their new contents. */
  write: ReadonlyMap<string, string>;
  /** Files or directories removed, each with everything beneath it. */
  remove: ReadonlySet<string>;
}

type Entry = Awaited<ReturnType<Io['readDirectory']>>[number];
type Stats = NonNullable<Awaited<ReturnType<Io['stat']>>>;
type Kind = 'file' | 'directory';

/** A directory entry for a path the edit made, which has no inode to describe. */
function entry(name: string, kind: Kind): Entry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
  } as Entry;
}

/** The part of `stat` a run reads, for a path the edit made. */
function made(kind: Kind, size: number): Stats {
  return { isFile: () => kind === 'file', isDirectory: () => kind === 'directory', size } as Stats;
}

/** What a read of a path the edit removed answers. */
function missing(target: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${target}' (removed in memory)`), { code: 'ENOENT' });
}

/**
 * A door that reads `base` with the edit applied on top.
 *
 * A written file is there with its new contents, and every directory above it
 * is there too, whether or not the disk has it. A removed path is gone with
 * everything beneath it, except what the edit writes there again. Listings are
 * merged by name, so a replaced file is listed once.
 */
export function overlayIo(base: Io, root: string, edit: TreeEdit): Io {
  const written = new Map([...edit.write].map(([file, text]) => [path.resolve(root, file), Buffer.from(text)]));
  const removed = [...edit.remove].map((target) => path.resolve(root, target));
  // What the edit puts in each directory, by name: every written file, and every
  // directory above one, up to the filesystem's root, which has no parent.
  const children = new Map<string, Map<string, Kind>>();
  const place = (target: string, kind: Kind): void => {
    const parent = path.dirname(target);
    if (parent === target) return;
    children.set(parent, (children.get(parent) ?? new Map<string, Kind>()).set(path.basename(target), kind));
    place(parent, 'directory');
  };
  for (const file of written.keys()) place(file, 'file');

  const gone = (target: string): boolean =>
    !written.has(target) &&
    !children.has(target) &&
    removed.some((removal) => target === removal || target.startsWith(`${removal}${path.sep}`));

  return {
    async readDirectory(directory) {
      const absolute = path.resolve(directory);
      if (gone(absolute)) throw missing(directory);
      const added = children.get(absolute);
      const listed = await base.readDirectory(directory).catch((error: unknown) => {
        if (added === undefined) throw error;
        return [];
      });
      const byName = new Map<string, Entry>();
      for (const item of listed) {
        if (!gone(path.join(absolute, item.name))) byName.set(item.name, item);
      }
      for (const [name, kind] of added ?? []) byName.set(name, entry(name, kind));
      return [...byName.values()];
    },
    async stat(target) {
      const absolute = path.resolve(target);
      const bytes = written.get(absolute);
      if (bytes !== undefined) return made('file', bytes.length);
      if (children.has(absolute)) return made('directory', 0);
      return gone(absolute) ? null : base.stat(target);
    },
    async readFile(file) {
      const absolute = path.resolve(file);
      const bytes = written.get(absolute);
      if (bytes !== undefined) return bytes;
      if (gone(absolute)) throw missing(file);
      return base.readFile(file);
    },
    async realpath(target) {
      const absolute = path.resolve(target);
      if (written.has(absolute) || children.has(absolute)) return absolute;
      if (gone(absolute)) throw missing(target);
      return base.realpath(target);
    },
  };
}

/**
 * A door that reads each thing once.
 *
 * `prove` runs a rule several times over trees that differ from the disk by a
 * file or two, and the disk does not change under it: it writes nothing, and
 * the tree a run reads has to be one tree. So every read of the base is kept
 * for the length of the command. A listing is copied out each time, because
 * the walk sorts what it is given in place.
 */
export function readOnce(base: Io): Io {
  const listings = new Map<string, ReturnType<Io['readDirectory']>>();
  const statted = new Map<string, ReturnType<Io['stat']>>();
  const contents = new Map<string, ReturnType<Io['readFile']>>();
  const resolved = new Map<string, ReturnType<Io['realpath']>>();
  const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = read();
      cache.set(key, pending);
    }
    return pending;
  };
  return {
    readDirectory: async (directory) => [...(await once(listings, path.resolve(directory), () => base.readDirectory(directory)))],
    stat: (target) => once(statted, path.resolve(target), () => base.stat(target)),
    readFile: (file) => once(contents, path.resolve(file), () => base.readFile(file)),
    realpath: (target) => once(resolved, path.resolve(target), () => base.realpath(target)),
  };
}
