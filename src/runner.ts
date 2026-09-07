/**
 * Directive -> Assertion -> Result.
 *
 * Resolution is strict and happens before any I/O: a directive with a bad
 * number, an unknown boolean or a path escaping the root is an error, never a
 * silently-passing assertion. A spec that lies is worse than no spec at all.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createCachedEngine,
  enumerateCandidates,
  resolveEngine,
  runSearches,
  type Engine,
  type EnginePreference,
  type SearchRequest,
} from './engine.js';
import { createExcludeMatcher, expandSpecPatterns, toPosix } from './glob.js';
import {
  ANALYSABLE_EXTENSIONS,
  createImportIndex,
  resolveSpecifier,
  type ImportIndex,
} from './imports.js';
import { parseDirectives } from './parser.js';
import type {
  Assertion,
  AssertionResult,
  Bounds,
  Directive,
  DirectiveError,
  MatchLocation,
  RunReport,
  SearchOptions,
  SearchResult,
} from './types.js';

export const DEFAULT_MAX_SNIPPETS = 5;
export const DEFAULT_CONCURRENCY = 8;

export interface RunOptions {
  /** Glob patterns / paths of the Markdown specs to execute. */
  patterns: readonly string[];
  /** Root of the codebase being asserted about. Defaults to cwd. */
  root?: string;
  /** Engine preference. `auto` uses ripgrep when available. */
  engine?: EnginePreference;
  /** Stop at the first failing assertion. */
  failFast?: boolean;
  /** Treat a target path that does not exist as a failure instead of a warning. */
  strictTargets?: boolean;
  /** Count matches inside the spec files themselves (off by default). */
  includeSpecs?: boolean;
  /** Max concurrent assertions. */
  concurrency?: number;
  /** Max snippets kept per failing assertion. */
  maxSnippets?: number;
}

export interface RunResult extends RunReport {
  /** Spec files that were executed, relative to root. */
  specFiles: string[];
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function parseBoolean(value: string | undefined, attribute: string): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`Attribute "${attribute}" must be true or false, got "${value}".`);
}

