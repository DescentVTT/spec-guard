/**
 * The JavaScript tokenizer's own contract.
 *
 * ADR-0005 states the risk this file exists to cover: "The scanner is the whole
 * thing. If it desynchronises without noticing, every assertion built on it is
 * quietly wrong." Every other test of the analyser goes through
 * `analyzeSource` and asserts on the *module references* that come out - which
 * is blind to almost everything the tokenizer does. A template resumption that
 * loses its place, a regex escape that skips a character too few, a `$` that is
 * not a substitution: none of those change the reference list for the files
 * anyone thought to write a test for, and all of them lose the scan on files
 * nobody did.
 *
 * So this asserts the token stream. It is the only place in the suite that
 * treats the tokenizer as a thing with an output rather than as a step on the
 * way to something else, and it was written from the list of mutants that
 * survived everything else: 139 of them, in the lowest-scoring file in the
 * project.
 */

import { describe, expect, it } from 'vitest';

import { analyzeSource, tokenize, ANALYSABLE_EXTENSIONS, JS_EXTENSIONS } from '../src/imports.js';
import { POLYGLOT_EXTENSIONS } from '../src/polyglot.js';

/** The token stream in a form that fits on one line per assertion. */
const stream = (source: string): string[] =>
  tokenize(source).tokens.map((token) => `${token.type}:${token.value}`);

const lost = (source: string): boolean => tokenize(source).desynced;

const specifiers = (source: string): string[] =>
  analyzeSource(source, 'src/a.ts').references.map((reference) => reference.specifier);

describe('the shape of the stream', () => {
  it('splits words, punctuation and strings', () => {
    expect(stream("import { A } from 'x';")).toEqual([
      'word:import',
      'punct:{',
      'word:A',
      'punct:}',
      'word:from',
      'string:x',
      'punct:;',
    ]);
  });

  it('reads identifiers containing digits, underscores and dollars', () => {
    // A digit cannot *start* an identifier, so a bare number falls through to
    // the punctuation branch. Harmless - the extractor only ever looks at words
    // and strings - but it is what the stream says, so it is what this asserts
    // rather than what it ought to say.
    expect(stream('const a1_$b = 1;')).toEqual([
      'word:const',
      'word:a1_$b',
      'punct:=',
      'punct:1',
      'punct:;',
    ]);
  });

  it('emits a decorator and a private field as punctuation, not identifiers', () => {
    // Neither @ nor # can continue an identifier, so accepting them as a start
    // would read a zero-length word and never advance.
    expect(stream('@dec class A { #x = 1 }')).toEqual([
      'punct:@',
      'word:dec',
      'word:class',
      'word:A',
      'punct:{',
      'punct:#',
      'word:x',
      'punct:=',
      'punct:1',
      'punct:}',
    ]);
  });

  it('emits nothing for an empty source', () => {
    expect(tokenize('')).toEqual({ tokens: [], desynced: false });
  });

  it('tracks line and column', () => {
    const { tokens } = tokenize("a\n  b\n\n   'c'");
    expect(tokens.map((token) => `${token.value}@${token.line}:${token.column}`)).toEqual([
      'a@1:1',
      'b@2:3',
      'c@4:4',
    ]);
  });
});

describe('comments', () => {
  it('drops a line comment without losing the line count', () => {
    const { tokens } = tokenize('// a comment\nafter');
    expect(tokens.map((token) => `${token.value}@${token.line}`)).toEqual(['after@2']);
  });

  it('drops a block comment and counts the lines it spanned', () => {
    const { tokens } = tokenize('/* one\ntwo\nthree */ after');
    expect(tokens.map((token) => `${token.value}@${token.line}`)).toEqual(['after@3']);
  });

  it('loses the scan on an unterminated block comment', () => {
    expect(lost('/* never closed\nimport x from "y";')).toBe(true);
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    expect(stream('const u = "http://example.com"; const x = 1;')).toContain('string:http://example.com');
  });
});

