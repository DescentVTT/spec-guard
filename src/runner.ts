/**
 * Directive -> Assertion -> Result.
 *
 * Resolution is strict and happens before any I/O: a directive with a bad
 * number, an unknown boolean or a path escaping the root is an error, never a
 * silently-passing assertion. A spec that lies is worse than no spec at all.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  comparePaths,
  createCachedEngine,
  enumerateCandidates,
  passKey,
  resolveEngine,
  runSearches,
  ANY_FILE_PROBE,
  ROOT_TARGETS,
  type Engine,
  type EnginePreference,
  type SearchRequest,
} from "./engine.js";
import { createExcludeMatcher, expandSpecPatterns, toPosix } from "./glob.js";
import {
  ANALYSABLE_EXTENSIONS,
  createImportIndex,
  resolveModule,
  type ImportIndex,
  type ModuleReference,
} from "./imports.js";
import { parseDirectives } from "./parser.js";
import {
  createScope,
  DEFAULT_SCOPE,
  EMPTY_LEDGER,
  type ScopePolicy,
} from "./scope.js";
import type {
  Assertion,
  AssertionResult,
  BaselineEntry,
  Bounds,
  Directive,
  DirectiveError,
  InactiveSpec,
  MatchLocation,
  RatchetMode,
  RunReport,
  SearchOptions,
  SearchResult,
  StaleBaselineEntry,
} from "./types.js";

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
  /**
   * Tolerate target paths that do not exist.
   *
   * Off by default, and deliberately so: a check that cannot tell "the code is
   * clean" from "the directory moved" reports success while verifying nothing.
   */
  allowMissingTargets?: boolean;
  /** Treat analysis that could not be completed as a failure. */
  strictTargets?: boolean;
  /**
   * Tolerate assertions whose scope contains no files.
   *
   * The run-level counterpart of `allow-empty` on a directive. Off by default:
   * an assertion that inspected nothing passes, and a passing assertion that
   * verified nothing is the failure mode this tool exists to prevent.
   */
  allowEmptyScope?: boolean;
  /** Count matches inside the spec files themselves (off by default). */
  includeSpecs?: boolean;
  /** Max concurrent assertions. */
  concurrency?: number;
  /** Max snippets kept per failing assertion. */
  maxSnippets?: number;
  /**
   * Skip the four directories spec-guard skips by default (`.git`, `.hg`,
   * `.svn`, `node_modules`). On by default; turn it off for a run that must
   * look at literally everything.
   */
  defaultSkips?: boolean;
  /**
   * Execute every directive, whatever lifecycle status its document declares.
   *
   * The way to ask "would this draft pass if we accepted it today", and the
   * escape hatch for a team whose `Proposed` means something else. Off by
   * default, because the point of reading the status is to honour it.
   */
  ignoreStatus?: boolean;
}

export interface RunResult extends RunReport {
  /** Spec files that were executed, relative to root. */
  specFiles: string[];
}

/**
 * Milliseconds between two `performance.now()` marks.
 *
 * Seven results carry a duration and each used to subtract inline, which is
 * seven chances to write the operands the wrong way round and report a negative
 * time - and seven copies of one subtraction that nothing could pin down,
 * because "a plausible number of milliseconds" is not an assertion.
 */
export function elapsed(from: number, to: number = performance.now()): number {
  return to - from;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function parseBoolean(value: string | undefined, attribute: string): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(
    `Attribute "${attribute}" must be true or false, got "${value}".`,
  );
}

