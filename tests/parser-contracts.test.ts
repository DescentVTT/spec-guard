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
  it('knows exactly these eight directives', () => {
    expect([...KINDS]).toEqual([
      'assert-absence',
      'assert-count',
      'assert-present',
      'assert-import-absence',
      'assert-import-count',
      'assert-import-cycle',
      'assert-layers',
      'assert-structure',
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
      // No baseline and no min: see ADR-0011 for why a cycle is not a file.
      'assert-import-cycle': ['target', 'exclude', 'types', 'dynamic', 'expected', 'max', 'allow-empty', 'reason'],
      'assert-layers': [
        'target',
        'order',
        'exclude',
        'types',
        'expected',
        'max',
        'allow-empty',
        'baseline',
        'ratchet',
        'reason',
      ],
      // No types and no comments: a structure rule reads names, never contents.
      'assert-structure': [
        'target',
        'pattern',
        'required',
        'partner',
        'dirs',
        'glob',
        'exclude',
        'expected',
        'max',
        'allow-empty',
        'baseline',
        'ratchet',
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
        '@assert-present, @assert-import-absence, @assert-import-count, @assert-import-cycle, @assert-layers, @assert-structure.',
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
    ["a='it\\'s'", { a: "it's" }],
    ['a="C:\\\\temp"', { a: 'C:\\temp' }],
    // Any other backslash is the value's own: a regular expression keeps its
    // escapes, and a Windows path its separators.
    ['symbol="\\bTODO\\b\\.\\d+"', { symbol: '\\bTODO\\b\\.\\d+' }],
    ['exclude=src\\gen', { exclude: 'src\\gen' }],
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

  it('blanks every fenced block in a document, not only the first', () => {
    // A closing fence is skipped because it lies inside the block it closes;
    // the next opener lies outside it and must open a block of its own.
    const source = '```\none\n```\nprose\n```\n<!-- @assert-absence symbol="X" -->\n```\n<!-- @assert-absence symbol="Y" -->\n';
    expect(parseDirectives(source, context).directives.map((directive) => directive.attributes['symbol'])).toEqual(['Y']);
  });

  it('blanks a tilde fence too, and needs three of them', () => {
    // `~{3,}` not `~`: a single tilde in prose is a tilde.
    expect(parseDirectives('~~~\n<!-- @assert-absence symbol="X" -->\n~~~\n', context).directives).toEqual([]);
    expect(parseDirectives('~\n<!-- @assert-absence symbol="X" -->\n~\n', context).directives).toHaveLength(1);
    expect(parseDirectives('~~\n<!-- @assert-absence symbol="X" -->\n~~\n', context).directives).toHaveLength(1);
  });

  it('needs three backticks, where two are a code span that closes nothing', () => {
    // One run of two and nothing to pair it with, so the inline rule leaves
    // it alone too. Read as a fence, it would hide the rest of the document.
    expect(parseDirectives('``\n<!-- @assert-absence symbol="X" -->\n', context).directives).toHaveLength(1);
  });

  it('requires the fence to start its line', () => {
    // The `^` anchor. Without it, "``` in a sentence" opens a block and
    // everything after it stops being read.
    const source = 'text ``` more\n<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives).toHaveLength(1);
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

/*
 * Three places the fence rule used to part from CommonMark, each of which ran a
 * directive a document only showed, or hid one it meant.
 */

/** The `symbol` of every directive a document executes, in order. */
function executed(source: string): Array<string | undefined> {
  return parseDirectives(source, context).directives.map((directive) => directive.attributes['symbol']);
}

describe('an info string that holds a backtick', () => {
  it('does not open a backtick fence, so the directive under it executes', () => {
    // ```` ```js`x ```` is prose opening with a code span. Read as a fence it
    // hid every line under it until something closed it, and nothing here
    // does - so the rule below it never ran, and nothing said so.
    expect(executed('```js`x\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('``` a ` b\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
  });

  it('is no closer either, so the fence after it still pairs as written', () => {
    // As a fence, ```` ```js`x ```` opened a block that the ```` ```md ```` below
    // closed, and the example's own closing fence then opened one that ran to
    // the end of the file. Both directives were hidden; the first is real.
    const source = [
      '```js`x',
      '<!-- @assert-absence symbol="X" -->',
      '',
      '```md',
      '<!-- @assert-absence symbol="Y" -->',
      '```',
      '<!-- @assert-absence symbol="Z" -->',
      '',
    ].join('\n');
    expect(executed(source)).toEqual(['X', 'Z']);
  });

  it('still opens a tilde fence, whose info string may hold anything', () => {
    // The must-not-match: only a backtick fence is refused a backtick.
    expect(executed('~~~ `js`\n<!-- @assert-absence symbol="X" -->\n~~~\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
  });
});

describe('a closing fence', () => {
  it('carries no info string, so a fence line with one stays inside the block', () => {
    // ```` ```js ```` inside a ``` block is a line of the block. It used to
    // close it, and the directive-shaped example after it executed.
    const source = [
      '```',
      '```js',
      '<!-- @assert-absence symbol="X" -->',
      '```',
      '<!-- @assert-absence symbol="Y" -->',
      '',
    ].join('\n');
    expect(executed(source)).toEqual(['Y']);
    expect(executed(source.replaceAll('```', '~~~'))).toEqual(['Y']);
  });

  it('may be followed by spaces, a tab, or a CRLF line ending', () => {
    // Whitespace is not an info string. Were it one, a closing fence with a
    // trailing space - or any closing fence in a Windows-authored file - would
    // close nothing, and the rest of the document would be hidden.
    for (const closer of ['```  ', '```\t', '``` \t ']) {
      expect(executed(`\`\`\`\n<!-- @assert-absence symbol="X" -->\n${closer}\n<!-- @assert-absence symbol="Y" -->\n`), JSON.stringify(closer)).toEqual(['Y']);
    }
    const crlf = '```\r\n<!-- @assert-absence symbol="X" -->\r\n```\r\n<!-- @assert-absence symbol="Y" -->\r\n';
    expect(executed(crlf)).toEqual(['Y']);
    expect(executed(crlf.replace('```\r\n<!--', '```ts\r\n<!--'))).toEqual(['Y']);
  });

  it('may open a block of its own when it is not inside one', () => {
    // A bare fence is both: the closer of the block it is in, or the opener of
    // one when it is in none.
    expect(executed('```\n<!-- @assert-absence symbol="X" -->\n```\n')).toEqual([]);
  });
});

describe('an indented fence', () => {
  it('is a fence at any indentation, as it is in a list item nested in another', () => {
    // A fence in a `1.` item inside a `-` item sits five spaces in, and deeper
    // nesting puts it further. CommonMark measures its three spaces from the
    // item; measured from the margin this was no fence, and the example
    // executed. Written the way a README writes one.
    const nested = (fence: string): string =>
      [
        '- Payments',
        '  1. Write the rule under the sentence it guards:',
        '',
        `     ${fence}md`,
        '     <!-- @assert-absence symbol="Example" -->',
        `     ${fence}`,
        '',
        '<!-- @assert-absence symbol="Real" -->',
        '',
      ].join('\n');
    expect(executed(nested('~~~'))).toEqual(['Real']);
    expect(executed(nested('~~~').replaceAll('     ', '         '))).toEqual(['Real']);
    // With backticks the old rule was right by accident: the two fence lines
    // paired as a code span. A backtick run in the prose above - a sentence
    // that mentions a fence - took the opener's place in that pairing, and
    // the example ran.
    expect(executed(nested('```'))).toEqual(['Real']);
    expect(executed(`Open a fence with \`\`\` and close it the same way.\n\n${nested('```')}`)).toEqual(['Real']);
    expect(executed('\t\t~~~\n<!-- @assert-absence symbol="X" -->\n\t\t~~~\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
  });

  it('opens and closes whatever the difference in indentation between the two', () => {
    expect(executed('        ```\n<!-- @assert-absence symbol="X" -->\n```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
    expect(executed('```\n<!-- @assert-absence symbol="X" -->\n        ```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
  });

  it('is still only a fence when nothing but whitespace comes before it', () => {
    // The must-not-match: indentation widens where a fence may start, not
    // what may start one. A run partway along an indented line opens nothing.
    expect(executed('        see ``` here\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('x```js\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('    ``\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
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
