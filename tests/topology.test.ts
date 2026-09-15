/**
 * `@assert-import-cycle` and `@assert-layers`, end to end through the runner.
 *
 * Every rule that passes here passes beside a control that fails, and every
 * failure is shown to name the thing to fix. The two directives are about
 * structure, and structure is where a check can pass for the wrong reason
 * without anything in its output looking different: a graph with its edges
 * missing has no cycles, and a layer nothing matches is never violated.
 *
 * See ADR-0011.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILED, EXIT_OK, main, type CliIO } from '../src/cli.js';
import { formatReport, formatSarif } from '../src/reporter.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const run = (root: string, options = {}) =>
  runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript', ...options });

async function only(files: Record<string, string>, options = {}) {
  const report = await run(await repo(files), options);
  expect(report.errors).toEqual([]);
  expect(report.results).toHaveLength(1);
  return report.results[0] as (typeof report.results)[number];
}

const CYCLE = {
  'src/a.ts': "import { b } from './b.js';\nexport const a = 1;\n",
  'src/b.ts': "\nimport { a } from './a.js';\nexport const b = 2;\n",
};

/* ------------------------------------------------------------------- cycles */

describe('@assert-import-cycle', () => {
  it('fails on a cycle and shows every import on the loop, and passes once it is broken', async () => {
    const broken = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n', ...CYCLE });

    expect(broken.ok).toBe(false);
    expect(broken.actual).toBe(1);
    expect(broken.description).toBe('src must have no import cycles');
    expect(broken.message).toBe('expected no import cycles, found 1');
    expect(broken.matches).toEqual([
      { file: 'src/a.ts', line: 1, column: 1, text: 'src/a.ts:1 -> src/b.ts:2 -> src/a.ts', count: 1 },
    ]);

    const fixed = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': CYCLE['src/a.ts'],
      'src/b.ts': 'export const b = 2;\n',
    });
    expect(fixed.ok).toBe(true);
    expect(fixed.actual).toBe(0);
  });

  it('counts components, so a second route around the same knot is still one cycle', async () => {
    const result = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="src" max="1" -->\n',
      'src/a.ts': "import './b.js';\nimport './c.js';\n",
      'src/b.ts': "import './c.js';\n",
      'src/c.ts': "import './a.js';\n",
    });

    expect(result.actual).toBe(1);
    expect(result.ok).toBe(true);
    // The shortest loop through the first file, not the first one found.
    expect(result.matches[0]?.text).toBe('src/a.ts:2 -> src/c.ts:1 -> src/a.ts');
  });

  it('holds a budget, and fails the day it is exceeded', async () => {
    const two = {
      ...CYCLE,
      'src/c.ts': "import './d.js';\n",
      'src/d.ts': "import './c.js';\n",
    };

    expect((await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" max="2" -->\n', ...two })).ok).toBe(true);
    const over = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" max="1" -->\n', ...two });
    expect(over.ok).toBe(false);
    expect(over.message).toBe('expected at most 1 import cycle, found 2');
    expect(over.description).toBe('src must have at most 1 import cycle');
  });

  it('sees a file that imports itself', async () => {
    const result = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': "export const a = 1;\nimport './a.js';\n",
    });

    expect(result.matches[0]?.text).toBe('src/a.ts:2 -> src/a.ts');
  });

  it('separates the runtime question from the coupling one with types="ignore"', async () => {
    const typeOnly = {
      'src/a.ts': "import type { B } from './b.js';\nexport type A = 1;\n",
      'src/b.ts': "import { a } from './a.js';\nexport type B = 2;\n",
    };

    const runtime = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" types="ignore" -->\n', ...typeOnly });
    expect(runtime.ok).toBe(true);
    expect(runtime.description).toBe('src must have no import cycles (type-only imports ignored)');

    const coupling = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n', ...typeOnly });
    expect(coupling.ok).toBe(false);
  });

  // From a real monorepo: a plugin loaded with import() closes a loop that no
  // module's load order can deadlock on.
  it('separates a lazy loop from a load-order one with dynamic="ignore"', async () => {
    const lazy = {
      'src/configuration.ts': "import { tier } from './lazy-tier.js';\nexport const configuration = tier;\n",
      'src/lazy-tier.ts': "export const tier = () => import('./tier-boot.js');\n",
      'src/tier-boot.ts': "import { configuration } from './configuration.js';\nexport const boot = configuration;\n",
    };

    const runtime = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" dynamic="ignore" -->\n', ...lazy });
    expect(runtime.ok).toBe(true);
    expect(runtime.description).toBe('src must have no import cycles (dynamic imports ignored)');

    const coupling = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n', ...lazy });
    expect(coupling.ok).toBe(false);
    expect(coupling.matches[0]?.text).toBe(
      'src/configuration.ts:1 -> src/lazy-tier.ts:1 -> src/tier-boot.ts:1 -> src/configuration.ts',
    );

    // A static import between the same two files keeps the loop, dynamic or not.
    const eager = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="src" dynamic="ignore" -->\n',
      ...lazy,
      'src/lazy-tier.ts': "import './tier-boot.js';\nexport const tier = () => import('./tier-boot.js');\n",
    });
    expect(eager.ok).toBe(false);
  });

  it('takes dynamic="..." on a cycle rule only', async () => {
    const report = await run(
      await repo({ 'docs/a.md': '<!-- @assert-layers target="src" order="a, b" dynamic="ignore" -->\n', ...CYCLE }),
    );
    expect(report.errors[0]?.message).toContain('Unknown attribute "dynamic"');
  });

  it('does not follow an import out of scope, and an exclude breaks a cycle through what it excludes', async () => {
    const outside = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src/a.ts" -->\n', ...CYCLE });
    expect(outside.ok).toBe(true);
    expect(outside.warnings).toEqual([]);

    const excluded = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" exclude="src/b.ts" -->\n', ...CYCLE });
    expect(excluded.ok).toBe(true);
    expect(excluded.description).toBe('src must have no import cycles (excluding src/b.ts)');
    // And silently: the import of an excluded file is the author's choice, not
    // an edge the graph failed to follow, so it must not fail --strict.
    expect(excluded.warnings).toEqual([]);
    expect((await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" exclude="src/b.ts" -->\n', ...CYCLE }, { strictTargets: true })).ok).toBe(true);
  });

  it('treats an import above the root as outside, not as missing', async () => {
    // With no target the scope is the whole root, and a path that climbs out of
    // it starts with "..", which is not under "." however the prefix is tested.
    const result = await only({
      'docs/a.md': '<!-- @assert-import-cycle -->\n',
      'a.ts': "import '../sibling-repo/shared.js';\n",
    });

    expect(result.warnings).toEqual([]);
  });

  it('reports an import it could not resolve, and fails on it under --strict', async () => {
    const files = {
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': "import './missing.js';\nimport '@/aliased';\nimport 'react';\n",
    };

    const lenient = await only(files);
    expect(lenient.ok).toBe(true);
    expect(lenient.warnings).toEqual([
      '2 imports could not be resolved to a file, so their edges are missing from the graph',
      '  src/a.ts:1 ./missing.js',
      '  src/a.ts:2 @/aliased',
    ]);

    const strict = await only(files, { strictTargets: true });
    expect(strict.ok).toBe(false);
    expect(strict.message).toBe('expected no import cycles, found 0; 2 references could not be resolved');
  });

  it('counts a dynamic import it could not read toward --strict too', async () => {
    const files = {
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': 'export const load = (name: string) => import(name);\n',
    };

    expect((await only(files)).ok).toBe(true);
    expect((await only(files, { strictTargets: true })).ok).toBe(false);
  });

  it('fails over a scope with no JavaScript or TypeScript in it, rather than finding no cycles', async () => {
    const python = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="app" -->\n',
      'app/a.py': 'from app import b\n',
      'app/b.py': 'from app import a\n',
    });

    expect(python.ok).toBe(false);
    expect(python.message).toBe(
      'none of the 2 files here are JavaScript or TypeScript, so there is no import graph to check and this assertion verified nothing (add allow-empty="true" if that is expected)',
    );

    const allowed = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="app" allow-empty="true" -->\n',
      'app/a.py': 'from app import b\n',
    });
    expect(allowed.ok).toBe(true);
  });

  it('says how much of a mixed scope made it into the graph', async () => {
    const result = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n', ...CYCLE, 'src/tool.py': 'import os\n' });
    expect(result.warnings).toContain('placed 2 of 3 files in the import graph; 1 is not JavaScript or TypeScript');

    const two = await only({
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      ...CYCLE,
      'src/tool.py': 'import os\n',
      'src/main.go': 'package main\n',
    });
    expect(two.warnings).toContain('placed 2 of 4 files in the import graph; 2 are not JavaScript or TypeScript');
  });

  it('says one unresolved import in the singular', async () => {
    const result = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n', 'src/a.ts': "import './gone.js';\n" });

    expect(result.warnings[0]).toBe('1 import could not be resolved to a file, so its edge is missing from the graph');
  });

  it('fails on a missing target, whatever the graph it could build says', async () => {
    const result = await only({ 'docs/a.md': '<!-- @assert-import-cycle target="src, gone" -->\n', 'src/a.ts': 'export {};\n' });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('target path does not exist: gone');
  });

  it('refuses a baseline, because a cycle is not a file', async () => {
    const report = await run(
      await repo({ 'docs/a.md': '<!-- @assert-import-cycle target="src" baseline="src/a.ts" -->\n', ...CYCLE }),
    );

    expect(report.errors[0]?.message).toContain('Unknown attribute "baseline" on @assert-import-cycle');
  });
});