describe('strings', () => {
  it('keeps the value without the quotes', () => {
    expect(stream(`'single' "double"`)).toEqual(['string:single', 'string:double']);
  });

  it('unescapes the character after a backslash', () => {
    expect(stream(String.raw`'it\'s' "a\\b"`)).toEqual(["string:it's", 'string:a\\b']);
  });

  it('loses the scan on a newline inside a quoted string', () => {
    // A quoted string cannot span lines, so this is a broken file, and reading
    // on from here would be reading a guess.
    expect(lost("const a = 'open\nconst b = 1;")).toBe(true);
  });

  it('loses the scan on a string that never closes', () => {
    expect(lost("const a = 'open")).toBe(true);
  });

  it('loses the scan on a trailing backslash at the end of the file', () => {
    expect(lost("const a = 'open\\")).toBe(true);
  });

  it('does not lose the scan on a well-formed file', () => {
    // The negative control for every case above.
    expect(lost("const a = 'closed';\n")).toBe(false);
  });
});

describe('regular expressions', () => {
  it('emits one token for a regex and keeps going', () => {
    expect(stream('const re = /abc/;')).toEqual([
      'word:const',
      'word:re',
      'punct:=',
      'punct:regex',
      'punct:;',
    ]);
  });

  it('consumes the flags', () => {
    expect(stream('x = /abc/gimsuy; y')).toEqual([
      'word:x',
      'punct:=',
      'punct:regex',
      'punct:;',
      'word:y',
    ]);
  });

  it('skips an escaped character inside the pattern', () => {
    // Without the two-character skip, the escaped slash closes the regex and
    // everything after it is read as code.
    expect(stream(String.raw`x = /a\/b/; y`)).toEqual([
      'word:x',
      'punct:=',
      'punct:regex',
      'punct:;',
      'word:y',
    ]);
  });

  it('does not end at a slash inside a character class', () => {
    expect(stream('x = /[/]/; y')).toEqual(['word:x', 'punct:=', 'punct:regex', 'punct:;', 'word:y']);
  });

  it('ends at a slash after the class has closed', () => {
    expect(stream('x = /[ab]/; y')).toEqual(['word:x', 'punct:=', 'punct:regex', 'punct:;', 'word:y']);
  });

  it('loses the scan on a regex that never closes', () => {
    expect(lost('x = /abc')).toBe(true);
  });

  it('loses the scan on a regex broken by a newline', () => {
    expect(lost('x = /abc\ny = 1;')).toBe(true);
  });

  describe('deciding whether a slash starts one', () => {
    it('does after a keyword that can be followed by an expression', () => {
      expect(stream('return /abc/')).toEqual(['word:return', 'punct:regex']);
    });

    it('does after punctuation that can be followed by an expression', () => {
      expect(stream('f( /abc/ )')).toEqual(['word:f', 'punct:(', 'punct:regex', 'punct:)']);
    });

    it('does at the very start of a file', () => {
      expect(stream('/abc/')).toEqual(['punct:regex']);
    });

    it('does not after an ordinary identifier, where it is division', () => {
      expect(stream('a / b')).toEqual(['word:a', 'punct:/', 'word:b']);
    });

    it('does not after a string', () => {
      expect(stream(`'a' / b`)).toEqual(['string:a', 'punct:/', 'word:b']);
    });

    it('does not after a template', () => {
      // The branch that says "a template token is not a place a regex can
      // start". Getting it wrong swallows the rest of the file as a pattern.
      expect(stream('`t` / b')).toEqual(['string:t', 'punct:/', 'word:b']);
    });

    it('does not on a JSX closing tag', () => {
      // `<` is deliberately absent from the punctuation list: in JSX every
      // closing tag is `</`, and reading that as a regex loses the file.
      expect(lost('const a = <div>x</div>;\n')).toBe(false);
      expect(specifiers("const a = <div>x</div>;\nimport { B } from './b.js';\n")).toEqual(['./b.js']);
    });
  });
});

