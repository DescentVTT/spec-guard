/**
 * Globs, in the three dialects the spec-* tools speak, compiled to one kind of
 * automaton.
 *
 * The syntax is the part people type: `*`, `**`, `?`, `[abc]`, `[!a-z]`,
 * `{a,b}`, and `\` to escape. What differs between the tools is not the
 * syntax but what a pattern is matched against, and those differences are
 * deliberate, so each has a name (docs/adr/0003-glob-dialects.md):
 *
 * - `path` - the whole repository-relative path, anchored at the root. A
 *   pattern with no glob syntax names a file, a directory, or either, as the
 *   caller says; `src/auth` may cover `src/auth/login.ts`.
 * - `ripgrep` - as ripgrep's `-g`: a pattern with no `/` is matched against
 *   the last segment at any depth, so `*.ts` matches `src/deep/a.ts`; one with
 *   a `/` is matched against the whole path.
 * - `gitignore` - as an exclusion list reads: a pattern matches a path or any
 *   directory above it, so `tests` excludes everything under any `tests`; one
 *   with a `/` other than a trailing one is anchored at the root, and a
 *   leading `/` only anchors.
 *
 * Shared by all three:
 *
 * - `**` is a globstar only as a whole segment. `a/**\/b` matches `a/b` and
 *   `a/x/y/b`; a trailing `/**` matches everything inside a directory and not
 *   the directory itself. Two stars inside a name, `**.md`, are refused: the
 *   tools read it three ways, and the quiet reading narrowed their scope. The
 *   refusal writes the two patterns it may have meant from the one written.
 * - `*`, `?` and classes never match `/`, and `*` matches a leading dot.
 * - Braces expand first, and each alternative reads as it would written on
 *   its own: `{src/,lib}` is `src/` or `lib`, and a trailing `/` means the
 *   directory's contents - in an exclusion, the directory and its contents.
 *   One that names no path, `{./,lib}` or `{,lib}`, is refused, as `./` and
 *   the empty pattern are.
 * - Case is the caller's decision, stated every time. A result must not
 *   depend on the host it ran on.
 * - A malformed pattern is an error, never a literal. An unclosed `[` or `{`,
 *   an extended glob, a `..` - each is refused with a reason, because a typo
 *   read as a literal is a scope that silently matches nothing. An extended
 *   glob is a group holding a `|`, `+(a|b)`: without one, `C++(notes).md` is
 *   a name with parentheses in it, as ripgrep and `.gitignore` read it.
 */

import {
  AutomatonTooLarge,
  Builder,
  findWitness,
  Matcher,
  WITNESS_BUDGET,
  type Automaton,
  type Fragment,
  type Witness,
} from './automaton.js';
import { ANY, classSet, literalSet, SEPARATOR, type CodeRange } from './charset.js';

export type GlobDialect = 'path' | 'ripgrep' | 'gitignore';

/** How a `path` pattern with no glob syntax is read. */
export type LiteralReading = 'file' | 'directory' | 'either';

export interface GlobOptions {
  readonly dialect: GlobDialect;
  /** Whether `A` and `a` differ. No default: the caller decides, every time. */
  readonly caseSensitive: boolean;
  /**
   * `path` dialect only: how a pattern with no glob syntax is read - as a
   * file, as a directory and everything beneath it, or as either. A function
   * is asked per literal path, for a caller that knows the tree. `either` when
   * unset. A trailing `/`, on the pattern or on one of its brace alternatives,
   * always means a directory's contents, and is never asked about.
   */
  readonly literal?: LiteralReading | ((path: string) => LiteralReading) | undefined;
  /**
   * `escape` (the default): `\` escapes the next character, and a `\` before a
   * letter or digit is refused as a Windows separator typed by mistake.
   * `separator`: every `\` is a `/`, for patterns typed on a Windows shell.
   */
  readonly backslash?: 'escape' | 'separator' | undefined;
}

