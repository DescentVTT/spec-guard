/**
 * A regular-expression matcher that cannot backtrack.
 *
 * Written for spec-graph, whose `~=` selector used to hand a user-supplied
 * string to `RegExp` and wait (spec-graph ADR-0017), and moved here so that
 * every tool that accepts a pattern from configuration or from a document can
 * run it unattended in CI without a pattern deciding how long CI takes.
 *
 * The cost is neither theoretical nor exotic. `^([A-Za-z0-9_]+[ ]?)+$` is what
 * somebody writes to say "the title is words separated by single spaces", and
 * against a title that does not match, V8 tries one branch per way of cutting
 * each word into pieces:
 *
 * ```text
 *                                                          RegExp      here
 * the quick brown fox jumps over the lazy dog!               0.9s      11us
 * the quick brown fox jumps over the lazy dog and!           5.4s      12us
 * the quick brown fox jumps over the lazy dog and keeps!     103s      13us
 * ```
 *
 * So a pattern here is compiled to a non-deterministic finite automaton and
 * simulated over the subject one character at a time (Thompson, 1968), keeping
 * a set of live states instead of a stack of choices. Each state is visited at
 * most once per position, which makes the work O(pattern x subject), growing
 * with the subject and not with the pattern's ambiguity.
 *
 * What it costs is a dialect. Backreferences and lookaround are not regular and
 * have no place in a linear automaton, so they are rejected while compiling,
 * with a message and an offset, rather than accepted and then slow.
 *
 * The dialect is JavaScript's without the `u` flag, character for character,
 * and is held to that by a differential test against `RegExp`: code units,
 * not code points, and `i` folding by the specification's `Canonicalize`.
 * Matching is unanchored and, unless `ignoreCase: false` is passed,
 * case-insensitive, which is what spec-graph's `~=` has always been. There
 * are no captures: nothing asks where a match was, only whether there was one.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** A pattern that will not compile, and where in it the problem starts. */
export class RegexError extends Error {
  /** Offset into the pattern source. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'RegexError';
    this.offset = offset;
  }
}

/**
 * Ceiling on the compiled program.
 *
 * Counted repetition is compiled by copying - `(ab){20}` is twenty copies -
 * which is part of what keeps the simulation flat, and also what makes
 * `(a{99}){99}` into ten thousand states. The bound has to live somewhere, and
 * a number checked while compiling is the only place it can be enforced without
 * measuring anything at match time.
 *
 * Far above any real selector: the widest pattern in this repository's own
 * tests compiles to seventeen states.
 */
const MAX_PROGRAM = 4096;

/* -------------------------------------------------------------------------- */
/* Character sets                                                             */
/* -------------------------------------------------------------------------- */

/** An inclusive range of UTF-16 code units. */
type Range = readonly [number, number];

/**
 * A set of code units, as inclusive ranges.
 *
 * Code units rather than code points, because that is what a `RegExp` without
 * the `u` flag matches: `.` consumes one half of a surrogate pair, and so does
 * this. Agreeing with the engine this replaced matters more than being right
 * about astral planes, which no selector in any corpus has asked about.
 */
interface CharSet {
  readonly negated: boolean;
  readonly ranges: readonly Range[];
}

/** `.` - anything but a line terminator, which is the default `RegExp` reading. */
const DOT: CharSet = { negated: true, ranges: [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]] };
const DIGIT: readonly Range[] = [[0x30, 0x39]];
const WORD: readonly Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
/** `\s`, taken from the specification rather than guessed at. */
const SPACE: readonly Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

/**
 * Folds a code unit the way a case-insensitive `RegExp` does.
 *
 * This is `Canonicalize` from the language specification, non-Unicode mode:
 * upper-case the character, keep it unchanged if that produced anything other
 * than one code unit, and keep it unchanged if upper-casing dragged a
 * non-ASCII character into ASCII. The last clause is the one nobody expects and
 * the reason U+017F (long s) does not match `s`.
 */
function canonical(code: number): number {
  // Every subject a glob sees is mostly ASCII, where the answer needs no string.
  // The general path below gives the same answer here, only slower.
  if (code < 128) return code >= 97 && code <= 122 ? code - 32 : code;
  const upper = String.fromCharCode(code).toUpperCase();
  if (upper.length !== 1) return code;
  const folded = upper.charCodeAt(0);
  if (code >= 128 && folded < 128) return code;
  return folded;
}

