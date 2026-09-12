/**
 * The directive grammar, and the code masking that decides what is prose.
 *
 * The attribute table was tested against a second copy of itself kept in the
 * suite, and that copy had fallen five attributes behind: `exclude`,
 * `comments`, `allow-empty`, `baseline` and `ratchet` could have been dropped
 * from any directive and every test would still have passed. It is now
 * asserted entry by entry against a list written out here on purpose - a
 * duplicate that is checked is a different thing from one that is not.
 *
 * The masking is the other half. `maskCode` decides which parts of a Markdown
 * file are prose and which are examples, and an example that is read as a
 * directive is a rule nobody wrote. Its fence and backtick-run rules were
 * exercised only by whichever document a test happened to use.
 */

import { describe, expect, it } from 'vitest';

import { maskCode, parseAttributes, parseDirectives, ALLOWED_ATTRIBUTES, KINDS } from '../src/parser.js';

const context = { file: 'C:/repo/docs/a.md', relativeFile: 'docs/a.md' };

/* ------------------------------------------------------------- the grammar */

describe('the directive table', () => {
  it('knows exactly these five directives', () => {
    expect([...KINDS]).toEqual([
      'assert-absence',
      'assert-count',
      'assert-present',
      'assert-import-absence',
      'assert-import-count',
    ]);
  });

  it('allows exactly these attributes, per directive', () => {
    // Written out rather than derived, because a test that reads the table it
    // is checking asserts only that the table equals itself.
    const expected: Record<string, string[]> = {
      'assert-absence': [
        'target',
        'symbol',
        'expected',
        'max',
        'glob',
        'exclude',
        'comments',
        'regex',
        'word',
        'ignore-case',
        'allow-empty',
        'baseline',
        'ratchet',
        'reason',
      ],
      'assert-count': [
        'target',
        'symbol',
        'expected',
        'min',
        'max',
        'glob',
        'exclude',
        'comments',
        'regex',
        'word',
        'ignore-case',
        'allow-empty',
        'reason',
      ],
      'assert-present': ['file', 'reason'],
      'assert-import-absence': [
        'target',
        'module',
        'exclude',
        'types',
        'expected',
        'max',
        'allow-empty',
        'baseline',
        'ratchet',
        'reason',
      ],
      'assert-import-count': [
        'target',
        'module',
        'exclude',
        'types',
        'expected',
        'min',
        'max',
        'allow-empty',
        'reason',
      ],
    };

    for (const [kind, names] of Object.entries(expected)) {
      expect([...(ALLOWED_ATTRIBUTES[kind as keyof typeof ALLOWED_ATTRIBUTES] ?? [])], kind).toEqual(names);
    }
    expect(Object.keys(ALLOWED_ATTRIBUTES).sort()).toEqual(Object.keys(expected).sort());
  });

  it('accepts every attribute the table names, for every directive', () => {
    for (const [kind, names] of Object.entries(ALLOWED_ATTRIBUTES)) {
      for (const name of names) {
        const { directives, errors } = parseDirectives(`<!-- @${kind} ${name}="1" -->`, context);
        expect(errors, `${kind} ${name}`).toEqual([]);
        expect(directives[0]?.attributes[name], `${kind} ${name}`).toBe('1');
      }
    }
  });

  it('names every directive it knows when refusing one it does not', () => {
    const { errors } = parseDirectives('<!-- @assert-nonsense -->', context);

    expect(errors[0]?.message).toBe(
      'Unknown directive "@assert-nonsense". Expected one of: @assert-absence, @assert-count, ' +
        '@assert-present, @assert-import-absence, @assert-import-count.',
    );
  });

  it('says nothing about a comment that was never trying to be a directive', () => {
    expect(parseDirectives('<!-- @todo tidy this up -->', context).errors).toEqual([]);
  });
});

describe('attribute values', () => {
  it.each([
    ['a="b"', { a: 'b' }],
    ["a='b'", { a: 'b' }],
    ['a=b', { a: 'b' }],
    // Unquoted values are more than one character long.
    ['expected=12', { expected: '12' }],
    ['a=b c=d', { a: 'b', c: 'd' }],
    // Whitespace is allowed around the equals sign, and only whitespace.
    ['a = "b"', { a: 'b' }],
    ['a\t=\t"b"', { a: 'b' }],
    // A bare name is shorthand for true.
    ['regex', { regex: 'true' }],
    ['a="b c"', { a: 'b c' }],
    ['a="say \\"hi\\""', { a: 'say "hi"' }],
    ['a=""', { a: '' }],
    ['', {}],
  ])('reads %s as %j', (input, expected) => {
    expect(parseAttributes(input)).toEqual(expected);
  });

  it('does not read a name and a value separated by something other than whitespace', () => {
    // `\s*` around the equals sign, not `\S*`: `a-b="c"` is one name, and
    // `axx="c"` is a different attribute from `a`.
    expect(parseAttributes('axx="c"')).toEqual({ axx: 'c' });
  });

  it('stops an unquoted value at the first character that cannot be in one', () => {
    expect(parseAttributes('a=b>c')).toEqual({ a: 'b', c: 'true' });
  });
});

