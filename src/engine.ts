/**
 * Search engines.
 *
 * Primary: native `ripgrep`, consumed as newline-delimited JSON. ripgrep is
 * multi-threaded, gitignore-aware and binary-skipping, which is why spec-guard
 * reaches for it before doing anything clever itself.
 *
 * Fallback: a pure-JS walker with identical assertion semantics, used when `rg`
 * is not on PATH (or when `--engine js` is passed). Nothing about spec-guard's
 * behaviour depends on ripgrep being installed - only its speed does.
 *
 * Both engines expose a batch API. Scanning a tree costs the same whether you
 * look for one symbol or twenty, so assertions that share a target set and
 * flags are answered by a single pass. Measured on a 2,000 file / 5 MB tree,
 * eight assertions cost ~280ms as eight ripgrep passes and ~90ms as one.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createCommentMask, type CommentMask } from './comments.js';
import { createExcludeMatcher, createGlobMatcher, toPosix, walkFiles } from './glob.js';
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
 * Converts ripgrep's byte column into a character column.
 *
 * ripgrep counts bytes; the scanner counts characters, and so does every editor
 * that a reader will paste the location into. On an ASCII line the two agree,
 * which is why the difference went unnoticed - it only appears once a line
 * holds a non-ASCII character before the match, and then the two engines report
 * different columns for the same match.
 */