/**
 * Whether a set accepts a code unit, case-insensitively.
 *
 * The specification canonicalises both sides: a character matches a set when
 * *some* member of the set folds to the same thing it does. A single-character
 * member can be asked that exactly. A range cannot without a fold table for
 * every code unit, so a range is asked the question backwards - does the
 * character, or either of its own case forms, fall inside it - which is exact
 * for every character whose fold is its own case change, and therefore for
 * every range anyone has written.
 */
function accepts(set: CharSet, code: number): boolean {
  const folded = canonical(code);
  let hit = false;
  for (let i = 0; i < set.ranges.length; i += 1) {
    const [low, high] = set.ranges[i] as Range;
    if (low === high ? low === code || canonical(low) === folded : inRange(low, high, code)) {
      hit = true;
      break;
    }
  }
  return set.negated ? !hit : hit;
}

/**
 * Whether some member of a range folds to the same thing a code unit does.
 *
 * Asked backwards, by trying the character's own case forms against the raw
 * range - and then checking that the form found there really does fold to the
 * same place, which is the part that is easy to leave out. U+017F upper-cases
 * to `S`, so without that check it matches `[A-Z]`, and it must not: the fold
 * keeps it outside ASCII, which is the same clause `isWordChar` gets wrong if
 * nobody is watching. The differential corpus caught both.
 */
function inRange(low: number, high: number, code: number): boolean {
  if (code >= low && code <= high) return true;
  // An ASCII character's only other case form is its ASCII letter twin, and the
  // two always fold together - so the loop below would ask exactly this.
  if (code < 128) {
    const twin = code >= 65 && code <= 90 ? code + 32 : code >= 97 && code <= 122 ? code - 32 : -1;
    return twin >= low && twin <= high;
  }
  const folded = canonical(code);
  const char = String.fromCharCode(code);
  for (const variant of [char.toLowerCase(), char.toUpperCase()]) {
    if (variant.length !== 1) continue;
    const candidate = variant.charCodeAt(0);
    if (candidate >= low && candidate <= high && canonical(candidate) === folded) return true;
  }
  return false;
}

/**
 * Whether a set accepts a code unit as written.
 *
 * What `RegExp` does without the `i` flag, and so none of the folding above
 * applies - which also means none of its one divergence does.
 */
function acceptsExactly(set: CharSet, code: number): boolean {
  return within(set.ranges, code) !== set.negated;
}

function within(ranges: readonly Range[], code: number): boolean {
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i] as Range;
    if (code >= range[0] && code <= range[1]) return true;
  }
  return false;
}

/**
 * Word characters for `\b`, which is exactly `\w` here.
 *
 * The specification does widen this set under case-insensitivity - to every
 * character that folds into it, which is U+017F (long s) and U+212A (the
 * Kelvin sign) - but only in Unicode mode, where `Canonicalize` has no clause
 * keeping a non-ASCII character out of ASCII. This is the non-Unicode dialect,
 * so both stay outside and the table for `\w` answers for `\b` as well.
 *
 * Written down because the first version of this function widened the set, and
 * the differential test against `RegExp` is what said otherwise. Reading the
 * clause was not enough; running it was. See spec-graph ADR-0017.
 */
function isWordChar(code: number): boolean {
  return within(WORD, code);
}

/* -------------------------------------------------------------------------- */
/* Syntax tree                                                                */
/* -------------------------------------------------------------------------- */

type Assertion = 'start' | 'end' | 'word-boundary' | 'not-word-boundary';

type Node =
  | { readonly kind: 'empty' }
  | { readonly kind: 'char'; readonly set: CharSet }
  | { readonly kind: 'assert'; readonly assertion: Assertion }
  | { readonly kind: 'concat'; readonly parts: readonly Node[] }
  | { readonly kind: 'alternate'; readonly options: readonly Node[] }
  | { readonly kind: 'repeat'; readonly node: Node; readonly min: number; readonly max: number };

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

class PatternParser {
  private readonly source: string;
  private position = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(): Node {
    const node = this.parseAlternation();
    // Every character is an atom except the two that close something, and
    // `parseSequence` stops on both, so anything left over is an unopened `)`.
    if (this.position < this.source.length) throw new RegexError('unmatched ")"', this.position);
    return node;
  }