function parseCount(value: string, attribute: string): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Attribute "${attribute}" must be a non-negative integer, got "${value}".`);
  }
  return Number.parseInt(normalized, 10);
}

/**
 * Splits a list attribute on commas or whitespace.
 *
 * Both because both read naturally for different lists:
 * `target="src, lib"` and `exclude="src/config/** tests/**"`. The cost is that
 * a path containing a space cannot be expressed; that is documented, and no
 * separator choice avoids it without quoting rules this syntax does not have.
 */
function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Rejects absolute paths and any `..` escape out of the root. */
function normalizeTarget(target: string, root: string, attribute: string): string {
  if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    throw new Error(`Attribute "${attribute}" must be relative to --root, got "${target}".`);
  }
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..')) {
    throw new Error(`Attribute "${attribute}" escapes the root directory: "${target}".`);
  }
  return toPosix(relative) || '.';
}

function plural(count: number): string {
  return count === 1 ? '' : 'es';
}

function describeBounds(bounds: Bounds): string {
  const { min, max } = bounds;
  if (min !== undefined && max !== undefined) {
    return min === max ? `exactly ${min} match${plural(min)}` : `between ${min} and ${max} matches`;
  }
  if (min !== undefined) return `at least ${min} match${plural(min)}`;
  if (max !== undefined) return max === 0 ? 'no matches' : `at most ${max} match${plural(max)}`;
  /* c8 ignore next */
  return 'any number of matches';
}

/** Prose form used in the assertion description ("must appear at most 3 times"). */
function describeExpectation(bounds: Bounds): string {
  const { min, max } = bounds;
  const times = (value: number): string => `${value} time${value === 1 ? '' : 's'}`;
  if (min !== undefined && max !== undefined) {
    return min === max ? `must appear exactly ${times(min)}` : `must appear between ${min} and ${max} times`;
  }
  if (min !== undefined) return `must appear at least ${times(min)}`;
  if (max === 0) return 'must not appear';
  /* c8 ignore next */
  return max === undefined ? 'may appear any number of times' : `must appear at most ${times(max)}`;
}

/** Prose for an import claim: "must not import", "must import at least 2 files". */
function describeImportExpectation(bounds: Bounds): string {
  const { min, max } = bounds;
  const files = (value: number): string => `${value} file${value === 1 ? '' : 's'}`;
  if (max === 0 && min === undefined) return 'must not import';
  if (min !== undefined && max !== undefined) {
    return min === max ? `must import from exactly ${files(min)}` : `must import from between ${min} and ${max} files`;
  }
  if (min !== undefined) return `must import from at least ${files(min)}`;
  /* c8 ignore next */
  return max === undefined ? 'may import' : `must import from at most ${files(max)}`;
}

function satisfies(count: number, bounds: Bounds): boolean {
  if (bounds.min !== undefined && count < bounds.min) return false;
  if (bounds.max !== undefined && count > bounds.max) return false;
  return true;
}

export interface ResolveContext {
  root: string;
  excludeFiles: ReadonlySet<string>;
}

/** Turns one directive into an executable assertion, or an error. */
export function resolveDirective(
  directive: Directive,
  context: ResolveContext,
): { assertion: Assertion } | { error: DirectiveError } {
  const { attributes, kind, location } = directive;
  const fail = (message: string): { error: DirectiveError } => ({
    error: { location, raw: directive.raw, message },
  });

  try {
    const reason = attributes['reason'];

    if (kind === 'assert-present') {
      const files = splitList(attributes['file']).map((file) => normalizeTarget(file, context.root, 'file'));
      if (files.length === 0) {
        return fail('@assert-present requires a file="..." attribute.');
      }
      return {
        assertion: {
          kind,
          location,
          description: `${files.join(', ')} must exist`,
          reason,
          targets: [],
          files,
          bounds: { min: files.length, max: files.length },
          missingTargets: [],
        },
      };
    }

    const isImportKind = kind === 'assert-import-absence' || kind === 'assert-import-count';
    const subject = isImportKind ? 'module' : 'symbol';
    const symbol = attributes[subject];
    if (symbol === undefined || symbol.length === 0) {
      return fail(`@${kind} requires a non-empty ${subject}="..." attribute.`);
    }

    const rawTargets = splitList(attributes['target']);
    const targets = (rawTargets.length > 0 ? rawTargets : ['.']).map((target) =>
      normalizeTarget(target, context.root, 'target'),
    );

    const bounds: Bounds = {};
    if (kind === 'assert-absence' || kind === 'assert-import-absence') {
      if (attributes['expected'] !== undefined && attributes['max'] !== undefined) {
        return fail(`@${kind} accepts either expected="..." or max="...", not both.`);
      }
      const limit = attributes['expected'] ?? attributes['max'];
      bounds.max = limit === undefined ? 0 : parseCount(limit, attributes['expected'] !== undefined ? 'expected' : 'max');
    } else {
      const expected = attributes['expected'];
      if (expected !== undefined) {
        if (attributes['min'] !== undefined || attributes['max'] !== undefined) {
          return fail(`@${kind} accepts either expected="..." or min/max, not both.`);
        }
        const value = parseCount(expected, 'expected');
        bounds.min = value;
        bounds.max = value;
      } else {
        if (attributes['min'] === undefined && attributes['max'] === undefined) {
          return fail(`@${kind} requires expected="...", min="..." or max="...".`);
        }
        if (attributes['min'] !== undefined) bounds.min = parseCount(attributes['min'], 'min');
        if (attributes['max'] !== undefined) bounds.max = parseCount(attributes['max'], 'max');
        if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) {
          return fail(`min="${bounds.min}" is greater than max="${bounds.max}".`);
        }
      }
    }

    if (isImportKind) {
      const scope = targets.join(', ');
      const excludeGlobs = splitList(attributes['exclude']);
      const except = excludeGlobs.length > 0 ? ` (excluding ${excludeGlobs.join(', ')})` : '';
      const includeTypes = (attributes['types'] ?? 'include').trim().toLowerCase() !== 'ignore';
      if (!['include', 'ignore'].includes((attributes['types'] ?? 'include').trim().toLowerCase())) {
        return fail(`Attribute "types" must be include or ignore, got "${attributes['types']}".`);
      }
      return {
        assertion: {
          kind,
          location,
          description: `${scope} ${describeImportExpectation(bounds)} "${symbol}"${except}`,
          reason,
          symbol,
          targets,
          files: [],
          bounds,
          search: {
            regex: false,
            word: false,
            ignoreCase: false,
            globs: [],
            excludeGlobs,
            excludeFiles: context.excludeFiles,
          },
          imports: { modules: splitList(symbol), includeTypes },
          missingTargets: [],
        },
      };
    }

    const search: SearchOptions = {
      regex: parseBoolean(attributes['regex'], 'regex'),
      word: parseBoolean(attributes['word'], 'word'),
      ignoreCase: parseBoolean(attributes['ignore-case'], 'ignore-case'),
      globs: splitList(attributes['glob']),
      excludeGlobs: splitList(attributes['exclude']),
      excludeFiles: context.excludeFiles,
    };

    if (search.regex) {
      try {
        new RegExp(symbol);
      } catch (error) {
        return fail(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const scope = targets.join(', ');
    const except = search.excludeGlobs.length > 0 ? ` (excluding ${search.excludeGlobs.join(', ')})` : '';
    return {
      assertion: {
        kind,
        location,
        description: `"${symbol}" ${describeExpectation(bounds)} in ${scope}${except}`,
        reason,
        symbol,
        targets,
        files: [],
        bounds,
        search,
        missingTargets: [],
      },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  return (await fs.stat(candidate).catch(() => null)) !== null;
}

export interface ExecuteOptions {
  root: string;
  engine: Engine;
  strictTargets: boolean;
  maxSnippets: number;
  /** Per-run analysis cache: parse once, query many. */
  imports: ImportIndex;
}

/**
 * An assertion that still needs a search, together with the function that turns
 * that search's result into the final report entry. Splitting execution this
 * way lets one assertion run alone or share a batched pass without duplicating
 * any of the pass/fail logic.
 */
interface PendingAssertion {
  request: SearchRequest;
  finish: (search: SearchResult) => AssertionResult;
}

/**
 * Resolves everything about an assertion that does not need a search, and
 * returns either a finished result or the search still to run.
 */
async function prepareAssertion(
  assertion: Assertion,
  options: Omit<ExecuteOptions, 'engine'>,
): Promise<AssertionResult | PendingAssertion> {
  const startedAt = performance.now();
  const warnings: string[] = [];

  const base: Omit<AssertionResult, 'ok' | 'actual' | 'message' | 'matches' | 'durationMs'> = {
    kind: assertion.kind,
    location: assertion.location,
    description: assertion.description,
    reason: assertion.reason,
    symbol: assertion.symbol,
    targets: assertion.targets,
    files: assertion.files,
    bounds: assertion.bounds,
    warnings,
  };

  if (assertion.kind === 'assert-present') {
    const missing: string[] = [];
    for (const file of assertion.files) {
      if (!(await pathExists(path.resolve(options.root, file)))) missing.push(file);
    }
    const actual = assertion.files.length - missing.length;
    return {
      ...base,
      ok: missing.length === 0,
      actual,
      message:
        missing.length === 0
          ? `all ${assertion.files.length} referenced ${assertion.files.length === 1 ? 'path exists' : 'paths exist'}`
          : `missing: ${missing.join(', ')}`,
      matches: [],
      durationMs: performance.now() - startedAt,
    };
  }

  if (assertion.imports) {
    return executeImportAssertion(assertion, options, base, warnings, startedAt);
  }

  const existingTargets: string[] = [];
  for (const target of assertion.targets) {
    if (await pathExists(path.resolve(options.root, target))) existingTargets.push(target);
    else assertion.missingTargets.push(target);
  }

  if (assertion.missingTargets.length > 0) {
    warnings.push(
      `target path${assertion.missingTargets.length === 1 ? '' : 's'} not found: ${assertion.missingTargets.join(', ')}`,
    );
  }

  if (options.strictTargets && assertion.missingTargets.length > 0) {
    return {
      ...base,
      ok: false,
      actual: 0,
      message: `target path${assertion.missingTargets.length === 1 ? ' does' : 's do'} not exist: ${assertion.missingTargets.join(', ')}`,
      matches: [],
      durationMs: performance.now() - startedAt,
    };
  }

  return {
    request: {
      root: options.root,
      symbol: assertion.symbol as string,
      targets: existingTargets,
      options: assertion.search as SearchOptions,
    },
    finish: (search: SearchResult): AssertionResult => ({
      ...base,
      ok: satisfies(search.count, assertion.bounds),
      actual: search.count,
      message: `expected ${describeBounds(assertion.bounds)}, found ${search.count}`,
      matches: search.matches.slice(0, options.maxSnippets),
      engine: search.engine,
      durationMs: performance.now() - startedAt,
    }),
  };
}

/**
 * Counts the files in scope that depend on the requested module.
 *
 * The unit is files, not references: "two files import the database" is the
 * useful statement, and it does not change when someone splits one import
 * statement into two.
 */
async function executeImportAssertion(
  assertion: Assertion,
  options: Omit<ExecuteOptions, 'engine'> & { imports: ImportIndex },
  base: Omit<AssertionResult, 'ok' | 'actual' | 'message' | 'matches' | 'durationMs'>,
  warnings: string[],
  startedAt: number,
): Promise<AssertionResult> {
  const query = assertion.imports as NonNullable<Assertion['imports']>;
  const existingTargets: string[] = [];
  for (const target of assertion.targets) {
    if (await pathExists(path.resolve(options.root, target))) existingTargets.push(target);
    else assertion.missingTargets.push(target);
  }

  if (assertion.missingTargets.length > 0) {
    warnings.push(
      `target path${assertion.missingTargets.length === 1 ? '' : 's'} not found: ${assertion.missingTargets.join(', ')}`,
    );
  }

  const enumeration = await enumerateCandidates({
    root: options.root,
    symbol: '',
    targets: existingTargets,
    options: assertion.search as SearchOptions,
  });

  const analysable = enumeration.files.filter((file) =>
    ANALYSABLE_EXTENSIONS.has(path.posix.extname(file.relativePath)),
  );
  const skipped = enumeration.files.length - analysable.length;
  if (skipped > 0) {
    warnings.push(
      `analysed ${analysable.length} of ${enumeration.files.length} files; ${skipped} are not JavaScript or TypeScript`,
    );
  }

  const matchesModule = createExcludeMatcher(query.modules);
  const matches: MatchLocation[] = [];
  const unresolved: string[] = [];

  for (const file of analysable) {
    const analysis = await options.imports.analyze(file.absolutePath, file.relativePath);

    for (const note of analysis.notes) {
      unresolved.push(`${note.file}:${note.line} ${note.detail}`);
    }

    const hit = analysis.references.find((reference) => {
      if (reference.typeOnly && !query.includeTypes) return false;
      return matchesModule(resolveSpecifier(reference.specifier, file.relativePath));
    });
    if (hit) {
      matches.push({
        file: file.relativePath,
        line: hit.line,
        column: hit.column,
        text: `${hit.kind === 'export' ? 'export' : 'import'} ${hit.specifier}`,
        count: 1,
      });
    }
  }

  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} module reference${unresolved.length === 1 ? '' : 's'} could not be resolved statically`,
      ...unresolved.slice(0, options.maxSnippets).map((entry) => `  ${entry}`),
    );
  }

  const strictFailure =
    options.strictTargets && (unresolved.length > 0 || assertion.missingTargets.length > 0);
  const ok = satisfies(matches.length, assertion.bounds) && !strictFailure;

  return {
    ...base,
    ok,
    actual: matches.length,
    message: strictFailure
      ? `expected ${describeBounds(assertion.bounds)}, found ${matches.length}, and ${unresolved.length} reference(s) could not be resolved`
      : `expected ${describeBounds(assertion.bounds)}, found ${matches.length}`,
    matches: matches.slice(0, options.maxSnippets),
    durationMs: performance.now() - startedAt,
  };
}

