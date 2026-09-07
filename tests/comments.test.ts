/**
 * Comment classification.
 *
 * The table below is the specification. Each source marks positions with
 * NEEDLE and states, in order, whether each one sits inside a comment. The
 * interesting rows are the ones where a comment marker appears inside a string:
 * reading those as comments would hide real code, so they must all come back
 * false. When the classifier is unsure it has to say "code", and these tests
 * exist to keep it that way.
 */

import { describe, expect, it } from 'vitest';

import { commentRanges, createCommentMask, syntaxFor } from '../src/comments.js';

/** Whether each NEEDLE in the source was classified as comment text. */
function classify(source: string, file: string): boolean[] {
  const mask = createCommentMask(source, file);
  const flags: boolean[] = [];
  for (let at = source.indexOf('NEEDLE'); at !== -1; at = source.indexOf('NEEDLE', at + 1)) {
    flags.push(mask.isComment(at));
  }
  return flags;
}

interface Case {
  name: string;
  file: string;
  source: string;
  /** One entry per NEEDLE, in source order. */
  expected: boolean[];
}

const CASES: Case[] = [
  {
    name: 'javascript line comment',
    file: 'a.ts',
    source: '// NEEDLE was removed\nconst x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    name: 'javascript block comment',
    file: 'a.js',
    source: '/* NEEDLE\n   still NEEDLE */\nconst x = NEEDLE;\n',
    expected: [true, true, false],
  },
  {
    name: 'a URL in a string does not open a comment',
    file: 'a.ts',
    source: 'const url = "http://example.com/docs";\nconst x = NEEDLE;\n',
    expected: [false],
  },
  {
    name: 'comment markers inside a string are text',
    file: 'a.ts',
    source: 'const s = "// NEEDLE /* NEEDLE */";\n',
    expected: [false, false],
  },
  {
    name: 'template literals are strings',
    file: 'a.ts',
    source: 'const s = `// NEEDLE`;\nconst x = NEEDLE;\n',
    expected: [false, false],
  },
  {
    name: 'an escaped quote does not end the string',
    file: 'a.ts',
    source: 'const s = "he said \\" // NEEDLE";\nconst x = NEEDLE;\n',
    expected: [false, false],
  },
  {
    name: 'jsx keeps counting after a closing tag',
    file: 'a.tsx',
    source: 'const a = <div>{value}</div>;\n// NEEDLE\nconst x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    // A trailing backslash ends a verbatim string but escapes the quote in a
    // normal one. Read it the normal way and the string swallows the rest of
    // the file, so the comment below has to come back true.
    name: 'a verbatim string ends at a backslash-quote',
    file: 'a.cs',
    source: 'var p = @"C:\\temp\\";\n// NEEDLE\nvar x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    name: 'c# verbatim strings still hide comment markers',
    file: 'a.cs',
    source: 'var p = @"// NEEDLE";\nvar x = NEEDLE;\n',
    expected: [false, false],
  },
  {
    name: 'rust block comments nest',
    file: 'a.rs',
    source: '/* outer /* inner */ NEEDLE */\nlet x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    name: 'rust raw strings hold comment markers',
    file: 'a.rs',
    source: 'let s = r#"// NEEDLE"#;\nlet x = NEEDLE;\n',
    expected: [false, false],
  },
  {
    // A lone quote is ordinary text inside r#"..."#, and the literal ends at
    // "#. Read the quotes as ordinary ones instead and they pair up wrongly,
    // leaving the last one open to run over the comment below.
    name: 'a hashed raw string may contain a quote',
    file: 'a.rs',
    source: 'let s = r#"say " once"#;\n// NEEDLE\nlet x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    name: 'an r-string ends at a backslash-quote',
    file: 'a.rs',
    source: 'let p = r"C:\\temp\\";\n// NEEDLE\nlet x = NEEDLE;\n',
    expected: [true, false],
  },
  {
    // Same trap in Go: a backslash means nothing inside backticks, so the
    // literal really does end and what follows really is a comment.
    name: 'a raw string ends at a backslash-backtick',
    file: 'a.go',
    source: 's := `\\`\n// NEEDLE\nx := NEEDLE\n',
    expected: [true, false],
  },
  {
    name: 'go raw strings still hide comment markers',
    file: 'a.go',
    source: 's := `// NEEDLE`\nx := NEEDLE\n',
    expected: [false, false],
  },
  {
    name: 'python hash comment',
    file: 'a.py',
    source: '# NEEDLE is gone\nx = NEEDLE\n',
    expected: [true, false],
  },
  {
    name: 'a docstring is a string, not a comment',
    file: 'a.py',
    source: '"""NEEDLE lives here"""\nx = NEEDLE\n',
    expected: [false, false],
  },
  {
    name: 'a hash inside a string is text',
    file: 'a.py',
    source: 'colour = "#fff NEEDLE"\n',
    expected: [false],
  },
  {
    name: 'sql double dash',
    file: 'a.sql',
    source: '-- NEEDLE dropped\nSELECT NEEDLE FROM t;\n',
    expected: [true, false],
  },
  {
    name: 'markup comment',
    file: 'a.html',
    source: '<!-- NEEDLE -->\n<div>NEEDLE</div>\n',
    expected: [true, false],
  },
  {
    name: 'an unterminated block comment runs to the end',
    file: 'a.ts',
    source: 'const a = 1;\n/* NEEDLE\n',
    expected: [true],
  },
  {
    name: 'an unterminated string keeps its contents as code',
    file: 'a.ts',
    source: 'const s = "NEEDLE\n',
    expected: [false],
  },
  {
    name: 'a comment on the last line needs no newline',
    file: 'a.ts',
    source: 'const a = 1;\n// NEEDLE',
    expected: [true],
  },
  {
    name: 'an unknown language classifies nothing',
    file: 'a.unknownext',
    source: '// NEEDLE\nNEEDLE\n',
    expected: [false, false],
  },
];