  private parseAlternation(): Node {
    const options: Node[] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.position += 1;
      options.push(this.parseSequence());
    }
    return options.length === 1 ? (options[0] as Node) : { kind: 'alternate', options };
  }

  private parseSequence(): Node {
    const parts: Node[] = [];
    for (;;) {
      const char = this.peek();
      if (char === undefined || char === '|' || char === ')') break;
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) return { kind: 'empty' };
    return parts.length === 1 ? (parts[0] as Node) : { kind: 'concat', parts };
  }

  private parseQuantified(): Node {
    const start = this.position;
    // A group makes its contents quantifiable: `RegExp` rejects `\b*` and
    // accepts `(\b)*`, which is the same nothing said twice, and this parser
    // treats a group as transparent - so whether one was written is the only
    // thing left that distinguishes the two.
    const grouped = this.peek() === '(';
    const atom = this.parseAtom();
    const bounds = this.parseQuantifier();
    if (bounds === null) return atom;
    if (atom.kind === 'assert' && !grouped) {
      throw new RegexError('nothing to repeat: a quantifier cannot follow an anchor', start);
    }
    return { kind: 'repeat', node: atom, min: bounds.min, max: bounds.max };
  }

  /** `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, and a trailing `?` that is ignored. */
  private parseQuantifier(): { min: number; max: number } | null {
    const char = this.peek();
    let bounds: { min: number; max: number } | null = null;

    if (char === '*') bounds = { min: 0, max: Infinity };
    else if (char === '+') bounds = { min: 1, max: Infinity };
    else if (char === '?') bounds = { min: 0, max: 1 };

    if (bounds !== null) this.position += 1;
    else if (char === '{') bounds = this.parseBraces();
    if (bounds === null) return null;

    // Laziness decides *which* match is found, and nothing here asks: the
    // question is whether one exists, and a lazy quantifier accepts the same
    // language as a greedy one.
    if (this.peek() === '?') this.position += 1;
    return bounds;
  }

  /**
   * Reads `{n,m}`, or nothing.
   *
   * A `{` that does not open a counted repetition is a literal brace, which is
   * what `RegExp` does with `a{` and what any pattern written against a
   * document full of `{0}` placeholders depends on.
   */
  private parseBraces(): { min: number; max: number } | null {
    const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.source.slice(this.position));
    if (!match) return null;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
    if (min > max) throw new RegexError('numbers out of order in a counted repetition', this.position);
    this.position += (match[0] as string).length;
    return { min, max };
  }

  private parseAtom(): Node {
    const start = this.position;
    const char = this.peek();

    switch (char) {
      case undefined:
        throw new RegexError('pattern ends where an expression was expected', start);
      case '(':
        return this.parseGroup();
      case '[':
        return { kind: 'char', set: this.parseClass() };
      case '.':
        this.position += 1;
        return { kind: 'char', set: DOT };
      case '^':
        this.position += 1;
        return { kind: 'assert', assertion: 'start' };
      case '$':
        this.position += 1;
        return { kind: 'assert', assertion: 'end' };
      case '*':
      case '+':
        throw new RegexError(`nothing to repeat before "${char}"`, start);
      case '\\':
        return this.parseEscape();
      default:
        this.position += 1;
        return { kind: 'char', set: literal(char.charCodeAt(0)) };
    }
  }

  /**
   * A group, which is never a capture.
   *
   * `(a)` and `(?:a)` compile to the same automaton because nothing downstream
   * can ask what `(a)` caught. A named group is accepted and its name dropped,
   * so a pattern copied out of somewhere else keeps working.
   */
  private parseGroup(): Node {
    const start = this.position;
    this.position += 1;

    if (this.source.startsWith('?:', this.position)) {
      this.position += 2;
    } else if (this.peek() === '?') {
      const named = /^\?<([A-Za-z_$][\w$]*)>/.exec(this.source.slice(this.position));
      if (named) {
        this.position += (named[0] as string).length;
      } else if (/^\?(?:=|!|<=|<!)/.test(this.source.slice(this.position))) {
        throw new RegexError(
          'lookaround is not supported: an automaton that cannot backtrack cannot look ahead - use ^= $= or *= for a fixed prefix, suffix or substring',
          start,
        );
      } else {
        throw new RegexError('unsupported group: expected (?:...) or (?<name>...)', start);
      }
    }

    const inner = this.parseAlternation();
    if (this.peek() !== ')') throw new RegexError('unmatched "("', start);
    this.position += 1;
    return inner;
  }

  /**
   * Reads a `[...]` class.
   *
   * `[]` matches nothing and `[^]` matches anything, which reads like a mistake
   * and is what every JavaScript engine does: the class ends at the first `]`,
   * even when that `]` is the first character inside it.
   */
  private parseClass(): CharSet {
    const start = this.position;
    this.position += 1;
    const negated = this.peek() === '^';
    if (negated) this.position += 1;

    const ranges: Range[] = [];
    while (this.position < this.source.length && this.peek() !== ']') {
      const low = this.parseClassAtom();
      // A `-` between two single characters is a range. Anywhere else - at
      // either end of the class, or beside a `\d`-style set, which has no
      // endpoint - it is a literal hyphen, exactly as Annex B has it.
      if (this.peek() !== '-' || this.source[this.position + 1] === ']' || this.position + 1 >= this.source.length) {
        push(ranges, low);
        continue;
      }
      const dash = this.position;
      this.position += 1;
      const high = this.parseClassAtom();
      if (typeof low === 'number' && typeof high === 'number') {
        if (low > high) throw new RegexError('characters out of order in a character class', dash);
        ranges.push([low, high]);
        continue;
      }
      push(ranges, low);
      ranges.push([0x2d, 0x2d]);
      push(ranges, high);
    }

    if (this.peek() !== ']') throw new RegexError('unterminated character class', start);
    this.position += 1;
    return { negated, ranges };
  }

  /** One member of a class: a code unit, or a whole set for `\d` and its kind. */
  private parseClassAtom(): number | readonly Range[] {
    if (this.peek() !== '\\') {
      const code = (this.peek() as string).charCodeAt(0);
      this.position += 1;
      return code;
    }
    // `\b` is a backspace inside a class and a word boundary outside one, which
    // is the only place the two readings of an escape diverge.
    if (this.source[this.position + 1] === 'b') {
      this.position += 2;
      return 0x08;
    }
    if (this.source[this.position + 1] === 'B') {
      throw new RegexError('"\\B" is an assertion, not a character, so it cannot be in a class', this.position);
    }
    const set = this.parseCharacterEscape();
    if (!set.negated && set.ranges.length === 1) {
      const [low, high] = set.ranges[0] as Range;
      if (low === high) return low;
    }
    return set.negated ? invert(set.ranges) : set.ranges;
  }

  /** An escape outside a class, where `\b` and `\B` are assertions. */
  private parseEscape(): Node {
    const next = this.source[this.position + 1];
    if (next === 'b' || next === 'B') {
      this.position += 2;
      return { kind: 'assert', assertion: next === 'b' ? 'word-boundary' : 'not-word-boundary' };
    }
    return { kind: 'char', set: this.parseCharacterEscape() };
  }

  /** Every escape that stands for a character or a set of them. */
  private parseCharacterEscape(): CharSet {
    const start = this.position;
    this.position += 1;
    const char = this.peek();
    if (char === undefined) throw new RegexError('pattern ends with a backslash', start);
    this.position += 1;

    switch (char) {
      case 'd':
        return { negated: false, ranges: DIGIT };
      case 'D':
        return { negated: true, ranges: DIGIT };
      case 'w':
        return { negated: false, ranges: WORD };
      case 'W':
        return { negated: true, ranges: WORD };
      case 's':
        return { negated: false, ranges: SPACE };
      case 'S':
        return { negated: true, ranges: SPACE };
      case 'n':
        return literal(0x0a);
      case 'r':
        return literal(0x0d);
      case 't':
        return literal(0x09);
      case 'f':
        return literal(0x0c);
      case 'v':
        return literal(0x0b);
      case '0':
        if (/^\d/.test(this.source.slice(this.position))) {
          throw new RegexError('an octal escape is not supported - write \\xHH or \\uHHHH', start);
        }
        return literal(0);
      case 'x':
        return literal(this.readHex(2, start));
      case 'u':
        return literal(this.readHex(4, start));
      case 'c': {
        const letter = this.peek();
        if (letter === undefined || !/[A-Za-z]/.test(letter)) {
          throw new RegexError('expected a letter after "\\c"', start);
        }
        this.position += 1;
        return literal(letter.charCodeAt(0) % 32);
      }
      case 'k':
        throw new RegexError(
          'a named backreference is not supported: a backreference is not a regular expression, and this is an automaton',
          start,
        );
      case 'p':
      case 'P':
        throw new RegexError(
          `"\\${char}" needs a table of Unicode properties, which this matcher does not carry - write the characters out as a [class]`,
          start,
        );
      default:
        if (/[1-9]/.test(char)) {
          throw new RegexError(
            'a backreference is not supported: it is not a regular expression, and this is an automaton',
            start,
          );
        }
        if (/[A-Za-z]/.test(char)) {
          // `RegExp` reads an unknown letter escape as the letter itself, so
          // `\A` quietly matches a capital A and `\z` a lower-case z. Saying so
          // is worth more than agreeing with a rule nobody wanted.
          throw new RegexError(`unknown escape "\\${char}"`, start);
        }
        return literal(char.charCodeAt(0));
    }
  }

  private readHex(digits: number, start: number): number {
    const raw = this.source.slice(this.position, this.position + digits);
    if (raw.length !== digits || !/^[0-9a-fA-F]+$/.test(raw)) {
      throw new RegexError(`expected ${digits} hex digits after "\\${this.source[start + 1] as string}"`, start);
    }
    this.position += digits;
    return Number.parseInt(raw, 16);
  }

  private peek(): string | undefined {
    return this.source[this.position];
  }
}

