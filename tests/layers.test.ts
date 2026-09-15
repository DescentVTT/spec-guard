/**
 * The layering rule, as a pure function.
 *
 * Every "this is allowed" here has its "and this is not" beside it, because a
 * layering check that never matches a reference passes every order - including
 * the reversed one. That is not hypothetical: the first rule this project wrote
 * with file-sized layers did exactly that, and the regression test for it is the
 * one named after it below.
 */

import { describe, expect, it } from 'vitest';

import type { ModuleReference, ReferenceKind } from '../src/imports.js';
import { checkLayers, layerMatcher, referenceForms, type LayerInput } from '../src/layers.js';

function ref(specifier: string, line = 1, extra: { typeOnly?: boolean; kind?: ReferenceKind } = {}): ModuleReference {
  return { specifier, kind: extra.kind ?? 'import', typeOnly: extra.typeOnly ?? false, line, column: 1 };
}

const ORDER = ['src/domain', 'src/application', 'src/infrastructure'];

/* ------------------------------------------------------------------- naming */

describe('the names a reference is matched under', () => {
  it('includes the files a JavaScript or TypeScript module can be, without asking whether they exist', () => {
    const forms = referenceForms('./runner.js', 'src/cli.ts');

    expect(forms[0]).toBe('./runner.js');
    expect(forms).toContain('src/runner.ts');
    expect(forms).toContain('src/runner.js');
    expect(forms).toContain('src/runner.js/index.ts');
  });

  it("includes a Python module's file and package forms", () => {
    expect(referenceForms('.models', 'app/views.py')).toEqual([
      '.models',
      'app/models',
      'app/models.py',
      'app/models/__init__.py',
    ]);
  });

  it('is the names module= tries, and nothing more, where modules are not files', () => {
    expect(referenceForms('github.com/o/r/internal/db', 'cmd/main.go')).toEqual([
      'github.com/o/r/internal/db',
      'github.com/o/r/internal/db',
    ]);
    expect(referenceForms('crate::infra::db', 'src/lib.rs')).toEqual(['crate::infra::db', 'crate/infra/db', 'crate::infra', 'crate']);
  });

  it("includes the namespaces a C# using sits under, and those it may mean inside its file's namespace", () => {
    expect(referenceForms('Shop.Application.Catalog', 'src/Shop.Domain/Order.cs')).toEqual([
      'Shop.Application.Catalog',
      'Shop/Application/Catalog',
      'Shop.Application',
      'Shop',
    ]);
    expect(referenceForms('Catalog', 'src/Shop.Domain/Order.cs', 'Shop')).toEqual([
      'Catalog',
      'Catalog',
      'Shop.Catalog',
      'Shop/Catalog',
      'Shop',
    ]);
  });

  it("adds a Python module's file forms after the modules it sits under", () => {
    expect(referenceForms('app.db', 'app/views.py')).toEqual(['app.db', 'app/db', 'app', 'app/db.py', 'app/db/__init__.py']);
  });
});

describe('which layers a path is in', () => {
  it('is every layer whose pattern matches, in order', () => {
    const layersOf = layerMatcher(['domain', 'src/domain/events', 'infrastructure']);

    expect(layersOf('src/domain/user.ts')).toEqual([0]);
    expect(layersOf('src/domain/events/created.ts')).toEqual([0, 1]);
    expect(layersOf('src/web/page.ts')).toEqual([]);
  });
});

/* -------------------------------------------------------------------- order */

