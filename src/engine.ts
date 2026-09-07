/**
 * Search engines.
 *
 * There is one set of semantics here, not two. The scanner reads files, counts
 * matches, classifies comments, decides what is binary and keeps the ledger of
 * what it could not inspect. ripgrep answers one question - which files under
 * these targets contain this text at all - and everything downstream of that is
 * the scanner's work, for both engines.
 *
 * It was not always so, and the reason for the rewrite is worth keeping: the
 * two used to be independent implementations, and they drifted. On a tree with
 * eight copies of one symbol the scanner found two and ripgrep found four,
 * because one honoured .gitignore and the other did not, one skipped a
 * hardcoded list of directory names and the other did not, and they disagreed
 * about binary files. Nothing in the output said so. See ADR-0007.
 *
 * Both engines expose a batch API. Scanning a tree costs the same whether you
 * look for one symbol or twenty, so assertions that share a target set and
 * flags are answered by a single pass.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createCommentMask, type CommentMask } from './comments.js';
import { createExcludeMatcher, createGlobMatcher, toPosix, walkFiles } from './glob.js';
import {
  isBinary,
  LedgerBuilder,
  MAX_LEDGER_ENTRIES,
  UNCERTAIN_REASONS,
  type SkippedPath,
} from './scope.js';
import type { EngineName, MatchLocation, SearchOptions, SearchResult } from './types.js';

/** Files larger than this are skipped by both engines, keeping them in sync. */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Hard cap on collected locations; the reporter only ever shows a handful. */
const MAX_COLLECTED_MATCHES = 500;

/** Longest line snippet echoed back to the terminal. */
const MAX_SNIPPET_LENGTH = 200;

export interface SearchRequest {
  /** Absolute root directory. All targets are resolved against it. */
  root: string;
  /** Literal string or regular expression source. */
  symbol: string;
  /** Existing target paths, relative to root, POSIX separators. */
  targets: string[];
  options: SearchOptions;
}

export interface Engine {
  readonly name: EngineName;
  search(request: SearchRequest): Promise<SearchResult>;
  /**
   * Answers several requests that share a root, target list and options.
   * Optional: `runSearches` falls back to parallel `search` calls.
   */
  searchBatch?(requests: SearchRequest[]): Promise<SearchResult[]>;
}

