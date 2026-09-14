/**
 * What a watch session knows about the tree: every read, cached, with who read
 * it. ADR-0014.
 *
 * Three rules, and everything else follows from them.
 *
 * **A read is a fact, and a reader records it.** A session gives each rule a
 * door of its own (`view`). The door answers from the cache, filling it on a
 * miss, and records the fact against the rule either way: a rule that was
 * served from the cache still depends on what the cache said.
 *
 * **Events only evict.** An event names a path and says nothing reliable about
 * what happened to it. Evicting forgets facts; it never writes one.
 *
 * **What was evicted is read again before anything runs, and compared.** A fact
 * whose value is the same as before changed nothing, whatever the event
 * suggested. Only the fields readers use count: a directory's names and their
 * kinds, a path's kind and a file's size, a file's bytes by hash. Timestamps
 * are never compared, so their granularity is not a hole and `touch` is not a
 * change.
 */

import path from 'node:path';

import type { Io } from './io.js';
import { contentHash } from './memo.js';

export type FactKind = 'listing' | 'stat' | 'content' | 'realpath';
type Kind = FactKind;

/** A fact's identity: what was read, of which path. */
export type FactKey = string;

/** Settled, so a failed read is replayed as the same failure. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Fact {
  kind: Kind;
  /** The path as it was read, resolved. */
  path: string;
  /** The path as events are compared with it. */
  folded: string;
  outcome: Promise<Outcome<unknown>>;
}

/**
 * How a path is compared with an event's: resolved, case-folded and
 * Unicode-normalised.
 *
 * Folding evicts too much on a case-sensitive filesystem, and only when two
 * names differ by case alone. Not folding would evict too little on the two
 * that are not - an event spelled `Src/a.ts` has to reach a fact read as
 * `src/a.ts` - and too little is the direction that serves an old answer.
 */
function fold(target: string): string {
  return path.resolve(target).normalize('NFC').toLowerCase();
}

function keyOf(kind: Kind, target: string): FactKey {
  return `${kind}:${fold(target)}`;
}

