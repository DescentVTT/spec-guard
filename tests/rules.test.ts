/**
 * Which rules govern a path, decided without reading the codebase.
 *
 * Every "governs" here sits beside a path that must not be governed and differs
 * from it in exactly one thing - a prefix, a segment, an extension - because a
 * governance check that says yes to everything passes every positive test ever
 * written for it. The claim that this arithmetic agrees with the real walk is
 * tested separately, over real trees, in query-equivalence.test.ts.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../src/parser.js';
import { governs, layerPosition, viewRule, within, type DocumentView, type QueryPath } from '../src/rules.js';
import { resolveDirective } from '../src/runner.js';
import { DEFAULT_SCOPE, SCAN_EVERYTHING } from '../src/scope.js';
import type { Assertion } from '../src/types.js';

const ROOT = path.resolve('/virtual/repo');
const SPEC = path.resolve(ROOT, 'docs/a.md');

function rules(markdown: string, options: { includeSpecs?: boolean; scanEverything?: boolean } = {}): Assertion[] {
  const { directives, errors } = parseDirectives(markdown, { file: SPEC, relativeFile: 'docs/a.md' });
  expect(errors).toEqual([]);
  return directives.map((directive) => {
    const resolved = resolveDirective(directive, {
      root: ROOT,
      excludeFiles: new Set(options.includeSpecs ? [] : [SPEC]),
      scope: options.scanEverything ? SCAN_EVERYTHING : DEFAULT_SCOPE,
    });
    if ('error' in resolved) throw new Error(resolved.error.message);
    return resolved.assertion;
  });
}

function rule(markdown: string, options: { includeSpecs?: boolean; scanEverything?: boolean } = {}): Assertion {
  const all = rules(markdown, options);
  expect(all).toHaveLength(1);
  return all[0] as Assertion;
}

const file = (relative: string): QueryPath => ({ path: relative, shape: 'file', absolutePath: path.resolve(ROOT, relative) });
const dir = (relative: string): QueryPath => ({ path: relative, shape: 'directory', absolutePath: path.resolve(ROOT, relative) });

/** The paths a rule governs, out of a list. */
function governed(assertion: Assertion, queries: readonly QueryPath[]): string[] {
  return queries.filter((query) => governs(assertion, query)).map((query) => `${query.path}${query.shape === 'directory' ? '/' : ''}`);
}

describe('within', () => {
  it('is the path itself or anything under it, and the root holds everything', () => {
    expect(within('src', 'src')).toBe(true);
    expect(within('src/a.ts', 'src')).toBe(true);
    expect(within('src2/a.ts', 'src')).toBe(false);
    expect(within('sr', 'src')).toBe(false);
    expect(within('anything/at/all', '.')).toBe(true);
    expect(within('src', 'src/a.ts')).toBe(false);
  });
});