function parseCount(value: string, attribute: string): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Attribute "${attribute}" must be a non-negative integer, got "${value}".`,
    );
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
  // Taking the items rather than splitting on the separators. Split needed a
  // `+` on the separator class, a trim and a length filter, and any two of the
  // three made the third unnecessary - so none of them could be tested. What is
  // wanted is "the runs of non-separator characters", and that is one pattern.
  return value.match(/[^,\s]+/g) ?? [];
}

/** Rejects absolute paths and any `..` escape out of the root. */
function normalizeTarget(
  target: string,
  root: string,
  attribute: string,
): string {
  // The second test is not redundant with the first: `path.isAbsolute` follows
  // the host platform, so a Windows drive path is absolute on Windows and an
  // ordinary relative name on Linux. A spec naming `C:/repo/src` has to be
  // refused on both, or the same document means two different things. It is
  // anchored, because a colon partway along a path is just a character.
  if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    throw new Error(
      `Attribute "${attribute}" must be relative to --root, got "${target}".`,
    );
  }
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..")) {
    throw new Error(
      `Attribute "${attribute}" escapes the root directory: "${target}".`,
    );
  }
  return toPosix(relative) || ".";
}

function plural(count: number): string {
  return count === 1 ? "" : "es";
}

function describeBounds(bounds: Bounds): string {
  const { min, max } = bounds;
  if (min !== undefined && max !== undefined) {
    return min === max
      ? `exactly ${min} match${plural(min)}`
      : `between ${min} and ${max} matches`;
  }
  if (min !== undefined) return `at least ${min} match${plural(min)}`;
  if (max !== undefined)
    return max === 0 ? "no matches" : `at most ${max} match${plural(max)}`;
  return "any number of matches";
}

/** Prose form used in the assertion description ("must appear at most 3 times"). */
function describeExpectation(bounds: Bounds): string {
  const { min, max } = bounds;
  const times = (value: number): string =>
    `${value} time${value === 1 ? "" : "s"}`;
  if (min !== undefined && max !== undefined) {
    return min === max
      ? `must appear exactly ${times(min)}`
      : `must appear between ${min} and ${max} times`;
  }
  if (min !== undefined) return `must appear at least ${times(min)}`;
  if (max === 0) return "must not appear";
  // No branch for "neither bound": this is only ever called from
  // `resolveDirective`, which refuses a directive that names none. Carrying a
  // fourth case here meant carrying a string no run could print.
  return `must appear at most ${times(max ?? 0)}`;
}

/** Prose for an import claim: "must not import", "must import at least 2 files". */
function describeImportExpectation(bounds: Bounds): string {
  const { min, max } = bounds;
  const files = (value: number): string =>
    `${value} file${value === 1 ? "" : "s"}`;
  if (max === 0 && min === undefined) return "must not import";
  if (min !== undefined && max !== undefined) {
    return min === max
      ? `must import from exactly ${files(min)}`
      : `must import from between ${min} and ${max} files`;
  }
  if (min !== undefined) return `must import from at least ${files(min)}`;
  // As above: `resolveDirective` never produces an unbounded import claim.
  return `must import from at most ${files(max ?? 0)}`;
}

/**
 * What a report says when an assertion covered nothing.
 *
 * The fourth silent false green, after the three ADR-0007 closed. A rule whose
 * scope holds no files passes every time, forever, and reads in the report
 * exactly like a rule that inspected a thousand files and found nothing. The
 * usual causes are a `glob` that matches no extension in the tree, an `exclude`
 * that swallowed the target, or a directory that has since been emptied.
 *
 * Deliberately no file count alongside it: under ripgrep spec-guard never
 * enumerates the tree, so "inspected 412 files" would be a number only one of
 * the two engines could produce. "Nothing at all" is the same answer in both,
 * and it is the only part that changes an outcome.
 */
const EMPTY_SCOPE_HINT = 'add allow-empty="true" if that is expected';

/**
 * The one-line explanation under a result.
 *
 * Built from parts rather than written per branch so that a run with a
 * baseline, an unreadable file and a stale entry says all three things instead
 * of whichever one the branch order happened to reach first.
 */
function describeOutcome(
  bounds: Bounds,
  actual: number,
  extras: { excluded: number; stale: readonly StaleBaselineEntry[]; gaps: number },
): string {
  const parts = [`expected ${describeBounds(bounds)}, found ${actual}`];

  if (extras.excluded > 0) {
    parts.push(
      `${extras.excluded} more ${extras.excluded === 1 ? "is" : "are"} on the baseline`,
    );
  }
  if (extras.gaps > 0) {
    parts.push(
      `${extras.gaps} file${extras.gaps === 1 ? "" : "s"} could not be inspected`,
    );
  }
  if (extras.stale.length > 0) {
    // Naming the entries matters more than counting them: the fix is to delete
    // exactly these lines from the spec, and a reader should not have to work
    // out which.
    const listed = extras.stale
      .map((entry) =>
        entry.found === 0
          ? `${entry.path} (no longer matches)`
          : `${entry.path} (declares ${entry.declared}, found ${entry.found})`,
      )
      .join(", ");
    parts.push(`the baseline is out of date and must be pruned: ${listed}`);
  }

  return parts.join("; ");
}

/**
 * Reads a `baseline="..."` attribute into entries.
 *
 * Each item is a path, optionally `path:count`; a bare path means one match.
 * The separator is a colon because a path here is always relative and
 * POSIX-shaped, so it cannot contain one - the same reasoning that lets
 * `target` split on whitespace.
 */
function parseBaseline(value: string | undefined, root: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  const seen = new Set<string>();

  for (const item of splitList(value)) {
    const separator = item.lastIndexOf(":");
    const rawPath = separator === -1 ? item : item.slice(0, separator);
    const rawCount = separator === -1 ? "1" : item.slice(separator + 1);
    const declared = parseCount(rawCount, "baseline");
    if (declared === 0) {
      throw new Error(
        `Baseline entry "${item}" declares 0 matches. Remove the entry instead; a baseline lists violations that exist.`,
      );
    }
    const normalized = normalizeTarget(rawPath, root, "baseline");
    if (seen.has(normalized)) {
      throw new Error(`Baseline lists "${normalized}" twice.`);
    }
    seen.add(normalized);
    entries.push({ path: normalized, declared });
  }

  return entries;
}

/**
 * Subtracts the declared debt from what was found.
 *
 * Two questions, and the ratchet needs both. Matches inside a baselined file
 * stop counting *up to the declared number* - so a file allowed two violations
 * that grows a third reports one, not three, and the failure points at the
 * change rather than at the history. And a file that no longer has as many as
 * it declares is a stale entry: the debt was paid and the ledger still claims
 * it, which is a spec asserting something untrue about the code.
 */
export function applyBaseline(
  entries: readonly BaselineEntry[],
  fileCounts: ReadonlyMap<string, number>,
): { excluded: number; stale: StaleBaselineEntry[]; shows: (file: string) => boolean } {
  let excluded = 0;
  const stale: StaleBaselineEntry[] = [];
  const declaredBy = new Map(entries.map((entry) => [entry.path, entry.declared]));

  for (const entry of entries) {
    const found = fileCounts.get(entry.path) ?? 0;
    excluded += Math.min(found, entry.declared);
    if (found < entry.declared) stale.push({ path: entry.path, declared: entry.declared, found });
  }

  return {
    excluded,
    stale,
    // Which files a failure should show. A file inside its allowance is not
    // what went wrong, and printing it points the reader at the history
    // instead of at the change - the first version of this did exactly that,
    // and reported a new violation by quoting a twelve-year-old one. A file
    // *over* its allowance still shows, because the excess is a real
    // violation living in it.
    shows: (file: string): boolean => (fileCounts.get(file) ?? 0) > (declaredBy.get(file) ?? 0),
  };
}

/**
 * Per-run cache for "does this scope contain anything at all".
 *
 * The same shape as the import index, and for the same reason: a document with
 * twenty assertions over `src/` asks this question twenty times and it has one
 * answer. Without the cache the probe measured about 0.9 ms per assertion,
 * which is small until a spec has two hundred of them.
 */
export function createScopeProbe(): (request: SearchRequest) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (request: SearchRequest): Promise<boolean> => {
    const key = JSON.stringify([
      request.root,
      request.targets,
      request.options.globs,
      request.options.excludeGlobs,
    ]);
    let pending = cache.get(key);
    if (!pending) {
      // The walk abandons at the first file it finds, so proving a scope is
      // populated costs a couple of directory reads rather than a traversal.
      pending = enumerateCandidates(request, ANY_FILE_PROBE).then(
        (enumeration) => enumeration.files.length > 0,
      );
      cache.set(key, pending);
    }
    return pending;
  };
}

/**
 * Whether a count is inside the bounds. An absent bound is no bound.
 *
 * Written as defaults rather than as two `!== undefined` guards. Those guards
 * could not change an answer - `count < undefined` is false for every count, so
 * the comparison already admitted everything - which meant two conditions in
 * the middle of the pass/fail decision that no test could hold in place.
 */
function satisfies(
  count: number,
  { min = 0, max = Number.POSITIVE_INFINITY }: Bounds,
): boolean {
  return count >= min && count <= max;
}

export interface ResolveContext {
  root: string;
  excludeFiles: ReadonlySet<string>;
  /** Run-level scope policy. Defaults to DEFAULT_SCOPE when unset. */
  scope?: ScopePolicy;
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
    const reason = attributes["reason"];

    if (kind === "assert-present") {
      const files = splitList(attributes["file"]).map((file) =>
        normalizeTarget(file, context.root, "file"),
      );
      if (files.length === 0) {
        return fail('@assert-present requires a file="..." attribute.');
      }
      return {
        assertion: {
          kind,
          location,
          description: `${files.join(", ")} must exist`,
          reason,
          targets: [],
          files,
          bounds: { min: files.length, max: files.length },
          missingTargets: [],
          // A file list is never empty here: resolution rejects that above.
          allowEmpty: true,
          baseline: [],
          ratchet: "two-sided",
        },
      };
    }

    const isImportKind =
      kind === "assert-import-absence" || kind === "assert-import-count";
    const subject = isImportKind ? "module" : "symbol";
    const symbol = attributes[subject];
    if (symbol === undefined || symbol.length === 0) {
      return fail(`@${kind} requires a non-empty ${subject}="..." attribute.`);
    }

    const allowEmpty = parseBoolean(attributes["allow-empty"], "allow-empty");

    // `baseline` and `ratchet` reach here only on the absence kinds: the parser
    // rejects them elsewhere, because "these known files may violate" means
    // nothing for an assertion that is not forbidding anything.
    const baseline = parseBaseline(attributes["baseline"], context.root);
    const rawRatchet = (attributes["ratchet"] ?? "two-sided").trim().toLowerCase();
    if (rawRatchet !== "two-sided" && rawRatchet !== "one-way") {
      return fail(
        `Attribute "ratchet" must be two-sided or one-way, got "${attributes["ratchet"]}".`,
      );
    }
    if (baseline.length === 0 && attributes["ratchet"] !== undefined) {
      return fail(`Attribute "ratchet" needs a baseline="..." to ratchet.`);
    }
    const ratchet: RatchetMode = rawRatchet;
    const comments = (attributes["comments"] ?? "ignore").trim().toLowerCase();
    if (comments !== "ignore" && comments !== "include") {
      return fail(
        `Attribute "comments" must be ignore or include, got "${attributes["comments"]}".`,
      );
    }

    const rawTargets = splitList(attributes["target"]);
    const targets = (rawTargets.length > 0 ? rawTargets : ROOT_TARGETS).map((target) =>
      normalizeTarget(target, context.root, "target"),
    );

    const bounds: Bounds = {};
    if (kind === "assert-absence" || kind === "assert-import-absence") {
      if (
        attributes["expected"] !== undefined &&
        attributes["max"] !== undefined
      ) {
        return fail(
          `@${kind} accepts either expected="..." or max="...", not both.`,
        );
      }
      const limit = attributes["expected"] ?? attributes["max"];
      bounds.max =
        limit === undefined
          ? 0
          : parseCount(
              limit,
              attributes["expected"] !== undefined ? "expected" : "max",
            );
    } else {
      const expected = attributes["expected"];
      if (expected !== undefined) {
        if (
          attributes["min"] !== undefined ||
          attributes["max"] !== undefined
        ) {
          return fail(
            `@${kind} accepts either expected="..." or min/max, not both.`,
          );
        }
        const value = parseCount(expected, "expected");
        bounds.min = value;
        bounds.max = value;
      } else {
        if (
          attributes["min"] === undefined &&
          attributes["max"] === undefined
        ) {
          return fail(
            `@${kind} requires expected="...", min="..." or max="...".`,
          );
        }
        if (attributes["min"] !== undefined)
          bounds.min = parseCount(attributes["min"], "min");
        if (attributes["max"] !== undefined)
          bounds.max = parseCount(attributes["max"], "max");
        // Defaults rather than presence checks, for the same reason as
        // `satisfies`: `min > undefined` is false whatever min is, so the two
        // `!== undefined` guards this used to carry could not decide anything.
        if ((bounds.min ?? 0) > (bounds.max ?? Number.POSITIVE_INFINITY)) {
          return fail(
            `min="${bounds.min}" is greater than max="${bounds.max}".`,
          );
        }
      }
    }

    if (isImportKind) {
      const scope = targets.join(", ");
      const excludeGlobs = splitList(attributes["exclude"]);
      const except =
        excludeGlobs.length > 0
          ? ` (excluding ${excludeGlobs.join(", ")})`
          : "";
      const includeTypes =
        (attributes["types"] ?? "include").trim().toLowerCase() !== "ignore";
      if (
        !["include", "ignore"].includes(
          (attributes["types"] ?? "include").trim().toLowerCase(),
        )
      ) {
        return fail(
          `Attribute "types" must be include or ignore, got "${attributes["types"]}".`,
        );
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
            // Inert here - these options only reach enumerateCandidates, never a
            // text search. It is set true because it is true: the tokenizer
            // reads imports, so a module named in a comment was never a match.
            ignoreComments: true,
            scope: context.scope ?? DEFAULT_SCOPE,
            excludeFiles: context.excludeFiles,
          },
          imports: { modules: splitList(symbol), includeTypes },
          missingTargets: [],
          allowEmpty,
          baseline,
          ratchet,
        },
      };
    }

    const search: SearchOptions = {
      regex: parseBoolean(attributes["regex"], "regex"),
      word: parseBoolean(attributes["word"], "word"),
      ignoreCase: parseBoolean(attributes["ignore-case"], "ignore-case"),
      globs: splitList(attributes["glob"]),
      excludeGlobs: splitList(attributes["exclude"]),
      ignoreComments: comments !== "include",
      scope: context.scope ?? DEFAULT_SCOPE,
      excludeFiles: context.excludeFiles,
    };

    if (search.regex) {
      try {
        new RegExp(symbol);
      } catch (error) {
        // No prefix of our own. V8's message already begins "Invalid regular
        // expression: /(/: ...", so adding one produced the phrase twice in a
        // row and pushed the pattern itself off the useful part of the line.
        return fail(error instanceof Error ? error.message : String(error));
      }
    }

    const scope = targets.join(", ");
    const except =
      search.excludeGlobs.length > 0
        ? ` (excluding ${search.excludeGlobs.join(", ")})`
        : "";
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
        allowEmpty,
        baseline,
        ratchet,
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
  allowMissingTargets: boolean;
  strictTargets: boolean;
  allowEmptyScope: boolean;
  maxSnippets: number;
  /** Per-run analysis cache: parse once, query many. */
  imports: ImportIndex;
  /** Per-run cache for "is there anything in this scope". */
  hasFiles: (request: SearchRequest) => Promise<boolean>;
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
  options: Omit<ExecuteOptions, "engine">,
): Promise<AssertionResult | PendingAssertion> {
  const startedAt = performance.now();
  const warnings: string[] = [];

  const base: Omit<
    AssertionResult,
    "ok" | "actual" | "message" | "matches" | "durationMs"
  > = {
    kind: assertion.kind,
    location: assertion.location,
    description: assertion.description,
    reason: assertion.reason,
    symbol: assertion.symbol,
    targets: assertion.targets,
    files: assertion.files,
    bounds: assertion.bounds,
    warnings,
    commentMatches: 0,
    unclassifiedFiles: 0,
    scope: EMPTY_LEDGER,
    baselinedMatches: 0,
    staleBaseline: [],
    fileMatches: [],
  };

  if (assertion.kind === "assert-present") {
    const missing: string[] = [];
    for (const file of assertion.files) {
      if (!(await pathExists(path.resolve(options.root, file))))
        missing.push(file);
    }
    const actual = assertion.files.length - missing.length;
    return {
      ...base,
      ok: missing.length === 0,
      actual,
      message:
        missing.length === 0
          ? `all ${assertion.files.length} referenced ${assertion.files.length === 1 ? "path exists" : "paths exist"}`
          : `missing: ${missing.join(", ")}`,
      matches: [],
      durationMs: elapsed(startedAt),
    };
  }

  if (assertion.imports) {
    return executeImportAssertion(
      assertion,
      options,
      base,
      warnings,
      startedAt,
    );
  }

  const existingTargets: string[] = [];
  for (const target of assertion.targets) {
    if (await pathExists(path.resolve(options.root, target)))
      existingTargets.push(target);
    else assertion.missingTargets.push(target);
  }

  if (assertion.missingTargets.length > 0) {
    warnings.push(
      `target path${assertion.missingTargets.length === 1 ? "" : "s"} not found: ${assertion.missingTargets.join(", ")}`,
    );
  }

  if (!options.allowMissingTargets && assertion.missingTargets.length > 0) {
    return {
      ...base,
      ok: false,
      actual: 0,
      message: `target path${assertion.missingTargets.length === 1 ? " does" : "s do"} not exist: ${assertion.missingTargets.join(", ")}`,
      matches: [],
      durationMs: elapsed(startedAt),
    };
  }

  const request: SearchRequest = {
    root: options.root,
    symbol: assertion.symbol as string,
    targets: existingTargets,
    options: assertion.search as SearchOptions,
  };

  if (!options.allowEmptyScope && !assertion.allowEmpty && !(await options.hasFiles(request))) {
    {
      return {
        ...base,
        ok: false,
        actual: 0,
        message: `no files were inspected, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`,
        matches: [],
        durationMs: elapsed(startedAt),
      };
    }
  }

  return {
    request,
    finish: (search: SearchResult): AssertionResult => {
      // A file that could not be read, or whose bytes are not text but did
      // contain the symbol, is a hole in the answer rather than a detail of it.
      // The count is still reported, because it is still true of everything
      // that was read; --strict is for runs where "true of what we read" is not
      // good enough.
      //
      // No filter for uncertainty here any more. The ledger only ever holds
      // gaps: the walk drops a policy skip before recording it, and the only
      // other reasons the scanner adds are "unreadable" and "binary". Filtering
      // again was a second statement of an invariant that is enforced where it
      // is created, and being a no-op, nothing could tell it from its absence.
      const gaps = search.scope.skipped;
      const strictFailure = options.strictTargets && gaps.length > 0;
      const { excluded, stale, shows } = applyBaseline(assertion.baseline, search.fileCounts);
      const staleFailure = assertion.ratchet === "two-sided" && stale.length > 0;
      const actual = search.count - excluded;
      return {
        ...base,
        ok: satisfies(actual, assertion.bounds) && !strictFailure && !staleFailure,
        actual,
        message: describeOutcome(assertion.bounds, actual, {
          excluded,
          stale: staleFailure ? stale : [],
          gaps: strictFailure ? gaps.length : 0,
        }),
        baselinedMatches: excluded,
        staleBaseline: stale,
        fileMatches: [...search.fileCounts].map(([file, count]) => ({ file, count })),
        matches: search.matches.filter((match) => shows(match.file)).slice(0, options.maxSnippets),
        // Carried as numbers, not prose, so the reporter can total them across a
        // run and JSON consumers can act on them.
        commentMatches: search.commentMatches,
        unclassifiedFiles: search.unclassifiedFiles,
        scope: search.scope,
        engine: search.engine,
        durationMs: elapsed(startedAt),
      };
    },
  };
}

/** How each kind of reference is spelled in a report snippet. */
const IMPORT_VERBS: Record<ModuleReference["kind"], string> = {
  import: "import",
  export: "export",
  require: "require",
  "dynamic-import": "import",
  use: "use",
  using: "using",
};

/**
 * Counts the files in scope that depend on the requested module.
 *
 * The unit is files, not references: "two files import the database" is the
 * useful statement, and it does not change when someone splits one import
 * statement into two.
 */
async function executeImportAssertion(
  assertion: Assertion,
  options: Omit<ExecuteOptions, "engine"> & { imports: ImportIndex },
  base: Omit<
    AssertionResult,
    "ok" | "actual" | "message" | "matches" | "durationMs"
  >,
  warnings: string[],
  startedAt: number,
): Promise<AssertionResult> {
  const query = assertion.imports as NonNullable<Assertion["imports"]>;
  const existingTargets: string[] = [];
  for (const target of assertion.targets) {
    if (await pathExists(path.resolve(options.root, target)))
      existingTargets.push(target);
    else assertion.missingTargets.push(target);
  }

  if (assertion.missingTargets.length > 0) {
    warnings.push(
      `target path${assertion.missingTargets.length === 1 ? "" : "s"} not found: ${assertion.missingTargets.join(", ")}`,
    );
  }

  // No symbol: an import assertion never runs a text search, and the walk does
  // not depend on one. This used to pass `symbol: ""`, an invented value that
  // reached nothing and that no test could therefore be wrong about.
  const enumeration = await enumerateCandidates({
    root: options.root,
    targets: existingTargets,
    options: assertion.search as SearchOptions,
  });

  const analysable = enumeration.files.filter((file) =>
    ANALYSABLE_EXTENSIONS.has(path.posix.extname(file.relativePath)),
  );

  if (analysable.length === 0 && !options.allowEmptyScope && !assertion.allowEmpty) {
    // For an import rule the bar is higher than "some file exists": a directory
    // of YAML has nothing this can read, so a dependency claim about it is a
    // claim about nothing.
    return {
      ...base,
      ok: false,
      actual: 0,
      message:
        enumeration.files.length === 0
          ? `no files were inspected, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`
          : `none of the ${enumeration.files.length} files here are in a language whose imports spec-guard can read, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`,
      matches: [],
      durationMs: elapsed(startedAt),
    };
  }

  const skipped = enumeration.files.length - analysable.length;
  if (skipped > 0) {
    warnings.push(
      `analysed ${analysable.length} of ${enumeration.files.length} files; ${skipped} ${skipped === 1 ? "is" : "are"} in a language whose imports spec-guard cannot read`,
    );
  }

  const matchesModule = createExcludeMatcher(query.modules);
  const matches: MatchLocation[] = [];
  const unresolved: string[] = [];

  for (const file of analysable) {
    const analysis = await options.imports.analyze(
      file.absolutePath,
      file.relativePath,
    );

    for (const note of analysis.notes) {
      unresolved.push(`${note.file}:${note.line} ${note.detail}`);
    }

    const hit = analysis.references.find((reference) => {
      if (reference.typeOnly && !query.includeTypes) return false;
      // Both forms are tried: the resolved one so `module="app/db/**"` works
      // everywhere, and the raw one so a Python or C# author can write the
      // dotted path they see in their own source and still be understood.
      return (
        matchesModule(resolveModule(reference.specifier, file.relativePath)) ||
        matchesModule(reference.specifier)
      );
    });
    if (hit) {
      matches.push({
        file: file.relativePath,
        line: hit.line,
        column: hit.column,
        text: `${IMPORT_VERBS[hit.kind]} ${hit.specifier}`,
        count: 1,
      });
    }
  }

  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} module reference${unresolved.length === 1 ? "" : "s"} could not be resolved statically`,
      ...unresolved.slice(0, options.maxSnippets).map((entry) => `  ${entry}`),
    );
  }

  const missingFailure =
    !options.allowMissingTargets && assertion.missingTargets.length > 0;

  // One reference per file, so the file counts are the matches themselves.
  const fileCounts = new Map(matches.map((match) => [match.file, 1]));
  const { excluded, stale, shows } = applyBaseline(assertion.baseline, fileCounts);
  const staleFailure = assertion.ratchet === "two-sided" && stale.length > 0;
  const actual = matches.length - excluded;

  const strictFailure =
    missingFailure || (options.strictTargets && unresolved.length > 0);
  const ok = satisfies(actual, assertion.bounds) && !strictFailure && !staleFailure;

  return {
    ...base,
    ok,
    actual,
    message: missingFailure
      ? `target path${assertion.missingTargets.length === 1 ? " does" : "s do"} not exist: ${assertion.missingTargets.join(", ")}`
      : describeOutcome(assertion.bounds, actual, {
          excluded,
          stale: staleFailure ? stale : [],
          gaps: 0,
        }) +
        (options.strictTargets && unresolved.length > 0
          ? `; ${unresolved.length} reference${unresolved.length === 1 ? "" : "s"} could not be resolved`
          : ""),
    baselinedMatches: excluded,
    staleBaseline: stale,
    fileMatches: [...fileCounts].map(([file, count]) => ({ file, count })),
    matches: matches.filter((match) => shows(match.file)).slice(0, options.maxSnippets),
    durationMs: elapsed(startedAt),
  };
}

