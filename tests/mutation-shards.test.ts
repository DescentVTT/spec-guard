/**
 * The merge that turns the shards of the full mutation sweep back into one
 * score (scripts/mutation-shards.mjs).
 *
 * The merge is a gate, so the property worth holding is that it cannot score
 * anything but exactly one sweep: a report split into shards the way Stryker
 * would write them must merge back to the same verdicts, tests and score, and
 * each way of not being one sweep must be refused rather than scored.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ASSIGNED,
  cacheFor,
  checkAssignment,
  formatTable,
  gate,
  mergeReports,
  mutateFor,
  reportHtml,
  SHARD_COUNT,
  ShardError,
  type Mutant,
  type Report,
} from '../scripts/mutation-shards.mjs';

const BASE = ['src/**/*.ts', '!src/types.ts', '!src/index.ts'];
const ASSIGNMENT = [['src/b.ts', 'src/d.ts'], ['src/a.ts']];
const THRESHOLDS = { high: 80, low: 60, break: 50 };

const TESTS: Record<string, string[]> = {
  'tests/a.test.ts': ['parses', 'rejects'],
  'tests/b.test.ts': ['walks', 'skips', 'counts'],
};

const testId = (file: string, name: string) =>
  String(Object.entries(TESTS).flatMap(([f, names]) => names.map((n) => `${f}|${n}`)).indexOf(`${file}|${name}`));

function mutant(id: number, status: string, covered: [string, string][], killed: [string, string][] = []): Mutant {
  return {
    id: String(id),
    mutatorName: 'StringLiteral',
    replacement: '""',
    location: { start: { line: id + 1, column: 1 }, end: { line: id + 1, column: 3 } },
    status,
    static: id % 4 === 0,
    coveredBy: covered.map(([file, name]) => testId(file, name)),
    killedBy: killed.map(([file, name]) => testId(file, name)),
  };
}

const A: [string, string] = ['tests/a.test.ts', 'parses'];
const R: [string, string] = ['tests/a.test.ts', 'rejects'];
const W: [string, string] = ['tests/b.test.ts', 'walks'];
const S: [string, string] = ['tests/b.test.ts', 'skips'];
const C: [string, string] = ['tests/b.test.ts', 'counts'];

// The sweep as one run would report it.
function unsplit(): Report {
  let id = 0;
  const file = (mutants: Mutant[]) => ({ language: 'typescript', source: 'export {};\n', mutants });
  return {
    schemaVersion: '1.0',
    projectRoot: '/work/spec-guard',
    thresholds: THRESHOLDS,
    config: { mutate: BASE, thresholds: THRESHOLDS, timeoutMS: 60000 },
    framework: { name: 'StrykerJS' },
    files: {
      'src/a.ts': file([mutant(id++, 'Killed', [A, R], [R]), mutant(id++, 'Survived', [A]), mutant(id++, 'Timeout', [W], [])]),
      'src/b.ts': file([mutant(id++, 'Killed', [W, S], [S]), mutant(id++, 'NoCoverage', [])]),
      'src/c.ts': file([mutant(id++, 'Survived', [C]), mutant(id++, 'Killed', [C, A], [A]), mutant(id++, 'Killed', [R], [R])]),
      'src/d.ts': file([mutant(id++, 'Killed', [S], [S])]),
      'src/e/f.ts': file([mutant(id++, 'Survived', [W, C]), mutant(id++, 'Killed', [A, W, S], [W])]),
    },
    testFiles: Object.fromEntries(
      Object.entries(TESTS).map(([f, names]) => [
        f,
        { source: '', tests: names.map((name) => ({ id: testId(f, name), name })) },
      ]),
    ),
  };
}

const owner = (file: string) => {
  const index = ASSIGNMENT.findIndex((files) => files.includes(file));
  return index === -1 ? ASSIGNMENT.length + 1 : index + 1;
};

