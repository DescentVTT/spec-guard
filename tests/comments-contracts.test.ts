/**
 * The comment lexer's tables and its "I lost my place" flag.
 *
 * Two gaps, both of the same kind: something is only ever read for its effect
 * on a match count, so anything it says that a count cannot see goes unchecked.
 *
 * The profiles are one. Which delimiters a language has, whether its block
 * comments nest, and which extensions map to which profile decide what counts
 * as code in every file spec-guard reads - and half of the table was pinned
 * only by whichever language a test happened to use.
 *
 * The `unterminated` flag is the other. It is how a caller learns that the scan
 * ran off the end of a construct and everything after it is a guess. Every test
 * asserted the ranges; none asserted that a well-formed file reports a scan
 * that stayed in step, so a lexer that cried wolf on every file would have
 * passed.
 */

import { describe, expect, it } from 'vitest';

import { commentRanges, createCommentMask, lexRanges, syntaxFor, syntaxNamed } from '../src/comments.js';

/* ------------------------------------------------------------ the profiles */

describe('which language an extension is', () => {
  it.each([
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.ts', 'javascript'],
    ['a.mts', 'javascript'],
    ['a.cts', 'javascript'],
    ['a.tsx', 'javascript'],
    ['a.c', 'c-like'],
    ['a.h', 'c-like'],
    ['a.cc', 'c-like'],
    ['a.cpp', 'c-like'],
    ['a.cxx', 'c-like'],
    ['a.hpp', 'c-like'],
    ['a.java', 'c-like'],
    ['a.kt', 'c-like'],
    ['a.kts', 'c-like'],
    ['a.scala', 'c-like'],
    ['a.swift', 'c-like'],
    ['a.dart', 'c-like'],
    ['a.php', 'c-like'],
    ['a.m', 'c-like'],
    ['a.mm', 'c-like'],
    ['a.zig', 'c-like'],
    ['a.cs', 'c#'],
    ['a.csx', 'c#'],
    ['a.rs', 'rust'],
    ['a.go', 'go'],
    ['a.py', 'hash'],
    ['a.pyi', 'hash'],
    ['a.rb', 'hash'],
    ['a.sh', 'hash'],
    ['a.bash', 'hash'],
    ['a.zsh', 'hash'],
    ['a.yaml', 'hash'],
    ['a.yml', 'hash'],
    ['a.toml', 'hash'],
    ['a.tf', 'hash'],
    ['a.pl', 'hash'],
    ['a.r', 'hash'],
    ['a.sql', 'sql-like'],
    ['a.lua', 'sql-like'],
    ['a.hs', 'sql-like'],
    ['a.elm', 'sql-like'],
    ['a.html', 'markup'],
    ['a.htm', 'markup'],
    ['a.xml', 'markup'],
    ['a.svg', 'markup'],
    ['a.vue', 'markup'],
    ['a.svelte', 'markup'],
    ['a.md', 'markup'],
    ['a.markdown', 'markup'],
    // Named for the comments it allows, so it gets the C-style reader.
    ['a.jsonc', 'c-like'],
    ['a.json', 'none'],
    ['a.txt', 'none'],
    ['a.csv', 'none'],
    ['a.tsv', 'none'],
    ['a.lock', 'none'],
    ['a.log', 'none'],
  ])('reads %s as %s', (file, name) => {
    expect(syntaxFor(file)?.name).toBe(name);
  });

  it('is case-insensitive about the extension', () => {
    expect(syntaxFor('A.TS')?.name).toBe('javascript');
  });

  it('leaves an extension it does not know unclassified', () => {
    // Unclassified, not "no comments": guessing either way is how a match in a
    // language nobody taught it gets silently reclassified.
    expect(syntaxFor('a.wat')).toBeNull();
    expect(syntaxFor('Makefile')).toBeNull();
  });
});

