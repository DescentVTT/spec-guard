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

import { EXIT_FAILED, main, type CliIO } from '../src/cli.js';
import { maskCode, parseAttributes, parseDirectives, ALLOWED_ATTRIBUTES, KINDS } from '../src/parser.js';
import { formatJson } from '../src/reporter.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

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
    expect(executed('- a\n\n\t~~~\n<!-- @assert-absence symbol="X" -->\n\t~~~\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
    // Four columns past the item's text is indented code, and a fence line
    // there is a line of it, as the next test says of one outside a list.
    expect(executed('- a\n\n\t\t~~~\n<!-- @assert-absence symbol="X" -->\n\t\t~~~\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['X', 'Y']);
  });

  it('closes on a fence no more than three columns deeper than the one that opened it', () => {
    // CommonMark's allowance, measured from the opener, so a fence in a list
    // item closes at the item's indentation. Deeper, the line is code.
    expect(executed('   ```\n<!-- @assert-absence symbol="X" -->\n      ```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
    expect(executed('```\n<!-- @assert-absence symbol="X" -->\n    ```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual([]);
    // Shallower is fine: the list item it sat in has ended.
    expect(executed('- a\n\n     ```\n<!-- @assert-absence symbol="X" -->\n```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
    // Four columns past the item's text, the opener is indented code, so X is
    // read, and the fence at the margin opens a block that runs to the end.
    expect(executed('- a\n\n      ```\n<!-- @assert-absence symbol="X" -->\n```\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['X']);
  });

  it('is code, not a fence, where a line indented four columns is code', () => {
    // After a blank line and outside a list, four columns open indented code,
    // and a fence line there is a line of that code. Read as a fence, it hid
    // every line after it until something closed it.
    expect(executed('prose\n\n    ```\n\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('        ```\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
  });

  it('is still only a fence when nothing but whitespace comes before it', () => {
    // The must-not-match: indentation widens where a fence may start, not
    // what may start one. A run partway along an indented line opens nothing.
    expect(executed('        see ``` here\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('x```js\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    expect(executed('    ``\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
  });
});

describe('a fence line shown as code in a list item', () => {
  // The review's document. 4f2826a read no indented code inside a list, so the
  // fence line six spaces in opened a block nothing closed, and the directive
  // at the end of the document - the only rule it states - never ran. From
  // cbe2223 the scanner knows the item's text column: four past it is code.
  const REPRO = [
    '- To show a fence in a list, indent it as code:',
    '',
    '      ```',
    '',
    '- The gateway is gone.',
    '',
    '<!-- @assert-absence target="src" symbol="LegacyGateway" -->',
    '',
  ].join('\n');
  const parsed = (source: string) => parseDirectives(source, context);

  it('is code, and the directive after it runs', () => {
    const { directives, warnings } = parsed(REPRO);
    expect(directives.map((directive) => [directive.location.line, directive.attributes['symbol']])).toEqual([[7, 'LegacyGateway']]);
    expect(warnings).toBeUndefined();
  });

  it.each([
    ['a dash item, eight spaces in', ['- Show it:', '', '        ```', '']],
    ['a numbered item, seven spaces in', ['1. Show it:', '', '       ```', '']],
    ['a nested item, eight spaces in', ['- Outer', '  - Inner, show it:', '', '        ```', '']],
    ['a nested numbered item', ['- Outer', '  1. Inner, show it:', '', '         ```', '']],
    ['tildes', ['- Show it:', '', '      ~~~', '']],
    ['a fence with an info string', ['- Show it:', '', '      ```ts', '']],
    ['a fence with an info string and tildes', ['1. Show it:', '', '       ~~~ md title="x"', '']],
    ['a tab past a dash item', ['- Show it:', '', '\t  ```', '']],
  ])('is code in %s, and the directive after it runs', (_, lines) => {
    const { directives, warnings } = parsed([...lines, '- Next item.', '', '<!-- @assert-absence target="src" symbol="LegacyGateway" -->', ''].join('\n'));
    expect(directives.map((directive) => directive.attributes['symbol'])).toEqual(['LegacyGateway']);
    expect(warnings).toBeUndefined();
  });

  it('is still a fence three columns past the item text, where it hides what it holds', () => {
    // The must-not-match: a fence in a list item is an opener up to three
    // columns past the item's text, as CommonMark says.
    const source = ['- Show it:', '', '     ```md', '     <!-- @assert-absence target="src" symbol="Example" -->', '     ```', '', '<!-- @assert-absence target="src" symbol="Real" -->', ''].join('\n');
    expect(parsed(source).directives.map((directive) => directive.attributes['symbol'])).toEqual(['Real']);
    expect(parsed(source).warnings).toBeUndefined();
  });

  it('fails the run from the command line, as 0.11.0 did', async () => {
    const root = await makeTempRepo({ 'docs/gateway.md': REPRO, 'src/pay.ts': 'export class LegacyGateway {}\n' });
    try {
      const out: string[] = [];
      const cli: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: { NO_COLOR: '1' }, cwd: root, isTTY: false };
      expect(await main(['docs/*.md', '--engine', 'js'], cli)).toBe(EXIT_FAILED);
      expect(out.join('\n')).toContain('"LegacyGateway" must not appear in src');
    } finally {
      await removeTempRepo(root);
    }
  });
});

describe('a block never closed', () => {
  const warningsOf = (source: string) => parseDirectives(source, context).warnings?.map(({ location, message }) => [location.line, message]);

  it('is a warning on its opening line when it runs to the end of the document, since nothing after it runs', () => {
    expect(warningsOf('# T\n\n```js\nconst x = 1;\n\n<!-- @assert-absence target="src" symbol="X" -->\n')).toEqual([
      [3, 'the code fence ```js opened here is never closed, so lines 3 to 6, the rest of the document, are read as code, and no directive in them runs'],
    ]);
    expect(warningsOf('# T\n\n~~~\nx\n')).toEqual([
      [3, 'the code fence ~~~ opened here is never closed, so lines 3 to 4, the rest of the document, are read as code, and no directive in them runs'],
    ]);
    // The fence a list item holds, three columns past its text, is one too.
    expect(warningsOf('- a\n\n     ```\n     x\n')?.map(([line]) => line)).toEqual([3]);
  });

  it.each(['pre', 'script', 'style', 'textarea', 'PRE'])('is a warning for a <%s> block, whose content is not Markdown either', (tag) => {
    expect(warningsOf(`# T\n\n<${tag} class="x">\nbody\n\n<!-- @assert-absence target="src" symbol="X" -->\n`)).toEqual([
      [3, `the <${tag.toLowerCase()}> block opened here is never closed, so lines 3 to 6, the rest of the document, are read as code, and no directive in them runs`],
    ]);
  });

  it('is no warning when it is closed, ends with its block quote, holds nothing, or is indented code', () => {
    expect(warningsOf('```\nx\n```\n')).toBeUndefined();
    expect(warningsOf('<pre>\nx\n</pre>\n')).toBeUndefined();
    expect(warningsOf('> ```\n> x\n\nafter\n')).toBeUndefined();
    expect(warningsOf('# T\n\n```\n')).toBeUndefined();
    expect(warningsOf('# T\n\n```\n\n\n')).toBeUndefined();
    expect(warningsOf('prose\n\n    ```\n    x\n')).toBeUndefined();
  });

  it('reaches the report as a warning, and fails nothing', async () => {
    const root = await makeTempRepo({
      'docs/a.md': '# A\n\n<!-- @assert-absence target="src" symbol="Nowhere" -->\n\n```sh\nnpm test\n\n<!-- @assert-absence target="src" symbol="Hidden" -->\n',
      'src/a.ts': 'const Hidden = 1;\n',
    });
    try {
      const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });
      expect(report.ok).toBe(true);
      expect(report.summary.total).toBe(1);
      expect(report.specWarnings?.map(({ location, message }) => [location.relativeFile, location.line, message.slice(0, 32)])).toEqual([
        ['docs/a.md', 5, 'the code fence ```sh opened here'],
      ]);
    } finally {
      await removeTempRepo(root);
    }
  });
});

describe('a directive-shaped comment in text no directive is read from', () => {
  const RULE = '<!-- @assert-absence target="src" symbol="X" -->';
  const maskedIn = (source: string) => parseDirectives(source, context).masked?.map(({ location, inside }) => [location.line, location.column, inside]);

  it('is counted with where it is and what hid it', () => {
    // Each of these ran under 0.11.0 or reads as prose to someone skimming the
    // source, and none runs now: the report has to say where they went.
    expect(maskedIn(`prose\n\n    ${RULE}\n`)).toEqual([[3, 5, 'indented code']]);
    expect(maskedIn(`# T\n\n<pre>\n${RULE}\n`)).toEqual([[4, 1, 'raw HTML']]);
    expect(maskedIn(`---\n${RULE}\n---\n\n# T\n`)).toEqual([[2, 1, 'front matter']]);
    expect(maskedIn(`+++\n${RULE}\n+++\n`)).toEqual([[2, 1, 'front matter']]);
    expect(maskedIn(`\`\`\`md\n${RULE}\n\`\`\`\n`)).toEqual([[2, 1, 'fenced code']]);
    expect(maskedIn(`Write \`${RULE}\` above the rule.\n`)).toEqual([[1, 8, 'code span']]);
  });

  it('is placed behind a byte-order mark where a directive there would be', () => {
    expect(maskedIn(`${String.fromCharCode(0xfeff)}\`${RULE}\`\n`)).toEqual([[1, 3, 'code span']]);
  });

  it('is any kind that begins with assert, known or not, and nothing else', () => {
    const source = `\`\`\`\n<!--@assert-bogus x -->\n<!-- @note hello -->\n<!-- @Assert-Count symbol="Y" -->\n\`\`\`\n`;
    expect(maskedIn(source)).toEqual([
      [2, 1, 'fenced code'],
      [4, 1, 'fenced code'],
    ]);
    // In any case, as the parser reads a kind, with nothing else to find.
    expect(maskedIn('```\n<!-- @ASSERT-ABSENCE symbol="Y" -->\n```\n')).toEqual([[2, 1, 'fenced code']]);
  });

  it('is not one that is read, as a directive or as an error, and a document with none says nothing', () => {
    const read = parseDirectives(`${RULE}\n<!-- @assert-bogus -->\n`, context);
    expect(read.directives).toHaveLength(1);
    expect(read.errors).toHaveLength(1);
    expect(read.masked).toBeUndefined();
    expect(parseDirectives('# Nothing to see\n\n```\ncode\n```\n', context).masked).toBeUndefined();
  });

  it('reaches the report and its JSON, and fails nothing', async () => {
    const root = await makeTempRepo({
      'docs/a.md': `# A\n\n${RULE}\n\n\`\`\`md\n${RULE}\n\`\`\`\n\n    ${RULE}\n`,
      'src/a.ts': 'export {};\n',
    });
    try {
      const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });
      expect(report.ok).toBe(true);
      expect(report.summary.total).toBe(1);
      expect(report.maskedDirectives?.map(({ location, inside }) => [location.relativeFile, location.line, inside])).toEqual([
        ['docs/a.md', 6, 'fenced code'],
        ['docs/a.md', 9, 'indented code'],
      ]);
      const json = JSON.parse(formatJson(report)) as { maskedDirectives: unknown };
      expect(json.maskedDirectives).toEqual([
        { spec: { file: 'docs/a.md', line: 6, column: 1 }, inside: 'fenced code' },
        { spec: { file: 'docs/a.md', line: 9, column: 5 }, inside: 'indented code' },
      ]);
    } finally {
      await removeTempRepo(root);
    }
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

/*
 * What spec-core's scanner reads the CommonMark way, where the masking it
 * replaced did not (ADR-0002, amended 2026-09-26).
 */

describe('code spans and comments, read left to right', () => {
  it('keeps a backtick inside a comment, where it is a character', () => {
    // Whichever of a span and a comment opens first wins. The masking this
    // replaced paired the two backticks, and the rule searched for spaces.
    const { directives } = parseDirectives('<!-- @assert-absence target="src" symbol="`eval`" -->\n', context);
    expect(directives[0]?.attributes['symbol']).toBe('`eval`');
  });

  it('ends a code span with its paragraph, so a stray backtick hides nothing after it', () => {
    // A backtick that closes nothing is a character. Paired with the next one
    // anywhere in the document, it hid every directive between the two.
    expect(executed('Press ` to open the console.\n\n<!-- @assert-absence symbol="X" -->\n\nOr `.\n')).toEqual(['X']);
    // The control: within one paragraph a span still runs across lines.
    expect(executed('a `code\nstill code <!-- @assert-absence symbol="X" --> ` b\n')).toEqual([]);
  });

  it('opens no span on an escaped backtick', () => {
    expect(executed('Escape it: \\`, then <!-- @assert-absence symbol="X" --> and a `.\n')).toEqual(['X']);
  });

  it('opens no fence inside a comment, where a template shows one', () => {
    expect(executed('<!--\n```\n-->\n<!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
  });
});

describe('what is not read for directives, besides fences and spans', () => {
  it('masks indented code, outside a list', () => {
    expect(executed('para\n\n    <!-- @assert-absence symbol="X" -->\n')).toEqual([]);
    // Four columns inside a list item continue the item far more often than
    // they open code, and masking them would drop what is written there.
    expect(executed('- a\n\n    <!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
    // And indented code never interrupts a paragraph.
    expect(executed('para\n    <!-- @assert-absence symbol="X" -->\n')).toEqual(['X']);
  });

  it('masks the elements whose content is not Markdown, and no others', () => {
    expect(executed('<pre>\n<!-- @assert-absence symbol="X" -->\n</pre>\n<!-- @assert-absence symbol="Y" -->\n')).toEqual(['Y']);
    expect(executed('<script>\n<!-- @assert-absence symbol="X" -->\n</script>\n')).toEqual([]);
    // A decision written inside a collapsed section is still a decision.
    expect(executed('<details>\n<!-- @assert-absence symbol="X" -->\n</details>\n')).toEqual(['X']);
  });

  it('masks front matter, and reports what follows it where it is', () => {
    const { directives } = parseDirectives('---\nnote: <!-- @assert-absence symbol="X" -->\n---\n<!-- @assert-absence symbol="Y" -->\n', context);
    expect(directives.map((directive) => [directive.attributes['symbol'], directive.location.line])).toEqual([['Y', 4]]);
  });
});

describe('offsets through the scanner', () => {
  it('reports a directive after a byte-order mark in the column it always was', () => {
    // The scanner reads the text after the mark. Its offsets are shifted back,
    // so the mark stays the first character of the first line, as it is in the
    // file a person opens.
    const source = '﻿<!-- @assert-absence symbol="X" -->\n';
    expect(parseDirectives(source, context).directives[0]?.location).toMatchObject({ line: 1, column: 2 });
    expect(maskCode(source)).toBe(source);
  });

  it('keeps every line terminator where it was, a carriage return inside code included', () => {
    expect(maskCode('```\r\nx\r\n```\r\n')).toBe('   \r\n \r\n   \r\n');
    expect(parseDirectives('```\r\nx\r\n```\r\n<!-- @assert-absence symbol="X" -->\r\n', context).directives[0]?.location.line).toBe(4);
  });

  it('counts lines by line feeds, as a report always has', () => {
    // A lone carriage return ends a line to the scanner, which reads the fence
    // above as closed; a report still counts the lines a line feed ends.
    const { directives } = parseDirectives('```\rx\r```\r<!-- @assert-absence symbol="X" -->', context);
    expect(directives[0]?.location).toMatchObject({ line: 1, column: 11 });
  });
});