// The shards as Stryker would write them: only their own files, mutant ids and
// test ids numbered afresh, and tests listed in an order of their own - so a
// merge that trusted an id across reports would attach the wrong tests.
function split(report: Report): { shard: number; report: Report }[] {
  return Array.from({ length: ASSIGNMENT.length + 1 }, (_, index) => {
    const shard = index + 1;
    const order = Object.entries(report.testFiles!).flatMap(([file, entry]) => entry.tests.map((test) => ({ file, test })));
    if (shard % 2 === 0) order.reverse();
    const local = new Map(order.map(({ test }, position) => [test.id, String((position * 7 + shard) % 1000)]));
    const testFiles: NonNullable<Report['testFiles']> = {};
    for (const { file, test } of order) {
      (testFiles[file] ??= { source: '', tests: [] }).tests.push({ ...test, id: local.get(test.id)! });
    }
    let nextId = 0;
    const files = Object.fromEntries(
      Object.entries(report.files)
        .filter(([name]) => owner(name) === shard)
        .map(([name, file]) => [
          name,
          {
            ...file,
            mutants: file.mutants.map((m) => ({
              ...m,
              id: String(nextId++),
              coveredBy: m.coveredBy?.map((id) => local.get(id)!),
              killedBy: m.killedBy?.map((id) => local.get(id)!),
            })),
          },
        ]),
    );
    return {
      shard,
      report: {
        ...report,
        files,
        testFiles,
        thresholds: { ...THRESHOLDS, break: null },
        config: { ...report.config, mutate: mutateFor(BASE, shard, ASSIGNMENT), thresholds: { ...THRESHOLDS, break: null } },
      },
    };
  });
}

const CARRIED =
  " A shard started from an incremental file that holds other shards' files reports their old verdicts as its own; see cacheFor.";

const merge = (shards: { shard: number; report: Report }[]) =>
  mergeReports(shards, { base: BASE, thresholds: THRESHOLDS, assigned: ASSIGNMENT });

// Every mutant as what it is, with its tests by name rather than by id.
function verdicts(report: Report) {
  const names = new Map(
    Object.entries(report.testFiles!).flatMap(([file, entry]) => entry.tests.map((test) => [test.id, `${file} > ${test.name}`])),
  );
  return Object.entries(report.files).flatMap(([file, entry]) =>
    entry.mutants.map(({ id: _id, coveredBy, killedBy, ...rest }) => ({
      file,
      ...rest,
      coveredBy: coveredBy?.map((id) => names.get(id)),
      killedBy: killedBy?.map((id) => names.get(id)),
    })),
  );
}

const refused = (shards: { shard: number; report: Report }[]) => {
  try {
    merge(shards);
  } catch (error) {
    expect(error).toBeInstanceOf(ShardError);
    return (error as Error).message;
  }
  throw new Error('merged');
};

describe('mutateFor', () => {
  it('gives a listed shard its files, and the last shard the rest of the base patterns', () => {
    expect(mutateFor(BASE, 1, ASSIGNMENT)).toEqual(['src/b.ts', 'src/d.ts']);
    expect(mutateFor(BASE, '2', ASSIGNMENT)).toEqual(['src/a.ts']);
    expect(mutateFor(BASE, 3, ASSIGNMENT)).toEqual([...BASE, '!src/b.ts', '!src/d.ts', '!src/a.ts']);
  });

  it('refuses a shard that is unset or not one of them', () => {
    for (const shard of [undefined, '', '0', '4', '1.5', ' 1', 'one']) {
      expect(() => mutateFor(BASE, shard, ASSIGNMENT)).toThrow(`A shard is a number from 1 to 3, got "${String(shard)}".`);
    }
  });

  it('refuses a table that lists a file twice, or a file the configuration does not mutate', () => {
    expect(() => checkAssignment(BASE, [['src/a.ts'], ['src/b.ts', 'src/a.ts']])).toThrow(
      'src/a.ts is assigned to shards 1 and 2.',
    );
    expect(() => checkAssignment(BASE, [['src/types.ts']])).toThrow(
      'src/types.ts is assigned to shard 1, but the configuration does not mutate it (src/**/*.ts, !src/types.ts, !src/index.ts).',
    );
    expect(() => checkAssignment(BASE, [['lib/a.ts']])).toThrow('lib/a.ts is assigned to shard 1');
    expect(checkAssignment(['src/**/*.ts', '!src/x/**', 'src/x/keep.ts'], [['src/x/keep.ts']]).get('src/x/keep.ts')).toBe(1);
  });
});

