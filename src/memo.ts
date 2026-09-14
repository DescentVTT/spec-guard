/**
 * Work that is a pure function of a file's bytes, done once per set of bytes.
 *
 * A watch session re-executes a rule whose inputs changed, and most of what
 * that rule reads has not changed: nineteen of the twenty files in `src` are
 * the same bytes they were a second ago. Tokenizing, comment masking and
 * scanning them again would be most of what the re-execution costs (ADR-0014
 * measured about half of a run with its reads answered from memory).
 *
 * So a result is kept under the hash of the bytes it came from and every other
 * input it depends on. Nothing here is ever invalidated, because nothing here
 * can be wrong about the bytes it is keyed by - which is also why a key that
 * forgets an input is the one defect this module can have, and why the watch
 * equivalence test holds a memo keyed without the file's path as a negative
 * control.
 *
 * A plain run remembers nothing and hashes nothing: `NO_MEMO` computes.
 *
 * One memo serves three callers, and no key of one can be a key of another,
 * because each passes a different number of inputs: an import analysis its path,
 * a spec its two paths, a scan its matching options, its patterns and its path.
 * A caller added later with the same count needs a tag of its own.
 */

import { createHash } from 'node:crypto';

export interface Memo {
  /**
   * The result of `compute` for these bytes and these other inputs, computed
   * at most once while it keeps being asked for.
   */
  remember<T>(bytes: Buffer, inputs: readonly string[], compute: () => T): T;
}

/** A memo that remembers nothing, for a run that happens once. */
export const NO_MEMO: Memo = {
  remember: (_bytes, _inputs, compute) => compute(),
};

/** Hashes already taken, by the buffer they were taken of. */
const hashes = new WeakMap<Buffer, string>();

/**
 * The SHA-256 of some bytes, taken once per buffer.
 *
 * A session hands out the same buffer for a file until the file changes, so a
 * rule that reads it again costs a lookup, not a hash.
 */
export function contentHash(bytes: Buffer): string {
  let hash = hashes.get(bytes);
  if (hash === undefined) {
    hash = createHash('sha256').update(bytes).digest('hex');
    hashes.set(bytes, hash);
  }
  return hash;
}

/** A memo that remembers, and forgets what a run did not ask for. */
export interface SessionMemo extends Memo {
  /** Entries currently held. */
  readonly size: number;
  /**
   * Drops every entry not asked for since the last sweep.
   *
   * Called after each run. An edit leaves the old bytes' results behind, and a
   * session left open all day would otherwise hold one set per save.
   */
  sweep(): void;
}

export function createMemo(): SessionMemo {
  let current = new Map<string, unknown>();
  let previous = new Map<string, unknown>();

  return {
    get size(): number {
      return new Set([...previous.keys(), ...current.keys()]).size;
    },
    remember<T>(bytes: Buffer, inputs: readonly string[], compute: () => T): T {
      // JSON rather than a separator: no input can then be read as two.
      const key = JSON.stringify([contentHash(bytes), ...inputs]);
      if (current.has(key)) return current.get(key) as T;
      const value = previous.has(key) ? (previous.get(key) as T) : compute();
      current.set(key, value);
      return value;
    },
    sweep(): void {
      previous = current;
      current = new Map();
    },
  };
}
