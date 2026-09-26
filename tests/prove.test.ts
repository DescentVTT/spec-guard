/**
 * `spec-guard prove`: each rule shown a violation of itself. ADR-0016.
 *
 * For every kind of violation, a rule that the violation fails and a rule that
 * cannot fail however the code changes, which has to survive: a check that
 * only ever reports `killed` would be a check that proves nothing either. Then
 * what prove must never do - write to the disk, give a different answer twice
 * - and what it says when no violation can be made.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { main, version, type CliIO } from '../src/cli.js';
import { walkFiles } from '../src/glob.js';
import { importLine, proveSpecGuard, PROVE_NAME, regexWitness, type ProveOptions } from '../src/prove.js';
import { formatProve, formatProveJson, formatProveSarif } from '../src/reporter.js';
import type { ProveReport, ProveResult } from '../src/types.js';
import { makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

const ROOT = path.resolve('/virtual/prove');

const TREE = {
  'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.test.ts': "import { a } from './a.js';\n",
};

async function prove(
  directives: string,
  files: Record<string, string> = TREE,
  options: Partial<ProveOptions> = {},
): Promise<ProveReport> {
  const io = memoryIo(ROOT, { 'docs/rules.md': `${directives}\n`, ...files });
  return proveSpecGuard({ patterns: ['docs/rules.md'], root: ROOT, io, ...options });
}

/** The one rule a document holds, as prove found it. */
async function one(directive: string, files?: Record<string, string>, options?: Partial<ProveOptions>): Promise<ProveResult> {
  const report = await prove(directive, files, options);
  expect(report.errors).toEqual([]);
  expect(report.results).toHaveLength(1);
  return report.results[0] as ProveResult;
}

/** What a result says, in the words and the changes a report carries. */
const said = (result: ProveResult) => ({
  outcome: result.outcome,
  unprovable: result.unprovable,
  probes: result.probes.map((probe) => [probe.claim, probe.outcome, probe.violation, probe.message, probe.changes]),
});

/* -------------------------------------------------------------------- text */

describe('a text rule', () => {
  it('is killed by a file of the scope\'s kind holding the text, beside the files it reads', async () => {
    expect(said(await one('<!-- @assert-absence target="src" symbol="Legacy" -->'))).toEqual({
      outcome: 'killed',
      unprovable: undefined,
      probes: [
        [
          'max',
          'killed',
          `added src/${PROVE_NAME}.ts holding "Legacy"`,
          'expected no matches, found 1',
          [{ path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 6 }],
        ],
      ],
    });
  });

  it('survives when its glob leaves out the code under its target', async () => {
    // The glob that misses the extension the code is written in: the rule
    // passes today, and would pass whatever the code did.
    expect(said(await one('<!-- @assert-absence target="src" symbol="Legacy" glob="*.js" allow-empty="true" -->'))).toEqual({
      outcome: 'survived',
      unprovable: undefined,
      probes: [
        [
          'max',
          'survived',
          `added src/${PROVE_NAME}.ts holding "Legacy", beside the code under src, none of which the rule reads`,
          'expected no matches, found 0',
          [{ path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 6 }],
        ],
      ],
    });
  });

  it('adds as many as its maximum takes to exceed', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="export" max="3" -->');
    expect(result.probes.map((probe) => [probe.violation, probe.message])).toEqual([
      [`added src/${PROVE_NAME}.ts holding "export" 2 times`, 'expected at most 3 matches, found 4'],
    ]);
  });

  it('puts the text at the top of a file it reads when no new file would be read', async () => {
    const result = await one('<!-- @assert-absence target="src/b.ts" symbol="Legacy" -->');
    expect(said(result).probes).toEqual([
      ['max', 'killed', 'put "Legacy" at the top of src/b.ts', 'expected no matches, found 1', [{ path: 'src/b.ts', change: 'replaced', bytes: 27 }]],
    ]);
  });

  it('goes under a minimum by taking out every line that holds the text', async () => {
    const result = await one('<!-- @assert-count target="src" symbol="export" min="1" max="5" -->');
    expect(said(result).probes).toEqual([
      ['max', 'killed', `added src/${PROVE_NAME}.ts holding "export" 4 times`, 'expected between 1 and 5 matches, found 6', [{ path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 27 }]],
      [
        'min',
        'killed',
        'removed 2 lines holding "export" from src/a.ts, src/b.ts',
        'expected between 1 and 5 matches, found 0',
        [
          { path: 'src/a.ts', change: 'replaced', bytes: 28 },
          { path: 'src/b.ts', change: 'replaced', bytes: 0 },
        ],
      ],
    ]);
  });

  it('empties a file whose match spans lines, since taking out lines leaves it', async () => {
    const result = await one('<!-- @assert-count target="src/m.ts" symbol="a\\nb" regex="true" expected="1" -->', { 'src/m.ts': 'a\nb\n' });
    expect(result.probes[1]?.message).toBe('expected exactly 1 match, found 0');
    expect(result.outcome).toBe('killed');
  });

  it('writes text a regular expression matches, and says when it cannot', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy(Gateway|Client)\\b" regex="true" -->');
    expect(result.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts holding "LegacyGateway"`);
    expect(said(await one('<!-- @assert-absence target="src" symbol="(?<=x)y" regex="true" -->'))).toEqual({
      outcome: 'unprovable',
      unprovable:
        'no text could be made that the regular expression (?<=x)y matches: prove writes text for literals, classes, groups, alternatives and counted repetition, not for lookaround or backreferences',
      probes: [],
    });
  });

  it('keeps the words it forbids whole when the rule asks for word boundaries', async () => {
    // The tree says `{ b }` and `b.js`, which a rule about the word b would
    // already count: a word nothing holds shows what the boundaries keep.
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy" word="true" -->');
    expect(result.outcome).toBe('killed');
  });
});

describe('text a regular expression matches', () => {
  it.each([
    ['Legacy', 'Legacy'],
    ['\\bTODO\\b', 'TODO'],
    ['a+b*c?', 'a'],
    ['[0-9]{3}-x{2,}', '000-xx'],
    ['(?:ab|cd)e', 'abe'],
    ['(?<name>q)r', 'qr'],
    ['\\d\\w\\s.\\D\\W\\S', '0a aa-a'],
    ['(?=a)|b', 'b'],
    ['[^a]', '0'],
    ['[^b]', 'a'],
    ['x{10}', 'xxxxxxxxxx'],
    ['x{2,5}', 'xx'],
    ['x{2,}?', 'xx'],
    ['[a-z_]+', 'a'],
    ['^foo$', 'foo'],
    ['a{', 'a{'],
    ['\\.\\(\\t', '.(\t'],
    ['x*?y+?', 'y'],
    ['a\\Bb', 'ab'],
    ['[\\]x]', ']'],
    ['[xy]', 'x'],
  ])('%s is matched by %j', (source, text) => {
    expect(regexWitness(source)).toBe(text);
    expect(new RegExp(source).test(text)).toBe(true);
  });

  it.each([['(?<=x)y'], ['(?!x)'], ['(a)\\1'], ['\\x41'], ['\\u0041'], ['\\p{L}'], ['[]'], ['^$'], ['a)'], ['x?'], ['[abc']])('%s has none', (source) => {
    expect(regexWitness(source)).toBeNull();
  });
});

/* ----------------------------------------------------------------- imports */

describe('an import rule', () => {
  it('is killed by a file of the scope\'s language importing the module', async () => {
    expect(said(await one('<!-- @assert-import-absence target="src" module="node:fs" -->'))).toEqual({
      outcome: 'killed',
      unprovable: undefined,
      probes: [
        ['max', 'killed', `added src/${PROVE_NAME}.ts importing node:fs`, 'expected no matches, found 1', [{ path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 18 }]],
      ],
    });
  });

  it('survives when its exclude leaves out every file under its target', async () => {
    const result = await one('<!-- @assert-import-absence target="src" module="node:fs" exclude="*.ts" allow-empty="true" -->');
    expect(result.outcome).toBe('survived');
    expect(result.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts importing node:fs, beside the code under src, none of which the rule reads`);
  });

  it('imports a name below a module pattern that is a glob', async () => {
    const result = await one('<!-- @assert-import-absence target="src" module="@app/db/**" -->');
    expect(result.outcome).toBe('killed');
    expect(result.probes[0]?.violation).toMatch(new RegExp(`^added src/${PROVE_NAME}\\.ts importing @app/db/.+$`));
  });

  it('empties the files importing a module to go under a minimum, and leaves its target in place', async () => {
    const result = await one('<!-- @assert-import-count target="src/a.ts" module="src/b.js" min="1" -->');
    expect(said(result).probes).toEqual([
      ['min', 'killed', 'emptied src/a.ts, the file importing it', 'expected at least 1 match, found 0', [{ path: 'src/a.ts', change: 'replaced', bytes: 0 }]],
    ]);
  });

  it('survives when the unit is files and the scope is one file already counted', async () => {
    // A maximum of one file over a target of one file cannot be exceeded,
    // whatever that file does: this repository had one (ADR-0016).
    const result = await one('<!-- @assert-import-count target="src/a.ts" module="src/b.js" expected="1" -->');
    expect(said(result).probes).toEqual([
      ['max', 'survived', 'made src/a.ts import src/b.js', 'expected exactly 1 match, found 1', [{ path: 'src/a.ts', change: 'replaced', bytes: 67 }]],
      ['min', 'killed', 'emptied src/a.ts, the file importing it', 'expected exactly 1 match, found 0', [{ path: 'src/a.ts', change: 'replaced', bytes: 0 }]],
    ]);
    expect(result.outcome).toBe('survived');
  });

  it.each([
    ['app/a.py', 'import os\n', 'app.db', 'import app.db\n'],
    ['app/a.go', 'package app\n', 'example.com/db', 'package prove\n\nimport "example.com/db"\n'],
    ['app/a.rs', 'use std::io;\n', 'crate::db', 'use crate::db;\n'],
    ['app/a.cs', 'using System;\n', 'App.Db', 'using App.Db;\n'],
  ])('writes the import in the language of %s', async (file, source, module, line) => {
    expect(importLine(path.extname(file), module)).toBe(line);
    const result = await one(`<!-- @assert-import-absence target="app" module="${module}" -->`, { [file]: source });
    expect(result.outcome).toBe('killed');
  });

  it('tries each language the scope is written in, once each, until one fails the rule', async () => {
    // C# cannot spell left-pad in a using, so the files in C# come to nothing, and
    // two of them must not crowd out the one language that can.
    const result = await one('<!-- @assert-import-absence target="app" module="left-pad" -->', {
      'app/a.cs': 'using System;\n',
      'app/b.cs': 'using System;\n',
      'app/c.ts': 'export {};\n',
    });
    expect(said(result).probes).toEqual([
      ['max', 'killed', `added app/${PROVE_NAME}.ts importing left-pad`, 'expected no matches, found 1', [{ path: `app/${PROVE_NAME}.ts`, change: 'added', bytes: 19 }]],
    ]);
  });

  it('says so when no name can be written for the module', async () => {
    // A path never holds a NUL, so spec-core finds no name this pattern matches.
    const result = await one('<!-- @assert-import-absence target="src" module="db\u0000" -->');
    expect(result.unprovable).toBe('no module name matches db\u0000');
  });

  it('says so when no file under its target is in a language it reads', async () => {
    const result = await one('<!-- @assert-import-absence target="docs" module="x" allow-empty="true" -->', {});
    expect(result.outcome).toBe('unprovable');
    expect(result.unprovable).toBe('nothing under docs is a file a violation could be put beside');
  });
});

