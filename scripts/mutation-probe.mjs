/**
 * A behavioural fingerprint of one build of spec-guard.
 *
 * Prints a digest of everything the package can be made to say without a
 * network: the analyser over a real corpus and over inputs designed to end
 * mid-construct, the directive grammar and the status reader, the glob
 * readings, every reporter format, the pure engine helpers, real searches over
 * real trees with both engines - including a ripgrep subprocess when one is
 * installed - and every command of the command line over three trees.
 *
 * Two builds that print the same digest are indistinguishable to everything
 * this can reach. Two that differ are distinguished, and the harness says by
 * what.
 *
 * The corpus is read from a *frozen* copy of the tree, never from the one a
 * harness patches: a probe that read patched files as input would see its own
 * corpus change and call every mutant distinguished - which is how the first
 * version of this reported four.
 *
 * It refuses to answer for an input that no longer finds its subject: an
 * export the build does not have, an attribute no directive takes, a flag the
 * command line refuses, a fixture that is gone. From 0.6.0 to 0.19.1 it could
 * not run at all, and nothing said so: a report written out by hand had not
 * grown with the reporter, and a malformed glob had become a refusal. So the
 * reports here are real runs', a refusal is an answer, and `--check` is what
 * tests/replay-scripts.test.ts runs against the build. ADR-0003.
 *
 *   node scripts/mutation-probe.mjs <dist-dir> --corpus <root> [--full <out>] [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node scripts/mutation-probe.mjs <dist-dir> --corpus <root> [--full <out>] [--check]';

/** An input of this probe that no longer finds what it was written to measure. */
class Stale extends Error {}

function need(holds, message) {
  if (!holds) throw new Stale(message);
}

const valueOf = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);

const dist = process.argv[2];
const fullAt = valueOf('--full');
const check = process.argv.includes('--check');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Frozen snapshot of the tree. Never the one being patched. */
const FROZEN = valueOf('--corpus') === undefined ? undefined : path.resolve(valueOf('--corpus'));

const out = [];
const sections = new Map();
/** One observation, on one line, so that two builds are compared observation by observation. */
function say(section, key, value) {
  const line = `${section}\t${key}\t${show(value)}`;
  out.push(/[\n\r]/.test(line) ? JSON.stringify(line) : line);
  sections.set(section, (sections.get(section) ?? 0) + 1);
}

/** Any value as one line: sets and maps by what they hold, a pattern by its source. */
function show(value) {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value, (_key, held) =>
    held instanceof Set || held instanceof Map ? [...held] : held instanceof RegExp ? `${held.source}|${held.flags}` : held,
  );
  return text ?? String(value);
}

/**
 * What a call answers, or how it refuses, since a refusal is an answer too. A
 * call that cannot be made at all - a function that is gone, an argument of a
 * shape nothing reads any more - is not a refusal, and stops the probe.
 */
function attempt(call) {
  try {
    return call();
  } catch (error) {
    if (error instanceof Stale || error instanceof TypeError || error instanceof ReferenceError) throw error;
    return `THREW ${error.message}`;
  }
}

