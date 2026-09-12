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
import {
  createExcludeMatcher,
  createGlobMatcher,
  statOrNull,
  toPosix,
  walkFiles,
  type DirectoryReader,
  type WalkOptions,
} from './glob.js';
import { isBinary, LedgerBuilder, UNCERTAIN_REASONS, type SkippedPath } from './scope.js';
import { lineStarts, locate } from './text.js';
import type { EngineName, MatchLocation, SearchOptions, SearchResult } from './types.js';

/** Files larger than this are skipped by both engines, keeping them in sync. */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * One rule about file size, in one place.
 *
 * It used to be written twice and spelled differently each time - `size <=
 * MAX_FILE_SIZE` where a file was admitted and `size > MAX_FILE_SIZE` where one
 * was skipped - so the boundary was defined by two expressions that had to be
 * kept complementary by hand. ripgrep is given the same number as
 * `--max-filesize`, which is also inclusive, so all three now agree by
 * construction rather than by inspection.
 */
export function withinSizeLimit(size: number): boolean {
  return size <= MAX_FILE_SIZE;
}

/** Hard cap on collected locations; the reporter only ever shows a handful. */
export const MAX_COLLECTED_MATCHES = 500;

/** Longest line snippet echoed back to the terminal. */
const MAX_SNIPPET_LENGTH = 200;

/** Most files read at once. Enough to keep a disk busy, few enough to be polite. */
export const MAX_CONCURRENT_READS = 16;

/** How many readers to start for a file list: never more than there are files. */
export function readConcurrency(fileCount: number): number {
  return Math.min(MAX_CONCURRENT_READS, fileCount);
}

/**
 * The target list for a request that names none: the root itself.
 *
 * Shared by the walker and the ripgrep argv rather than written out at each,
 * because the two must agree on what "no target" means - ripgrep given an empty
 * path argument searches nothing at all, and a walk given one searches
 * everything.
 */
export const ROOT_TARGETS: readonly string[] = ['.'];

/** The targets a request asks for, or the root when it asks for none. */
function targetsOf(request: WalkRequest): readonly string[] {
  return request.targets.length > 0 ? request.targets : ROOT_TARGETS;
}

/**
 * Total ordering on POSIX paths, ties included.
 *
 * Three call sites used to inline `a < b ? -1 : 1`, which is correct only
 * because no caller can produce two equal paths - and therefore had no
 * behaviour to test at the tie. Stating the tie makes the function total, the
 * ordering identical, and the comparison something a test can pin down.
 */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Everything a walk of the tree depends on - which is everything except the
 * pattern, since enumeration never looks inside a file.
 *
 * A separate type because callers that only want the file list had to invent a
 * symbol to ask for one, and an invented value is a value no test can be wrong
 * about. The import assertions passed `symbol: ""`.
 */
export interface WalkRequest {
  /** Absolute root directory. All targets are resolved against it. */
  root: string;
  /** Existing target paths, relative to root, POSIX separators. */
  targets: string[];
  options: SearchOptions;
  /**
   * Ignored here. Declared optional so that a `SearchRequest` written inline -
   * which every existing caller of `enumerateCandidates` does - still satisfies
   * TypeScript's excess-property check.
   */
  symbol?: string;
}