describe('a file, against a rule with targets', () => {
  it('is governed under a target and not under a directory that merely shares its prefix', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" -->');
    expect(governed(absence, [file('src/a.ts'), file('src/deep/b.ts'), file('src2/a.ts'), file('lib/src/a.ts'), file('a.ts')])).toEqual([
      'src/a.ts',
      'src/deep/b.ts',
    ]);
  });

  it('is governed by any of several targets, not only the first', () => {
    const absence = rule('<!-- @assert-absence target="lib, src" symbol="X" -->');
    expect(governed(absence, [file('lib/a.ts'), file('src/a.ts'), file('test/a.ts')])).toEqual(['lib/a.ts', 'src/a.ts']);
  });

  it('is governed everywhere by a rule with no target, which searches the root', () => {
    const absence = rule('<!-- @assert-absence symbol="X" -->');
    expect(governed(absence, [file('a.ts'), file('deep/down/b.py')])).toEqual(['a.ts', 'deep/down/b.py']);
  });

  it('is governed by a target that is the file itself and by nothing next to it', () => {
    const absence = rule('<!-- @assert-absence target="src/a.ts" symbol="X" -->');
    expect(governed(absence, [file('src/a.ts'), file('src/a.tsx'), file('src/b.ts')])).toEqual(['src/a.ts']);
  });

  it('is left out by an exclude that names one of its segments, and only a whole segment', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" exclude="tests" -->');
    expect(governed(absence, [file('src/tests/a.ts'), file('src/testsuite/a.ts'), file('src/a.tests.ts')])).toEqual([
      'src/testsuite/a.ts',
      'src/a.tests.ts',
    ]);
  });

  it('is left out by an anchored exclude only from the root, and by an exclude glob', () => {
    const anchored = rule('<!-- @assert-absence symbol="X" exclude="src/legacy" -->');
    expect(governed(anchored, [file('src/legacy/a.ts'), file('lib/src/legacy/a.ts')])).toEqual(['lib/src/legacy/a.ts']);
    const glob = rule('<!-- @assert-absence target="src" symbol="X" exclude="**/*.test.ts" -->');
    expect(governed(glob, [file('src/a.test.ts'), file('src/deep/b.test.ts'), file('src/a.ts')])).toEqual(['src/a.ts']);
  });

  it('must match glob, by basename without a slash and by path with one', () => {
    const basename = rule('<!-- @assert-absence target="src" symbol="X" glob="*.ts" -->');
    expect(governed(basename, [file('src/deep/a.ts'), file('src/a.js')])).toEqual(['src/deep/a.ts']);
    const anchored = rule('<!-- @assert-absence symbol="X" glob="src/*.ts" -->');
    expect(governed(anchored, [file('src/a.ts'), file('src/deep/a.ts'), file('lib/a.ts')])).toEqual(['src/a.ts']);
  });

  it('is not governed inside a directory the walk skips, below the target only', () => {
    const fromSrc = rule('<!-- @assert-absence target="src" symbol="X" -->');
    expect(governed(fromSrc, [file('src/node_modules/x.js'), file('src/deep/.git/config'), file('src/ok.js')])).toEqual(['src/ok.js']);

    // The walk never checks the name of the directory it starts in.
    const inside = rule('<!-- @assert-absence target="node_modules/pkg" symbol="X" -->');
    expect(governed(inside, [file('node_modules/pkg/a.js'), file('node_modules/pkg/node_modules/b.js')])).toEqual(['node_modules/pkg/a.js']);

    const root = rule('<!-- @assert-absence symbol="X" -->');
    expect(governed(root, [file('node_modules/a.js'), file('.hg/store'), file('.svn/x'), file('src/a.js')])).toEqual(['src/a.js']);
  });

  it('is governed inside a skipped directory under --no-default-skips', () => {
    const everything = rule('<!-- @assert-absence target="src" symbol="X" -->', { scanEverything: true });
    expect(governed(everything, [file('src/node_modules/x.js')])).toEqual(['src/node_modules/x.js']);
  });

  it('is governed when only its own name is one the walk skips as a directory', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" -->');
    expect(governed(absence, [file('src/node_modules')])).toEqual(['src/node_modules']);
  });

  it('is not governed when it is the spec file itself, unless specs are included', () => {
    const markdown = '<!-- @assert-absence symbol="X" -->';
    expect(governed(rule(markdown), [file('docs/a.md'), file('docs/b.md')])).toEqual(['docs/b.md']);
    expect(governed(rule(markdown, { includeSpecs: true }), [file('docs/a.md')])).toEqual(['docs/a.md']);
  });

  it('is governed by an import rule only in a language whose imports are read', () => {
    const imports = rule('<!-- @assert-import-absence target="src" module="db" -->');
    expect(
      governed(imports, [file('src/a.ts'), file('src/a.py'), file('src/a.go'), file('src/a.rs'), file('src/a.cs'), file('src/a.css'), file('src/a.md')]),
    ).toEqual(['src/a.ts', 'src/a.py', 'src/a.go', 'src/a.rs', 'src/a.cs']);

    const count = rule('<!-- @assert-import-count target="src" module="db" max="1" -->');
    expect(governed(count, [file('src/a.mjs'), file('src/a.json')])).toEqual(['src/a.mjs']);

    const layers = rule('<!-- @assert-layers target="src" order="src/a, src/b" -->');
    expect(governed(layers, [file('src/a/x.py'), file('src/a/x.yaml')])).toEqual(['src/a/x.py']);
  });

  it('is governed by a cycle rule only when it is JavaScript or TypeScript', () => {
    const cycles = rule('<!-- @assert-import-cycle target="src" -->');
    expect(governed(cycles, [file('src/a.ts'), file('src/a.cjs'), file('src/a.py'), file('src/a.go')])).toEqual(['src/a.ts', 'src/a.cjs']);
  });

  it('is governed by a text rule in any language at all', () => {
    const count = rule('<!-- @assert-count target="." symbol="X" min="1" -->');
    expect(governed(count, [file('a.yaml'), file('b.css'), file('Makefile')])).toEqual(['a.yaml', 'b.css', 'Makefile']);
  });
});

