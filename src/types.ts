import type { ScopeLedger, ScopePolicy } from './scope.js';

/**
 * Shared types for spec-guard.
 *
 * The pipeline is deliberately linear and side-effect free until the very edge:
 *   parser -> Directive[]  ->  runner (+ engine) -> AssertionResult[]  ->  reporter
 */

/** Every assertion kind the parser understands. */
export type DirectiveKind =
  | 'assert-absence'
  | 'assert-count'
  | 'assert-present'
  | 'assert-import-absence'
  | 'assert-import-count'
  | 'assert-import-cycle'
  | 'assert-layers'
  | 'assert-structure';

/** What an `@assert-structure` directive claims. Exactly one per directive; see ADR-0013. */
export type StructureClaim = 'pattern' | 'required' | 'partner';

/** The claim of an `@assert-structure` directive, resolved. */
export interface StructureQuery {
  claim: StructureClaim;
  /**
   * The claim's list, as written: the name patterns every file must match, the
   * entries every directory must hold, or the partner templates of which one
   * must exist.
   */
  values: string[];
  /**
   * For `required`, the glob choosing directories below each target. Absent
   * when the rule is about the targets themselves.
   */
  dirs?: string;
}

/** Extra scope carried by the import assertions. */
export interface ImportQuery {
  /** Module patterns, matched with gitignore-style rules. */
  modules: string[];
  /** Whether `import type` / `export type` count as dependencies. */
  includeTypes: boolean;
  /** Whether `import('x')` counts. Only a cycle rule can leave it out (`dynamic="ignore"`). */
  includeDynamic: boolean;
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

/**
 * A document's declared lifecycle state, as written in the document.
 *
 * ADRs are an historical ledger: one moves from Proposed to Accepted, and later
 * to Superseded, and the superseded text stays on disk because deleting it
 * deletes the reason a decision was made. spec-guard executed every directive
 * it found regardless, which made a draft break CI and made a superseded ADR
 * keep enforcing a rule its own heading says was replaced.
 *
 * See ADR-0010 for why this is read from the document rather than declared per
 * directive, and why an unrecognised word stays in force.
 */
export interface SpecStatus {
  /** The first word, lowercased: `superseded` from "Superseded by ADR-0007". */
  value: string;
  /** The whole line as written, which is what a reader wants to be shown. */
  label: string;
  /** Where in the document it was found. */
  source: 'frontmatter' | 'heading' | 'label';
  /** Whether the directives in this document execute. */
  active: boolean;
}

/**
 * Something about how a spec document was read that a reader should know and
 * that fails nothing: a status that could not be read, a block that is never
 * closed. Each changes which of the document's rules run, which is why none is
 * left unsaid.
 */
export interface SpecWarning {
  location: SourceLocation;
  /** Which of them, in words that stay the same while the document changes around it. */
  kind: 'unreadable-status' | 'unclosed-block';
  message: string;
}

/** What hides a directive-shaped comment from being read as a directive. */
export type MaskedContext = 'fenced code' | 'indented code' | 'code span' | 'raw HTML' | 'front matter';

/**
 * A comment shaped like a directive - `<!-- @assert-...` - that was not read as
 * one, because it sits in text no directive is read from.
 *
 * Usually an example, shown on purpose. But which text is code decides which
 * rules run, and a document whose code ends somewhere other than where its
 * author thinks - an indented line, a `---` read as front matter - loses its
 * rules without a word. So they are counted and named, never run.
 */
export interface MaskedDirective {
  location: SourceLocation;
  inside: MaskedContext;
}

export interface ParseResult {
  directives: Directive[];
  errors: DirectiveError[];
  /** The document's declared status, when it declares one. */
  status?: SpecStatus;
  /** Present only when there is something to say. */
  warnings?: SpecWarning[];
  /** Present only when there are any. */
  masked?: MaskedDirective[];
}

/** A spec file whose status withheld its directives from execution. */
export interface InactiveSpec {
  /** Path relative to the root, forward slashes. */
  file: string;
  /** The normalised status word that withheld it. */
  status: string;
  /** The status line as written. */
  label: string;
  /** How many directives were not executed. */
  directives: number;
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
  /**
   * 1-based line number, or 0 when the match is the path as a whole - a file
   * with the wrong name, or a directory missing an entry, has no line.
   */
  line: number;
  /** 1-based column of the first match on that line; 0 alongside a line of 0. */
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
   * The layer patterns of `@assert-layers`, from the layer everything may depend
   * on to the layer that may depend on everything. See ADR-0011.
   */
  layers?: string[];
  /** Present on `@assert-structure`. */
  structure?: StructureQuery;
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
  /**
   * The claim of an `@assert-structure` result.
   *
   * Carried because it decides what a match is: a file for `pattern` and
   * `partner`, a directory for `required` - and a directory is not something a
   * code-scanning annotation can be placed on.
   */
  claim?: StructureClaim;
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
  /**
   * Assertions never executed because their document is not in force.
   *
   * Its own field rather than a second meaning for `skipped`: one of these is
   * "the run stopped early", the other is "the author said this rule does not
   * apply yet", and a reader who cannot tell them apart is being told a run
   * was complete when it was not.
   */
  inactive: number;
}

/**
 * What a command took from a project's configuration, by key. ADR-0014.
 *
 * Carried on a report because an option in a file nobody is looking at is an
 * option nobody knows is in force - and `allowEmptyScope` there weakens every
 * rule in the project.
 */
export interface ConfigUse {
  /** The file the options came from, relative to the root. */
  file: string;
  /** Keys whose values were used. */
  applied: string[];
  /** Keys the command line set too, and won. */
  overridden: string[];
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
  /**
   * Documents whose status withheld their directives.
   *
   * Reported by name, never merely counted. A rule that stopped being enforced
   * is the one thing a report must not be quiet about, and "0 failed" over a
   * tree where half the ADRs went dormant is the exact shape of the lie this
   * tool exists to prevent.
   */
  inactiveSpecs: InactiveSpec[];
  /**
   * What changed how a spec document was read: a status that could not be
   * read, a block never closed. Not failures, and never left unsaid, since
   * each decides which of a document's rules run.
   */
  specWarnings?: SpecWarning[];
  /**
   * Directive-shaped comments in code, raw HTML or front matter, which no rule
   * was read from. Counted and named, as a withheld document is, so that text
   * read as code by accident is not a rule gone quiet without a word.
   */
  maskedDirectives?: MaskedDirective[];
  /**
   * The project's exclusions, added to every rule that takes `exclude`, and
   * empty when there were none.
   *
   * On the report whatever set them - a configuration, the command line, or a
   * caller of the API - since a path left out of every rule changes every
   * result, and a report that cannot say which paths those were cannot be
   * audited. `config` says whether they came from a file.
   */
  exclude: string[];
  /** What the command line took from the project's configuration, when it took anything. */
  config?: ConfigUse;
}

/* -------------------------------------------------------------------- prove */

/**
 * The bound of a rule a violation was made to cross: its maximum, a minimum
 * above zero, or, for `@assert-present`, the files it names. ADR-0016.
 */
export type ProveClaim = 'max' | 'min' | 'present';

/** What `spec-guard prove` found for a rule. */
export type ProveOutcome = 'killed' | 'survived' | 'unprovable';

/** One change a violation made to the tree, in memory and nowhere else. */
export interface TreeChange {
  /** Path relative to the root, forward slashes. */
  path: string;
  change: 'added' | 'replaced' | 'removed';
  /** How many bytes an added or replaced file holds now. */
  bytes?: number;
}

/** A violation made to cross one claim of a rule, and what the rule said about it. */
export interface ProveProbe {
  claim: ProveClaim;
  /** `killed` when the rule failed on the claim; `survived` when it still passed. */
  outcome: 'killed' | 'survived';
  /** The violation, as a sentence: what was added, put or removed, and where. */
  violation: string;
  changes: TreeChange[];
  /** The rule's own message over the changed tree. */
  message: string;
  /** What the rule counted over the changed tree. */
  actual: number;
}

export interface ProveResult {
  kind: DirectiveKind;
  location: SourceLocation;
  description: string;
  reason?: string;
  outcome: ProveOutcome;
  /** Why no violation could be made, when the outcome is `unprovable`. */
  unprovable?: string;
  /**
   * One probe per claim a violation could be made for, in order: the maximum,
   * then the minimum. A rule survives when any probe survives.
   */
  probes: ProveProbe[];
  durationMs: number;
}

export interface ProveReport {
  /** Whether no rule survived and every directive could be read. */
  ok: boolean;
  root: string;
  durationMs: number;
  summary: {
    specs: number;
    total: number;
    killed: number;
    survived: number;
    unprovable: number;
    /** Rules not proved because their document is not in force. */
    inactive: number;
  };
  results: ProveResult[];
  errors: DirectiveError[];
  inactiveSpecs: InactiveSpec[];
  /** As a run's: what changed how a document was read. */
  specWarnings?: SpecWarning[];
  /** As a run's: directive-shaped comments no rule was read from. */
  maskedDirectives?: MaskedDirective[];
  exclude: string[];
  config?: ConfigUse;
  /** Spec files that were read, relative to the root. */
  specFiles: string[];
}

/* -------------------------------------------------------------------- cites */

/**
 * One family of citable documents, as `.spec-guard.json` names it: an id
 * template whose `{n}` is a run of digits, and a glob naming the documents
 * with `{n}` standing for the number. ADR-0017.
 */
export interface CiteFamily {
  /** The id as comments write it, e.g. `ADR-{n}`. */
  id: string;
  /** The documents, e.g. `docs/adr/{n}-*.md`. */
  files: string;
}

/** What a citation found wrong: the document is not there, or not in force. */
export type CiteRule = 'ghost-citation' | 'stale-citation';

/** One citation of a document that does not exist or is no longer in force. */
export interface CiteFinding {
  rule: CiteRule;
  /** A ghost is an error; a stale citation a warning, or an error under `--strict`. */
  severity: 'error' | 'warning';
  /** The file whose comment cites, root-relative, forward slashes. */
  file: string;
  line: number;
  column: number;
  /** The id as the comment wrote it: `ADR-7`, `ADR-0007`. */
  cited: string;
  /** The family's id template. */
  family: string;
  /** The document cited, when there is one. */
  document?: string;
  /** Its status word, for a stale citation. */
  status?: string;
  /** The id to cite instead, when the document's status line names one in force. */
  successor?: string;
  message: string;
  /** What to do next. */
  hint: string;
}

/** A family as a report shows it: where it came from, and what it found. */
export interface CiteFamilyReport extends CiteFamily {
  /** `config` when `cites` named it; `derived` when read off the spec files. */
  source: 'config' | 'derived';
  /** Documents the glob matched. */
  documents: number;
}

/** A file whose comments could not all be read, and why. */
export interface CiteGap {
  file: string;
  reason: 'unreadable' | 'binary' | 'too-large' | 'lost-scan';
  detail: string;
}

export interface CitesReport {
  /** No ghost, and under `--strict` no stale citation and no file left unread. */
  ok: boolean;
  root: string;
  durationMs: number;
  families: CiteFamilyReport[];
  summary: {
    /** Source files whose comments were read. */
    files: number;
    /** Citations found, one per file, line and document. */
    citations: number;
    ghosts: number;
    stale: number;
    /** Ids another owner qualifies - `spec-core's ADR-0005` - which are that owner's documents, and not checked. */
    qualified: number;
    /** Files left unread because no comment syntax is known for their extension. */
    unclassified: number;
  };
  /** Ghost and stale citations, by file, line and column. */
  findings: CiteFinding[];
  /** Files that should have been read and could not be read in full. */
  gaps: CiteGap[];
  /** The extensions of the files left unclassified, most common first, with their counts. */
  unclassified: Array<{ extension: string; files: number }>;
  /** What a reader should know about how the families were chosen. */
  notes: string[];
  exclude: string[];
  config?: ConfigUse;
}
