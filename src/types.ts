/**
 * Shared types for spec-guard.
 *
 * The pipeline is deliberately linear and side-effect free until the very edge:
 *   parser -> Directive[]  ->  runner (+ engine) -> AssertionResult[]  ->  reporter
 */

/** The three assertion kinds understood by the parser. */
export type DirectiveKind = 'assert-absence' | 'assert-count' | 'assert-present';

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
  /** Absolute file paths to exclude from results (the spec files themselves). */
  excludeFiles: ReadonlySet<string>;
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
  /** Up to `maxSnippets` match locations, in file order. */
  matches: MatchLocation[];
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
  /** Targets that do not exist on disk. */
  missingTargets: string[];
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