describe('template literals', () => {
  it('reads one with no substitution as a usable string', () => {
    expect(stream('`plain`')).toEqual(['string:plain']);
  });

  it('unescapes inside it', () => {
    expect(stream('`a\\`b`')).toEqual(['string:a`b']);
  });

  it('counts the lines it spans', () => {
    const { tokens } = tokenize('`one\ntwo`\nafter');
    expect(tokens.map((token) => `${token.type}@${token.line}`)).toEqual(['string@1', 'word@3']);
  });

  it('treats a dollar that is not a substitution as text', () => {
    expect(stream('`a$b`')).toEqual(['string:a$b']);
    expect(stream('`cost: $`')).toEqual(['string:cost: $']);
  });

  it('hands one substitution back to the main loop as code', () => {
    // The closing brace of a substitution is consumed by the resumption rather
    // than emitted: it is not punctuation in the code, it is the end of a
    // string.
    expect(stream('`a${b}c`')).toEqual(['template:', 'word:b']);
  });

  it('handles two consecutive substitutions', () => {
    // The resumption path: after the first `}` the scanner is back inside the
    // template and has to notice the second `${` itself. Nothing else in the
    // suite reaches this.
    expect(stream('`${a}${b}`')).toEqual(['template:', 'word:a', 'word:b']);
  });

  it('handles text between two substitutions', () => {
    expect(stream('`x${a}y${b}z`')).toEqual(['template:', 'word:a', 'word:b']);
  });

  it('handles an escape in the resumed part', () => {
    expect(stream('`${a}\\`b`')).toEqual(['template:', 'word:a']);
  });

  it('treats a dollar in the resumed part as text', () => {
    expect(stream('`${a}b$c`')).toEqual(['template:', 'word:a']);
  });

  it('handles an object literal inside a substitution', () => {
    // The brace depth is what tells the closing `}` of the substitution apart
    // from the closing `}` of an object inside it.
    expect(stream('`${ {a: 1} }`')).toEqual([
      'template:',
      'punct:{',
      'word:a',
      'punct::',
      'punct:1',
      // The object's closing brace is punctuation; the substitution's is not
      // emitted at all, which is the whole point of tracking the depth.
      'punct:}',
    ]);
  });

  it('handles a template nested inside a substitution', () => {
    expect(stream('`${`inner`}`')).toEqual(['template:', 'string:inner']);
  });

  it('handles a substituted template nested inside a substitution', () => {
    expect(stream('`${`a${b}c`}`')).toEqual(['template:', 'template:', 'word:b']);
  });

  it('loses the scan on a template that never closes', () => {
    expect(lost('`open')).toBe(true);
  });

  it('loses the scan on a trailing backslash inside one', () => {
    expect(lost('`open\\')).toBe(true);
  });

  it('loses the scan when the resumed part never closes', () => {
    expect(lost('`a${b}c')).toBe(true);
  });

  it('loses the scan when a substitution is never closed at all', () => {
    // The stack check at the end: the `${` opened a frame nothing popped.
    expect(lost('`a${b')).toBe(true);
  });

  it('does not lose the scan on well-formed templates', () => {
    for (const source of ['`a`', '`a${b}c`', '`${a}${b}`', '`${`n`}`', '`${ {x:1} }`']) {
      expect(lost(source), source).toBe(false);
    }
  });
});

describe('braces outside templates', () => {
  it('counts them without confusing a plain block for a substitution', () => {
    expect(stream('function f() { return { a: 1 }; }')).toContain('punct:}');
    expect(lost('function f() { return { a: 1 }; }')).toBe(false);
  });

  it('survives more closing braces than opening ones', () => {
    expect(lost('} } }')).toBe(false);
  });
});