describe('cacheFor', () => {
  it('gives each shard every test and only its own files, and nobody a file the configuration does not mutate', () => {
    const cache = unsplit();
    cache.files['src/types.ts'] = { mutants: [] };
    const parts = [1, 2, 3].map((shard) => cacheFor(cache, mutateFor(BASE, shard, ASSIGNMENT)));

    expect(parts.map((part) => Object.keys(part.files))).toEqual([['src/b.ts', 'src/d.ts'], ['src/a.ts'], ['src/c.ts', 'src/e/f.ts']]);
    for (const part of parts) {
      expect(part.testFiles).toBe(cache.testFiles);
      expect({ ...part, files: undefined }).toEqual({ ...cache, files: undefined });
    }
    expect(Object.keys(cache.files)).toContain('src/types.ts');
  });

  it('leaves nothing to carry over: the merge takes shards started from their parts', () => {
    const original = unsplit();
    const shards = split(original).map(({ shard, report }) => ({
      shard,
      report: { ...report, files: { ...cacheFor(original, mutateFor(BASE, shard, ASSIGNMENT)).files, ...report.files } },
    }));
    expect(verdicts(merge(shards))).toEqual(verdicts(original));
  });
});

describe('mergeReports', () => {
  it('merges the shards back into the sweep they were split from', () => {
    const original = unsplit();
    const merged = merge(split(original));

    expect(verdicts(merged)).toEqual(verdicts(original));
    expect(Object.keys(merged.files)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e/f.ts']);
    const ids = Object.values(merged.files).flatMap((file) => file.mutants.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(gate(merged, THRESHOLDS).metrics).toEqual(gate(original, THRESHOLDS).metrics);
    expect(merged.thresholds).toEqual(THRESHOLDS);
    expect(merged.config).toEqual({ ...original.config, mutate: BASE, thresholds: THRESHOLDS });
    expect(merged.projectRoot).toBe('/work/spec-guard');
  });

  it('merges shards in whatever order their reports arrive', () => {
    const original = unsplit();
    expect(verdicts(merge(split(original).reverse()))).toEqual(verdicts(original));
  });

  it('attaches the wrong tests if test ids are trusted across shards, which is what the fixture is built to catch', () => {
    const original = unsplit();
    const shards = split(original);
    const naive = { ...shards[0]!.report, testFiles: shards[0]!.report.testFiles, files: Object.assign({}, ...shards.map((s) => s.report.files)) };
    expect(verdicts(naive).map((v) => v.coveredBy)).not.toEqual(verdicts(original).map((v) => v.coveredBy));
  });

  it('refuses a sweep with a shard missing', () => {
    const shards = split(unsplit());
    expect(refused(shards.filter((s) => s.shard !== 2))).toBe(
      'No report from shard 2 of 3: the sweep is incomplete, and an incomplete sweep has no score.',
    );
    expect(refused([shards[0]!])).toBe('No report from shard 2 or 3 of 3: the sweep is incomplete, and an incomplete sweep has no score.');
  });

  it('refuses a shard that reported twice, or one that is not a shard', () => {
    const shards = split(unsplit());
    expect(refused([...shards, shards[1]!])).toBe('Shard 2 reported twice.');
    expect(refused([...shards, { shard: 4, report: shards[0]!.report }])).toBe('There are 3 shards, but a report came from shard 4.');
    expect(refused([{ shard: 0, report: shards[0]!.report }, ...shards])).toBe('There are 3 shards, but a report came from shard 0.');
  });

  it('refuses a shard that ran with patterns other than its own', () => {
    const shards = split(unsplit());
    shards[2]!.report.config = { ...shards[2]!.report.config, mutate: BASE };
    expect(refused(shards)).toBe(
      `Shard 3 ran with mutate ${JSON.stringify(BASE)}, not ${JSON.stringify(mutateFor(BASE, 3, ASSIGNMENT))}.`,
    );
  });

  it('refuses a file mutated by two shards', () => {
    const shards = split(unsplit());
    shards[2]!.report.files['src/a.ts'] = shards[1]!.report.files['src/a.ts']!;
    expect(refused(shards)).toBe(`src/a.ts was mutated by shards 2 and 3.${CARRIED}`);
  });

  it('refuses a file reported by a shard it does not belong to', () => {
    const shards = split(unsplit());
    shards[0]!.report.files['src/c.ts'] = shards[2]!.report.files['src/c.ts']!;
    delete shards[2]!.report.files['src/c.ts'];
    expect(refused(shards)).toBe(`src/c.ts belongs to shard 3, but shard 1 reported it.${CARRIED}`);
  });

  // What the first sharded sweep on CI did: every shard started from the whole
  // sweep's incremental file, so Stryker reported the other shards' files too,
  // with the old verdicts it had carried over.
  it('refuses shards that carried the other shards\' verdicts over from an incremental file', () => {
    const original = unsplit();
    const shards = split(original).map(({ shard, report }) => ({
      shard,
      report: { ...report, files: { ...original.files, ...report.files } },
    }));
    expect(refused(shards)).toBe(`src/a.ts belongs to shard 2, but shard 1 reported it.${CARRIED}`);
  });

  it('refuses a listed file its shard did not mutate, as a renamed file would be', () => {
    const shards = split(unsplit());
    delete shards[0]!.report.files['src/d.ts'];
    expect(refused(shards)).toBe(
      'src/d.ts is assigned to shard 1, which reported no mutants in it. If it was renamed or removed, update ASSIGNED in scripts/mutation-shards.mjs.',
    );
  });

  it('refuses shards that ran different tests', () => {
    const shards = split(unsplit());
    const tests = shards[2]!.report.testFiles!['tests/b.test.ts']!.tests;
    tests.splice(tests.findIndex((test) => test.name === 'skips'), 1);
    expect(refused(shards)).toBe('Shards 1 and 3 ran different tests: 1 only in shard 1, 0 only in shard 3, such as "skips" in tests/b.test.ts.');

    const extra = split(unsplit());
    extra[1]!.report.testFiles!['tests/c.test.ts'] = { source: '', tests: [{ id: '999', name: 'is new' }] };
    expect(refused(extra)).toBe('Shards 1 and 2 ran different tests: 0 only in shard 1, 1 only in shard 2, such as "is new" in tests/c.test.ts.');
  });

  it('refuses tests it cannot tell apart by name', () => {
    const shards = split(unsplit());
    const tests = shards[1]!.report.testFiles!['tests/a.test.ts']!.tests;
    tests.push({ ...tests[0]!, id: '998' });
    expect(refused(shards)).toBe(`Shard 2 has two tests named "${tests[0]!.name}" in tests/a.test.ts, so its tests cannot be matched by name.`);
  });

  it('refuses a mutant that names a test its report does not define', () => {
    const shards = split(unsplit());
    shards[1]!.report.files['src/a.ts']!.mutants[0]!.killedBy = ['12345'];
    expect(refused(shards)).toBe('Shard 2 names test 12345, which its report does not define.');
  });
});

describe('gate', () => {
  const scored = (killed: number, survived: number) => {
    const report = unsplit();
    report.files = {
      'src/a.ts': {
        mutants: [
          ...Array.from({ length: killed }, (_, i) => mutant(i, 'Killed', [A], [A])),
          ...Array.from({ length: survived }, (_, i) => mutant(killed + i, 'Survived', [A])),
        ],
      },
    };
    return report;
  };

  it('fails a score under the break threshold and passes one on it, as Stryker does', () => {
    const on = gate(scored(97, 3), { high: 98, low: 95, break: 97 });
    expect(on.metrics.mutationScore).toBe(97);
    expect(on).toMatchObject({ passed: true, message: 'Final mutation score of 97.00 is greater than or equal to break threshold 97.' });

    const under = gate(scored(9699, 301), { high: 98, low: 95, break: 97 });
    expect(under.metrics.mutationScore).toBeCloseTo(96.99, 10);
    expect(under).toMatchObject({ passed: false, message: 'Final mutation score 96.99 under breaking threshold 97.' });
  });

  it('counts a timeout as detected and an uncovered mutant as not', () => {
    const report = unsplit();
    const { metrics } = gate(report, THRESHOLDS);
    expect(metrics).toMatchObject({ killed: 6, timeout: 1, survived: 3, noCoverage: 1, totalMutants: 11 });
    expect(metrics.mutationScore).toBeCloseTo((7 / 11) * 100, 10);
  });

  it('passes anything when no break threshold is configured', () => {
    expect(gate(scored(0, 5), { high: 98, low: 95, break: null })).toMatchObject({
      passed: true,
      message: 'Final mutation score 0.00, with no break threshold configured.',
    });
  });
});

describe('the merged report as people read it', () => {
  it('prints a row per file under the totals', () => {
    expect(formatTable(merge(split(unsplit())))).toBe(
      [
        'File       | % score | % covered | killed | timeout | survived | no cov | errors',
        '-----------|---------|-----------|--------|---------|----------|--------|-------',
        'All files  |   63.64 |     70.00 |      6 |       1 |        3 |      1 |      0',
        'src/a.ts   |   66.67 |     66.67 |      1 |       1 |        1 |      0 |      0',
        'src/b.ts   |   50.00 |    100.00 |      1 |       0 |        0 |      1 |      0',
        'src/c.ts   |   66.67 |     66.67 |      2 |       0 |        1 |      0 |      0',
        'src/d.ts   |  100.00 |    100.00 |      1 |       0 |        0 |      0 |      0',
        'src/e/f.ts |   50.00 |     50.00 |      1 |       0 |        1 |      0 |      0',
      ].join('\n'),
    );
  });

  it('writes a page no source text can break out of', () => {
    const report = unsplit();
    report.files['src/a.ts']!.source = 'const s = "</script><script>alert(1)</script>";';
    const html = reportHtml(report, '/* elements */');
    expect(html).toContain('<script>\n/* elements */\n</script>');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    const payload = html.slice(html.indexOf('app.report = ') + 'app.report = '.length, html.indexOf(';\nfunction updateTheme'));
    expect(new Function(`return ${payload}`)()).toEqual(report);
  });
});

describe('this repository', () => {
  const config = readFileSync('stryker.config.mjs', 'utf8');
  const base = JSON.parse(/mutate: (\[.*\]),/.exec(config)![1]!.replaceAll("'", '"')) as string[];

  it('lists only files the configuration mutates, each once', () => {
    expect(base).toEqual(BASE);
    expect([...checkAssignment(base).keys()].sort()).toEqual(ASSIGNED.flat().sort());
    for (const file of ASSIGNED.flat()) expect(() => readFileSync(file)).not.toThrow();
  });

  it('runs one job per shard', () => {
    const workflow = readFileSync('.github/workflows/mutation.yml', 'utf8');
    expect(/^\s+shard: \[([\d, ]+)\]$/m.exec(workflow)?.[1]).toBe(
      Array.from({ length: SHARD_COUNT }, (_, index) => index + 1).join(', '),
    );
  });
});