export interface Glob {
  readonly source: string;
  readonly dialect: GlobDialect;
  readonly caseSensitive: boolean;
  /**
   * The directories a walk must enter to find every match: one per
   * alternative, the leading literal segments. `''` for an alternative that
   * can match at any depth.
   */
  readonly bases: readonly string[];
  readonly automaton: Automaton;
  /** Whether a canonical path - POSIX, no `.`, no empty or trailing segment - matches. */
  match(path: string): boolean;
}

export type GlobParse = { readonly ok: true; readonly glob: Glob } | { readonly ok: false; readonly error: string };

export class GlobError extends Error {
  readonly source: string;
  constructor(source: string, reason: string) {
    super(`invalid glob "${source}": ${reason}`);
    this.name = 'GlobError';
    this.source = source;
  }
}

/** More alternatives than this is a pattern nobody meant. */
export const MAX_ALTERNATIVES = 256;

type Token =
  | { readonly kind: 'literal'; readonly point: number }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: readonly CodeRange[] };

type Segment = { readonly kind: 'globstar' } | { readonly kind: 'name'; readonly tokens: readonly Token[] };

interface Alternative {
  readonly segments: readonly Segment[];
  /** Written with a `/` somewhere other than at its end. */
  readonly slashed: boolean;
}

/** Whether a string uses glob syntax at all. */
export function isGlobSyntax(source: string): boolean {
  return /[*?[\]{}]/.test(source);
}

/**
 * Parses and compiles a glob, or says why it cannot: malformed, or too large
 * to compile, past {@link MAX_ALTERNATIVES} alternatives or `MAX_STATES`
 * states. It throws only what a `literal` function throws.
 */
export function parseGlob(source: string, options: GlobOptions): GlobParse {
  const result = build(source, options);
  return typeof result === 'string' ? { ok: false, error: result } : { ok: true, glob: result };
}

/**
 * Parses and compiles a glob, throwing {@link GlobError} for every reason
 * {@link parseGlob} gives, and what a `literal` function throws.
 */
export function compileGlob(source: string, options: GlobOptions): Glob {
  const result = build(source, options);
  if (typeof result === 'string') throw new GlobError(source, result);
  return result;
}

function build(source: string, options: GlobOptions): Glob | string {
  const escapes = options.backslash !== 'separator';
  let pattern = source.trim();
  if (!escapes) pattern = pattern.replace(/\\/g, '/');
  const written = pattern;
  if (pattern.length === 0) return 'the pattern is empty';
  if (pattern.startsWith('!')) return 'a negated pattern is a list entry, not a glob; narrow the positive pattern';
  if (/(?:^|[^\\])[?*+@!]\([^)]*\|/.test(pattern)) return EXTGLOB;
  while (pattern.startsWith('./')) pattern = pattern.slice(2);

  // A leading slash roots a pattern at the filesystem's root in the path and
  // ripgrep dialects, and only anchors it at the repository root in gitignore.
  let rooted = false;
  let anchored = false;
  if (pattern.startsWith('/')) {
    if (options.dialect === 'gitignore') anchored = true;
    else rooted = true;
    pattern = pattern.replace(/^\/+/, '');
  }
  if (pattern.length === 0) return 'the pattern names the root itself, not a path under it';

  const expanded = expandBraces(pattern, escapes);
  if (typeof expanded === 'string') return expanded;

  const alternatives: Alternative[] = [];
  for (const text of expanded) {
    // Refused before its trailing slash is read, which would make `./` the
    // contents of `.`, every path: `{./,a}` is refused as `./` alone is.
    // Each text the braces give is shorter than the pattern, so only a
    // pattern without braces is its own text.
    if (namesNoPath(text)) return text === pattern ? 'the pattern names no path' : bracesNamingNoPath(text);
    const parsed = parseAlternative(trailingSlash(text, options.dialect), escapes);
    if (parsed === GLOBSTAR_IN_NAME) return `${GLOBSTAR_IN_NAME}: ${globstarAdvice(written)}`;
    if (typeof parsed === 'string') return parsed;
    alternatives.push(parsed);
  }

  const builder = new Builder();
  const fragments: Fragment[] = [];
  const bases: string[] = [];
  let automaton: Automaton;
  try {
    for (const alternative of alternatives) {
      const compiled = compileAlternative(builder, alternative, options, rooted, anchored);
      fragments.push(compiled.fragment);
      bases.push(compiled.base);
    }
    automaton = builder.finish(builder.either(fragments), options.caseSensitive);
  } catch (error) {
    // A pattern too large to compile is refused with a reason, as a malformed
    // one is. Anything else - a caller's literal reading that throws - is the
    // caller's failure, not the pattern's, and goes on up.
    if (error instanceof AutomatonTooLarge) return error.message;
    throw error;
  }
  let matcher: Matcher | null = null;
  return {
    source,
    dialect: options.dialect,
    caseSensitive: options.caseSensitive,
    bases: [...new Set(bases)],
    automaton,
    match(path: string): boolean {
      matcher ??= new Matcher(automaton);
      return matcher.test(path);
    },
  };
}