describe('a cycle rule', () => {
  it('is killed by two files that import each other', async () => {
    expect(said(await one('<!-- @assert-import-cycle target="src" -->')).probes).toEqual([
      [
        'max',
        'killed',
        `added src/${PROVE_NAME}-a.ts and src/${PROVE_NAME}-b.ts, which import each other`,
        'expected no import cycles, found 1',
        [
          { path: `src/${PROVE_NAME}-a.ts`, change: 'added', bytes: 31 },
          { path: `src/${PROVE_NAME}-b.ts`, change: 'added', bytes: 31 },
        ],
      ],
    ]);
  });

  it('adds as many cycles as its maximum takes to exceed', async () => {
    const result = await one('<!-- @assert-import-cycle target="src" max="1" -->');
    expect(result.probes[0]?.message).toBe('expected at most 1 import cycle, found 2');
  });

  it('survives when its exclude leaves out the graph', async () => {
    const result = await one('<!-- @assert-import-cycle target="src" exclude="src" allow-empty="true" -->', { ...TREE, 'src/x/d.ts': '' });
    expect(result.outcome).toBe('survived');
  });
});

describe('a layer rule', () => {
  const LAYERED = {
    'src/domain/user.ts': 'export const user = 1;\n',
    'src/app/service.ts': "import { user } from '../domain/user.js';\n",
  };

  it('is killed by a file in the lower layer importing the upper one', async () => {
    expect(said(await one('<!-- @assert-layers target="src" order="src/domain, src/app" -->', LAYERED)).probes).toEqual([
      [
        'max',
        'killed',
        `added src/domain/${PROVE_NAME}.ts in the layer src/domain, importing src/app from the layer src/app above it`,
        'expected no violating files, found 1',
        [{ path: `src/domain/${PROVE_NAME}.ts`, change: 'added', bytes: 18 }],
      ],
    ]);
  });

  it('puts the import at the top of a file when its layers are files', async () => {
    const result = await one('<!-- @assert-layers target="src" order="src/domain/user.ts, src/app/service.ts" -->', LAYERED);
    expect(result.probes[0]?.violation).toBe(
      'made src/domain/user.ts, in the layer src/domain/user.ts, import src/app/service.ts from the layer src/app/service.ts above it',
    );
    expect(result.outcome).toBe('killed');
  });

  it('survives when its exclude leaves out the lower layer', async () => {
    const result = await one('<!-- @assert-layers target="src" order="src/domain, src/app" exclude="src/domain" allow-empty="true" -->', LAYERED);
    expect(result.outcome).toBe('survived');
    expect(result.probes[0]?.violation).toBe(
      `added src/domain/${PROVE_NAME}.ts in the layer src/domain, importing src/app from the layer src/app above it, beside the code under src, none of which the rule reads`,
    );
  });

  it('says so when no name can be written for the layer above', async () => {
    const result = await one('<!-- @assert-layers target="src" order="src/domain, app\u0000" allow-empty="true" -->', LAYERED);
    expect(result.unprovable).toBe('no module name matches the layer app\u0000');
  });

  it('says so when no file sits below another layer', async () => {
    const result = await one('<!-- @assert-layers target="src/app" order="src/domain, src/app" allow-empty="true" -->', LAYERED);
    expect(result.unprovable).toBe('no file under its targets belongs to exactly one layer that another layer is listed after');
  });
});