export type EnginePreference = 'auto' | 'ripgrep' | 'javascript';

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value: string): string {
  const trimmed = value.replace(/\r?\n$/, '');
  return trimmed.length > MAX_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH)}…` : trimmed;
}


/**
 * Orders matches by path, then by line. ripgrep searches in parallel and emits
 * files in no fixed order, so this is what makes snippet output stable.
 */
export function sortLocations(locations: MatchLocation[]): MatchLocation[] {
  return locations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Per-pattern accumulator used by both engines. */
interface Tally {
  count: number;
  locations: MatchLocation[];
  /** Matches skipped because they were inside a comment. */
  commentCount: number;
}

function emptyTally(): Tally {
  return { count: 0, locations: [], commentCount: 0 };
}


/** Requests that may share one pass: same root, same targets, same options. */
function sharesOnePass(requests: readonly SearchRequest[]): boolean {
  const [first] = requests;
  /* c8 ignore next -- runSearches never passes an empty list here */
  if (!first) return false;
  return requests.every(
    (request) =>
      request.root === first.root &&
      request.targets.length === first.targets.length &&
      request.targets.every((target, index) => target === first.targets[index]) &&
      request.options.regex === first.options.regex &&
      request.options.word === first.options.word &&
      request.options.ignoreCase === first.options.ignoreCase &&
      request.options.globs.length === first.options.globs.length &&
      request.options.globs.every((glob, index) => glob === first.options.globs[index]) &&
      request.options.excludeGlobs.length === first.options.excludeGlobs.length &&
      request.options.excludeGlobs.every((glob, index) => glob === first.options.excludeGlobs[index]) &&
      request.options.excludeFiles === first.options.excludeFiles,
  );
}

/** Runs requests through the batch API when the engine has one. */
export async function runSearches(engine: Engine, requests: SearchRequest[]): Promise<SearchResult[]> {
  if (requests.length === 0) return [];
  if (requests.length === 1 || !engine.searchBatch || !sharesOnePass(requests)) {
    return Promise.all(requests.map((request) => engine.search(request)));
  }
  return engine.searchBatch(requests);
}

/* ------------------------------------------------------------------ ripgrep */

/** Resolved once per process: the ripgrep binary to use, or null if absent. */
let ripgrepProbe: Promise<string | null> | undefined;

export function resetRipgrepProbe(): void {
  ripgrepProbe = undefined;
}

/** Locates a usable `rg` binary. `SPEC_GUARD_RG` overrides PATH lookup. */
export function findRipgrep(): Promise<string | null> {
  ripgrepProbe ??= new Promise<string | null>((resolve) => {
    const binary = process.env.SPEC_GUARD_RG || 'rg';
    let child;
    try {
      child = spawn(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* c8 ignore next 3 -- spawn only throws synchronously on bad arguments */
      resolve(null);
      return;
    }
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? binary : null));
  });
  return ripgrepProbe;
}


/**
 * Builds the argv that makes ripgrep walk exactly what the scanner walks.
 *
 * Almost every flag here switches off an opinion. ripgrep's defaults are
 * excellent for a developer grepping their own checkout and wrong for a rule
 * about a repository:
 *
 *   --hidden      `.github`, `.husky` and `.claude-rules` hold real code, and
 *                 leaving them out let an absence assertion pass while the
 *                 forbidden thing sat in a workflow file.
 *   --no-ignore   .gitignore says what git should carry, not what a rule
 *                 covers - and it applies only inside a git repository, so the
 *                 same tree answered differently depending on whether a .git
 *                 directory happened to exist above it.
 *
 * What remains is spec-guard's own scope policy, passed as exclusions so that
 * both engines skip the same four names for the same reasons. Those come last
 * because ripgrep lets a later glob override an earlier one, and a policy skip
 * must not be undone by a user's `glob="*.ts"`.
 */
export function buildRipgrepArgs(request: SearchRequest, patterns: readonly string[] = [request.symbol]): string[] {
  const { options } = request;
  const args = [
    '--files-with-matches',
    // The only separator a filename cannot contain.
    '--null',
    '--no-config',
    '--hidden',
    '--no-ignore',
    //   --text        ripgrep treats a file named on the command line as text
    //                 and a file it walked into as binary, so the same bytes
    //                 were listed or not depending on how they were reached.
    //                 The scanner decides what is binary, once, for both
    //                 engines; ripgrep's job is only to say which files matched.
    '--text',
    `--max-filesize=${MAX_FILE_SIZE}`,
  ];
  if (!options.regex) args.push('--fixed-strings');
  if (options.word) args.push('--word-regexp');
  if (options.ignoreCase) args.push('--ignore-case');
  for (const glob of options.globs) args.push('--glob', glob);
  // ripgrep reads a leading "!" as an exclusion, with gitignore semantics that
  // createExcludeMatcher mirrors for the JavaScript engine.
  for (const glob of options.excludeGlobs) args.push('--glob', `!${glob}`);
  for (const name of options.scope.skippedDirectories.keys()) args.push('--glob', `!${name}/`);
  for (const pattern of patterns) args.push('--regexp', pattern);
  args.push('--');
  args.push(...(request.targets.length > 0 ? request.targets : ['.']));
  return args;
}

/**
 * ripgrep, used as a pre-filter rather than as a counter.
 *
 * The two engines used to be two implementations of the same semantics, and
 * they drifted: ripgrep honoured .gitignore and the scanner did not, the
 * scanner skipped a hardcoded list of directory names and ripgrep did not, and
 * a binary file was searched by one and skipped by the other. Same tree, two
 * answers, no warning.
 *
 * So ripgrep no longer decides anything. It answers one question - which files
 * under these targets contain this text at all - and the scanner does the rest:
 * counting, comment classification, binary handling, positions, the ledger.
 * There is one implementation of the semantics, and ripgrep supplies the thing
 * it is unmatched at, which is getting from thousands of files down to a
 * handful very quickly.
 *
 * That also removes the batching problem. Attributing a match to the right
 * pattern used to be delicate, because one ripgrep pass over several patterns
 * cannot always say which one matched; as a pre-filter it does not need to,
 * since including a file that turns out not to match is free.
 */
class RipgrepEngine implements Engine {
  readonly name: EngineName = 'ripgrep';

  constructor(private readonly binary: string) {}

  async search(request: SearchRequest): Promise<SearchResult> {
    const [result] = await this.searchBatch([request]);
    return result as SearchResult;
  }

  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    /* c8 ignore next -- runSearches never passes an empty list */
    if (!first) return [];

    const patterns = [...new Set(requests.map((request) => request.symbol))];
    const { files, unreadable } = await this.filesWithMatches(first, patterns);
    const results = await javascriptEngine.searchFiles(files, requests, unreadable);
    // The result names ripgrep because ripgrep is what searched the tree; the
    // scanner is a shared post-step, not a different engine.
    return results.map((result) => ({ ...result, engine: this.name }));
  }

  /** Which files contain any of these patterns, and which could not be read. */
  private filesWithMatches(
    request: SearchRequest,
    patterns: string[],
  ): Promise<{ files: CandidateFile[]; unreadable: string[] }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, buildRipgrepArgs(request, patterns), {
        cwd: request.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr += chunk));

      child.once('error', reject);
      child.once('close', (code) => {
        // 0 = matches, 1 = none, anything else is a real failure.
        if (code !== 0 && code !== 1) {
          reject(new Error(`ripgrep exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        const files: CandidateFile[] = [];
        // --null separates paths with NUL, which is the only separator a file
        // name cannot contain. Splitting on newlines loses files whose names
        // contain one.
        for (const entry of stdout.split('\0')) {
          if (entry.length === 0) continue;
          const absolutePath = path.resolve(request.root, entry);
          if (request.options.excludeFiles.has(absolutePath)) continue;
          files.push({ absolutePath, relativePath: toPosix(path.relative(request.root, absolutePath)) });
        }
        files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
        resolve({ files, unreadable: parseRipgrepErrors(stderr) });
      });
    });
  }
}

