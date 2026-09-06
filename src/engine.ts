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

import { createGlobMatcher, toPosix, walkFiles } from './glob.js';
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

function sortLocations(locations: MatchLocation[]): MatchLocation[] {
  return locations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Per-pattern accumulator used by both engines. */
interface Tally {
  count: number;
  locations: MatchLocation[];
}

function emptyTally(): Tally {
  return { count: 0, locations: [] };
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
    const tallies = await this.run(request, [request.symbol]);
    return this.toResult(tallies.get(request.symbol));
  }

  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    const [first] = requests;
    if (!first) return [];

    const patterns = [...new Set(requests.map((request) => request.symbol))];
    const batchable =
      patterns.length > 1 && !first.options.regex && !first.options.ignoreCase && canBatchLiterals(patterns);

    if (!batchable) {
      return Promise.all(requests.map((request) => this.search(request)));
    }

    try {
      const tallies = await this.run(first, patterns);
      return requests.map((request) => this.toResult(tallies.get(request.symbol)));
      /* c8 ignore next 4 */
    } catch (error) {
      if (!(error instanceof UnattributableBatch)) throw error;
      return Promise.all(requests.map((request) => this.search(request)));
    }
  }

  private toResult(tally: Tally | undefined): SearchResult {
    const resolved = tally ?? emptyTally();
    return { count: resolved.count, matches: sortLocations(resolved.locations), engine: this.name };
  }

  /** One ripgrep pass; returns a tally per pattern. */
  private run(request: SearchRequest, patterns: string[]): Promise<Map<string, Tally>> {
    return new Promise<Map<string, Tally>>((resolve, reject) => {
      const child = spawn(this.binary, buildRipgrepArgs(request, patterns), {
        cwd: request.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const single = patterns.length === 1 ? (patterns[0] as string) : null;
      const tallies = new Map<string, Tally>(patterns.map((pattern) => [pattern, emptyTally()]));
      let pending = '';
      let stderr = '';
      let failure: Error | null = null;

      const handleEvent = (line: string): void => {
        if (line.length === 0 || failure) return;
        let event: { type?: string; data?: unknown };
        try {
          event = JSON.parse(line) as { type?: string; data?: unknown };
        } catch {
          /* c8 ignore next -- ripgrep only ever emits valid JSON lines */
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
        const text = truncate(decodeText(data.lines));

        for (const submatch of submatches) {
          // With --fixed-strings and no --ignore-case the matched text is the
          // pattern verbatim, which is what makes attribution exact.
          const pattern = single ?? decodeText(submatch.match);
          const tally = tallies.get(pattern);
          /* c8 ignore next 4 -- belt and braces: --fixed-strings guarantees a hit */
          if (!tally) {
            failure = new UnattributableBatch(`ripgrep reported an unexpected match: ${pattern}`);
            return;
          }
          tally.count += 1;
          const last = tally.locations.at(-1);
          if (last && last.file === file && last.line === lineNumber) {
            last.count += 1;
          } else if (tally.locations.length < MAX_COLLECTED_MATCHES) {
            tally.locations.push({ file, line: lineNumber, column: (submatch.start ?? 0) + 1, text, count: 1 });
          }
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          handleEvent(pending.slice(0, newline));
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
        handleEvent(pending);
        if (failure) {
          reject(failure);
          return;
        }
        // 0 = matches, 1 = no matches, 2 = an actual failure.
        if (code !== 0 && code !== 1) {
          reject(new Error(`ripgrep exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        resolve(tallies);
      });
    });
  }
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
    const patterns = [...new Set(requests.map((request) => request.symbol))];
    const regexps = new Map(patterns.map((pattern) => [pattern, buildJsRegExp(pattern, first.options)]));
    const tallies = new Map<string, Tally>(patterns.map((pattern) => [pattern, emptyTally()]));

    const concurrency = Math.min(16, Math.max(1, files.length));
    let cursor = 0;
    const perFile = new Map<string, Map<string, Tally>>();

    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const file = files[cursor++];
        /* c8 ignore next -- cursor is bounded by files.length */
        if (!file) return;
        const buffer = await fs.readFile(file.absolutePath).catch(() => null);
        if (!buffer || isProbablyBinary(buffer)) continue;
        const content = buffer.toString('utf8');
        const scanned = new Map<string, Tally>();
        for (const [pattern, regexp] of regexps) {
          scanned.set(pattern, scanContent(content, file.relativePath, regexp));
        }
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
        for (const location of tally.locations) {
          if (total.locations.length < MAX_COLLECTED_MATCHES) total.locations.push(location);
        }
      }
    }

    return requests.map((request) => {
      const tally = tallies.get(request.symbol) ?? emptyTally();
      return { count: tally.count, matches: tally.locations, engine: this.name };
    });
  }

  /** Every file a request should look at, sorted by relative path. */
  private async collectFiles(request: SearchRequest): Promise<CandidateFile[]> {
    const matcher = createGlobMatcher(request.options.globs);
    const found = new Map<string, CandidateFile>();

    for (const target of request.targets.length > 0 ? request.targets : ['.']) {
      const absoluteTarget = path.resolve(request.root, target);
      const stats = await fs.stat(absoluteTarget).catch(() => null);
      if (!stats) continue;

      if (stats.isFile()) {
        const relativePath = toPosix(path.relative(request.root, absoluteTarget));
        if (stats.size <= MAX_FILE_SIZE && matcher(relativePath)) {
          found.set(absoluteTarget, { absolutePath: absoluteTarget, relativePath });
        }
        continue;
      }

      for await (const file of walkFiles(absoluteTarget)) {
        if (file.size > MAX_FILE_SIZE) continue;
        const relativePath = toPosix(path.relative(request.root, file.absolutePath));
        if (!matcher(relativePath)) continue;
        found.set(file.absolutePath, { absolutePath: file.absolutePath, relativePath });
      }
    }

    for (const excluded of request.options.excludeFiles) found.delete(excluded);
    return [...found.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  }
}

/** Counts matches in one file and records per-line snippets. */
export function scanContent(content: string, relativePath: string, regexp: RegExp): Tally {
  regexp.lastIndex = 0;
  let count = 0;
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

  return { count, locations: [...byLine.values()].sort((a, b) => a.line - b.line) };
}

/* ------------------------------------------------------------------ factory */

/** An engine that is guaranteed to implement the batch API. */
export type BatchEngine = Engine & Required<Pick<Engine, 'searchBatch'>>;

export const javascriptEngine: BatchEngine = new JavaScriptEngine();

/** Spawn failures that mean "this binary is not installed", not "search failed". */
const MISSING_BINARY_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'UNKNOWN']);

function isMissingBinary(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && MISSING_BINARY_CODES.has(code);
}

/**
 * Tries ripgrep on the first search and remembers the answer.
 *
 * Probing with `rg --version` up front would be simpler, but a process spawn
 * costs ~27ms on Windows - as much as a whole search - and that probe sits on
 * the critical path of every run. Discovering ripgrep's absence from the first
 * real search is free.
 */
class AutoEngine implements Engine {
  private mode: 'unknown' | 'ripgrep' | 'javascript' = 'unknown';
  private readonly ripgrep = new RipgrepEngine(process.env.SPEC_GUARD_RG || 'rg');

  get name(): EngineName {
    return this.mode === 'javascript' ? 'javascript' : 'ripgrep';
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const [result] = await this.searchBatch([request]);
    return result as SearchResult;
  }

  async searchBatch(requests: SearchRequest[]): Promise<SearchResult[]> {
    if (this.mode !== 'javascript') {
      try {
        const results = await this.ripgrep.searchBatch(requests);
        this.mode = 'ripgrep';
        return results;
      } catch (error) {
        if (!isMissingBinary(error)) throw error;
        this.mode = 'javascript';
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
  return new AutoEngine();
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
