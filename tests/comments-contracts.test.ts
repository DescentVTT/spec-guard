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
    ['a.toml', 'hash'],
    ['a.tf', 'hash'],
    ['a.pl', 'hash'],
    ['a.r', 'hash'],
    // A shell and YAML both take `#` as a comment only where a word starts.
    ['a.sh', 'shell-like'],
    ['a.bash', 'shell-like'],
    ['a.zsh', 'shell-like'],
    ['a.yaml', 'shell-like'],
    ['a.yml', 'shell-like'],
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
    // .NET's XML: a ProjectReference commented out of a project file is not one.
    ['a.csproj', 'markup'],
    ['a.fsproj', 'markup'],
    ['a.vbproj', 'markup'],
    ['a.props', 'markup'],
    ['a.targets', 'markup'],
    ['a.slnx', 'markup'],
    ['a.nuspec', 'markup'],
    ['a.resx', 'markup'],
    ['a.xaml', 'markup'],
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
    ['shell-like', { line: ['#'], block: [], nested: false }],
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
    for (const file of ['a.ts', 'a.c', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sh', 'a.sql', 'a.md', 'a.json']) {
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
    ['c#', ['"""', '@$"', '@"', '"', "'"]],
    // One raw form, `r` and any number of hashes, before the ordinary quotes.
    ['rust', ['r', '"', "'"]],
    ['go', ['"', "'", '`']],
    // Triple quotes first: a Python docstring is a string, not a comment, and
    // reading it as code is the conservative direction.
    ['hash', ['"""', "'''", '"', "'"]],
    ['shell-like', ["$'", '"', "'"]],
    ['sql-like', ['"', "'"]],
    ['markup', []],
    ['none', []],
  ])('%s opens strings with exactly %j, in that order', (name, opens) => {
    expect(syntaxNamed(name)?.strings.map((rule) => rule.open)).toEqual(opens);
  });

  it('closes a c# raw string with its own run of quotes, and verbatim strings with a plain quote, honouring no backslash', () => {
    expect(syntaxNamed('c#')?.strings.slice(0, 3)).toEqual([
      { open: '"""', close: '"""', escape: false, run: true },
      { open: '@$"', close: '"', escape: false },
      { open: '@"', close: '"', escape: false },
    ]);
  });

  it('reads a rust raw string by its hashes, and a character literal as a line at most', () => {
    expect(syntaxNamed('rust')?.strings).toEqual([
      { open: 'r', close: '"', escape: false, hashes: true },
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: true, singleLine: true },
    ]);
  });

  it('honours a backslash in a shell string only where the shell does', () => {
    // Nothing escapes inside '...', in a shell or in YAML; $'...' is the form
    // that exists to allow it.
    expect(syntaxNamed('shell-like')?.strings).toEqual([
      { open: "$'", close: "'", escape: true },
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: false },
    ]);
  });

  const PROFILES = ['javascript', 'c-like', 'c#', 'rust', 'go', 'hash', 'shell-like', 'sql-like', 'markup', 'none'];

  it.each([
    ['lifetimes', ['rust']],
    // C++ and C23 alone. JavaScript, C# and Go share C's comments, not this.
    ['digitSeparators', ['c-like']],
    ['wordComments', ['shell-like']],
  ] as const)('reads %s in exactly %j', (flag, names) => {
    expect(PROFILES.filter((name) => syntaxNamed(name)?.[flag] === true)).toEqual(names);
  });

  it('names every profile the table above walks', () => {
    for (const file of ['a.ts', 'a.c', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sh', 'a.sql', 'a.md', 'a.json']) {
      expect(PROFILES, file).toContain(syntaxFor(file)?.name);
    }
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

describe('c# strings since C# 11', () => {
  const CS = syntaxNamed('c#') as NonNullable<ReturnType<typeof syntaxNamed>>;

  it('reads a raw string holding a quote as one string', () => {
    // Read as "" and then a string of its own, the inner quote closed it early
    // and everything after `b` sat outside a string.
    const source = 'var s = """a "b" c"""; // note';
    const result = lexRanges(source, CS);

    expect(result.strings).toEqual([[8, 21]]);
    expect(result.comments).toEqual([[23, source.length]]);
    expect(result.unterminated).toBe(false);
  });

  it('closes a raw string of four quotes only at four, so it can hold three', () => {
    // It used to run to the end of the file, and every using after it was lost.
    const source = 'var s = """"\n  x """ y\n  """"; // note';
    const result = lexRanges(source, CS);

    expect(result.strings).toEqual([[8, 29]]);
    expect(result.comments).toEqual([[31, source.length]]);
    expect(result.unterminated).toBe(false);
  });

  it('honours no backslash in a raw string, which has no escapes at all', () => {
    const source = 'var p = """C:\\"""; // note';
    const result = lexRanges(source, CS);

    expect(result.strings).toEqual([[8, 17]]);
    expect(result.comments).toEqual([[19, source.length]]);
  });

  it('takes a run of any length, not only the lengths someone listed', () => {
    const source = 'var s = """""a """" b"""""; x';
    expect(lexRanges(source, CS).strings).toEqual([[8, 26]]);
  });

  it('reads an empty string as an empty string, not as the start of a run', () => {
    // Only a raw string's opener runs: a plain quote that did would read `""`
    // as the opener of a string closed by `""`, and lose the rest of the file.
    const source = 'var a = ""; var b = "x"; // note';
    const result = lexRanges(source, CS);

    expect(result.strings).toEqual([[8, 10], [20, 23]]);
    expect(result.unterminated).toBe(false);
  });

  it('reports a raw string that never closes as a lost place', () => {
    expect(lexRanges('var s = """\n  open "" \n', CS).unterminated).toBe(true);
  });

  it.each([
    // `@$"` used to read as `@`, `$` and an ordinary string, whose backslash
    // escaped the closing quote.
    ['@$"', 'var p = @$"C:\\"; // note', 8],
    ['$@"', 'var p = $@"C:\\"; // note', 9],
  ])('honours no backslash in an interpolated verbatim string opened %s', (_prefix, source, start) => {
    const result = lexRanges(source, CS);

    expect(result.strings).toEqual([[start, 15]]);
    expect(result.comments).toEqual([[17, source.length]]);
    expect(result.unterminated).toBe(false);
  });
});

/** What a scan read as literals, comments and lost, as text. */
function read(source: string, name: string) {
  const result = lexRanges(source, syntaxNamed(name) as NonNullable<ReturnType<typeof syntaxNamed>>);
  const text = (ranges: ReadonlyArray<readonly [number, number]>) => ranges.map(([start, end]) => source.slice(start, end));
  return { strings: text(result.strings), comments: text(result.comments), unterminated: result.unterminated };
}

describe('rust quotes that are not character literals', () => {
  // Every source here ends in a contraction, the trap from the trial: a quote
  // misread as opening a character literal closes on that apostrophe instead,
  // and everything between becomes the literal.
  it.each([
    ['a static lifetime', "fn id(&self) -> &'static str { name }"],
    ['the anonymous lifetime', "impl Iterator for Lines<'_> {}"],
    ['a lifetime parameter', "struct Parser<'a> { rest: &'a str }"],
    ['lifetime bounds', "fn f<'a, 'b>(x: &'a str) -> &'b str where 'a: 'b { x }"],
    ['a lifetime in a trait object', 'fn lines(t: &str) -> Box<dyn Iterator<Item = &str> + \'_> { todo!() }'],
    ['a loop label', "'outer: loop { break 'outer; }"],
    ['a label on a block', "let v = 'done: { break 'done 1; };"],
    ['a lifetime with a non-ascii name', "fn f<'λ>(x: &'λ str) {}"],
  ])('reads %s as code', (_name, code) => {
    expect(read(`${code} // it's`, 'rust')).toEqual({ strings: [], comments: ["// it's"], unterminated: false });
  });

  it('reads the trial file: a lifetime, a comment with a contraction, and the code between', () => {
    const source = "fn id(&self) -> &'static str {\n    \"rules\"\n}\n\nconst X: u8 = 1;\n// don't\n";
    expect(read(source, 'rust')).toEqual({ strings: ['"rules"'], comments: ["// don't"], unterminated: false });
  });

  it.each([
    ["'a'", "'a'"],
    ["'_'", "'_'"],
    ["'λ'", "'λ'"],
    ["'\\''", "'\\''"],
    ['\'"\'', '\'"\''],
    ["'\\\\'", "'\\\\'"],
    ["'\\u{1F600}'", "'\\u{1F600}'"],
    ["b'\\''", "'\\''"],
  ])('reads %s as a character literal', (literal, captured) => {
    expect(read(`let c = ${literal}; // it's`, 'rust')).toEqual({ strings: [captured], comments: ["// it's"], unterminated: false });
  });

  it('reads a lifetime whole, so its last letter opens no raw string', () => {
    // A macro's input is tokens, and there a lifetime can sit against a string:
    // rustc reads `'xr` and then "a\"b", not `'x` and a raw string r"a\".
    expect(read('m!(\'xr"a\\"b"); // note', 'rust')).toEqual({
      strings: ['"a\\"b"'],
      comments: ['// note'],
      unterminated: false,
    });
  });

  it('ends a character literal left open at its line, and reports the lost place', () => {
    // No valid file has one. What it costs is now a line rather than the file:
    // the comment below is read, and the flag still says something went wrong.
    expect(read("let c = '  x;\n// note\n", 'rust')).toEqual({ strings: ["'  x;"], comments: ['// note'], unterminated: true });
  });

  it('lets a string run over lines, which only a character literal cannot', () => {
    expect(read('let s = "one\ntwo"; // note', 'rust')).toEqual({ strings: ['"one\ntwo"'], comments: ['// note'], unterminated: false });
  });
});

describe('rust raw strings', () => {
  it.each([
    ['no hashes, and a backslash', 'r"C:\\"'],
    ['one hash, holding a quote', 'r#"say "hi""#'],
    ['two hashes, holding a quote and a hash', 'r##"a "# b"##'],
    ['three hashes, holding two', 'r###"a "## b"###'],
    ['nothing at all', 'r#""#'],
  ])('reads a raw string with %s', (_name, literal) => {
    expect(read(`let s = ${literal}; // it's`, 'rust')).toEqual({ strings: [literal], comments: ["// it's"], unterminated: false });
  });

  it.each([
    ['byte', 'br##"a "# b"##'],
    ['C', 'cr#"a "b"#'],
  ])('reads a raw %s string by the same rule', (_name, literal) => {
    expect(read(`let s = ${literal}; // it's`, 'rust').strings).toEqual([literal.slice(1)]);
  });

  it('reads a raw identifier as an identifier', () => {
    // `r#` with no quote after its hashes opens nothing: this is a field named
    // `type`, and the string after it is an ordinary one.
    expect(read('let r#type = "a\\"b"; // it\'s', 'rust')).toEqual({ strings: ['"a\\"b"'], comments: ["// it's"], unterminated: false });
  });

  it('reads the r of a word as a letter', () => {
    expect(read('for x in xs { f("C:\\\\"); } // it\'s', 'rust').strings).toEqual(['"C:\\\\"']);
  });

  it('reports a raw string whose closer is short of hashes as a lost place', () => {
    expect(read('let s = r##"a "# b"#;\n', 'rust')).toEqual({ strings: ['r##"a "# b"#;\n'], comments: [], unterminated: true });
  });
});

describe('digit separators in C++ and C23', () => {
  it.each([
    ["100'000"],
    ["1'000'000"],
    // A group after a separator can start with a letter, so the number is read
    // back to where it started, across the separators before it.
    ["0xFFFF'FFFF'FFFF"],
    ["0b1010'1010"],
    ["3.141'592"],
  ])('reads %s as one number', (number) => {
    expect(read(`auto n = ${number}; // it's`, 'c-like')).toEqual({ strings: [], comments: ["// it's"], unterminated: false });
  });

  it('reads a number at the very start of the file', () => {
    expect(read("1'0; // it's", 'c-like').strings).toEqual([]);
  });

  it('still reads a character literal whose prefix ends in a digit', () => {
    expect(read('auto a = u8\'a\'; auto b = L\'"\'; // it\'s', 'c-like')).toEqual({
      strings: ["'a'", '\'"\''],
      comments: ["// it's"],
      unterminated: false,
    });
  });

  it.each(['javascript', 'c#', 'go'])('is not a rule for %s, which shares only C comments', (name) => {
    // A quote after a number is no valid code in these either; a misread file
    // is what reaches one, and a rule should not change which wrong answer it
    // gets.
    expect(read("x = 1'a # b'", name).strings).toEqual(["'a # b'"]);
  });
});

describe('a hash inside a word, in a shell and in YAML', () => {
  it.each([
    ['a prefix removal', 'name=${file#v} # tag'],
    ['a basename', 'name=${path##*/} # base'],
    ['an array length', 'count=${#items[@]} # items'],
    ['the argument count', 'if [ $# -eq 0 ]; then exit 1; fi # none'],
    ['a URL fragment in YAML', 'url: https://example.com/docs#top # docs'],
  ])('reads %s as code, up to the comment after it', (_name, source) => {
    expect(read(source, 'shell-like').comments).toEqual([source.slice(source.lastIndexOf('# '))]);
  });

  it.each([
    ['at the start of the file', '# note\nx=1\n'],
    ['at the start of a line', 'x=1\n# note\n'],
    ['after a space', 'x=1 # note\n'],
    ['after a tab', 'x=1\t# note\n'],
  ])('opens a comment %s', (_name, source) => {
    expect(read(source, 'shell-like').comments).toEqual(['# note']);
  });

  it('reads a comment written against code as code, the direction that fails loudly', () => {
    expect(read('x=1;# note\n', 'shell-like').comments).toEqual([]);
  });

  it('still opens one anywhere in Python, which says so', () => {
    expect(read('x=1# note\n', 'hash').comments).toEqual(['# note']);
  });

  it.each([
    ['a single-quoted string ending in a backslash', "'C:\\'"],
    ['a double-quoted string with escaped quotes', '"say \\"hi\\""'],
    ['an ANSI-C string with an escaped quote', "$'it\\'s'"],
    ['a quote straight after a number', "'x # y'"],
  ])('closes %s where the shell does', (_name, literal) => {
    const source = `echo 2${literal} # note`;
    expect(read(source, 'shell-like')).toEqual({ strings: [literal], comments: ['# note'], unterminated: false });
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