/* --------------------------------------------------------------- structure */

describe('a structure rule', () => {
  it('is killed by a file no pattern names', async () => {
    const result = await one('<!-- @assert-structure target="src" pattern="[ab].ts" exclude="*.test.ts" -->');
    expect(said(result).probes).toEqual([
      ['max', 'killed', `added src/${PROVE_NAME}.ts, named by none of [ab].ts`, 'expected no misnamed files, found 1', [{ path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 0 }]],
    ]);
  });

  it('survives when every name it could see is one its patterns name', async () => {
    const result = await one('<!-- @assert-structure target="src" pattern="*" -->');
    expect(result.outcome).toBe('survived');
    expect(result.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts, named by none of *`);
  });

  it('is killed by taking a required entry out of a directory it selects', async () => {
    const files = { 'packages/a/package.json': '{}', 'packages/b/package.json': '{}', 'packages/b/README.md': '' };
    const result = await one('<!-- @assert-structure target="packages" dirs="*" required="package.json" -->', files);
    expect(said(result).probes).toEqual([
      [
        'max',
        'killed',
        'removed packages/a/package.json, which package.json names',
        'expected no directories missing an entry, found 1',
        [{ path: 'packages/a/package.json', change: 'removed' }],
      ],
    ]);
  });

  it('says so when it selects no directory', async () => {
    const result = await one('<!-- @assert-structure target="src" dirs="*" required="index.ts" allow-empty="true" -->');
    expect(result.unprovable).toBe('it selects no directory, so there is no entry to take away');
  });

  it('is killed by taking away a partner', async () => {
    const PAIRED = { 'src/a.ts': '', 'src/a.test.ts': '', 'src/b.ts': '', 'src/b.test.ts': '' };
    const result = await one('<!-- @assert-structure target="src" exclude="*.test.ts" partner="[name].test.[ext]" -->', PAIRED);
    expect(said(result).probes).toEqual([
      ['max', 'killed', 'removed src/a.test.ts, the partner of src/a.ts', 'expected no files without a partner, found 1', [{ path: 'src/a.test.ts', change: 'removed' }]],
    ]);
  });

  it('survives when its glob leaves out the code under its target', async () => {
    const result = await one('<!-- @assert-structure target="src" glob="*.js" partner="[name].test.[ext]" allow-empty="true" -->');
    expect(result.outcome).toBe('survived');
    expect(result.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts, with no partner, beside the code under src, none of which the rule reads`);
  });
});

describe('a presence rule', () => {
  it('is killed by removing what it names', async () => {
    expect(said(await one('<!-- @assert-present file="src/b.ts, src/a.ts" -->')).probes).toEqual([
      ['present', 'killed', 'removed src/b.ts', 'missing: src/b.ts', [{ path: 'src/b.ts', change: 'removed' }]],
    ]);
  });
});

/* ------------------------------------------------------------------- places */

describe('where a violation goes', () => {
  it('beside the first file of each extension, in that file\'s directory', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy" -->', { 'src/deep/a.ts': '', 'src/z.ts': '' });
    expect(result.probes[0]?.violation).toBe(`added src/deep/${PROVE_NAME}.ts holding "Legacy"`);
  });

  it('at the root, named without a directory', async () => {
    const result = await one('<!-- @assert-absence target="." symbol="Legacy" exclude="docs" -->', { 'a.ts': '' });
    expect(result.probes[0]?.changes).toEqual([{ path: `${PROVE_NAME}.ts`, change: 'added', bytes: 6 }]);
  });

  it('never over a file of the same name the rule already reads', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy" -->', { [`src/${PROVE_NAME}.ts`]: 'export {};\n' });
    expect(result.probes[0]?.violation).toBe(`put "Legacy" at the top of src/${PROVE_NAME}.ts`);
  });

  it('numbers the files it adds from the second, as many as the maximum takes', async () => {
    const result = await one('<!-- @assert-import-count target="src" module="node:fs" max="1" -->');
    expect(result.probes[0]?.changes).toEqual([
      { path: `src/${PROVE_NAME}.ts`, change: 'added', bytes: 18 },
      { path: `src/${PROVE_NAME}-2.ts`, change: 'added', bytes: 18 },
    ]);
    expect(result.probes[0]?.message).toBe('expected at most 1 match, found 2');
  });

  it('adds a cycle for each one the maximum takes', async () => {
    const result = await one('<!-- @assert-import-cycle target="src" max="1" -->');
    expect(result.probes[0]?.changes.map((change) => change.path)).toEqual([
      `src/${PROVE_NAME}-a.ts`,
      `src/${PROVE_NAME}-b.ts`,
      `src/${PROVE_NAME}-2-a.ts`,
      `src/${PROVE_NAME}-2-b.ts`,
    ]);
  });

  it('takes as many entries and partners away as the maximum takes', async () => {
    const packages = { 'packages/a/package.json': '{}', 'packages/b/package.json': '{}', 'packages/c/package.json': '{}' };
    const required = await one('<!-- @assert-structure target="packages" dirs="*" required="package.json" max="1" -->', packages);
    expect(required.probes[0]?.changes.map((change) => change.path)).toEqual(['packages/a/package.json', 'packages/b/package.json']);
    const paired = { 'src/a.ts': '', 'src/a.test.ts': '', 'src/b.ts': '', 'src/b.test.ts': '', 'src/c.ts': '', 'src/c.test.ts': '' };
    const partner = await one('<!-- @assert-structure target="src" exclude="*.test.ts" partner="[name].test.[ext]" max="1" -->', paired);
    expect(partner.probes[0]?.violation).toBe('removed src/a.test.ts, src/b.test.ts, the partner of src/a.ts, src/b.ts');
    expect(partner.outcome).toBe('killed');
  });

  it('takes an entry out of a directory a required rule names without dirs, and out of none it excludes', async () => {
    const files = { 'packages/a/package.json': '{}', 'lib/package.json': '{}' };
    const result = await one('<!-- @assert-structure target="lib, packages/a" exclude="lib" required="package.json" -->', files);
    expect(result.probes[0]?.violation).toBe('removed packages/a/package.json, which package.json names');
  });

  it('takes a nested required entry out of the directory that holds it', async () => {
    const files = { 'packages/a/src/index.ts': '', 'packages/a/src/other.ts': '' };
    const result = await one('<!-- @assert-structure target="packages" dirs="*" required="src/*.ts" -->', files);
    expect(result.probes[0]?.changes.map((change) => change.path)).toEqual(['packages/a/src/index.ts', 'packages/a/src/other.ts']);
    expect(result.outcome).toBe('killed');
  });
});

/* ---------------------------------------------------------- at the margins */

