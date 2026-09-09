import type { ScopeLedger, ScopePolicy } from './scope.js';

/**
 * Shared types for spec-guard.
 *
 * The pipeline is deliberately linear and side-effect free until the very edge:
 *   parser -> Directive[]  ->  runner (+ engine) -> AssertionResult[]  ->  reporter
 */

/** The three assertion kinds understood by the parser. */
export type DirectiveKind =
  | 'assert-absence'
  | 'assert-count'
  | 'assert-present'
  | 'assert-import-absence'
  | 'assert-import-count';

/** Extra scope carried by the import assertions. */
export interface ImportQuery {
  /** Module patterns, matched with gitignore-style rules. */
  modules: string[];
  /** Whether `import type` / `export type` count as dependencies. */
  includeTypes: boolean;
}

/** Source location of a directive inside a spec file. */
export interface SourceLocation {
  /** Absolute path to the spec file. */
  file: string;
  /** Path relative to the root, using forward slashes. Used for display. */
  relativeFile: string;
  /** 1-based line number of the directive's opening `<!--`. */
  line: number;
  /** 1-based column of the directive's opening `<!--`. */
  column: number;
}

/** A raw, syntactically valid directive extracted from Markdown. */
export interface Directive {
  kind: DirectiveKind;
  attributes: Readonly<Record<string, string>>;
  location: SourceLocation;
  /** The raw comment text, useful for error messages. */
  raw: string;
}

/** A directive that could not be parsed (unknown kind, bad attributes, ...). */
export interface DirectiveError {
  location: SourceLocation;
  message: string;
  raw: string;
}

export interface ParseResult {
  directives: Directive[];
  errors: DirectiveError[];
}

/** Search behaviour shared by `assert-absence` and `assert-count`. */
export interface SearchOptions {
  /** Treat `symbol` as a regular expression instead of a literal string. */
  regex: boolean;
  /** Require the match to be surrounded by non-word characters. */
  word: boolean;
  /** Case-insensitive matching. */
  ignoreCase: boolean;
  /** Include-only glob filters, e.g. `*.ts`. Empty means "every file". */
  globs: string[];
  /**
   * Paths to leave out, gitignore-style: a bare name matches any segment, so
   * `tests` excludes that directory wherever it appears.
   */
  excludeGlobs: string[];
  /**
   * Skip matches that sit inside comments.
   *
   * On by default: the comment recording that a symbol was removed should not
   * be what proves the symbol is still there.
   */
  ignoreComments: boolean;
  /**
   * What the walk is allowed to look at.
   *
   * Lives on the options, not on the engine, because both engines read it: the
   * scanner consults it while walking and the ripgrep arguments are derived
   * from it. One policy, so the two cannot drift.
   */
  scope: ScopePolicy;
  /** Absolute file paths to exclude from results (the spec files themselves). */
  excludeFiles: ReadonlySet<string>;
}

/**
 * One line of a debt baseline: a file that is allowed to violate, and by how
 * much.
 *
 * Counts, not line numbers. A line number is invalidated by every edit above
 * it, which would turn the baseline into a file nobody can keep current; a
 * per-file count survives refactoring and still catches the two cases that
 * matter - a new file starting to violate, and an existing one violating more.
 * What it does not catch is a violation moving within a file it already
 * covers, and ADR-0009 says so rather than implying otherwise.
 */
export interface BaselineEntry {
  /** Path relative to the root, forward slashes. */
  path: string;
  /** How many matches this file is allowed to contribute. */
  declared: number;
}

/** How strictly the baseline has to match reality. */
export type RatchetMode = 'two-sided' | 'one-way';

/** A baseline entry that claims more violations than the code has. */
export interface StaleBaselineEntry {
  path: string;
  declared: number;
  found: number;
}

/** Inclusive bounds an actual count must satisfy. */
export interface Bounds {
  min?: number;
  max?: number;
}

/** A single match location used for failure snippets. */
export interface MatchLocation {
  /** Path relative to root, forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first match on that line. */
  column: number;
  /** Trimmed line content, truncated for display. */
  text: string;
  /** Number of matches on this line. */
  count: number;
}

