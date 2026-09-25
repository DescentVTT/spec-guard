/**
 * Non-deterministic finite automata over code points: built by Thompson's
 * construction, run by keeping a set of live states, and searched for a
 * shortest string several of them accept and several others refuse.
 *
 * Why an automaton rather than a `RegExp`: a glob such as `*-*-*-*-*-*x`
 * handed to a backtracking engine tries every way of dividing a long name
 * between its stars, and one spec-* tool measured 28 seconds for one path. A
 * set of live states visits each state at most once per character, so a match
 * costs at most the pattern's size times the path's length, whatever the
 * pattern says.
 *
 * Why the same automaton for the witness: whether two scopes can name the same
 * file, and whether one lies wholly inside another, are questions about the
 * languages the patterns accept. Asked of the automata that do the matching,
 * the answers cannot drift from what matching does.
 */

import { accepts, acceptsIgnoringCase, boundaryPoints, DOT, SLASH, type CharSet } from './charset.js';

const CHAR = 0;
const SPLIT = 1;
const JUMP = 2;
const MATCH = 3;

/** A compiled automaton. Immutable once built, and safe to share. */
export interface Automaton {
  readonly kinds: Uint8Array;
  /** A CHAR's next state, a SPLIT's first branch, a JUMP's target. */
  readonly first: Int32Array;
  /** A SPLIT's second branch. */
  readonly second: Int32Array;
  /** A CHAR's set; unused for the others. */
  readonly sets: readonly (CharSet | null)[];
  readonly start: number;
  readonly caseSensitive: boolean;
}

/** A piece of an automaton under construction: where it starts, and the arrows still unaimed. */
export interface Fragment {
  readonly start: number;
  readonly holes: readonly Hole[];
}

interface Hole {
  readonly state: number;
  readonly slot: 1 | 2;
}

/**
 * Ceiling on the size of one automaton.
 *
 * Brace alternatives are compiled side by side, so a pattern's size is the
 * sum of its alternatives'. Far above anything a scope list says; it exists
 * so that a pathological pattern is refused while compiling rather than
 * matched slowly.
 */
export const MAX_STATES = 65_536;

export class AutomatonTooLarge extends Error {
  constructor() {
    super(`the pattern compiles to more than ${MAX_STATES} states`);
    this.name = 'AutomatonTooLarge';
  }
}

/** Thompson's construction, one fragment at a time. */
export class Builder {
  private readonly kinds: number[] = [];
  private readonly first: number[] = [];
  private readonly second: number[] = [];
  private readonly sets: (CharSet | null)[] = [];

  private add(kind: number, set: CharSet | null, first: number, second: number): number {
    if (this.kinds.length >= MAX_STATES) throw new AutomatonTooLarge();
    this.kinds.push(kind);
    this.first.push(first);
    this.second.push(second);
    this.sets.push(set);
    return this.kinds.length - 1;
  }

  private patch(holes: readonly Hole[], target: number): void {
    for (const hole of holes) {
      if (hole.slot === 1) this.first[hole.state] = target;
      else this.second[hole.state] = target;
    }
  }

  /** One character from a set. */
  char(set: CharSet): Fragment {
    const state = this.add(CHAR, set, -1, -1);
    return { start: state, holes: [{ state, slot: 1 }] };
  }

  /** The empty string. */
  empty(): Fragment {
    const state = this.add(JUMP, null, -1, -1);
    return { start: state, holes: [{ state, slot: 1 }] };
  }

  /** Each fragment after the one before it. */
  sequence(parts: readonly Fragment[]): Fragment {
    if (parts.length === 0) return this.empty();
    let current = parts[0] as Fragment;
    for (let i = 1; i < parts.length; i += 1) {
      const next = parts[i] as Fragment;
      this.patch(current.holes, next.start);
      current = { start: current.start, holes: next.holes };
    }
    return current;
  }

  /** Any one of the fragments. */
  either(options: readonly Fragment[]): Fragment {
    if (options.length === 0) throw new Error('an alternation needs at least one option');
    let current = options[options.length - 1] as Fragment;
    for (let i = options.length - 2; i >= 0; i -= 1) {
      const option = options[i] as Fragment;
      const split = this.add(SPLIT, null, option.start, current.start);
      current = { start: split, holes: [...option.holes, ...current.holes] };
    }
    return current;
  }

  /** Zero or more of a fragment. */
  star(body: Fragment): Fragment {
    const split = this.add(SPLIT, null, body.start, -1);
    this.patch(body.holes, split);
    return { start: split, holes: [{ state: split, slot: 2 }] };
  }

  /** One or more of a fragment. */
  plus(body: Fragment): Fragment {
    const split = this.add(SPLIT, null, body.start, -1);
    this.patch(body.holes, split);
    return { start: body.start, holes: [{ state: split, slot: 2 }] };
  }

  /** Zero or one of a fragment. */
  optional(body: Fragment): Fragment {
    const empty = this.empty();
    return this.either([body, empty]);
  }

