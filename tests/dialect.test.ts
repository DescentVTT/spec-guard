/**
 * One dialect for a regex rule, read by both engines alike. ADR-0007, amended
 * 2026-10-24.
 *
 * ripgrep only names the files the scanner reads, and it read a rule's `\w`,
 * `\b`, `\d` and `\s` as Unicode's where JavaScript read them as ASCII (and
 * its `\s` with U+FEFF and without NEL), a character as a code point where
 * JavaScript read a UTF-16 unit, and `\A` or `[[:alpha:]]` as what the regex
 * crate documents where JavaScript read letters and brackets. Each was a file
 * the scanner counted in and ripgrep left out: a pass under `--engine rg`.
 * The scanner now reads a rule as the crate does, and refuses what the two
 * would read apart. The cases that must still be read as before are here
 * too.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createCommentMask } from '../src/comments.js';
import { buildJsRegExp, javascriptEngine, resolveEngine, scanContent, type SearchRequest } from '../src/engine.js';
import { runSpecGuard } from '../src/runner.js';
import type { SearchOptions } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const at = (...points: number[]): string => String.fromCodePoint(...points);

const E_ACUTE = at(0xe9); // a letter
const MARK = at(0x301); // a combining mark
const ZWJ = at(0x200d); // Join_Control
const UNDERTIE = at(0x203f); // connector punctuation
const CIRCLED_A = at(0x24b6); // a symbol that is Alphabetic
const ARABIC_THREE = at(0x663); // a decimal digit
const SUPERSCRIPT_TWO = at(0xb2); // a number, and no decimal digit
const ROMAN_EIGHT = at(0x2167); // a number that is Alphabetic
const BOM = at(0xfeff); // no White_Space
const NEL = at(0x85); // White_Space
const NBSP = at(0xa0); // White_Space
const KELVIN = at(0x212a);
const LONG_S = at(0x17f);
const SMILE = at(0x1f600); // two UTF-16 units

/** How many matches a rule over one text counts. */
function count(symbol: string, content: string, options: Partial<SearchOptions> = {}): number {
  return scanContent(content, 'a.txt', buildJsRegExp(symbol, searchOptions({ regex: true, ...options }))).count;
}

