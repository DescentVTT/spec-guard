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
import { checkLayers, layerMatcher, referenceForms } from '../src/layers.js';

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

  it('is the specifier and its module, and nothing more, where modules are not files', () => {
    expect(referenceForms('github.com/o/r/internal/db', 'cmd/main.go')).toEqual([
      'github.com/o/r/internal/db',
      'github.com/o/r/internal/db',
    ]);
    expect(referenceForms('crate::infra::db', 'src/lib.rs')).toEqual(['crate::infra::db', 'crate/infra/db']);
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
