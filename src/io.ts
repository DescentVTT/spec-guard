/**
 * The one door every read of a codebase goes through.
 *
 * A plain run reads through `nodeIo`. A watch session hands every reader a door
 * of its own that caches what was read and records who read it, because the
 * session can only evict what it saw being read, and it only sees reads here.
 * A module that reached for `node:fs` itself would be invisible to it, and a
 * rule that read through that module would go on reporting a file that has
 * since changed. ADR-0014 asserts that nothing else imports `node:fs`.
 */

import { promises as fs, watch, type Dirent, type Stats } from 'node:fs';

/** Reads one directory's entries, in whatever order the filesystem returns them. */
export type DirectoryReader = (directory: string) => Promise<Dirent[]>;

export interface Io {
  /** A directory's entries. Rejects when the directory cannot be listed. */
  readDirectory: DirectoryReader;
  /** `stat`, following links, or null for a path that cannot be stat'd. */
  stat(target: string): Promise<Stats | null>;
  /** A file's bytes. Rejects when the file cannot be read. */
  readFile(file: string): Promise<Buffer>;
  /** The path with every link resolved. Rejects when it cannot be resolved. */
  realpath(target: string): Promise<string>;
}

/**
 * The filesystem, as Node reads it.
 *
 * `stat` answers null rather than rejecting because every caller asks one
 * question of it - is anything there - and five `.catch(() => null)` tails were
 * five copies of that answer. The other three reject, because an unreadable
 * directory or file is something each caller reports in its own words.
 */
export const nodeIo: Io = {
  readDirectory: (directory) => fs.readdir(directory, { withFileTypes: true }),
  stat: (target) => fs.stat(target).catch(() => null),
  readFile: (file) => fs.readFile(file),
  realpath: (target) => fs.realpath(target),
};

/** A watch on a directory tree, until it is closed. */
export interface TreeWatcher {
  close(): void;
}

/** Reports that something under a watched root changed, or that it cannot tell what. */
export type TreeListener = (type: 'rename' | 'change', filename: string | null) => void;

/**
 * Watches everything under a directory, with one recursive watcher on it.
 *
 * One, not one per directory. A watcher holds its directory open, and on Windows
 * that makes renaming a directory above it fail with EPERM - which is what
 * `git checkout` and an editor's folder rename both do. ADR-0014 measured it.
 * Setting up the watch can throw, and a watch that fails later reports to
 * `onError`. Node's `watch` is a parameter so a test can make it fail.
 */
export function watchTree(root: string, listener: TreeListener, onError: (error: Error) => void, start: typeof watch = watch): TreeWatcher {
  const watcher = start(root, { recursive: true }, (type, filename) => listener(type, filename ?? null));
  watcher.on('error', onError);
  return { close: () => watcher.close() };
}

/** Reads a file as UTF-8 text through a door. */
export async function readText(io: Io, file: string): Promise<string> {
  return (await io.readFile(file)).toString('utf8');
}