/* ------------------------------------------------------------------ braces */

/**
 * Expands `{a,b}` groups into the patterns they stand for, or says why the
 * pattern is malformed.
 *
 * Classes and escapes are skipped while looking for braces and commas, so
 * `{[,]x,y}` is two alternatives, `[,]x` and `y`. A lone `}` is a literal: it
 * cannot be read as anything else. An unclosed `{` is an error.
 *
 * Here and in the two functions after it, a loop that reads one step past
 * the end reads `''`, which none of them acts on, and `classEnd` answers -1
 * or an index past the `[`, so `close > 0` and `close >= 0` read the same.
 * `open` is set by the `{` that any `}` read here closes, so its first value
 * is never read.
 */
function expandBraces(pattern: string, escapes: boolean): string[] | string {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\' && escapes) {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = classEnd(pattern, i, escapes);
      if (close > 0) i = close;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) open = i;
      depth += 1;
      continue;
    }
    if (ch !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth > 0) continue;
    const prefix = pattern.slice(0, open);
    const suffix = pattern.slice(i + 1);
    const results: string[] = [];
    for (const option of splitOptions(pattern.slice(open + 1, i), escapes)) {
      const expanded = expandBraces(`${prefix}${option}${suffix}`, escapes);
      if (typeof expanded === 'string') return expanded;
      results.push(...expanded);
      if (results.length > MAX_ALTERNATIVES) return `the braces expand to more than ${MAX_ALTERNATIVES} patterns`;
    }
    return results;
  }
  if (depth > 0) return 'a "{" is never closed';
  return [pattern];
}

/** Splits a brace body on its top-level commas. */
function splitOptions(body: string, escapes: boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '\\' && escapes) {
      i += 1;
    } else if (ch === '[') {
      const close = classEnd(body, i, escapes);
      if (close > 0) i = close;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The index of the `]` closing a class opened at `open`, or -1 when none does within the segment. */
function classEnd(pattern: string, open: number, escapes: boolean): number {
  let i = open + 1;
  if (pattern.charAt(i) === '!' || pattern.charAt(i) === '^') i += 1;
  // The first member is always a member, even `]`.
  if (pattern.charAt(i) === ']') i += 1;
  for (; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\' && escapes) {
      i += 1;
      continue;
    }
    if (ch === '/') return -1;
    if (ch === ']') return i;
  }
  return -1;
}

/* ---------------------------------------------------------------- segments */

/** Whether a pattern's text names no path: nothing in it but `/` and `.` segments. */
function namesNoPath(text: string): boolean {
  return text.split('/').every((part) => part === '' || part === '.');
}

/**
 * The refusal of an alternative the braces give that names no path, naming
 * it as it was expanded, so that `.{/,a}` is told `./`, the text refused.
 */
function bracesNamingNoPath(text: string): string {
  return text === '' ? 'the braces expand to an empty pattern' : `the braces expand to "${text}", which names no path`;
}

