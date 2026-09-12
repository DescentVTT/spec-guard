/**
 * A behavioural fingerprint of one build of spec-guard.
 *
 * Prints a digest of everything the package can be made to say without a
 * network: the analyser over a real corpus and over inputs designed to end
 * mid-construct, the directive grammar, the glob compiler, every reporter
 * format, the pure engine helpers, and real searches over real trees with both
 * engines - including a ripgrep subprocess when one is installed.
 *
 * Two builds that print the same digest are indistinguishable to everything
 * this can reach. Two that differ are distinguished, and the harness says by
 * what.
 *
 * The corpus is read from a *frozen* copy of the tree, never from the working
 * one. The harness that drives this patches source files, and a probe that read
 * them as input would see its own corpus change and call every mutant
 * distinguished - which is how the first version of this reported four.
 *
 *   node scripts/mutation-probe.mjs <dist-dir> --corpus <root> [--full <out>]
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.argv[2];
const fullAt = process.argv.includes('--full') ? process.argv[process.argv.indexOf('--full') + 1] : null;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
/** Frozen snapshot of src/, tests/ and docs/. Never the live tree. */
const FROZEN = process.argv[process.argv.indexOf('--corpus') + 1];
const load = (name) => import(pathToFileURL(path.join(dist, name)).href);

const imports = await load('imports.js');
const polyglot = await load('polyglot.js');
const comments = await load('comments.js');
const parser = await load('parser.js');
const glob = await load('glob.js');
const engine = await load('engine.js');
const reporter = await load('reporter.js');
const runner = await load('runner.js');
const scope = await load('scope.js');
const cli = await load('cli.js');
const text = await load('text.js');

const out = [];
const say = (section, key, value) => out.push(`${section}\t${key}\t${value}`);

/* ------------------------------------------------------------------ corpus */

function* walk(directory, extensions, limit, depth = 0) {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full, extensions, limit, depth + 1);
    else if (extensions.has(path.extname(entry.name))) yield full;
  }
}