  /** Closes the automaton: every unaimed arrow reaches acceptance. */
  finish(body: Fragment, caseSensitive: boolean): Automaton {
    const match = this.add(MATCH, null, -1, -1);
    this.patch(body.holes, match);
    return {
      kinds: Uint8Array.from(this.kinds),
      first: Int32Array.from(this.first),
      second: Int32Array.from(this.second),
      sets: [...this.sets],
      start: body.start,
      caseSensitive,
    };
  }
}

/**
 * Follows every empty arrow out of the states on a stack, appending each
 * CHAR or MATCH state reached to `into`. `visited[state] === stamp` marks a
 * state already taken this round, which is what bounds the work.
 */
function close(
  automaton: Automaton,
  stack: number[],
  visited: Int32Array,
  stamp: number,
  into: number[],
): void {
  const { kinds, first, second } = automaton;
  while (stack.length > 0) {
    const state = stack.pop() as number;
    if (visited[state] === stamp) continue;
    visited[state] = stamp;
    switch (kinds[state]) {
      case SPLIT:
        stack.push(second[state] as number, first[state] as number);
        break;
      case JUMP:
        stack.push(first[state] as number);
        break;
      default:
        into.push(state);
    }
  }
}

/**
 * A reusable matcher over one automaton.
 *
 * Holds its buffers between subjects; it is not reentrant, and nothing needs
 * it to be - matching calls out to nothing.
 */
export class Matcher {
  private readonly automaton: Automaton;
  private readonly visited: Int32Array;
  private stamp = 0;
  private readonly stack: number[] = [];
  private live: number[] = [];
  private next: number[] = [];

  constructor(automaton: Automaton) {
    this.automaton = automaton;
    this.visited = new Int32Array(automaton.kinds.length).fill(-1);
  }

  /** Whether the automaton accepts the whole of a subject. */
  test(subject: string): boolean {
    const { automaton } = this;
    const accept = automaton.caseSensitive ? accepts : acceptsIgnoringCase;
    this.live.length = 0;
    this.stack.length = 0;
    this.stack.push(automaton.start);
    this.stamp += 1;
    close(automaton, this.stack, this.visited, this.stamp, this.live);

    for (let i = 0; i < subject.length; i += 1) {
      const point = subject.codePointAt(i) as number;
      if (point > 0xffff) i += 1;
      this.next.length = 0;
      this.stamp += 1;
      for (const state of this.live) {
        if (automaton.kinds[state] !== CHAR) continue;
        if (!accept(automaton.sets[state] as CharSet, point)) continue;
        this.stack.push(automaton.first[state] as number);
        close(automaton, this.stack, this.visited, this.stamp, this.next);
      }
      if (this.next.length === 0) return false;
      const spent = this.live;
      this.live = this.next;
      this.next = spent;
    }
    return this.live.some((state) => automaton.kinds[state] === MATCH);
  }
}

/** The answer to a witness search. */
export type Witness =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'none' }
  /** The search met its budget before deciding. Rare, and never a guess either way. */
  | { readonly kind: 'undecided' };

/**
 * How many distinct search states a witness search may visit. The search is
 * polynomial in the sizes of the automata it must satisfy and, for the ones
 * it must avoid, bounded by the subsets of their states it reaches; scope
 * patterns reach a handful. The bound turns a pathological input into an
 * `undecided` rather than a hang.
 */
export const WITNESS_BUDGET = 200_000;

/**
 * Path validity as a four-state machine: at the start of a segment, inside a
 * segment reading `.` or `..` so far, or inside a segment that is a name. A
 * witness must end inside a name, and a `/` is only legal after one, so no
 * witness has an empty segment, a `.` or `..` segment, or a slash at either
 * end - which a pattern such as `a/*\/b` would otherwise produce as `a//b`.
 * NUL is refused outright: no filesystem and no git tree holds a path with one.
 */
const SEGMENT_START = 0;
const ONE_DOT = 1;
const TWO_DOTS = 2;
const IN_NAME = 3;
const INVALID = -1;
const NUL = 0;

function stepValidity(state: number, point: number): number {
  if (point === NUL) return INVALID;
  if (point === SLASH) return state === IN_NAME ? SEGMENT_START : INVALID;
  if (point === DOT) return state === SEGMENT_START ? ONE_DOT : state === ONE_DOT ? TWO_DOTS : IN_NAME;
  return IN_NAME;
}

interface SearchNode {
  /** One live CHAR/MATCH state per automaton that must accept. */
  readonly positive: readonly number[];
  /** Every live state, sorted, per automaton that must refuse. */
  readonly negative: readonly (readonly number[])[];
  readonly validity: number;
  readonly parent: number;
  readonly point: number;
}

function closureOf(automaton: Automaton, seeds: readonly number[]): number[] {
  const visited = new Int32Array(automaton.kinds.length).fill(-1);
  const out: number[] = [];
  close(automaton, [...seeds], visited, 0, out);
  return out;
}

