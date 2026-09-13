/**
 * `@assert-structure`: what files are called, what directories hold, and which
 * files come in pairs. ADR-0013.
 *
 * Names only. Nothing here reads a file's contents, and nothing asks the
 * filesystem whether a path exists: a path exists when its name is in its
 * parent's listing, compared exactly. A lookup of `README.md` finds `Readme.md`
 * on Windows and macOS and does not on Linux, and a rule about names that
 * answers one way on a laptop and the other in CI is not a rule about names.
 */

import path from 'node:path';

import { comparePaths } from './engine.js';
import {
  createExcludeMatcher,
  createGlobMatcher,
  defaultDirectoryReader,
  globToRegExp,
  isGlob,
  toPosix,
  walkPaths,
  type DirectoryReader,
} from './glob.js';
import { LedgerBuilder, UNCERTAIN_REASONS, type ScopeLedger, type ScopePolicy } from './scope.js';
import type { StructureQuery } from './types.js';

/** One directory entry, as the walk's reader lists it. */
type Entry = Awaited<ReturnType<DirectoryReader>>[number];

/** A directory's entries, by name. */
export type Listing = ReadonlyMap<string, Entry>;

/** The names under one target. Every path is relative to the root. */
export interface Tree {
  files: string[];
  /** Every directory below the target, empty ones included. */
  directories: string[];
  /** Directories that could not be listed. */
  gaps: string[];
}

/**
 * The listings of one run, each directory read at most once.
 *
 * The walk and the lookups read through the same cache, so a partner beside its
 * file is found in the listing the walk already made, and five rules over `src`
 * cost one walk of it - the same bargain the import index and the scope probe
 * make.
 */
export interface TreeIndex {
  /**
   * The entries of a root-relative directory, reached by name from the root, or
   * null when it is not there or cannot be listed.
   *
   * Every directory on the way has to be in its parent's listing as a directory.
   * So `Tests/` does not stand in for `tests/` on a filesystem that would allow
   * it, and a symbolic link is not followed: its entry is a link, not a
   * directory.
   */
  listing(relativeDirectory: string): Promise<Listing | null>;
  /** The names under a target, walked once per run for each target and scope. */
  walk(target: string, scope: ScopePolicy): Promise<Tree>;
}

export function createTreeIndex(root: string, readDirectory: DirectoryReader = defaultDirectoryReader): TreeIndex {
  // Each directory's read, by its path from the root, kept twice over: as the
  // reader returned it, for the walk - which needs a failed read to fail, and
  // sorts in place a list that is then already sorted - and as a lookup by
  // name, built once. Keyed by the relative path rather than the absolute one
  // because a lookup names every directory on its way, and joining an absolute
  // path per segment was most of what a partner rule cost over ten thousand
  // files.
  const reads = new Map<string, { entries: Promise<Entry[]>; listing: Promise<Listing | null> }>();
  const walks = new Map<string, Promise<Tree>>();

  const read = (relativeDirectory: string): { entries: Promise<Entry[]>; listing: Promise<Listing | null> } => {
    let cached = reads.get(relativeDirectory);
    if (!cached) {
      const entries = readDirectory(path.join(root, relativeDirectory));
      const listing = entries.then(
        (found) => new Map(found.map((entry) => [entry.name, entry])),
        () => null,
      );
      cached = { entries, listing };
      reads.set(relativeDirectory, cached);
    }
    return cached;
  };

  const listing = async (relativeDirectory: string): Promise<Listing | null> => {
    let current = await read('.').listing;
    if (relativeDirectory === '.') return current;
    const names = relativeDirectory.split('/');
    for (const [depth, name] of names.entries()) {
      if (current?.get(name)?.isDirectory() !== true) return null;
      current = await read(names.slice(0, depth + 1).join('/')).listing;
    }
    return current;
  };

  const walk = (target: string, scope: ScopePolicy): Promise<Tree> => {
    const key = JSON.stringify([target, [...scope.skippedDirectories.keys()]]);
    let pending = walks.get(key);
    if (!pending) {
      pending = (async (): Promise<Tree> => {
        const tree: Tree = { files: [], directories: [], gaps: [] };
        const fromRoot = (relativePath: string): string => path.posix.join(target, relativePath);
        const walked = walkPaths(path.join(root, target), {
          scope,
          readDirectory: (directory) => read(toPosix(path.relative(root, directory)) || '.').entries,
          onDirectory: (relativePath) => tree.directories.push(fromRoot(relativePath)),
          // Only the gaps. `.git` and `node_modules` are the run's policy, and
          // are no more news here than they are to a search.
          onSkip: (relativePath, reason) => {
            if (UNCERTAIN_REASONS.has(reason)) tree.gaps.push(fromRoot(relativePath));
          },
        });
        for await (const file of walked) tree.files.push(fromRoot(file.relativePath));
        return tree;
      })();
      walks.set(key, pending);
    }
    return pending;
  };

  return { listing, walk };
}

