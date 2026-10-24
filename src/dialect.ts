/**
 * One reading of a regex rule, for both engines. ADR-0007, amended
 * 2026-10-24.
 *
 * ripgrep only names the files the scanner reads, so a file its reading of a
 * pattern leaves out is a file whose matches are never counted, and a rule
 * they would fail passes. ripgrep reads a pattern as the regex crate's
 * documentation says, and JavaScript gave some of the same text another
 * meaning: its `\w`, `\b` and `\d` were ASCII and its `\s` held U+FEFF and not
 * NEL, where the crate's are Unicode's; a character was a UTF-16 unit; and
 * `\A`, `\<` or `[[:alpha:]]` were letters and brackets. So the scanner is
 * given each rule as the crate reads it, in JavaScript's `v` mode, which reads
 * a character as a code point, folds case by Unicode's simple case folding as
 * the crate does, and holds a class inside a class:
 *
 * - `\w`, `\d`, `\s`, their negations, `\b` and `\B` are the crate's Unicode
 *   ones, and so is the boundary `word="true"` puts round a rule;
 * - `^` and `$` meet each line, as ripgrep reads one with `--crlf`;
 * - what the crate reads and JavaScript read otherwise is refused, naming it,
 *   since one engine would count what the other never named;
 * - what JavaScript read without `v` as itself is kept as itself: an escaped
 *   sign, a lone `]`, a `{` or `}` that is no count, and a `-` beside a class
 *   escape in a class. The crate reads each the same, but a `{` and that `-`,
 *   which it refuses, and which the scanner then answers alone;
 * - what only JavaScript reads, a look-around or a back-reference, is the
 *   scanner's alone, as before: ripgrep refuses the pattern, and the scanner
 *   answers the search.
 */

/**
 * The regex crate's `\w`: `\p{Alphabetic}`, `\p{M}`, `\d`, `\p{Pc}` and
 * `\p{Join_Control}`, as its documentation lists them (regex 1.13.1, read
 * 2026-10-24). JavaScript's is `[A-Za-z0-9_]`, and a literal's word boundary
 * here was `\p{L}`, `\p{N}` and `_`, which holds no mark and no ZWJ.
 */
export const WORD_CHARACTER = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;

const NOT_WORD_CHARACTER = `[^${WORD_CHARACTER.slice(1)}`;

/** The crate's `\d`, `\s`, `\w` and their negations, each of which stands in a class as well as outside one. */
const CLASS_ESCAPES: Readonly<Record<string, string>> = {
  d: String.raw`\p{Nd}`,
  D: String.raw`\P{Nd}`,
  s: String.raw`\p{White_Space}`,
  S: String.raw`\P{White_Space}`,
  w: WORD_CHARACTER,
  W: NOT_WORD_CHARACTER,
};

/**
 * A word character on one side and none on the other, the start and the end
 * of the text standing for none, as the crate's `\b` reads.
 */
const BOUNDARY = `(?:(?<=${WORD_CHARACTER})(?!${WORD_CHARACTER})|(?<!${WORD_CHARACTER})(?=${WORD_CHARACTER}))`;
const NOT_BOUNDARY = `(?:(?<=${WORD_CHARACTER})(?=${WORD_CHARACTER})|(?<!${WORD_CHARACTER})(?!${WORD_CHARACTER}))`;

/**
 * U+2028 and U+2029, at which JavaScript's `m` ends a line and ripgrep
 * does not. Made from their numbers, so that no separator stands in this file
 * where an editor would show a line break.
 */
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);

/**
 * `^` and `$` as ripgrep reads them with `--crlf`: at the start and at the
 * end of each line, a line ending at LF, at CRLF or at a lone CR, with no line
 * after the last line end. JavaScript's `m` reads three lines more, and each
 * is taken back out: one between the CR and the LF of a CRLF, one after the
 * last line end (and so in an empty file), and a line end at each separator.
 * With `m` alone `\s+$` matched on every line of a CRLF file and on the
 * last of every file, `^` met each CRLF line twice, and a line begun at a
 * separator was counted in a file ripgrep never named. ADR-0007, amended
 * 2026-10-19.
 */
const LINE_START = `(?:^(?<![${SEPARATORS}])(?!(?<=\\r)\\n)(?=[\\s\\S]))`;
const LINE_END = `(?:$(?![${SEPARATORS}])(?!(?<=\\r)\\n)(?!(?<![^\\n\\r])(?![\\s\\S])))`;