describe('the profiles themselves', () => {
  it.each([
    ['javascript', { line: ['//'], block: [['/*', '*/']], nested: false }],
    ['c-like', { line: ['//'], block: [['/*', '*/']], nested: false }],
    ['c#', { line: ['//'], block: [['/*', '*/']], nested: false }],
    // Rust block comments nest, so /* /* */ */ is one comment, not one and a
    // half - and it is the only profile here for which that is true.
    ['rust', { line: ['//'], block: [['/*', '*/']], nested: true }],
    ['go', { line: ['//'], block: [['/*', '*/']], nested: false }],
    ['hash', { line: ['#'], block: [], nested: false }],
    ['sql-like', { line: ['--'], block: [['/*', '*/']], nested: false }],
    ['markup', { line: [], block: [['<!--', '-->']], nested: false }],
    ['none', { line: [], block: [], nested: false }],
  ])('%s has exactly these delimiters', (name, shape) => {
    expect(syntaxNamed(name)).toMatchObject(shape);
  });

  it('gives every profile a name that finds it again', () => {
    // Two ways of answering "which language is this" is one more than the
    // number that can be right, so the by-name table is derived from the
    // by-extension one; this is the assertion that they agree.
    for (const file of ['a.ts', 'a.c', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sql', 'a.md', 'a.json']) {
      const syntax = syntaxFor(file);
      expect(syntaxNamed(syntax?.name ?? ''), file).toBe(syntax);
    }
  });

  it('knows nothing by a name it does not have', () => {
    expect(syntaxNamed('cobol')).toBeNull();
  });

  it.each([
    ['javascript', ['"', "'", '`']],
    ['c-like', ['"', "'"]],
    ['c#', ['@"', '"', "'"]],
    ['rust', ['r#"', 'r"', '"', "'"]],
    ['go', ['"', "'", '`']],
    // Triple quotes first: a Python docstring is a string, not a comment, and
    // reading it as code is the conservative direction.
    ['hash', ['"""', "'''", '"', "'"]],
    ['sql-like', ['"', "'"]],
    ['markup', []],
    ['none', []],
  ])('%s opens strings with exactly %j, in that order', (name, opens) => {
    expect(syntaxNamed(name)?.strings.map((rule) => rule.open)).toEqual(opens);
  });

  it('closes a c# verbatim string with a plain quote, and does not honour a backslash in it', () => {
    const verbatim = syntaxNamed('c#')?.strings[0];
    expect(verbatim).toEqual({ open: '@"', close: '"', escape: false });
  });

  it('closes a rust raw string with the matching hash form', () => {
    expect(syntaxNamed('rust')?.strings.slice(0, 2)).toEqual([
      { open: 'r#"', close: '"#', escape: false },
      { open: 'r"', close: '"', escape: false },
    ]);
  });

  it('honours a backslash in an ordinary quoted string, and in a python docstring', () => {
    expect(syntaxNamed('javascript')?.strings.find((rule) => rule.open === '"')?.escape).toBe(true);
    expect(syntaxNamed('hash')?.strings.find((rule) => rule.open === '"""')).toEqual({
      open: '"""',
      close: '"""',
      escape: true,
    });
  });

  it('does not honour a backslash in a go backtick string', () => {
    // A raw string literal in Go has no escapes at all: `a\` is a complete,
    // two-character string, and treating the backslash as an escape swallows
    // the closing backtick and everything after it.
    expect(syntaxNamed('go')?.strings.find((rule) => rule.open === '`')?.escape).toBe(false);
  });
});

/* ------------------------------------------------ the lost-my-place flag */

const JS = syntaxNamed('javascript');

function lex(source: string) {
  return lexRanges(source, JS as NonNullable<typeof JS>);
}

describe('a scan that stayed in step', () => {
  it.each([
    ['a line comment', 'const a = 1; // note\n'],
    ['a block comment', '/* note */ const a = 1;\n'],
    ['an empty block comment', '/**/\n'],
    ['a closed string', "const a = 'text';\n"],
    ['a closed template', 'const a = `text`;\n'],
    ['an escaped quote inside a string', "const a = 'it\\'s';\n"],
    ['a quote inside a comment', "// it's fine\n"],
    ['no comments or strings at all', 'const a = 1;\n'],
    ['an empty file', ''],
  ])('reports no lost place for %s', (_name, source) => {
    // The flag, not the ranges. A lexer that reported every file as
    // unterminated would produce exactly the ranges every other test asserts.
    expect(lex(source).unterminated).toBe(false);
  });
});

describe('a scan that ran off the end', () => {
  it.each([
    ['an unterminated block comment', '/* never closed\n'],
    ['an unterminated string', "const a = 'never closed;\n"],
    ['an unterminated template', 'const a = `never closed;\n'],
    ['a string ending in a trailing escape', "const a = 'never closed\\"],
  ])('reports a lost place for %s', (_name, source) => {
    expect(lex(source).unterminated).toBe(true);
  });

  it('runs an unterminated construct to the end of the file rather than nowhere', () => {
    const source = '/* never closed';
    const [range] = lex(source).comments;

    expect(range).toEqual([0, source.length]);
  });

  it('runs an unterminated string to the end of the file too', () => {
    const source = "x = 'never closed";
    const [range] = lex(source).strings;

    expect(range).toEqual([4, source.length]);
  });
});

describe('nested block comments', () => {
  const RUST = syntaxNamed('rust');

  it('closes only at the last matching delimiter', () => {
    const source = '/* a /* b */ c */ code';
    expect(commentRanges(source, RUST as NonNullable<typeof RUST>)).toEqual([[0, 17]]);
  });

  it('reports an inner comment left open as a lost place', () => {
    const source = '/* a /* b */';
    const result = lexRanges(source, RUST as NonNullable<typeof RUST>);

    expect(result.unterminated).toBe(true);
    expect(result.comments).toEqual([[0, source.length]]);
  });

  it('reports a balanced nest as a scan that stayed in step', () => {
    expect(lexRanges('/* a /* b */ c */', RUST as NonNullable<typeof RUST>).unterminated).toBe(false);
  });

  it('does not nest for a language whose comments do not', () => {
    // The same source in C: the first `*/` ends it, and ` c */` is code.
    const C = syntaxNamed('c-like');
    expect(commentRanges('/* a /* b */ c */', C as NonNullable<typeof C>)).toEqual([[0, 12]]);
  });
});

describe('the mask a file gets', () => {
  it('says it classified a file whose language it knows', () => {
    expect(createCommentMask('// note\n', 'a.ts').classified).toBe(true);
  });

  it('says it did not classify one it does not', () => {
    expect(createCommentMask('// note\n', 'a.wat').classified).toBe(false);
  });

  it('treats every offset in an unclassified file as code', () => {
    const mask = createCommentMask('// note\n', 'a.wat');
    expect(mask.isComment(0)).toBe(false);
    expect(mask.isComment(3)).toBe(false);
  });
});