function literal(code: number): CharSet {
  return { negated: false, ranges: [[code, code]] };
}

function push(ranges: Range[], atom: number | readonly Range[]): void {
  if (typeof atom === 'number') ranges.push([atom, atom]);
  else ranges.push(...atom);
}

/**
 * Complement of a range list, so `[\D]` can sit inside a class.
 *
 * A negated escape is a set with no endpoints, and a class is a union of
 * ranges, so the only way to put one inside the other is to spell out what it
 * leaves.
 */
function invert(ranges: readonly Range[]): readonly Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let cursor = 0;
  for (const [low, high] of sorted) {
    if (low > cursor) out.push([cursor, low - 1]);
    cursor = Math.max(cursor, high + 1);
  }
  if (cursor <= 0xffff) out.push([cursor, 0xffff]);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

interface Split {
  readonly op: 'split';
  /** Where the first branch starts. */
  x: number;
  /** Where the second branch starts. */
  y: number;
}

interface Jump {
  readonly op: 'jump';
  to: number;
}

type Instruction =
  | { readonly op: 'char'; readonly set: CharSet }
  | Split
  | Jump
  | { readonly op: 'assert'; readonly assertion: Assertion }
  | { readonly op: 'match' };

class Compiler {
  readonly code: Instruction[] = [];