describe('what the extractor does with the stream', () => {
  it('ignores import.meta', () => {
    expect(specifiers('const u = import.meta.url;\n')).toEqual([]);
  });

  it('ignores a property called import or require', () => {
    expect(specifiers("loader.require('x');\nobj.import('y');\n")).toEqual([]);
  });

  it('reads a dynamic import whose argument is a literal', () => {
    expect(specifiers("const m = await import('./a.js');\n")).toEqual(['./a.js']);
    expect(specifiers("const m = require('./b.js');\n")).toEqual(['./b.js']);
  });

  it('reads a dynamic import with a second argument', () => {
    // `import('x', { with: { type: 'json' } })` closes on a comma, not a paren.
    expect(specifiers("const m = await import('./a.json', { with: { type: 'json' } });\n")).toEqual([
      './a.json',
    ]);
  });

  it('reports a dynamic import whose argument is a name', () => {
    const analysis = analyzeSource('const m = await import(name);\n', 'src/a.ts');
    expect(analysis.references).toEqual([]);
    expect(analysis.notes[0]?.detail).toBe('import(name)');
  });

  it('reports a dynamic import whose argument is an expression', () => {
    expect(analyzeSource('const m = await import(`./${a}.js`);\n', 'src/a.ts').notes[0]?.detail).toBe(
      'import(expression)',
    );
  });

  it('reads a bare side-effect import', () => {
    expect(specifiers("import './polyfill.js';\n")).toEqual(['./polyfill.js']);
  });

  it('reads an export-from as a dependency', () => {
    expect(specifiers("export * from './a.js';\nexport { B } from './b.js';\n")).toEqual([
      './a.js',
      './b.js',
    ]);
  });

  it('does not run past a semicolon looking for from', () => {
    expect(specifiers("import A;\nconst from = 'not-a-module';\n")).toEqual([]);
  });

  it('gives up on a clause that never reaches from', () => {
    // The lookahead bound: a pathological clause must not make the extractor
    // scan the rest of the file for every import keyword in it.
    const long = `import {${Array.from({ length: 400 }, (_, i) => `a${i}`).join(', ')}} from './x.js';\n`;
    expect(specifiers(long)).toEqual([]);
  });

  it('reads a clause that reaches from inside the bound', () => {
    const short = `import {${Array.from({ length: 20 }, (_, i) => `a${i}`).join(', ')}} from './x.js';\n`;
    expect(specifiers(short)).toEqual(['./x.js']);
  });

  describe('type-only imports', () => {
    const typeOnly = (source: string): boolean | undefined =>
      analyzeSource(source, 'src/a.ts').references[0]?.typeOnly;

    it('marks import type', () => {
      expect(typeOnly("import type { A } from './a.js';\n")).toBe(true);
      expect(typeOnly("import type A from './a.js';\n")).toBe(true);
    });

    it('does not mark a default binding that happens to be called type', () => {
      // `import type from 'x'` imports a value named `type`.
      expect(typeOnly("import type from './a.js';\n")).toBe(false);
    });

    it('does not mark a bare import of a module called type', () => {
      expect(typeOnly("import 'type';\n")).toBe(false);
    });

    it('marks export type', () => {
      expect(typeOnly("export type { A } from './a.js';\n")).toBe(true);
    });
  });
});

/**
 * The three tables the tokenizer's heuristics live in.
 *
 * Asserted entry by entry, which is unusual for this suite and deliberate here.
 * These are not incidental constants: each one is a decision with a reason in
 * ADR-0005, an entry silently dropped misreads real code, and nothing else in
 * the suite notices. `<` being *absent* from the punctuation list is the
 * clearest case - it is there so that JSX closing tags do not start a regular
 * expression, and it is a hole in the table that has to stay a hole.
 */