export interface SearchRequest extends WalkRequest {
  /** Literal string or regular expression source. */
  symbol: string;
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

/**
 * Trims a line to snippet length, and takes the line terminator off it.
 *
 * The terminator is a lone CR, not a newline: the caller slices up to the
 * `\n`, so on a CRLF file the carriage return is the one byte that survives.
 * This used to strip `\r?\n$`, which cannot match anything the caller passes -
 * so every snippet from a Windows-authored file carried a CR into the report,
 * where it returns the terminal cursor to column 0 and overwrites the line.
 */
export function truncate(value: string): string {
  const trimmed = value.replace(/\r$/, '');
  return trimmed.length > MAX_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH)}…` : trimmed;
}


/**
 * Orders matches by path, then by line. ripgrep searches in parallel and emits
 * files in no fixed order, so this is what makes snippet output stable.
 */
export function sortLocations(locations: MatchLocation[]): MatchLocation[] {
  return locations.sort((a, b) => (a.file === b.file ? a.line - b.line : comparePaths(a.file, b.file)));
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


/* ------------------------------------------------------------ request keys */

/**
 * When two requests are the same question, in three nested scopes.
 *
 * Three places need this and each used to answer it separately: whether two
 * requests can share one walk, whether they can share one scan of that walk,
 * and whether one result can be served from the cache instead of searched
 * again. The lists drifted, as hand-maintained parallel lists do, and two of
 * the gaps were live defects rather than missed cache hits:
 *
 *   - the result cache ignored `ignoreComments`, so an assertion written
 *     `comments="include"` was answered with the comment-stripped count from
 *     the assertion above it, or the other way round depending on which ran
 *     first;
 *   - the grouping test ignored it too, so the same two assertions were merged
 *     into one pass and the second was scanned with the first's mask;
 *   - neither considered `scope`, which is one object per run today and would
 *     have done the same thing the day it stopped being one.
 *
 * Now each key is the one inside it plus exactly what that layer adds, so a new
 * search option is either in `walkKey` or in `passKey` and cannot be in neither.
 *
 * The keys are conservative by construction: equal keys mean the same answer,
 * while two spellings of one question merely cost a repeated search. That is
 * the safe direction, and it is why there is no canonicalisation here - sorting
 * the exclude set or memoising the result would buy cache hits and could not
 * buy correctness.
 */
function walkKey(request: WalkRequest): string {
  const { options } = request;
  return JSON.stringify([
    request.root,
    request.targets,
    options.globs,
    options.excludeGlobs,
    [...options.excludeFiles],
    [...options.scope.skippedDirectories],
  ]);
}

/**
 * One walk, plus everything that decides what counts as a match within it.
 *
 * Exported because the runner groups assertions before handing them here, and
 * it used to do so against a list of its own that was missing four of these
 * fields. Being too coarse there costs no correctness - `sharesOnePass` checks
 * again and declines - but it did cost the batching: a group of five where two
 * requests disagreed was refused as a whole and run as five separate searches,
 * rather than as the three-and-two it actually was.
 */
export function passKey(request: SearchRequest): string {
  const { options } = request;
  return JSON.stringify([walkKey(request), options.regex, options.word, options.ignoreCase, options.ignoreComments]);
}

/** One pass, plus the pattern it is looking for. */
function searchKey(request: SearchRequest): string {
  return JSON.stringify([passKey(request), request.symbol]);
}

/**
 * Requests that may share one pass: same walk, same matching semantics.
 *
 * Takes the first request rather than finding it, so there is no empty list to
 * defend against here. `runSearches` has already answered that question, and
 * answering it twice left a branch nothing could reach.
 */
function sharesOnePass(first: SearchRequest, requests: readonly SearchRequest[]): boolean {
  const key = passKey(first);
  return requests.every((request) => passKey(request) === key);
}

/** Runs requests through the batch API when the engine has one. */
export async function runSearches(engine: Engine, requests: SearchRequest[]): Promise<SearchResult[]> {
  const [first] = requests;
  if (!first) return [];
  // No special case for a single request. Handing one request to `searchBatch`
  // is what `search` does anyway in all three engines here, so the shortcut
  // saved one key comparison and cost a branch that no result could depend on.
  if (!engine.searchBatch || !sharesOnePass(first, requests)) {
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
    // No try/catch. `spawn` throws synchronously only for invalid arguments,
    // and every argument here is a literal except the binary name, which comes
    // from the environment and therefore cannot contain the NUL byte that is
    // the only thing that would make a string argument invalid. The catch was
    // unreachable, and an unreachable catch that resolves to "not installed"
    // would have turned a real failure into a silent fallback if it ever ran.
    const child = spawn(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
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
  args.push(...targetsOf(request));
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

      // Bytes, decoded once at the end, rather than a string built chunk by
      // chunk. `setEncoding('utf8')` would also have been correct, but the
      // failure it prevents is invisible when it is missing: a path containing
      // a multi-byte character that straddles a chunk boundary decodes to two
      // replacement characters, and only for files large enough and named
      // awkwardly enough to land on the seam. Holding bytes until there are no
      // more of them makes that unrepresentable rather than merely handled.
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.once('error', reject);
      child.once('close', (code) => {
        const errors = Buffer.concat(stderr).toString('utf8');
        // 0 = matches, 1 = none, anything else is a real failure.
        if (code !== 0 && code !== 1) {
          reject(new Error(ripgrepFailureMessage(code, errors)));
          return;
        }
        resolve({
          files: parseRipgrepFiles(Buffer.concat(stdout).toString('utf8'), request.root, request.options.excludeFiles),
          unreadable: parseRipgrepErrors(errors),
        });
      });
    });
  }
}

/**
 * What a run says when ripgrep exits with a code that is neither 0 nor 1.
 *
 * Separate from the spawn because it is the only part a reader ever sees, and
 * inside the promise the only way to produce one was to break a real
 * subprocess - so the exact text, including whether the trailing newline every
 * command writes ends up in the middle of the sentence, was never asserted.
 */
export function ripgrepFailureMessage(code: number | null, errors: string): string {
  return `ripgrep exited with code ${code}${errors ? `: ${errors.trim()}` : ''}`;
}

/**
 * Turns ripgrep's `--files-with-matches --null` output into candidate files.
 *
 * Split out from the spawn so that the parsing has somewhere to be tested from:
 * inside the promise it could only be reached by running a real subprocess,
 * which is why the separator handling, the exclusion filter and the ordering
 * were all covered only incidentally, by whatever a real tree happened to
 * contain.
 */
export function parseRipgrepFiles(
  stdout: string,
  root: string,
  excludeFiles: ReadonlySet<string>,
): CandidateFile[] {
  const files: CandidateFile[] = [];
  // --null separates paths with NUL, which is the only separator a file name
  // cannot contain. Splitting on newlines loses files whose names contain one.
  for (const entry of stdout.split('\0')) {
    // The list is NUL-*terminated*, so the last split is always empty.
    if (entry.length === 0) continue;
    const absolutePath = path.resolve(root, entry);
    if (excludeFiles.has(absolutePath)) continue;
    files.push({ absolutePath, relativePath: toPosix(path.relative(root, absolutePath)) });
  }
  return files.sort((a, b) => comparePaths(a.relativePath, b.relativePath));
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

    // No floor of 1: an empty file list starts no readers, and a loop that
    // never runs produces the same empty tallies as one that runs once and
    // finds nothing. The guard was defending against an outcome it shared.
    const concurrency = readConcurrency(files.length);
    let cursor = 0;
    const perFile = new Map<string, Map<string, Tally>>();
    // Per pattern, how many matches each file holds. Only files that matched
    // appear, so this is smaller than perFile, which already holds an entry for
    // every file scanned - there is no new memory shape here.
    const byFile = new Map<string, Map<string, number>>(patterns.map((pattern) => [pattern, new Map()]));
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
        if (tally.count > 0) (byFile.get(pattern) as Map<string, number>).set(file.relativePath, tally.count);
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
        fileCounts: byFile.get(request.symbol) ?? new Map<string, number>(),
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
  skipped: readonly SkippedPath[];
}

export interface EnumerationBudget {
  maxFiles: number;
  maxBytes: number;
}

/**
 * A budget that abandons the walk at the first file it finds.
 *
 * Used to answer one question - "is there anything here at all?" - without
 * walking a tree to count files nobody asked about. The answer is the same
 * whichever engine will do the searching, which is the point: an assertion that
 * covers nothing has to be recognised identically by both.
 */
export const ANY_FILE_PROBE: EnumerationBudget = { maxFiles: 0, maxBytes: 0 };

/**
 * Lists the files a request would search, sorted by relative path.
 *
 * With a budget, the walk abandons as soon as the tree proves bigger than the
 * budget allows. That makes it usable as a cheap probe: enumeration is stat-only
 * work, so finding out a tree is "too big" costs a bounded number of stats
 * rather than a full traversal.
 */
export async function enumerateCandidates(
  request: WalkRequest,
  budget?: EnumerationBudget,
  /**
   * Directory reader, forwarded to the walk. Exists for the same reason
   * `walkFiles` takes one: the interesting behaviour here is what the
   * enumeration does with a directory it *cannot* read, and there is no
   * portable way to create one - Windows has no chmod, and a permission bit set
   * by a test is a permission bit a failed test leaves behind.
   */
  readDirectory?: DirectoryReader,
): Promise<Enumeration> {
  const matcher = createGlobMatcher(request.options.globs);
  const excluded = createExcludeMatcher(request.options.excludeGlobs);
  // excludeFiles is applied here rather than after the walk so that a budgeted
  // enumeration counts only files it would really search. Filtering afterwards
  // let an excluded spec file fill a one-file probe and make a populated
  // directory look empty.
  const admits = (absolutePath: string, relativePath: string): boolean =>
    matcher(relativePath) && !excluded(relativePath) && !request.options.excludeFiles.has(absolutePath);
  const found = new Map<string, CandidateFile>();
  // A LedgerBuilder rather than an array and a cap of its own: the sample cap
  // is one rule, it is applied again downstream, and a second implementation of
  // it here was reachable only by a tree with a hundred unreadable paths in it -
  // which is to say, by nothing the suite could build.
  const ledger = new LedgerBuilder();
  const note = (relativePath: string, reason: SkippedPath['reason']): void => {
    // Only gaps go in the ledger. `.git` and `node_modules` are configuration,
    // not news: they are the same on every run, they are documented, and
    // reporting them each time would bury the entries that do mean something.
    // It also keeps the two engines' ledgers identical, since ripgrep is only
    // ever asked about files it did not skip.
    if (!UNCERTAIN_REASONS.has(reason)) return;
    ledger.add(relativePath, reason);
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

  outer: for (const target of targetsOf(request)) {
    const absoluteTarget = path.resolve(request.root, target);
    const stats = await statOrNull(absoluteTarget);
    if (!stats) continue;

    if (stats.isFile()) {
      const relativePath = toPosix(path.relative(request.root, absoluteTarget));
      if (withinSizeLimit(stats.size) && admits(absoluteTarget, relativePath)) {
        if (!admit(absoluteTarget, relativePath, stats.size)) break outer;
      }
      continue;
    }

    const prefix = toPosix(path.relative(request.root, absoluteTarget));
    const walkOptions: WalkOptions = {
      scope: request.options.scope,
      onSkip: (relativePath: string, reason: SkippedPath['reason']): void =>
        note(prefix ? `${prefix}/${relativePath}` : relativePath, reason),
      ...(readDirectory ? { readDirectory } : {}),
    };

    for await (const file of walkFiles(absoluteTarget, walkOptions)) {
      if (!withinSizeLimit(file.size)) continue;
      const relativePath = toPosix(path.relative(request.root, file.absolutePath));
      if (!admits(file.absolutePath, relativePath)) continue;
      if (!admit(file.absolutePath, relativePath, file.size)) break outer;
    }
  }

  const files = [...found.values()].sort((a, b) => comparePaths(a.relativePath, b.relativePath));
  return { files, exceeded, bytes, skipped: ledger.build().skipped };
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
  // The arithmetic itself belongs to text.ts, which every other reader of a
  // source file already shares. This function used to carry its own copy of
  // both halves, which is precisely the second chance to be off by one that
  // module exists to remove.
  let starts: number[] | null = null;
  const lineOf = (index: number): { line: number; column: number } =>
    locate((starts ??= lineStarts(content)), index);

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
 *
 * Taking the platform as an argument rather than reading it: a decision that is
 * explicitly about two platforms cannot be verified on one of them if the other
 * branch is only reachable by being that other platform. Both are now asserted
 * everywhere the suite runs.
 */
export function smallTreeBudget(platform: NodeJS.Platform): EnumerationBudget {
  return platform === 'win32' ? { maxFiles: 512, maxBytes: 1024 * 1024 } : { maxFiles: 32, maxBytes: 64 * 1024 };
}

export const SMALL_TREE_BUDGET: EnumerationBudget = smallTreeBudget(process.platform);

/**
 * Spawn failures that mean "this binary is not installed", not "search failed".
 *
 * Typed as a set of `unknown` so the lookup can be handed whatever an error
 * object carried. The alternative - narrowing with `typeof code === 'string'`
 * first - was a branch that could not change an answer, because a code that is
 * not a string is not in the set either.
 */
const MISSING_BINARY_CODES: ReadonlySet<unknown> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EINVAL',
  'UNKNOWN',
]);

/** Exported so the code list can be asserted; EACCES and friends are not
 * reproducible on demand from a real spawn. */
export function isMissingBinary(error: unknown): boolean {
  return MISSING_BINARY_CODES.has((error as { code?: unknown } | null | undefined)?.code);
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
      const key = walkKey(first);
      let probe = this.enumerations.get(key);
      if (!probe) {
        probe = enumerateCandidates(first, SMALL_TREE_BUDGET);
        this.enumerations.set(key, probe);
      }
      const enumeration = await probe;

      if (!enumeration.exceeded) {
        // Small tree: the walk already produced the file list, so scanning it
        // here costs less than starting a process.
        //
        // `enumeration.skipped` is passed on, which it was not: the walk's own
        // ledger was collected and then dropped, so a directory the walk could
        // not read went unreported on any tree small enough to take this branch
        // and was reported on any tree that was not. Two answers about the same
        // repository, decided by its size - the drift ADR-0007 exists to stop.
        return javascriptEngine.searchFiles(enumeration.files, requests, [], enumeration.skipped);
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
  // Every preference is compared, including the default. Leaving `auto` as the
  // fall-through meant its name was never read, so the default could have said
  // anything at all and every run would still have behaved identically.
  if (preference === 'javascript') return javascriptEngine;
  if (preference === 'auto') return new AdaptiveEngine();
  const binary = await findRipgrep();
  if (!binary) {
    throw new Error('ripgrep (rg) was requested with --engine rg but is not available on PATH.');
  }
  return new RipgrepEngine(binary);
}

/**
 * `searchBatch` is required rather than optional: `createCachedEngine` always
 * supplies one, and typing it as maybe-absent only meant every caller that
 * wanted it wrote a cast asserting what the factory already guaranteed.
 */
export type CachedEngine = Engine & Required<Pick<Engine, 'searchBatch'>> & { fallbacks: string[] };

/**
 * Wraps an engine with a de-duplicating cache plus an automatic fallback to the
 * JS engine, so a ripgrep hiccup degrades to "slower" instead of "broken".
 */
export function createCachedEngine(engine: Engine): CachedEngine {
  const cache = new Map<string, Promise<SearchResult>>();
  const fallbacks: string[] = [];

  const keyOf = searchKey;

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

      // No `if (uncached.length > 0)` around this: `runSearches` returns an
      // empty array without touching the engine, and a forEach over nothing
      // does nothing. The guard could not change an outcome, which is why
      // nothing could be written to hold it in place.
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

      return Promise.all(keys.map((key) => cache.get(key) as Promise<SearchResult>));
    },
  };
}