describe('a rule at the margins', () => {
  it('is run as a run runs it when prove is given no options', async () => {
    // Missing targets fail, an empty scope fails, and --strict is off: each is
    // what the run does, and a proof that ran rules otherwise would prove them
    // under rules nobody runs.
    expect((await one('<!-- @assert-absence target="gone" symbol="x" -->')).unprovable).toBe(
      'it fails on the tree as it stands (target path does not exist: gone), so no change can be shown to be what fails it',
    );
    expect((await one('<!-- @assert-absence target="src" symbol="x" glob="*.js" -->')).unprovable).toBe(
      'it fails on the tree as it stands (no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)), so no change can be shown to be what fails it',
    );
    const dynamic = { ...TREE, 'src/d.ts': 'await import(name);\n' };
    expect((await one('<!-- @assert-import-absence target="src" module="node:fs" -->', dynamic)).outcome).toBe('killed');
  });

  it('names every target it could not find, and every one with nothing under it', async () => {
    const missing = await one('<!-- @assert-absence target="gone, lost" symbol="x" allow-empty="true" -->', TREE, { allowMissingTargets: true });
    expect(missing.unprovable).toBe('none of its targets exists (gone, lost)');
    const io = memoryIo(ROOT, { 'docs/rules.md': '<!-- @assert-absence target="one, two" symbol="x" allow-empty="true" -->\n' }, ['one', 'two']);
    const empty = await proveSpecGuard({ patterns: ['docs/rules.md'], root: ROOT, io });
    expect(empty.results[0]?.unprovable).toBe('nothing under one, two is a file a violation could be put beside');
  });

  it('names every target of a rule that reads none of the code under them', async () => {
    const result = await one('<!-- @assert-absence target="src, lib" symbol="Legacy" glob="*.js" allow-empty="true" -->', { ...TREE, 'lib/x.ts': '' });
    expect(result.probes[0]?.violation).toBe(`added lib/${PROVE_NAME}.ts holding "Legacy", beside the code under src, lib, none of which the rule reads`);
  });

  it('says so when every place a violation could go is taken', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy" glob="*.js" allow-empty="true" -->', { [`src/${PROVE_NAME}.ts`]: '' });
    expect(result.unprovable).toBe('every place a violation could go is one the rule does not read, or holds a file already');
  });

  it('survives when the only files it reads are ones whose text it does not count', async () => {
    // A binary file is searched and not counted, so text put at its top shows
    // nothing - and a new file its glob would not read is never tried instead.
    const result = await one('<!-- @assert-absence target="src" symbol="Legacy" glob="data.bin" -->', { 'src/data.bin': 'raw\u0000bytes\n' });
    expect(result.outcome).toBe('survived');
    expect(result.probes[0]?.violation).toBe('put "Legacy" at the top of src/data.bin');
  });

  it('says what it took away when a minimum is crossed by lines, and by a match that spans them', async () => {
    const files = { 'src/1.ts': 'x\n', 'src/2.ts': 'x\na\nb\n' };
    const spans = await one('<!-- @assert-count target="src" symbol="x|a\\nb" regex="true" min="1" -->', files);
    expect(said(spans).probes).toEqual([
      [
        'min',
        'killed',
        'removed 1 line holding "x|a\\nb" from src/1.ts, and emptied src/2.ts, where a match spans lines',
        'expected at least 1 match, found 0',
        [
          { path: 'src/1.ts', change: 'replaced', bytes: 0 },
          { path: 'src/2.ts', change: 'replaced', bytes: 0 },
        ],
      ],
    ]);
    // The lines that are left are joined as they were, so no match is made of them.
    const joined = await one('<!-- @assert-count target="src" symbol="export" min="1" -->', { 'src/3.ts': 'ex\nport\nexport\n' });
    expect(said(joined).probes[0]?.[2]).toBe('removed 1 line holding "export" from src/3.ts');
    expect(said(joined).probes[0]?.[4]).toEqual([{ path: 'src/3.ts', change: 'replaced', bytes: 8 }]);
  });

  it('says so when text it wrote for a regular expression does not match it', async () => {
    expect((await one('<!-- @assert-absence target="src" symbol="a\\r" regex="true" -->')).outcome).toBe('unprovable');
  });

  it('names every file it adds, empties or is named by', async () => {
    const imports = await one('<!-- @assert-import-count target="src" module="node:fs" max="1" -->');
    expect(imports.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts, src/${PROVE_NAME}-2.ts importing node:fs`);
    const two = await one('<!-- @assert-import-count target="src" module="src/b.js" min="1" -->', { ...TREE, 'src/d.ts': "import './b.js';\n" });
    expect(two.probes.map((probe) => probe.violation)).toEqual(['emptied src/a.ts, src/d.ts, the files importing it']);
    const named = await one('<!-- @assert-structure target="src" pattern="a.ts, b.ts" exclude="*.test.ts" -->');
    expect(named.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts, named by none of a.ts, b.ts`);
  });
});

describe('a layer rule at the margins', () => {
  const LAYERED = {
    'src/domain/user.ts': 'export const user = 1;\n',
    'src/app/service.ts': "import { user } from '../domain/user.js';\n",
  };

  it('adds as many files as its maximum takes, all in the lower layer', async () => {
    const result = await one('<!-- @assert-layers target="src" order="src/domain, src/app" max="1" -->', LAYERED);
    expect(result.probes[0]?.violation).toBe(
      `added src/domain/${PROVE_NAME}.ts, src/domain/${PROVE_NAME}-2.ts in the layer src/domain, importing src/app from the layer src/app above it`,
    );
  });

  it('puts nothing beside a file no layer claims', async () => {
    // src/a/util.ts belongs to no layer, and comes first.
    const result = await one('<!-- @assert-layers target="src" order="src/domain, src/app" -->', { ...LAYERED, 'src/a/util.ts': '' });
    expect(result.probes[0]?.violation).toBe(`added src/domain/${PROVE_NAME}.ts in the layer src/domain, importing src/app from the layer src/app above it`);
  });

  it('adds no file its layers do not claim, even where the rule reads nothing', async () => {
    const result = await one(
      '<!-- @assert-layers target="src" order="src/domain/user.ts, src/app/service.ts" exclude="src/domain" allow-empty="true" -->',
      LAYERED,
    );
    expect(result.unprovable).toBe('every place a violation could go is one the rule does not read, or holds a file already');
  });

  it('says so when its targets are missing', async () => {
    const result = await one('<!-- @assert-layers target="gone" order="a, b" allow-empty="true" -->', LAYERED, { allowMissingTargets: true });
    expect(result.unprovable).toBe('none of its targets exists (gone)');
  });
});

describe('a cycle or structure rule at the margins', () => {
  it('pairs the files it adds by name, whatever the directory is called', async () => {
    const result = await one('<!-- @assert-import-cycle target="my-app" -->', { 'my-app/x.ts': '' });
    expect(result.probes[0]?.changes.map((change) => change.path)).toEqual([`my-app/${PROVE_NAME}-a.ts`, `my-app/${PROVE_NAME}-b.ts`]);
    expect(result.outcome).toBe('killed');
  });

  it('says so when its targets are missing', async () => {
    const options = { allowMissingTargets: true };
    expect((await one('<!-- @assert-import-cycle target="gone" allow-empty="true" -->', TREE, options)).unprovable).toBe('none of its targets exists (gone)');
    expect((await one('<!-- @assert-structure target="gone" pattern="*.ts" allow-empty="true" -->', TREE, options)).unprovable).toBe(
      'none of its targets exists (gone)',
    );
  });

  it('takes out only the entries a required rule names, in order', async () => {
    const files = { 'packages/a/b.json': '{}', 'packages/a/a.json': '{}', 'packages/a/README.md': '' };
    const result = await one('<!-- @assert-structure target="packages" dirs="*" required="*.json" -->', files);
    expect(result.probes[0]?.violation).toBe('removed packages/a/a.json, packages/a/b.json, which *.json names');
  });

  it('selects only the directories its dirs and exclude choose, and passes over a target that is gone', async () => {
    const files = {
      'packages/a/package.json': '{}',
      'packages/a/src/x.ts': '',
      'packages/b/package.json': '{}',
      'packages/c/package.json': '{}',
    };
    const deeper = await one('<!-- @assert-structure target="packages, gone" dirs="*" required="package.json" max="1" -->', files, {
      allowMissingTargets: true,
    });
    expect(deeper.probes[0]?.violation).toBe('removed packages/a/package.json, packages/b/package.json, which package.json names');
    const excluded = await one('<!-- @assert-structure target="packages" dirs="*" exclude="a" required="package.json" -->', files);
    expect(excluded.probes[0]?.violation).toBe('removed packages/b/package.json, which package.json names');
  });

  it('takes away only the partners a file has', async () => {
    const files = { 'src/a.ts': '', 'src/a.test.ts': '' };
    const result = await one('<!-- @assert-structure target="src" exclude="*.test.ts, *.spec.ts" partner="[name].spec.[ext], [name].test.[ext]" -->', files);
    expect(result.probes[0]?.violation).toBe('removed src/a.test.ts, the partner of src/a.ts');
  });
});