/**
 * Pulls the paths out of ripgrep's stderr.
 *
 * `--no-messages` used to be passed, which threw these away: a file ripgrep
 * could not open produced no match, no error and no difference from a file that
 * was searched and found clean. ripgrep writes one line per failure, as
 * `path: reason`, and the path is what the report needs.
 *
 * Anything that does not parse is returned as-is rather than dropped, on the
 * principle that an unexplained line from a subprocess is still information.
 */
export function parseRipgrepErrors(stderr: string): string[] {
  const paths: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // "rg: " prefixes ripgrep's own diagnostics rather than a file's.
    const body = line.startsWith('rg: ') ? line.slice(4) : line;
    const separator = body.indexOf(': ');
    paths.push(separator === -1 ? body : body.slice(0, separator));
  }
  return paths;
}

/* --------------------------------------------------------------- javascript */

/** Builds the matching RegExp shared by the JS engine. */
export function buildJsRegExp(symbol: string, options: SearchOptions): RegExp {
  const flags = `g${options.ignoreCase ? 'i' : ''}`;
  if (options.regex) {
    const source = options.word ? `(?<![A-Za-z0-9_])(?:${symbol})(?![A-Za-z0-9_])` : symbol;
    return new RegExp(source, flags);
  }
  const escaped = escapeRegExp(symbol);
  const source = options.word ? `(?<![\\p{L}\\p{N}_])(?:${escaped})(?![\\p{L}\\p{N}_])` : escaped;
  return new RegExp(source, `${flags}u`);
}


interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

class JavaScriptEngine implements Engine {
  readonly name: EngineName = 'javascript';

  async search(request: SearchRequest): Promise<SearchResult> {
    const [result] = await this.searchBatch([request]);
    return result as SearchResult;
  }

