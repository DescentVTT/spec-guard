/**
 * Directive -> Assertion -> Result.
 *
 * Resolution is strict and happens before any I/O: a directive with a bad
 * number, an unknown boolean or a path escaping the root is an error, never a
 * silently-passing assertion. A spec that lies is worse than no spec at all.
 */

import path from "node:path";

import {
  comparePaths,
  createCachedEngine,
  createJavaScriptEngine,
  enumerateCandidates,
  passKey,
  resolveEngine,
  runSearches,
  ANY_FILE_PROBE,
  ROOT_TARGETS,
  type CachedEngine,
  type Engine,
  type EnginePreference,
  type SearchRequest,
} from "./engine.js";
import {
  createExcludeMatcher,
  excludeListError,
  globPatternError,
  modulePatternError,
  pathPatternError,
  patternListError,
  toPosix,
} from "./glob.js";
import { nodeIo, type Io } from "./io.js";
import {
  buildGraph,
  cyclicComponents,
  edgeKey,
  isGraphFile,
  witness,
  type GraphScope,
} from "./graph.js";
import {
  ANALYSABLE_EXTENSIONS,
  createImportIndex,
  moduleNames,
  type ImportIndex,
  type ModuleReference,
} from "./imports.js";
import { checkLayers, type LayerInput } from "./layers.js";
import { readSpecs, specPath, type SpecSet } from "./specs.js";
import {
  createScope,
  DEFAULT_SCOPE,
  EMPTY_LEDGER,
  type ScopePolicy,
} from "./scope.js";
import {
  checkStructure,
  createTreeIndex,
  partnerTemplateIssue,
  requiredEntryIssue,
  type TreeIndex,
} from "./structure.js";
import type {
  Assertion,
  AssertionResult,
  BaselineEntry,
  Bounds,
  Directive,
  DirectiveError,
  EngineName,
  InactiveSpec,
  MatchLocation,
  RatchetMode,
  RunReport,
  SearchOptions,
  SearchResult,
  SpecStatus,
  StaleBaselineEntry,
  StructureClaim,
  StructureQuery,
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
   * Paths no assertion looks at, in the gitignore form `exclude="..."` takes,
   * added to every directive that takes `exclude`. `@assert-present` names its
   * files and takes none. Build output is the usual reason: `target`, `bin`,
   * `obj`, `dist`.
   */
  exclude?: readonly string[];
  /**
   * Execute every directive, whatever lifecycle status its document declares.
   *
   * The way to ask "would this draft pass if we accepted it today", and the
   * escape hatch for a team whose `Proposed` means something else. Off by
   * default, because the point of reading the status is to honour it.
   */
  ignoreStatus?: boolean;
  /**
   * Which resolved assertions to execute. Every one, when unset.
   *
   * For a caller that wants the rules governing a few paths rather than all of
   * them - the MCP server's `check_architecture`. An assertion that is not
   * selected is not executed and not counted; it is still resolved, so a
   * malformed directive is an error whatever is selected.
   */
  select?: (assertion: Assertion) => boolean;
  /**
   * The door every read of the run goes through: finding and reading the specs,
   * checking targets exist, walking them, scanning files, reading imports and
   * listing directories. The filesystem, when unset. ADR-0014.
   *
   * For a caller whose tree is not on disk, or not as the disk has it - one
   * that changes a file in memory to see which rule notices. ripgrep reads the
   * disk itself, in a process of its own where no door reaches, so an `io` with
   * `engine: 'ripgrep'` is refused rather than answered from the disk, and an
   * `io` with `auto` searches with the scanner.
   */
  io?: Io;
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
export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  // Taking the items rather than splitting on the separators. Split needed a
  // `+` on the separator class, a trim and a length filter, and any two of the
  // three made the third unnecessary - so none of them could be tested. What is
  // wanted is "the runs of non-separator characters", and that is one pattern.
  return value.match(/[^,\s]+/g) ?? [];
}

/**
 * What a directive is told about a list attribute holding a pattern that
 * cannot be read.
 *
 * A list attribute splits on commas, so `glob="*.{ts,tsx}"` arrives as `*.{ts`
 * and `tsx}`, and the first is refused for a brace that never closes. That
 * is true and not what went wrong, so a value with a comma inside braces is
 * told what did. It always split so: the scanner read both halves as literals
 * that matched nothing, and ripgrep refused them. ADR-0015.
 */