/**
 * What a trailing slash means, read on each alternative the braces give, so
 * that `{src/,lib}` reads `src/` as `src/` alone reads: the directory's
 * contents, `src/**`, and not a literal that may be the directory itself.
 *
 * In an exclusion `build/` excludes what `build` does. Git's rule is that a
 * trailing slash matches only a directory, and a directory is excluded with
 * everything in it; a matcher that sees only a path cannot tell a directory
 * from a file, so the slash is dropped, and it anchors nothing.
 *
 * Only ever given a text that names a path, so a name is left. The whole run
 * of slashes is taken, but one slash would read the same, since
 * `parseAlternative` drops the empty segments the rest leave; and taken
 * lazily it is the whole run all the same, since it ends the text.
 */
function trailingSlash(text: string, dialect: GlobDialect): string {
  const name = text.replace(/\/+$/, '');
  return name === text || dialect === 'gitignore' ? name : `${name}/**`;
}

/**
 * The segments of a text that names a path - `build` refuses one that does
 * not - so at least one segment is left.
 */
function parseAlternative(text: string, escapes: boolean): Alternative | string {
  const segments: Segment[] = [];
  const raw = text.split('/');
  for (const part of raw) {
    if (part === '' || part === '.') continue;
    if (part === '..') return 'a pattern cannot climb out of its root with ".."';
    if (part === '**') {
      if (segments[segments.length - 1]?.kind !== 'globstar') segments.push({ kind: 'globstar' });
      continue;
    }
    const tokens = tokenize(part, escapes);
    if (typeof tokens === 'string') return tokens;
    segments.push({ kind: 'name', tokens });
  }
  return { segments, slashed: raw.filter((part) => part !== '' && part !== '.').length > 1 };
}

const EXTGLOB = 'extended globs such as "+(a|b)" are not supported: write alternatives as "{a,b}", and a literal parenthesis as "[(]"';
const GLOBSTAR_IN_NAME = '"**" means any number of directories only as a whole segment';

/**
 * The two patterns a writer of `**` inside a name may have meant, built from
 * what they wrote. Each run of stars that is not a whole segment becomes, for
 * any depth, a globstar segment with a star kept on each side where a name
 * went on - `docs/**.md` to `docs/**\/*.md`, `src/a**` to `src/a*\/**`,
 * `a**b` to `a*\/**\/*b` - and for one level a single star. Everything else
 * stays as written, braces and classes included, and a globstar that was a
 * whole segment stays one.
 *
 * Only `/` is taken for a boundary. A run beside a brace, `{**.md,x}`, is
 * given a star on that side too, which keeps the advice a pattern that
 * compiles whatever the braces expand to.
 *
 * `written` holds a `\` only where it escapes: in the `separator` reading
 * each one is already a `/`.
 */
function globstarAdvice(written: string): string {
  let deep = '';
  let flat = '';
  let at = 0;
  // One step past the end reads `''` and appends nothing, so the bound could
  // be one further and give the same advice.
  while (at < written.length) {
    const ch = written.charAt(at);
    let next = at + 1;
    if (ch === '\\') {
      next = at + 2;
    } else if (ch === '[') {
      // A class is copied as written. `classEnd` answers an index past the
      // `[`, or -1 for one never closed, so `close >= 0` reads the same; and
      // stopping one short of the `]` copies the class all the same, since
      // its last member and the `]` after it are never a run of stars.
      const close = classEnd(written, at, true);
      if (close > 0) next = close + 1;
    } else if (ch === '*') {
      while (written.charAt(next) === '*') next += 1;
      const before = at > 0 && written.charAt(at - 1) !== '/';
      const after = next < written.length && written.charAt(next) !== '/';
      if (next - at > 2 || (next - at === 2 && (before || after))) {
        deep += `${before ? '*/' : ''}**${after ? '/*' : ''}`;
        flat += '*';
        at = next;
        continue;
      }
    }
    deep += written.slice(at, next);
    flat += written.slice(at, next);
    at = next;
  }
  return `write "${deep}" for any depth, or "${flat}" for one level`;
}