  /**
   * Batching here is unconditionally safe: every pattern is scanned
   * independently over the same file contents, so the answers are identical to
   * separate passes - only the file reads are shared.
   */
  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];

    const enumeration = await enumerateCandidates(first);
    return this.searchFiles(enumeration.files, requests, [], enumeration.skipped);
  }

  /**
   * Scans an already-enumerated file list.
   *
   * `unreadable` carries paths a caller already knows it could not open -
   * ripgrep reports those on stderr, and they belong in the same ledger as the
   * ones this scanner discovers for itself.
   */
  async searchFiles(
    files: readonly CandidateFile[],
    requests: SearchRequest[],
    unreadable: readonly string[] = [],
    skipped: readonly SkippedPath[] = [],
  ): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];
    const ledger = new LedgerBuilder();
    for (const entry of skipped) ledger.add(entry.path, entry.reason, entry.matches);
    for (const entry of unreadable) ledger.add(entry, 'unreadable');
    const patterns = [...new Set(requests.map((request) => request.symbol))];
    const regexps = new Map(patterns.map((pattern) => [pattern, buildJsRegExp(pattern, first.options)]));
    const tallies = new Map<string, Tally>(patterns.map((pattern) => [pattern, emptyTally()]));

    const concurrency = Math.min(16, Math.max(1, files.length));
    let cursor = 0;
    const perFile = new Map<string, Map<string, Tally>>();
    let unclassifiedFiles = 0;

    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const file = files[cursor++];
        /* c8 ignore next -- cursor is bounded by files.length */
        if (!file) return;
        const buffer = await fs.readFile(file.absolutePath).catch(() => null);
        if (!buffer) {
          // A file we cannot open might hold anything, so it is recorded rather
          // than passed over as though it had been read and found clean.
          ledger.add(file.relativePath, 'unreadable');
          continue;
        }
        const content = buffer.toString('utf8');
        let mask: CommentMask | undefined;
        const getMask = first.options.ignoreComments
          ? (): CommentMask => (mask ??= createCommentMask(content, file.relativePath))
          : undefined;

        const scanned = new Map<string, Tally>();
        for (const [pattern, regexp] of regexps) {
          scanned.set(pattern, scanContent(content, file.relativePath, regexp, getMask));
        }

        if (isBinary(buffer)) {
          // Searched, but not counted. Skipping binary files silently was a way
          // to pass an assertion by never looking; searching them and saying
          // what was found leaves the decision with the reader.
          //
          // Only a binary file that *did* contain the symbol goes in the
          // ledger. One that did not is not a gap - it was read, searched and
          // found clean - and leaving it out is also what keeps the two engines
          // reporting the same thing, since ripgrep only ever hands the scanner
          // files that matched.
          const found = [...scanned.values()].reduce((total, tally) => total + tally.count, 0);
          if (found > 0) ledger.add(file.relativePath, 'binary', found);
          continue;
        }
        // A mask exists only if some pattern matched, since that is the only
        // thing that calls getMask - so reaching here already means this file
        // matched and its language was not understood.
        if (mask && !mask.classified) unclassifiedFiles += 1;
        perFile.set(file.relativePath, scanned);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    // Merge in walk order so snippets come out sorted by path, like ripgrep's.
    for (const file of files) {
      const scanned = perFile.get(file.relativePath);
      if (!scanned) continue;
      for (const [pattern, tally] of scanned) {
        const total = tallies.get(pattern) as Tally;
        total.count += tally.count;
        total.commentCount += tally.commentCount;
        for (const location of tally.locations) {
          if (total.locations.length < MAX_COLLECTED_MATCHES) total.locations.push(location);
        }
      }
    }

    const scope = ledger.build();
    return requests.map((request) => {
      const tally = tallies.get(request.symbol) ?? emptyTally();
      return {
        count: tally.count,
        commentMatches: tally.commentCount,
        unclassifiedFiles,
        matches: tally.locations,
        scope,
        engine: this.name,
      };
    });
  }

  /** Every file a request should look at, sorted by relative path. */
}

export interface Enumeration {
  files: CandidateFile[];
  /** True when the walk stopped early because the budget was reached. */
  exceeded: boolean;
  bytes: number;
  /** Paths the walk declined to inspect, with the reason for each. */
  skipped: SkippedPath[];
}