  private add<T extends Instruction>(instruction: T): T {
    if (this.code.length >= MAX_PROGRAM) {
      throw new RegexError(
        `pattern is too large: counted repetition is compiled by copying, and this needs more than ${MAX_PROGRAM} states`,
        0,
      );
    }
    this.code.push(instruction);
    return instruction;
  }

  get here(): number {
    return this.code.length;
  }

  emitMatch(): void {
    this.add({ op: 'match' });
  }

  compile(node: Node): void {
    switch (node.kind) {
      case 'empty':
        return;
      case 'char':
        this.add({ op: 'char', set: node.set });
        return;
      case 'assert':
        this.add({ op: 'assert', assertion: node.assertion });
        return;
      case 'concat':
        for (const part of node.parts) this.compile(part);
        return;
      case 'alternate': {
        // One split per option but the last. Each split falls through to its
        // own branch and points its second arm at the next split; each branch
        // ends in a jump past all of them.
        const ends: Jump[] = [];
        for (let i = 0; i < node.options.length - 1; i += 1) {
          const split = this.add({ op: 'split', x: 0, y: 0 });
          split.x = this.here;
          this.compile(node.options[i] as Node);
          ends.push(this.add({ op: 'jump', to: 0 }));
          split.y = this.here;
        }
        this.compile(node.options[node.options.length - 1] as Node);
        for (const end of ends) end.to = this.here;
        return;
      }
      case 'repeat':
        this.repeat(node.node, node.min, node.max);
        return;
    }
  }