function tokenize(segment: string, escapes: boolean): Token[] | string {
  const tokens: Token[] = [];
  const chars = Array.from(segment);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (ch === '\\' && escapes) {
      const next = chars[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) {
        return '"\\" escapes glob syntax; separate directories with "/"';
      }
      tokens.push({ kind: 'literal', point: next.codePointAt(0) as number });
      i += 1;
    } else if (ch === '*') {
      // Two stars inside a name are refused rather than read as one. The
      // tools this replaces read `docs/**.md` three ways - recursive, one
      // level, and as ripgrep does - and reading it as one level silently
      // dropped every nested document from a run that used to include them.
      if (chars[i + 1] === '*') return GLOBSTAR_IN_NAME;
      tokens.push({ kind: 'star' });
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
    } else if (ch === '[') {
      const parsed = readClass(chars, i, escapes);
      if (typeof parsed === 'string') return parsed;
      tokens.push(parsed.token);
      i = parsed.end;
    } else {
      tokens.push({ kind: 'literal', point: ch.codePointAt(0) as number });
    }
  }
  return tokens;
}

function readClass(chars: readonly string[], open: number, escapes: boolean): { token: Token; end: number } | string {
  let i = open + 1;
  let negated = false;
  if (chars[i] === '!' || chars[i] === '^') {
    negated = true;
    i += 1;
  }
  const ranges: CodeRange[] = [];
  let first = true;
  for (; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (ch === ']' && !first) return { token: { kind: 'class', negated, ranges }, end: i };
    first = false;
    let low = ch;
    if (ch === '\\' && escapes && chars[i + 1] !== undefined) {
      i += 1;
      low = chars[i] as string;
    }
    let high = low;
    if (chars[i + 1] === '-' && chars[i + 2] !== undefined && chars[i + 2] !== ']') {
      i += 2;
      high = chars[i] as string;
      if (high === '\\' && escapes && chars[i + 1] !== undefined) {
        i += 1;
        high = chars[i] as string;
      }
    }
    const from = low.codePointAt(0) as number;
    const to = high.codePointAt(0) as number;
    if (to < from) return `the range "${low}-${high}" runs backwards`;
    ranges.push([from, to]);
  }
  return 'a "[" is never closed';
}

/* --------------------------------------------------------------- compiling */

function literalText(segments: readonly Segment[]): string | null {
  const names: string[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'name') return null;
    let name = '';
    for (const token of segment.tokens) {
      if (token.kind !== 'literal') return null;
      name += String.fromCodePoint(token.point);
    }
    names.push(name);
  }
  return names.join('/');
}

/** One segment name: at least one character, none of them `/`. */
function name(b: Builder): Fragment {
  return b.plus(b.char(ANY));
}

/** Zero or more whole directories: `(name/)*`. */
function anyDirectories(b: Builder): Fragment {
  return b.star(b.sequence([name(b), b.char(SEPARATOR)]));
}

/** One or more whole segments below a path: `/name(/name)*`. */
function beneath(b: Builder): Fragment {
  return b.sequence([b.char(SEPARATOR), name(b), b.star(b.sequence([b.char(SEPARATOR), name(b)]))]);
}

function tokens(b: Builder, list: readonly Token[]): Fragment {
  return b.sequence(
    list.map((token) => {
      switch (token.kind) {
        case 'literal':
          return b.char(literalSet(token.point));
        case 'any':
          return b.char(ANY);
        case 'star':
          return b.star(b.char(ANY));
        case 'class':
          return b.char(classSet(token.ranges, token.negated));
      }
    }),
  );
}

function segmentsFragment(b: Builder, segments: readonly Segment[]): Fragment {
  const parts: Fragment[] = [];
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment.kind === 'globstar') {
      // Inside a path a globstar is any number of whole directories, the
      // separator after them included; at its end, at least one segment.
      parts.push(last ? b.sequence([name(b), b.star(b.sequence([b.char(SEPARATOR), name(b)]))]) : anyDirectories(b));
      return;
    }
    parts.push(tokens(b, segment.tokens));
    if (!last) parts.push(b.char(SEPARATOR));
  });
  return b.sequence(parts);
}

