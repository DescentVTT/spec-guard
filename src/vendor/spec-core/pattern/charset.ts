/**
 * Sets of characters a glob position accepts, over Unicode code points.
 *
 * A glob matches a path one character at a time, and a character is a code
 * point: `?` matches `é` whether it is stored as one UTF-16 unit or not, and an
 * emoji as one. That is what a person counting characters in a file name
 * expects, and it is the same on every host.
 *
 * No set but the separator's accepts `/`. A path is matched a segment at a
 * time, and a `*` or a `[!a]` that swallowed a slash would let one segment of
 * a pattern match two of a path.
 */

/** An inclusive range of code points. */
export type CodeRange = readonly [number, number];

export interface CharSet {
  readonly negated: boolean;
  readonly ranges: readonly CodeRange[];
  /** True only for the path separator itself. */
  readonly separator: boolean;
}

export const SLASH = 0x2f;
export const DOT = 0x2e;
export const MAX_CODE_POINT = 0x10ffff;

/** The separator, and nothing else. */
export const SEPARATOR: CharSet = { negated: false, ranges: [[SLASH, SLASH]], separator: true };

/** Any character but the separator: `?`, and the body of `*`. */
export const ANY: CharSet = { negated: true, ranges: [], separator: false };

export function literalSet(point: number): CharSet {
  return { negated: false, ranges: [[point, point]], separator: point === SLASH };
}

export function classSet(ranges: readonly CodeRange[], negated: boolean): CharSet {
  return { negated, ranges, separator: false };
}

function within(ranges: readonly CodeRange[], point: number): boolean {
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i] as CodeRange;
    if (point >= range[0] && point <= range[1]) return true;
  }
  return false;
}

/** Whether a set accepts a code point as written. */
export function accepts(set: CharSet, point: number): boolean {
  if (point === SLASH) return set.separator;
  return within(set.ranges, point) !== set.negated;
}

/**
 * The code points a code point is the same letter as, ignoring case: itself,
 * and its lower- and upper-case forms where each is a single code point.
 *
 * Simple case mapping, which is what `toLowerCase` and `toUpperCase` give one
 * character at a time. It is locale-free, so two hosts agree; `ß` has no single
 * upper-case code point and so matches only itself.
 */
export function caseVariants(point: number): readonly number[] {
  if (point < 0x80) {
    if (point >= 0x41 && point <= 0x5a) return [point, point + 32];
    if (point >= 0x61 && point <= 0x7a) return [point, point - 32];
    return [point];
  }
  const char = String.fromCodePoint(point);
  const out = [point];
  for (const variant of [char.toLowerCase(), char.toUpperCase()]) {
    const code = variant.codePointAt(0) as number;
    if (variant.length === String.fromCodePoint(code).length && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Whether a set accepts a code point with case ignored: whether it accepts
 * the point or one of its case variants. A negated set is negated over the
 * same question, so `[!a]` refuses `A` as well as `a`.
 */
export function acceptsIgnoringCase(set: CharSet, point: number): boolean {
  if (point === SLASH) return set.separator;
  const variants = caseVariants(point);
  let inside = false;
  for (let i = 0; i < variants.length && !inside; i += 1) inside = within(set.ranges, variants[i] as number);
  return inside !== set.negated;
}

/**
 * Characters a witness is spelled with when any of them will do, in order of
 * preference. A witness is read by a person deciding whether two scopes really
 * overlap, and `src/x.ts` reads better than `src/\u0000.ts`.
 */
const READABLE = [0x78, 0x61, 0x62, 0x30, 0x5f, 0x2d, 0x7e, 0x21, DOT, SLASH] as const;

/**
 * Every code point at which the answer "which of these sets accept it" can
 * change, readable ones first.
 *
 * Each set accepts a union of intervals, so the sets' memberships are constant
 * between consecutive interval ends. The start of each interval and the point
 * after its end therefore meet every distinct combination of answers, and
 * trying them all decides every question a witness search can ask of one
 * character. The separator and the dot are always included: path validity
 * turns on them.
 */
export function boundaryPoints(sets: readonly CharSet[]): number[] {
  // 1, not 0: no path holds a NUL, so the least character worth trying is the next.
  const points: number[] = [...READABLE, 1];
  for (const set of sets) {
    for (const [low, high] of set.ranges) {
      points.push(low);
      if (high < MAX_CODE_POINT) points.push(high + 1);
    }
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const point of points) {
    if (seen.has(point)) continue;
    seen.add(point);
    out.push(point);
  }
  return out;
}