export function byteColumnToCharacter(line: string, byteOffset: number): number {
  // One byte per character, so the offset is already a character count. This
  // also covers the case where ripgrep gave us no line text to measure.
  if (line.length === Buffer.byteLength(line)) return byteOffset + 1;
  return Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8').length + 1;
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

/**
 * True when no two of these literals can ever match overlapping text, which is
 * exactly when merging them into one ripgrep alternation is safe.
 *
 * Two ways an alternation loses a match that separate passes would find:
 *   containment - ["Primary", "PrimaryButton"] on "PrimaryButton"; and
 *   dovetailing - ["abc", "cd"] on "abcd", where the scan resumes past "cd".
 * Rejecting both leaves batching indistinguishable from separate passes.
 */
export function canBatchLiterals(patterns: readonly string[]): boolean {
  for (const a of patterns) {
    for (const b of patterns) {
      if (a === b) continue;
      if (a.includes(b) || b.includes(a)) return false;
      for (let offset = 1; offset < a.length; offset++) {
        if (b.startsWith(a.slice(offset))) return false;
      }
    }
  }
  return true;
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

interface RipgrepText {
  text?: string;
  bytes?: string;
}

function decodeText(value: RipgrepText | undefined): string {
  if (typeof value?.text === 'string') return value.text;
  // ripgrep base64-encodes paths and lines that are not valid UTF-8.
  /* c8 ignore next 2 -- needs a non-UTF-8 path on disk to reach */
  if (typeof value?.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8');
  return '';
}

/** Builds the argv for one ripgrep pass over `patterns`. */
export function buildRipgrepArgs(request: SearchRequest, patterns: readonly string[] = [request.symbol]): string[] {
  const { options } = request;
  const args = ['--json', '--no-config', '--no-messages', `--max-filesize=${MAX_FILE_SIZE}`];
  if (!options.regex) args.push('--fixed-strings');
  if (options.word) args.push('--word-regexp');
  if (options.ignoreCase) args.push('--ignore-case');
  for (const glob of options.globs) args.push('--glob', glob);
  // ripgrep reads a leading "!" as an exclusion, with gitignore semantics that
  // createExcludeMatcher mirrors for the JavaScript engine.
  for (const glob of options.excludeGlobs) args.push('--glob', `!${glob}`);
  for (const pattern of patterns) args.push('--regexp', pattern);
  args.push('--');
  args.push(...(request.targets.length > 0 ? request.targets : ['.']));
  return args;
}

/** Signals that a batched pass could not be attributed and must be re-run. */
class UnattributableBatch extends Error {}

class RipgrepEngine implements Engine {
  readonly name: EngineName = 'ripgrep';

  constructor(private readonly binary: string) {}

  async search(request: SearchRequest): Promise<SearchResult> {
    if (request.options.ignoreComments) {
      const [result] = await this.commentAware(request, [request.symbol], [request]);
      return result as SearchResult;
    }
    const tallies = await this.run(request, [request.symbol]);
    return this.toResult(tallies.get(request.symbol));
  }

  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];

    const patterns = [...new Set(requests.map((request) => request.symbol))];

    // Comment-aware counting needs the file's text, which ripgrep's match
    // stream does not carry. Rather than re-implement classification twice,
    // ripgrep is used for what it is unmatched at - telling us which handful of
    // files out of thousands contain the symbol at all - and those files are
    // then counted by the scanner, which already knows about comments. Both
    // engines therefore produce comment-aware counts through one code path.
    if (first.options.ignoreComments) {
      return this.commentAware(first, patterns, requests);
    }

    if (!shouldBatchPatterns(patterns, first.options)) {
      return Promise.all(requests.map((request) => this.search(request)));
    }

    try {
      const tallies = await this.run(first, patterns);
      return requests.map((request) => this.toResult(tallies.get(request.symbol)));
    } catch (error) {
      if (!(error instanceof UnattributableBatch)) throw error;
      return Promise.all(requests.map((request) => this.search(request)));
    }
  }

  /**
   * Two-phase search, used whenever comments must be classified.
   *
   * The result still names ripgrep: it did the searching, and classification is
   * a post-step both engines share rather than a different engine.
   */
  private async commentAware(
    request: SearchRequest,
    patterns: string[],
    requests: SearchRequest[],
  ): Promise<SearchResult[]> {
    const files = await this.filesWithMatches(request, patterns);
    const results = await javascriptEngine.searchFiles(files, requests);
    return results.map((result) => ({ ...result, engine: this.name }));
  }

  /** Phase one: which files contain any of these patterns at all. */
  private filesWithMatches(request: SearchRequest, patterns: string[]): Promise<CandidateFile[]> {
    return new Promise<CandidateFile[]>((resolve, reject) => {
      const args = buildRipgrepArgs(request, patterns).map((argument) =>
        argument === '--json' ? '--files-with-matches' : argument,
      );
      const child = spawn(this.binary, args, {
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
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const absolutePath = path.resolve(request.root, trimmed);
          if (request.options.excludeFiles.has(absolutePath)) continue;
          files.push({ absolutePath, relativePath: toPosix(path.relative(request.root, absolutePath)) });
        }
        files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
        resolve(files);
      });
    });
  }

  private toResult(tally: Tally | undefined): SearchResult {
    const resolved = tally ?? emptyTally();
    return {
      count: resolved.count,
      commentMatches: resolved.commentCount,
      unclassifiedFiles: 0,
      matches: sortLocations(resolved.locations),
      engine: this.name,
    };
  }

  /** One ripgrep pass; returns a tally per pattern. */
  private run(request: SearchRequest, patterns: string[]): Promise<Map<string, Tally>> {
    return new Promise<Map<string, Tally>>((resolve, reject) => {
      const child = spawn(this.binary, buildRipgrepArgs(request, patterns), {
        cwd: request.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const sink = createRipgrepSink(request, patterns);
      let pending = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          sink.line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.once('error', reject);
      child.once('close', (code) => {
        sink.line(pending);
        if (sink.failure) {
          reject(sink.failure);
          return;
        }
        // 0 = matches, 1 = no matches, 2 = an actual failure.
        if (code !== 0 && code !== 1) {
          reject(new Error(`ripgrep exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        resolve(sink.tallies);
      });
    });
  }
}

/**
 * Whether a set of patterns may share one ripgrep pass.
 *
 * Kept separate from the engine so the decision can be asserted directly: from
 * the outside a correct batch and a correct set of separate passes are
 * indistinguishable by design, which makes this the only place the rule is
 * observable.
 */
export function shouldBatchPatterns(patterns: readonly string[], options: SearchOptions): boolean {
  if (patterns.length <= 1) return false;
  if (options.regex || options.ignoreCase) return false;
  return canBatchLiterals(patterns);
}

export interface RipgrepSink {
  /** Feeds one line of ripgrep --json output. */
  line(text: string): void;
  readonly tallies: Map<string, Tally>;
  readonly failure: Error | null;
}

/**
 * Parses ripgrep's newline-delimited JSON into per-pattern tallies.
 *
 * This is deliberately pure and separate from the subprocess: every interesting
 * case here - a base64 path, a match with no submatches, an excluded file, an
 * unattributable match - is trivial to exercise as data and nearly impossible
 * to provoke from a real ripgrep on demand.
 */
export function createRipgrepSink(request: SearchRequest, patterns: readonly string[]): RipgrepSink {
  const single = patterns.length === 1 ? (patterns[0] as string) : null;
  const tallies = new Map<string, Tally>(patterns.map((pattern) => [pattern, emptyTally()]));
  const sink = {
    tallies,
    failure: null as Error | null,
    line(text: string): void {
      if (text.length === 0 || sink.failure) return;
      let event: { type?: string; data?: unknown };
      try {
        event = JSON.parse(text) as { type?: string; data?: unknown };
      } catch {
        return;
      }
      if (event.type !== 'match' || !event.data) return;

      const data = event.data as {
        path?: RipgrepText;
        lines?: RipgrepText;
        line_number?: number;
        submatches?: Array<{ start?: number; match?: RipgrepText }>;
      };
      const submatches = data.submatches ?? [];
      if (submatches.length === 0) return;

      // ripgrep echoes the path as given ("./src/a.ts" when the target is
      // "."); normalise so both engines report the same relative path.
      const absolute = path.resolve(request.root, decodeText(data.path));
      if (request.options.excludeFiles.has(absolute)) return;
      const file = toPosix(path.relative(request.root, absolute));
      const lineNumber = data.line_number ?? 0;
      const lineText = decodeText(data.lines);
      const text_ = truncate(lineText);

      for (const submatch of submatches) {
        // With --fixed-strings and no --ignore-case the matched text is the
        // pattern verbatim, which is what makes attribution exact.
        const pattern = single ?? decodeText(submatch.match);
        const tally = tallies.get(pattern);
        if (!tally) {
          sink.failure = new UnattributableBatch(`ripgrep reported an unexpected match: ${pattern}`);
          return;
        }
        tally.count += 1;
        const last = tally.locations.at(-1);
        if (last && last.file === file && last.line === lineNumber) {
          last.count += 1;
        } else if (tally.locations.length < MAX_COLLECTED_MATCHES) {
          tally.locations.push({
            file,
            line: lineNumber,
            column: byteColumnToCharacter(lineText, submatch.start ?? 0),
            text: text_,
            count: 1,
          });
        }
      }
    },
  };
  return sink;
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

function isProbablyBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
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

    const files = await this.collectFiles(first);
    return this.searchFiles(files, requests);
  }

  /** Scans an already-enumerated file list. */
  async searchFiles(files: readonly CandidateFile[], requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];
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
        if (!buffer || isProbablyBinary(buffer)) continue;
        const content = buffer.toString('utf8');
        let mask: CommentMask | undefined;
        const getMask = first.options.ignoreComments
          ? (): CommentMask => (mask ??= createCommentMask(content, file.relativePath))
          : undefined;

        const scanned = new Map<string, Tally>();
        for (const [pattern, regexp] of regexps) {
          scanned.set(pattern, scanContent(content, file.relativePath, regexp, getMask));
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

    return requests.map((request) => {
      const tally = tallies.get(request.symbol) ?? emptyTally();
      return {
        count: tally.count,
        commentMatches: tally.commentCount,
        unclassifiedFiles,
        matches: tally.locations,
        engine: this.name,
      };
    });
  }

  /** Every file a request should look at, sorted by relative path. */
  private async collectFiles(request: SearchRequest): Promise<CandidateFile[]> {
    return (await enumerateCandidates(request)).files;
  }
}

export interface Enumeration {
  files: CandidateFile[];
  /** True when the walk stopped early because the budget was reached. */
  exceeded: boolean;
  bytes: number;
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

    for await (const file of walkFiles(absoluteTarget)) {
      if (file.size > MAX_FILE_SIZE) continue;
      const relativePath = toPosix(path.relative(request.root, file.absolutePath));
      if (!admits(relativePath)) continue;
      if (!admit(file.absolutePath, relativePath, file.size)) break outer;
    }
  }

  for (const excluded of request.options.excludeFiles) found.delete(excluded);
  const files = [...found.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return { files, exceeded, bytes };
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
    searchFiles(files: readonly CandidateFile[], requests: SearchRequest[]): Promise<SearchResult[]>;
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