/* ------------------------------------------------------------ what is left */

describe('what the survivors of a sweep asked for', () => {
  it('runs rules strictly, and over an empty scope, when told to', async () => {
    const dynamic = { ...TREE, 'src/d.ts': 'await import(name);\n' };
    expect((await one('<!-- @assert-import-absence target="src" module="node:fs" -->', dynamic, { strictTargets: true })).unprovable).toMatch(
      /^it fails on the tree as it stands \(expected no matches, found 0; 1 reference could not be resolved\)/,
    );
    const empty = await one('<!-- @assert-absence target="src" symbol="x" glob="*.js" -->', TREE, { allowEmptyScope: true });
    expect(empty.outcome).toBe('survived');
  });

  it('puts an import only beside files in a language it reads', async () => {
    const result = await one('<!-- @assert-import-absence target="notes" module="x" allow-empty="true" -->', { 'notes/a.md': '' });
    expect(result.unprovable).toBe('nothing under notes is a file a violation could be put beside');
  });

  it('adds every file a maximum takes, or none, and never over a file that is there', async () => {
    // Two files are needed and the second name is taken, so the kind is passed
    // over, and one import at the top of a file would be one file, not two.
    const result = await one('<!-- @assert-import-count target="src" module="node:fs" max="1" -->', { ...TREE, [`src/${PROVE_NAME}-2.ts`]: '' });
    expect(result.unprovable).toBe('every place a violation could go is one the rule does not read, or holds a file already');
  });

  it('puts an import at the top of no file the rule does not read', async () => {
    const result = await one('<!-- @assert-import-absence target="src" module="x" exclude="*.ts" allow-empty="true" -->', {
      ...TREE,
      [`src/${PROVE_NAME}.ts`]: '',
    });
    expect(result.unprovable).toBe('every place a violation could go is one the rule does not read, or holds a file already');
  });

  it('adds as many files as a layer maximum takes, and makes no file import across when one is not enough', async () => {
    const LAYERED = { 'src/domain/user.ts': '', 'src/app/service.ts': "import '../domain/user.js';\n" };
    const result = await one('<!-- @assert-layers target="src" order="src/domain/user.ts, src/app/service.ts" max="1" -->', LAYERED);
    expect(result.unprovable).toBe('every place a violation could go is one the rule does not read, or holds a file already');
  });

  it('names every file a minimum empties and every module no name was found for', async () => {
    const spans = { 'src/m.ts': 'a\nb\n', 'src/n.ts': 'a\nb\n' };
    const emptied = await one('<!-- @assert-count target="src" symbol="a\\nb" regex="true" min="1" -->', spans);
    expect(emptied.probes[0]?.violation).toBe('emptied src/m.ts, src/n.ts, where a match spans lines');
    const modules = await one('<!-- @assert-import-absence target="src" module="db\u0000, x\u0000" -->');
    expect(modules.unprovable).toBe('no module name matches db\u0000, x\u0000');
  });

  it('names every misnamed file it adds', async () => {
    const result = await one('<!-- @assert-structure target="src" pattern="[ab].ts" exclude="*.test.ts" max="1" -->');
    expect(result.probes[0]?.violation).toBe(`added src/${PROVE_NAME}.ts, src/${PROVE_NAME}-2.ts, named by none of [ab].ts`);
  });

  it('passes over a required rule\'s target that is gone, wherever it is listed', async () => {
    const result = await one('<!-- @assert-structure target="gone, packages/a" required="package.json" -->', { 'packages/a/package.json': '{}' }, { allowMissingTargets: true });
    expect(result.probes[0]?.violation).toBe('removed packages/a/package.json, which package.json names');
  });

  it('carries no reason on a rule that was proved', async () => {
    expect(Object.keys(await one('<!-- @assert-absence target="src" symbol="Legacy" -->'))).not.toContain('unprovable');
  });

  it('writes an import in the notation of each language', () => {
    expect(importLine('.pyi', 'app/db')).toBe('import app.db\n');
    expect(importLine('.py', 'app/db')).toBe('import app.db\n');
    expect(importLine('.rs', 'crate/db')).toBe('use crate::db;\n');
    expect(importLine('.cs', 'App/Db')).toBe('using App.Db;\n');
    expect(importLine('.ts', 'src/db')).toBe("import 'src/db';\n");
  });
});

/* ----------------------------------------------------------- what it says */

describe('a rule no violation can be shown to fail', () => {
  it('is one that fails already', async () => {
    const result = await one('<!-- @assert-absence target="src" symbol="export" -->');
    expect(said(result)).toEqual({
      outcome: 'unprovable',
      unprovable: 'it fails on the tree as it stands (expected no matches, found 2), so no change can be shown to be what fails it',
      probes: [],
    });
  });

  it('is one whose targets are all missing', async () => {
    const result = await one('<!-- @assert-absence target="gone" symbol="x" allow-empty="true" -->', TREE, { allowMissingTargets: true });
    expect(result.unprovable).toBe('none of its targets exists (gone)');
  });
});

describe('the report', () => {
  const RULES = [
    '<!-- @assert-absence target="src" symbol="Legacy" -->',
    '<!-- @assert-structure target="src" pattern="*" -->',
    '<!-- @assert-absence target="src" symbol="export" -->',
  ].join('\n');

  it('counts each outcome, and is not ok while a rule survives', async () => {
    const report = await prove(RULES);
    expect(report.summary).toEqual({ specs: 1, total: 3, killed: 1, survived: 1, unprovable: 1, inactive: 0 });
    expect(report.ok).toBe(false);
    expect(report.specFiles).toEqual(['docs/rules.md']);
    expect(report.root).toBe(ROOT);
    expect((await prove('<!-- @assert-absence target="src" symbol="Legacy" -->')).ok).toBe(true);
  });

  it('is not ok when a directive cannot be read, and says which', async () => {
    const report = await prove('<!-- @assert-absence target="src" symbol="x" glob="[a" -->');
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.message)).toEqual(['Attribute "glob" has an invalid glob pattern "[a": a "[" is never closed.']);
  });

  it('proves nothing in a document that is not in force, unless told to', async () => {
    const draft = `---\nstatus: draft\n---\n${RULES}`;
    const withheld = await prove(draft);
    expect(withheld.summary).toMatchObject({ total: 0, inactive: 3 });
    expect(withheld.inactiveSpecs).toEqual([{ file: 'docs/rules.md', status: 'draft', label: 'draft', directives: 3 }]);
    expect((await prove(draft, TREE, { ignoreStatus: true })).summary.total).toBe(3);
  });

  it('is the same every time the tree is', async () => {
    const timeless = (report: ProveReport) => JSON.parse(formatProveJson(report), (key, value: unknown) => (key === 'durationMs' ? 0 : value));
    expect(timeless(await prove(RULES))).toEqual(timeless(await prove(RULES)));
  });
});