/** What a root-relative path is, by name - or null, which a link is too. */
async function kindOf(index: TreeIndex, relativePath: string): Promise<'file' | 'directory' | null> {
  if (relativePath === '.') return 'directory';
  const entry = (await index.listing(path.posix.dirname(relativePath)))?.get(path.posix.basename(relativePath));
  return entry?.isDirectory() ? 'directory' : entry?.isFile() ? 'file' : null;
}

/**
 * Whether a directory holds a required entry: a file, or a directory when it
 * ends in `/` - which `basename` and `dirname` both already ignore.
 */
async function holds(index: TreeIndex, directory: string, entry: string): Promise<boolean> {
  const wantsDirectory = entry.endsWith('/');
  const named = globToRegExp(path.posix.basename(entry));
  const listing = await index.listing(path.posix.join(directory, path.posix.dirname(entry)));
  return [...(listing?.values() ?? [])].some(
    (item) => named.test(item.name) && (wantsDirectory ? item.isDirectory() : item.isFile()),
  );
}

/* -------------------------------------------------------------- the grammar */

const PLACEHOLDER = /\[(name|ext|dir)\]/g;

/**
 * The path a partner template names for a file.
 *
 * `[name]` is the base name up to its last dot and `[ext]` is what follows it;
 * a name whose only dot leads it, like `.env`, is all name. `[dir]` is the
 * file's directory below the target it was found from - empty for a file at the
 * top, or for a target that is the file itself - and a segment left empty leaves
 * no separator behind. A template without a `/` names a sibling; a template
 * with one names a path from the root.
 *
 * That is the whole grammar, and it is small on purpose: a reader can expand a
 * template by eye, which is the property a substitution engine gives up.
 */
export function expandPartner(template: string, file: string, target: string): string {
  const directory = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const dot = base.lastIndexOf('.');
  const values: Record<string, string> = {
    name: dot > 0 ? base.slice(0, dot) : base,
    ext: dot > 0 ? base.slice(dot + 1) : '',
    dir: path.posix.relative(file === target ? directory : target, directory),
  };
  const filled = template
    .split('/')
    .map((segment) => segment.replace(PLACEHOLDER, (_, key: string) => values[key] as string))
    .filter((segment) => segment.length > 0)
    .join('/');
  return template.includes('/') ? filled : path.posix.join(directory, filled);
}

/** Why a partner template cannot be used, or null when it can. */
export function partnerTemplateIssue(template: string): string | null {
  const literal = template.replace(PLACEHOLDER, '');
  const unknown = /\[[^\]]*\]/.exec(literal);
  if (unknown) {
    return `Partner template "${template}" uses ${unknown[0]}; the placeholders are [name], [ext] and [dir].`;
  }
  if (isGlob(literal)) {
    return `Partner template "${template}" is a name, not a glob, so it cannot hold *, ?, [, ], { or }.`;
  }
  if (template.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `Partner template "${template}" must be a path inside the root, with no empty, "." or ".." segment.`;
  }
  return null;
}

/** Why a required entry cannot be used, or null when it can. */
export function requiredEntryIssue(entry: string): string | null {
  const segments = entry.replace(/\/$/, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `Required entry "${entry}" must be a path inside the directory, with no empty, "." or ".." segment.`;
  }
  if (segments.slice(0, -1).some(isGlob)) {
    return `Required entry "${entry}" can use a glob only in its last segment.`;
  }
  return null;
}

/* ---------------------------------------------------------------- the check */

export interface StructureRequest {
  /** Root-relative targets; `.` is the root. */
  targets: readonly string[];
  globs: readonly string[];
  excludeGlobs: readonly string[];
  scope: ScopePolicy;
}

export interface StructureViolation {
  /** The misnamed or partnerless file, or the directory missing an entry. */
  path: string;
  /** What is wrong with it. */
  text: string;
}

