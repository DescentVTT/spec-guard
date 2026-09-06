/**
 * Dependency-free glob matching and directory walking.
 *
 * Windows shells do not expand globs, so `spec-guard "docs/**\/*.md"` must
 * behave identically on every platform. spec-guard therefore always expands
 * patterns itself instead of trusting the shell.
 */

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

/** Directories never worth searching. Mirrors ripgrep's practical defaults. */
export const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'venv',
]);

const MAGIC_RE = /[*?[\]{}]/;

/** True when the pattern contains glob metacharacters. */
export function isGlob(pattern: string): boolean {
  return MAGIC_RE.test(pattern);
}

/** Normalises Windows separators so every internal path uses `/`. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

const REGEXP_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '|', '\\']);

/**
 * Converts a glob to an anchored RegExp.
 * Supports `*`, `**`, `?`, `[...]` and `{a,b}` - the subset every developer
 * already knows from .gitignore and ripgrep.
 */
export function globToRegExp(pattern: string, options: { ignoreCase?: boolean } = {}): RegExp {
  let source = '';
  let index = 0;
  const input = toPosix(pattern);

  while (index < input.length) {
    const char = input[index] as string;

    if (char === '*') {
      if (input[index + 1] === '*') {
        index += 2;
        if (input[index] === '/') {
          index += 1;
          source += '(?:[^/]*\\/)*';
        } else {
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const close = input.indexOf(']', index + 1);
      if (close === -1) {
        source += '\\[';
        index += 1;
        continue;
      }
      let body = input.slice(index + 1, close);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body}]`;
      index = close + 1;
      continue;
    }

    if (char === '{') {
      const close = input.indexOf('}', index + 1);
      if (close === -1) {
        source += '\\{';
        index += 1;
        continue;
      }
      const alternatives = input
        .slice(index + 1, close)
        .split(',')
        .map((alternative) => globToRegExp(alternative, options).source.slice(1, -1));
      source += `(?:${alternatives.join('|')})`;
      index = close + 1;
      continue;
    }

    source += REGEXP_SPECIALS.has(char) ? `\\${char}` : char;
    index += 1;
  }

  return new RegExp(`^${source}$`, options.ignoreCase ? 'i' : '');
}

/**
 * Builds a predicate over root-relative POSIX paths.
 *
 * Following ripgrep's `-g` semantics, a pattern without a `/` is matched
 * against the file's basename (`*.ts` matches `src/deep/a.ts`), while a pattern
 * containing `/` is matched against the whole relative path.
 */
export function createGlobMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  if (patterns.length === 0) return () => true;

  const matchers = patterns.map((pattern) => {
    let normalized = toPosix(pattern).replace(/^\.\//, '');
    if (normalized.endsWith('/')) normalized += '**';
    const basenameOnly = !normalized.includes('/');
    return { regexp: globToRegExp(normalized), basenameOnly };
  });

  return (relativePath: string): boolean =>
    matchers.some(({ regexp, basenameOnly }) =>
      regexp.test(basenameOnly ? path.posix.basename(relativePath) : relativePath),
    );
}

/** Reads one directory. Injectable so the ordering guarantee can be tested. */
export type DirectoryReader = (directory: string) => Promise<Dirent[]>;

export const defaultDirectoryReader: DirectoryReader = (directory) =>
  fs.readdir(directory, { withFileTypes: true });

export interface WalkOptions {
  /** Directory names to skip entirely. */
  ignoredDirectories?: ReadonlySet<string>;
  /** Include dotfiles and dot-directories. */
  includeHidden?: boolean;
  /** Follow symbolic links (off by default - cycles are not worth the risk). */
  followSymlinks?: boolean;
  /**
   * Directory reader, defaulting to `fs.readdir`.
   *
   * This exists because the ordering guarantee below is otherwise untestable on
   * Windows: NTFS returns directory entries already sorted, so a test that
   * checks the output is ordered passes even if the sort is deleted. Injecting
   * an unordered reader makes the guarantee real on every platform.
   */
  readDirectory?: DirectoryReader;
}

export interface WalkedFile {
  absolutePath: string;
  /** Path relative to the walk root, POSIX separators. */
  relativePath: string;
  size: number;
}

/** Orders directory entries by name, byte-wise and stable across platforms. */
export function compareDirents(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Depth-first directory walk yielding regular files.
 * Emits nothing when `root` is missing or is not a directory.
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const ignored = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
  const includeHidden = options.includeHidden ?? false;
  const followSymlinks = options.followSymlinks ?? false;
  const readDirectory = options.readDirectory ?? defaultDirectoryReader;
  const seen = new Set<string>();

  async function* visit(directory: string, prefix: string): AsyncGenerator<WalkedFile> {
    let entries;
    try {
      entries = await readDirectory(directory);
    } catch {
      return;
    }
    // Sorted explicitly: readdir order is filesystem-defined (NTFS happens to
    // return names in order, ext4 returns them in hash order), and spec-guard
    // reports snippets in a stable order regardless of where it runs.
    entries.sort(compareDirents);

    for (const entry of entries) {
      const name = entry.name;
      if (!includeHidden && name.startsWith('.')) continue;
      const absolutePath = path.join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        const stats = await fs.stat(absolutePath).catch(() => null);
        if (!stats) continue;
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      }

      if (isDirectory) {
        if (ignored.has(name)) continue;
        // Each physical directory is visited at most once. That stops symlink
        // cycles, and - more importantly for a search tool - stops a linked
        // tree from counting the same match twice.
        const real = followSymlinks ? await fs.realpath(absolutePath).catch(() => absolutePath) : absolutePath;
        if (seen.has(real)) continue;
        seen.add(real);
        yield* visit(absolutePath, relativePath);
        continue;
      }

      if (!isFile) continue;
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats) continue;
      yield { absolutePath, relativePath, size: stats.size };
    }
  }

  const rootStats = await fs.stat(root).catch(() => null);
  if (!rootStats?.isDirectory()) return;
  yield* visit(root, '');
}

/** Longest leading directory of a glob that contains no metacharacters. */
export function globBase(pattern: string): { base: string; rest: string } {
  const segments = toPosix(pattern).split('/');
  const base: string[] = [];
  let index = 0;
  for (; index < segments.length; index++) {
    const segment = segments[index] as string;
    if (isGlob(segment) || index === segments.length - 1) break;
    base.push(segment);
  }
  return { base: base.join('/'), rest: segments.slice(index).join('/') };
}

/**
 * Expands CLI spec patterns into a sorted, de-duplicated list of absolute file
 * paths. Plain paths are taken literally; a directory expands to the Markdown
 * files it contains.
 */
export async function expandSpecPatterns(
  patterns: readonly string[],
  root: string,
  defaultExtensions: readonly string[] = ['.md', '.markdown', '.mdx'],
): Promise<string[]> {
  const found = new Set<string>();

  for (const rawPattern of patterns) {
    const pattern = toPosix(rawPattern);

    if (!isGlob(pattern)) {
      const absolute = path.resolve(root, pattern);
      const stats = await fs.stat(absolute).catch(() => null);
      if (stats?.isFile()) {
        found.add(absolute);
      } else if (stats?.isDirectory()) {
        for await (const file of walkFiles(absolute)) {
          if (defaultExtensions.some((extension) => file.relativePath.toLowerCase().endsWith(extension))) {
            found.add(file.absolutePath);
          }
        }
      }
      continue;
    }

    const isAbsolutePattern = path.isAbsolute(pattern);
    const { base } = globBase(pattern);
    const walkRoot = isAbsolutePattern ? base || path.parse(pattern).root : path.resolve(root, base);
    const matcher = createGlobMatcher([pattern]);
    const includeHidden = pattern.split('/').some((segment) => segment.startsWith('.'));

    for await (const file of walkFiles(walkRoot, { includeHidden })) {
      const candidate = isAbsolutePattern
        ? toPosix(file.absolutePath)
        : toPosix(path.relative(root, file.absolutePath));
      if (matcher(candidate)) found.add(file.absolutePath);
    }
  }

  return [...found].sort();
}