describe('the lookup tables', () => {
  const WORDS = [
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
  ];

  const PUNCTUATION = [
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '/',
    '%',
    '^',
    '~',
    '>',
  ];

  it.each(WORDS)('a slash after %s starts a regex', (word) => {
    expect(stream(`${word} /abc/`)).toEqual([`word:${word}`, 'punct:regex']);
  });

  // Each case is prefixed with a word so the punctuation under test is really
  // the preceding token. A bare leading `/` cannot be: at the start of a file a
  // slash is always a regex, so `/ /abc/` tests nothing about the `/` entry.
  it.each(PUNCTUATION)('a slash after %s starts a regex', (punctuation) => {
    expect(stream(`x ${punctuation} /abc/`)).toEqual([
      'word:x',
      `punct:${punctuation}`,
      'punct:regex',
    ]);
  });

  it.each(['<', '.', ')', ']'])('a slash after %s does not', (punctuation) => {
    expect(stream(`x ${punctuation} /abc/`)).toEqual([
      'word:x',
      `punct:${punctuation}`,
      'punct:/',
      'word:abc',
      'punct:/',
    ]);
  });

  it.each(['foo', 'const', 'x1'])('a slash after the ordinary word %s is division', (word) => {
    expect(stream(`${word} /abc/`)).toEqual([`word:${word}`, 'punct:/', 'word:abc', 'punct:/']);
  });
});

describe('the extension tables', () => {
  it('names every extension the JavaScript tokenizer claims', () => {
    expect([...JS_EXTENSIONS].sort()).toEqual([
      '.cjs',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.mts',
      '.ts',
      '.tsx',
    ]);
  });

  it('is exactly the JavaScript set plus the polyglot set', () => {
    // ANALYSABLE_EXTENSIONS decides which files an import assertion inspects,
    // and a name missing from it means those files are reported as unreadable
    // rather than analysed. It is built from the two tables, so this asserts
    // the sum rather than a third hand-written list.
    expect([...ANALYSABLE_EXTENSIONS].sort()).toEqual(
      [...JS_EXTENSIONS, ...POLYGLOT_EXTENSIONS.keys()].sort(),
    );
    expect(ANALYSABLE_EXTENSIONS.size).toBe(JS_EXTENSIONS.size + POLYGLOT_EXTENSIONS.size);
  });

  it.each([...JS_EXTENSIONS])('reads an import from a %s file', (extension) => {
    expect(analyzeSource("import { A } from './a.js';\n", `src/file${extension}`).references).toHaveLength(
      1,
    );
  });
});

describe('a well-formed file never reports a lost scan', () => {
  // The stream assertions above say what the tokens are; these say the scan
  // still knows where it is. A mutant that mistakes a lone `$` for a
  // substitution produces the same tokens and an unbalanced template stack, so
  // only the flag catches it.
  it.each([
    '`plain`',
    '`a$b`',
    '`cost: $`',
    '`${a}b$c`',
    '`${a}${b}`',
    '`x${a}y${b}z`',
    '`${`inner`}`',
    '`${`a${b}c`}`',
    '`${ {a: 1} }`',
    'x = /[/]/; y',
    'x = /a\/b/;',
    "const u = 'http://example.com';",
    'function f() { return { a: 1 }; }',
    "import { A } from './a.js';",
  ])('%s', (source) => {
    expect(lost(source)).toBe(false);
  });
});

describe('the extractor at the end of a file', () => {
  it('ignores an import keyword with nothing after it', () => {
    expect(specifiers('import')).toEqual([]);
    expect(specifiers('const x = 1;\nrequire')).toEqual([]);
  });

  it('ignores require that is not a call', () => {
    expect(specifiers("const r = require;\nconst s = require.cache;\n")).toEqual([]);
  });

  it('ignores an import call whose argument is not a literal', () => {
    expect(specifiers('const m = import();\n')).toEqual([]);
    expect(specifiers('const m = require();\n')).toEqual([]);
  });

  it('ignores an export that never reaches a specifier', () => {
    expect(specifiers('export const a = 1;\nexport default b;\n')).toEqual([]);
  });

  it('reads an import whose clause spans lines', () => {
    expect(specifiers("import {\n  A,\n  B,\n} from './a.js';\n")).toEqual(['./a.js']);
  });
});