  private repeat(node: Node, min: number, max: number): void {
    for (let i = 0; i < min; i += 1) this.compile(node);

    if (max === Infinity) {
      const split = this.add({ op: 'split', x: 0, y: 0 });
      const body = this.here;
      split.x = body;
      this.compile(node);
      this.add({ op: 'jump', to: body - 1 });
      split.y = this.here;
      return;
    }

    // `{2,5}` is two copies and then three optional ones, each able to leave
    // for the far end rather than for the next copy.
    const exits: Split[] = [];
    for (let i = min; i < max; i += 1) {
      const split = this.add({ op: 'split', x: 0, y: 0 });
      split.x = this.here;
      exits.push(split);
      this.compile(node);
    }
    for (const split of exits) split.y = this.here;
  }
}

/* -------------------------------------------------------------------------- */
/* Simulation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A compiled pattern. Reusable and safe to cache.
 *
 * Not reentrant, which nothing can ask of it: `test` is synchronous and calls
 * out to nothing, and the buffers it keeps between subjects are what make it
 * cheap enough to run against every path a walk visits.
 */
export interface RegexMatcher {
  /** True when the pattern matches anywhere in the subject. */
  test(subject: string): boolean;
  /** State count. Published for the size test, and for nothing else. */
  readonly size: number;
}

export interface RegexOptions {
  /** Fold case the way the `i` flag does. On unless set to `false`. */
  readonly ignoreCase?: boolean | undefined;
}

/**
 * Compiles a pattern into a matcher.
 *
 * Throws {@link RegexError} on anything it cannot run in linear time, which
 * is the point: the alternative to a message here is a build that stops.
 */
export function compileRegex(source: string, options: RegexOptions = {}): RegexMatcher {
  const tree = new PatternParser(source).parse();
  const compiler = new Compiler();
  compiler.compile(tree);
  compiler.emitMatch();
  // A pattern that begins by asserting the start of the subject cannot match
  // anywhere else, so the simulation stops seeding new threads at every
  // position. Nothing depends on this being noticed - it is the difference
  // between one pass and two over a long body.
  const machine = new Machine(compiler.code, startsAnchored(tree), options.ignoreCase !== false);
  return {
    size: compiler.code.length,
    test: (subject: string): boolean => machine.test(subject),
  };
}

/** True when every path through the pattern opens by asserting the start. */
function startsAnchored(node: Node): boolean {
  switch (node.kind) {
    case 'assert':
      return node.assertion === 'start';
    case 'concat': {
      const first = node.parts[0];
      return first !== undefined && startsAnchored(first);
    }
    case 'alternate':
      return node.options.every((option) => startsAnchored(option));
    case 'repeat':
      return node.min > 0 && startsAnchored(node.node);
    default:
      return false;
  }
}

const OP_CHAR = 0;
const OP_SPLIT = 1;
const OP_JUMP = 2;
const OP_ASSERT = 3;
const OP_MATCH = 4;

/** Fills the slots of states that are not characters, where nothing reads it. */
const NOTHING: CharSet = { negated: false, ranges: [] };

/**
 * The simulation, over the program flattened into typed arrays.
 *
 * The compiler's instructions are objects of five shapes, and one loop reading
 * `op` off all five is a megamorphic property read on every step. Simulated that
 * way, with a fresh visited table per subject, a glob cost about 3.5
 * microseconds a path and a path that failed on its first character still paid
 * half a microsecond for the allocation. Flat arrays and buffers kept between
 * subjects bring those to 0.6 and 0.04 - `RegExp` takes 0.06 - which matters
 * because a walk tests every path it visits against every pattern.
 */
class Machine {
  private readonly ops: Uint8Array;
  /** A split's first branch, or a jump's target. */
  private readonly first: Int32Array;
  /** A split's second branch. */
  private readonly second: Int32Array;
  private readonly sets: CharSet[];
  private readonly assertions: Assertion[];
  private readonly anchored: boolean;
  private readonly ignoreCase: boolean;

  /**
   * The position each state was last reached at. One visit per state per
   * position is exactly what turns the exponent into a product.
   */
  private readonly visited: Int32Array;
  /** Each visit pushes at most two states, so this cannot overflow. */
  private readonly stack: Int32Array;
  private live: Int32Array;
  private next: Int32Array;