describe('the order', () => {
  it('lets a layer import from itself and from the layers listed before it', () => {
    const report = checkLayers(
      [
        { file: 'src/application/service.ts', references: [ref('../domain/user.js'), ref('./other.js')] },
        { file: 'src/infrastructure/repo.ts', references: [ref('../domain/user.js'), ref('../application/service.js')] },
      ],
      ORDER,
      true,
    );

    expect(report.violations).toEqual([]);
  });

  it('forbids importing from a layer listed after it', () => {
    const reference = ref('../infrastructure/db.js', 4);
    const report = checkLayers([{ file: 'src/domain/user.ts', references: [reference] }], ORDER, true);

    expect(report.violations).toEqual([{ file: 'src/domain/user.ts', from: 0, to: 2, reference }]);
  });

  it('counts a file once, at its first offending reference in source order', () => {
    const report = checkLayers(
      [
        {
          file: 'src/domain/user.ts',
          references: [ref('./value.js', 1), ref('../application/service.js', 3), ref('../infrastructure/db.js', 7)],
        },
      ],
      ORDER,
      true,
    );

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ to: 1, reference: { line: 3 } });
  });

  it('reports the latest layer a single reference reaches', () => {
    // A path two later layers both match is reported against the later one,
    // which is the rule it breaks by more.
    const order = ['core', 'adapters', 'infrastructure'];
    const report = checkLayers(
      [{ file: 'src/core/model.ts', references: [ref('../infrastructure/adapters/http.js')] }],
      order,
      true,
    );

    expect(report.violations[0]).toMatchObject({ from: 0, to: 2 });
  });

  it('ignores type-only references when asked to, and only then', () => {
    const inputs = [{ file: 'src/domain/user.ts', references: [ref('../infrastructure/db.js', 2, { typeOnly: true })] }];

    expect(checkLayers(inputs, ORDER, false).violations).toEqual([]);
    expect(checkLayers(inputs, ORDER, true).violations).toHaveLength(1);
  });
});

describe('files the order does not settle', () => {
  it('leaves a file no layer claims unchecked, and lists it', () => {
    const report = checkLayers(
      [{ file: 'src/shared/log.ts', references: [ref('../infrastructure/db.js')] }],
      ORDER,
      true,
    );

    expect(report.unassigned).toEqual(['src/shared/log.ts']);
    expect(report.violations).toEqual([]);
  });

  it('refuses to guess which of two layers a file obeys, and lists it with both', () => {
    const order = ['domain', 'src/domain/adapters', 'infrastructure'];
    const report = checkLayers(
      [{ file: 'src/domain/adapters/db.ts', references: [ref('../../infrastructure/db.js')] }],
      order,
      true,
    );

    expect(report.ambiguous).toEqual([{ file: 'src/domain/adapters/db.ts', layers: [0, 1] }]);
    expect(report.violations).toEqual([]);
  });

  it('counts the files each layer holds, an ambiguous one in both', () => {
    const report = checkLayers(
      [
        { file: 'src/domain/a.ts', references: [] },
        { file: 'src/domain/b.ts', references: [] },
        { file: 'src/infrastructure/c.ts', references: [] },
      ],
      ORDER,
      true,
    );

    expect(report.members).toEqual([2, 0, 1]);
  });
});

/* --------------------------------------------------------- what reaches what */