/** What a reader can ask of a `stat`. */
interface Kinded {
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The part of a fact a reader can observe, as a string two reads can compare.
 *
 * Built as a value and serialised, rather than spelled in marker characters, so
 * that every part of it is something a reader does look at: a directory's names
 * with the answers to each kind question, a path's kind and a file's size, a
 * file's bytes by hash. A failed read counts its message for file contents only:
 * the import index reports that message, while nothing reports why a directory
 * could not be listed or a real path resolved - only that it could not.
 */
function fingerprint(kind: Kind, outcome: Outcome<unknown>): string {
  // A failure is an object, which no observation is, holding the message only
  // where one is read: `{}` for a directory or a real path.
  return JSON.stringify(outcome.ok ? observed(kind, outcome.value) : { error: kind === 'content' ? (outcome.error as Error).message : undefined });
}

function observed(kind: Kind, value: unknown): unknown {
  if (kind === 'listing') {
    // Sorted, because two reads of one directory need not list it in one order.
    return (value as Array<Kinded & { name: string; isSymbolicLink(): boolean }>)
      .map((entry) => JSON.stringify([entry.name, entry.isSymbolicLink(), entry.isDirectory(), entry.isFile()]))
      .sort();
  }
  if (kind === 'stat') {
    const stats = value as (Kinded & { size: number }) | null;
    // A directory's size is whatever its filesystem says it is, and nothing reads it.
    return stats === null ? null : [stats.isDirectory(), stats.isFile(), stats.isFile() ? stats.size : null];
  }
  return kind === 'content' ? contentHash(value as Buffer) : value;
}

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function replay<T>(outcome: Promise<Outcome<unknown>>): Promise<T> {
  return outcome.then((settled) => (settled.ok ? (settled.value as T) : Promise.reject(settled.error)));
}

/**
 * Which facts a batch of events evicts.
 *
 * A `change` naming a directory whose listing is known evicts that directory
 * and its parent's listing, and nothing beneath it: Windows reports a
 * directory's `change` on every save inside it, and the files beneath have
 * events of their own. Anything else - a `rename`, or a path that is not a
 * known directory - evicts beneath the path too, because an entry that
 * appeared, disappeared or was replaced takes everything under it along. Node
 * documents `rename` as the event for a name that appears or disappears; that
 * is the one thing about an event this relies on.
 */
function evictions(
  events: readonly WatchEvent[],
  root: string,
  knownDirectory: (folded: string) => boolean,
): (fact: { kind: Kind; folded: string }) => boolean {
  const shallow = new Set<string>();
  const deep = new Set<string>();
  for (const event of events) {
    const target = fold(path.join(root, event.filename as string));
    if (event.type === 'change' && knownDirectory(target)) shallow.add(target);
    else deep.add(target);
  }
  const parents = new Set([...shallow, ...deep].map((target) => path.dirname(target)));
  // Each fact's ancestors are looked up, rather than each event's descendants
  // searched for: `npm install` is thousands of events, and the cost of a batch
  // should not grow with them.
  return ({ kind, folded }) => {
    if (shallow.has(folded) || deep.has(folded)) return true;
    if (kind === 'listing' && parents.has(folded)) return true;
    for (let directory = path.dirname(folded); directory !== path.dirname(directory); directory = path.dirname(directory)) {
      if (deep.has(directory)) return true;
    }
    return false;
  };
}

/**
 * The two decisions the cache makes, together: what an event evicts, and what
 * counts as a change. A parameter only so the equivalence test can hand the
 * cache a deliberately wrong one and watch the test fail.
 */
export interface FactPolicy {
  evictions: typeof evictions;
  fingerprint: typeof fingerprint;
}

export const FACT_POLICY: FactPolicy = { evictions, fingerprint };

/** One change a watcher reported: a path, relative to the root, or everything. */
export interface WatchEvent {
  type: 'rename' | 'change';
  /** Relative to the watched root, or null when the watcher could not say. */
  filename: string | null;
}

export interface FactCache {
  /** A door that reads through the cache and records every fact it serves. */
  view(record: Set<FactKey>): Io;
  /**
   * Forgets what the events may have changed, and returns the facts forgotten.
   * An event with no filename forgets everything; see `evictions` for the rest.
   */
  evict(events: readonly WatchEvent[]): Map<FactKey, Fact>;
  /** Forgets everything, and returns it. */
  evictAll(): Map<FactKey, Fact>;
  /**
   * Reads again each forgotten fact somebody used, and returns the keys whose
   * observable value changed. Facts nobody used are simply gone.
   */
  refresh(forgotten: ReadonlyMap<FactKey, Fact>, used: (key: FactKey) => boolean): Promise<Set<FactKey>>;
  /** Facts held, for tests and for the numbers ADR-0014 reports. */
  readonly size: number;
}

export function createFactCache(root: string, io: Io, policy: FactPolicy = FACT_POLICY): FactCache {
  const facts = new Map<FactKey, Fact>();

  const read = <T>(kind: Kind, target: string, load: () => Promise<T>): { key: FactKey; fact: Fact } => {
    const key = keyOf(kind, target);
    let fact = facts.get(key);
    if (fact === undefined) {
      fact = { kind, path: path.resolve(target), folded: fold(target), outcome: settle(load()) };
      facts.set(key, fact);
    }
    return { key, fact };
  };

  const reload = (fact: Fact): Fact => {
    const load: Record<Kind, () => Promise<unknown>> = {
      listing: () => io.readDirectory(fact.path),
      stat: () => io.stat(fact.path),
      content: () => io.readFile(fact.path),
      realpath: () => io.realpath(fact.path),
    };
    return { ...fact, outcome: settle(load[fact.kind]()) };
  };

  const take = (predicate: (fact: Fact, key: FactKey) => boolean): Map<FactKey, Fact> => {
    const taken = new Map<FactKey, Fact>();
    for (const [key, fact] of facts) {
      if (predicate(fact, key)) taken.set(key, fact);
    }
    for (const key of taken.keys()) facts.delete(key);
    return taken;
  };

  return {
    get size(): number {
      return facts.size;
    },

    view(record: Set<FactKey>): Io {
      const served = <T>(kind: Kind, target: string, load: () => Promise<T>): Promise<T> => {
        const { key, fact } = read(kind, target, load);
        record.add(key);
        return replay<T>(fact.outcome);
      };
      return {
        readDirectory: (directory) => served('listing', directory, () => io.readDirectory(directory)),
        stat: (target) => served('stat', target, () => io.stat(target)),
        readFile: (file) => served('content', file, () => io.readFile(file)),
        realpath: (target) => served('realpath', target, () => io.realpath(target)),
      };
    },

    evict(events: readonly WatchEvent[]): Map<FactKey, Fact> {
      if (events.some((event) => event.filename === null)) return this.evictAll();
      return take(policy.evictions(events, root, (folded) => facts.has(`listing:${folded}`)));
    },

    evictAll(): Map<FactKey, Fact> {
      return take(() => true);
    },

    async refresh(forgotten: ReadonlyMap<FactKey, Fact>, used: (key: FactKey) => boolean): Promise<Set<FactKey>> {
      const changed = new Set<FactKey>();
      await Promise.all(
        [...forgotten].map(async ([key, before]) => {
          if (!used(key)) return;
          // Another read may have cached the path again since it was evicted;
          // that read is the current one, and the comparison is with it.
          let after = facts.get(key);
          if (after === undefined) {
            after = reload(before);
            facts.set(key, after);
          }
          const [was, is] = await Promise.all([before.outcome, after.outcome]);
          if (policy.fingerprint(before.kind, was) !== policy.fingerprint(after.kind, is)) changed.add(key);
        }),
      );
      return changed;
    },
  };
}