/* ------------------------------------------------------------------- layers */

const LAYERED = {
  'src/domain/user.ts': 'export interface User { id: string }\n',
  'src/application/signup.ts': "import type { User } from '../domain/user.js';\nexport const signup = 1;\n",
  'src/infrastructure/db.ts': "import { signup } from '../application/signup.js';\nexport const db = 1;\n",
};

const ORDER = 'order="src/domain, src/application, src/infrastructure"';

describe('@assert-layers', () => {
  it('passes an order the code keeps, and fails the same order reversed', async () => {
    // The pairing that matters most. A layer check that matched no reference
    // would pass both.
    const kept = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...LAYERED });
    expect(kept.ok).toBe(true);
    expect(kept.description).toBe('src must keep its layers in order, src/domain < src/application < src/infrastructure');

    const reversed = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="src/infrastructure, src/application, src/domain" -->\n',
      ...LAYERED,
    });
    expect(reversed.ok).toBe(false);
    expect(reversed.actual).toBe(2);
    expect(reversed.message).toBe('expected no violating files, found 2');
  });

  it('names the file, the two layers and the import', async () => {
    const result = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`,
      ...LAYERED,
      'src/domain/user.ts': "\n\nimport { db } from '../infrastructure/db.js';\n",
    });

    expect(result.matches).toEqual([
      {
        file: 'src/domain/user.ts',
        line: 3,
        column: 1,
        text: 'src/domain -> src/infrastructure: import ../infrastructure/db.js',
        count: 1,
      },
    ]);
    expect(result.fileMatches).toEqual([{ file: 'src/domain/user.ts', count: 1 }]);
  });

  it('fails on a layer that matches nothing, which is usually a typo', async () => {
    const typo = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="src/domain, src/aplication, src/infrastructure" -->\n',
      ...LAYERED,
    });
    expect(typo.ok).toBe(false);
    expect(typo.message).toBe(
      'layer "src/aplication" matches no file in scope, so nothing is held to it (add allow-empty="true" if that is expected)',
    );

    const allowed = await only({
      'docs/a.md':
        '<!-- @assert-layers target="src" order="src/domain, src/aplication, src/infrastructure" allow-empty="true" -->\n',
      ...LAYERED,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings).toContain('layer "src/aplication" matches no file in scope');
  });

  it('names every layer that matches nothing, in the plural', async () => {
    const order = 'order="src/domain, src/aplication, src/infrastucture"';
    const failing = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${order} -->\n`, ...LAYERED });
    expect(failing.message).toBe(
      'layers "src/aplication" and "src/infrastucture" match no file in scope, so nothing is held to them (add allow-empty="true" if that is expected)',
    );

    const allowed = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${order} allow-empty="true" -->\n`, ...LAYERED });
    expect(allowed.warnings).toContain('layers "src/aplication" and "src/infrastucture" match no file in scope');
  });

  it('fails on a file two layers claim, naming both', async () => {
    const result = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="domain, src/domain/events, infrastructure" -->\n',
      'src/domain/events/created.ts': 'export {};\n',
      'src/infrastructure/db.ts': 'export {};\n',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'src/domain/events/created.ts is in both "domain" and "src/domain/events"; a file in two layers has no single rule to follow',
    );

    // And where imports do cross, so that nothing else is wrong with the rule:
    // the file two layers claim is the whole reason it fails.
    const crossed = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="domain, src/domain/events, infrastructure" -->\n',
      'src/domain/events/created.ts': 'export {};\n',
      'src/domain/user.ts': 'export {};\n',
      'src/infrastructure/db.ts': "import '../domain/user.js';\n",
    });
    expect(crossed.ok).toBe(false);
    expect(crossed.message).toContain('is in both "domain" and "src/domain/events"');
  });

  it('says how many files no layer constrains', async () => {
    const result = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`,
      ...LAYERED,
      'src/shared/log.ts': 'export {};\n',
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('1 of 4 files belongs to no layer, so nothing here constrains it');

    const two = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`,
      ...LAYERED,
      'src/shared/log.ts': 'export {};\n',
      'src/shared/clock.ts': 'export {};\n',
    });
    expect(two.warnings).toContain('2 of 5 files belong to no layer, so nothing here constrains them');
  });

  it('ignores type-only imports with types="ignore", and not otherwise', async () => {
    const files = {
      ...LAYERED,
      'src/domain/user.ts': "import type { Db } from '../infrastructure/db.js';\n",
    };

    expect((await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} types="ignore" -->\n`, ...files })).ok).toBe(true);
    expect((await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...files })).ok).toBe(false);
  });

  it('takes a baseline for the violations that already exist, and ratchets it', async () => {
    const files = { ...LAYERED, 'src/domain/user.ts': "import '../infrastructure/db.js';\n" };

    const exempt = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} baseline="src/domain/user.ts" -->\n`,
      ...files,
    });
    expect(exempt.ok).toBe(true);
    expect(exempt.baselinedMatches).toBe(1);

    const stale = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} baseline="src/domain/user.ts" -->\n`,
      ...LAYERED,
    });
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain('the baseline is out of date and must be pruned: src/domain/user.ts (no longer matches)');
  });

  it('holds Python to its layers by the dotted names Python writes', async () => {
    const files = {
      'app/domain/user.py': 'from app.infrastructure.db import session\n',
      'app/infrastructure/db.py': 'session = None\n',
    };

    expect((await only({ 'docs/a.md': '<!-- @assert-layers target="app" order="domain, infrastructure" -->\n', ...files })).ok).toBe(false);
    expect((await only({ 'docs/a.md': '<!-- @assert-layers target="app" order="infrastructure, domain" -->\n', ...files })).ok).toBe(true);
  });

  it('fails on unreadable references under --strict', async () => {
    const files = {
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`,
      ...LAYERED,
      'src/domain/user.ts': 'export const load = (name: string) => import(name);\n',
    };

    expect((await only(files)).ok).toBe(true);
    const strict = await only(files, { strictTargets: true });
    expect(strict.ok).toBe(false);
    expect(strict.message).toBe('expected no violating files, found 0; 1 reference could not be resolved');
  });

  it('describes a budget in violating files', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} max="2" -->\n`, ...LAYERED });

    expect(result.description).toBe(
      'src must keep its layers in order, src/domain < src/application < src/infrastructure, with at most 2 violating files',
    );
  });
});