/** The reason a rule is refused for, or undefined when it is read. */
function refusal(symbol: string): string | undefined {
  try {
    buildJsRegExp(symbol, searchOptions({ regex: true }));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('a class, as the regex crate reads it', () => {
  it('reads \\w as Alphabetic, marks, decimal digits, connector punctuation and Join_Control', () => {
    for (const char of ['a', '_', '7', E_ACUTE, MARK, ZWJ, UNDERTIE, CIRCLED_A, ARABIC_THREE, ROMAN_EIGHT]) {
      expect(count(String.raw`x\wy`, `x${char}y`), char).toBe(1);
      expect(count(String.raw`x\Wy`, `x${char}y`), char).toBe(0);
      expect(count(String.raw`x[\w]y`, `x${char}y`), char).toBe(1);
      expect(count(String.raw`x[^\w]y`, `x${char}y`), char).toBe(0);
      expect(count(String.raw`x[\W]y`, `x${char}y`), char).toBe(0);
      expect(count(String.raw`x[^\W]y`, `x${char}y`), char).toBe(1);
    }
    for (const char of ['-', ' ', SUPERSCRIPT_TWO, BOM]) {
      expect(count(String.raw`x\wy`, `x${char}y`), char).toBe(0);
      expect(count(String.raw`x\Wy`, `x${char}y`), char).toBe(1);
      expect(count(String.raw`x[\W]y`, `x${char}y`), char).toBe(1);
    }
  });

  it('reads \\d as a decimal digit of any script, and no other number', () => {
    expect(count(String.raw`x\dy`, `x${ARABIC_THREE}y`)).toBe(1);
    expect(count(String.raw`x\Dy`, `x${ARABIC_THREE}y`)).toBe(0);
    expect(count(String.raw`x[\d]y`, `x${ARABIC_THREE}y`)).toBe(1);
    expect(count(String.raw`x[^\d]y`, `x${ARABIC_THREE}y`)).toBe(0);
    expect(count(String.raw`x[\D]y`, `x${ARABIC_THREE}y`)).toBe(0);
    expect(count(String.raw`x\dy`, `x${SUPERSCRIPT_TWO}y`)).toBe(0);
    expect(count(String.raw`x\Dy`, `x${SUPERSCRIPT_TWO}y`)).toBe(1);
    expect(count(String.raw`x\dy`, 'x7y')).toBe(1);
  });

  it('reads \\s as White_Space, which holds NEL and not U+FEFF', () => {
    expect(count(String.raw`a\sb`, `a${NEL}b`)).toBe(1);
    expect(count(String.raw`a\Sb`, `a${NEL}b`)).toBe(0);
    expect(count(String.raw`a\sb`, `a${BOM}b`)).toBe(0);
    expect(count(String.raw`a\Sb`, `a${BOM}b`)).toBe(1);
    expect(count(String.raw`a[\s]b`, `a${BOM}b`)).toBe(0);
    expect(count(String.raw`a[^\s]b`, `a${BOM}b`)).toBe(1);
    expect(count(String.raw`a[\S]b`, `a${NEL}b`)).toBe(0);
    expect(count(String.raw`a\sb`, `a${NBSP}b`)).toBe(1);
    expect(count(String.raw`a\sb`, 'a\tb')).toBe(1);
  });

  it('reads a class escape beside other members of a class', () => {
    expect(count(String.raw`x[a\W]y`, `x${E_ACUTE}y`)).toBe(0);
    expect(count(String.raw`x[a\W]y`, 'x-y')).toBe(1);
    expect(count(String.raw`x[a\W]y`, 'xay')).toBe(1);
    expect(count(String.raw`x[^a\W]y`, `x${E_ACUTE}y`)).toBe(1);
    expect(count(String.raw`x[^a\W]y`, 'xay')).toBe(0);
    expect(count(String.raw`x[\W_]+y`, 'x_-_y')).toBe(1);
    expect(count(String.raw`x[\s\S]y`, `x${SMILE}y`)).toBe(1);
  });
});

describe('a word boundary, as the regex crate reads it', () => {
  it('meets no boundary between two letters, either of them outside ASCII', () => {
    expect(count(String.raw`foo\b`, `foo${E_ACUTE}`)).toBe(0);
    expect(count(String.raw`\bfoo`, `${E_ACUTE}foo`)).toBe(0);
    expect(count(String.raw`\Wbar`, `${E_ACUTE}bar`)).toBe(0);
    expect(count(String.raw`foo\B`, `foo${E_ACUTE}`)).toBe(1);
    expect(count(String.raw`o\B${E_ACUTE}`, `fo${E_ACUTE}`)).toBe(1);
  });

  it('meets one between a letter and what is no word character, the ends of the text included', () => {
    expect(count(String.raw`foo\b`, 'foo-')).toBe(1);
    expect(count(String.raw`foo\b`, 'foo')).toBe(1);
    expect(count(String.raw`\bfoo`, 'foo')).toBe(1);
    expect(count(String.raw`${E_ACUTE}\b `, `x${E_ACUTE} y`)).toBe(1);
    expect(count(String.raw`${E_ACUTE}\B `, `x${E_ACUTE} y`)).toBe(0);
    expect(count(String.raw`\bfoo\b`, 'a foo b')).toBe(1);
    expect(count(String.raw`\Bfoo`, 'foo')).toBe(0);
  });

  it('puts the same boundary round a literal and a regex with word', () => {
    for (const regex of [false, true]) {
      for (const char of [E_ACUTE, MARK, ZWJ, UNDERTIE, CIRCLED_A, ARABIC_THREE, ROMAN_EIGHT, '_', 'b']) {
        expect(count('foo', `x foo${char} y`, { regex, word: true }), `${regex} ${char}`).toBe(0);
        expect(count('foo', `x ${char}foo y`, { regex, word: true }), `${regex} ${char}`).toBe(0);
      }
      for (const char of [SUPERSCRIPT_TWO, '-', ' ', BOM]) {
        expect(count('foo', `x foo${char} y`, { regex, word: true }), `${regex} ${char}`).toBe(1);
      }
      expect(count('foo', 'foo', { regex, word: true })).toBe(1);
    }
  });

  it('puts it round the whole of a regex, as ripgrep puts the half boundaries round a pattern', () => {
    expect(count('-foo', 'a-foo b', { word: true })).toBe(0);
    expect(count('-foo', ' -foo b', { word: true })).toBe(1);
    expect(count('a|bc', 'xbc a', { word: true })).toBe(1);
  });
});

describe('a character, and its case, as the regex crate reads them', () => {
  it('reads a character outside the Basic Multilingual Plane as one', () => {
    expect(count('^.$', SMILE)).toBe(1);
    expect(count('^..$', SMILE)).toBe(0);
    expect(count('x[^a]y', `x${SMILE}y`)).toBe(1);
    expect(count('x[^a][^a]y', `x${SMILE}y`)).toBe(0);
  });

  it('steps past an empty match by a character, one outside the Basic Multilingual Plane included', () => {
    // One unit on, V8 moves the index back to the character's first unit
    // and meets the same empty match again: the scan never came back.
    expect(count('x*', `a${SMILE}b`)).toBe(4);
    expect(count(String.raw`\B`, `${SMILE}${SMILE}`)).toBe(3);
    // U+FFFF is the last character of one unit, and is stepped past by one.
    expect(count('x*', `a${at(0xffff)}b`)).toBe(4);
    // Nor between its two units, where a look-behind once met an empty
    // match: a word character before the smile and after it, and no place
    // that is not a boundary.
    expect(count(String.raw`\B`, `x${SMILE}y`)).toBe(0);
    expect(count(String.raw`(?<!\p{L})`, `x${SMILE}y`)).toBe(2);
    expect(count('x*', `a${SMILE}b`, { word: true })).toBe(0);
    // In a comment as well: the six places of `// a`, the smile and `b`.
    const content = `// a${SMILE}b\nx\n`;
    const tally = scanContent(content, 'a.ts', buildJsRegExp('x*', searchOptions({ regex: true })), () => createCommentMask(content, 'a.ts'));
    expect(tally).toMatchObject({ count: 3, commentCount: 6 });
    // And a match in a comment that is not empty is stepped past by nothing.
    const twice = '// xx\n';
    expect(scanContent(twice, 'a.ts', buildJsRegExp('x', searchOptions({ regex: true })), () => createCommentMask(twice, 'a.ts'))).toMatchObject({ count: 0, commentCount: 2 });
  });

  it('counts no empty match after the last line end, where no line is, as ripgrep names no file for one', () => {
    expect(count('x*', 'a\n')).toBe(2);
    expect(count('x*', 'a')).toBe(2);
    expect(count('x*', '')).toBe(0);
    expect(count('x?', '\n')).toBe(1);
    expect(count(String.raw`\B`, 'a\n')).toBe(0);
    expect(count(String.raw`\B`, 'a\r')).toBe(1);
    expect(count('a\n', 'a\n')).toBe(1);
  });

  it('folds case by Unicode simple case folding', () => {
    expect(count('xky', `x${KELVIN}y`, { ignoreCase: true })).toBe(1);
    expect(count('xsy', `x${LONG_S}y`, { ignoreCase: true })).toBe(1);
    expect(count(`x${at(0xdf)}y`, `x${at(0x1e9e)}y`, { ignoreCase: true })).toBe(1);
    expect(count('x[^a-z]y', `x${KELVIN}y`, { ignoreCase: true })).toBe(0);
    expect(count(String.raw`x\Wy`, `x${LONG_S}y`, { ignoreCase: true })).toBe(0);
    expect(count('xky', `x${KELVIN}y`)).toBe(0);
    expect(count(`x${at(0x130)}y`, 'xiy', { ignoreCase: true })).toBe(0);
  });

  it('reads a property and a code point in braces', () => {
    expect(count(String.raw`x\p{L}y`, `x${E_ACUTE}y`)).toBe(1);
    expect(count(String.raw`x\p{L}y`, 'xp{L}y')).toBe(0);
    expect(count(String.raw`x\P{L}y`, 'x-y')).toBe(1);
    expect(count(String.raw`x\p{Script=Greek}y`, `x${at(0x3b1)}y`)).toBe(1);
    expect(count(String.raw`\u{41}`, 'A')).toBe(1);
    expect(count(String.raw`x[\u{41}]y`, 'xAy')).toBe(1);
    // What follows a property is read as the rest of the rule is.
    expect(count(String.raw`\p{L}\w`, `${E_ACUTE}${E_ACUTE}`)).toBe(1);
    expect(count(String.raw`x[\p{L}-.]y`, 'x-y')).toBe(1);
    expect(count(String.raw`x[\u{41}-\u{43}]y`, 'xBy')).toBe(1);
  });
});

describe('what JavaScript read as itself', () => {
  it('keeps an escaped sign as the sign, outside a class and in one', () => {
    for (const sign of ['-', '#', ' ', ':', '@', '%', '=', '"', "'", '_', ',', ';', '!', '&', '~', '`', '/', '.', '$', '^']) {
      expect(count(`x\\${sign}y`, `x${sign}y`), sign).toBe(1);
      expect(count(`x[\\${sign}]y`, `x${sign}y`), sign).toBe(1);
      expect(count(`x\\${sign}y`, 'xay'), sign).toBe(0);
    }
    // A sign below U+0010, written with two hex digits.
    expect(count('x\\\ty', 'x\ty')).toBe(1);
    // A `<` after an escaped sign opens no group's name, as after `\k` it does.
    expect(count('x\\-<y>', 'x-<y>')).toBe(1);
    // And a sign written plain in a class, which `v` mode reads only escaped.
    for (const sign of ['(', ')', '|', '{', '}', '/', '$', '^', '&', '~', '.', '*']) {
      expect(count(`x[a${sign}]y`, `x${sign}y`), sign).toBe(1);
    }
  });

  it('keeps a lone ], a lone } and a { that is no count', () => {
    expect(count('x]y', 'x]y')).toBe(1);
    expect(count('x}y', 'x}y')).toBe(1);
    expect(count(String.raw`if \(x\) {`, 'if (x) {')).toBe(1);
    expect(count('xa{,3}y', 'xa{,3}y')).toBe(1);
    expect(count('xa{y', 'xa{y')).toBe(1);
    expect(count(String.raw`\[TODO]`, '[TODO]')).toBe(1);
    expect(count('xa{2}y', 'xaay')).toBe(1);
    expect(count('xa{2,}y', 'xaaay')).toBe(1);
    expect(count('xa{1,2}y', 'xaaay')).toBe(0);
    expect(count('xa{10}y', `x${'a'.repeat(10)}y`)).toBe(1);
    // A class ends at its `]`, and a `]` after it is a lone one.
    expect(count('[a]]', 'a]')).toBe(1);
  });

  it('keeps a - beside a class escape, or after a range, as a -', () => {
    expect(count(String.raw`x[\w-.]y`, 'x-y')).toBe(1);
    expect(count(String.raw`x[\w-.]y`, `x${E_ACUTE}y`)).toBe(1);
    expect(count(String.raw`x[.-\w]y`, 'x-y')).toBe(1);
    expect(count('x[a-c-e]y', 'x-y')).toBe(1);
    expect(count('x[a-c-e]y', 'xdy')).toBe(0);
    expect(count('x[a-c]y', 'xby')).toBe(1);
    expect(count('x[-a]y', 'x-y')).toBe(1);
    expect(count('x[a-]y', 'x-y')).toBe(1);
    expect(count(String.raw`x[a\-c]y`, 'xby')).toBe(0);
    expect(count(String.raw`x[\x41-\x43]y`, 'xBy')).toBe(1);
  });

  it('keeps an anchor a line, a group name and an escape what they were', () => {
    expect(count('(?<$a>x)\\k<$a>$', 'xx\nxxy\n')).toBe(1);
    expect(count('[$^]', 'a$b^c\n')).toBe(2);
    expect(count('[^]', 'ab')).toBe(2);
    expect(count('x[^]y', 'xab')).toBe(0);
    // `\b` in a class is a backspace, a character a range can start at.
    expect(count(String.raw`x[\b-z]y`, 'xAy')).toBe(1);
    expect(count(String.raw`x[\!-\/]y`, 'x#y')).toBe(1);
    // A `{` after `\B` is a character, as it is after any atom it counts nothing of.
    expect(count(String.raw`x \B{x}`, 'x {x}')).toBe(1);
    expect(count('x[]y', 'xy')).toBe(0);
    expect(count(String.raw`x[\b]y`, `x${at(8)}y`)).toBe(1);
    expect(count(String.raw`x\cAy`, `x${at(1)}y`)).toBe(1);
    expect(count(String.raw`(?<=a)b`, 'ab')).toBe(1);
  });
});

describe('what the two engines would read apart', () => {
  it('is refused, naming it', () => {
    const cases: Array<[string, string]> = [
      [String.raw`x\Ay`, String.raw`"\A" is the start of the text to ripgrep and "A" to JavaScript`],
      [String.raw`x\zy`, String.raw`"\z" is the end of the text to ripgrep and "z" to JavaScript`],
      [String.raw`a\<b`, String.raw`"\<" is the start of a word to ripgrep and "<" to JavaScript`],
      [String.raw`a\>b`, String.raw`"\>" is the end of a word to ripgrep and ">" to JavaScript`],
      [String.raw`x\ay`, String.raw`"\a" is a bell, U+0007 to ripgrep and "a" to JavaScript`],
      [String.raw`x[\a]y`, String.raw`"\a" is a bell, U+0007 to ripgrep and "a" to JavaScript`],
      [String.raw`\U00000041`, String.raw`"\U" is a code point in eight hex digits to ripgrep and "U" to JavaScript`],
      [String.raw`x[\U00000041]y`, String.raw`"\U" is a code point in eight hex digits to ripgrep and "U" to JavaScript`],
      ['xa{2, 3}y', '"{2, 3}" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript'],
      ['xa{ 2 }y', '"{ 2 }" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript'],
      ['xa{2,3 }y', '"{2,3 }" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript'],
      ['xa{2, }y', '"{2, }" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript'],
      ['xa{ 10 }y', '"{ 10 }" is a count to ripgrep, which reads one with blanks in it, and those characters to JavaScript'],
      [String.raw`x\pLy`, String.raw`"\pL" is a class of characters to ripgrep and "pL" to JavaScript`],
      [String.raw`x[\PL]y`, String.raw`"\PL" is a class of characters to ripgrep and "PL" to JavaScript`],
      [String.raw`\x{41}`, String.raw`"\x{" is the code point its braces hold to ripgrep, and an "x" and braces to JavaScript`],
      [String.raw`\b{start}foo`, String.raw`"\b{" is a word boundary of the kind its braces name to ripgrep, and a word boundary before a "{" to JavaScript`],
      ['[[:alpha:]]', '"[" in a class is a class inside it to ripgrep, as in [[:alpha:]], and a "[" to JavaScript'],
      ['x[a[b]]y', '"[" in a class is a class inside it to ripgrep, as in [[:alpha:]], and a "[" to JavaScript'],
      ['x[a&&b]y', '"&&" in a class is an operation on two classes to ripgrep and two characters to JavaScript'],
      ['x[a-z--b]y', '"--" in a class is an operation on two classes to ripgrep and two characters to JavaScript'],
      ['x[a~~b]y', '"~~" in a class is an operation on two classes to ripgrep and two characters to JavaScript'],
      ['[]a]', '"[]" before a "]" is a class holding the "]" to ripgrep, and no character to JavaScript'],
      ['[^]a]', '"[^]" before a "]" is a class holding the "]" to ripgrep, and any character to JavaScript'],
    ];
    for (const [symbol, reason] of cases) {
      expect(refusal(symbol), symbol).toBe(`Invalid regular expression: /${symbol}/: ${reason}`);
    }
  });

  it('names the rule, not its reading, where JavaScript refuses it', () => {
    expect(refusal('(')).toBe('Invalid regular expression: /(/: Unterminated group');
    expect(refusal('[a')).toBe('Invalid regular expression: /[a/: Unterminated character class');
    expect(refusal(String.raw`x\ey`)).toBe(String.raw`Invalid regular expression: /x\ey/: Invalid escape`);
    expect(refusal('[z-a]')).toBe('Invalid regular expression: /[z-a]/: Range out of order in character class');
    expect(refusal('x\\')).toBe('Invalid regular expression: /x\\/: \\ at end of pattern');
    expect(refusal(String.raw`x[\B]y`)).toBe(String.raw`Invalid regular expression: /x[\B]y/: Invalid escape`);
    // An escaped character outside ASCII, from the first of them on, which
    // JavaScript read as itself without `v` and the crate refuses.
    for (const char of [at(0x80), E_ACUTE]) expect(refusal(`x\\${char}y`), char).toBe(`Invalid regular expression: /x\\${char}y/: Invalid escape`);
    expect(refusal(String.raw`\p{L`)).toBe(String.raw`Invalid regular expression: /\p{L/: Invalid property name`);
    expect(refusal('(?<abc')).toBe('Invalid regular expression: /(?<abc/: Invalid capture group name');
  });

  it('reads what is no such construct', () => {
    for (const symbol of [String.raw`\\A`, String.raw`x[\A-]`, '[^]', '[]', 'x]y', '[a-]', String.raw`[\<]`, String.raw`\p{L}`, String.raw`\bfoo`, String.raw`[&]`, String.raw`[~]`, '[a-z-]', String.raw`[\-\-]`]) {
      expect(() => buildJsRegExp(symbol, searchOptions({ regex: true })), symbol).not.toThrow(/to ripgrep/);
    }
    expect(refusal(String.raw`x[\A-]`)).toBe(String.raw`Invalid regular expression: /x[\A-]/: Invalid escape`);
  });
});

const rgPath = findTestRipgrep();

describe.skipIf(!rgPath)('one reading, through both engines', () => {
  // Each sample is a file of its own, and each rule is asked of each engine
  // alone, so that no other rule's match names a file ripgrep's reading of
  // this one left out.
  const SAMPLES: Record<string, string> = {
    ascii: 'x foo y',
    'e-acute-after': `x foo${E_ACUTE} y`,
    'e-acute-before': `x ${E_ACUTE}foo y`,
    mark: `x foo${MARK} y`,
    zwj: `x foo${ZWJ} y`,
    undertie: `x foo${UNDERTIE} y`,
    'circled-a': `x foo${CIRCLED_A} y`,
    'arabic-three': `x foo${ARABIC_THREE} y`,
    'superscript-two': `x foo${SUPERSCRIPT_TWO} y`,
    'roman-eight': `x foo${ROMAN_EIGHT} y`,
    bom: `x foo${BOM}bar y`,
    nel: `x foo${NEL}bar y`,
    nbsp: `x foo${NBSP}bar y`,
    smile: `x ${SMILE} y`,
    kelvin: `x ${KELVIN} y`,
    'long-s': `x ${LONG_S} y`,
    dash: 'x foo-bar y',
    'lone-a': 'a',
  };
  const RULES: Array<Partial<SearchOptions> & { symbol: string }> = [
    { symbol: String.raw`foo\b`, regex: true },
    { symbol: String.raw`foo\B`, regex: true },
    { symbol: String.raw`\bfoo`, regex: true },
    { symbol: String.raw`foo\w`, regex: true },
    { symbol: String.raw`foo\W`, regex: true },
    { symbol: String.raw`foo[^\w ]`, regex: true },
    { symbol: String.raw`foo[\W]`, regex: true },
    { symbol: String.raw`foo\d`, regex: true },
    { symbol: String.raw`foo\D`, regex: true },
    { symbol: String.raw`foo\sbar`, regex: true },
    { symbol: String.raw`foo\Sbar`, regex: true },
    { symbol: String.raw`foo[\s]bar`, regex: true },
    { symbol: 'x .. y', regex: true },
    { symbol: 'x . y', regex: true },
    { symbol: 'x [^a][^a] y', regex: true },
    { symbol: 'x k y', regex: true, ignoreCase: true },
    { symbol: 'x s y', regex: true, ignoreCase: true },
    { symbol: 'x [^a-z] y', regex: true, ignoreCase: true },
    { symbol: String.raw`x \W y`, regex: true, ignoreCase: true },
    { symbol: 'foo', regex: true, word: true },
    { symbol: 'foo', word: true },
    { symbol: 'foo', ignoreCase: true, word: true },
    // A byte order mark is a character of the first line to both, and an
    // empty match after the last line end is on no line.
    { symbol: BOM },
    { symbol: String.raw`^\S`, regex: true },
    { symbol: 'x*', regex: true },
    { symbol: String.raw`\B`, regex: true },
  ];

  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.map(removeTempRepo));
  });

  it('names to the scanner every file the scanner counts in, and counts the same matches in the same places', async () => {
    const root = await makeTempRepo({
      ...Object.fromEntries(Object.entries(SAMPLES).map(([name, text]) => [`data/${name}.txt`, `${text}\n`])),
      'data/starts-with-a-mark.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x foo y\n')]),
      'data/empty.txt': '',
    });
    temporary.push(root);
    process.env.SPEC_GUARD_RG = rgPath as string;
    const ripgrep = await resolveEngine('ripgrep');

    const places = async (request: SearchRequest, engine: typeof javascriptEngine | typeof ripgrep): Promise<string[]> =>
      (await engine.search(request)).matches.map((match) => `${match.file}:${match.line}`);
    for (const { symbol, ...options } of RULES) {
      const request: SearchRequest = { root, symbol, targets: ['data'], options: searchOptions(options) };
      const scanner = await places(request, javascriptEngine);
      expect(await places(request, ripgrep), JSON.stringify({ symbol, options })).toEqual(scanner);
    }
  });

  it('counts what the regex crate documents, through the run', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': [
        '# Rules',
        '',
        '<!-- @assert-count target="data/after.txt" symbol="foo\\b" regex="true" max="9" -->',
        '<!-- @assert-count target="data/before.txt" symbol="\\Wbar" regex="true" max="9" -->',
        '<!-- @assert-count target="data/bom.txt" symbol="a\\sb" regex="true" max="9" -->',
        '<!-- @assert-count target="data/word.txt" symbol="baz" regex="true" word="true" max="9" -->',
        '<!-- @assert-count target="data/mark.txt" symbol="cafe" word="true" max="9" -->',
        '<!-- @assert-count target="data/plain.txt" symbol="foo\\b" regex="true" max="9" -->',
        '',
      ].join('\n'),
      'data/after.txt': `foo${E_ACUTE}\n`,
      'data/before.txt': `${E_ACUTE}bar\n`,
      'data/bom.txt': `a${BOM}b\n`,
      'data/word.txt': `${E_ACUTE}baz\n`,
      'data/mark.txt': `cafe${MARK}\n`,
      'data/plain.txt': 'foo-\nfoo\n',
    });
    temporary.push(root);

    for (const engine of ['javascript', 'ripgrep'] as const) {
      process.env.SPEC_GUARD_RG = rgPath as string;
      const report = await runSpecGuard({ root, patterns: ['docs/rules.md'], engine });
      expect(report.engine, engine).toBe(engine);
      expect(report.warnings, engine).toEqual([]);
      expect(report.results.map((result) => result.actual), engine).toEqual([0, 0, 0, 0, 0, 2]);
    }
  });

  it('refuses a rule the two would read apart, with either engine, before it searches', async () => {
    const root = await makeTempRepo({
      'docs/rules.md': '# Rules\n\n<!-- @assert-absence target="data" symbol="x\\Ay" regex="true" -->\n',
      'data/a.txt': 'xAy\n',
    });
    temporary.push(root);

    for (const engine of ['javascript', 'ripgrep'] as const) {
      process.env.SPEC_GUARD_RG = rgPath as string;
      const report = await runSpecGuard({ root, patterns: ['docs/rules.md'], engine });
      expect(report.results, engine).toEqual([]);
      expect(report.errors.map((error) => error.message), engine).toEqual([String.raw`Invalid regular expression: /x\Ay/: "\A" is the start of the text to ripgrep and "A" to JavaScript`]);
    }
  });
});
