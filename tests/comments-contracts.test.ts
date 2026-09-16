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

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { commentRanges, createCommentMask, lexRanges, syntaxFor, syntaxNamed } from '../src/comments.js';
import { tokenize } from '../src/imports.js';

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
    // A shell and YAML both take `#` as a comment only where a word starts,
    // and part company over quotes: YAML's plain scalars are unquoted text.
    ['a.sh', 'shell'],
    ['a.bash', 'shell'],
    ['a.zsh', 'shell'],
    ['a.yaml', 'yaml'],
    ['a.yml', 'yaml'],
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
    ['shell', { line: ['#'], block: [], nested: false }],
    ['yaml', { line: ['#'], block: [], nested: false }],
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
    for (const file of ['a.ts', 'a.c', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sh', 'a.yml', 'a.sql', 'a.md', 'a.json']) {
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
    ['shell', ["$'", '"', "'"]],
    // No `$'…'` in YAML: that is a shell's ANSI-C quoting, and here it is text.
    ['yaml', ['"', "'"]],
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

  it.each([
    // Nothing escapes inside '...', in a shell or in YAML; $'...' is the shell
    // form that exists to allow it, and YAML has no counterpart.
    ['shell', [{ open: "$'", close: "'", escape: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: false }]],
    ['yaml', [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: false, doubled: true }]],
  ])('honours a backslash in a %s string only where that language does', (name, rules) => {
    expect(syntaxNamed(name)?.strings).toEqual(rules);
  });

  const PROFILES = ['javascript', 'c-like', 'c#', 'rust', 'go', 'hash', 'shell', 'yaml', 'sql-like', 'markup', 'none'];

  it.each([
    ['lifetimes', ['rust']],
    // C++ and C23 alone. JavaScript, C# and Go share C's comments, not this.
    ['digitSeparators', ['c-like']],
    ['wordComments', ['shell', 'yaml']],
    // The shell's quotes open anywhere, because `dir='C:\'` needs them to.
    ['wordQuotes', ['yaml']],
    ['regexLiterals', ['javascript']],
    ['jsxText', ['javascript']],
  ] as const)('reads %s in exactly %j', (flag, names) => {
    expect(PROFILES.filter((name) => syntaxNamed(name)?.[flag] === true)).toEqual(names);
  });

  it('names every profile the table above walks', () => {
    for (const file of ['a.ts', 'a.c', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sh', 'a.yml', 'a.sql', 'a.md', 'a.json']) {
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

  it.each([
    ['c-like', '"say \\"hi\\""'],
    ['c-like', "'\\''"],
    ['c#', '"say \\"hi\\""'],
    ['go', '"say \\"hi\\""'],
    ['sql-like', '"say \\"hi\\""'],
  ])('honours a backslash inside a %s string, so %s is one literal', (name, literal) => {
    // The behaviour behind the escape flags the profiles share. Read without
    // them the literal ends at its first inner quote, and the rest of the line
    // - a comment marker included - is read as something else.
    expect(read(`x = ${literal}; // note`, name).strings).toEqual([literal]);
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
    ['a prefix removal', 'shell', 'name=${file#v} # tag'],
    ['a basename', 'shell', 'name=${path##*/} # base'],
    ['an array length', 'shell', 'count=${#items[@]} # items'],
    ['the argument count', 'shell', 'if [ $# -eq 0 ]; then exit 1; fi # none'],
    ['a URL fragment in YAML', 'yaml', 'url: https://example.com/docs#top # docs'],
  ])('reads %s as code, up to the comment after it', (_name, profile, source) => {
    expect(read(source, profile).comments).toEqual([source.slice(source.lastIndexOf('# '))]);
  });

  it.each([
    ['at the start of the file', '# note\nx=1\n'],
    ['at the start of a line', 'x=1\n# note\n'],
    ['after a space', 'x=1 # note\n'],
    ['after a tab', 'x=1\t# note\n'],
  ])('opens a comment %s', (_name, source) => {
    expect(read(source, 'shell').comments).toEqual(['# note']);
  });

  it.each(['shell', 'yaml'])('reads a comment written against code as code in %s, the direction that fails loudly', (profile) => {
    expect(read('x=1;# note\n', profile).comments).toEqual([]);
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
    // Mid-word, every one of them: a shell quote opens wherever it is written.
    const source = `echo 2${literal} # note`;
    expect(read(source, 'shell')).toEqual({ strings: [literal], comments: ['# note'], unterminated: false });
  });
});

describe('a quote inside a YAML plain scalar', () => {
  it.each([
    ['an apostrophe in a word', "- name: Build the decoder's artefact\n"],
    ['two of them, lines apart', "- name: Don't stop\n- name: it's fine\n"],
    ['one in a block scalar', "run: |\n  echo we can't\n"],
    ['an apostrophe at the end of a word', '- name: the decoders\' artefacts\n'],
  ])('reads %s as text, not as a string opening', (_name, source) => {
    expect(read(source, 'yaml').strings).toEqual([]);
  });

  it('keeps reading comments after one, which is what the runaway string cost', () => {
    // On 0.10.3 the apostrophe in `decoder's` opened a literal that closed on
    // the one in `Don't`, and the comment between them was read as code.
    const source = "- name: Build the decoder's artefact\n# note\n- name: Don't stop\n";
    expect(read(source, 'yaml')).toEqual({ strings: [], comments: ['# note'], unterminated: false });
  });

  it.each([
    ['after a key', "key: 'a # b'"],
    ['at the start of a line', "'a # b'"],
    ['after a dash', "- 'a # b'"],
  ])('still opens a quoted scalar %s', (_name, code) => {
    expect(read(`${code}\n# note\n`, 'yaml')).toEqual({ strings: ["'a # b'"], comments: ['# note'], unterminated: false });
  });

  it('reads a double-quoted scalar, and the apostrophe inside it', () => {
    expect(read('key: "it\'s # fine"\n# note\n', 'yaml')).toEqual({
      strings: ['"it\'s # fine"'],
      comments: ['# note'],
      unterminated: false,
    });
  });

  it("reads YAML's own escape, a doubled quote, as part of the scalar", () => {
    // Ending at the first of the pair would leave `s # x` outside any string,
    // where the `#` opens a comment over the rest of the line.
    expect(read("key: 'it''s # x'\n# note\n", 'yaml')).toEqual({
      strings: ["'it''s # x'"],
      comments: ['# note'],
      unterminated: false,
    });
  });

  it('does not double a quote where the language has no such escape', () => {
    // In a shell `'a'' # b'` is two strings written against each other, and
    // the quote that opens the second one does so mid-word.
    expect(read("echo 'a'' # b'", 'shell').strings).toEqual(["'a'", "' # b'"]);
  });

  it('keeps a shell reading a mid-word quote as a string, where it is one', () => {
    expect(read("dir='C:\\' # note", 'shell').strings).toEqual(["'C:\\'"]);
  });
});

describe('javascript regular expressions that hold a quote', () => {
  it.each([
    ['an apostrophe', "/'/"],
    ['a double quote', '/"/'],
    ['a character class of both', '/[\'"]/'],
    ['an escaped apostrophe', "/\\'/"],
    ['a backtick', '/`/'],
    ['a class holding a slash', '/[/"]/'],
    // The closing bracket matters: with the class still open, the `/` after it
    // closes nothing and the `"` opens a string instead.
    ['a class that ends before the closer', '/[/]"/'],
    ['an escaped slash and a quote', '/\\/"/'],
    ['flags after it', "/'/gi"],
  ])('reads %s as a literal, so the comment after it is still a comment', (_name, literal) => {
    // Every one of these opened a string on 0.11.0's predecessor, which closed
    // on the next quote in the file - and the comment below went unread.
    const source = `const re = ${literal};\n// note\n`;
    expect(read(source, 'javascript')).toEqual({ strings: [literal.replace(/[gi]+$/, '')], comments: ['// note'], unterminated: false });
  });

  it('reads the regular expression this repository lost its place on', () => {
    // src/parser.ts: the `"` opened a string that ran on for 138 characters,
    // and the file reported a scan that never recovered.
    const source = 'const quoted = /^\\\\(["\'\\\\])(.*?)\\\\1/.exec(text);\n// note\n';
    expect(read(source, 'javascript').comments).toEqual(['// note']);
  });

  it.each([
    ['a division by a variable', 'const half = total / count; // note'],
    ['a division by a number', 'const half = total / 2; // note'],
    ['two divisions in a row', 'const ratio = a / b / c; // note'],
    ['a division after a call', 'const n = size() / 2; // note'],
    ['a division after an index', 'const n = xs[0] / 2; // note'],
  ])('reads %s as a division, not as a literal', (_name, source) => {
    expect(read(source, 'javascript')).toEqual({ strings: [], comments: ['// note'], unterminated: false });
  });

  it.each([
    ['after a keyword', 'if (x) return /a"b/; // note', '/a"b/'],
    ['after typeof', 'const t = typeof /a"b/; // note', '/a"b/'],
    ['after an equals', 'const re = /a"b/; // note', '/a"b/'],
    ['after a comma', 'f(x, /a"b/); // note', '/a"b/'],
    ['after an open brace', '{ /a"b/.test(x); } // note', '/a"b/'],
    ['after a colon', 'const o = { re: /a"b/ }; // note', '/a"b/'],
    ['after a pipe', 'const r = y || /a"b/; // note', '/a"b/'],
  ])('opens one %s', (_name, source, literal) => {
    expect(read(source, 'javascript').strings).toEqual([literal]);
  });

  it('opens one at the very start of a file', () => {
    expect(read('/"/.test(x); // note', 'javascript')).toEqual({ strings: ['/"/'], comments: ['// note'], unterminated: false });
  });

  it('opens one after nothing but whitespace', () => {
    expect(read('  /"/.test(x); // note', 'javascript').strings).toEqual(['/"/']);
  });

  it.each([
    ['a tab', 'x;\n\t/"/.test(y); // note'],
    ['a carriage return', 'x;\r\n/"/.test(y); // note'],
  ])('looks past %s to the token before it', (_name, source) => {
    expect(read(source, 'javascript').strings).toEqual(['/"/']);
  });

  it('reads a word that starts at the first character of the file', () => {
    // `return` is a word a regular expression may follow, and here it is read
    // back to offset zero.
    expect(read('return/"/; // note', 'javascript')).toEqual({ strings: ['/"/'], comments: ['// note'], unterminated: false });
  });

  it('reads a division whose left side is the first character of the file', () => {
    expect(read('a/b/c; // note', 'javascript')).toEqual({ strings: [], comments: ['// note'], unterminated: false });
  });

  it('opens one that begins a statement after a block', () => {
    // `}` is in the punctuation table for exactly this, and only `/>` after
    // one is read as a JSX element closing instead.
    expect(read('if (a) { b(); }\n/"/.test(c); // note', 'javascript').strings).toEqual(['/"/']);
  });

  it('does not let the JSX rule reach past the slash it is about', () => {
    // The guard asks about the character *after* the slash. Asking about the
    // one before instead never fires, and this line then opens a literal that
    // runs from `/>` to the division below it.
    expect(read('const a = <App x={y} />; const b = 1 / 2; // note', 'javascript').strings).toEqual([]);
  });

  it.each([
    ['a line comment', 'f(  // why\n  a / b / c); // note'],
    ['a block comment', 'f(/* why */a / b / c); // note'],
  ])('does not take the token before %s for the token before the slash', (_name, source) => {
    // Stepping over a comment is for a `/` that comes after one. A `/` that
    // comes after ordinary code keeps its own answer: these are divisions, and
    // reading the `(` instead would make the first one a literal.
    expect(read(source, 'javascript').strings).toEqual([]);
  });

  it('does not let a regular expression close on a later line', () => {
    expect(read('const x = / a;\nconst y = b / c; // note', 'javascript').strings).toEqual([]);
  });

  it('looks past a comment to the token before it', () => {
    // A statement that opens with a regular expression, after a comment. The
    // comment is not a token, so what decides is the `;` before it.
    expect(read('x = 1;\n// first\n/"/.test(y);\n// note\n', 'javascript').strings).toEqual(['/"/']);
  });

  it('looks past a block comment too', () => {
    expect(read('f(/* why */ /"/);\n// note\n', 'javascript').strings).toEqual(['/"/']);
  });

  it('reads a slash that closes nothing on its line as a division', () => {
    // The bound that makes this safe: a regular expression is one line, so a
    // `/` read wrongly costs a line at most, and this one costs nothing.
    expect(read('const n = (a) / b;\n// note\n', 'javascript')).toEqual({ strings: [], comments: ['// note'], unterminated: false });
  });

  it.each([
    ['at the end of the line', 'const x = / not one;\n// note\n', ['// note']],
    ['at the end of the file', 'const x = / not one;', []],
  ])('reads a slash where one could open but nothing closes it %s as code', (_name, source, comments) => {
    // `=` is a position a regular expression may open in, so this is the path
    // where the scan looks for a closer and does not find one. It opens no
    // literal at all - not an empty one at the slash.
    expect(read(source, 'javascript')).toEqual({ strings: [], comments, unterminated: false });
  });

  it('leaves a division alone when it is the last character of the file', () => {
    expect(read('const n = a /', 'javascript')).toEqual({ strings: [], comments: [], unterminated: false });
  });

  it('keeps reading `</` in JSX as a closing tag rather than a literal', () => {
    expect(read('const a = <div>{x}</div>;\n// note\n', 'javascript').strings).toEqual([]);
  });

  it('keeps `/>` after an expression attribute a closing tag', () => {
    // `}` allows a regular expression, except before `/>`: that is `<App x={y} />`.
    expect(read('const a = <App x={y} />;\n// note\n', 'javascript')).toEqual({
      strings: [],
      comments: ['// note'],
      unterminated: false,
    });
  });

  it('still reads /> as a regular expression where it is one', () => {
    expect(read('const e = s.replace(/>/g, "&gt;"); // note', 'javascript').strings).toEqual(['/>/', '"&gt;"']);
  });

  it('does not read a regular expression inside a string or a comment', () => {
    expect(read('const s = "a / b"; // and /\'/ here\n', 'javascript')).toEqual({
      strings: ['"a / b"'],
      comments: ["// and /'/ here"],
      unterminated: false,
    });
  });

  it('is not a rule for the other C-family profiles, which have no such literal', () => {
    // C has no regular expression, so the `/` opens nothing and the quote
    // after it is a character literal with no partner - 0.10.3's answer,
    // deliberately unchanged. Inventing a literal a language does not have is
    // how a rule starts hiding code in files it was never meant to read.
    expect(read("int n = a /'/ b; // note", 'c-like')).toEqual({
      strings: ["'/ b; // note"],
      comments: [],
      unterminated: true,
    });
  });

  it.each(['c-like', 'c#', 'go'])('opens none in %s either, in the one shape that would show it', (name) => {
    // `=` is where a regular expression may open, and `/x/` closes on its
    // line: everything the javascript profile needs, in a profile that has no
    // such literal. It reads as a division and two more divisions.
    expect(read('n =/x/2; // note', name)).toEqual({ strings: [], comments: ['// note'], unterminated: false });
  });
});

describe('one table, two scanners', () => {
  // The import tokenizer in imports.ts asks the same question about `/` and
  // now reads the same two tables to answer it. These are the shapes where
  // they could disagree, and a disagreement is a file one of them mis-scans.
  it.each([
    ['a regular expression holding a quote', 'const re = /["\']/g;\n'],
    ['a division', 'const half = total / count;\n'],
    ['a regular expression after return', 'function f() { return /a"b/; }\n'],
    ['a JSX closing tag', 'const a = <div>{x}</div>;\n'],
    ['a JSX self-closing element after an attribute', 'const a = <App x={y} />;\n'],
    ['an HTML escape', 'const e = s.replace(/>/g, "&gt;");\n'],
    ['a regular expression opening the file', '/"/.test(x);\n'],
    ['a character class holding a slash', 'const parts = s.split(/[/\\\\]/);\n'],
  ])('reads %s with both scanners in step', (_name, source) => {
    expect(tokenize(source).desynced, 'the import tokenizer').toBe(false);
    expect(lex(source).unterminated, 'the comment lexer').toBe(false);
  });
});

describe('a javascript string that never closes', () => {
  it.each(["'", '"'])('ends at its line when opened with %s, because only a template may hold a line break', (quote) => {
    // It used to run to the end of the file, so every comment below it was
    // read as code. A quoted string cannot hold a line break in JavaScript.
    const source = `const s = ${quote}never closed;\n// note\nconst x = 1;\n`;
    expect(read(source, 'javascript')).toEqual({
      strings: [`${quote}never closed;`],
      comments: ['// note'],
      unterminated: true,
    });
  });

  it('reads JSX text with an apostrophe as the text it is', () => {
    // `Don't` opens a literal no quote closes. Bounded to its line, the rest
    // of the file is read normally - and the `//` inside the text stays inside
    // the literal, which is the direction that fails loudly.
    const source = "const a = <p>Don't click // here</p>;\n// note\nconst x = 1;\n";
    expect(read(source, 'javascript').comments).toEqual(['// note']);
  });

  it('still lets a line continuation carry a string over', () => {
    // `\` and a newline is one escape, so this string is closed and in step.
    expect(read('const s = "one \\\ntwo"; // note', 'javascript')).toEqual({
      strings: ['"one \\\ntwo"'],
      comments: ['// note'],
      unterminated: false,
    });
  });

  it('lets a template hold as many line breaks as it likes', () => {
    expect(read('const s = `one\ntwo`; // note', 'javascript')).toEqual({
      strings: ['`one\ntwo`'],
      comments: ['// note'],
      unterminated: false,
    });
  });

  it('leaves a C string running to the end of the file, where the profile says nothing', () => {
    // Not every language in the C profile agrees about this, and a rule that
    // is only right for one of them does not belong to the family.
    expect(read("char *s = 'never closed;\n// note\n", 'c-like').unterminated).toBe(true);
    expect(read("char *s = 'never closed;\n// note\n", 'c-like').comments).toEqual([]);
  });
});

describe('a block comment opener in JSX text', () => {
  it('reads /* straight after a tag as text', () => {
    // `<div>/*</div>` opened a comment that ran to the next `*/` in the file,
    // taking every line between with it.
    expect(read('const a = <div>/*</div>;\nconst b = 1; /* note */\n', 'javascript')).toEqual({
      strings: [],
      comments: ['/* note */'],
      unterminated: false,
    });
  });

  it('opens no regular expression there either, because none begins with a star', () => {
    expect(read('const a = <div>/*</div>;\n', 'javascript').strings).toEqual([]);
  });

  it('still opens a block comment after a space following a >', () => {
    // `a > /* b */ c` is a comparison and a comment, and stays one.
    expect(read('const ok = a > /* note */ b;\n', 'javascript').comments).toEqual(['/* note */']);
  });

  it('is not a rule for C, where a > is only ever an operator', () => {
    expect(read('int n = a>/* note */b;\n', 'c-like').comments).toEqual(['/* note */']);
  });
});

describe('the lexer reading this repository', () => {
  it('stays in step in every source file here', async () => {
    // Not a fixture: the defect 0.11.0 fixes was found in `src/parser.ts`,
    // whose `/^\\(["'\\])(.*?)\\1/` opened a string that ran 138 characters
    // into the prose below it. `src/polyglot.ts` lost 242 lines the same way.
    // Both reported it, and nothing was asserting that they should not have.
    const directory = fileURLToPath(new URL('../src', import.meta.url));
    const names = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
    expect(names.length).toBeGreaterThan(10);

    const lost: string[] = [];
    for (const name of names) {
      const source = await readFile(path.join(directory, name), 'utf8');
      if (lex(source).unterminated) lost.push(name);
    }

    expect(lost).toEqual([]);
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