/** Executes a single resolved assertion. */
export async function executeAssertion(
  assertion: Assertion,
  options: ExecuteOptions,
): Promise<AssertionResult> {
  const prepared = await prepareAssertion(assertion, options);
  if (!("request" in prepared)) return prepared;
  return prepared.finish(await options.engine.search(prepared.request));
}

/**
 * How many workers to run over the batches.
 *
 * At least one, so an empty run still terminates; never more than there are
 * batches, so a spec with three groups does not start eight workers to find
 * five of them nothing to do.
 */
export function batchConcurrency(requested: number, batches: number): number {
  return Math.max(1, Math.min(requested, batches));
}

/** Reads, parses and executes every directive found in the given spec files. */
export async function runSpecGuard(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now();
  const root = path.resolve(options.root ?? process.cwd());
  const maxSnippets = options.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
  const strictTargets = options.strictTargets ?? false;
  const allowMissingTargets = options.allowMissingTargets ?? false;
  const allowEmptyScope = options.allowEmptyScope ?? false;
  const scope = createScope(options.defaultSkips ?? true);

  const specFiles = await expandSpecPatterns(options.patterns, root);
  const excludeFiles = new Set(
    options.includeSpecs ? [] : specFiles.map((file) => path.resolve(file)),
  );

  const directives: Directive[] = [];
  /** Parsed, validated, and then not run: see ADR-0010. */
  const withheld: Directive[] = [];
  const errors: DirectiveError[] = [];
  const inactiveSpecs: InactiveSpec[] = [];

  for (const file of specFiles) {
    const relativeFile = toPosix(path.relative(root, file)) || toPosix(file);
    const source = await fs.readFile(file, "utf8").catch((error: unknown) => {
      errors.push({
        location: { file, relativeFile, line: 1, column: 1 },
        raw: "",
        message: `Unable to read spec file: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    });
    if (source === null) continue;
    const parsed = parseDirectives(source, { file, relativeFile });
    errors.push(...parsed.errors);
    const status = parsed.status;
    if (status && !status.active && !(options.ignoreStatus ?? false)) {
      withheld.push(...parsed.directives);
      // Recorded even when it held no directives. "docs/adr/0011.md is a
      // draft" is worth saying to someone wondering why their new rule has no
      // effect, and a report that only mentions the documents it happened to
      // find directives in cannot answer that.
      inactiveSpecs.push({
        file: relativeFile,
        status: status.value,
        label: status.label,
        directives: parsed.directives.length,
      });
      continue;
    }
    directives.push(...parsed.directives);
  }

  const assertions: Assertion[] = [];
  for (const directive of directives) {
    const resolved = resolveDirective(directive, { root, excludeFiles, scope });
    if ("error" in resolved) errors.push(resolved.error);
    else assertions.push(resolved.assertion);
  }

  // Not in force is not the same as not checked. A withheld directive is still
  // held to being well-formed, so a draft's typo is found on the day it is
  // written rather than on the day the ADR is accepted - which is the day
  // everyone has already agreed the rule is right and stopped looking at it.
  for (const directive of withheld) {
    const resolved = resolveDirective(directive, { root, excludeFiles, scope });
    if ("error" in resolved) errors.push(resolved.error);
  }

  const engine = createCachedEngine(
    await resolveEngine(options.engine ?? "auto"),
  );
  const executeOptions = {
    root,
    engine,
    allowMissingTargets,
    strictTargets,
    allowEmptyScope,
    maxSnippets,
    imports: createImportIndex(),
    hasFiles: createScopeProbe(),
  };
  const results: AssertionResult[] = [];

  if (options.failFast) {
    // Fail-fast trades throughput for an early exit, so it runs unbatched.
    for (let index = 0; index < assertions.length; index++) {
      const result = await executeAssertion(
        assertions[index] as Assertion,
        executeOptions,
      );
      results[index] = result;
      if (!result.ok) {
        results.length = index + 1;
        break;
      }
    }
  } else {
    const prepared = await Promise.all(
      assertions.map((assertion) =>
        prepareAssertion(assertion, executeOptions),
      ),
    );

    const groups = new Map<
      string,
      Array<{ index: number; pending: PendingAssertion }>
    >();
    prepared.forEach((entry, index) => {
      if (!("request" in entry)) {
        results[index] = entry;
        return;
      }
      // The engine's own definition of "these can share one pass", rather than
      // a second list here that had drifted four fields behind it. This is
      // where most of spec-guard's speed comes from: a spec with twenty
      // assertions over `src/` costs one ripgrep pass, not twenty.
      const key = passKey(entry.request);
      const group = groups.get(key);
      if (group) group.push({ index, pending: entry });
      else groups.set(key, [{ index, pending: entry }]);
    });

    const batches = [...groups.values()];
    const concurrency = batchConcurrency(
      options.concurrency ?? DEFAULT_CONCURRENCY,
      batches.length,
    );
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
          results[entry.index] = entry.pending.finish(
            searches[position] as SearchResult,
          );
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  const warnings = engine.fallbacks.map(
    (message) =>
      `ripgrep failed, fell back to the JavaScript engine (${message})`,
  );

  // Errors arrive in two waves (parse, then resolve); readers expect file order.
  errors.sort((a, b) =>
    a.location.relativeFile === b.location.relativeFile
      ? a.location.line - b.location.line
      : comparePaths(a.location.relativeFile, b.location.relativeFile),
  );

  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0 && errors.length === 0,
    root,
    engine: warnings.length > 0 ? "javascript" : engine.name,
    durationMs: elapsed(startedAt),
    summary: {
      specs: specFiles.length,
      total: results.length,
      passed: results.length - failed,
      failed,
      skipped: assertions.length - results.length,
      inactive: withheld.length,
    },
    results,
    errors,
    warnings,
    inactiveSpecs,
    specFiles: specFiles.map(
      (file) => toPosix(path.relative(root, file)) || toPosix(file),
    ),
  };
}