function patternAttributeError(attribute: string, value: string, error: string): string {
  const split = /\{[^{}]*,/.test(value);
  return `Attribute "${attribute}" has an ${error}.${split ? " A list attribute splits on commas, so a {a,b} group cannot be written in one: list each pattern instead." : ""}`;
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

/** What a count is a count of, in both numbers. */
interface Unit {
  one: string;
  many: string;
}

const MATCHES: Unit = { one: "match", many: "matches" };
const CYCLES: Unit = { one: "import cycle", many: "import cycles" };
const VIOLATING_FILES: Unit = { one: "violating file", many: "violating files" };

function describeBounds(bounds: Bounds, unit: Unit = MATCHES): string {
  const { min, max } = bounds;
  const counted = (count: number): string => `${count} ${count === 1 ? unit.one : unit.many}`;
  if (min !== undefined && max !== undefined) {
    return min === max
      ? `exactly ${counted(min)}`
      : `between ${min} and ${max} ${unit.many}`;
  }
  if (min !== undefined) return `at least ${counted(min)}`;
  if (max !== undefined)
    return max === 0 ? `no ${unit.many}` : `at most ${counted(max)}`;
  return `any number of ${unit.many}`;
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
  unit: Unit = MATCHES,
): string {
  const parts = [`expected ${describeBounds(bounds, unit)}, found ${actual}`];

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
export function createScopeProbe(io: Io = nodeIo): (request: SearchRequest) => Promise<boolean> {
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
      pending = enumerateCandidates(request, ANY_FILE_PROBE, io).then(
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
  /**
   * A project's exclusions, added to those of every directive that takes
   * `exclude`. A directive's description still names only its own: the
   * project's are named once, in the line that says which options it took.
   */
  exclude?: readonly string[];
}

/** A directive's own exclusions and the project's, once each. */
function withProjectExcludes(project: readonly string[] | undefined, own: readonly string[]): string[] {
  return [...new Set([...(project ?? []), ...own])];
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
          // A file list is never empty here: resolution rejects that above.
          allowEmpty: true,
          baseline: [],
          ratchet: "two-sided",
        },
      };
    }

    const perModule =
      kind === "assert-import-absence" || kind === "assert-import-count";
    // The two directives of ADR-0011. A cycle is a claim about the graph
    // itself and names no subject; layers name theirs in `order`.
    const graphKind = kind === "assert-import-cycle" || kind === "assert-layers";
    const isImportKind = perModule || graphKind;
    // ADR-0013: a structure rule names its subject by naming its claim, and
    // names exactly one. Two claims in one directive would count two different
    // things in one number.
    const structureKind = kind === "assert-structure";
    const claims = STRUCTURE_CLAIMS.filter((claim) => attributes[claim] !== undefined);
    if (structureKind && claims.length !== 1) {
      return fail(
        claims.length === 0
          ? '@assert-structure requires one of pattern="...", required="..." or partner="...".'
          : `@assert-structure makes one claim per directive, got ${claims.join(" and ")}.`,
      );
    }
    const subject = structureKind
      ? (claims[0] as StructureClaim)
      : kind === "assert-layers" ? "order" : perModule ? "module" : "symbol";
    const symbol = attributes[subject] ?? "";
    // A list attribute is empty when it lists nothing, whatever its length; a
    // symbol of one space is a symbol.
    if (kind !== "assert-import-cycle" && (structureKind ? splitList(symbol).length : symbol.length) === 0) {
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

    // Refused here, before any kind reads it, as the configuration and
    // --exclude refuse the same patterns: each would exclude nothing and say so
    // nowhere.
    const excludeError = excludeListError(splitList(attributes["exclude"]));
    if (excludeError !== null) return fail(patternAttributeError("exclude", attributes["exclude"] as string, excludeError));
    // A malformed glob is refused for the same reason: read as a literal, it
    // was a filter that matched nothing, and the rule over it passed. ADR-0015.
    const globError = patternListError(splitList(attributes["glob"]), globPatternError);
    if (globError !== null) return fail(patternAttributeError("glob", attributes["glob"] as string, globError));

    const rawTargets = splitList(attributes["target"]);
    const targets = (rawTargets.length > 0 ? rawTargets : ROOT_TARGETS).map((target) =>
      normalizeTarget(target, context.root, "target"),
    );

    const bounds: Bounds = {};
    if (kind === "assert-absence" || kind === "assert-import-absence" || graphKind || structureKind) {
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

    if (structureKind) {
      return resolveStructure(directive, subject as StructureClaim, splitList(symbol), {
        targets,
        bounds,
        allowEmpty,
        baseline,
        ratchet,
        scope: context.scope ?? DEFAULT_SCOPE,
        projectExcludes: context.exclude ?? [],
      });
    }

    if (isImportKind) {
      const scope = targets.join(", ");
      const ownExcludes = splitList(attributes["exclude"]);
      const except =
        ownExcludes.length > 0
          ? ` (excluding ${ownExcludes.join(", ")})`
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
      const dynamic = (attributes["dynamic"] ?? "include").trim().toLowerCase();
      if (!["include", "ignore"].includes(dynamic)) {
        return fail(`Attribute "dynamic" must be include or ignore, got "${attributes["dynamic"]}".`);
      }
      const includeDynamic = dynamic === "include";
      const layers = splitList(symbol);
      const moduleError = perModule
        ? patternListError(layers, (pattern) => modulePatternError(pattern))
        : patternListError(layers, (pattern) => modulePatternError(pattern, "layer"));
      if (moduleError !== null) return fail(patternAttributeError(subject, symbol, moduleError));
      if (kind === "assert-layers") {
        if (layers.length < 2) {
          return fail(
            `@assert-layers needs at least two layers in order="...", got ${layers.length}.`,
          );
        }
        const repeated = layers.find((layer, at) => layers.indexOf(layer) !== at);
        if (repeated !== undefined) {
          return fail(`Layer "${repeated}" is listed twice in order="...".`);
        }
      }
      const typesNote = includeTypes ? "" : " (type-only imports ignored)";
      const ignored = [...(includeTypes ? [] : ["type-only"]), ...(includeDynamic ? [] : ["dynamic"])];
      const ignoredNote = ignored.length === 0 ? "" : ` (${ignored.join(" and ")} imports ignored)`;
      const description =
        kind === "assert-import-cycle"
          ? `${scope} must have ${describeBounds(bounds, CYCLES)}${ignoredNote}${except}`
          : kind === "assert-layers"
            ? `${scope} must keep its layers in order, ${layers.join(" < ")}${bounds.max === 0 ? "" : `, with ${describeBounds(bounds, VIOLATING_FILES)}`}${typesNote}${except}`
            : `${scope} ${describeImportExpectation(bounds)} "${symbol}"${except}`;
      return {
        assertion: {
          kind,
          location,
          description,
          reason,
          // Only the per-module kinds have a subject a report can quote.
          symbol: perModule ? symbol : undefined,
          targets,
          files: [],
          bounds,
          search: {
            regex: false,
            word: false,
            ignoreCase: false,
            globs: [],
            excludeGlobs: withProjectExcludes(context.exclude, ownExcludes),
            // Inert here - these options only reach enumerateCandidates, never a
            // text search. It is set true because it is true: the tokenizer
            // reads imports, so a module named in a comment was never a match.
            ignoreComments: true,
            scope: context.scope ?? DEFAULT_SCOPE,
            excludeFiles: context.excludeFiles,
          },
          imports: { modules: perModule ? splitList(symbol) : [], includeTypes, includeDynamic },
          ...(kind === "assert-layers" ? { layers } : {}),
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
      excludeGlobs: withProjectExcludes(context.exclude, splitList(attributes["exclude"])),
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
    const ownExcludes = splitList(attributes["exclude"]);
    const except =
      ownExcludes.length > 0
        ? ` (excluding ${ownExcludes.join(", ")})`
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
        allowEmpty,
        baseline,
        ratchet,
      },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const STRUCTURE_CLAIMS: readonly StructureClaim[] = ["pattern", "required", "partner"];

/** What each structure claim counts. */
const STRUCTURE_UNITS: Record<StructureClaim, Unit> = {
  pattern: { one: "misnamed file", many: "misnamed files" },
  required: { one: "directory missing an entry", many: "directories missing an entry" },
  partner: { one: "file without a partner", many: "files without a partner" },
};

/**
 * The rest of an `@assert-structure` directive, once what every rule shares is
 * read. Throws for a directive that cannot mean what it says, which
 * `resolveDirective` reports as the directive's error.
 */
function resolveStructure(
  directive: Directive,
  claim: StructureClaim,
  values: string[],
  shared: Pick<Assertion, "targets" | "bounds" | "allowEmpty" | "baseline" | "ratchet"> & {
    scope: ScopePolicy;
    projectExcludes: readonly string[];
  },
): { assertion: Assertion } {
  const { attributes } = directive;
  const required = claim === "required";
  const globs = splitList(attributes["glob"]);
  const excludeGlobs = splitList(attributes["exclude"]);
  const searchedExcludes = withProjectExcludes(shared.projectExcludes, excludeGlobs);

  // Two attributes that would otherwise be read and ignored, which is a rule
  // saying something it does not check.
  if (attributes["dirs"] !== undefined && !required) {
    throw new Error(`Attribute "dirs" chooses the directories of required="...", and this directive claims ${claim}="...".`);
  }
  if (required && globs.length > 0) {
    throw new Error(`Attribute "glob" chooses files, and required="..." is about directories; dirs="..." chooses those.`);
  }
  const dirs = attributes["dirs"]?.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (dirs === "") throw new Error(`Attribute "dirs" must not be empty.`);
  const dirsError = dirs === undefined ? null : pathPatternError(dirs);
  if (dirsError !== null) throw new Error(`Attribute "dirs" has an ${dirsError}.`);
  const namesError = claim === "pattern" ? patternListError(values, globPatternError) : null;
  if (namesError !== null) throw new Error(patternAttributeError("pattern", attributes["pattern"] as string, namesError));

  const issue = values
    .map((value) => (required ? requiredEntryIssue(value) : claim === "partner" ? partnerTemplateIssue(value) : null))
    .find((found) => found !== null);
  if (issue) throw new Error(issue);

  const scope = shared.targets.join(", ");
  const matching = globs.length > 0 ? ` matching ${globs.join(", ")}` : "";
  const claimed =
    claim === "pattern"
      ? `files in ${scope}${matching} must be named ${values.join(" or ")}`
      : claim === "partner"
        ? `files in ${scope}${matching} must each have a partner ${values.join(" or ")}`
        : dirs === undefined
          ? `${scope} must contain ${values.join(", ")}`
          : `directories matching ${dirs} under ${scope} must contain ${values.join(", ")}`;
  const allowance = shared.bounds.max === 0 ? "" : `, with ${describeBounds(shared.bounds, STRUCTURE_UNITS[claim])}`;
  const except = excludeGlobs.length > 0 ? ` (excluding ${excludeGlobs.join(", ")})` : "";

  return {
    assertion: {
      kind: directive.kind,
      location: directive.location,
      description: `${claimed}${allowance}${except}`,
      reason: attributes["reason"],
      targets: shared.targets,
      files: [],
      bounds: shared.bounds,
      search: {
        regex: false,
        word: false,
        ignoreCase: false,
        globs,
        excludeGlobs: searchedExcludes,
        // Nothing is read, so there is no comment to leave out.
        ignoreComments: false,
        scope: shared.scope,
        // The spec files are in scope. Every other rule leaves them out so a
        // text rule does not find its own directive, and a structure rule reads
        // no text - while a rule about what the ADRs are called is about them.
        excludeFiles: new Set(),
      },
      structure: dirs === undefined ? { claim, values } : { claim, values, dirs },
      allowEmpty: shared.allowEmpty,
      baseline: shared.baseline,
      ratchet: shared.ratchet,
    },
  };
}

/**
 * The spec files a search must not count, as absolute paths.
 *
 * A spec names the symbol it forbids, so without this every absence rule would
 * find itself. Empty under `--include-specs`.
 */
export function specExclusions(specFiles: readonly string[], includeSpecs: boolean): ReadonlySet<string> {
  return new Set(includeSpecs ? undefined : specFiles.map((file) => path.resolve(file)));
}

async function pathExists(io: Io, candidate: string): Promise<boolean> {
  return (await io.stat(candidate)) !== null;
}

/**
 * The targets that exist and the ones that do not, in the order written.
 *
 * Returned rather than recorded on the assertion, which is what execution used
 * to do: the second execution of a rule then named each missing target twice.
 * A watch session executes its rules again and again (ADR-0014).
 */
async function partitionTargets(
  targets: readonly string[],
  options: { root: string; io: Io },
): Promise<{ existing: string[]; missing: string[] }> {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    (await pathExists(options.io, path.resolve(options.root, target)) ? existing : missing).push(target);
  }
  return { existing, missing };
}

export interface ExecuteOptions {
  root: string;
  /** The door every read of the codebase goes through. ADR-0014. */
  io: Io;
  engine: Engine;
  allowMissingTargets: boolean;
  strictTargets: boolean;
  allowEmptyScope: boolean;
  maxSnippets: number;
  /** Per-run analysis cache: parse once, query many. */
  imports: ImportIndex;
  /** Per-run cache for "is there anything in this scope". */
  hasFiles: (request: SearchRequest) => Promise<boolean>;
  /** Per-run directory listings and walks, for the structure rules. */
  tree: TreeIndex;
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
    claim: assertion.structure?.claim,
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
      if (!(await pathExists(options.io, path.resolve(options.root, file))))
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

  if (assertion.structure) {
    return executeStructureAssertion(assertion, assertion.structure, options, base, warnings, startedAt);
  }

  const { existing: existingTargets, missing } = await partitionTargets(assertion.targets, options);
  const notFound = missingTargets(missing);
  if (missing.length > 0) warnings.push(notFound.warning);

  if (!options.allowMissingTargets && missing.length > 0) {
    return {
      ...base,
      ok: false,
      actual: 0,
      message: notFound.failure,
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

  // Every target missing, and that tolerated, leaves nothing to search - and
  // must not be handed to the engine as an empty target list, which the engine
  // reads, by contract, as the root. It used to be: a rule on a deleted
  // `src/auth` searched the whole repository, where `min="1"` could pass on a
  // test file. Found by holding `spec-guard query` to the walk; see ADR-0012.
  const nothingLeft = existingTargets.length === 0;

  if (!options.allowEmptyScope && !assertion.allowEmpty && (nothingLeft || !(await options.hasFiles(request)))) {
    return {
      ...base,
      ok: false,
      actual: 0,
      message: `no files were inspected, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`,
      matches: [],
      durationMs: elapsed(startedAt),
    };
  }

  const finish = (search: Unsearched | SearchResult): AssertionResult => {
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
  };

  return nothingLeft ? finish(NOTHING_SEARCHED) : { request, finish };
}

/**
 * What a report says about targets that are not there: a warning always, and a
 * failure unless `--allow-missing-targets` tolerates it. One place for the
 * words, since every kind of rule that has a target says them.
 */
function missingTargets(missing: readonly string[]): { warning: string; failure: string } {
  const one = missing.length === 1;
  return {
    warning: `target path${one ? "" : "s"} not found: ${missing.join(", ")}`,
    failure: `target path${one ? " does" : "s do"} not exist: ${missing.join(", ")}`,
  };
}

/**
 * Holds a structure rule to the tree, by name. ADR-0013.
 *
 * Four things fail before any count is read, because each is a rule that would
 * otherwise pass without checking what it says: a missing target, a `required`
 * target that is a file, a partner template that names the file itself, and a
 * scope holding nothing.
 */
async function executeStructureAssertion(
  assertion: Assertion,
  query: StructureQuery,
  options: Omit<ExecuteOptions, "engine">,
  base: ImportBase,
  warnings: string[],
  startedAt: number,
): Promise<AssertionResult> {
  const search = assertion.search as SearchOptions;
  const check = await checkStructure(
    query,
    {
      targets: assertion.targets,
      globs: search.globs,
      excludeGlobs: search.excludeGlobs,
      scope: search.scope,
    },
    options.tree,
  );

  const notFound = missingTargets(check.missing);
  if (check.missing.length > 0) warnings.push(notFound.warning);

  const files = check.notDirectories;
  const self = check.selfPartner;
  const failure =
    !options.allowMissingTargets && check.missing.length > 0
      ? notFound.failure
      : files.length > 0
        ? `required="..." is about directories, and ${files.length === 1 ? "this target is a file" : "these targets are files"}: ${files.join(", ")}`
        : self !== undefined
          ? `partner template ${self.template} names ${self.file} itself, so every file would be its own partner`
          : check.inspected === 0 && !options.allowEmptyScope && !assertion.allowEmpty
            ? `no ${query.claim === "required" ? "directories were selected" : "files were inspected"}, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`
            : null;

  const fileCounts = new Map(check.violations.map((violation) => [violation.path, 1]));
  const { excluded, stale, shows } = applyBaseline(assertion.baseline, fileCounts);
  const staleFailure = assertion.ratchet === "two-sided" && stale.length > 0;
  const gaps = check.scope.skipped.length;
  const strictFailure = options.strictTargets && gaps > 0;
  const actual = check.violations.length - excluded;

  return {
    ...base,
    ok: failure === null && satisfies(actual, assertion.bounds) && !staleFailure && !strictFailure,
    actual,
    message:
      failure ??
      describeOutcome(
        assertion.bounds,
        actual,
        { excluded, stale: staleFailure ? stale : [], gaps: strictFailure ? gaps : 0 },
        STRUCTURE_UNITS[query.claim],
      ),
    baselinedMatches: excluded,
    staleBaseline: stale,
    fileMatches: [...fileCounts].map(([file, count]) => ({ file, count })),
    // No line and no column: what is wrong is the path itself.
    matches: check.violations
      .filter((violation) => shows(violation.path))
      .slice(0, options.maxSnippets)
      .map((violation) => ({ file: violation.path, line: 0, column: 0, text: violation.text, count: 1 })),
    scope: check.scope,
    durationMs: elapsed(startedAt),
  };
}

/** The result of a search that had no files to look at, and so ran no engine. */
type Unsearched = Omit<SearchResult, "engine"> & { engine?: undefined };

const NOTHING_SEARCHED: Unsearched = {
  count: 0,
  commentMatches: 0,
  unclassifiedFiles: 0,
  matches: [],
  fileCounts: new Map(),
  scope: EMPTY_LEDGER,
};

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
  const { existing: existingTargets, missing: absent } = await partitionTargets(assertion.targets, options);
  const notFound = missingTargets(absent);
  if (absent.length > 0) warnings.push(notFound.warning);

  // No symbol: an import assertion never runs a text search, and the walk does
  // not depend on one. This used to pass `symbol: ""`, an invented value that
  // reached nothing and that no test could therefore be wrong about.
  //
  // And no walk at all when every target is missing: an empty target list is
  // the root to the engine, as the text rules above found out.
  const enumeration =
    existingTargets.length === 0
      ? { files: [] }
      : await enumerateCandidates(
          {
            root: options.root,
            targets: existingTargets,
            options: assertion.search as SearchOptions,
          },
          undefined,
          options.io,
        );

  // Why a missing target fails the assertion, or null when it does not. Decided
  // before scope, so a rule whose only target is gone says so rather than that
  // its scope is empty - which is true, and not the thing to fix.
  const missing =
    !options.allowMissingTargets && absent.length > 0
      ? notFound.failure
      : null;

  // A cycle needs files the resolver can name, which today means JavaScript
  // and TypeScript; every other import rule reads any language spec-guard
  // tokenizes. ADR-0011 has the reasons, language by language.
  const cycles = assertion.kind === "assert-import-cycle";
  const analysable = enumeration.files.filter((file) =>
    cycles
      ? isGraphFile(file.relativePath)
      : ANALYSABLE_EXTENSIONS.has(path.posix.extname(file.relativePath)),
  );

  if (analysable.length === 0 && missing === null && !options.allowEmptyScope && !assertion.allowEmpty) {
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
          : cycles
            ? `none of the ${enumeration.files.length} files here are JavaScript or TypeScript, so there is no import graph to check and this assertion verified nothing (${EMPTY_SCOPE_HINT})`
            : `none of the ${enumeration.files.length} files here are in a language whose imports spec-guard can read, so this assertion verified nothing (${EMPTY_SCOPE_HINT})`,
      matches: [],
      durationMs: elapsed(startedAt),
    };
  }

  const skipped = enumeration.files.length - analysable.length;
  if (skipped > 0) {
    // Which kinds, because "2 files" in a .NET project is a project file and a
    // Razor page, and only one of them can hold an `@using` nothing here reads.
    const inAnalysis = new Set(analysable);
    const kinds = new Set(
      enumeration.files.flatMap((file) =>
        inAnalysis.has(file) ? [] : [path.posix.extname(file.relativePath) || path.posix.basename(file.relativePath)],
      ),
    );
    warnings.push(
      cycles
        ? `placed ${analysable.length} of ${enumeration.files.length} files in the import graph; ${skipped} ${skipped === 1 ? "is" : "are"} not JavaScript or TypeScript`
        : `analysed ${analysable.length} of ${enumeration.files.length} files; ${skipped} ${skipped === 1 ? "is" : "are"} in a language whose imports spec-guard cannot read (${[...kinds].sort().join(", ")})`,
    );
  }

  const analysed: LayerInput[] = [];
  const unresolved: string[] = [];

  for (const file of analysable) {
    const analysis = await options.imports.analyze(
      file.absolutePath,
      file.relativePath,
    );
    for (const note of analysis.notes) {
      unresolved.push(`${note.file}:${note.line} ${note.detail}`);
    }
    analysed.push({ file: file.relativePath, references: analysis.references, namespaces: analysis.namespaces });
  }

  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} module reference${unresolved.length === 1 ? "" : "s"} could not be resolved statically`,
      ...unresolved.slice(0, options.maxSnippets).map((entry) => `  ${entry}`),
    );
  }

  const read: ImportRead = {
    analysed,
    walked: enumeration.files.map((file) => file.relativePath),
    targets: existingTargets,
    unresolved: unresolved.length,
    missing,
  };

  if (cycles) return finishCycles(assertion, options, base, warnings, startedAt, read);
  if (assertion.layers) {
    return finishLayers(assertion, assertion.layers, options, base, warnings, startedAt, read);
  }

  const matchesModule = createExcludeMatcher(query.modules);
  const matches: MatchLocation[] = [];

  for (const { file, references } of analysed) {
    const hit = references.find((reference) => {
      if (reference.typeOnly && !query.includeTypes) return false;
      // Every name the reference has: the resolved one so `module="app/db/**"`
      // works everywhere, the raw one so a Python or C# author can write the
      // dotted path they see in their own source, and the modules a dotted one
      // sits under, so `module="App.Db"` covers `App.Db.Client` as `App/Db` does.
      return moduleNames(reference.specifier, file, reference.namespace).some(matchesModule);
    });
    if (hit) {
      matches.push({
        file,
        line: hit.line,
        column: hit.column,
        text: `${IMPORT_VERBS[hit.kind]} ${hit.specifier}`,
        count: 1,
      });
    }
  }

  // One reference per file, so the file counts are the matches themselves.
  const fileCounts = new Map(matches.map((match) => [match.file, 1]));
  const { excluded, stale, shows } = applyBaseline(assertion.baseline, fileCounts);
  const staleFailure = assertion.ratchet === "two-sided" && stale.length > 0;
  const actual = matches.length - excluded;

  const strictFailure =
    read.missing !== null || (options.strictTargets && unresolved.length > 0);
  const ok = satisfies(actual, assertion.bounds) && !strictFailure && !staleFailure;

  return {
    ...base,
    ok,
    actual,
    message:
      read.missing ??
      describeOutcome(assertion.bounds, actual, {
        excluded,
        stale: staleFailure ? stale : [],
        gaps: 0,
      }) + strictSuffix(options, unresolved.length),
    baselinedMatches: excluded,
    staleBaseline: stale,
    fileMatches: [...fileCounts].map(([file, count]) => ({ file, count })),
    matches: matches.filter((match) => shows(match.file)).slice(0, options.maxSnippets),
    durationMs: elapsed(startedAt),
  };
}

/** Everything an import rule reads before it decides anything. */
interface ImportRead {
  /** Each file in the analysis, with the references it makes. */
  analysed: LayerInput[];
  /** Every file the walk produced, analysable or not. */
  walked: string[];
  /** The targets that exist. */
  targets: string[];
  /** References the tokenizer could not resolve statically. */
  unresolved: number;
  /** Why a missing target fails the assertion, or null when it does not. */
  missing: string | null;
}

type ImportBase = Omit<
  AssertionResult,
  "ok" | "actual" | "message" | "matches" | "durationMs"
>;

/** What `--strict` adds to a message when references went unresolved. */
function strictSuffix(options: { strictTargets: boolean }, unresolved: number): string {
  return options.strictTargets && unresolved > 0
    ? `; ${unresolved} reference${unresolved === 1 ? "" : "s"} could not be resolved`
    : "";
}

/**
 * Counts the import cycles in scope - components, not simple cycles.
 *
 * Each is shown as one concrete loop with the line of every import on it, at
 * the location of the first. The count does not move when someone adds a
 * second route around a loop that already exists, which is what makes it a
 * number a spec can hold. See ADR-0011.
 */
function finishCycles(
  assertion: Assertion,
  options: Omit<ExecuteOptions, "engine">,
  base: ImportBase,
  warnings: string[],
  startedAt: number,
  read: ImportRead,
): AssertionResult {
  const query = assertion.imports as NonNullable<Assertion["imports"]>;
  const scope: GraphScope = {
    nodes: new Set(read.analysed.map((entry) => entry.file)),
    walked: new Set(read.walked),
    excluded: createExcludeMatcher((assertion.search as SearchOptions).excludeGlobs),
    covers: (relativePath) =>
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      read.targets.some(
        (target) =>
          target === "." || relativePath === target || relativePath.startsWith(`${target}/`),
      ),
  };

  const graph = buildGraph(read.analysed, scope, query.includeTypes, query.includeDynamic);
  const loops = cyclicComponents(graph).map((component) => witness(component, graph.successors));

  if (graph.unresolved.length > 0) {
    const count = graph.unresolved.length;
    warnings.push(
      `${count} import${count === 1 ? "" : "s"} could not be resolved to a file, so ${count === 1 ? "its edge is" : "their edges are"} missing from the graph`,
      ...graph.unresolved
        .slice(0, options.maxSnippets)
        .map(({ file, reference }) => `  ${file}:${reference.line} ${reference.specifier}`),
    );
  }

  const gaps = read.unresolved + graph.unresolved.length;
  const actual = loops.length;
  const ok =
    satisfies(actual, assertion.bounds) &&
    read.missing === null &&
    !(options.strictTargets && gaps > 0);

  const matches = loops.map((loop): MatchLocation => {
    const hop = (at: number): ModuleReference =>
      graph.via.get(edgeKey(loop[at] as string, loop[at + 1] as string)) as ModuleReference;
    return {
      file: loop[0] as string,
      line: hop(0).line,
      column: hop(0).column,
      // Every file on the loop with the line that leaves it, so the imports to
      // change can be read off without opening each file to find them.
      text: loop.map((file, at) => (at < loop.length - 1 ? `${file}:${hop(at).line}` : file)).join(" -> "),
      count: 1,
    };
  });

  return {
    ...base,
    ok,
    actual,
    message:
      read.missing ??
      describeOutcome(assertion.bounds, actual, { excluded: 0, stale: [], gaps: 0 }, CYCLES) +
        strictSuffix(options, gaps),
    matches: matches.slice(0, options.maxSnippets),
    durationMs: elapsed(startedAt),
  };
}

/**
 * Checks each file's imports against the layer order.
 *
 * Five things fail besides a violation, because each is a rule that would
 * otherwise pass while checking less than it says: a layer that matches no
 * file, a file two layers claim, a missing target, a layer no C# using can
 * reach, and a scope in which no import reaches another layer at all. The
 * first, the last two and their `allow-empty` are the same idea - a rule that
 * could not have failed. See ADR-0011.
 */
function finishLayers(
  assertion: Assertion,
  order: readonly string[],
  options: Omit<ExecuteOptions, "engine">,
  base: ImportBase,
  warnings: string[],
  startedAt: number,
  read: ImportRead,
): AssertionResult {
  const query = assertion.imports as NonNullable<Assertion["imports"]>;
  const report = checkLayers(read.analysed, order, query.includeTypes);
  const quoted = (layers: readonly number[]): string =>
    layers.map((layer) => `"${order[layer]}"`).join(" and ");

  const empty = order.flatMap((_, layer) => (report.members[layer] === 0 ? [layer] : []));
  const emptyAllowed = options.allowEmptyScope || assertion.allowEmpty;
  const one = empty.length === 1;
  const unmatched = `${one ? "layer" : "layers"} ${quoted(empty)} ${one ? "matches" : "match"} no file in scope`;

  if (report.unassigned.length > 0) {
    warnings.push(
      `${report.unassigned.length} of ${read.analysed.length} files ${report.unassigned.length === 1 ? "belongs" : "belong"} to no layer, so nothing here constrains ${report.unassigned.length === 1 ? "it" : "them"}`,
    );
  }
  if (empty.length > 0 && emptyAllowed) warnings.push(unmatched);

  // A layer named by its folder, `src/Shop.Domain`, holds the right files, and
  // no using - which names `Shop.Domain.Orders`, never a path - reaches it.
  const blind = report.unreachable;
  const alone = blind.length === 1;
  const unreached = `no C# using can reach ${alone ? "layer" : "layers"} ${quoted(blind.map(({ layer }) => layer))}: ${alone ? "it matches" : "they match"} none of the namespaces ${alone ? "its" : "their"} files declare, such as ${blind.map(({ namespace }) => namespace).join(" and ")}, so a dependency on ${alone ? "it" : "them"} is never seen`;
  if (blind.length > 0 && emptyAllowed) warnings.push(unreached);
  const uncrossed = "no import in scope reaches a layer other than its own file's, so these layers would pass in any order";
  if (!report.crossed && emptyAllowed) warnings.push(uncrossed);

  const fileCounts = new Map(report.violations.map((violation) => [violation.file, 1]));
  const { excluded, stale, shows } = applyBaseline(assertion.baseline, fileCounts);
  const staleFailure = assertion.ratchet === "two-sided" && stale.length > 0;
  const actual = report.violations.length - excluded;
  const emptyFailure = empty.length > 0 && !emptyAllowed;
  const blindFailure = blind.length > 0 && !emptyAllowed;
  const uncrossedFailure = !report.crossed && !emptyAllowed;

  const ok =
    satisfies(actual, assertion.bounds) &&
    read.missing === null &&
    !staleFailure &&
    !emptyFailure &&
    report.ambiguous.length === 0 &&
    !blindFailure &&
    !uncrossedFailure &&
    !(options.strictTargets && read.unresolved > 0);

  const message =
    read.missing ??
    (emptyFailure
      ? `${unmatched}, so nothing is held to ${one ? "it" : "them"} (${EMPTY_SCOPE_HINT})`
      : report.ambiguous.length > 0
        ? `${report.ambiguous
            .slice(0, options.maxSnippets)
            .map(({ file, layers }) => `${file} is in both ${quoted(layers)}`)
            .join("; ")}; a file in two layers has no single rule to follow`
        : blindFailure
          ? `${unreached} (a layer reaches C# when it matches the namespace as well as the folder; ${EMPTY_SCOPE_HINT})`
          : uncrossedFailure
            ? `${uncrossed} (${EMPTY_SCOPE_HINT})`
            : describeOutcome(
                assertion.bounds,
                actual,
                { excluded, stale: staleFailure ? stale : [], gaps: 0 },
                VIOLATING_FILES,
              ) + strictSuffix(options, read.unresolved));

  return {
    ...base,
    ok,
    actual,
    message,
    baselinedMatches: excluded,
    staleBaseline: stale,
    fileMatches: [...fileCounts].map(([file, count]) => ({ file, count })),
    matches: report.violations
      .filter((violation) => shows(violation.file))
      .slice(0, options.maxSnippets)
      .map((violation) => ({
        file: violation.file,
        line: violation.reference.line,
        column: violation.reference.column,
        text: `${order[violation.from]} -> ${order[violation.to]}: ${IMPORT_VERBS[violation.reference.kind]} ${violation.reference.specifier}`,
        count: 1,
      })),
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

/**
 * The part of a run decided by the specs alone: the rules to execute, and what
 * is wrong with the rest.
 */
export interface RunPlan {
  root: string;
  /** Every spec file the patterns matched, absolute. */
  specFiles: readonly string[];
  /** The rules to execute, in document order. */
  assertions: Assertion[];
  /** How many directives their document's status withheld. */
  withheld: number;
  /** Parse and resolution errors, in the order they were found. */
  errors: DirectiveError[];
  inactiveSpecs: InactiveSpec[];
  /** The project's exclusions every rule was resolved with. */
  exclude: string[];
}

/**
 * Throws for a project exclusion that can never exclude anything.
 *
 * The command line and the configuration refuse these before a run starts, with
 * the option or file named. This is for a caller of the API, which would
 * otherwise get the same silent no-op they refuse.
 */
export function checkProjectExcludes(exclude: readonly string[] | undefined): string[] {
  const patterns = [...(exclude ?? [])];
  const error = excludeListError(patterns);
  if (error !== null) throw new Error(`${error}.`);
  return patterns;
}

/**
 * Resolves what a set of specs asks for, reading nothing.
 *
 * The first half of `runSpecGuard`, moved out so that a watch session plans
 * each run the way a run does rather than by a copy of it (ADR-0014).
 */
export function planRun(
  specs: SpecSet,
  root: string,
  options: Pick<RunOptions, "includeSpecs" | "defaultSkips" | "ignoreStatus" | "select" | "exclude">,
): RunPlan {
  const exclude = checkProjectExcludes(options.exclude);
  const scope = createScope(options.defaultSkips ?? true);
  const excludeFiles = specExclusions(specs.files, options.includeSpecs ?? false);

  const directives: Directive[] = [];
  /** Parsed, validated, and then not run: see ADR-0010. */
  const withheld: Directive[] = [];
  const errors: DirectiveError[] = [...specs.errors];
  const inactiveSpecs: InactiveSpec[] = [];

  for (const document of specs.documents) {
    if (!document.inForce && !(options.ignoreStatus ?? false)) {
      // A document is only ever out of force because of a status it declares.
      const status = document.status as SpecStatus;
      withheld.push(...document.directives);
      // Recorded even when it held no directives. "docs/adr/0011.md is a
      // draft" is worth saying to someone wondering why their new rule has no
      // effect, and a report that only mentions the documents it happened to
      // find directives in cannot answer that.
      inactiveSpecs.push({
        file: document.relativeFile,
        status: status.value,
        label: status.label,
        directives: document.directives.length,
      });
      continue;
    }
    directives.push(...document.directives);
  }

  const assertions: Assertion[] = [];
  for (const directive of directives) {
    const resolved = resolveDirective(directive, { root, excludeFiles, scope, exclude });
    if ("error" in resolved) errors.push(resolved.error);
    // Selection happens after resolution, so a directive that is not selected
    // is still held to being well-formed - the same bargain ADR-0010 strikes
    // for a document that is not in force.
    else if (options.select?.(resolved.assertion) ?? true) assertions.push(resolved.assertion);
  }

  // Not in force is not the same as not checked. A withheld directive is still
  // held to being well-formed, so a draft's typo is found on the day it is
  // written rather than on the day the ADR is accepted - which is the day
  // everyone has already agreed the rule is right and stopped looking at it.
  for (const directive of withheld) {
    const resolved = resolveDirective(directive, { root, excludeFiles, scope, exclude });
    if ("error" in resolved) errors.push(resolved.error);
  }

  return { root, specFiles: specs.files, assertions, withheld: withheld.length, errors, inactiveSpecs, exclude };
}

/**
 * A run's report, from its plan and the results of the rules it executed.
 *
 * The last part of `runSpecGuard`, shared with a watch session for the same
 * reason as `planRun`.
 */
export function reportRun(
  plan: RunPlan,
  results: AssertionResult[],
  engine: { name: EngineName; fallbacks: readonly string[] },
  startedAt: number,
): RunResult {
  const warnings = engine.fallbacks.map(
    (message) =>
      `ripgrep failed, fell back to the JavaScript engine (${message})`,
  );

  // Errors arrive in two waves (parse, then resolve); readers expect file order.
  const errors = [...plan.errors].sort((a, b) =>
    a.location.relativeFile === b.location.relativeFile
      ? a.location.line - b.location.line
      : comparePaths(a.location.relativeFile, b.location.relativeFile),
  );

  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0 && errors.length === 0,
    root: plan.root,
    engine: warnings.length > 0 ? "javascript" : engine.name,
    durationMs: elapsed(startedAt),
    summary: {
      specs: plan.specFiles.length,
      total: results.length,
      passed: results.length - failed,
      failed,
      skipped: plan.assertions.length - results.length,
      inactive: plan.withheld,
    },
    results,
    errors,
    warnings,
    inactiveSpecs: plan.inactiveSpecs,
    exclude: plan.exclude,
    specFiles: plan.specFiles.map((file) => specPath(plan.root, file)),
  };
}

/**
 * Why a run given a door of its caller's cannot search with ripgrep.
 *
 * Exported so a test can hold the words; the refusal is the only thing a
 * caller who asked for both learns.
 */
export const RIPGREP_THROUGH_IO =
  'engine "ripgrep" cannot read through the io this run was given: ripgrep reads the disk itself, in a process of its own. Leave engine unset, or set it to "auto" or "javascript".';

/**
 * The engine a run searches with.
 *
 * A caller's door gets the scanner reading through it, for `auto` as for
 * `javascript`: the adaptive engine hands a large tree to ripgrep, which reads
 * around any door. Anything `resolveEngine` would take for ripgrep is refused.
 * The scanner is its own fallback, as a watch session's is (ADR-0014), because
 * the shared one reads the filesystem.
 */
async function runEngine(preference: EnginePreference, io: Io | undefined): Promise<CachedEngine> {
  if (io === undefined) return createCachedEngine(await resolveEngine(preference));
  if (preference !== "auto" && preference !== "javascript") throw new Error(RIPGREP_THROUGH_IO);
  const scanner = createJavaScriptEngine(io);
  return createCachedEngine(scanner, scanner);
}

/** Reads, parses and executes every directive found in the given spec files. */
export async function runSpecGuard(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now();
  const root = path.resolve(options.root ?? process.cwd());
  const io = options.io ?? nodeIo;
  const plan = planRun(await readSpecs(options.patterns, root, io), root, options);
  const assertions = plan.assertions;

  const engine = await runEngine(options.engine ?? "auto", options.io);
  const executeOptions: ExecuteOptions = {
    root,
    io,
    engine,
    allowMissingTargets: options.allowMissingTargets ?? false,
    strictTargets: options.strictTargets ?? false,
    allowEmptyScope: options.allowEmptyScope ?? false,
    maxSnippets: options.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    imports: createImportIndex(io),
    hasFiles: createScopeProbe(io),
    tree: createTreeIndex(root, io),
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

  return reportRun(plan, results, engine, startedAt);
}