describe('on disk', () => {
  let root: string | undefined;
  afterAll(async () => {
    if (root) await removeTempRepo(root);
  });

  it('writes nothing, and leaves every file as it was', async () => {
    root = await makeTempRepo({
      'docs/rules.md': [
        '<!-- @assert-absence target="src" symbol="Legacy" -->',
        '<!-- @assert-count target="src" symbol="export" min="1" -->',
        '<!-- @assert-import-cycle target="src" -->',
        '<!-- @assert-present file="src/b.ts" -->',
        '<!-- @assert-structure target="src" exclude="*.test.ts, b.ts" partner="[name].test.[ext]" -->',
      ].join('\n'),
      ...TREE,
      'src/a.test.ts': '',
    });
    const snapshot = async (): Promise<string[]> => {
      const files: string[] = [];
      for await (const file of walkFiles(root as string)) {
        files.push(`${file.relativePath} ${createHash('sha256').update(await fs.readFile(file.absolutePath)).digest('hex')}`);
      }
      return files;
    };
    const before = await snapshot();
    const report = await proveSpecGuard({ patterns: ['docs/rules.md'], root });
    expect(report.summary).toMatchObject({ total: 5, killed: 5 });
    expect(await snapshot()).toEqual(before);
    expect(before.some((line) => line.includes(PROVE_NAME))).toBe(false);
  });
});

/* --------------------------------------------------------- the command line */

describe('spec-guard prove', () => {
  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.splice(0).map(removeTempRepo));
  });

  const RULES = [
    '<!-- @assert-absence target="src" symbol="Legacy" reason="the gateway is gone" -->',
    '<!-- @assert-structure target="src" pattern="*" -->',
    '<!-- @assert-absence target="src" symbol="export" -->',
  ].join('\n');

  async function run(argv: string[], files: Record<string, string> = { 'docs/rules.md': RULES, ...TREE }) {
    const root = await makeTempRepo(files);
    temporary.push(root);
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIO = {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: { NO_COLOR: '1', TERM: 'xterm' },
      cwd: root,
      isTTY: false,
    };
    const code = await main(['prove', ...argv], cli);
    // The duration is the only thing in the output that differs between runs.
    return { code, out: out.join('\n').replace(/ · \d+(?:\.\d+)?m?s$/m, ' · Xms'), err };
  }

  it('prints what survived and what could not be proved, and exits 1 when anything survived', async () => {
    const { code, out, err } = await run(['docs/rules.md']);
    expect(err).toEqual([]);
    expect(out).toBe(
      [
        'spec-guard prove 1 spec · 3 rules',
        '',
        '✖ docs/rules.md:2  @assert-structure  passed with a violation in place',
        '    files in src must be named *',
        `    maximum: added src/${PROVE_NAME}.ts, named by none of *, and it still passed: expected no misnamed files, found 0`,
        '',
        '○ docs/rules.md:3  @assert-absence  no violation could be made',
        '    "export" must not appear in src',
        '    it fails on the tree as it stands (expected no matches, found 2), so no change can be shown to be what fails it',
        '',
        '1 seen to fail · 1 survived · 1 unprovable · Xms',
        '✖ 1 rule passed with a violation of itself in place',
      ].join('\n'),
    );
    expect(code).toBe(1);
  });

  it('prints every rule under --verbose, those seen to fail last, with the reason each gives', async () => {
    const { out } = await run(['docs/rules.md', '--verbose']);
    expect(out).toContain(
      [
        '✔ docs/rules.md:1  @assert-absence  seen to fail',
        '    "Legacy" must not appear in src',
        `    maximum: added src/${PROVE_NAME}.ts holding "Legacy", and it failed: expected no matches, found 1`,
        '    reason: the gateway is gone',
        '',
        '1 seen to fail',
      ].join('\n'),
    );
  });

  it('exits 0 when every rule was seen to fail, and says so', async () => {
    const { code, out } = await run(['docs/rules.md'], { 'docs/rules.md': RULES.split('\n')[0] as string, ...TREE });
    expect(out.split('\n').slice(-2)).toEqual(['1 seen to fail · Xms', '✔ every rule in force was seen to fail']);
    expect(code).toBe(0);
  });

  it('exits 1 for a rule no violation could be made for only under --strict', async () => {
    const files = { 'docs/rules.md': RULES.split('\n')[2] as string, ...TREE };
    expect((await run(['docs/rules.md'], files)).code).toBe(0);
    expect((await run(['docs/rules.md', '--strict'], files)).code).toBe(1);
    // --strict with every rule seen to fail is a clean proof.
    const killed = { 'docs/rules.md': RULES.split('\n')[0] as string, ...TREE };
    expect((await run(['docs/rules.md', '--strict'], killed)).code).toBe(0);
  });

  it('paints for a terminal, and names the version it was in SARIF', async () => {
    const root = await makeTempRepo({ 'docs/rules.md': RULES, ...TREE });
    temporary.push(root);
    const out: string[] = [];
    const tty: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: { TERM: 'xterm' }, cwd: root, isTTY: true };
    await main(['prove', 'docs/rules.md'], tty);
    expect(out.join('\n')).toContain(`${String.fromCharCode(27)}[1m${String.fromCharCode(27)}[34mspec-guard prove`);
    const sarif = JSON.parse((await run(['docs/rules.md', '--format', 'sarif'])).out) as { runs: Array<{ tool: { driver: { version: string } } }> };
    expect(sarif.runs[0]?.tool.driver.version).toBe(version());
  });

  it('writes a versioned JSON document', async () => {
    const { code, out } = await run(['docs/rules.md', '--json']);
    const document = JSON.parse(out) as { formatVersion: number; ok: boolean; summary: object; results: Array<{ outcome: string; spec: object }> };
    expect(document.formatVersion).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.summary).toEqual({ specs: 1, total: 3, killed: 1, survived: 1, unprovable: 1, inactive: 0 });
    expect(document.results.map((result) => [result.outcome, result.spec])).toEqual([
      ['killed', { file: 'docs/rules.md', line: 1, column: 1 }],
      ['survived', { file: 'docs/rules.md', line: 2, column: 1 }],
      ['unprovable', { file: 'docs/rules.md', line: 3, column: 1 }],
    ]);
    expect(code).toBe(1);
  });

  it('writes SARIF with a result on each directive that survived or could not be proved', async () => {
    const { out } = await run(['docs/rules.md', '--format', 'sarif']);
    const sarif = JSON.parse(out) as {
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        results: Array<{ ruleId: string; level: string; message: { text: string } }>;
      }>;
    };
    const [first] = sarif.runs;
    expect(first?.tool.driver.name).toBe('spec-guard prove');
    expect(first?.tool.driver.rules.map((rule) => rule.id)).toEqual(['rule-cannot-fail', 'rule-unprovable', 'invalid-directive']);
    expect(first?.results.map((result) => [result.ruleId, result.level, result.message.text])).toEqual([
      [
        'rule-cannot-fail',
        'error',
        `files in src must be named *: added src/${PROVE_NAME}.ts, named by none of *, and it still passed: expected no misnamed files, found 0`,
      ],
      [
        'rule-unprovable',
        'note',
        '"export" must not appear in src: it fails on the tree as it stands (expected no matches, found 2), so no change can be shown to be what fails it',
      ],
    ]);
  });

  it('refuses the options that mean nothing to a proof', async () => {
    for (const option of ['--engine', '--concurrency', '--max-snippets']) {
      const { code, err } = await run([option, '1']);
      expect(code).toBe(2);
      expect(err[0]).toBe(`Option ${option} does not apply to spec-guard prove.`);
    }
    for (const option of ['--watch', '--fail-fast', '--print-baseline']) {
      expect((await run([option])).err[0]).toBe(`Option ${option} does not apply to spec-guard prove.`);
    }
  });

  it('exits 2 when no spec matched, and 0 with --allow-empty', async () => {
    const missing = await run(['nowhere/*.md', 'elsewhere/*.md']);
    expect(missing.code).toBe(2);
    expect(missing.err).toEqual(['spec-guard: no spec files matched "nowhere/*.md", "elsewhere/*.md"']);
    expect((await run(['nowhere/*.md', '--allow-empty'])).code).toBe(0);
    const json = await run(['nowhere/*.md', '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ summary: { specs: 0 } });
  });

  it('names what it could not read and what is not in force, and says when it proved nothing', async () => {
    const { code, out } = await run(['docs'], {
      'docs/draft.md': `---\nstatus: draft\n---\n${RULES}\n`,
      'docs/typo.md': '<!-- @assert-absence target="src" symbol="x" glob="[a" -->\n',
      ...TREE,
    });
    expect(out).toBe(
      [
        'spec-guard prove 2 specs · 0 rules',
        '',
        '⚠ docs/typo.md:1  invalid directive',
        '    Attribute "glob" has an invalid glob pattern "[a": a "[" is never closed.',
        '    <!-- @assert-absence target="src" symbol="x" glob="[a" -->',
        '',
        '○ docs/draft.md is draft - 3 rules not proved',
        '',
        '0 seen to fail · 1 invalid · 3 not in force · Xms',
        '⚠ no rule was proved, so nothing was shown',
      ].join('\n'),
    );
    expect(code).toBe(1);
  });

  it('exits 2 for a spec pattern it cannot read', async () => {
    const { code, err } = await run(['docs/[rules.md']);
    expect(code).toBe(2);
    expect(err).toEqual(['spec-guard: invalid spec pattern "docs/[rules.md": a "[" is never closed']);
  });

  it('takes what decides a rule from the configuration, and says so', async () => {
    const files = {
      '.spec-guard.json': JSON.stringify({ specs: ['docs/rules.md'], exclude: ['gen'], engine: 'js', maxSnippets: 2 }),
      'docs/rules.md': RULES.split('\n')[0] as string,
      ...TREE,
    };
    const { code, out } = await run([], files);
    expect(out).toContain('options from .spec-guard.json: specs, exclude (gen)\n');
    expect(code).toBe(0);
  });

  it('takes every option that decides whether a rule passes, and none that schedules a run', async () => {
    const options = { strict: true, allowMissingTargets: true, allowEmptyScope: true, ignoreStatus: true, includeSpecs: true, defaultSkips: false, concurrency: 2 };
    const files = { '.spec-guard.json': JSON.stringify({ specs: ['docs/rules.md'], ...options }), 'docs/rules.md': RULES.split('\n')[0] as string, ...TREE };
    const { out } = await run([], files);
    expect(out).toContain('options from .spec-guard.json: specs, strict, allowMissingTargets, allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips\n');
  });
});