/* ------------------------------------------------------- a rule that saw nothing */

const SOLUTION = {
  'src/Shop.Domain/Orders/Order.cs': 'namespace Shop.Domain.Orders;\n\npublic sealed class Order { }\n',
  'src/Shop.Application/Orders/PlaceOrder.cs':
    'using Shop.Domain.Orders;\n\nnamespace Shop.Application.Orders;\n\npublic sealed class PlaceOrder { }\n',
  'src/Shop.Infrastructure/Persistence/OrderStore.cs':
    'using Microsoft.EntityFrameworkCore;\nusing Shop.Application.Orders;\n\nnamespace Shop.Infrastructure.Persistence;\n\npublic sealed class OrderStore { }\n',
};

const BY_NAMESPACE = 'order="Shop.Domain, Shop.Application, Shop.Infrastructure"';
const BY_FOLDER = 'order="src/Shop.Domain, src/Shop.Application, src/Shop.Infrastructure"';

describe('@assert-layers over a C# solution', () => {
  it('holds each project to the order by the namespaces its usings name', async () => {
    const kept = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${BY_NAMESPACE} -->\n`, ...SOLUTION });
    expect(kept.ok).toBe(true);
    expect(kept.warnings).toEqual([]);

    // The report this came from: a domain file importing the application passed.
    const broken = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${BY_NAMESPACE} -->\n`,
      ...SOLUTION,
      'src/Shop.Domain/Orders/Order.cs':
        'using Shop.Application.Orders;\n\nnamespace Shop.Domain.Orders;\n\npublic sealed class Order { }\n',
    });
    expect(broken.ok).toBe(false);
    expect(broken.matches).toEqual([
      {
        file: 'src/Shop.Domain/Orders/Order.cs',
        line: 1,
        column: 1,
        text: 'Shop.Domain -> Shop.Application: using Shop.Application.Orders',
        count: 1,
      },
    ]);
  });

  it('fails on layers named by folder, which no using can reach, naming a namespace of each', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${BY_FOLDER} -->\n`, ...SOLUTION });

    expect(result.ok).toBe(false);
    expect(result.actual).toBe(0);
    expect(result.message).toBe(
      'no C# using can reach layers "src/Shop.Application" and "src/Shop.Infrastructure": they match none of the namespaces their files declare, such as Shop.Application.Orders and Shop.Infrastructure.Persistence, so a dependency on them is never seen (a layer reaches C# when it matches the namespace as well as the folder; add allow-empty="true" if that is expected)',
    );
    expect(result.warnings).toEqual([]);
  });

  it('says so of one layer in the singular, and as a warning when an empty rule is allowed', async () => {
    const files = { ...SOLUTION, 'docs/a.md': '<!-- @assert-layers target="src" order="src/Shop.Domain, src/Shop.Application" -->\n' };
    const one = 'no C# using can reach layer "src/Shop.Application": it matches none of the namespaces its files declare, such as Shop.Application.Orders, so a dependency on it is never seen';

    expect((await only(files)).message).toBe(
      `${one} (a layer reaches C# when it matches the namespace as well as the folder; add allow-empty="true" if that is expected)`,
    );

    const allowed = await only({ ...files, 'docs/a.md': files['docs/a.md'].replace(' -->', ' allow-empty="true" -->') });
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings).toEqual([
      '1 of 3 files belongs to no layer, so nothing here constrains it',
      one,
      "no import in scope reaches a layer other than its own file's, so these layers would pass in any order",
    ]);
  });

  it('fails when one layer is out of reach even though others are crossed into', async () => {
    // The mixed order: the application imports the domain, which reaches it, so
    // something crossed - and the domain importing the application would not.
    const result = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="Shop.Domain, src/Shop.Application, Shop.Infrastructure" -->\n',
      ...SOLUTION,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('no C# using can reach layer "src/Shop.Application"');
  });

  it('passes a layer named by a segment folder and namespace share', async () => {
    // A solution whose folders are not named for their namespaces.
    const result = await only({
      'docs/a.md': '<!-- @assert-layers target="src" order="Domain, Application" -->\n',
      'src/Domain/Entities/Order.cs': 'namespace Acme.Clean.Domain.Entities;\n',
      'src/Application/Orders/PlaceOrder.cs': 'using Acme.Clean.Domain.Entities;\nnamespace Acme.Clean.Application.Orders;\n',
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('@assert-layers where no import crosses a layer', () => {
  const UNCROSSED = {
    'src/domain/user.ts': 'export {};\n',
    'src/application/signup.ts': "import './local.js';\n",
    'src/application/local.ts': 'export {};\n',
    'src/infrastructure/db.ts': "import 'pg';\n",
  };
  const uncrossed = "no import in scope reaches a layer other than its own file's, so these layers would pass in any order";

  it('fails, since any order of the layers would have passed', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...UNCROSSED });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(`${uncrossed} (add allow-empty="true" if that is expected)`);
    expect(result.warnings).toEqual([]);
  });

  it('warns instead when an empty rule is allowed, by the directive or for the run', async () => {
    const allowed = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} allow-empty="true" -->\n`, ...UNCROSSED });
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings).toEqual([uncrossed]);

    const run = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...UNCROSSED }, { allowEmptyScope: true });
    expect(run.ok).toBe(true);
    expect(run.warnings).toEqual([uncrossed]);
  });
});

describe('what an @assert-layers directive must say before anything is read', () => {
  const error = async (directive: string): Promise<string | undefined> =>
    (await run(await repo({ 'docs/a.md': `${directive}\n`, ...LAYERED }))).errors[0]?.message;

  it('needs an order', async () => {
    expect(await error('<!-- @assert-layers target="src" -->')).toBe('@assert-layers requires a non-empty order="..." attribute.');
  });

  it('needs two layers to have an order at all', async () => {
    expect(await error('<!-- @assert-layers target="src" order="src/domain" -->')).toBe(
      '@assert-layers needs at least two layers in order="...", got 1.',
    );
  });

  it('refuses a layer listed twice', async () => {
    expect(await error('<!-- @assert-layers target="src" order="domain, infrastructure, domain" -->')).toBe(
      'Layer "domain" is listed twice in order="...".',
    );
  });
});

/* ----------------------------------------------- what the first sweep missed */

/**
 * Inputs the first CI mutation sweep of this feature showed nothing exercised.
 *
 * Each of these was a surviving mutant: a condition that could be deleted, or a
 * slice that could be dropped, with every test still passing. Most are the
 * boundaries of a cycle rule's scope, which is exactly where a check turns an
 * import it should report into one it silently ignores.
 */
describe('the edges of a cycle rule scope', () => {
  const unresolvedIn = async (files: Record<string, string>, directive: string, options = {}) =>
    (await only({ 'docs/a.md': `${directive}\n`, ...files }, options)).warnings;

  it('ignores an import of a file that exists and is not code', async () => {
    // The stylesheet is counted as outside the graph, which is true; what it
    // must not be is an import the graph failed to follow.
    expect(
      await unresolvedIn({ 'src/a.ts': "import './app.css';\n", 'src/app.css': 'body {}\n' }, '<!-- @assert-import-cycle target="src" -->'),
    ).toEqual(['placed 1 of 2 files in the import graph; 1 is not JavaScript or TypeScript']);
  });

  it('treats `..` from a root-level file as leaving the root', async () => {
    expect(await unresolvedIn({ 'a.ts': "import '..';\n" }, '<!-- @assert-import-cycle -->')).toEqual([]);
  });

  it('reports a missing import at the root when the rule has no target', async () => {
    expect(await unresolvedIn({ 'a.ts': "import './gone.js';\n" }, '<!-- @assert-import-cycle -->')).toContain(
      '  a.ts:1 ./gone.js',
    );
  });

  it('reports a missing import into the second of two targets', async () => {
    const warnings = await unresolvedIn(
      { 'src/a.ts': "import '../lib/gone.js';\n", 'lib/b.ts': 'export {};\n' },
      '<!-- @assert-import-cycle target="src, lib" -->',
    );
    expect(warnings).toContain('  src/a.ts:1 ../lib/gone.js');
  });

  it('reports an import of a target directory that has no index', async () => {
    const warnings = await unresolvedIn(
      { 'src/a.ts': "import './lib';\n", 'src/lib/b.ts': 'export {};\n' },
      '<!-- @assert-import-cycle target="src/a.ts, src/lib" -->',
    );
    expect(warnings).toContain('  src/a.ts:1 ./lib');
  });

  it('lists no more unresolved imports, and no more cycles, than --max-snippets allows', async () => {
    const files = {
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': "import './b.js';\nimport './gone1.js';\nimport './gone2.js';\n",
      'src/b.ts': "import './a.js';\n",
      'src/c.ts': "import './d.js';\n",
      'src/d.ts': "import './c.js';\n",
    };
    const result = await only(files, { maxSnippets: 1 });

    expect(result.warnings).toEqual([
      '2 imports could not be resolved to a file, so their edges are missing from the graph',
      '  src/a.ts:2 ./gone1.js',
    ]);
    expect(result.actual).toBe(2);
    expect(result.matches).toHaveLength(1);
  });
});

describe('the per-module import rules, through the reader they now share', () => {
  it('shows no more matches than --max-snippets allows', async () => {
    // A survivor older than ADR-0011, in code this change restructured: the
    // cap on an import assertion's snippets could be removed and nothing said.
    const result = await only(
      {
        'docs/a.md': '<!-- @assert-import-absence target="src" module="node:fs" -->\n',
        'src/a.ts': "import 'node:fs';\n",
        'src/b.ts': "import 'node:fs';\n",
      },
      { maxSnippets: 1 },
    );

    expect(result.actual).toBe(2);
    expect(result.matches).toHaveLength(1);
  });
});

describe('the edges of a layer rule', () => {
  it('says nothing at all about a rule every file obeys and every layer covers', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...LAYERED });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);

    // Including when empty layers would have been allowed: permission to have
    // one is not a reason to announce that there are none.
    const allowed = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} allow-empty="true" -->\n`, ...LAYERED });
    expect(allowed.warnings).toEqual([]);
  });

  it('fails on a missing target', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src, gone" ${ORDER} -->\n`, ...LAYERED });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('target path does not exist: gone');
  });

  it('passes under --strict when nothing went unresolved', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...LAYERED }, { strictTargets: true });

    expect(result.ok).toBe(true);
  });

  it('lets a one-way ratchet keep a stale baseline entry', async () => {
    const result = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} baseline="src/domain/user.ts" ratchet="one-way" -->\n`,
      ...LAYERED,
    });

    expect(result.ok).toBe(true);
    expect(result.staleBaseline).toEqual([{ path: 'src/domain/user.ts', declared: 1, found: 0 }]);
  });

  it('shows only the violations the baseline does not cover, and no more than --max-snippets', async () => {
    const files = {
      ...LAYERED,
      'src/domain/user.ts': "import '../infrastructure/db.js';\n",
      'src/domain/order.ts': "import '../infrastructure/db.js';\n",
      'src/domain/zone.ts': "import '../infrastructure/db.js';\n",
    };

    const baselined = await only({
      'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} baseline="src/domain/order.ts" max="5" -->\n`,
      ...files,
    });
    expect(baselined.matches.map((match) => match.file)).toEqual(['src/domain/user.ts', 'src/domain/zone.ts']);

    const capped = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} -->\n`, ...files }, { maxSnippets: 1 });
    expect(capped.matches).toHaveLength(1);
    expect(capped.actual).toBe(3);
  });

  it('names every ambiguous file, separated, and no more than --max-snippets of them', async () => {
    const files = {
      'docs/a.md': '<!-- @assert-layers target="src" order="domain, src/domain/events, infrastructure" -->\n',
      'src/domain/events/a.ts': 'export {};\n',
      'src/domain/events/b.ts': 'export {};\n',
      'src/infrastructure/db.ts': 'export {};\n',
    };

    expect((await only(files)).message).toBe(
      'src/domain/events/a.ts is in both "domain" and "src/domain/events"; src/domain/events/b.ts is in both "domain" and "src/domain/events"; a file in two layers has no single rule to follow',
    );
    expect((await only(files, { maxSnippets: 1 })).message).toBe(
      'src/domain/events/a.ts is in both "domain" and "src/domain/events"; a file in two layers has no single rule to follow',
    );
  });

  it('describes a budget of one in the singular', async () => {
    const result = await only({ 'docs/a.md': `<!-- @assert-layers target="src" ${ORDER} max="1" -->\n`, ...LAYERED });

    expect(result.description).toBe(
      'src must keep its layers in order, src/domain < src/application < src/infrastructure, with at most 1 violating file',
    );
  });
});

/* -------------------------------------------------------------- the report */

describe('how the two directives are reported', () => {
  it('shows a passing rule with its description and a count in its own unit', async () => {
    const root = await repo({
      'docs/a.md': `<!-- @assert-import-cycle target="src" -->\n<!-- @assert-layers target="src" ${ORDER} -->\n`,
      ...LAYERED,
    });

    const text = formatReport(await run(root), { color: false, verbose: true });

    expect(text).toContain('✔ docs/a.md:1  @assert-import-cycle src must have no import cycles (0 cycles)');
    expect(text).toContain(
      '✔ docs/a.md:2  @assert-layers src must keep its layers in order, src/domain < src/application < src/infrastructure (0 violating files)',
    );

    // And the count is dimmed like every other pass line's, which only a report
    // with colour on can show.
    const ESC = String.fromCharCode(27);
    const coloured = formatReport(await run(root), { color: true, verbose: true });
    expect(coloured).toContain(`src must have no import cycles ${ESC}[2m(0 cycles)${ESC}[0m`);
  });

  it('gives two cycle rules on one target two alert identities', async () => {
    // Neither names a symbol or a file, which is what the fingerprint used to
    // tell assertions apart by - so `types="ignore"` beside the default would
    // have been one alert in code scanning.
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n<!-- @assert-import-cycle target="src" types="ignore" -->\n',
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': "import './a.js';\n",
    });

    const results = JSON.parse(formatSarif(await run(root))).runs[0].results as Array<{
      partialFingerprints: { specGuardAssertion: string };
    }>;

    expect(results).toHaveLength(2);
    expect(results[0]?.partialFingerprints.specGuardAssertion).not.toBe(results[1]?.partialFingerprints.specGuardAssertion);
  });
});

describe('through the CLI', () => {
  function createIO(root: string): { io: CliIO; out: string[] } {
    const out: string[] = [];
    return { out, io: { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: root, isTTY: false } };
  }

  it('exits on the cycle, and passes once types are ignored', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-cycle target="src" -->\n',
      'src/a.ts': "import type { B } from './b.js';\n",
      'src/b.ts': "import './a.js';\n",
    });

    const failing = createIO(root);
    expect(await main(['docs/a.md', '--root', root, '--engine', 'js'], failing.io)).toBe(EXIT_FAILED);
    expect(failing.out.join('\n')).toContain('src/a.ts:1 -> src/b.ts:1 -> src/a.ts');

    const passing = await repo({
      'docs/a.md': '<!-- @assert-import-cycle target="src" types="ignore" -->\n',
      'src/a.ts': "import type { B } from './b.js';\n",
      'src/b.ts': "import './a.js';\n",
    });
    expect(await main(['docs/a.md', '--root', passing, '--engine', 'js'], createIO(passing).io)).toBe(EXIT_OK);
  });
});