describe('what a reference reaches', () => {
  it('reaches a layer that names a single file, through the extension the import writes', () => {
    // The regression. `src/runner.ts` is the file and `./runner.js` is what
    // imports it, and with only the module and the specifier tried no reference
    // matched any file-sized layer - so this order passed reversed.
    const order = ['src/cli.ts', 'src/runner.ts'];
    const report = checkLayers([{ file: 'src/cli.ts', references: [ref('./runner.js', 14)] }], order, true);

    expect(report.violations).toEqual([
      { file: 'src/cli.ts', from: 0, to: 1, reference: expect.objectContaining({ line: 14 }) },
    ]);
  });

  it('reaches a layer outside the files being checked, by name alone', () => {
    // Only `src/domain` is analysed here; infrastructure was never walked. A
    // rule that needed to find the imported file would miss this.
    const report = checkLayers([{ file: 'src/domain/user.ts', references: [ref('../infrastructure/db')] }], ORDER, true);

    expect(report.violations).toHaveLength(1);
  });

  it('reaches layers by bare name in every language spec-guard reads', () => {
    const order = ['domain', 'infrastructure'];
    const cases: Array<[string, ModuleReference]> = [
      ['app/domain/user.py', ref('app.infrastructure.db')],
      ['app/domain/user.py', ref('..infrastructure.db')],
      ['internal/domain/user.go', ref('github.com/org/repo/internal/infrastructure/db')],
      ['src/domain/user.rs', ref('crate::infrastructure::db', 1, { kind: 'use' })],
      ['src/domain/User.cs', ref('App.infrastructure.Db', 1, { kind: 'using' })],
    ];

    for (const [file, reference] of cases) {
      expect(checkLayers([{ file, references: [reference] }], order, true).violations, file).toHaveLength(1);
      // The control: the same file importing its own layer is fine.
      const own = { ...reference, specifier: reference.specifier.replace('infrastructure', 'domain') };
      expect(checkLayers([{ file, references: [own] }], order, true).violations, `${file} own`).toEqual([]);
    }
  });

  it('reaches a Python layer that names a module file', () => {
    const order = ['app/domain.py', 'app/db.py'];
    const report = checkLayers([{ file: 'app/domain.py', references: [ref('app.db')] }], order, true);

    expect(report.violations).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- c# layers */

const SHOP = ['Shop.Domain', 'Shop.Application', 'Shop.Infrastructure'];

function using(specifier: string, line = 1, namespace?: string): ModuleReference {
  return { ...ref(specifier, line, { kind: 'using' }), namespace };
}

describe('a C# solution layered by namespace', () => {
  it('holds a project to the order by the namespaces its usings name, sub-namespaces included', () => {
    // The regression from a real solution: `Shop.Application` as a layer holds
    // the files of src/Shop.Application, and did not reach `using
    // Shop.Application.Catalog;`, so a domain file importing it passed.
    const violation = using('Shop.Application.Catalog', 3);
    const report = checkLayers(
      [
        { file: 'src/Shop.Domain/Orders/Order.cs', references: [using('Shop.Domain.Common'), violation] },
        { file: 'src/Shop.Application/Catalog/GetProduct.cs', references: [using('Shop.Domain.Orders')] },
      ],
      SHOP,
      true,
    );

    expect(report.violations).toEqual([{ file: 'src/Shop.Domain/Orders/Order.cs', from: 0, to: 1, reference: violation }]);
  });

  it('reaches no layer through a namespace that merely starts with the same letters', () => {
    const report = checkLayers(
      [{ file: 'src/Shop.Domain/Order.cs', references: [using('Shop.ApplicationServices.Pricing')] }],
      SHOP,
      true,
    );

    expect(report.violations).toEqual([]);
  });

  it('reaches a layer through a using written relative to the namespace around it', () => {
    const report = checkLayers(
      [{ file: 'src/Shop.Domain/Order.cs', references: [using('Application.Catalog', 4, 'Shop.Domain')] }],
      SHOP,
      true,
    );

    expect(report.violations).toMatchObject([{ from: 0, to: 1, reference: { line: 4 } }]);
  });
});

describe('what a layer rule could not have seen', () => {
  const PATHS = ['src/Shop.Domain', 'src/Shop.Application', 'src/Shop.Infrastructure'];
  const solution = [
    {
      file: 'src/Shop.Domain/Orders/Order.cs',
      references: [using('Shop.Application.Catalog')],
      namespaces: ['Shop.Domain.Orders'],
    },
    {
      file: 'src/Shop.Application/Catalog/GetProduct.cs',
      references: [using('Shop.Domain.Orders')],
      namespaces: ['Shop.Application.Catalog', 'Shop.Application.Catalog.Queries'],
    },
    { file: 'src/Shop.Infrastructure/Db.cs', references: [], namespaces: ['Shop.Infrastructure'] },
  ];

  it('names every layer after the first whose own namespaces no using can reach, with one they declare', () => {
    // A folder is a path, and a using names a namespace: every layer here holds
    // the right files, and no reference reaches any of them.
    const report = checkLayers(solution, PATHS, true);

    expect(report.violations).toEqual([]);
    expect(report.unreachable).toEqual([
      { layer: 1, namespace: 'Shop.Application.Catalog' },
      { layer: 2, namespace: 'Shop.Infrastructure' },
    ]);
    expect(report.crossed).toBe(false);
  });

  it('names nothing once the layers match the namespaces, and sees the dependency', () => {
    const report = checkLayers(solution, SHOP, true);

    expect(report.unreachable).toEqual([]);
    expect(report.crossed).toBe(true);
    expect(report.violations).toHaveLength(1);
  });

  it('gives as the example the namespace most of the layer declares, not the one its first file borrows', () => {
    const extension = (file: string) => ({ file, references: [], namespaces: ['Microsoft.Extensions.DependencyInjection'] });
    const own = (file: string) => ({ file, references: [], namespaces: ['Shop.Infrastructure.Persistence'] });
    const example = (inputs: LayerInput[]) => checkLayers(inputs, PATHS, true).unreachable;

    expect(
      example([extension('src/Shop.Infrastructure/DependencyInjection.cs'), own('src/Shop.Infrastructure/A.cs'), own('src/Shop.Infrastructure/B.cs')]),
    ).toEqual([{ layer: 2, namespace: 'Shop.Infrastructure.Persistence' }]);
    // A tie goes to the first.
    expect(example([extension('src/Shop.Infrastructure/DependencyInjection.cs'), own('src/Shop.Infrastructure/A.cs')])).toEqual([
      { layer: 2, namespace: 'Microsoft.Extensions.DependencyInjection' },
    ]);
  });

  it('lists the layers in order whatever order their files arrive in', () => {
    expect(checkLayers([...solution].reverse(), PATHS, true).unreachable.map(({ layer }) => layer)).toEqual([1, 2]);
  });

  it('takes one namespace a using can reach as enough, and a file that declares none as saying nothing', () => {
    const report = checkLayers(
      [
        // An extension class in a framework's namespace, beside one that is the layer's own.
        {
          file: 'src/Shop.Application/DependencyInjection.cs',
          references: [],
          namespaces: ['Microsoft.Extensions.DependencyInjection'],
        },
        { file: 'src/Shop.Application/Catalog/Product.cs', references: [], namespaces: ['Shop.Application.Catalog'] },
        { file: 'src/Shop.Infrastructure/Program.cs', references: [] },
      ],
      ['Shop.Domain', 'Shop.Application', 'src/Shop.Infrastructure'],
      true,
    );

    expect(report.unreachable).toEqual([]);
  });

  it('leaves the namespaces of a file no single layer claims out of it', () => {
    const report = checkLayers(
      [
        { file: 'src/Shared/Clock.cs', references: [], namespaces: ['Shared'] },
        { file: 'src/Shop.Domain/Shop.Application/Odd.cs', references: [], namespaces: ['Odd'] },
      ],
      ['Shop.Domain', 'Shop.Application'],
      true,
    );

    expect(report.unreachable).toEqual([]);
  });

  it('says nothing crossed when every reference stays in its own layer or leaves the order', () => {
    const report = checkLayers(
      [
        { file: 'src/domain/a.ts', references: [ref('./b.js'), ref('react')] },
        { file: 'src/application/c.ts', references: [ref('./d.js')] },
        { file: 'src/shared/log.ts', references: [ref('../domain/a.js')] },
      ],
      ORDER,
      true,
    );

    expect(report.crossed).toBe(false);
  });

  it('says something crossed for an allowed reference as much as a forbidden one, and not for one it ignores', () => {
    const allowed = [{ file: 'src/application/c.ts', references: [ref('../domain/a.js')] }];
    expect(checkLayers(allowed, ORDER, true).crossed).toBe(true);

    const typeOnly = [{ file: 'src/application/c.ts', references: [ref('../domain/a.js', 1, { typeOnly: true })] }];
    expect(checkLayers(typeOnly, ORDER, false).crossed).toBe(false);
    expect(checkLayers(typeOnly, ORDER, true).crossed).toBe(true);
  });
});