/* ------------------------------------------------------------ code masking */

describe('fenced blocks', () => {
  function maskedLines(source: string): string[] {
    return maskCode(source).split('\n');
  }

  it('blanks a backtick fence and its contents, keeping every offset', () => {
    const source = '# Title\n```\n<!-- @assert-absence symbol="X" -->\n```\nafter\n';
    const masked = maskCode(source);

    expect(masked).toHaveLength(source.length);
    expect(masked).toContain('# Title');
    expect(masked).toContain('after');
    expect(parseDirectives(source, context).directives).toEqual([]);
  });

  it('blanks a tilde fence too, and needs three of them', () => {
    // `~{3,}` not `~`: a single tilde in prose is a tilde.
    expect(parseDirectives('~~~\n<!-- @assert-absence symbol="X" -->\n~~~\n', context).directives).toEqual([]);
    expect(parseDirectives('~\n<!-- @assert-absence symbol="X" -->\n~\n', context).directives).toHaveLength(1);
  });

  it('requires the fence to be the whole line', () => {
    // The `$` anchor. Without it, "``` in a sentence" opens a block and
    // everything after it stops being read.
    const source = 'text ``` more\n<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives).toHaveLength(1);
  });

  it('allows up to three spaces of indentation, and no more', () => {
    expect(parseDirectives('   ```\n<!-- @assert-absence symbol="X" -->\n   ```\n', context).directives).toEqual([]);
    // Four spaces is not a fence. Only one run of backticks here, so the
    // inline-span rule has nothing to pair it with either.
    expect(parseDirectives('    ```\n<!-- @assert-absence symbol="X" -->\n', context).directives).toHaveLength(1);
  });

  it('closes a fence only on a run at least as long as the opener', () => {
    const source = '````\n```\n<!-- @assert-absence symbol="X" -->\n````\nafter\n';
    expect(parseDirectives(source, context).directives).toEqual([]);
  });

  it('masks an unterminated fence to the end of the file, and no further', () => {
    // The blanking loop is bounded by the length of the source as well as by
    // the end of the block; without that bound it writes past the end and the
    // masked text comes back longer than what went in.
    const source = '```\n<!-- @assert-absence symbol="X" -->\n';
    const masked = maskCode(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.trim()).toBe('');
  });

  it('does not treat a line inside a block as a new opening fence', () => {
    const source = '```\n```\n<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives).toHaveLength(1);
  });

  it('keeps every newline, so later lines keep their numbers', () => {
    const source = '```\ncode\n```\n<!-- @assert-absence symbol="X" -->\n';
    expect(maskedLines(source)).toHaveLength(source.split('\n').length);
    expect(parseDirectives(source, context).directives[0]?.location.line).toBe(4);
  });
});

describe('inline code spans', () => {
  it('blanks a span between runs of equal length', () => {
    const source = 'Use `<!-- @assert-absence symbol="X" -->` here.\n';
    expect(parseDirectives(source, context).directives).toEqual([]);
  });

  it('does not pair runs of different lengths', () => {
    // CommonMark's rule. Pairing a ``` with a ` shifts every later pairing by
    // one and unmasks the prose between them.
    const source = 'a ``` b ` c ` d\n<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives).toHaveLength(1);
  });

  it('includes the closing run in what it blanks', () => {
    const source = 'a `x` b\n';
    expect(maskCode(source)).toBe('a     b\n');
  });

  it('leaves an unclosed run alone', () => {
    const source = 'a ` b\n<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives).toHaveLength(1);
  });

  it('starts looking again after the run it closed on', () => {
    expect(maskCode('`a` b `c`')).toBe('    b    ');
  });

  it('keeps a surrogate pair the same length', () => {
    const source = `x\`${String.fromCodePoint(0x1f600)}\`y`;
    expect(maskCode(source)).toHaveLength(source.length);
  });
});
