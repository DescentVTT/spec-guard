/**
 * Search scope: what an assertion actually looked at.
 *
 * An assertion's answer is worth exactly as much as the set of files behind it.
 * "`LegacyThing` appears nowhere in `src`" is a useful claim; "`LegacyThing`
 * appears nowhere in the part of `src` we happened to walk" is not, and the two
 * are indistinguishable in a report that only prints a count.
 *
 * So every file under a target lands in exactly one of three states, and the
 * third one is never silent:
 *
 *   inspected  - read and searched.
 *   excluded   - the assertion's own `exclude`/`glob` said so. Not reported:
 *                the user asked for it and already knows.
 *   skipped    - spec-guard decided. Always counted, always reported.
 *
 * Skips split further, because two very different things were being conflated:
 *
 *   policy      - `.git`, `node_modules`. Deliberate, uninteresting, and not a
 *                 gap in the analysis. Reported as a total.
 *   uncertainty - a file that could not be read, or whose bytes are not text.
 *                 These are gaps: the file might contain the symbol and nobody
 *                 knows. Reported individually, and `--strict` fails on them.
 *
 * The policy list is deliberately tiny. Every name on it is a place where the
 * tool can be sure it is not looking at your code: version-control object
 * stores, which hold compressed copies of code you already deleted, and
 * dependency trees, which hold code you did not write. Names like `dist`,
 * `build`, `out` and `coverage` are **not** on it, because spec-guard cannot
 * tell a build output directory from a directory of build scripts, and a guess
 * that goes the wrong way is exactly the silent false green this module exists
 * to prevent. Narrowing scope is the assertion's job, through `exclude`.
 */

/**
 * Why spec-guard, rather than the user, left a path out.
 *
 * `worktree` is a directory below where a walk starts that holds a `.git` of
 * its own: another checkout, of this repository or of another one, whose
 * files are not this one's (ADR-0007, amended 2026-10-19).
 */
export type SkipReason = 'vcs' | 'dependencies' | 'unreadable' | 'binary' | 'worktree';

/**
 * Reasons that represent a gap in the analysis rather than a deliberate
 * omission. These are what `--strict` refuses to pass over.
 */
export const UNCERTAIN_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>(['unreadable', 'binary']);

/**
 * The entries of a ledger that are gaps in the answer, which is what
 * `--strict` fails on. A ledger also names the other work trees a walk left
 * out, which are no gap: what they hold is another checkout's.
 */
export function gapsOf(ledger: ScopeLedger): SkippedPath[] {
  return ledger.skipped.filter((entry) => UNCERTAIN_REASONS.has(entry.reason));
}

/**
 * Directory names skipped unless `--no-default-skips` is given.
 *
 * Four names, each one a place where anything found would be misleading rather
 * than merely noisy: a version-control store answers "did this ever exist",
 * not "does this exist", and a dependency tree answers for somebody else's
 * code.
 */
export const DEFAULT_SKIPPED_DIRECTORIES: ReadonlyMap<string, SkipReason> = new Map<string, SkipReason>([
  ['.git', 'vcs'],
  ['.hg', 'vcs'],
  ['.svn', 'vcs'],
  ['node_modules', 'dependencies'],
]);

/**
 * What a run is allowed to look at.
 *
 * One object, shared by both engines: the JavaScript walker consults it
 * directly and the ripgrep arguments are derived from it, so the two cannot
 * drift apart without a test noticing.
 */
export interface ScopePolicy {
  /** Directory names to skip, and why. Empty under `--no-default-skips`. */
  readonly skippedDirectories: ReadonlyMap<string, SkipReason>;
  /**
   * Whether a directory below where a walk starts that holds a `.git` of its
   * own is left out. A linked worktree under `.claude/worktrees`, a submodule
   * and a clone inside the tree are each another checkout: walked, their
   * citations were counted twice and a stale one failed `cites --strict` in
   * the checkout above them. Off under `--no-default-skips`.
   */
  readonly otherWorkTrees: 'skip' | 'walk';
}

export const DEFAULT_SCOPE: ScopePolicy = { skippedDirectories: DEFAULT_SKIPPED_DIRECTORIES, otherWorkTrees: 'skip' };

/** A policy that walks everything, for when only certainty will do. */
export const SCAN_EVERYTHING: ScopePolicy = { skippedDirectories: new Map(), otherWorkTrees: 'walk' };

export function createScope(useDefaultSkips: boolean): ScopePolicy {
  return useDefaultSkips ? DEFAULT_SCOPE : SCAN_EVERYTHING;
}

/** One path spec-guard declined to inspect, with the reason. */
export interface SkippedPath {
  /** Path relative to the run root, POSIX separators. */
  readonly path: string;
  readonly reason: SkipReason;
  /**
   * Matches found inside a file that was not counted.
   *
   * Only meaningful for `binary`: the bytes were searched, so we know whether
   * ignoring the file mattered. A binary file with no match is a non-event; a
   * binary file *with* one is the difference between a real pass and a lie.
   */
  readonly matches?: number;
}

/** How many paths were skipped, by reason, plus a sample for the report. */
export interface ScopeLedger {
  readonly skipped: readonly SkippedPath[];
}

export const EMPTY_LEDGER: ScopeLedger = { skipped: [] };

/** Longest list of skipped paths a single result will carry. */
export const MAX_LEDGER_ENTRIES = 100;

/** Accumulates skips without letting a pathological tree exhaust memory. */
export class LedgerBuilder {
  private readonly entries: SkippedPath[] = [];
  private readonly counts = new Map<SkipReason, number>();

  add(path: string, reason: SkipReason, matches?: number): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    if (this.entries.length < MAX_LEDGER_ENTRIES) {
      this.entries.push(matches === undefined ? { path, reason } : { path, reason, matches });
    }
  }

  /** How many paths carried this reason, including any beyond the sample cap. */
  count(reason: SkipReason): number {
    return this.counts.get(reason) ?? 0;
  }

  build(): ScopeLedger {
    return { skipped: this.entries };
  }
}

/** Totals per reason, computed from a ledger. */
export function tallyLedger(ledger: ScopeLedger): Map<SkipReason, number> {
  const totals = new Map<SkipReason, number>();
  for (const entry of ledger.skipped) {
    totals.set(entry.reason, (totals.get(entry.reason) ?? 0) + 1);
  }
  return totals;
}

/** Merges ledgers from several searches into one. */
export function mergeLedgers(ledgers: readonly ScopeLedger[]): ScopeLedger {
  const seen = new Set<string>();
  const skipped: SkippedPath[] = [];
  for (const ledger of ledgers) {
    for (const entry of ledger.skipped) {
      const key = `${entry.reason}:${entry.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (skipped.length < MAX_LEDGER_ENTRIES) skipped.push(entry);
    }
  }
  return { skipped };
}

/**
 * True when the bytes are not text.
 *
 * A NUL anywhere means binary, which is the same question ripgrep answers when
 * it reports a `binary_offset` and stops. Checking only a prefix - the usual
 * shortcut - would disagree with ripgrep on any file whose first NUL comes
 * late, and disagreeing engines are the defect this module exists to remove.
 */
export function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}