function stepSet(automaton: Automaton, states: readonly number[], point: number): number[] {
  const seeds: number[] = [];
  for (const state of states) {
    if (automaton.kinds[state] === CHAR && accepts(automaton.sets[state] as CharSet, point)) {
      seeds.push(automaton.first[state] as number);
    }
  }
  return closureOf(automaton, seeds).sort((a, b) => a - b);
}

/** Every way of choosing one element from each list. */
function combinations(lists: readonly (readonly number[])[]): number[][] {
  let out: number[][] = [[]];
  for (const list of lists) {
    const grown: number[][] = [];
    for (const prefix of out) for (const state of list) grown.push([...prefix, state]);
    out = grown;
  }
  return out;
}

function isMatch(automaton: Automaton, state: number): boolean {
  return automaton.kinds[state] === MATCH;
}

/**
 * A shortest path every automaton in `include` accepts and none in `exclude`
 * does, spelled with readable characters where there is a choice.
 *
 * Breadth-first over the product of one live state per included automaton
 * (existential: some run of each must accept) and the whole live set per
 * excluded one (universal: no run of it may). Characters are tried at the
 * boundary points of every set in play, which meets every combination of
 * answers those sets can give, so the search is exact: `none` means no path
 * exists, not that none was found. The first path reached is a shortest one.
 *
 * Case-sensitive automata only. Every scope comparison in the family is
 * case-sensitive, and folding case exactly would need every set's closure
 * under case mapping.
 */
export function findWitness(
  include: readonly Automaton[],
  exclude: readonly Automaton[] = [],
  budget: number = WITNESS_BUDGET,
): Witness {
  if (include.length === 0) throw new Error('a witness search needs at least one automaton to satisfy');
  for (const automaton of [...include, ...exclude]) {
    if (!automaton.caseSensitive) throw new Error('a witness search is defined for case-sensitive patterns only');
  }

  const startPositive = include.map((automaton) => closureOf(automaton, [automaton.start]));
  const startNegative = exclude.map((automaton) => closureOf(automaton, [automaton.start]).sort((a, b) => a - b));

  const nodes: SearchNode[] = [];
  const seen = new Set<string>();
  const key = (positive: readonly number[], negative: readonly (readonly number[])[], validity: number): string =>
    `${positive.join(',')}|${validity}|${negative.map((set) => set.join(',')).join('|')}`;

  const enqueue = (
    positive: readonly number[],
    negative: readonly (readonly number[])[],
    validity: number,
    parent: number,
    point: number,
  ): void => {
    const id = key(positive, negative, validity);
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({ positive, negative, validity, parent, point });
  };

  for (const positive of combinations(startPositive)) enqueue(positive, startNegative, SEGMENT_START, -1, 0);

  for (let cursor = 0; cursor < nodes.length; cursor += 1) {
    if (cursor >= budget) return { kind: 'undecided' };
    const node = nodes[cursor] as SearchNode;

    const accepted = node.positive.every((state, i) => isMatch(include[i] as Automaton, state));
    const refused = node.negative.every((set, i) => !set.some((state) => isMatch(exclude[i] as Automaton, state)));
    if (accepted && refused && node.validity === IN_NAME) return { kind: 'found', path: spell(nodes, cursor) };

    // A MATCH state reads nothing more: an included automaton sitting on one
    // can only accept here, so no longer path extends this node.
    if (node.positive.some((state, i) => (include[i] as Automaton).kinds[state] !== CHAR)) continue;

    const sets: CharSet[] = [];
    node.positive.forEach((state, i) => sets.push((include[i] as Automaton).sets[state] as CharSet));
    node.negative.forEach((set, i) => {
      const automaton = exclude[i] as Automaton;
      for (const state of set) if (automaton.kinds[state] === CHAR) sets.push(automaton.sets[state] as CharSet);
    });

    // Where each included automaton goes next does not depend on the
    // character, only whether it may go; what the excluded ones reach does.
    const successors = combinations(
      node.positive.map((state, i) => closureOf(include[i] as Automaton, [(include[i] as Automaton).first[state] as number])),
    );
    for (const point of boundaryPoints(sets)) {
      const validity = stepValidity(node.validity, point);
      if (validity === INVALID) continue;
      if (!node.positive.every((state, i) => accepts((include[i] as Automaton).sets[state] as CharSet, point))) {
        continue;
      }
      const negative = node.negative.map((set, i) => stepSet(exclude[i] as Automaton, set, point));
      for (const positive of successors) enqueue(positive, negative, validity, cursor, point);
    }
  }
  return { kind: 'none' };
}

function spell(nodes: readonly SearchNode[], index: number): string {
  const points: number[] = [];
  for (let i = index; (nodes[i] as SearchNode).parent >= 0; i = (nodes[i] as SearchNode).parent) {
    points.push((nodes[i] as SearchNode).point);
  }
  return String.fromCodePoint(...points.reverse());
}