function compileAlternative(
  b: Builder,
  alternative: Alternative,
  options: GlobOptions,
  rooted: boolean,
  anchored: boolean,
): { fragment: Fragment; base: string } {
  const { segments } = alternative;
  const body = segmentsFragment(b, segments);
  const root = rooted ? '/' : '';
  const literal = literalText(segments);
  const leading = leadingLiteral(segments);

  if (options.dialect === 'gitignore') {
    const floating = !anchored && !alternative.slashed;
    const parts = [body, b.optional(beneath(b))];
    if (floating) parts.unshift(anyDirectories(b));
    const base = literal !== null ? leading.slice(0, -1) : leading;
    return { fragment: b.sequence(parts), base: floating ? '' : base.join('/') };
  }

  if (options.dialect === 'ripgrep' && !rooted && !alternative.slashed) {
    return { fragment: b.sequence([anyDirectories(b), body]), base: '' };
  }

  const parts = rooted ? [b.char(SEPARATOR), body] : [body];
  if (options.dialect === 'path' && literal !== null) {
    const reading = typeof options.literal === 'function' ? options.literal(root + literal) : options.literal ?? 'either';
    if (reading === 'directory') {
      parts.push(beneath(b));
      return { fragment: b.sequence(parts), base: root + literal };
    }
    if (reading === 'either') parts.push(b.optional(beneath(b)));
  }
  // A literal path may be a file, whose base is the directory holding it.
  const base = literal !== null ? leading.slice(0, -1) : leading;
  return { fragment: b.sequence(parts), base: root + base.join('/') };
}

function leadingLiteral(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    const text = literalText([segment]);
    if (text === null) break;
    out.push(text);
  }
  return out;
}

/* ---------------------------------------------------------------- questions */

function assertComparable(globs: readonly Glob[]): void {
  for (const glob of globs) {
    if (!glob.caseSensitive) throw new Error(`"${glob.source}" ignores case; scopes are compared case-sensitively`);
  }
}

/**
 * A shortest path every glob in `include` matches and no glob in `exclude`
 * does: the file two scopes would both write, less what either protects.
 * `none` is a proof that there is no such path. Case-sensitive globs only.
 */
export function globWitness(
  include: readonly Glob[],
  exclude: readonly Glob[] = [],
  budget: number = WITNESS_BUDGET,
): Witness {
  assertComparable([...include, ...exclude]);
  return findWitness(
    include.map((glob) => glob.automaton),
    exclude.map((glob) => glob.automaton),
    budget,
  );
}

/**
 * Whether every path `inner` matches is matched by one of `outer`: `true`,
 * `false`, or `undecided` when the search met its budget.
 */
export function globCovers(
  outer: readonly Glob[],
  inner: Glob,
  budget: number = WITNESS_BUDGET,
): boolean | 'undecided' {
  const witness = globWitness([inner], outer, budget);
  return witness.kind === 'undecided' ? 'undecided' : witness.kind === 'none';
}

/* -------------------------------------------------------------------- lists */

export interface GlobList {
  /** Whether a path is in: the last entry that matches it decides, and a `!` entry takes it out. */
  match(path: string): boolean;
  readonly entries: readonly { readonly negated: boolean; readonly glob: Glob }[];
}

export type GlobListParse = { readonly ok: true; readonly list: GlobList } | { readonly ok: false; readonly error: string };

/**
 * A list of patterns read the way a `.gitignore` reads: in order, each entry
 * deciding the paths it matches, a leading `!` taking them back out.
 */
export function parseGlobList(patterns: readonly string[], options: GlobOptions): GlobListParse {
  const entries: { negated: boolean; glob: Glob }[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    const negated = trimmed.startsWith('!');
    const parsed = parseGlob(negated ? trimmed.slice(1) : trimmed, options);
    if (!parsed.ok) return { ok: false, error: `"${pattern}": ${parsed.error}` };
    entries.push({ negated, glob: parsed.glob });
  }
  return {
    ok: true,
    list: {
      entries,
      match(path: string): boolean {
        let included = false;
        for (const entry of entries) if (entry.glob.match(path)) included = !entry.negated;
        return included;
      },
    },
  };
}