/** What the crate reads in an escape that JavaScript read as the letter or the sign itself. */
const RIPGREP_ESCAPES: Readonly<Record<string, string>> = {
  A: 'the start of the text',
  z: 'the end of the text',
  '<': 'the start of a word',
  '>': 'the end of a word',
  a: 'a bell, U+0007',
  U: 'a code point in eight hex digits',
};

/** A count JavaScript reads after an atom: `{n}`, `{n,}` or `{n,m}`. */
const COUNT = /\{\d+(?:,\d*)?\}/y;

/**
 * A count with blanks in it, `{2, 3}`, which ripgrep 15.0.0 reads as a count
 * (measured; its documentation does not say) and JavaScript as characters.
 */
const BLANK_COUNT = /\{\s*\d+\s*(?:,\s*\d*\s*)?\}/y;

/**
 * An escape that holds a name or a number between brackets: `\p{...}`,
 * `\P{...}`, `\u{...}` and `\k<...>`. Read as a match of its own, so that no
 * reading of a rule steps back. One left open is read a character at a time,
 * and `v` mode refuses it in the words it has for it read whole.
 */
const NAMED = /\\[pPu]\{[^}]*\}|\\k<[^>]*>/y;

/** A group's name, which may hold a `$`; one left open is read as `NAMED` reads one. */
const GROUP_NAME = /\(\?<(?![=!])[^>]*>/y;

function refuse(source: string, reason: string): never {
  throw new SyntaxError(`Invalid regular expression: /${source}/: ${reason}`);
}

/**
 * ASCII that is neither a letter nor a digit, which the crate reads as itself
 * after a backslash, `<` and `>` aside, and which `v` mode reads as itself
 * written as a hex escape, in a class and outside one.
 */
function isAsciiSign(char: string): boolean {
  return char.charCodeAt(0) < 0x80 && !/[0-9A-Za-z]/.test(char);
}

function hex(char: string): string {
  return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

interface Piece {
  /** The piece as `v` mode reads it. */
  text: string;
  /** How many characters of the rule it stands for. */
  length: number;
  /** Whether it stands for a class of characters, which no range can end at. */
  set: boolean;
}

/** The escape that starts at `at`, which is a backslash. */
function escapeAt(source: string, at: number, inClass: boolean): Piece {
  const next = source.charAt(at + 1);
  const known = CLASS_ESCAPES[next];
  if (known !== undefined) return { text: known, length: 2, set: true };
  const ripgrep = RIPGREP_ESCAPES[next];
  // In a class the crate refuses a `\<`, a `\A` and a `\z`, and the scanner
  // answers as JavaScript reads it, which `v` mode accepts or refuses itself.
  if (ripgrep !== undefined && (!inClass || next === 'a' || next === 'U')) {
    refuse(source, `"\\${next}" is ${ripgrep} to ripgrep and "${next}" to JavaScript`);
  }
  const after = source.charAt(at + 2);
  if (next === 'b' || next === 'B') {
    if (inClass) return { text: next === 'b' ? '\\x08' : '\\B', length: 2, set: false };
    if (next === 'b' && after === '{') refuse(source, '"\\b{" is a word boundary of the kind its braces name to ripgrep, and a word boundary before a "{" to JavaScript');
    return { text: next === 'b' ? BOUNDARY : NOT_BOUNDARY, length: 2, set: false };
  }
  if ((next === 'p' || next === 'P') && after !== '{') {
    refuse(source, `"\\${next}${after}" is a class of characters to ripgrep and "${next}${after}" to JavaScript`);
  }
  if (next === 'x' && after === '{') refuse(source, '"\\x{" is the code point its braces hold to ripgrep, and an "x" and braces to JavaScript');
  // No sign between the brackets is the class's or the rule's own. `v` mode
  // refuses a `\k<...>` in a class, read whole or not.
  NAMED.lastIndex = at;
  const named = NAMED.exec(source);
  if (named !== null) return { text: named[0], length: named[0].length, set: next !== 'u' };
  if (isAsciiSign(next)) return { text: hex(next), length: 2, set: false };
  // A letter, a digit, any other character, or nothing: `v` mode reads it as
  // JavaScript reads it, or refuses it, as it refuses a trailing backslash.
  // Two on from a trailing backslash is past the end, where every reading
  // here stops.
  return { text: source.slice(at, at + 2), length: 2, set: false };
}

/** The class that starts at `at`, which is a `[`, and whether it is `[]` or `[^]`, which the crate does not close where JavaScript does. */
function classAt(source: string, at: number): { text: string; length: number; empty: boolean } {
  let i = at + 1;
  const negated = source.charAt(i) === '^';
  if (negated) i += 1;
  if (source.charAt(i) === ']') return { text: source.slice(at, i + 1), length: i + 1 - at, empty: true };
  const atoms: Array<{ text: string; set: boolean; dash: boolean }> = [];
  while (i < source.length && source.charAt(i) !== ']') {
    const pair = source.slice(i, i + 2);
    if (pair === '&&' || pair === '--' || pair === '~~') {
      refuse(source, `"${pair}" in a class is an operation on two classes to ripgrep and two characters to JavaScript`);
    }
    const char = source.charAt(i);
    if (char === '[') refuse(source, '"[" in a class is a class inside it to ripgrep, as in [[:alpha:]], and a "[" to JavaScript');
    if (char === '\\') {
      const escape = escapeAt(source, i, true);
      atoms.push({ text: escape.text, set: escape.set, dash: false });
      i += escape.length;
      continue;
    }
    const point = String.fromCodePoint(source.codePointAt(i)!);
    atoms.push({ text: isAsciiSign(point) ? hex(point) : point, set: false, dash: point === '-' });
    i += point.length;
  }
  // A `-` between two characters is a range to both. Beside a class escape,
  // or after a range, JavaScript read it as itself. Two in a row are refused
  // above, so neither end of a range is a `-` that could start another.
  let body = '';
  for (let k = 0; k < atoms.length; k += 1) {
    const atom = atoms[k]!;
    const end = atoms[k + 2];
    const ranged = !atom.set && atoms[k + 1]?.dash === true && end !== undefined && !end.set;
    body += ranged ? `${atom.text}-${end.text}` : atom.text;
    k += ranged ? 2 : 0;
  }
  // An unterminated class stays unterminated, for `v` mode to refuse.
  const closed = i < source.length ? ']' : '';
  return { text: `[${negated ? '^' : ''}${body}${closed}`, length: i + closed.length - at, empty: false };
}

/**
 * A regex rule's source as the scanner reads it, in JavaScript's `v` mode:
 * the reading ripgrep has of it, where the two dialects meet.
 *
 * Throws a SyntaxError, worded as JavaScript words its own, for a rule the
 * two engines would read differently.
 */
export function readRegex(source: string): string {
  let read = '';
  let at = 0;
  let empty = '';
  while (at < source.length) {
    const char = source.charAt(at);
    if (char === '\\') {
      const escape = escapeAt(source, at, false);
      read += escape.text;
      at += escape.length;
      continue;
    }
    if (char === '[') {
      const found = classAt(source, at);
      read += found.text;
      if (found.empty) empty = found.text;
      at += found.length;
      continue;
    }
    GROUP_NAME.lastIndex = at;
    const group = GROUP_NAME.exec(source);
    if (group !== null) {
      read += group[0];
      at += group[0].length;
      continue;
    }
    if (char === '{') {
      COUNT.lastIndex = at;
      const count = COUNT.exec(source);
      BLANK_COUNT.lastIndex = at;
      const blank = count === null ? BLANK_COUNT.exec(source) : null;
      if (blank !== null) refuse(source, `"${blank[0]}" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript`);
      read += count === null ? '\\{' : count[0];
      at += count === null ? 1 : count[0].length;
      continue;
    }
    if (char === ']' && empty !== '') {
      refuse(source, `"${empty}" before a "]" is a class holding the "]" to ripgrep, and ${empty === '[]' ? 'no character' : 'any character'} to JavaScript`);
    }
    read += char === '^' ? LINE_START : char === '$' ? LINE_END : char === ']' || char === '}' ? `\\${char}` : char;
    at += 1;
  }
  return read;
}

/**
 * The regular expression the scanner matches a regex rule with: the rule as
 * `readRegex` reads it, between word boundaries for `word="true"`, which
 * ripgrep's `--word-regexp` puts round a pattern as `\b{start-half}` and
 * `\b{end-half}`: no word character before the match and none after it.
 */
export function buildRegexRule(symbol: string, flags: string, word: boolean): RegExp {
  const read = readRegex(symbol);
  const source = word ? `(?<!${WORD_CHARACTER})(?:${read})(?!${WORD_CHARACTER})` : read;
  try {
    return new RegExp(source, `${flags}mv`);
  } catch (error) {
    // V8 names the source it was given, which is the reading, not the rule.
    const message = (error as Error).message;
    refuse(symbol, message.slice(message.lastIndexOf(': ') + 2));
  }
}