export interface EnumerationBudget {
  maxFiles: number;
  maxBytes: number;
}

/**
 * Lists the files a request would search, sorted by relative path.
 *
 * With a budget, the walk abandons as soon as the tree proves bigger than the
 * budget allows. That makes it usable as a cheap probe: enumeration is stat-only
 * work, so finding out a tree is "too big" costs a bounded number of stats
 * rather than a full traversal.
 */
export async function enumerateCandidates(
  request: SearchRequest,
  budget?: EnumerationBudget,
): Promise<Enumeration> {
  const matcher = createGlobMatcher(request.options.globs);
  const excluded = createExcludeMatcher(request.options.excludeGlobs);
  const admits = (relativePath: string): boolean => matcher(relativePath) && !excluded(relativePath);
  const found = new Map<string, CandidateFile>();
  const skipped: SkippedPath[] = [];
  const note = (relativePath: string, reason: SkippedPath['reason']): void => {
    // Only gaps go in the ledger. `.git` and `node_modules` are configuration,
    // not news: they are the same on every run, they are documented, and
    // reporting them each time would bury the entries that do mean something.
    // It also keeps the two engines' ledgers identical, since ripgrep is only
    // ever asked about files it did not skip.
    if (!UNCERTAIN_REASONS.has(reason)) return;
    if (skipped.length < MAX_LEDGER_ENTRIES) skipped.push({ path: relativePath, reason });
  };
  let bytes = 0;
  let exceeded = false;

  const admit = (absolutePath: string, relativePath: string, size: number): boolean => {
    found.set(absolutePath, { absolutePath, relativePath });
    bytes += size;
    if (budget && (found.size > budget.maxFiles || bytes > budget.maxBytes)) {
      exceeded = true;
      return false;
    }
    return true;
  };

  outer: for (const target of request.targets.length > 0 ? request.targets : ['.']) {
    const absoluteTarget = path.resolve(request.root, target);
    const stats = await fs.stat(absoluteTarget).catch(() => null);
    if (!stats) continue;

    if (stats.isFile()) {
      const relativePath = toPosix(path.relative(request.root, absoluteTarget));
      if (stats.size <= MAX_FILE_SIZE && admits(relativePath)) {
        if (!admit(absoluteTarget, relativePath, stats.size)) break outer;
      }
      continue;
    }

    const prefix = toPosix(path.relative(request.root, absoluteTarget));
    const walkOptions = {
      scope: request.options.scope,
      onSkip: (relativePath: string, reason: SkippedPath['reason']): void =>
        note(prefix ? `${prefix}/${relativePath}` : relativePath, reason),
    };

    for await (const file of walkFiles(absoluteTarget, walkOptions)) {
      if (file.size > MAX_FILE_SIZE) continue;
      const relativePath = toPosix(path.relative(request.root, file.absolutePath));
      if (!admits(relativePath)) continue;
      if (!admit(file.absolutePath, relativePath, file.size)) break outer;
    }
  }

  for (const excluded of request.options.excludeFiles) found.delete(excluded);
  const files = [...found.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return { files, exceeded, bytes, skipped };
}

/** Counts matches in one file and records per-line snippets. */
export function scanContent(
  content: string,
  relativePath: string,
  regexp: RegExp,
  /**
   * Resolved lazily, and only once the file has produced a match. Classifying
   * every file in scope would mean a comment scan of the whole tree; this way
   * the cost is proportional to matches, which for an architecture assertion is
   * usually zero.
   */
  getMask?: () => CommentMask,
): Tally {
  regexp.lastIndex = 0;
  let count = 0;
  let commentCount = 0;
  const byLine = new Map<number, MatchLocation>();

  // Lazily built line index: only paid for when the file actually matches.
  let lineStarts: number[] | null = null;
  const lineOf = (index: number): { line: number; column: number } => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') lineStarts.push(i + 1);
      }
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: index - (lineStarts[low] as number) + 1 };
  };

  let match: RegExpExecArray | null;
  while ((match = regexp.exec(content)) !== null) {
    if (getMask?.().isComment(match.index)) {
      commentCount += 1;
      if (match[0].length === 0) regexp.lastIndex += 1;
      continue;
    }
    count += 1;
    const { line, column } = lineOf(match.index);
    const existing = byLine.get(line);
    if (existing) {
      existing.count += 1;
    } else if (byLine.size < MAX_COLLECTED_MATCHES) {
      const start = content.lastIndexOf('\n', match.index - 1) + 1;
      const end = content.indexOf('\n', match.index);
      byLine.set(line, {
        file: relativePath,
        line,
        column,
        text: truncate(content.slice(start, end === -1 ? content.length : end)),
        count: 1,
      });
    }
    if (match[0].length === 0) regexp.lastIndex += 1;
  }

  // No sort: exec scans forward, so lines are discovered in increasing order and
  // a Map preserves insertion order. Sorting here was dead code - mutation
  // testing found it by reporting that neither reversing nor removing the
  // comparator changed any result.
  return { count, locations: [...byLine.values()], commentCount };
}