describe('comment classification', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(classify(testCase.source, testCase.file)).toEqual(testCase.expected);
    });
  }

  it('covers every case with at least one NEEDLE', () => {
    // Guards the table itself: an expectation of [] would assert nothing, and
    // a typo in NEEDLE is the easiest way to write a test that always passes.
    for (const testCase of CASES) {
      expect(testCase.expected.length, testCase.name).toBeGreaterThan(0);
      expect(testCase.source.split('NEEDLE').length - 1, testCase.name).toBe(testCase.expected.length);
    }
  });

  it('asserts both directions somewhere in the table', () => {
    const flags = CASES.flatMap((testCase) => testCase.expected);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });
});

describe('syntaxFor', () => {
  it('recognises a language per family', () => {
    expect(syntaxFor('a.ts')?.name).toBe('javascript');
    expect(syntaxFor('a.java')?.name).toBe('c-like');
    expect(syntaxFor('a.cs')?.name).toBe('c#');
    expect(syntaxFor('a.rs')?.name).toBe('rust');
    expect(syntaxFor('a.go')?.name).toBe('go');
    expect(syntaxFor('a.py')?.name).toBe('hash');
    expect(syntaxFor('a.sql')?.name).toBe('sql-like');
    expect(syntaxFor('a.html')?.name).toBe('markup');
  });

  it('ignores extension case', () => {
    expect(syntaxFor('A.TS')?.name).toBe('javascript');
  });

  it('returns null for an unknown extension', () => {
    expect(syntaxFor('a.unknownext')).toBeNull();
    expect(syntaxFor('Makefile')).toBeNull();
  });

  it('resolves the extension, not a dot anywhere in the path', () => {
    expect(syntaxFor('src/a.ts.snapshot')).toBeNull();
    expect(syntaxFor('my.dir/a.ts')?.name).toBe('javascript');
  });
});

describe('commentRanges', () => {
  const javascript = syntaxFor('a.ts');

  it('returns half-open ranges that exclude the following code', () => {
    const source = '// gone\nkeep';
    const ranges = commentRanges(source, javascript as NonNullable<typeof javascript>);
    expect(ranges).toEqual([[0, 7]]);
    expect(source.slice(0, 7)).toBe('// gone');
    // The newline is not part of the comment, and neither is what follows it.
    expect(source[7]).toBe('\n');
  });

  it('finds every comment in order', () => {
    const source = '/* a */ code // b\n/* c */';
    const ranges = commentRanges(source, javascript as NonNullable<typeof javascript>);
    expect(ranges.map(([start, end]) => source.slice(start, end))).toEqual(['/* a */', '// b', '/* c */']);
  });

  it('finds nothing in code that has no comments', () => {
    expect(commentRanges('const x = 1;\n', javascript as NonNullable<typeof javascript>)).toEqual([]);
  });
});

describe('createCommentMask', () => {
  it('reports whether the language was understood', () => {
    const known = createCommentMask('// x', 'a.ts');
    expect(known.classified).toBe(true);
    expect(known.syntax).toBe('javascript');

    const unknown = createCommentMask('// x', 'a.unknownext');
    expect(unknown.classified).toBe(false);
    expect(unknown.syntax).toBeNull();
  });

  it('answers offsets on either side of every boundary', () => {
    //             0123456789
    const source = 'a /* c */ b';
    const mask = createCommentMask(source, 'a.ts');
    expect(mask.isComment(0)).toBe(false);
    expect(mask.isComment(1)).toBe(false);
    expect(mask.isComment(2)).toBe(true);
    expect(mask.isComment(8)).toBe(true);
    expect(mask.isComment(9)).toBe(false);
    expect(mask.isComment(source.length - 1)).toBe(false);
  });

  it('is correct across many comments, where the binary search matters', () => {
    // 200 alternating pairs: /*i*/ then code i. Every offset is checked
    // against a linear scan of the same ranges, so an off-by-one in the
    // search cannot hide behind a lucky midpoint.
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) parts.push(`/*${i}*/x${i};`);
    const source = parts.join('\n');
    const mask = createCommentMask(source, 'a.ts');
    const ranges = commentRanges(source, syntaxFor('a.ts') as NonNullable<ReturnType<typeof syntaxFor>>);
    const linear = (offset: number): boolean => ranges.some(([start, end]) => offset >= start && offset < end);

    for (let offset = 0; offset < source.length; offset++) {
      expect(mask.isComment(offset), `offset ${offset}`).toBe(linear(offset));
    }
  });
});

describe('formats with nothing to classify', () => {
  it('treats JSON as understood but comment-free', () => {
    const mask = createCommentMask('{ "a": "// not a comment" }', 'package.json');
    expect(mask.classified).toBe(true);
    expect(mask.syntax).toBe('none');
    expect(mask.isComment(8)).toBe(false);
  });

  it('reads comments in jsonc, which is named for having them', () => {
    expect(classify('{\n  // NEEDLE\n  "a": NEEDLE\n}\n', 'tsconfig.jsonc')).toEqual([true, false]);
  });

  it('reads html comments in markdown', () => {
    expect(classify('<!-- NEEDLE -->\n\nProse mentioning NEEDLE.\n', 'notes.md')).toEqual([true, false]);
  });
});