describe('a directory, against a rule with targets', () => {
  it('is governed when it lies inside a target, and not beside one', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" -->');
    expect(governed(absence, [dir('src'), dir('src/domain'), dir('sr'), dir('src2'), dir('lib')])).toEqual(['src/', 'src/domain/']);
  });

  it('is governed when a target lies inside it, including the root', () => {
    const absence = rule('<!-- @assert-absence target="src/domain/user.ts" symbol="X" -->');
    expect(governed(absence, [dir('.'), dir('src'), dir('src/domain'), dir('src/dom'), dir('lib')])).toEqual(['./', 'src/', 'src/domain/']);
  });

  it('is not governed when it is excluded, which excludes everything under it', () => {
    const anchored = rule('<!-- @assert-absence target="src" symbol="X" exclude="src/legacy" -->');
    expect(governed(anchored, [dir('src/legacy'), dir('src/legacy/deep'), dir('src/legacyish')])).toEqual(['src/legacyish/']);
    const bare = rule('<!-- @assert-absence target="src" symbol="X" exclude="generated" -->');
    expect(governed(bare, [dir('src/generated'), dir('src/a/generated/b'), dir('src/a')])).toEqual(['src/a/']);
  });

  it('is governed despite an exclude that only some files under it match', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" exclude="**/*.test.ts" -->');
    expect(governed(absence, [dir('src/domain')])).toEqual(['src/domain/']);
  });

  it('is not governed through a target that is itself excluded', () => {
    const absence = rule('<!-- @assert-absence target="src/gen, lib" symbol="X" exclude="gen" -->');
    expect(governed(absence, [dir('src'), dir('.')])).toEqual(['./']);
    const only = rule('<!-- @assert-absence target="src/gen" symbol="X" exclude="gen" -->');
    expect(governed(only, [dir('src'), dir('.')])).toEqual([]);
  });

  it('is not governed inside a skipped directory below the target', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="X" -->');
    expect(governed(absence, [dir('src/node_modules'), dir('src/node_modules/pkg'), dir('src/modules')])).toEqual(['src/modules/']);
    const everything = rule('<!-- @assert-absence target="src" symbol="X" -->', { scanEverything: true });
    expect(governed(everything, [dir('src/node_modules')])).toEqual(['src/node_modules/']);
  });

  it('is governed whatever glob or language filter might leave nothing in it', () => {
    const python = rule('<!-- @assert-absence target="src" symbol="X" glob="*.py" -->');
    const cycles = rule('<!-- @assert-import-cycle target="src" -->');
    expect(governed(python, [dir('src/web')])).toEqual(['src/web/']);
    expect(governed(cycles, [dir('src/styles')])).toEqual(['src/styles/']);
  });
});

describe('@assert-present', () => {
  const present = (): Assertion => rule('<!-- @assert-present file="SECURITY.md, docs/guide/intro.md" -->');

  it('governs exactly the files it names', () => {
    expect(governed(present(), [file('SECURITY.md'), file('docs/guide/intro.md'), file('SECURITY.txt'), file('docs/guide')])).toEqual([
      'SECURITY.md',
      'docs/guide/intro.md',
    ]);
  });

  it('governs a directory holding a file it names', () => {
    expect(governed(present(), [dir('.'), dir('docs'), dir('docs/guide'), dir('docs/other'), dir('doc')])).toEqual(['./', 'docs/', 'docs/guide/']);
  });
});

describe('layerPosition', () => {
  const order = ['src/domain', 'src/application', 'src/infrastructure'];

  it('places a path in its layer, with everything before it allowed and everything after forbidden', () => {
    expect(layerPosition(order, 'src/application/orders.ts')).toEqual({
      layer: 'src/application',
      position: 2,
      matches: ['src/application'],
      mayImport: ['src/domain', 'src/application'],
      mustNotImport: ['src/infrastructure'],
    });
  });

  it('allows only its own layer at the bottom and forbids nothing at the top', () => {
    expect(layerPosition(order, 'src/domain/user.ts')).toMatchObject({ position: 1, mayImport: ['src/domain'], mustNotImport: ['src/application', 'src/infrastructure'] });
    expect(layerPosition(order, 'src/infrastructure/db.ts')).toMatchObject({ position: 3, mayImport: order, mustNotImport: [] });
  });

  it('places a path no layer matches nowhere, and says nothing about its imports', () => {
    expect(layerPosition(order, 'src/shared/util.ts')).toEqual({ layer: null, position: null, matches: [], mayImport: [], mustNotImport: [] });
  });

  it('refuses to choose between two layers that both match', () => {
    expect(layerPosition(['src', 'src/web'], 'src/web/page.ts')).toEqual({
      layer: null,
      position: null,
      matches: ['src', 'src/web'],
      mayImport: [],
      mustNotImport: [],
    });
  });

  it('matches a bare layer name in any segment, as exclude does', () => {
    expect(layerPosition(['domain', 'web'], 'packages/shop/domain/cart.ts')).toMatchObject({ layer: 'domain', position: 1 });
  });
});

describe('viewRule', () => {
  const accepted: DocumentView = { file: 'docs/a.md', title: 'ADR-1', status: 'accepted', label: 'Accepted', inForce: true };
  const proposed: DocumentView = { ...accepted, status: 'proposed', label: 'Proposed', inForce: false };

  it('shows a text rule with every search option it resolved to', () => {
    const absence = rule('<!-- @assert-absence target="src" symbol="Legacy" regex word ignore-case comments="include" glob="*.ts" exclude="src/old" reason="gone" -->');
    expect(viewRule(absence, accepted)).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-absence',
      description: absence.description,
      reason: 'gone',
      inForce: true,
      bounds: { max: 0 },
      targets: ['src'],
      exclude: ['src/old'],
      glob: ['*.ts'],
      symbol: 'Legacy',
      regex: true,
      word: true,
      ignoreCase: true,
      comments: 'include',
      baseline: [],
    });
  });

  it('shows the defaults a text rule resolved to rather than leaving them out', () => {
    const count = rule('<!-- @assert-count symbol="Session" expected="1" -->');
    expect(viewRule(count, proposed)).toMatchObject({
      reason: null,
      inForce: false,
      bounds: { min: 1, max: 1 },
      targets: ['.'],
      exclude: [],
      glob: [],
      regex: false,
      word: false,
      ignoreCase: false,
      comments: 'ignore',
    });
  });

  it('shows @assert-present as the files it names and nothing else', () => {
    const present = rule('<!-- @assert-present file="LICENSE" -->');
    expect(viewRule(present, accepted, file('LICENSE'))).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-present',
      description: 'LICENSE must exist',
      reason: null,
      inForce: true,
      bounds: { min: 1, max: 1 },
      files: ['LICENSE'],
    });
  });

  it('shows an import rule with its modules and how it treats type-only imports', () => {
    const imports = rule('<!-- @assert-import-absence target="src/domain" module="src/infra/**, pg" types="ignore" -->');
    expect(viewRule(imports, accepted)).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-import-absence',
      description: imports.description,
      reason: null,
      inForce: true,
      bounds: { max: 0 },
      targets: ['src/domain'],
      exclude: [],
      modules: ['src/infra/**', 'pg'],
      types: 'ignore',
      baseline: [],
    });
    const count = rule('<!-- @assert-import-count target="src" module="db" min="1" -->');
    expect(viewRule(count, accepted)).toMatchObject({ kind: 'assert-import-count', modules: ['db'], types: 'include', bounds: { min: 1 } });
  });

  it('shows a cycle rule with no subject and no baseline', () => {
    const cycles = rule('<!-- @assert-import-cycle target="src" max="2" -->');
    expect(viewRule(cycles, accepted, file('src/a.ts'))).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-import-cycle',
      description: cycles.description,
      reason: null,
      inForce: true,
      bounds: { max: 2 },
      targets: ['src'],
      exclude: [],
      types: 'include',
      dynamic: 'include',
    });
    const lazy = rule('<!-- @assert-import-cycle target="src" dynamic="ignore" -->');
    expect(viewRule(lazy, accepted)).toMatchObject({ dynamic: 'ignore', types: 'include' });
  });

  it('shows a layer rule with its order, and with the position of a path when asked about one', () => {
    const layers = rule('<!-- @assert-layers target="src" order="src/domain, src/web" types="ignore" -->');
    const general = viewRule(layers, accepted);
    expect(general).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-layers',
      description: layers.description,
      reason: null,
      inForce: true,
      bounds: { max: 0 },
      targets: ['src'],
      exclude: [],
      order: ['src/domain', 'src/web'],
      types: 'ignore',
      baseline: [],
    });
    expect(viewRule(layers, accepted, file('src/web/page.ts'))).toEqual({
      ...general,
      position: { layer: 'src/web', position: 2, matches: ['src/web'], mayImport: ['src/domain', 'src/web'], mustNotImport: [] },
    });
  });

  it('shows the whole baseline in general, and only the entries at or under a queried path', () => {
    const markdown = [
      '<!-- @assert-absence target="src" symbol="X" baseline="src/a.ts:2 src/deep/b.ts src/deeper/c.ts" -->',
      '<!-- @assert-layers target="src" order="src/deep, src/web" baseline="src/deep/x.ts, src/web/y.ts" -->',
      '<!-- @assert-import-absence target="src" module="db" baseline="src/a.ts" -->',
    ].join('\n');
    const [absence, layers, imports] = rules(markdown) as [Assertion, Assertion, Assertion];

    expect(viewRule(absence, accepted).baseline).toEqual([
      { path: 'src/a.ts', declared: 2 },
      { path: 'src/deep/b.ts', declared: 1 },
      { path: 'src/deeper/c.ts', declared: 1 },
    ]);
    expect(viewRule(absence, accepted, file('src/a.ts')).baseline).toEqual([{ path: 'src/a.ts', declared: 2 }]);
    expect(viewRule(absence, accepted, dir('src/deep')).baseline).toEqual([{ path: 'src/deep/b.ts', declared: 1 }]);
    expect(viewRule(absence, accepted, file('src/z.ts')).baseline).toEqual([]);
    expect(viewRule(layers, accepted, dir('src/web')).baseline).toEqual([{ path: 'src/web/y.ts', declared: 1 }]);
    expect(viewRule(imports, accepted, file('src/b.ts')).baseline).toEqual([]);
    expect(viewRule(imports, accepted, file('src/a.ts')).baseline).toEqual([{ path: 'src/a.ts', declared: 1 }]);
  });
});

describe('@assert-structure', () => {
  const accepted: DocumentView = { file: 'docs/a.md', title: 'ADR-13', status: 'accepted', label: 'Accepted', inForce: true };

  it('governs the files a naming or partner rule walks - the spec files included', () => {
    const naming = rule('<!-- @assert-structure target="docs" glob="*.md" exclude="drafts" pattern="[0-9]*.md" -->');
    expect(governed(naming, [file('docs/a.md'), file('docs/0001-x.md'), file('docs/x.txt'), file('docs/drafts/b.md'), file('src/c.md')])).toEqual([
      'docs/a.md',
      'docs/0001-x.md',
    ]);
    // The control: a text rule over the same files leaves the spec out.
    expect(governed(rule('<!-- @assert-absence target="docs" glob="*.md" symbol="X" -->'), [file('docs/a.md'), file('docs/b.md')])).toEqual(['docs/b.md']);
    const partner = rule('<!-- @assert-structure target="src" exclude="*.test.ts" partner="[name].test.ts" -->');
    expect(governed(partner, [file('src/a.ts'), file('src/a.test.ts'), file('src/node_modules/x/i.ts'), dir('src/deep'), dir('lib')])).toEqual([
      'src/a.ts',
      'src/deep/',
    ]);
  });

  it('governs a file whose directory a required rule holds, and not one nested deeper', () => {
    const packages = rule('<!-- @assert-structure target="packages" dirs="*" exclude="shared" required="package.json" -->');
    expect(
      governed(packages, [
        file('packages/api/index.ts'),
        file('packages/api/package.json'),
        file('packages/api/src/main.ts'),
        file('packages/README.md'),
        file('packages/shared/x.ts'),
        file('packages/node_modules/index.js'),
        file('other/api/index.ts'),
      ]),
    ).toEqual(['packages/api/index.ts', 'packages/api/package.json']);
    const everything = rule('<!-- @assert-structure target="packages" dirs="*" required="package.json" -->', { scanEverything: true });
    expect(governed(everything, [file('packages/node_modules/index.js')])).toEqual(['packages/node_modules/index.js']);
    const deep = rule('<!-- @assert-structure target="svc" dirs="**/api" required="openapi.yaml" -->');
    expect(governed(deep, [file('svc/a/api/x.ts'), file('svc/api/x.ts'), file('svc/a/x.ts'), file('api/x.ts')])).toEqual(['svc/a/api/x.ts', 'svc/api/x.ts']);
  });

  it('without dirs, governs the files directly in a target and every directory on the way to one', () => {
    const root = rule('<!-- @assert-structure target="., pkg" required="LICENSE" -->');
    expect(governed(root, [file('README.md'), file('pkg/index.ts'), file('src/a.ts'), file('pkg/src/a.ts')])).toEqual(['README.md', 'pkg/index.ts']);
    const nested = rule('<!-- @assert-structure target="apps/web" required="package.json" -->');
    expect(governed(nested, [dir('.'), dir('apps'), dir('apps/web'), dir('apps/web/src'), dir('apps/api'), dir('lib')])).toEqual(['./', 'apps/', 'apps/web/']);
    const excluded = rule('<!-- @assert-structure target="apps/web" exclude="web" required="package.json" -->');
    expect(governed(excluded, [dir('apps'), dir('apps/web'), file('apps/web/a.ts')])).toEqual([]);
  });

  it('with dirs, governs any directory under which one could be selected', () => {
    const packages = rule('<!-- @assert-structure target="packages" dirs="*" exclude="shared" required="package.json" -->');
    expect(
      governed(packages, [dir('.'), dir('packages'), dir('packages/api'), dir('packages/shared'), dir('packages/node_modules'), dir('lib')]),
    ).toEqual(['./', 'packages/', 'packages/api/']);
  });

  it('shows a naming rule with its patterns, and whether a queried file is named as it must be', () => {
    const naming = rule('<!-- @assert-structure target="src/domain" glob="*.ts" pattern="*.entity.ts, index.ts" -->');
    const general = viewRule(naming, accepted);
    expect(general).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-structure',
      description: naming.description,
      reason: null,
      inForce: true,
      bounds: { max: 0 },
      targets: ['src/domain'],
      exclude: [],
      glob: ['*.ts'],
      claim: 'pattern',
      pattern: ['*.entity.ts', 'index.ts'],
      baseline: [],
    });
    expect(viewRule(naming, accepted, file('src/domain/user.entity.ts'))).toEqual({ ...general, named: true });
    expect(viewRule(naming, accepted, file('src/domain/user.ts'))).toEqual({ ...general, named: false });
    expect(viewRule(naming, accepted, dir('src/domain'))).toEqual(general);
  });

  it('shows a partner rule with its templates, and the partners a queried file needs', () => {
    const partner = rule('<!-- @assert-structure target="src/api, ., node_modules/pkg" partner="[name].test.[ext], tests/[dir]/[name].test.[ext]" -->');
    const general = viewRule(partner, accepted);
    expect(general).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-structure',
      description: partner.description,
      reason: null,
      inForce: true,
      bounds: { max: 0 },
      targets: ['src/api', '.', 'node_modules/pkg'],
      exclude: [],
      glob: [],
      claim: 'partner',
      partner: ['[name].test.[ext]', 'tests/[dir]/[name].test.[ext]'],
      baseline: [],
    });
    // Measured from the first target that reaches the file, as a run measures it.
    expect(viewRule(partner, accepted, file('src/api/v1/user.ts')).partners).toEqual(['src/api/v1/user.test.ts', 'tests/v1/user.test.ts']);
    expect(viewRule(partner, accepted, file('src/web/page.tsx')).partners).toEqual(['src/web/page.test.tsx', 'tests/src/web/page.test.tsx']);
    expect(viewRule(partner, accepted, file('node_modules/pkg/x/i.js')).partners).toEqual(['node_modules/pkg/x/i.test.js', 'tests/x/i.test.js']);
    expect(viewRule(partner, accepted, dir('src'))).toEqual(general);
    // A file called .git - which a worktree has - is a file, and only a directory of that name is skipped.
    expect(viewRule(partner, accepted, file('.git')).partners).toEqual(['.git.test.', 'tests/.git.test.']);
    const outside = rule('<!-- @assert-structure target="src" partner="[name].x" -->');
    expect(viewRule(outside, accepted, file('lib/a.ts'))).not.toHaveProperty('partners');
    expect(viewRule(outside, accepted, file('src/node_modules/a.ts'))).not.toHaveProperty('partners');
  });

  it('shows a required rule with its entries and the directories it chooses', () => {
    const packages = rule('<!-- @assert-structure target="packages" dirs="*" required="package.json, README.md" baseline="packages/old" -->');
    expect(viewRule(packages, accepted, file('packages/api/index.ts'))).toEqual({
      document: 'docs/a.md',
      line: 1,
      kind: 'assert-structure',
      description: packages.description,
      reason: null,
      inForce: true,
      bounds: { max: 0 },
      targets: ['packages'],
      exclude: [],
      claim: 'required',
      required: ['package.json', 'README.md'],
      dirs: '*',
      baseline: [],
    });
    expect(viewRule(packages, accepted).baseline).toEqual([{ path: 'packages/old', declared: 1 }]);
    expect(viewRule(rule('<!-- @assert-structure required="LICENSE" -->'), accepted)).toMatchObject({ dirs: null, targets: ['.'] });
  });
});