/* ------------------------------------------------------------------ factory */

/** An engine that is guaranteed to implement the batch API. */
export type BatchEngine = Engine &
  Required<Pick<Engine, 'searchBatch'>> & {
    /** Scans a file list that the caller already enumerated. */
    searchFiles(
      files: readonly CandidateFile[],
      requests: SearchRequest[],
      unreadable?: readonly string[],
      skipped?: readonly SkippedPath[],
    ): Promise<SearchResult[]>;
  };

export const javascriptEngine: BatchEngine = new JavaScriptEngine();

/**
 * How much scanning the JavaScript engine may do before ripgrep is worth a
 * process spawn.
 *
 * Measured with scripts/bench-engines.mjs. ripgrep's cost is dominated by
 * process startup and is nearly flat in tree size; the JavaScript scanner grows
 * linearly. The crossover is therefore wherever a spawn costs, and that differs
 * by an order of magnitude between platforms:
 *
 *   Windows 11, Node 24, rg 15   spawn floor ~130ms   crossover ~575 files
 *   Linux (container), Node 22, rg 13   spawn floor ~15ms   crossover ~25 files
 *
 * The budget is set just below each crossover, so choosing JavaScript is never
 * the slower option by more than a few milliseconds, while a small tree on
 * Windows avoids a spawn that would cost ten times the whole search.
 */
export const SMALL_TREE_BUDGET: EnumerationBudget =
  process.platform === 'win32' ? { maxFiles: 512, maxBytes: 1024 * 1024 } : { maxFiles: 32, maxBytes: 64 * 1024 };

/** Spawn failures that mean "this binary is not installed", not "search failed". */
const MISSING_BINARY_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'UNKNOWN']);

/** Exported so the code list can be asserted; EACCES and friends are not
 * reproducible on demand from a real spawn. */
export function isMissingBinary(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && MISSING_BINARY_CODES.has(code);
}

/**
 * Identity tokens for exclude sets.
 *
 * The enumeration cache key has to account for `excludeFiles`, because
 * enumeration applies it - two groups over the same targets but with different
 * exclusions are different questions. Hashing the paths would be wasteful (a
 * run excludes every spec file), and the runner passes one set for the whole
 * run, so identity is both cheap and sufficient.
 */
const excludeSetIds = new WeakMap<ReadonlySet<string>, number>();
let nextExcludeSetId = 0;

function excludeSetId(excludeFiles: ReadonlySet<string>): number {
  let id = excludeSetIds.get(excludeFiles);
  if (id === undefined) {
    id = nextExcludeSetId++;
    excludeSetIds.set(excludeFiles, id);
  }
  return id;
}

function enumerationKey(request: SearchRequest): string {
  return JSON.stringify([
    request.root,
    request.targets,
    request.options.globs,
    request.options.excludeGlobs,
    excludeSetId(request.options.excludeFiles),
  ]);
}

/**
 * Picks an engine per search group instead of once per run.
 *
 * The probe is the work: it enumerates the target set under a budget, which is
 * stat-only. If the tree fits, the file list is already in hand and the
 * JavaScript scan runs against it with no spawn and no second walk. If the walk
 * abandons, the tree is big enough that ripgrep will win comfortably, and the
 * abandoned enumeration cost a bounded number of stats.
 *
 * Deciding per group rather than per run matters because one spec can assert
 * against `src/` and a single file in the same run.
 */