/** Executes a single resolved assertion. */
export async function executeAssertion(assertion: Assertion, options: ExecuteOptions): Promise<AssertionResult> {
  const prepared = await prepareAssertion(assertion, options);
  if (!('request' in prepared)) return prepared;
  return prepared.finish(await options.engine.search(prepared.request));
}

/**
 * Groups searches that can share a single pass over the tree: same targets,
 * same flags. This is where most of spec-guard's speed comes from - a spec with
 * twenty assertions over `src/` costs one ripgrep pass, not twenty.
 */
function groupKey(request: SearchRequest): string {
  const { options } = request;
  return JSON.stringify([request.targets, options.regex, options.word, options.ignoreCase, options.globs]);
}

/** Reads, parses and executes every directive found in the given spec files. */
export async function runSpecGuard(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now();
  const root = path.resolve(options.root ?? process.cwd());
  const maxSnippets = options.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
  const strictTargets = options.strictTargets ?? false;

  const specFiles = await expandSpecPatterns(options.patterns, root);
  const excludeFiles = new Set(options.includeSpecs ? [] : specFiles.map((file) => path.resolve(file)));

  const directives: Directive[] = [];
  const errors: DirectiveError[] = [];

  for (const file of specFiles) {
    const relativeFile = toPosix(path.relative(root, file)) || toPosix(file);
    const source = await fs.readFile(file, 'utf8').catch((error: unknown) => {
      errors.push({
        location: { file, relativeFile, line: 1, column: 1 },
        raw: '',
        message: `Unable to read spec file: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    });
    if (source === null) continue;
    const parsed = parseDirectives(source, { file, relativeFile });
    directives.push(...parsed.directives);
    errors.push(...parsed.errors);
  }

  const assertions: Assertion[] = [];
  for (const directive of directives) {
    const resolved = resolveDirective(directive, { root, excludeFiles });
    if ('error' in resolved) errors.push(resolved.error);
    else assertions.push(resolved.assertion);
  }

  const engine = createCachedEngine(await resolveEngine(options.engine ?? 'auto'));
  const executeOptions = { root, engine, strictTargets, maxSnippets, imports: createImportIndex() };
  const results: AssertionResult[] = new Array(assertions.length);

  if (options.failFast) {
    // Fail-fast trades throughput for an early exit, so it runs unbatched.
    for (let index = 0; index < assertions.length; index++) {
      const result = await executeAssertion(assertions[index] as Assertion, executeOptions);
      results[index] = result;
      if (!result.ok) {
        results.length = index + 1;
        break;
      }
    }
  } else {
    const prepared = await Promise.all(
      assertions.map((assertion) => prepareAssertion(assertion, executeOptions)),
    );

    const groups = new Map<string, Array<{ index: number; pending: PendingAssertion }>>();
    prepared.forEach((entry, index) => {
      if (!('request' in entry)) {
        results[index] = entry;
        return;
      }
      const key = groupKey(entry.request);
      const group = groups.get(key);
      if (group) group.push({ index, pending: entry });
      else groups.set(key, [{ index, pending: entry }]);
    });

    const batches = [...groups.values()];
    const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, batches.length || 1));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        /* c8 ignore next -- cursor is bounded by batches.length */
        if (!batch) return;
        const searches = await runSearches(
          engine,
          batch.map((entry) => entry.pending.request),
        );
        batch.forEach((entry, position) => {
          results[entry.index] = entry.pending.finish(searches[position] as SearchResult);
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  const warnings = engine.fallbacks.map(
    (message) => `ripgrep failed, fell back to the JavaScript engine (${message})`,
  );

  // Errors arrive in two waves (parse, then resolve); readers expect file order.
  errors.sort((a, b) =>
    a.location.relativeFile === b.location.relativeFile
      ? a.location.line - b.location.line
      : a.location.relativeFile < b.location.relativeFile
        ? -1
        : 1,
  );

  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0 && errors.length === 0,
    root,
    engine: warnings.length > 0 ? 'javascript' : engine.name,
    durationMs: performance.now() - startedAt,
    summary: {
      specs: specFiles.length,
      total: results.length,
      passed: results.length - failed,
      failed,
      skipped: assertions.length - results.length,
    },
    results,
    errors,
    warnings,
    specFiles: specFiles.map((file) => toPosix(path.relative(root, file)) || toPosix(file)),
  };
}
