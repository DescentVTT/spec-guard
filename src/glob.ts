/**
 * Glob matching and directory walking.
 *
 * Windows shells do not expand globs, so `spec-guard "docs/**\/*.md"` must
 * behave identically on every platform. spec-guard therefore always expands
 * patterns itself instead of trusting the shell.
 *
 * Matching is spec-core's, copied into src/vendor/spec-core: one automaton that
 * keeps a set of live states and so cannot backtrack, in three named dialects.
 * Each kind of pattern here is one of them, read case-sensitively on every host.
 * `glob=` is `ripgrep`, `exclude=`, `module=` and a layer are `gitignore`, and
 * a pattern matched against a whole path from where it starts - `dirs=`, a
 * required entry's name - is `path`. What is walked, and what the walk skips,
 * stays here. ADR-0015.
 */

import path from 'node:path';

import { nodeIo, type Io } from './io.js';
import { DEFAULT_SCOPE, type ScopePolicy, type SkipReason } from './scope.js';
import { globWitness, parseGlob, type Glob, type GlobOptions, type GlobParse } from './vendor/spec-core/pattern/index.js';

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
 *
 * @deprecated Nothing in spec-guard matches with this any more: a glob is read
 * by spec-core's automaton, which cannot backtrack (ADR-0015). This compiled
 * `*-*-*-*-*-*x` to a pattern that took 28 seconds to fail a 121-character
 * name, read `**` inside a segment as crossing directories, and took an unclosed
 * `[` or `{` as a literal. It stays for callers of the API, and the tests keep
 * it as the oracle for everything the two readings agree on.
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
 * An include glob in the one form both engines are given: forward slashes, no
 * surrounding space, no leading `./`, and a trailing slash read as everything
 * under the directory.
 *
 * ripgrep used to be handed the glob as written, and matched nothing for
 * `./src/*.ts` or `src/` while the scanner matched the files. ADR-0014. The
 * space is trimmed because spec-core trims it, and ripgrep would have read it
 * as part of a name.
 */