export interface StructureCheck {
  /** Targets whose names are not there. */
  missing: string[];
  /** Targets of a `required` rule that are files, which hold nothing. */
  notDirectories: string[];
  /** How many files or directories the claim was held to. Zero is an empty scope. */
  inspected: number;
  violations: StructureViolation[];
  /** A template that names the file itself, at the first file where it does. */
  selfPartner?: { file: string; template: string };
  /** Directories under a target that could not be listed. */
  scope: ScopeLedger;
}

/**
 * Holds every file or directory in scope to the claim.
 *
 * A subject is counted once, with the first target that reaches it - which is
 * the target `[dir]` is measured from when two targets overlap.
 */
export async function checkStructure(
  query: StructureQuery,
  request: StructureRequest,
  index: TreeIndex,
): Promise<StructureCheck> {
  const excluded = createExcludeMatcher(request.excludeGlobs);
  const included = createGlobMatcher(request.globs);
  const required = query.claim === 'required';
  const selects = query.dirs === undefined ? null : globToRegExp(query.dirs);
  const missing: string[] = [];
  const notDirectories: string[] = [];
  const gaps = new Set<string>();
  const subjects = new Map<string, string>();
  const add = (subject: string, target: string): void => {
    if (!subjects.has(subject)) subjects.set(subject, target);
  };

  for (const target of request.targets) {
    const kind = await kindOf(index, target);
    if (kind === 'file') {
      if (required) notDirectories.push(target);
      else if (included(target) && !excluded(target)) add(target, target);
    } else if (kind !== 'directory') {
      missing.push(target);
    } else if (required && selects === null) {
      if (!excluded(target)) add(target, target);
    } else {
      const tree = await index.walk(target, request.scope);
      for (const gap of tree.gaps) gaps.add(gap);
      if (selects !== null) {
        for (const directory of tree.directories) {
          if (!excluded(directory) && selects.test(path.posix.relative(target, directory))) add(directory, target);
        }
      } else {
        for (const file of tree.files) if (included(file) && !excluded(file)) add(file, target);
      }
    }
  }

  const ledger = new LedgerBuilder();
  for (const gap of gaps) ledger.add(gap, 'unreadable');
  const ordered = [...subjects].sort(([a], [b]) => comparePaths(a, b));
  const check: StructureCheck = {
    missing,
    notDirectories,
    inspected: ordered.length,
    violations: [],
    scope: ledger.build(),
  };

  if (query.claim === 'pattern') {
    const named = createGlobMatcher(query.values);
    for (const [file] of ordered) {
      if (!named(file)) check.violations.push({ path: file, text: `matches none of ${query.values.join(', ')}` });
    }
    return check;
  }

  if (required) {
    const found = await Promise.all(
      ordered.map(([directory]) => Promise.all(query.values.map((entry) => holds(index, directory, entry)))),
    );
    ordered.forEach(([directory], at) => {
      const lacking = query.values.filter((_, position) => !(found[at] as boolean[])[position]);
      if (lacking.length > 0) check.violations.push({ path: directory, text: `missing ${lacking.join(', ')}` });
    });
    return check;
  }

  // Partners. Expanded before anything is looked up, so a template naming the
  // file itself is refused rather than satisfied by every file.
  const partners = ordered.map(([file, target]) => query.values.map((template) => expandPartner(template, file, target)));
  const expectedBy = new Map<string, string>();
  for (const [at, [file]] of ordered.entries()) {
    const names = partners[at] as string[];
    const own = names.indexOf(file);
    if (own !== -1) return { ...check, selfPartner: { file, template: query.values[own] as string } };
    for (const name of names) if (!expectedBy.has(name)) expectedBy.set(name, file);
  }

  const found = await Promise.all(
    partners.map((names) =>
      Promise.all(
        names.map(
          async (name) =>
            (await index.listing(path.posix.dirname(name)))?.get(path.posix.basename(name))?.isFile() === true,
        ),
      ),
    ),
  );
  ordered.forEach(([file], at) => {
    if ((found[at] as boolean[]).includes(true)) return;
    // The likeliest reason a file has no partner is that it is one, and the
    // directive forgot to exclude the partners.
    const owner = expectedBy.get(file);
    const hint = owner === undefined ? '' : ` (it is the partner of ${owner} - exclude it?)`;
    check.violations.push({ path: file, text: `has no partner ${(partners[at] as string[]).join(' or ')}${hint}` });
  });
  return check;
}