/* ------------------------------------------------------- the report, rendered */

describe('the report, rendered', () => {
  const at = (relativeFile: string, line: number) => ({ file: path.join(ROOT, relativeFile), relativeFile, line, column: 1 });
  const probe = (claim: 'max' | 'min', outcome: 'killed' | 'survived', violation: string, message: string) => ({
    claim,
    outcome,
    violation,
    changes: [{ path: 'src/x.ts', change: 'added' as const, bytes: 6 }],
    message,
    actual: 1,
  });
  const REPORT: ProveReport = {
    ok: false,
    root: ROOT,
    durationMs: 1234.56789,
    summary: { specs: 2, total: 4, killed: 1, survived: 2, unprovable: 1, inactive: 3 },
    results: [
      {
        kind: 'assert-absence',
        location: at('docs/rules.md', 1),
        description: '"Legacy" must not appear in src',
        reason: 'the gateway is gone',
        outcome: 'killed',
        probes: [probe('max', 'killed', 'added src/x.ts holding "Legacy"', 'expected no matches, found 1')],
        durationMs: 1.23456,
      },
      {
        kind: 'assert-count',
        location: at('docs/rules.md', 2),
        description: '"X" must appear between 1 and 5 times in src',
        outcome: 'survived',
        probes: [probe('max', 'survived', 'added a', 'first'), probe('min', 'killed', 'removed b', 'second')],
        durationMs: 2,
      },
      {
        kind: 'assert-structure',
        location: at('docs/rules.md', 3),
        description: 'files in src must be named *',
        outcome: 'survived',
        probes: [probe('max', 'survived', 'added c', 'third'), probe('max', 'survived', 'added d', 'fourth')],
        durationMs: 3,
      },
      {
        kind: 'assert-import-absence',
        location: at('docs/rules.md', 4),
        description: 'src must not import "x"',
        outcome: 'unprovable',
        unprovable: 'none of its targets exists (src)',
        probes: [],
        durationMs: 4,
      },
    ],
    errors: [{ location: at('docs/typo.md', 9), message: 'Unknown attribute "expct".', raw: '<!-- @assert-count expct="1"\n  target="src" -->' }],
    inactiveSpecs: [{ file: 'docs/draft.md', status: 'draft', label: 'Draft', directives: 3 }],
    exclude: ['gen'],
    config: { file: '.spec-guard.json', applied: ['specs'], overridden: [] },
    specFiles: ['docs/rules.md', 'docs/draft.md'],
  };

  const E = String.fromCharCode(27);
  const [R, B, D, RED, GREEN, YELLOW, BLUE, MAGENTA] = ['0m', '1m', '2m', '31m', '32m', '33m', '34m', '35m'].map((code) => `${E}[${code}`);

  it('paints each part as the run does, survivors first and those seen to fail last', () => {
    expect(formatProve(REPORT, { color: true, verbose: true }).split('\n')).toEqual([
      `${B}${BLUE}spec-guard prove${R} ${D}2 specs · 4 rules${R}`,
      '',
      `${RED}${B}✖${R} ${B}docs/rules.md:2${R}  ${MAGENTA}@assert-count${R}  passed with a violation in place`,
      '    "X" must appear between 1 and 5 times in src',
      `    maximum: added a, ${RED}${B}and it still passed${R}: ${D}first${R}`,
      `    minimum: removed b, ${GREEN}and it failed${R}: ${D}second${R}`,
      '',
      `${RED}${B}✖${R} ${B}docs/rules.md:3${R}  ${MAGENTA}@assert-structure${R}  passed with a violation in place`,
      '    files in src must be named *',
      `    maximum: added c, ${RED}${B}and it still passed${R}: ${D}third${R}`,
      `    maximum: added d, ${RED}${B}and it still passed${R}: ${D}fourth${R}`,
      '',
      `${YELLOW}○${R} ${B}docs/rules.md:4${R}  ${MAGENTA}@assert-import-absence${R}  no violation could be made`,
      '    src must not import "x"',
      `    ${YELLOW}none of its targets exists (src)${R}`,
      '',
      `${GREEN}✔${R} ${B}docs/rules.md:1${R}  ${MAGENTA}@assert-absence${R}  seen to fail`,
      '    "Legacy" must not appear in src',
      `    maximum: added src/x.ts holding "Legacy", ${GREEN}and it failed${R}: ${D}expected no matches, found 1${R}`,
      `    ${D}reason: the gateway is gone${R}`,
      '',
      `${YELLOW}${B}⚠${R} ${B}docs/typo.md:9${R}  ${YELLOW}invalid directive${R}`,
      '    Unknown attribute "expct".',
      `    ${D}<!-- @assert-count expct="1"${R}`,
      '',
      `${D}○ docs/draft.md is Draft - 3 rules not proved${R}`,
      '',
      'options from .spec-guard.json: specs',
      'exclude from the command line: gen',
      '',
      [
        `${GREEN}1 seen to fail${R}`,
        `${RED}${B}2 survived${R}`,
        `${YELLOW}1 unprovable${R}`,
        `${YELLOW}1 invalid${R}`,
        `${D}3 not in force${R}`,
        `${D}1.23s${R}`,
      ].join(`${D} · ${R}`),
      `${RED}${B}✖ 2 rules passed with a violation of themselves in place${R}`,
    ]);
  });

  it('writes glyphs a legacy console can show when asked, and the others when not', () => {
    const glyphs = (ascii?: boolean): string[] =>
      formatProve(REPORT, { color: false, verbose: true, ...(ascii === undefined ? {} : { ascii }) })
        .split('\n')
        .filter((line) => /^[^\s\d] /.test(line))
        .map((line) => line.charAt(0));
    expect(glyphs(true)).toEqual(['x', 'x', 'o', '+', '!', 'o', 'x']);
    expect(glyphs()).toEqual(['✖', '✖', '○', '✔', '⚠', '○', '✖']);
  });

  it('closes in colour on a proof that showed every rule failing, or showed nothing', () => {
    const proved = { ...REPORT, results: [], errors: [], inactiveSpecs: [], summary: { ...REPORT.summary, total: 1, killed: 1, survived: 0, unprovable: 0, inactive: 0 } };
    expect(formatProve(proved, { color: true, verbose: false }).split('\n').at(-1)).toBe(`${GREEN}✔ every rule in force was seen to fail${R}`);
    const nothing = { ...proved, summary: { ...proved.summary, total: 0, killed: 0 } };
    expect(formatProve(nothing, { color: true, verbose: false }).split('\n').at(-1)).toBe(`${YELLOW}⚠ no rule was proved, so nothing was shown${R}`);
  });

  it('calls a presence rule\'s claim by its name', () => {
    const present = {
      ...REPORT.results[0],
      kind: 'assert-present' as const,
      probes: [{ ...probe('max', 'killed', 'removed src/b.ts', 'missing: src/b.ts'), claim: 'present' as const }],
    } as ProveResult;
    expect(formatProve({ ...REPORT, results: [present] }, { color: false, verbose: true })).toContain(
      '    presence: removed src/b.ts, and it failed: missing: src/b.ts\n',
    );
  });

  it('ends on the summary when nothing survived and not every rule was seen to fail', () => {
    const quiet = { ...REPORT, results: [], errors: [], inactiveSpecs: [], summary: { ...REPORT.summary, total: 2, killed: 1, survived: 0 } };
    expect(formatProve(quiet, { color: false, verbose: false }).split('\n').at(-1)).toBe('1 seen to fail · 1 unprovable · 3 not in force · 1.23s');
  });

  it('writes a JSON document a script can read, with durations to the microsecond', () => {
    const document = JSON.parse(formatProveJson(REPORT)) as Record<string, unknown>;
    expect(document).toEqual({
      formatVersion: 1,
      ok: false,
      root: ROOT,
      durationMs: 1234.568,
      summary: REPORT.summary,
      specFiles: REPORT.specFiles,
      results: REPORT.results.map((result) => ({
        outcome: result.outcome,
        kind: result.kind,
        spec: { file: 'docs/rules.md', line: result.location.line, column: 1 },
        description: result.description,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.unprovable === undefined ? {} : { unprovable: result.unprovable }),
        probes: result.probes,
        durationMs: result.durationMs === 1.23456 ? 1.235 : result.durationMs,
      })),
      errors: [{ spec: { file: 'docs/typo.md', line: 9, column: 1 }, message: 'Unknown attribute "expct".', raw: '<!-- @assert-count expct="1"\n  target="src" -->' }],
      specWarnings: [],
      inactiveSpecs: REPORT.inactiveSpecs,
      exclude: ['gen'],
      config: REPORT.config,
    });
  });

  it('writes SARIF with the violations that survived, on the directive that stated the rule', () => {
    const fingerprint = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
    const place = (uri: string, line: number) => ({ physicalLocation: { artifactLocation: { uri }, region: { startLine: line, startColumn: 1 } } });
    const sarif = JSON.parse(formatProveSarif(REPORT)) as {
      $schema: string;
      version: string;
      runs: Array<{ tool: { driver: Record<string, unknown> }; results: unknown[] }>;
    };
    expect([sarif.$schema, sarif.version]).toEqual(['https://json.schemastore.org/sarif-2.1.0.json', '2.1.0']);
    expect(sarif.runs[0]?.tool.driver).toEqual({
      name: 'spec-guard prove',
      informationUri: 'https://github.com/DescentVTT/spec-guard',
      version: '0.0.0',
      rules: [
        { id: 'rule-cannot-fail', name: 'rule-cannot-fail', shortDescription: { text: 'A rule that passed with a violation of itself in place.' } },
        { id: 'rule-unprovable', name: 'rule-unprovable', shortDescription: { text: 'A rule no violation could be made for.' } },
        { id: 'invalid-directive', name: 'invalid-directive', shortDescription: { text: 'A directive that could not be parsed, so nothing was checked.' } },
      ],
    });
    expect(sarif.runs[0]?.results).toEqual([
      {
        ruleId: 'rule-cannot-fail',
        level: 'error',
        message: { text: '"X" must appear between 1 and 5 times in src: added a, and it still passed: first' },
        locations: [place('docs/rules.md', 2)],
        partialFingerprints: { specGuardAssertion: fingerprint('docs/rules.md', 'assert-count', '"X" must appear between 1 and 5 times in src') },
      },
      {
        ruleId: 'rule-cannot-fail',
        level: 'error',
        message: { text: 'files in src must be named *: added c, and it still passed: third; added d, and it still passed: fourth' },
        locations: [place('docs/rules.md', 3)],
        partialFingerprints: { specGuardAssertion: fingerprint('docs/rules.md', 'assert-structure', 'files in src must be named *') },
      },
      {
        ruleId: 'rule-unprovable',
        level: 'note',
        message: { text: 'src must not import "x": none of its targets exists (src)' },
        locations: [place('docs/rules.md', 4)],
        partialFingerprints: { specGuardAssertion: fingerprint('docs/rules.md', 'assert-import-absence', 'src must not import "x"') },
      },
      {
        ruleId: 'invalid-directive',
        level: 'error',
        message: { text: 'Unknown attribute "expct".' },
        locations: [place('docs/typo.md', 9)],
        partialFingerprints: { specGuardAssertion: fingerprint('docs/typo.md', 'invalid', 'Unknown attribute "expct".') },
      },
    ]);
  });
});