export interface SearchResult {
  /** Total number of matched occurrences (not lines). */
  count: number;
  /** Matches excluded because they were inside comments. */
  commentMatches: number;
  /** Files whose language has no known comment syntax, so nothing was excluded. */
  unclassifiedFiles: number;
  /** Up to `maxSnippets` match locations, in file order. */
  matches: MatchLocation[];
  /**
   * How many matches each matching file holds.
   *
   * Uncapped, unlike `matches`, because a baseline has to be evaluated against
   * every file that matched rather than the first few - a ratchet that only saw
   * the first five violations would let the sixth through.
   */
  fileCounts: ReadonlyMap<string, number>;
  /** What was not inspected, and why. Never empty for a reason nobody stated. */
  scope: ScopeLedger;
  /** Engine that produced this result. */
  engine: EngineName;
}

export type EngineName = 'ripgrep' | 'javascript';

/** Fully resolved assertion, ready to execute. */
export interface Assertion {
  kind: DirectiveKind;
  location: SourceLocation;
  /** Human readable description of what is being asserted. */
  description: string;
  /** Optional `reason="..."` supplied by the spec author. */
  reason?: string;
  /** For search assertions. */
  symbol?: string;
  /** Target paths relative to root, forward slashes. */
  targets: string[];
  /** Files referenced by `assert-present`, relative to root. */
  files: string[];
  bounds: Bounds;
  search?: SearchOptions;
  /** Present on the import assertions. */
  imports?: ImportQuery;
  /**
   * Known violations that do not count. Empty when the directive declared none.
   *
   * Always present rather than optional: `baseline ?? []` at the two places
   * that read it was a branch nothing could reach, because resolution always
   * fills this in. An unreachable fallback is indistinguishable from a
   * reachable one when you are reading the code.
   */
  baseline: readonly BaselineEntry[];
  /** Whether a baseline entry that no longer matches fails the run. */
  ratchet: RatchetMode;
  /** Targets that do not exist on disk. */
  missingTargets: string[];
  /**
   * Tolerate a scope containing no files.
   *
   * Off by default. An assertion over an empty scope passes without inspecting
   * anything, which is indistinguishable in a report from an assertion that
   * inspected a thousand files and found nothing - and one of those two is a
   * lie. Set by `allow-empty="true"` for the rules where covering nothing yet
   * is the honest state of the world.
   */
  allowEmpty: boolean;
}

export interface AssertionResult {
  ok: boolean;
  kind: DirectiveKind;
  location: SourceLocation;
  description: string;
  reason?: string;
  symbol?: string;
  targets: string[];
  files: string[];
  bounds: Bounds;
  /** Observed count: matches for searches, existing files for `assert-present`. */
  actual: number;
  /** Short "expected X, found Y" style explanation. */
  message: string;
  matches: MatchLocation[];
  warnings: string[];
  /**
   * Matches that were found but not counted because they sat inside comments.
   * Reported rather than discarded: comment exclusion is the only thing that
   * can turn a failure into a pass without anyone touching code.
   */
  commentMatches: number;
  /** Matching files whose language is unknown, so their comments counted as code. */
  unclassifiedFiles: number;
  /** What this assertion did not inspect, and why. */
  scope: ScopeLedger;
  /**
   * Matches excluded because a baseline entry accounted for them.
   *
   * Reported for the same reason `commentMatches` is: this is the other way an
   * assertion can pass without the code being clean, and a reader is entitled
   * to know it happened.
   */
  baselinedMatches: number;
  /** Baseline entries that claim more violations than the code has. */
  staleBaseline: StaleBaselineEntry[];
  /**
   * How many matches each matching file holds, in file order.
   *
   * The raw material for writing a baseline, which is why it is not capped the
   * way `matches` is.
   */
  fileMatches: Array<{ file: string; count: number }>;
  engine?: EngineName;
  durationMs: number;
}

export interface RunSummary {
  specs: number;
  total: number;
  passed: number;
  failed: number;
  /** Assertions never executed because --fail-fast stopped the run. */
  skipped: number;
}

export interface RunReport {
  ok: boolean;
  root: string;
  engine: EngineName;
  durationMs: number;
  summary: RunSummary;
  results: AssertionResult[];
  /** Spec-level problems: unparsable directives, unreadable files. */
  errors: DirectiveError[];
  /** Non-fatal notices, e.g. an engine fallback. */
  warnings: string[];
}
