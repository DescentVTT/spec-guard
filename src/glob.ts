/**
 * Dependency-free glob matching and directory walking.
 *
 * Windows shells do not expand globs, so `spec-guard "docs/**\/*.md"` must
 * behave identically on every platform. spec-guard therefore always expands
 * patterns itself instead of trusting the shell.
 */

import path from 'node:path';

import { nodeIo, type Io } from './io.js';
import { DEFAULT_SCOPE, type ScopePolicy, type SkipReason } from './scope.js';

const MAGIC_RE = /[*?[\]{}]/;

/** True when the pattern contains glob metacharacters. */
export function isGlob(pattern: string): boolean {
  return MAGIC_RE.test(pattern);
}

/** Normalises Windows separators so every internal path uses `/`. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

// No backslash on the list. `globToRegExp` runs its input through `toPosix`
// first, so by the time this is consulted there are no backslashes left to
// escape - an entry for one described a character that cannot arrive.
const REGEXP_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '|']);

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

/**
 * Builds a predicate for `exclude` patterns, following gitignore/ripgrep rules
 * rather than the include-filter rules above.
 *
 * The two are deliberately different, because users mean different things by
 * them. `glob="*.ts"` filters files. `exclude="tests"` means the tests
 * directory - everything under it - and `exclude="src/config"` means that
 * directory, not a file of that name. ripgrep's `-g !pattern` already behaves
 * this way; matching it here is what keeps the two engines from disagreeing.
 *
 * The rule is one line: a pattern without a slash is tested against every path
 * segment; a pattern with a slash is tested against the path and each of its
 * ancestor directories.
 */
export function createExcludeMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  if (patterns.length === 0) return () => false;

  const matchers = patterns.map((pattern) => {
    const normalized = toPosix(pattern)
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    return { regexp: globToRegExp(normalized), anchored: normalized.includes('/') };
  });

  return (relativePath: string): boolean => {
    const segments = relativePath.split('/');
    return matchers.some(({ regexp, anchored }) => {
      if (!anchored) return segments.some((segment) => regexp.test(segment));
      for (let depth = segments.length; depth > 0; depth--) {
        if (regexp.test(segments.slice(0, depth).join('/'))) return true;
      }
      return false;
    });
  };
}

export interface WalkOptions {
  /**
   * What may be walked. Defaults to DEFAULT_SCOPE.
   *
   * Note what is *not* here any more: a flag for hidden files. `.github`,
   * `.husky` and `.claude-rules` hold real code and configuration, and skipping
   * them by default meant an absence assertion could pass while the forbidden
   * thing sat in a workflow file. Dot-prefixed names are now ordinary names;
   * the only paths left out are the ones the scope policy names.
   */
  scope?: ScopePolicy;
  /** Follow symbolic links (off by default - cycles are not worth the risk). */
  followSymlinks?: boolean;
  /**
   * Called for every path the walk declined to inspect.
   *
   * A walk that quietly returns fewer files than the tree contains is the
   * defect this whole module was rewritten to remove, so the caller is told
   * rather than left to assume.
   */
  onSkip?: (relativePath: string, reason: SkipReason) => void;
  /**
   * Called for every directory the walk enters, below the one it started in.
   *
   * For the rules about directories (ADR-0013). Deriving directories from the
   * files a walk yields cannot see an empty one, and an empty package is the
   * clearest case of a package missing its manifest.
   */
  onDirectory?: (relativePath: string) => void;
  /**
   * The door the walk reads through, defaulting to the filesystem.
   *
   * Injectable first because the ordering guarantee below is otherwise
   * untestable on Windows: NTFS returns directory entries already sorted, so a
   * test that checks the output is ordered passes even if the sort is deleted.
   * An unordered reader makes the guarantee real on every platform. A watch
   * session now passes one too, to see what the walk read (ADR-0014).
   */
  io?: Io;
}

/** A file the walk found, before anyone has asked how big it is. */
export interface WalkedPath {
  absolutePath: string;
  /** Path relative to the walk root, POSIX separators. */
  relativePath: string;
}

export interface WalkedFile extends WalkedPath {
  size: number;
}

/** Orders directory entries by name, byte-wise and stable across platforms. */
export function compareDirents(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Depth-first directory walk yielding regular files with their sizes.
 * Emits nothing when `root` is missing or is not a directory.
 *
 * A file that is listed but cannot be stat'd - it was deleted mid-walk, or its
 * permissions forbid it - is reported as unreadable rather than yielded.
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const io = options.io ?? nodeIo;
  for await (const file of walkPaths(root, options)) {
    const stats = await io.stat(file.absolutePath);
    if (!stats) {
      options.onSkip?.(file.relativePath, 'unreadable');
      continue;
    }
    yield { ...file, size: stats.size };
  }
}

/**
 * The same walk, without a stat per file.
 *
 * Split out for the spec patterns, which need names and never sizes. The stat is
 * most of what a walk costs on Windows: 516ms for 1,200 files against 42ms for
 * the directory reads alone, measured when `spec-guard query` put a budget on
 * finding the specs. See ADR-0012.
 */
export async function* walkPaths(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedPath> {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const followSymlinks = options.followSymlinks ?? false;
  const io = options.io ?? nodeIo;
  const onSkip = options.onSkip;
  const seen = new Set<string>();

  async function* visit(directory: string, prefix: string): AsyncGenerator<WalkedPath> {
    let entries;
    try {
      entries = await io.readDirectory(directory);
    } catch {
      // A directory we cannot list may hold anything, so it is reported rather
      // than treated as empty.
      onSkip?.(prefix || '.', 'unreadable');
      return;
    }
    // Sorted explicitly: readdir order is filesystem-defined (NTFS happens to
    // return names in order, ext4 returns them in hash order), and spec-guard
    // reports snippets in a stable order regardless of where it runs.
    entries.sort(compareDirents);

    for (const entry of entries) {
      const name = entry.name;
      const absolutePath = path.join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        const stats = await io.stat(absolutePath);
        if (!stats) continue;
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      }

      if (isDirectory) {
        const reason = scope.skippedDirectories.get(name);
        if (reason !== undefined) {
          onSkip?.(relativePath, reason);
          continue;
        }
        // Each physical directory is visited at most once. That stops symlink
        // cycles, and - more importantly for a search tool - stops a linked
        // tree from counting the same match twice.
        const real = followSymlinks ? await io.realpath(absolutePath).catch(() => absolutePath) : absolutePath;
        if (seen.has(real)) continue;
        seen.add(real);
        options.onDirectory?.(relativePath);
        yield* visit(absolutePath, relativePath);
        continue;
      }

      if (!isFile) continue;
      yield { absolutePath, relativePath };
    }
  }

  const rootStats = await io.stat(root);
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
  io: Io = nodeIo,
): Promise<string[]> {
  const found = new Set<string>();

  for (const rawPattern of patterns) {
    const pattern = toPosix(rawPattern);

    if (!isGlob(pattern)) {
      const absolute = path.resolve(root, pattern);
      const stats = await io.stat(absolute);
      if (stats?.isFile()) {
        found.add(absolute);
      } else if (stats?.isDirectory()) {
        for await (const file of walkPaths(absolute, { io })) {
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

    for await (const file of walkPaths(walkRoot, { io })) {
      const candidate = isAbsolutePattern
        ? toPosix(file.absolutePath)
        : toPosix(path.relative(root, file.absolutePath));
      if (matcher(candidate)) found.add(file.absolutePath);
    }
  }

  return [...found].sort();
}