  constructor(code: readonly Instruction[], anchored: boolean, ignoreCase: boolean) {
    const size = code.length;
    this.ops = new Uint8Array(size);
    this.first = new Int32Array(size);
    this.second = new Int32Array(size);
    this.sets = new Array<CharSet>(size).fill(NOTHING);
    this.assertions = new Array<Assertion>(size).fill('start');
    this.anchored = anchored;
    this.ignoreCase = ignoreCase;
    this.visited = new Int32Array(size).fill(-1);
    this.stack = new Int32Array(2 * size + 1);
    this.live = new Int32Array(size);
    this.next = new Int32Array(size);

    code.forEach((instruction, pc) => {
      switch (instruction.op) {
        case 'char':
          this.ops[pc] = OP_CHAR;
          this.sets[pc] = instruction.set;
          break;
        case 'split':
          this.ops[pc] = OP_SPLIT;
          this.first[pc] = instruction.x;
          this.second[pc] = instruction.y;
          break;
        case 'jump':
          this.ops[pc] = OP_JUMP;
          this.first[pc] = instruction.to;
          break;
        case 'assert':
          this.ops[pc] = OP_ASSERT;
          this.assertions[pc] = instruction.assertion;
          break;
        case 'match':
          this.ops[pc] = OP_MATCH;
          break;
      }
    });
  }

  test(subject: string): boolean {
    const length = subject.length;
    this.visited.fill(-1);

    let live = this.live;
    let next = this.next;
    let alive = 0;

    for (let position = 0; position <= length; position += 1) {
      if (position === 0 || !this.anchored) {
        alive = this.seed(live, alive, 0, subject, position);
        if (alive < 0) return true;
      } else if (alive === 0) {
        // An anchored pattern gets one chance, and every thread from it has died.
        return false;
      }

      if (position === length) return false;
      const char = subject.charCodeAt(position);
      let arriving = 0;
      for (let i = 0; i < alive; i += 1) {
        const pc = live[i] as number;
        const set = this.sets[pc] as CharSet;
        if (!(this.ignoreCase ? accepts(set, char) : acceptsExactly(set, char))) continue;
        arriving = this.seed(next, arriving, pc + 1, subject, position + 1);
        if (arriving < 0) return true;
      }
      const spent = live;
      live = next;
      next = spent;
      alive = arriving;
    }

    return false;
  }

  /**
   * Follows every zero-width transition out of one state, appending the
   * character states it reaches to `list`.
   *
   * Returns the new length of the list, or -1 the moment a thread reaches the
   * end of the pattern: the only question is whether a match exists, so there
   * is no leftmost-longest to settle and no captures to keep, and the first
   * thread to arrive is the answer.
   *
   * A stray thread at state 0 changes no answer: an unanchored pattern seeds it
   * at every position anyway, and an anchored one opens by asserting the start.
   * That makes two mutants here equivalent, with no test to write - the loop
   * running once past an empty stack, and a jump read as a split, both of which
   * add exactly that thread.
   */
  private seed(list: Int32Array, length: number, start: number, subject: string, position: number): number {
    const { ops, first, second, visited, stack } = this;
    let count = length;
    let top = 0;
    stack[top++] = start;
    while (top > 0) {
      const pc = stack[--top] as number;
      if (visited[pc] === position) continue;
      visited[pc] = position;
      switch (ops[pc]) {
        case OP_MATCH:
          return -1;
        case OP_JUMP:
          stack[top++] = first[pc] as number;
          break;
        case OP_SPLIT:
          stack[top++] = second[pc] as number;
          stack[top++] = first[pc] as number;
          break;
        case OP_ASSERT:
          if (holds(this.assertions[pc] as Assertion, subject, position)) stack[top++] = pc + 1;
          break;
        default:
          list[count++] = pc;
      }
    }
    return count;
  }
}

function holds(assertion: Assertion, subject: string, position: number): boolean {
  switch (assertion) {
    case 'start':
      return position === 0;
    case 'end':
      return position === subject.length;
    default: {
      const before = position > 0 && isWordChar(subject.charCodeAt(position - 1));
      const after = position < subject.length && isWordChar(subject.charCodeAt(position));
      return (before !== after) === (assertion === 'word-boundary');
    }
  }
}