class AdaptiveEngine implements Engine {
  private usedRipgrep = false;
  private ripgrepMissing = false;
  private readonly ripgrep = new RipgrepEngine(process.env.SPEC_GUARD_RG || 'rg');
  private readonly enumerations = new Map<string, Promise<Enumeration>>();

  get name(): EngineName {
    return this.usedRipgrep ? 'ripgrep' : 'javascript';
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const [result] = await this.searchBatch([request]);
    return result as SearchResult;
  }

  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];

    if (!this.ripgrepMissing) {
      const key = enumerationKey(first);
      let probe = this.enumerations.get(key);
      if (!probe) {
        probe = enumerateCandidates(first, SMALL_TREE_BUDGET);
        this.enumerations.set(key, probe);
      }
      const enumeration = await probe;

      if (!enumeration.exceeded) {
        // Small tree: the walk already produced the file list, so scanning it
        // here costs less than starting a process.
        return javascriptEngine.searchFiles(enumeration.files, requests);
      }

      try {
        const results = await this.ripgrep.searchBatch(requests);
        this.usedRipgrep = true;
        return results;
      } catch (error) {
        if (!isMissingBinary(error)) throw error;
        this.ripgrepMissing = true;
      }
    }

    return javascriptEngine.searchBatch(requests);
  }
}

/** Resolves the engine to use, honouring an explicit preference. */
export async function resolveEngine(preference: EnginePreference = 'auto'): Promise<Engine> {
  if (preference === 'javascript') return javascriptEngine;
  if (preference === 'ripgrep') {
    const binary = await findRipgrep();
    if (!binary) {
      throw new Error('ripgrep (rg) was requested with --engine rg but is not available on PATH.');
    }
    return new RipgrepEngine(binary);
  }
  return new AdaptiveEngine();
}

export type CachedEngine = Engine & { fallbacks: string[] };

/**
 * Wraps an engine with a de-duplicating cache plus an automatic fallback to the
 * JS engine, so a ripgrep hiccup degrades to "slower" instead of "broken".
 */
export function createCachedEngine(engine: Engine): CachedEngine {
  const cache = new Map<string, Promise<SearchResult>>();
  const fallbacks: string[] = [];

  const keyOf = (request: SearchRequest): string =>
    JSON.stringify([
      request.root,
      request.symbol,
      request.targets,
      request.options.regex,
      request.options.word,
      request.options.ignoreCase,
      request.options.globs,
      request.options.excludeGlobs,
      [...request.options.excludeFiles].sort(),
    ]);

  const recordFallback = (error: unknown): void => {
    fallbacks.push(error instanceof Error ? error.message : String(error));
  };

  return {
    // A getter, not a snapshot: the auto engine only learns which backend it is
    // using once the first search has run.
    get name(): EngineName {
      return engine.name;
    },
    fallbacks,

    search(request: SearchRequest): Promise<SearchResult> {
      const key = keyOf(request);
      let result = cache.get(key);
      if (!result) {
        result = engine.search(request).catch(async (error: unknown) => {
          if (engine === javascriptEngine) throw error;
          recordFallback(error);
          return javascriptEngine.search(request);
        });
        cache.set(key, result);
      }
      return result;
    },

    async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
      const keys = requests.map(keyOf);
      const missing = requests.filter((_, index) => !cache.has(keys[index] as string));
      const uncached = [...new Map(missing.map((request) => [keyOf(request), request])).values()];

      if (uncached.length > 0) {
        const pending = runSearches(engine, uncached).catch(async (error: unknown) => {
          if (engine === javascriptEngine) throw error;
          recordFallback(error);
          return runSearches(javascriptEngine, uncached);
        });
        uncached.forEach((request, index) => {
          cache.set(
            keyOf(request),
            pending.then((results) => results[index] as SearchResult),
          );
        });
      }

      return Promise.all(keys.map((key) => cache.get(key) as Promise<SearchResult>));
    },
  };
}