async function main() {
  if (dist === undefined || dist.startsWith('--') || FROZEN === undefined) {
    console.error(USAGE);
    return 2;
  }

  /**
   * A module of the build, which refuses to hand over an export it does not
   * have. Read plainly, a renamed constant is `undefined`, printed as such in
   * both builds, and measured by nothing from then on.
   */
  const load = async (name) => {
    const module = await import(pathToFileURL(path.resolve(dist, name)).href);
    return {
      exports: new Proxy(module, {
        get(target, key) {
          if (typeof key === 'string' && !(key in target)) throw new Stale(`${name} exports no ${key}, which the probe reads`);
          return target[key];
        },
      }),
    };
  };

  const { exports: imports } = await load('imports.js');
  const { exports: polyglot } = await load('polyglot.js');
  const { exports: comments } = await load('comments.js');
  const { exports: parser } = await load('parser.js');
  const { exports: glob } = await load('glob.js');
  const { exports: engine } = await load('engine.js');
  const { exports: reporter } = await load('reporter.js');
  const { exports: runner } = await load('runner.js');
  const { exports: scope } = await load('scope.js');
  const { exports: cli } = await load('cli.js');
  const { exports: text } = await load('text.js');

  /* ---------------------------------------------------------------- corpus */

  function* walk(directory, extensions, depth = 0) {
    if (depth > 10) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(full, extensions, depth + 1);
      else if (extensions.has(path.extname(entry.name))) yield full;
    }
  }

  function collect(base, directory, extensions, limit) {
    const files = [];
    for (const file of walk(path.join(base, directory), extensions)) {
      if (files.length >= limit) break;
      try {
        if (statSync(file).size > 512 * 1024) continue;
        files.push([path.relative(base, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')]);
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
    'namespace Shop.Domain;\nusing System;', 'namespace A { namespace B { using C; } }\nusing D;',
  ];

  // node_modules is never patched, so it can be read live.
  const jsCorpus = collect(ROOT, 'node_modules', new Set(['.ts', '.js', '.mjs', '.cjs']), 1200);
  const ownCorpus = collect(FROZEN, 'src', new Set(['.ts']), 50).concat(collect(FROZEN, 'tests', new Set(['.ts']), 60));
  need(existsSync(path.join(FROZEN, 'README.md')), `${FROZEN} holds no README.md: --corpus names a copy of the tree`);
  const mdCorpus = collect(FROZEN, 'docs', new Set(['.md']), 40).concat([['README.md', readFileSync(path.join(FROZEN, 'README.md'), 'utf8')]]);
  need(jsCorpus.length > 0, `no JavaScript under ${path.join(ROOT, 'node_modules')} to analyse: run npm ci`);
  need(ownCorpus.length > 0 && mdCorpus.length > 1, `${FROZEN} holds no src/, tests/ or docs/ to read: --corpus names a copy of the tree`);

  /* ----------------------------------------------------------- 1. analysers */

  const analysis = (source, file) => imports.analyzeSource(source, file);

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

  say('imports.extensions', '-', [imports.JS_EXTENSIONS, imports.ANALYSABLE_EXTENSIONS]);
  for (const [specifier, file, namespace] of [['./b.js', 'src/a.ts'], ['../b', 'src/x/a.ts'], ['node:fs', 'src/a.ts'], ['@app/db', 'src/a.ts'],
    ['.sibling', 'app/pkg/main.py'], ['std::fmt', 'src/a.rs'], ['System.Text', 'src/A.cs', 'Shop.Domain'], ['database/sql', 'a.go'], ['', 'a.ts']]) {
    say('specifier', `${specifier}|${file}`, [
      imports.resolveSpecifier(specifier, file), imports.resolveModule(specifier, file), imports.moduleNames(specifier, file, namespace),
    ]);
  }

  /* ------------------------------------------------------- 2. the tokenizer */

  for (const [index, source] of HOSTILE.entries()) say('tokenize', index, imports.tokenize(source));

  /* ----------------------------------------------- 3. the comment classifier */

  for (const name of ['a.ts', 'a.cs', 'a.rs', 'a.go', 'a.py', 'a.sql', 'a.md', 'a.json', 'a.wat', 'a.c', 'a.sh', 'a.yaml', 'a.html', 'Makefile']) {
    const syntax = comments.syntaxFor(name);
    say('syntaxFor', name, syntax ? syntax.name : 'null');
    if (!syntax) continue;
    need(comments.syntaxNamed(syntax.name) === syntax, `comments.syntaxNamed does not know "${syntax.name}", the profile of ${name}`);
    for (const [index, source] of [...HOSTILE, ...HOSTILE_CS, ...HOSTILE_RS].entries()) {
      say(`lex.${name}`, index, comments.lexRanges(source, syntax));
    }
  }
  for (const [file, source] of ownCorpus) {
    const mask = comments.createCommentMask(source, file);
    let hits = '';
    for (let at = 0; at < source.length; at += 37) hits += mask.isComment(at) ? '1' : '0';
    say('mask', file, `${mask.classified}|${mask.syntax}|${hits}`);
  }

  /* ----------------------------------------------------------- 4. the parser */

  const context = (file) => ({ file, relativeFile: file });
  for (const [file, source] of mdCorpus) {
    say('parse', file, parser.parseDocument(source, context(file)));
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
    '<!-- @assert-count symbol="\\bTODO\\b" exclude="src\\gen" -->',
    '<pre>\n<!-- @assert-absence symbol="X" -->\n</pre>\n<!-- @assert-absence symbol="Y" -->',
    '<script>\n<!-- @assert-absence symbol="X" -->',
    '\ufeff<!-- @assert-absence symbol="X" -->\n\n    <!-- @assert-absence symbol="Y" -->',
    '---\nstatus: draft\n---\n<!-- @assert-absence symbol="X" -->',
    '---\ntitle: a\n<!-- @assert-absence symbol="X" -->\n---\n`<!-- @assert-absence symbol="Y" -->`',
  ];
  /** The ways a document says what its status is, and the ways one fails to. */
  const STATUSES = [
    '# T\n\n## Status\n\nAccepted.\n', '# T\n\n## Status\n\n**Superseded** by ADR-0007\n', '# T\n\n## Status\n\n## Context\n',
    '# T\n\n## Status\n\n2024-05-01: accepted\n\nStatus: draft\n', 'T\n=\n\nStatus\n------\n\nDraft\n', '# T\n\n## Status of the migration\n\nDraft\n',
    '**Status:** Draft\n', '**Status**: Draft\n', 'Status: **Draft**\n', '__Status__ : rejected\n', '   status:proposed\n', '    status: proposed\n',
    'Status reports are due.\n', 'Status: \u8349\u7a3f\n', 'Status:\n', '# T\n\n## Context\n\nStatus: draft\n', '```\nStatus: draft\n```\n',
    '---\nstatus: draft\n---\n# T\n', '---\nstatus: "proposed" # decided at review\n---\n', "---\nStatus: 'Superseded by ADR-0007'\n---\n",
    '---\nstatus: "accepted" (2024-05-01)\n---\n## Status\n\nProposed\n', '---\nstatus:\n  - draft\n---\n', '---\nstatus: a: b\n---\n',
    '---\ntitle: T\n---\n## Status\n\nDraft\n', '---\nstatus: draft\n', '---\n\n', '---   \nstatus: draft\n---   ', '\ufeff---\nstatus: draft\n---\n',
    '+++\nstatus = "draft"\n+++\n', "+++\nstatus = 'rejected' # why\n+++\n", '+++\nStatus = "a\\u0041\\t"\n+++\n', '+++\nstatus = "a\\x"\n+++\n',
    '+++\nstatus = """\ndraft"""\n+++\n', '+++\nstatus = ["draft"]\n+++\n', '+++\nstatus = 3\n+++\n', '+++\n[tool]\nstatus = "draft"\n+++\n',
    '+++\n[]\nstatus = "draft"\n+++\n', '+++\ntitle = """\nstatus = "draft"\n"""\nstatus = "proposed"\n+++\n', '+++\nx = { status = "draft" }\n+++\n',
    '+++\nstatus = "draft\n+++\n', '+++\n"status" = "draft"\n+++\n', '+++\nstatus = "\\U00110000"\n+++\n',
    '| Status | Accepted |\n| --- | --- |\n', '| Field | Value |\n| --- | --- |\n| **State** | Deprecated |\n', '| Status |\n| --- |\n| Draft |\n',
    '| a | b | c |\n| --- | --- | --- |\n| Status | Draft | x |\n', '# T\n\n## Log\n\n| Status | Draft |\n| --- | --- |\n', '| Status | `draft` |\n| --- | --- |\n',
    '# One\n\n# Two\n', '#\n\n# Real\n', 'Title\n=====\n', '```\n# Not a title\n```\n',
  ];
  for (const [index, source] of MD_HOSTILE.entries()) {
    say('parse.hostile', index, parser.parseDirectives(source, context('h.md')));
    say('mask.hostile', index, parser.maskCode(source));
  }
  for (const [index, source] of STATUSES.entries()) {
    say('status', index, [parser.parseStatus(source), parser.parseTitle(source), parser.parseDocument(source, context('s.md'))]);
  }
  need(STATUSES.some((source) => parser.parseStatus(source)?.active === false), 'no status the probe writes is read as one that takes a document out of force');
  need(STATUSES.some((source) => parser.parseStatus(source) === undefined), 'every status the probe writes is read, the unreadable ones included');
  say('parser.kinds', 'all', parser.KINDS);
  say('parser.inactive', 'all', parser.INACTIVE_STATUSES);
  for (const [kind, set] of Object.entries(parser.ALLOWED_ATTRIBUTES)) say('parser.allowed', kind, set);
  for (const input of ['', 'a', 'a=1', 'A="b" c', "a='\\'' b=\"\\\\\"", 'a="b', 'a = b = c']) say('parseAttributes', input, parser.parseAttributes(input));

  /* ------------------------------------------------------------- 5. the glob */

  const PATTERNS = [
    'a.ts', '*.ts', '?.ts', '**/*.ts', 'src/**/*.ts', 'src/**', '[abc].ts', '[!abc].ts', '{a,b}.ts',
    '{a,b,c}', '{*.ts,*.js}', 'a.b+c^d$e(f)g|h', 'a[b', 'a{b', 'src\\a.ts', './src/a.ts', 'src/./a.ts',
    'src/', 'tests', 'src/config', 'src/config//', '', '{dist/**,}', '**', '*', 'a/b:/c',
    '/src', '!src', '../x', 'C:/x', '.', '/', '+(a|b)', ' ./{a/,d/ ', '{src/*.ts,*.md}', '{,src/}a.ts', '{/src,x}', 'a}b', '@app/db/**', 'node:fs',
  ];
  const PATHS = [
    'a.ts', 'src/a.ts', 'src/deep/a.ts', 'src/a.js', 'dist/a.js', 'tests/a.ts', 'src/tests/a.ts',
    'src/config', 'src/config/deep/a.ts', 'other/src/config/a.ts', '', 'a', 'a/b:/c', 'x.tsx',
    'src/\u65e5\u672c\u8a9e.ts', 'a\nb.ts', 'src', 'a}b', 'README.md', '@app/db/client',
  ];
  const matched = (make) =>
    attempt(() => {
      const matches = make();
      return PATHS.map((candidate) => (matches(candidate) ? 1 : 0)).join('');
    });
  let refused = 0;
  for (const pattern of PATTERNS) {
    // Deprecated, and still what a caller of the library can ask for.
    const compiled = glob.globToRegExp(pattern);
    say('globToRegExp', pattern, `${compiled.source}|${compiled.flags}|${glob.globToRegExp(pattern, { ignoreCase: true }).flags}`);
    const include = matched(() => glob.createGlobMatcher([pattern]));
    if (include.startsWith('THREW')) refused += 1;
    say('matchers', pattern, [include, matched(() => glob.createExcludeMatcher([pattern])), matched(() => glob.createPathMatcher(pattern))]);
    const errors = [
      glob.globPatternError(pattern), glob.excludePatternError(pattern), glob.modulePatternError(pattern),
      glob.modulePatternError(pattern, 'layer'), glob.pathPatternError(pattern), glob.pathPatternError(pattern, 'as written'), glob.specPatternError(pattern),
    ];
    say('patternError', pattern, errors);
    need((errors[0] === null) === !include.startsWith('THREW'), `glob.globPatternError and glob.createGlobMatcher disagree on whether "${pattern}" can be read`);
    say('normalize', pattern, [glob.normalizeGlob(pattern), glob.normalizeExclude(pattern), glob.normalizeDirs(pattern)]);
    say('shape', pattern, [
      errors[0] === null ? [glob.patternShape(pattern, 'include'), glob.ripgrepGlobs(glob.normalizeGlob(pattern), 'include')] : 'refused',
      errors[1] === null ? [glob.patternShape(pattern, 'exclude'), glob.ripgrepGlobs(glob.normalizeExclude(pattern), 'exclude')] : 'refused',
    ]);
    say('moduleWitness', pattern, glob.moduleWitness(pattern));
    say('globBase', pattern, attempt(() => glob.globBase(pattern)));
    say('isGlob', pattern, glob.isGlob(pattern));
  }
  need(refused > 0 && refused < PATTERNS.length, `${refused} of the probe's ${PATTERNS.length} globs are refused: it holds both the malformed and the well formed, and one kind is gone`);
  say('matchers.none', 'empty', `${glob.createGlobMatcher([])('x')}${glob.createExcludeMatcher([])('x')}`);
  say('listError', '-', [glob.excludeListError(['a', '!b', 'c[']), glob.excludeListError([]), glob.patternListError(['a', 'b['], glob.globPatternError)]);
  for (const value of ['a\\b', 'a/b', 'a\\\\b', '']) say('toPosix', JSON.stringify(value), glob.toPosix(value));
  say('compareDirents', 'matrix', [['a', 'b'], ['b', 'a'], ['a', 'a']].map(([x, y]) => glob.compareDirents({ name: x }, { name: y })).join(','));

  /* ----------------------------------------------------- 6. offset arithmetic */

  for (const [index, source] of [...HOSTILE, 'a\nb\nc', 'a\r\nb', '\n\n\n', 'abc'].entries()) {
    const starts = text.lineStarts(source);
    say('lineStarts', index, starts);
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

  /* ------------------------------------------------------- 7. engine helpers */

  for (const [a, b] of [['a', 'b'], ['b', 'a'], ['a', 'a'], ['src/a', 'src/a.ts'], ['', 'a']]) {
    say('comparePaths', `${a}|${b}`, engine.comparePaths(a, b));
  }
  for (const value of ['x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), 'x'.repeat(500), 'a\r', 'a\rb', 'a\r\n', '']) {
    say('truncate', JSON.stringify(value.slice(0, 12)) + value.length, JSON.stringify(engine.truncate(value)));
  }
  for (const size of [0, 1, engine.MAX_FILE_SIZE - 1, engine.MAX_FILE_SIZE, engine.MAX_FILE_SIZE + 1]) {
    say('withinSizeLimit', size, engine.withinSizeLimit(size));
  }
  for (const n of [0, 1, 15, 16, 17, 100000]) say('readConcurrency', n, engine.readConcurrency(n));
  for (const p of ['win32', 'linux', 'darwin', 'aix']) say('smallTreeBudget', p, engine.smallTreeBudget(p));
  say('engine.constants', '-', [engine.ROOT_TARGETS, engine.MAX_COLLECTED_MATCHES, engine.MAX_CONCURRENT_READS, engine.ANY_FILE_PROBE, engine.SMALL_TREE_BUDGET]);
  for (const [code, errors] of [[2, ''], [2, 'rg: bad\n'], [null, 'killed\n'], [101, '  x  '], [1, 'a\nb\n']]) {
    say('ripgrepFailureMessage', `${code}|${JSON.stringify(errors)}`, engine.ripgrepFailureMessage(code, errors));
  }
  for (const stdout of ['', 'a.ts\0', 'a.ts\0b.ts\0', 'b.ts\0a.ts\0', 'src/b\nc.ts\0', 'src\\d\\a.ts\0', 'src/\u65e5.ts\0', '\0\0']) {
    say('parseRipgrepFiles', JSON.stringify(stdout), engine.parseRipgrepFiles(stdout, ROOT, new Set()));
  }
  say('parseRipgrepFiles.excl', '-', engine.parseRipgrepFiles('a.ts\0b.ts\0', ROOT, new Set([path.resolve(ROOT, 'a.ts')])));
  for (const stderr of ['', 'p: reason', 'rg: p: reason', 'a\r\nb', '  ', 'no separator', 'a: b: c']) {
    say('parseRipgrepErrors', JSON.stringify(stderr), engine.parseRipgrepErrors(stderr));
  }
  for (const value of ['a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o', '', 'plain']) say('escapeRegExp', value, engine.escapeRegExp(value));
  const searchOptions = (extra = {}) => ({
    regex: false, word: false, ignoreCase: false, globs: [], excludeGlobs: [], ignoreComments: false,
    scope: scope.DEFAULT_SCOPE, excludeFiles: engine.sealPaths(), ...extra,
  });
  const OPTS = [{}, { regex: true }, { word: true }, { ignoreCase: true }, { regex: true, word: true }, { ignoreComments: true },
    { globs: ['*.ts', 'src/**/*.md', '{src/*.ts,*.md}'], excludeGlobs: ['tests', '/build', 'src/gen/'] }, { scope: scope.SCAN_EVERYTHING },
    { excludeFiles: engine.sealPaths([path.resolve(ROOT, 'docs/a.md')]) }];
  const keys = [];
  for (const [index, extra] of OPTS.entries()) {
    const options = searchOptions(extra);
    say('buildJsRegExp', index, engine.buildJsRegExp('Foo.bar', options));
    const request = { root: ROOT, symbol: 'Foo', targets: ['src'], options };
    say('buildRipgrepArgs', index, engine.buildRipgrepArgs(request));
    say('buildRipgrepArgs.multi', index, engine.buildRipgrepArgs({ ...request, targets: [] }, ['a', 'b']));
    keys.push(engine.passKey(request), engine.passKey({ ...request }), engine.passKey({ ...request, targets: [] }), engine.passKey({ ...request, symbol: 'Bar' }));
  }
  // A key is compared and never read, so what is said of the keys is which of
  // them are equal: a sealed set is numbered, and a number is not an answer.
  const sameAsFirst = (list) => list.map((key) => list.findIndex((other) => show(other) === show(key)));
  say('passKey', 'equal', sameAsFirst(keys));
  {
    const [none, some] = [engine.sealPaths(), engine.sealPaths(['b', 'a'])];
    say('pathsKey', 'equal', sameAsFirst([engine.pathsKey(none), engine.pathsKey(some), engine.pathsKey(none), engine.pathsKey(some), engine.pathsKey(engine.sealPaths(['b', 'a']))]));
    say('pathsKey', 'unsealed', [engine.pathsKey(new Set(['b', 'a'])), engine.pathsKey(new Set())]);
  }
  const SCAN = [
    'const a = Foo;', 'const a = Foo;\nconst b = Foo + Foo;\nconst c = 1;', 'a\nb\nFoo', 'Foo',
    'ab\nFoo\ncd', 'const a = Foo;\r\nnext\r\n', `${'x'.repeat(500)}Foo`, 'abc',
    Array.from({ length: 520 }, (_, i) => `v${i} = Foo;`).join('\n'), '// Foo\nFoo /* Foo */ "Foo"',
  ];
  for (const [index, content] of SCAN.entries()) {
    const options = searchOptions();
    say('scanContent', index, engine.scanContent(content, 'a.ts', engine.buildJsRegExp('Foo', options)));
    say('scanContent.re', index, engine.scanContent(content, 'a.ts', engine.buildJsRegExp('x?', { ...options, regex: true })));
    say('scanContent.mask', index, engine.scanContent(content, 'a.ts', engine.buildJsRegExp('Foo', options), () => comments.createCommentMask(content, 'a.ts')));
  }
  say('sortLocations', '-', engine.sortLocations([
    { file: 'b', line: 1, column: 1, text: '', count: 1 },
    { file: 'a', line: 2, column: 1, text: '', count: 1 },
    { file: 'a', line: 1, column: 1, text: '', count: 1 },
  ]));
  for (const error of [null, undefined, {}, { code: 'ENOENT' }, { code: 'EACCES' }, { code: 'EPERM' }, { code: 'EINVAL' }, { code: 'UNKNOWN' }, { code: 'OTHER' }, { code: 42 }]) {
    say('isMissingBinary', JSON.stringify(error), engine.isMissingBinary(error));
  }

  /* -------------------------------------------------------- 8. scope helpers */

  say('scope.table', '-', scope.DEFAULT_SKIPPED_DIRECTORIES);
  say('scope.uncertain', '-', scope.UNCERTAIN_REASONS);
  say('scope.empty', '-', scope.EMPTY_LEDGER);
  say('scope.create', '-', `${scope.createScope(true) === scope.DEFAULT_SCOPE}|${scope.createScope(false) === scope.SCAN_EVERYTHING}`);
  for (const bytes of [[0], [97, 98], [], [97, 0, 98]]) say('isBinary', JSON.stringify(bytes), scope.isBinary(Buffer.from(bytes)));
  {
    const ledger = new scope.LedgerBuilder();
    for (let i = 0; i < scope.MAX_LEDGER_ENTRIES + 5; i++) ledger.add(`f${i}`, i % 2 ? 'binary' : 'unreadable', i);
    say('ledger', '-', `${ledger.build().skipped.length}|${ledger.count('binary')}|${ledger.count('unreadable')}|${ledger.count('vcs')}`);
    say('tally', '-', scope.tallyLedger(ledger.build()));
    say('merge', '-', scope.mergeLedgers([ledger.build(), ledger.build()]).skipped.length);
  }

  /* ------------------------------------------------------- 9. polyglot parts */

  for (const input of ['std::fmt;', 'std::fmt as f;', 'std::fmt ;', 'a::b c;', '::std::fmt;', 'std::{fmt, io};',
    'a::{b::{c, d}, e};', '  a :: {b};', ';', '', 'a::{', 'a::{b}; use c::d;']) {
    say('expandUsePath', JSON.stringify(input), polyglot.expandUsePath(input));
  }
  for (const input of ['a\n\n   \nb', 'from a import (\n b,\n c,\n)\nnext\n', 'import a, \\\n b\n', ')\nimport a\n', '', 'x']) {
    say('logicalLines', JSON.stringify(input), polyglot.logicalLines(input));
  }
  for (const [t, o] of [['f(a(b), c)', 1], ['f(a', 1], ['()', 0], ['', 0]]) say('matchingClose', `${t}|${o}`, polyglot.matchingClose(t, o, '(', ')'));
  for (const raw of ['"a"', "'a'", '`a`', '@"a"', 'r#"a"#', 'r"a"', '"""a"""', "'''a'''", 'a']) {
    say('literalValue', raw, JSON.stringify(polyglot.literalValue(raw)));
  }
  for (const [spec, file, lang] of [['database/sql', 'a.go', 'go'], ['std::fmt::D', 'a.rs', 'rust'],
    ['System.Text.Json', 'a.cs', 'csharp'], ['app.db.client', 'app/main.py', 'python'],
    ['.sibling', 'app/pkg/main.py', 'python'], ['..other.mod', 'app/pkg/main.py', 'python'],
    ['...top', 'a/b/c/main.py', 'python'], ['.', 'a/b.py', 'python']]) {
    say('normalizeModule', `${spec}|${file}|${lang}`, [polyglot.normalizeModule(spec, file, lang), polyglot.enclosingModules(spec, lang)]);
  }
  for (const file of ['a.py', 'a.go', 'a.rs', 'a.cs', 'a.ts', 'a', 'A.PY']) say('languageFor', file, polyglot.languageFor(file));
  say('polyglot.extensions', '-', polyglot.POLYGLOT_EXTENSIONS);
  say('polyglot.syntaxNames', '-', polyglot.SYNTAX_NAMES);
  say('polyglot.maxExpansion', '-', polyglot.MAX_EXPANSION);
  {
    const reader = new polyglot.Reader('  a.b<c<d>> ; rest');
    reader.skipSpace();
    const dotted = reader.dotted();
    reader.skipSpace();
    reader.skipGenerics();
    say('Reader', '-', `${dotted}|${reader.index}|${reader.peek()}`);
  }

  /* ---------------------------------------------------- 10. directive resolve */

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
    { symbol: 'X', comments: 'include' }, { symbol: 'X', comments: 'sometimes' }, { symbol: 'X', word: 'true' }, { symbol: 'X', word: 'true', regex: 'true' },
    { symbol: 'X', 'ignore-case': 'true' }, { symbol: 'X', glob: '*.ts, src/**' }, { symbol: 'X', glob: 'a[b' }, { symbol: 'X', exclude: '!a' },
    { symbol: 'X', 'allow-empty': 'true', reason: 'because' }, { module: 'a[b' }, { module: 'node:fs, @app/db/**', target: 'src' },
    { target: 'src', types: 'ignore' }, { target: 'src', dynamic: 'ignore' }, { target: 'src', dynamic: 'maybe' }, { target: 'src', max: '2' },
    { target: 'src', order: 'src/domain, src/app, src/infra' }, { target: 'src', order: 'src/domain' }, { target: 'src', order: 'a, a' },
    { target: 'src', order: 'domain, {./}' }, { order: 'Shop.Domain, Shop.Application', types: 'ignore', baseline: 'src/a.ts' },
    { target: 'src', partner: '[name].test.[ext]' }, { target: 'src', partner: '[name].test.[ext], tests/[dir]/[name].test.[ext]', exclude: '*.test.ts' },
    { target: 'src', partner: '[nope].x' }, { target: 'packages', dirs: '*', required: 'package.json, README.md' }, { target: 'packages', dirs: '{a/,d}', required: 'x' },
    { target: 'src', pattern: '*.entity.ts, index.ts' }, { target: 'src', pattern: '{./}' }, { target: 'src', pattern: '*.ts', glob: 'a/**', max: '1' },
    { target: 'src', required: 'x', partner: '[name].x' }, { target: 'src', dirs: '**' }, { target: 'src', pattern: '*.ts', baseline: 'src/a.ts', ratchet: 'one-way' },
  ];
  {
    const taken = new Set(Object.values(parser.ALLOWED_ATTRIBUTES).flatMap((names) => [...names]));
    const given = new Set(ATTRS.flatMap((attributes) => Object.keys(attributes)));
    for (const name of given) need(taken.has(name), `the probe resolves a directive with ${name}="...", which no directive takes any more`);
    for (const [kind, names] of Object.entries(parser.ALLOWED_ATTRIBUTES)) {
      for (const name of names) need(given.has(name), `@${kind} takes ${name}="...", and the probe resolves no directive with it: add one to ATTRS`);
    }
  }
  let resolved = 0;
  for (const kind of parser.KINDS) {
    need(Object.hasOwn(parser.ALLOWED_ATTRIBUTES, kind), `parser.ALLOWED_ATTRIBUTES has no entry for @${kind}`);
    for (const [index, attributes] of ATTRS.entries()) {
      const directive = { kind, attributes, raw: '<!-- -->', location: { file: 'f', relativeFile: 'f', line: 1, column: 1 } };
      const answer = attempt(() => runner.resolveDirective(directive, { root: ROOT, excludeFiles: new Set(), exclude: index % 7 === 0 ? ['dist', 'tests/fixtures'] : undefined }));
      if (typeof answer !== 'string' && 'assertion' in answer) resolved += 1;
      say(`resolve.${kind}`, index, answer);
    }
  }
  need(resolved > parser.KINDS.size, `${resolved} of the probe's directives resolve to an assertion: the resolver refuses nearly everything it is given`);
  say('runner.elapsed', '-', `${runner.elapsed(100, 250)}|${runner.elapsed(0, 0)}`);
  for (const [r, b] of [[8, 3], [8, 0], [0, 5], [2, 9], [1, 1]]) say('batchConcurrency', `${r}|${b}`, runner.batchConcurrency(r, b));
  say('runner.defaults', '-', [runner.DEFAULT_MAX_SNIPPETS, runner.DEFAULT_CONCURRENCY]);
  for (const value of [undefined, '', 'a', ' a , b ,, c ']) say('splitList', JSON.stringify(value), runner.splitList(value));
  say('specExclusions', '-', [runner.specExclusions(['docs/a.md', 'docs/b.md'], false), runner.specExclusions(['docs/a.md'], true)]);
  for (const exclude of [undefined, [], ['dist'], ['!dist', 'a['], ['..']]) say('checkProjectExcludes', JSON.stringify(exclude), attempt(() => runner.checkProjectExcludes(exclude)));

  /* -------------------------------------------------------------- real trees */

  const DEMO = path.join(FROZEN, 'tests', 'fixtures', 'demo-repo');
  const CITES = path.join(FROZEN, 'tests', 'fixtures', 'cites-corpus');
  const stable = (report) => ({ ...report, durationMs: 0, results: report.results.map((result) => ({ ...result, durationMs: 0 })) });
  const demoRun = stable(await runner.runSpecGuard({ patterns: ['docs/**/*.md'], root: DEMO, engine: 'javascript' }));

  /* ---------------------------------------------------------- 11. the reports */

  // A report as a run gives it, never one written out here: the reporter reads
  // fields a hand-written report does not have the day after they are added,
  // which is what stopped this probe at 0.6.0.
  const failing = demoRun.results.find((result) => !result.ok && result.matches.length > 1);
  need(failing !== undefined, `no rule under ${DEMO} fails with two matches to print: the reports are made from one`);
  const known = new Set(demoRun.results.flatMap((result) => Object.keys(result)));
  const location = (line) => ({ file: path.join(DEMO, 'docs', 'a.md'), relativeFile: 'docs/a.md', line, column: 1 });
  const VARIANTS = [
    {}, { ok: true, actual: 0, matches: [], fileMatches: [] }, { reason: 'because' },
    { warnings: ['w1', 'w2'] }, { commentMatches: 1 }, { commentMatches: 2 }, { unclassifiedFiles: 1 },
    { unclassifiedFiles: 2 }, { baselinedMatches: 1 }, { baselinedMatches: 2 },
    { staleBaseline: [{ path: 'a', declared: 2, found: 1 }, { path: 'b', declared: 1, found: 0 }] },
    { scope: { skipped: [{ path: 'a', reason: 'unreadable' }] } },
    { scope: { skipped: ['a', 'b', 'c', 'd'].map((n) => ({ path: n, reason: 'unreadable' })) } },
    { scope: { skipped: ['a', 'b', 'c', 'd'].map((n) => ({ path: n, reason: 'binary', matches: 1 })) } },
    { scope: { skipped: [{ path: 'a', reason: 'binary', matches: 2 }, { path: 'b', reason: 'unreadable' }] } },
    { actual: 9, matches: [failing.matches[0]] }, { kind: 'assert-present', symbol: undefined, files: ['a', 'b'] },
    { durationMs: 1234.5 }, { fileMatches: [] }, { bounds: { min: 2, max: 4 } }, { bounds: { min: 3 } }, { engine: 'ripgrep' }, { targets: [] },
  ];
  const everyFormat = (section, key, report) => {
    for (const color of [false, true]) {
      for (const verbose of [false, true]) {
        for (const ascii of [false, true]) say(`${section}.human`, `${key}|${color}${verbose}${ascii}`, JSON.stringify(reporter.formatReport(report, { color, verbose, ascii })));
      }
    }
    say(`${section}.human.snippets`, key, JSON.stringify(reporter.formatReport(report, { color: false, verbose: true }, 1)));
    say(`${section}.json`, key, reporter.formatJson(report));
    say(`${section}.sarif`, key, reporter.formatSarif(report, { version: '1.2.3' }));
    say(`${section}.sarif.novers`, key, reporter.formatSarif(report));
    say(`${section}.baselines`, key, reporter.formatBaselines(report));
    const annotations = reporter.runAnnotations(report);
    say(`${section}.github`, key, reporter.formatGithub(annotations));
    say(`${section}.gitlab`, key, reporter.formatGitlab(annotations));
  };
  for (const [index, extra] of VARIANTS.entries()) {
    for (const name of Object.keys(extra)) need(known.has(name), `a rule's result has no "${name}" any more, which report variant ${index} sets`);
    const result = { ...failing, durationMs: 2.34567, ...extra };
    everyFormat('report', index, {
      ...demoRun, ok: Boolean(extra.ok), durationMs: 12,
      summary: { ...demoRun.summary, total: 1, passed: extra.ok ? 1 : 0, failed: extra.ok ? 0 : 1, skipped: 0 },
      errors: [], warnings: [], results: [result],
    });
  }
  everyFormat('report', 'errors', {
    ...demoRun, ok: false, durationMs: 12, summary: { ...demoRun.summary, total: 0, passed: 0, failed: 0, skipped: 3 },
    errors: [{ location: location(9), raw: '<!-- @x -->', message: 'unknown' }, { location: location(1), raw: '', message: 'other' }],
    warnings: ['run warning'], results: [],
  });
  everyFormat('report', 'demo', demoRun);
  for (const [stream, flag, env] of [[{}, undefined, {}], [{ isTTY: true }, undefined, {}], [{}, true, {}], [{}, false, {}],
    [{ isTTY: true }, undefined, { NO_COLOR: '1' }], [{}, undefined, { FORCE_COLOR: '1' }], [{}, undefined, { FORCE_COLOR: '0' }]]) {
    say('shouldUseColor', JSON.stringify([stream, flag, env]), reporter.shouldUseColor(stream, flag, env));
  }
  for (const [env, platform] of [[{}, 'win32'], [{}, 'linux'], [{ WT_SESSION: '1' }, 'win32'], [{ TERM: 'x' }, 'win32'], [{ TERM_PROGRAM: 'x' }, 'win32']]) {
    say('shouldUseAscii', JSON.stringify([env, platform]), reporter.shouldUseAscii(env, platform));
  }
  {
    const paint = reporter.createPainter(true);
    say('painter', '-', `${paint('t')}|${paint('t', 'red')}|${paint('t', 'red', 'bold')}|${reporter.createPainter(false)('t', 'red')}`);
  }
  say('formatConfigUse', '-', [
    reporter.formatConfigUse({ file: 'package.json', applied: ['specs', 'exclude'], overridden: ['engine'] }, ['dist']),
    reporter.formatConfigUse({ file: '.spec-guard.json', applied: [], overridden: [] }),
    reporter.formatOptionLines(undefined, []), reporter.formatOptionLines({ file: 'package.json', applied: ['strict'], overridden: [] }, ['a', 'b']),
  ]);

  /* ----------------------------------------------------------- 12. real runs */

  // Each option beside the run it is meant to change: `true` where the demo
  // tree shows the difference, so that an option the runner no longer reads
  // is not measured as the plain run, twice.
  const RUNS = [
    [{}, false],
    [{ strictTargets: true }, true],
    [{ allowMissingTargets: true }, true],
    [{ includeSpecs: true }, false],
    [{ defaultSkips: false }, false],
    [{ failFast: true }, true],
    [{ concurrency: 1 }, false],
    [{ maxSnippets: 1 }, true],
    [{ allowEmptyScope: true }, false],
    [{ ignoreStatus: true }, false],
    [{ exclude: ['src/legacy'] }, true],
    [{ engine: 'auto' }, false],
    [{ patterns: ['docs/**/*.rst'] }, true],
    [{ patterns: ['docs/adr/0001-passing.md'] }, true],
  ];
  if (process.env['SPEC_GUARD_RG']) RUNS.push([{ engine: 'ripgrep' }, true]);
  for (const [index, [options, differs]] of RUNS.entries()) {
    const report = stable(await runner.runSpecGuard({ patterns: ['docs/**/*.md'], engine: 'javascript', ...options, root: DEMO }));
    if (differs) need(show(report) !== show(demoRun), `a run of ${DEMO} with ${show(options)} reads as the run without it`);
    say('run', index, report);
  }
  // Documents that are not in force, which the demo tree has none of.
  {
    const run = async (options) => stable(await runner.runSpecGuard({ patterns: ['docs/**/*.md'], root: CITES, engine: 'javascript', ...options }));
    const [inForce, all] = [await run({}), await run({ ignoreStatus: true })];
    need(inForce.inactiveSpecs.length > 0, `no document under ${CITES} is out of force`);
    need(show(inForce) !== show(all), `a run of ${CITES} with ignoreStatus reads as the run without it`);
    say('run', 'status', [inForce, all]);
    everyFormat('report', 'status', inForce);
  }
  // The project's own specs, which exercise the import, layer and structure rules end to end.
  {
    const report = stable(await runner.runSpecGuard({ patterns: ['docs/**/*.md', 'README.md'], root: FROZEN, engine: 'javascript', exclude: ['dist', 'coverage', 'reports', 'tests/fixtures'] }));
    need(new Set(report.results.map((result) => result.kind)).size >= 6, `the specs under ${FROZEN} exercise fewer than six kinds of directive`);
    say('run', 'self', report);
    everyFormat('report', 'self', report);
  }

  /* ----------------------------------------------------------- 13. the CLI */

  say('cli.version', '-', cli.version());
  say('cli.exits', '-', `${cli.EXIT_OK}|${cli.EXIT_FAILED}|${cli.EXIT_ERROR}`);
  say('cli.help', '-', createHash('sha256').update(cli.HELP).digest('hex'));

  const TREES = { demo: DEMO, cites: CITES, project: FROZEN };
  /** Command lines the parser reads, each in the tree it runs in, and the exit code where the fixture's name promises one. */
  const ARGVS = [
    ['demo', []], ['demo', ['--help']], ['demo', ['-h']], ['demo', ['--version']],
    ['demo', ['--format', 'human']], ['demo', ['--format', 'json']], ['demo', ['--format', 'JSON']], ['demo', ['--format', 'sarif']],
    ['demo', ['--format', 'github']], ['demo', ['--format', 'gitlab']],
    ['demo', ['--json']], ['demo', ['--verbose']], ['demo', ['-v']], ['demo', ['--fail-fast']], ['demo', ['--strict']], ['demo', ['--no-strict']],
    ['demo', ['--allow-missing-targets']], ['demo', ['--allow-empty-scope']], ['demo', ['--include-specs']], ['demo', ['--no-default-skips']],
    ['demo', ['--default-skips']], ['demo', ['--allow-empty']], ['demo', ['--ignore-status']], ['demo', ['--exclude', 'src/legacy, src/core']],
    ['demo', ['--exclude', 'src/legacy', '--exclude=']],
    ['demo', ['--print-baseline']], ['demo', ['--engine', 'rg']], ['demo', ['--engine', 'js']], ['demo', ['--engine', 'auto']],
    ['demo', ['--max-snippets', '1']], ['demo', ['--concurrency', '2']], ['demo', ['--concurrency', '1']],
    ['demo', ['--color']], ['demo', ['--no-color']], ['demo', ['docs/**/*.rst']], ['demo', ['docs/**/*.rst', '--allow-empty']],
    ['demo', ['docs/**/*.rst', '--format', 'sarif']], ['demo', ['docs/**/*.rst', '--format', 'json']], ['demo', ['docs/**/*.rst', '--format', 'gitlab']],
    ['demo', ['docs/adr/0001-passing.md'], 0], ['demo', ['docs/adr/0002-failing.md'], 1], ['demo', ['docs/adr/0003-invalid.md']], ['demo', ['docs/**/*.rst', '--format', 'github'], 2],
    ['demo', ['docs/adr/0001-passing.md', '--verbose']], ['demo', ['docs/adr/0002-failing.md', '--format', 'sarif']],
    ['demo', ['docs/adr/0002-failing.md', '--print-baseline']], ['demo', ['docs/adr/0002-failing.md', '--json']],
    ['demo', ['docs/adr/0002-failing.md', '--format', 'github']], ['demo', ['docs/adr/0002-failing.md', '--format', 'gitlab']],
    ['demo', ['docs/**/*.md', '--engine', 'js']], ['demo', ['docs/**/*.md', '--engine', 'js', '--verbose']], ['demo', ['docs/a[b']],
    ['demo', ['-r', 'src', '--spec', '../docs/adr/0001-passing.md']], ['demo', ['--root', 'nowhere'], 2], ['demo', ['--root', 'nowhere', '--allow-empty'], 2],
    ['demo', ['--spec', ''], 2], ['demo', ['docs/adr/0001-passing.md', '--spec', ' '], 2], ['demo', ['.']], ['demo', ['--exclude', ' ']],
    ['demo', ['query', 'src/services/BillingService.ts']], ['demo', ['query', 'src/services', 'src/core', '--format', 'json']],
    ['demo', ['query', 'src', '--spec', 'docs/adr/0002-failing.md']], ['demo', ['query', '../x']],
    ['demo', ['prove']], ['demo', ['prove', '--format', 'json']], ['demo', ['prove', '--format', 'sarif']], ['demo', ['prove', '--strict', '--verbose']],
    ['demo', ['prove', '--format', 'github']], ['demo', ['prove', '--format', 'gitlab']], ['demo', ['prove', 'docs/adr/0001-passing.md']],
    ['demo', ['cites']], ['demo', ['cites', 'src', '--format', 'json']],
    ['demo', ['impact', 'src/services/BillingService.ts']], ['demo', ['impact', 'src/services', '--depth', '1', '--format', 'json']],
    ['cites', []], ['cites', ['--verbose']], ['cites', ['--ignore-status']], ['cites', ['--format', 'json']], ['cites', ['--format', 'sarif']],
    ['cites', ['--format', 'github']], ['cites', ['--format', 'gitlab']], ['cites', ['--strict']],
    ['cites', ['cites']], ['cites', ['cites', '--strict']], ['cites', ['cites', '--format', 'json']],
    ['cites', ['cites', '--format', 'sarif']], ['cites', ['cites', '--format', 'github']], ['cites', ['cites', '--format', 'gitlab']],
    ['cites', ['cites', 'crates']], ['cites', ['cites', '--exclude', 'crates']], ['cites', ['query', 'crates']], ['cites', ['prove']],
    ['project', []], ['project', ['--format', 'gitlab']], ['project', ['--strict', '--verbose']],
    ['project', ['query', 'src/engine.ts', 'src/vendor/spec-core/text/index.ts']], ['project', ['query', 'src', '--format', 'json']],
    ['project', ['prove']], ['project', ['prove', '--format', 'json']],
    ['project', ['cites']], ['project', ['cites', '--format', 'json']],
    ['project', ['impact', 'src/text.ts']], ['project', ['impact', 'src/engine.ts', '--depth', '1']], ['project', ['impact', 'src/glob.ts', '--format', 'json']],
  ];
  /** Command lines the parser refuses. One it has started to read is an option this probe would measure as nothing but the help text. */
  const REFUSED = [
    ['--nonsense'], ['--format'], ['--format', 'yaml'], ['--engine', 'nope'], ['--max-snippets', '-1'], ['--max-snippets'],
    ['--root'], ['--root', '--verbose'], ['--depth', 'x'], ['--watch', '--format', 'json'], ['--spec'], ['--exclude', '!src'], ['query'], ['impact'], ['cites', '--verbose'],
    ['--root', ''], ['-r', ' '], ['--concurrency', '0'], ['--exclude', ','], ['--strict=false'], ['--default-skips=false'], ['--allow-empty=false'], ['--help=no'],
  ];
  /** Options the help names that no invocation here passes, each with why. */
  const NOT_RUN = new Map([['--watch', 'a session runs until it is interrupted; tests/watch.test.ts drives one']]);
  {
    const passed = new Set([...ARGVS.map(([, argv]) => argv), ...REFUSED].flat().map((argument) => argument.split('=')[0]));
    const named = new Set(cli.HELP.match(/--[a-z][a-z-]*/g));
    need(named.size > 20, 'the help text names fewer than twenty options: the probe reads them off it as --name');
    for (const flag of named) need(passed.has(flag) || NOT_RUN.has(flag), `the help names ${flag}, and the probe passes it to no invocation: add one to ARGVS`);
    for (const flag of NOT_RUN.keys()) need(named.has(flag), `${flag} is listed as not run, and the help no longer names it`);
    const commands = [...cli.HELP.matchAll(/^ {2}spec-guard ([a-z]+) /gm)].map((found) => found[1]);
    need(commands.length >= 5, 'the help text lists fewer than five commands under Usage');
    for (const command of commands) need(command === 'mcp' || ARGVS.some(([, argv]) => argv[0] === command), `the help lists the command ${command}, and the probe never runs it`);
  }
  // Durations are the one thing that changes between two identical runs.
  // Both spellings collapse to one token: `formatDuration` switches from `12ms`
  // to `1.02s` above a second, so a slow first run would otherwise read as a
  // behaviour change.
  const scrub = (line) =>
    line
      .replace(/\d+(?:\.\d+)?ms/g, 'T')
      .replace(/\d+\.\d+s/g, 'T')
      .replace(/"durationMs":\s*[\d.]+/g, '"durationMs":0');
  const invoke = async (tree, argv, stdin) => {
    const said = [];
    const erred = [];
    const code = await cli.main(argv, {
      stdout: (line) => said.push(line), stderr: (line) => erred.push(line),
      env: {}, cwd: TREES[tree], isTTY: false, ...(stdin === undefined ? {} : { stdin }),
    });
    return { code, said, erred };
  };
  for (const [index, [tree, argv, exits]] of ARGVS.entries()) {
    const key = `${index} ${tree}: ${argv.join(' ')}`;
    const parsed = attempt(() => cli.parseArgs(argv, TREES[tree]));
    need(typeof parsed !== 'string', `the command line refuses \`${argv.join(' ')}\`, which the probe runs as one it reads: ${parsed}`);
    const { code, said, erred } = await invoke(tree, argv);
    if (exits !== undefined) need(code === exits, `\`${argv.join(' ')}\` under ${TREES[tree]} exits ${code}, and its name says ${exits}`);
    say('cli.main', key, [String(code), scrub(said.join(' | ')), '--', scrub(erred.join(' | '))].join(' ~ '));
    say('cli.parseArgs', key, parsed);
  }
  for (const [index, argv] of REFUSED.entries()) {
    const parsed = attempt(() => cli.parseArgs(argv, DEMO));
    need(typeof parsed === 'string', `the command line reads \`${argv.join(' ')}\`, which the probe keeps as one it refuses`);
    const { code, erred } = await invoke('demo', argv);
    need(code === cli.EXIT_ERROR, `\`${argv.join(' ')}\` is refused and exits ${code}`);
    say('cli.refused', `${index} ${argv.join(' ')}`, `${parsed} ~ ${createHash('sha256').update(erred.join('\n')).digest('hex')}`);
  }
  // The MCP server, asked what a client asks. Requests are answered as they
  // finish, so the answers are put in the order of their ids.
  for (const tree of ['demo', 'project']) {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_architectural_rules', arguments: { path: 'src' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_architecture', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_dependents', arguments: { paths: ['src'] } } },
      { jsonrpc: '2.0', id: 6, method: 'resources/list' },
      { jsonrpc: '2.0', id: 7, method: 'nonsense' },
    ];
    const { code, said, erred } = await invoke(tree, ['mcp'], Readable.from([Buffer.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`)]));
    const answers = said.map((line) => JSON.parse(line)).sort((a, b) => a.id - b.id);
    need(answers.length === requests.filter((request) => 'id' in request).length, `the MCP server answered ${answers.length} of the probe's requests under ${TREES[tree]}`);
    need(answers.every((answer) => answer.id === 7 || 'result' in answer), `the MCP server refuses a request the probe makes under ${TREES[tree]}: ${show(answers.find((answer) => answer.id !== 7 && !('result' in answer)))}`);
    say('cli.mcp', tree, [String(code), scrub(show(answers)), '--', scrub(erred.join(' | '))].join(' ~ '));
  }

  /* -------------------------------------------------------------- the digest */

  const body = out.join('\n');
  if (fullAt) writeFileSync(fullAt, body, 'utf8');
  const digest = `${createHash('sha256').update(body).digest('hex')} ${out.length}`;
  if (check) {
    const families = new Map();
    for (const [section, count] of sections) {
      const family = section.split('.')[0];
      families.set(family, (families.get(family) ?? 0) + count);
    }
    console.log([...families].map(([family, count]) => `${String(count).padStart(6)}  ${family}`).join('\n'));
    console.log(`\n${out.length} observations of ${path.resolve(dist)}, every input finding its subject\n${digest}`);
  } else {
    console.log(digest);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof Stale)) throw error;
  console.error(`mutation-probe: ${error.message}`);
  process.exitCode = 2;
}