export function normalizeGlob(pattern: string): string {
  const normalized = toPosix(pattern.trim()).replace(/^\.\//, '');
  return normalized.endsWith('/') ? `${normalized}**` : normalized;
}

/**
 * An `exclude` pattern in the one form both engines are given: forward slashes,
 * no surrounding space, no leading `./` and no trailing slash. A leading `/`
 * stays, because it means something: see `createExcludeMatcher`.
 *
 * ripgrep used to be handed the pattern as written, and read three shapes
 * differently from the scanner. `./build` and `src\build` excluded nothing, and
 * `build/` did not exclude a file named `build`. ADR-0014.
 */
export function normalizeExclude(pattern: string): string {
  return toPosix(pattern.trim()).replace(/^\.\//, '').replace(/\/+$/, '');
}

/* --------------------------------------------------------------- readings */

// Case-sensitive, every one: the family's rule for paths, since git's are and a
// result must not depend on the host it ran on (spec-core ADR-0005).
const RIPGREP: GlobOptions = { dialect: 'ripgrep', caseSensitive: true };
const GITIGNORE: GlobOptions = { dialect: 'gitignore', caseSensitive: true };
// A pattern with no glob syntax names exactly one path, never a directory and
// what is beneath it: `dirs="packages"` is that directory, and `README.md` is
// that file.
const WHOLE: GlobOptions = { dialect: 'path', caseSensitive: true, literal: 'file' };

/**
 * Which part of a path decides whether a pattern matches it: its last segment,
 * any one of its segments, or only the whole of it.
 */
export type PatternShape = 'last' | 'any' | 'whole';

/** A pattern as spec-core read it, and what of a path its answer depends on. */
interface Reading {
  parsed: GlobParse;
  shape: PatternShape;
}

/**
 * An include glob, as `glob=` means it.
 *
 * A leading `/` anchors it at the root, as ripgrep reads `-g /src/*.ts` and as
 * `exclude` reads `/build`. spec-core's ripgrep dialect reads it as the root of
 * the filesystem, which no path relative to the root is under, so the slash is
 * dropped and the rest read as a whole path. Otherwise a pattern that is one
 * segment in every alternative is a file name at any depth, and so decided by
 * a path's last segment alone.
 */
function readInclude(pattern: string): Reading {
  const normalized = normalizeGlob(pattern);
  // The first run of slashes, which a pattern that starts with one starts with.
  if (normalized.startsWith('/')) return { parsed: parseGlob(normalized.replace(/\/+/, ''), WHOLE), shape: 'whole' };
  const parsed = parseGlob(normalized, RIPGREP);
  return { parsed, shape: parsed.ok && oneSegment(normalized) ? 'last' : 'whole' };
}

/**
 * An exclusion, a module or a layer, as `.gitignore` reads a line: one that is
 * one segment in every alternative, and not anchored by a leading `/`, matches
 * a path when it matches any one of the path's segments.
 */
function readExclude(pattern: string): Reading {
  const normalized = normalizeExclude(pattern);
  const parsed = parseGlob(normalized, GITIGNORE);
  const floating = parsed.ok && !normalized.startsWith('/') && oneSegment(normalized);
  return { parsed, shape: floating ? 'any' : 'whole' };
}

/** A pattern matched against a whole path from where it starts, with `\` a separator as it is everywhere here. */
function readWhole(pattern: string): Reading {
  return { parsed: parseGlob(toPosix(pattern), WHOLE), shape: 'whole' };
}

/** What of a path decides whether a glob or an exclusion matches it. */
export function patternShape(pattern: string, kind: 'include' | 'exclude'): PatternShape {
  return (kind === 'include' ? readInclude(pattern) : readExclude(pattern)).shape;
}

/** A pattern's segments, as spec-core counts them: an empty or `.` segment is none. */
function segmentsOf(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** Whether every alternative of a pattern spec-core accepted is one segment. */
function oneSegment(pattern: string): boolean {
  return expandBraces(lex(pattern)).every((tokens) => segmentsOf(tokens.join('')).length === 1);
}

/** The predicate a reading produced, or an error naming the pattern as it was written. */
function matcherOf(reading: Reading, kind: string, pattern: string): (relativePath: string) => boolean {
  if (!reading.parsed.ok) throw new Error(`invalid ${kind} pattern "${pattern}": ${reading.parsed.error}`);
  return globPredicate(reading.parsed.glob, reading.shape);
}

/** Why a reading failed, in the words `matcherOf` would throw, or null. */
function refusal(reading: Reading, kind: string, pattern: string): string | null {
  return reading.parsed.ok ? null : `invalid ${kind} pattern "${pattern}": ${reading.parsed.error}`;
}

/**
 * A predicate over paths from one compiled glob, asking the glob no more often
 * than the pattern's shape requires.
 *
 * Every answer is the automaton's. But a Thompson automaton keeps a set of live
 * states per character where a RegExp compiled to machine code, and asked of
 * every path the matching took 26 times as long: 261 ms against 10 over the
 * 10,446 paths in this repository's node_modules, for three globs and four
 * exclusions (ADR-0015). A tree repeats its names - those paths hold 6,714
 * distinct segments - and most patterns are one segment in every alternative,
 * `*.ts`, `tests`, `node:fs`, whose answer for a path is their answer for its
 * last segment or for one of its segments. So those are asked once per segment.
 * Any other pattern can only match below the directories spec-core names as its
 * bases, and a path outside all of them is answered without asking.
 */
export function globPredicate(glob: Pick<Glob, 'match' | 'bases'>, shape: PatternShape): (relativePath: string) => boolean {
  if (shape === 'whole') {
    const { bases } = glob;
    return (relativePath) =>
      bases.some((base) => base === '' || relativePath.startsWith(`${base}/`)) && glob.match(relativePath);
  }
  const known = new Map<string, boolean>();
  const matches = (segment: string): boolean => {
    let answer = known.get(segment);
    if (answer === undefined) {
      answer = glob.match(segment);
      known.set(segment, answer);
    }
    return answer;
  };
  return shape === 'last'
    ? (relativePath) => matches(relativePath.slice(relativePath.lastIndexOf('/') + 1))
    : (relativePath) => relativePath.split('/').some(matches);
}

/**
 * Why an include glob cannot be read, or null when it can.
 *
 * A malformed glob - an unclosed `[` or `{`, an extended glob such as `+(a|b)`,
 * a `..` - used to be read anyway: as a literal, or as whatever the regular
 * expression it compiled to happened to mean. A typo read as a literal is a
 * filter that matches nothing and reports clean, so it is refused.
 */
export function globPatternError(pattern: string): string | null {
  return refusal(readInclude(pattern), 'glob', pattern);
}

/** Why a module pattern or a layer cannot be read, or null when it can. */
export function modulePatternError(pattern: string, kind: 'module' | 'layer' = 'module'): string | null {
  return refusal(readExclude(pattern), kind, pattern);
}

/**
 * A name a module pattern or a layer matches, or null when it matches none.
 *
 * The shortest spec-core's witness search finds, so a literal is itself -
 * `node:fs`, `src/db` - and `@app/db/**` is a name just below `@app/db`.
 * `spec-guard prove` imports it, to show a rule about the module that it can
 * fail (ADR-0016).
 */
export function moduleWitness(pattern: string): string | null {
  const { parsed } = readExclude(pattern);
  if (!parsed.ok) return null;
  const found = globWitness([parsed.glob]);
  return found.kind === 'found' ? found.path : null;
}

/** Why a pattern read against a whole path - `dirs=`, a required entry's name - cannot be read, or null. */
export function pathPatternError(pattern: string): string | null {
  return refusal(readWhole(pattern), 'glob', pattern);
}

/**
 * Why an exclude pattern can never leave anything out, or null when it can.
 *
 * Each of the first four matched nothing under both engines, and nothing said
 * so. The one that matters is `!`: in `.gitignore` it re-includes a path, and a
 * list copied from one kept `build` and silently lost
 * `!build/generated/needed.ts`, so the exclusion was wider than the list reads.
 * A `..` or a drive path points outside the root, where nothing is searched,
 * and `.` or `/` names the root itself, which no path under it is. After those,
 * whatever spec-core refuses: a malformed pattern excludes nothing either.
 */
export function excludePatternError(pattern: string): string | null {
  const normalized = normalizeExclude(pattern);
  const reason = normalized.startsWith('!')
    ? 'negation patterns are not supported in exclude'
    : normalized.split('/').includes('..')
      ? '".." leads out of the root, and only paths inside it are searched'
      : /^[a-zA-Z]:\//.test(normalized)
        ? 'exclusions are relative to the root, and a drive path is not'
        : normalized === '' || normalized === '.'
          ? 'it names the root itself rather than a path under it'
          : null;
  return reason === null ? refusal(readExclude(pattern), 'exclude', pattern) : `invalid exclude pattern "${pattern}": ${reason}`;
}

/** The error for the first pattern in a list that cannot be read, by the given check, or null. */
export function patternListError(patterns: readonly string[], check: (pattern: string) => string | null): string | null {
  for (const pattern of patterns) {
    const error = check(pattern);
    if (error !== null) return error;
  }
  return null;
}

/** The error for the first pattern in a list that can never exclude anything, or null. */
export function excludeListError(patterns: readonly string[]): string | null {
  return patternListError(patterns, excludePatternError);
}

/**
 * Builds a predicate over root-relative POSIX paths.
 *
 * Following ripgrep's `-g` semantics, a pattern without a `/` is matched
 * against the file's name at any depth (`*.ts` matches `src/deep/a.ts`), while
 * a pattern containing `/` is matched against the whole relative path. Each
 * alternative of a `{a,b}` decides that for itself. Throws for a pattern that
 * cannot be read; a directive's patterns are refused before a matcher is built.
 */
export function createGlobMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  if (patterns.length === 0) return () => true;
  const matchers = patterns.map((pattern) => matcherOf(readInclude(pattern), 'glob', pattern));
  return (relativePath: string): boolean => matchers.some((matches) => matches(relativePath));
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
 * The rule is one line: a pattern matches a path or any directory above it,
 * and it is anchored at the root when it holds a `/` anywhere but at its end.
 * A leading slash anchors and is otherwise dropped, as it is in `.gitignore`:
 * `/build` is the `build` at the root, where `build` is one at any depth.
 * ripgrep always read it that way, and the scanner used to match nothing for
 * it, so a rule excluding `/target` gave a different count on a tree large
 * enough for `auto` to pick ripgrep.
 */
export function createExcludeMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const matchers = patterns.map((pattern) => matcherOf(readExclude(pattern), 'exclude', pattern));
  return (relativePath: string): boolean => matchers.some((matches) => matches(relativePath));
}

/**
 * Builds a predicate for one pattern matched against a whole path from where
 * it starts: `dirs="*"` against a directory below a target, a required entry's
 * name against the names in a directory. `*` is one segment, `**` any number of
 * them, and a pattern with no glob syntax names one path exactly.
 */
export function createPathMatcher(pattern: string): (relativePath: string) => boolean {
  return matcherOf(readWhole(pattern), 'glob', pattern);
}

/* ------------------------------------------------------- what ripgrep reads */

/**
 * The globs ripgrep is handed for one normalised pattern: the same set of
 * paths spec-core reads it as, spelled so that ripgrep's globset reads it the
 * same way.
 *
 * Handed the pattern as spec-guard normalised it, ripgrep still read four
 * shapes differently from the scanner, and each is measured in ADR-0015:
 * - it decides whether a glob is anchored from the whole glob, where spec-core
 *   decides for each alternative of its braces, so `{src/*.ts,*.md}` found
 *   `*.md` only at the root;
 * - it drops an empty alternative, so `{,src/}a.ts` never found `a.ts`;
 * - it keeps `.` and empty segments, which spec-core drops, so `src/./a.ts`
 *   matched nothing;
 * - it refuses a `}` that closes nothing, which spec-core reads as itself.
 *
 * So the braces are expanded here, one glob per alternative, each alternative
 * is cleaned of `.` and empty segments and anchored or not by its own shape,
 * and a lone `}` is written as the class `[}]`. Only ever given a pattern
 * spec-core accepts, since a directive's are refused before anything runs.
 */
export function ripgrepGlobs(normalized: string): string[] {
  const rooted = normalized.startsWith('/');
  const globs = expandBraces(lex(normalized)).map((tokens) => {
    const segments = segmentsOf(tokens.map((token) => (token === '}' ? '[}]' : token)).join(''));
    const text = segments.join('/');
    // ripgrep reads a leading `!` as negation and spec-core reads it as a
    // character. Only an alternative can start with one - a pattern that does
    // is refused - and a prefix that changes nothing else keeps it a character.
    if (rooted || (segments.length > 1 && text.startsWith('!'))) return `/${text}`;
    return text.startsWith('!') ? `**/${text}` : text;
  });
  return [...new Set(globs)];
}

/**
 * A pattern spec-core accepted, cut into classes, braces, commas and the runs
 * of anything else between them. A class is one token, so what it holds is
 * never read as a brace or a comma: it opens with `[`, may be negated with `!`
 * or `^`, and its first member is a member even when it is `]`.
 */
function lex(pattern: string): string[] {
  return pattern.match(/\[[!^]?\]?[^\]]*\]|[{},]|[^[{},]+/g) as string[];
}

/**
 * `{a,b}` groups expanded into the patterns they stand for, as spec-core
 * expands them: groups nest, and a `}` that closes nothing is a character.
 * Every `{` closes, since spec-core accepted the pattern.
 */
function expandBraces(tokens: readonly string[]): Array<readonly string[]> {
  const open = tokens.indexOf('{');
  if (open === -1) return [tokens];
  let close = open;
  for (let depth = 1; depth > 0; depth += nesting(tokens[close] as string)) close += 1;
  const options: string[][] = [[]];
  let depth = 0;
  for (const token of tokens.slice(open + 1, close)) {
    if (token === ',' && depth === 0) {
      options.push([]);
    } else {
      depth += nesting(token);
      (options[options.length - 1] as string[]).push(token);
    }
  }
  return options.flatMap((option) => expandBraces([...tokens.slice(0, open), ...option, ...tokens.slice(close + 1)]));
}

/** How a token moves the depth of brace groups. */
function nesting(token: string): number {
  return token === '{' ? 1 : token === '}' ? -1 : 0;
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
 *
 * A glob is walked from its literal base and matched below it, so the base is
 * never read as a glob: `../shared/docs/*.md` names a directory outside the
 * root, whose `..` a glob may not hold, and `C:/repo/docs/*.md` a drive. What
 * is below is read as `glob=` reads the pattern: `*.md` by name at any depth,
 * `docs/*.md` as the whole path. A pattern spec-core refuses is an error that
 * names it, where it used to be read as a literal and match nothing.
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

    const normalized = normalizeGlob(pattern);
    const isAbsolutePattern = path.isAbsolute(normalized);
    const { base, rest } = globBase(normalized);
    const walkRoot = isAbsolutePattern ? base || path.parse(normalized).root : path.resolve(root, base);
    // With no base, what is left is the whole pattern, and reads as glob= does.
    // Below a base every alternative is anchored, since each holds the base's `/`.
    const matches = matcherOf(base === '' && !isAbsolutePattern ? readInclude(rest) : readWhole(rest), 'spec', rawPattern);

    for await (const file of walkPaths(walkRoot, { io })) {
      if (matches(file.relativePath)) found.add(file.absolutePath);
    }
  }

  return [...found].sort();
}