function collect(directory, extensions, limit) {
  const files = [];
  for (const file of walk(directory, extensions, limit)) {
    if (files.length >= limit) break;
    try {
      if (statSync(file).size > 512 * 1024) continue;
      files.push([path.relative(ROOT, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')]);
    } catch {
      /* unreadable files are not this probe's subject */
    }
  }
  return files;
}

/** Inputs designed to stop in the middle of something. */
const HOSTILE = [
  '', ' ', '\n', '\r\n', '`', '`a', '`a${b', '`a${b}c', '`a\\', "'", "'a", "'a\\", '"a', '"a\r\n',
  '/re', 'x = /re', 'x = /[a', '/*', '/* a', '/*/', '/**/', '//', '// a', 'a /', 'x = /a\\',
  '`${', '`${}', '`a{b}`', 'import', 'import {', 'import {A', 'import type', 'import type {',
  'import.', "import '.'", "import '('", "import 'type'", 'export', 'export {', 'export { A } from',
  'const a = await import(', "const a = await import('x'", 'const a = require(', 'require.resolve(1)',
  "const a = 'import'\n'./b.js'", 'a', '$', '`$', '`${a}$', 'x', 'x ', '\u0000', '\u{1f600}',
  'import "\u65e5\u672c\u8a9e.js";', 'const a = 1; // \u00e9\u00e8\u00ea', '\ufeffimport "a";',
];
const HOSTILE_PY = [
  'import', 'from', 'from .', 'from . import', 'from  a import b', 'import   a.b', 'from import x',
  'from . import (a, b)', 'from . import *', "__import__ ( 'os' )", 'from a import (\n b,\n c,\n)',
  'import a, \\\n b', ')\nimport a', '#import a', '"""\nimport a\n"""', "'''x'''\nimport b",
];
const HOSTILE_GO = [
  'import "fmt"', 'import (\n"fmt"\n"os"\n)', 'import f "fmt"', 'import _ "x"', 'import . "fmt"',
  'import (', 'import', 'import (\nf "fmt"\n)', 'package main\nimport "fmt"\nfunc f(){println("x")}',
  'import `raw`', 'var s = `a\\`',
];
const HOSTILE_RS = [
  'use std::fmt;', 'use std::{fmt, io};', 'use a::{b::{c, d}, e};', 'use a::b as c;', 'use ::a::b;',
  'use', 'use a::{', 'use a::b', '/* a /* b */ c */ use x::y;', 'let s = r#"use a::b;"#;',
  'use a::{\n b,\n};\nuse c::d;',
];
const HOSTILE_CS = [
  'using System;', 'using static System.Math;', 'using A = B.C;', 'using L = A.List<int>;',
  'using D = A.Dictionary<int, List<string>>;', 'using D = A.List<int\nusing System.Text;',
  'using (var s = O()) { }', 'using var t = O();', 'using ;', 'using', 'using staticfiles.H;',
  'var v = @"using X;";', 'global using System;',
];

// node_modules is never patched, so it can be read live.
const jsCorpus = collect(path.join(ROOT, 'node_modules'), new Set(['.ts', '.js', '.mjs', '.cjs']), 1200);
const ownCorpus = collect(path.join(FROZEN, 'src'), new Set(['.ts']), 50).concat(
  collect(path.join(FROZEN, 'tests'), new Set(['.ts']), 60),
);
const mdCorpus = collect(path.join(FROZEN, 'docs'), new Set(['.md']), 40).concat([
  ['README.md', readFileSync(path.join(FROZEN, 'README.md'), 'utf8')],
]);

/* ------------------------------------------------------------- 1. analysers */

function analysis(source, file) {
  const a = imports.analyzeSource(source, file);
  return (
    a.references.map((r) => `${r.kind}|${r.specifier}|${r.typeOnly}|${r.line}:${r.column}`).join(';') +
    '#' +
    a.notes.map((n) => `${n.kind}|${n.line}:${n.column}|${n.detail}`).join(';')
  );
}

for (const [file, source] of [...jsCorpus, ...ownCorpus]) say('analyse', file, analysis(source, file));
for (const [index, source] of HOSTILE.entries()) {
  say('hostile.ts', index, analysis(source, 'h.ts'));
  say('hostile.tsx', index, analysis(source, 'h.tsx'));
}
for (const [index, source] of HOSTILE_PY.entries()) say('hostile.py', index, analysis(source, 'pkg/h.py'));
for (const [index, source] of HOSTILE_GO.entries()) say('hostile.go', index, analysis(source, 'h.go'));
for (const [index, source] of HOSTILE_RS.entries()) say('hostile.rs', index, analysis(source, 'h.rs'));
for (const [index, source] of HOSTILE_CS.entries()) say('hostile.cs', index, analysis(source, 'h.cs'));

// Every prefix of a real file, so a scan that loses its place anywhere shows up.
const sample = readFileSync(path.join(FROZEN, 'src', 'polyglot.ts'), 'utf8').slice(0, 6000);
for (let cut = 0; cut <= sample.length; cut += 7) say('prefix', cut, analysis(sample.slice(0, cut), 'p.ts'));

/* --------------------------------------------------------- 2. the tokenizer */

for (const [index, source] of HOSTILE.entries()) {
  const { tokens, desynced } = imports.tokenize(source);
  say('tokenize', index, `${desynced}|${tokens.map((t) => `${t.type}:${t.value}@${t.line}:${t.column}`).join(',')}`);
}

/* ------------------------------------------------- 3. the comment classifier */

for (const name of ['a.ts', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sql', 'a.md', 'a.json', 'a.wat']) {
  const syntax = comments.syntaxFor(name);
  say('syntaxFor', name, syntax ? syntax.name : 'null');
  if (!syntax) continue;
  for (const [index, source] of [...HOSTILE, ...HOSTILE_CS, ...HOSTILE_RS].entries()) {
    const lex = comments.lexRanges(source, syntax);
    say(`lex.${name}`, index, `${lex.unterminated}|${JSON.stringify(lex.comments)}|${JSON.stringify(lex.strings)}`);
  }
}
for (const [file, source] of ownCorpus) {
  const mask = comments.createCommentMask(source, file);
  let hits = '';
  for (let at = 0; at < source.length; at += 37) hits += mask.isComment(at) ? '1' : '0';
  say('mask', file, `${mask.classified}|${hits}`);
}

/* ------------------------------------------------------------- 4. the parser */

for (const [file, source] of mdCorpus) {
  const parsed = parser.parseDirectives(source, { file, relativeFile: file });
  say('parse', file, JSON.stringify(parsed));
  say('maskCode', file, createHash('sha256').update(parser.maskCode(source)).digest('hex'));
}
const MD_HOSTILE = [
  '```\n<!-- @assert-absence symbol="X" -->\n```',
  '~~~\n<!-- @assert-absence symbol="X" -->\n~~~',
  '~\n<!-- @assert-absence symbol="X" -->\n~',
  '   ```\n<!-- @assert-absence symbol="X" -->\n   ```',
  '    ```\n<!-- @assert-absence symbol="X" -->',
  'text ``` more\n<!-- @assert-absence symbol="X" -->',
  '````\n```\n<!-- @assert-absence symbol="X" -->\n````',
  '```\n<!-- @assert-absence symbol="X" -->',
  '`<!-- @assert-absence symbol="X" -->`',
  'a ``` b ` c ` d\n<!-- @assert-absence symbol="X" -->',
  'a ` b\n<!-- @assert-absence symbol="X" -->',
  '`a` b `c`',
  `x\`${String.fromCodePoint(0x1f600)}\`y`,
  '<!-- @assert-nonsense -->',
  '<!-- @todo tidy -->',
  '<!-- @assert-present file="a.md" nope="1" -->',
  '<!-- @assert-count a = "b" c=d e -->',
  "<!-- @assert-count a='b' -->",
  '<!-- @assert-count a="say \\"hi\\"" -->',
  '<!-- @assert-count axx="c" a=b>c -->',
];
for (const [index, source] of MD_HOSTILE.entries()) {
  say('parse.hostile', index, JSON.stringify(parser.parseDirectives(source, { file: 'h.md', relativeFile: 'h.md' })));
  say('mask.hostile', index, JSON.stringify(parser.maskCode(source)));
}
say('parser.kinds', 'all', JSON.stringify([...parser.KINDS]));
for (const [kind, set] of Object.entries(parser.ALLOWED_ATTRIBUTES)) say('parser.allowed', kind, JSON.stringify([...set]));

/* --------------------------------------------------------------- 5. the glob */

const PATTERNS = [
  'a.ts', '*.ts', '?.ts', '**/*.ts', 'src/**/*.ts', 'src/**', '[abc].ts', '[!abc].ts', '{a,b}.ts',
  '{a,b,c}', '{*.ts,*.js}', 'a.b+c^d$e(f)g|h', 'a[b', 'a{b', 'src\\a.ts', './src/a.ts', 'src/./a.ts',
  'src/', 'tests', 'src/config', 'src/config//', '', '{dist/**,}', '**', '*', 'a/b:/c',
];
const PATHS = [
  'a.ts', 'src/a.ts', 'src/deep/a.ts', 'src/a.js', 'dist/a.js', 'tests/a.ts', 'src/tests/a.ts',
  'src/config', 'src/config/deep/a.ts', 'other/src/config/a.ts', '', 'a', 'a/b:/c', 'x.tsx',
  'src/\u65e5\u672c\u8a9e.ts', 'a\nb.ts',
];
for (const pattern of PATTERNS) {
  const compiled = glob.globToRegExp(pattern);
  say('globToRegExp', pattern, `${compiled.source}|${compiled.flags}`);
  say('globToRegExp.i', pattern, glob.globToRegExp(pattern, { ignoreCase: true }).flags);
  const include = glob.createGlobMatcher([pattern]);
  const exclude = glob.createExcludeMatcher([pattern]);
  say('matchers', pattern, PATHS.map((p) => `${include(p) ? 1 : 0}${exclude(p) ? 1 : 0}`).join(''));
  say('globBase', pattern, JSON.stringify(glob.globBase(pattern)));
  say('isGlob', pattern, String(glob.isGlob(pattern)));
}
say('matchers.none', 'empty', `${glob.createGlobMatcher([])('x')}${glob.createExcludeMatcher([])('x')}`);
for (const value of ['a\\b', 'a/b', 'a\\\\b', '']) say('toPosix', JSON.stringify(value), glob.toPosix(value));
say('compareDirents', 'matrix', [['a', 'b'], ['b', 'a'], ['a', 'a']].map(([x, y]) => glob.compareDirents({ name: x }, { name: y })).join(','));

/* ------------------------------------------------------- 6. offset arithmetic */

for (const [index, source] of [...HOSTILE, 'a\nb\nc', 'a\r\nb', '\n\n\n', 'abc'].entries()) {
  const starts = text.lineStarts(source);
  say('lineStarts', index, JSON.stringify(starts));
  const located = [];
  for (let at = 0; at <= source.length + 3; at++) located.push(JSON.stringify(text.locate(starts, at)));
  say('locate', index, located.join(''));
}
const RANGES = [[], [[2, 4]], [[0, 6]], [[1, 3], [5, 7]], [[5, 7], [1, 3]], [[0, 6], [2, 3]],
  [[0, 4], [2, 6]], [[2, 2]], [[4, 1]], [[1, 99]], [[10, 20]], [[0, 2]], [[1, 3], [6, 4]], [[1, 3], [6, 6]]];
for (const [index, ranges] of RANGES.entries()) {
  say('maskRanges', index, JSON.stringify(text.maskRanges('abcdefgh', ranges)));
  say('maskRanges.nl', index, JSON.stringify(text.maskRanges('a\nbc\ndefg', ranges)));
}

/* --------------------------------------------------------- 7. engine helpers */

for (const [a, b] of [['a', 'b'], ['b', 'a'], ['a', 'a'], ['src/a', 'src/a.ts'], ['', 'a']]) {
  say('comparePaths', `${a}|${b}`, String(engine.comparePaths(a, b)));
}
for (const value of ['x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), 'x'.repeat(500), 'a\r', 'a\rb', 'a\r\n', '']) {
  say('truncate', JSON.stringify(value.slice(0, 12)) + value.length, JSON.stringify(engine.truncate(value)));
}
for (const size of [0, 1, engine.MAX_FILE_SIZE - 1, engine.MAX_FILE_SIZE, engine.MAX_FILE_SIZE + 1]) {
  say('withinSizeLimit', size, String(engine.withinSizeLimit(size)));
}
for (const n of [0, 1, 15, 16, 17, 100000]) say('readConcurrency', n, String(engine.readConcurrency(n)));
for (const p of ['win32', 'linux', 'darwin', 'aix']) say('smallTreeBudget', p, JSON.stringify(engine.smallTreeBudget(p)));
say('ROOT_TARGETS', '-', JSON.stringify(engine.ROOT_TARGETS));
say('MAX_COLLECTED_MATCHES', '-', String(engine.MAX_COLLECTED_MATCHES));
say('MAX_CONCURRENT_READS', '-', String(engine.MAX_CONCURRENT_READS));
for (const [code, errors] of [[2, ''], [2, 'rg: bad\n'], [null, 'killed\n'], [101, '  x  '], [1, 'a\nb\n']]) {
  say('ripgrepFailureMessage', `${code}|${JSON.stringify(errors)}`, engine.ripgrepFailureMessage(code, errors));
}
for (const stdout of ['', 'a.ts\0', 'a.ts\0b.ts\0', 'b.ts\0a.ts\0', 'src/b\nc.ts\0', 'src\\d\\a.ts\0', 'src/\u65e5.ts\0', '\0\0']) {
  say('parseRipgrepFiles', JSON.stringify(stdout), JSON.stringify(engine.parseRipgrepFiles(stdout, ROOT, new Set())));
}
say('parseRipgrepFiles.excl', '-', JSON.stringify(engine.parseRipgrepFiles('a.ts\0b.ts\0', ROOT, new Set([path.resolve(ROOT, 'a.ts')]))));
for (const stderr of ['', 'p: reason', 'rg: p: reason', 'a\r\nb', '  ', 'no separator', 'a: b: c']) {
  say('parseRipgrepErrors', JSON.stringify(stderr), JSON.stringify(engine.parseRipgrepErrors(stderr)));
}
for (const value of ['a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o', '', 'plain']) say('escapeRegExp', value, engine.escapeRegExp(value));
const OPTS = [{}, { regex: true }, { word: true }, { ignoreCase: true }, { regex: true, word: true }];
for (const [index, extra] of OPTS.entries()) {
  const options = { regex: false, word: false, ignoreCase: false, globs: [], excludeGlobs: [], ignoreComments: false, scope: scope.DEFAULT_SCOPE, excludeFiles: new Set(), ...extra };
  const re = engine.buildJsRegExp('Foo.bar', options);
  say('buildJsRegExp', index, `${re.source}|${re.flags}`);
  say('buildRipgrepArgs', index, JSON.stringify(engine.buildRipgrepArgs({ root: ROOT, symbol: 'Foo', targets: ['src'], options })));
  say('buildRipgrepArgs.multi', index, JSON.stringify(engine.buildRipgrepArgs({ root: ROOT, symbol: 'Foo', targets: [], options }, ['a', 'b'])));
}
const SCAN = [
  'const a = Foo;', 'const a = Foo;\nconst b = Foo + Foo;\nconst c = 1;', 'a\nb\nFoo', 'Foo',
  'ab\nFoo\ncd', 'const a = Foo;\r\nnext\r\n', `${'x'.repeat(500)}Foo`, 'abc',
  Array.from({ length: 520 }, (_, i) => `v${i} = Foo;`).join('\n'),
];
for (const [index, content] of SCAN.entries()) {
  const options = { regex: false, word: false, ignoreCase: false, globs: [], excludeGlobs: [], ignoreComments: false, scope: scope.DEFAULT_SCOPE, excludeFiles: new Set() };
  say('scanContent', index, JSON.stringify(engine.scanContent(content, 'a.ts', engine.buildJsRegExp('Foo', options))));
  say('scanContent.re', index, JSON.stringify(engine.scanContent(content, 'a.ts', engine.buildJsRegExp('x?', { ...options, regex: true }))));
}
say('sortLocations', '-', JSON.stringify(engine.sortLocations([
  { file: 'b', line: 1, column: 1, text: '', count: 1 },
  { file: 'a', line: 2, column: 1, text: '', count: 1 },
  { file: 'a', line: 1, column: 1, text: '', count: 1 },
])));
for (const error of [null, undefined, {}, { code: 'ENOENT' }, { code: 'EACCES' }, { code: 'EPERM' }, { code: 'EINVAL' }, { code: 'UNKNOWN' }, { code: 'OTHER' }, { code: 42 }]) {
  say('isMissingBinary', JSON.stringify(error), String(engine.isMissingBinary(error)));
}

/* ---------------------------------------------------------- 8. scope helpers */

say('scope.table', '-', JSON.stringify([...scope.DEFAULT_SKIPPED_DIRECTORIES]));
say('scope.uncertain', '-', JSON.stringify([...scope.UNCERTAIN_REASONS]));
say('scope.empty', '-', JSON.stringify(scope.EMPTY_LEDGER));
say('scope.create', '-', `${scope.createScope(true) === scope.DEFAULT_SCOPE}|${scope.createScope(false) === scope.SCAN_EVERYTHING}`);
for (const bytes of [[0], [97, 98], [], [97, 0, 98]]) say('isBinary', JSON.stringify(bytes), String(scope.isBinary(Buffer.from(bytes))));
{
  const ledger = new scope.LedgerBuilder();
  for (let i = 0; i < scope.MAX_LEDGER_ENTRIES + 5; i++) ledger.add(`f${i}`, i % 2 ? 'binary' : 'unreadable', i);
  say('ledger', '-', `${ledger.build().skipped.length}|${ledger.count('binary')}|${ledger.count('unreadable')}|${ledger.count('vcs')}`);
  say('tally', '-', JSON.stringify([...scope.tallyLedger(ledger.build())]));
  say('merge', '-', String(scope.mergeLedgers([ledger.build(), ledger.build()]).skipped.length));
}

/* --------------------------------------------------------- 9. polyglot parts */

for (const input of ['std::fmt;', 'std::fmt as f;', 'std::fmt ;', 'a::b c;', '::std::fmt;', 'std::{fmt, io};',
  'a::{b::{c, d}, e};', '  a :: {b};', ';', '', 'a::{', 'a::{b}; use c::d;']) {
  say('expandUsePath', JSON.stringify(input), JSON.stringify(polyglot.expandUsePath(input)));
}
for (const input of ['a\n\n   \nb', 'from a import (\n b,\n c,\n)\nnext\n', 'import a, \\\n b\n', ')\nimport a\n', '', 'x']) {
  say('logicalLines', JSON.stringify(input), JSON.stringify(polyglot.logicalLines(input)));
}
for (const [t, o] of [['f(a(b), c)', 1], ['f(a', 1], ['()', 0], ['', 0]]) say('matchingClose', `${t}|${o}`, String(polyglot.matchingClose(t, o, '(', ')')));
for (const raw of ['"a"', "'a'", '`a`', '@"a"', 'r#"a"#', 'r"a"', '"""a"""', "'''a'''", 'a']) {
  say('literalValue', raw, JSON.stringify(polyglot.literalValue(raw)));
}
for (const [spec, file, lang] of [['database/sql', 'a.go', 'go'], ['std::fmt::D', 'a.rs', 'rust'],
  ['System.Text.Json', 'a.cs', 'csharp'], ['app.db.client', 'app/main.py', 'python'],
  ['.sibling', 'app/pkg/main.py', 'python'], ['..other.mod', 'app/pkg/main.py', 'python'],
  ['...top', 'a/b/c/main.py', 'python'], ['.', 'a/b.py', 'python']]) {
  say('normalizeModule', `${spec}|${file}|${lang}`, polyglot.normalizeModule(spec, file, lang));
}
say('polyglot.extensions', '-', JSON.stringify([...polyglot.POLYGLOT_EXTENSIONS]));
say('polyglot.syntaxNames', '-', JSON.stringify(polyglot.SYNTAX_NAMES));
say('polyglot.maxExpansion', '-', String(polyglot.MAX_EXPANSION));
{
  const reader = new polyglot.Reader('  a.b<c<d>> ; rest');
  reader.skipSpace();
  const dotted = reader.dotted();
  reader.skipSpace();
  reader.skipGenerics();
  say('Reader', '-', `${dotted}|${reader.index}|${reader.peek()}`);
}

/* ------------------------------------------------------ 10. directive resolve */

const KINDS = ['assert-absence', 'assert-count', 'assert-present', 'assert-import-absence', 'assert-import-count'];
const ATTRS = [
  {}, { symbol: 'X' }, { symbol: 'X', expected: '0' }, { symbol: 'X', expected: '1' }, { symbol: 'X', expected: '2' },
  { symbol: 'X', min: '1' }, { symbol: 'X', min: '2' }, { symbol: 'X', max: '0' }, { symbol: 'X', max: '1' },
  { symbol: 'X', max: '2' }, { symbol: 'X', min: '1', max: '3' }, { symbol: 'X', min: '3', max: '1' },
  { symbol: 'X', expected: 'lots' }, { symbol: 'X', max: 'lots' }, { symbol: 'X', expected: '12' },
  { symbol: 'X', expected: ' 3 ' }, { symbol: 'X', expected: '1x' }, { symbol: 'X', expected: '' },
  { symbol: 'X', target: 'src, lib' }, { symbol: 'X', target: ' , ' }, { symbol: 'X', target: '/etc/x' },
  { symbol: 'X', target: 'C:/x' }, { symbol: 'X', target: 'a/b:/c' }, { symbol: 'X', target: '../x' },
  { symbol: 'X', regex: 'true' }, { symbol: 'X', regex: 'off' }, { symbol: 'X', regex: 'maybe' },
  { symbol: '(', expected: '1' }, { symbol: '(', expected: '1', regex: 'true' },
  { symbol: 'X', baseline: 'src/a.ts', ratchet: 'one-way' }, { symbol: 'X', ratchet: 'one-way' },
  { symbol: 'X', ratchet: 'sideways', baseline: 'a' }, { symbol: 'X', 'allow-empty': 'perhaps' },
  { symbol: 'X', exclude: 'a, b' }, { symbol: 'X', baseline: 'src/a.ts:2' }, { symbol: 'X', baseline: 'src/a.ts:x' },
  { symbol: 'X', baseline: '../x' }, { file: 'a.ts, b.ts' }, { file: '/etc/x' },
  { module: 'a/**' }, { module: 'a/**', expected: '0' }, { module: 'a/**', expected: '1' },
  { module: 'a/**', min: '1' }, { module: 'a/**', max: '1' }, { module: 'a/**', min: '1', max: '4' },
  { module: 'a/**', types: 'ignore' }, { module: 'a/**', types: 'maybe' }, { module: 'a/**', exclude: 't/**, f/**' },
];
for (const kind of KINDS) {
  for (const [index, attributes] of ATTRS.entries()) {
    const directive = { kind, attributes, raw: '<!-- -->', location: { file: 'f', relativeFile: 'f', line: 1, column: 1 } };
    let value;
    try {
      const resolved = runner.resolveDirective(directive, { root: ROOT, excludeFiles: new Set() });
      value = JSON.stringify(resolved, (k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v));
    } catch (error) {
      value = `THREW ${error.message}`;
    }
    say(`resolve.${kind}`, index, value);
  }
}
say('runner.elapsed', '-', `${runner.elapsed(100, 250)}|${runner.elapsed(0, 0)}`);
for (const [r, b] of [[8, 3], [8, 0], [0, 5], [2, 9], [1, 1]]) say('batchConcurrency', `${r}|${b}`, String(runner.batchConcurrency(r, b)));

/* ------------------------------------------------------------ 11. the reports */

const location = (line) => ({ file: 'C:/r/docs/a.md', relativeFile: 'docs/a.md', line, column: 1 });
const baseResult = {
  ok: false, kind: 'assert-absence', location: location(4), description: '"Gone" must not appear in src',
  symbol: 'Gone', targets: ['src', 'lib'], files: [], bounds: { max: 0 }, actual: 2,
  message: 'expected no matches, found 2',
  matches: [{ file: 'src/a.ts', line: 7, column: 5, text: '  const Gone = 1;  ', count: 1 },
    { file: 'src/b.ts', line: 2, column: 1, text: 'Gone();', count: 1 }],
  warnings: [], commentMatches: 0, unclassifiedFiles: 0, scope: scope.EMPTY_LEDGER,
  baselinedMatches: 0, staleBaseline: [], fileMatches: [{ file: 'src/a.ts', count: 1 }, { file: 'src/b.ts', count: 3 }],
  engine: 'ripgrep', durationMs: 2.34567,
};
const VARIANTS = [
  {}, { ok: true, actual: 0, matches: [], fileMatches: [] }, { reason: 'because' },
  { warnings: ['w1', 'w2'] }, { commentMatches: 1 }, { commentMatches: 2 }, { unclassifiedFiles: 1 },
  { unclassifiedFiles: 2 }, { baselinedMatches: 1 }, { baselinedMatches: 2 },
  { staleBaseline: [{ path: 'a', declared: 2, found: 1 }, { path: 'b', declared: 1, found: 0 }] },
  { scope: { skipped: [{ path: 'a', reason: 'unreadable' }] } },
  { scope: { skipped: ['a', 'b', 'c', 'd'].map((n) => ({ path: n, reason: 'unreadable' })) } },
  { scope: { skipped: ['a', 'b', 'c', 'd'].map((n) => ({ path: n, reason: 'binary', matches: 1 })) } },
  { scope: { skipped: [{ path: 'a', reason: 'binary', matches: 2 }, { path: 'b', reason: 'unreadable' }] } },
  { actual: 9, matches: [baseResult.matches[0]] }, { kind: 'assert-present', symbol: undefined, files: ['a', 'b'] },
  { durationMs: 1234.5 }, { fileMatches: [] },
];
for (const [index, extra] of VARIANTS.entries()) {
  const result = { ...baseResult, ...extra };
  const report = {
    ok: Boolean(extra.ok), root: 'C:/r', engine: 'ripgrep', durationMs: 12,
    summary: { specs: 1, total: 1, passed: extra.ok ? 1 : 0, failed: extra.ok ? 0 : 1, skipped: 0 },
    specFiles: ['docs/a.md'], errors: [], warnings: [], results: [result],
  };
  for (const color of [false, true]) {
    for (const verbose of [false, true]) {
      for (const ascii of [false, true]) {
        say('formatReport', `${index}|${color}${verbose}${ascii}`, JSON.stringify(reporter.formatReport(report, { color, verbose, ascii })));
      }
    }
  }
  say('formatJson', index, reporter.formatJson(report));
  say('formatSarif', index, reporter.formatSarif(report, { version: '1.2.3' }));
  say('formatSarif.novers', index, reporter.formatSarif(report));
  say('formatBaselines', index, reporter.formatBaselines(report));
}
{
  const withErrors = {
    ok: false, root: 'C:/r', engine: 'ripgrep', durationMs: 12,
    summary: { specs: 1, total: 0, passed: 0, failed: 0, skipped: 3 }, specFiles: ['docs/a.md'],
    errors: [{ location: location(9), raw: '<!-- @x -->', message: 'unknown' }, { location: location(1), raw: '', message: 'other' }],
    warnings: ['run warning'], results: [],
  };
  for (const color of [false, true]) say('formatReport.errors', color, JSON.stringify(reporter.formatReport(withErrors, { color, verbose: true })));
  say('formatSarif.errors', '-', reporter.formatSarif(withErrors));
  say('formatJson.errors', '-', reporter.formatJson(withErrors));
  say('formatBaselines.none', '-', reporter.formatBaselines(withErrors));
}
for (const [stream, flag, env] of [[{}, undefined, {}], [{ isTTY: true }, undefined, {}], [{}, true, {}], [{}, false, {}],
  [{ isTTY: true }, undefined, { NO_COLOR: '1' }], [{}, undefined, { FORCE_COLOR: '1' }], [{}, undefined, { FORCE_COLOR: '0' }]]) {
  say('shouldUseColor', JSON.stringify([stream, flag, env]), String(reporter.shouldUseColor(stream, flag, env)));
}
for (const [env, platform] of [[{}, 'win32'], [{}, 'linux'], [{ WT_SESSION: '1' }, 'win32'], [{ TERM: 'x' }, 'win32'], [{ TERM_PROGRAM: 'x' }, 'win32']]) {
  say('shouldUseAscii', JSON.stringify([env, platform]), String(reporter.shouldUseAscii(env, platform)));
}
{
  const paint = reporter.createPainter(true);
  say('painter', '-', `${paint('t')}|${paint('t', 'red')}|${paint('t', 'red', 'bold')}|${reporter.createPainter(false)('t', 'red')}`);
}

/* ------------------------------------------------------------ 12. real runs */

const DEMO = path.join(FROZEN, 'tests', 'fixtures', 'demo-repo');
const RUNS = [
  { patterns: ['docs/**/*.md'], engine: 'javascript' },
  { patterns: ['docs/**/*.md'], engine: 'javascript', verbose: true },
  { patterns: ['docs/**/*.md'], engine: 'javascript', strictTargets: true },
  { patterns: ['docs/**/*.md'], engine: 'javascript', allowMissingTargets: true },
  { patterns: ['docs/**/*.md'], engine: 'javascript', includeSpecs: true },
  { patterns: ['docs/**/*.md'], engine: 'javascript', defaultSkips: false },
  { patterns: ['docs/**/*.md'], engine: 'javascript', failFast: true },
  { patterns: ['docs/**/*.md'], engine: 'javascript', concurrency: 1 },
  { patterns: ['docs/**/*.md'], engine: 'javascript', maxSnippets: 1 },
  { patterns: ['docs/**/*.md'], engine: 'javascript', allowEmptyScope: true },
  { patterns: ['docs/**/*.rst'], engine: 'javascript' },
  { patterns: ['docs/**/*.md'], engine: 'auto' },
];
if (process.env['SPEC_GUARD_RG']) RUNS.push({ patterns: ['docs/**/*.md'], engine: 'ripgrep' });
for (const [index, options] of RUNS.entries()) {
  const report = await runner.runSpecGuard({ ...options, root: DEMO });
  const stable = { ...report, durationMs: 0, results: report.results.map((r) => ({ ...r, durationMs: 0 })) };
  say('run', index, JSON.stringify(stable));
}
// The project's own specs, which exercise the import assertions end to end.
{
  const report = await runner.runSpecGuard({ patterns: ['docs/**/*.md', 'README.md'], root: FROZEN, engine: 'javascript' });
  const stable = { ...report, durationMs: 0, results: report.results.map((r) => ({ ...r, durationMs: 0 })) };
  say('run', 'self', JSON.stringify(stable));
}

/* ------------------------------------------------------------- 13. the CLI */

say('cli.version', '-', cli.version());
say('cli.exits', '-', `${cli.EXIT_OK}|${cli.EXIT_FAILED}|${cli.EXIT_ERROR}`);
say('cli.help', '-', createHash('sha256').update(cli.HELP).digest('hex'));

const ARGVS = [
  [], ['--help'], ['--version'], ['--nonsense'], ['--format'], ['--format', 'yaml'],
  ['--format', 'human'], ['--format', 'json'], ['--format', 'JSON'], ['--format', 'sarif'],
  ['--json'], ['--verbose'], ['--fail-fast'], ['--strict'], ['--allow-missing-targets'],
  ['--allow-empty-scope'], ['--include-specs'], ['--no-default-skips'], ['--allow-empty'],
  ['--print-baseline'], ['--engine', 'rg'], ['--engine', 'js'], ['--engine', 'auto'],
  ['--engine', 'nope'], ['--max-snippets', '1'], ['--max-snippets', '-1'], ['--max-snippets'],
  ['--concurrency', '2'], ['--concurrency', '0'], ['--root'], ['--root', '--verbose'],
  ['--color'], ['--no-color'], ['docs/**/*.rst'], ['docs/**/*.rst', '--allow-empty'],
  ['docs/**/*.rst', '--format', 'sarif'], ['docs/**/*.rst', '--format', 'json'],
  ['docs/adr/0001-passing.md'], ['docs/adr/0002-failing.md'], ['docs/adr/0003-invalid.md'],
  ['docs/adr/0001-passing.md', '--verbose'], ['docs/adr/0002-failing.md', '--format', 'sarif'],
  ['docs/adr/0002-failing.md', '--print-baseline'], ['docs/adr/0002-failing.md', '--json'],
  ['docs/**/*.md', '--engine', 'js'], ['docs/**/*.md', '--engine', 'js', '--verbose'],
];
// Durations are the one thing that changes between two identical runs.
// Both spellings collapse to one token: `formatDuration` switches from `12ms`
// to `1.02s` above a second, so a slow first run would otherwise read as a
// behaviour change.
const scrub = (line) =>
  line
    .replace(/\d+(?:\.\d+)?ms/g, 'T')
    .replace(/\d+\.\d+s/g, 'T')
    .replace(/"durationMs":\s*[\d.]+/g, '"durationMs":0');
for (const [index, argv] of ARGVS.entries()) {
  const out = [];
  const err = [];
  let code;
  try {
    code = await cli.main(argv, {
      stdout: (t) => out.push(t), stderr: (t) => err.push(t),
      env: {}, cwd: DEMO, isTTY: false,
    });
  } catch (error) {
    code = `THREW ${error.message}`;
  }
  const joined = [String(code), scrub(out.join(' | ')), '--', scrub(err.join(' | '))].join(' ~ ');
  say('cli.main', `${index} ${argv.join(' ')}`, joined);
  try {
    say('cli.parseArgs', `${index} ${argv.join(' ')}`, JSON.stringify(cli.parseArgs(argv, DEMO)));
  } catch (error) {
    say('cli.parseArgs', `${index} ${argv.join(' ')}`, `THREW ${error.message}`);
  }
}

/* ---------------------------------------------------------------- the digest */

const body = out.join('\n');
if (fullAt) (await import('node:fs')).writeFileSync(fullAt, body, 'utf8');
console.log(`${createHash('sha256').update(body).digest('hex')} ${out.length}`);
