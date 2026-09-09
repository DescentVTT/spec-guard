/**
 * The debt ratchet.
 *
 * A strict rule introduced into a mature codebase lands on violations that
 * already exist. The three usual answers are all bad: widen the rule until it
 * covers nothing, add an `exclude` that becomes a permanent unmonitored blind
 * spot, or write `expected="5"` and learn nothing when one violation is fixed
 * and another appears.
 *
 * A baseline names the files. That makes it reviewable in a diff, it fails when
 * a new file starts violating, and - two-sided, by default - it fails when the
 * ledger claims debt that has been paid, because a spec that says something
 * untrue about the code is the thing this tool exists to catch.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { applyBaseline, runSpecGuard } from '../src/runner.js';
import { formatBaselines } from '../src/reporter.js';
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

const run = (root: string, patterns = ['docs/a.md']) =>
  runSpecGuard({ patterns, root, engine: 'javascript' });

/** A spec whose baseline exempts the two files that already violate. */
const LEGACY = {
  'src/legacy/gateway.ts': 'const a = LegacyGateway;\nconst b = LegacyGateway;\n',
  'src/legacy/adapter.ts': 'const c = LegacyGateway;\n',
  'src/app.ts': 'export const app = 1;\n',
};

const SPEC = (baseline: string, extra = '') =>
  `<!-- @assert-absence target="src" symbol="LegacyGateway" ${extra} baseline="${baseline}" -->\n`;

describe('applyBaseline', () => {
  it('excludes up to the declared count and no further', () => {
    const result = applyBaseline([{ path: 'a.ts', declared: 2 }], new Map([['a.ts', 5]]));
    expect(result).toMatchObject({ excluded: 2, stale: [] });
  });

  it('reports a file that no longer has as many as it declares', () => {
    expect(applyBaseline([{ path: 'a.ts', declared: 2 }], new Map([['a.ts', 1]]))).toMatchObject({
      excluded: 1,
      stale: [{ path: 'a.ts', declared: 2, found: 1 }],
    });
  });

  it('reports a file that no longer matches at all', () => {
    expect(applyBaseline([{ path: 'a.ts', declared: 1 }], new Map())).toMatchObject({
      excluded: 0,
      stale: [{ path: 'a.ts', declared: 1, found: 0 }],
    });
  });

  it('shows a file only when it is over its allowance', () => {
    const { shows } = applyBaseline(
      [
        { path: 'within.ts', declared: 2 },
        { path: 'over.ts', declared: 1 },
      ],
      new Map([
        ['within.ts', 2],
        ['over.ts', 3],
        ['new.ts', 1],
      ]),
    );

    expect(shows('within.ts')).toBe(false);
    expect(shows('over.ts')).toBe(true);
    expect(shows('new.ts')).toBe(true);
  });

  it('shows every matching file when there is no baseline', () => {
    expect(applyBaseline([], new Map([['a.ts', 1]])).shows('a.ts')).toBe(true);
  });
});

describe('a baseline that matches reality', () => {
  it('passes', async () => {
    const root = await repo({ ...LEGACY, 'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts') });

    const report = await run(root);

    expect(report.ok).toBe(true);
    expect(report.results[0]?.actual).toBe(0);
    expect(report.results[0]?.baselinedMatches).toBe(3);
  });

  it('says out loud that it excluded matches', async () => {
    const root = await repo({ ...LEGACY, 'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts') });

    const report = await run(root);
    const { formatReport } = await import('../src/reporter.js');

    expect(formatReport(report, { color: false, verbose: false })).toContain(
      '3 matches excluded by the baseline',
    );
  });
});

describe('the ratchet catches debt growing', () => {
  it('fails when a file that is not on the baseline starts violating', async () => {
    const root = await repo({
      ...LEGACY,
      'src/new-feature.ts': 'const d = LegacyGateway;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts'),
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.actual).toBe(1);
    expect(report.results[0]?.matches[0]?.file).toBe('src/new-feature.ts');
  });

  it('fails when a baselined file violates more than it declares', async () => {
    const root = await repo({
      ...LEGACY,
      'src/legacy/adapter.ts': 'const c = LegacyGateway;\nconst d = LegacyGateway;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts'),
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    // One over the declared allowance, not all four: the failure points at the
    // change rather than at the history.
    expect(report.results[0]?.actual).toBe(1);
  });
});

describe('the ratchet catches debt claimed but not owed', () => {
  it('fails when a baselined file has been cleaned up', async () => {
    const root = await repo({
      ...LEGACY,
      'src/legacy/adapter.ts': 'export const adapter = 1;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts'),
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('the baseline is out of date and must be pruned');
    expect(report.results[0]?.message).toContain('src/legacy/adapter.ts (no longer matches)');
    expect(report.results[0]?.staleBaseline).toEqual([
      { path: 'src/legacy/adapter.ts', declared: 1, found: 0 },
    ]);
  });

  it('fails when a baselined file has been partly cleaned up', async () => {
    const root = await repo({
      ...LEGACY,
      'src/legacy/gateway.ts': 'const a = LegacyGateway;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts'),
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('src/legacy/gateway.ts (declares 2, found 1)');
  });

  it('passes the same case under ratchet="one-way"', async () => {
    const root = await repo({
      ...LEGACY,
      'src/legacy/adapter.ts': 'export const adapter = 1;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts', 'ratchet="one-way"'),
    });

    const report = await run(root);

    expect(report.ok).toBe(true);
    // Not failing is not the same as not knowing: the entry is still reported.
    expect(report.results[0]?.staleBaseline).toEqual([
      { path: 'src/legacy/adapter.ts', declared: 1, found: 0 },
    ]);
  });

  it('still fails a one-way ratchet when new debt appears', async () => {
    const root = await repo({
      ...LEGACY,
      'src/new-feature.ts': 'const d = LegacyGateway;\n',
      'docs/a.md': SPEC('src/legacy/gateway.ts:2 src/legacy/adapter.ts', 'ratchet="one-way"'),
    });

    expect((await run(root)).ok).toBe(false);
  });
});

describe('baselines on import assertions', () => {
  const IMPORTS = {
    'ui/legacy-view.py': 'from app.db.client import Client\n',
    'ui/view.py': 'from app.widgets import button\n',
  };

  it('exempts a declared file and catches a new one', async () => {
    const clean = await repo({
      ...IMPORTS,
      'docs/a.md':
        '<!-- @assert-import-absence target="ui" module="app/db/**" baseline="ui/legacy-view.py" -->\n',
    });
    expect((await run(clean)).ok).toBe(true);

    const regressed = await repo({
      ...IMPORTS,
      'ui/new-view.py': 'from app.db.client import Client\n',
      'docs/a.md':
        '<!-- @assert-import-absence target="ui" module="app/db/**" baseline="ui/legacy-view.py" -->\n',
    });
    const report = await run(regressed);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.actual).toBe(1);
    expect(report.results[0]?.matches.map((match) => match.file)).toEqual(['ui/new-view.py']);
  });

  it('fails when a declared file no longer imports the module', async () => {
    const root = await repo({
      'ui/legacy-view.py': 'from app.widgets import button\n',
      'docs/a.md':
        '<!-- @assert-import-absence target="ui" module="app/db/**" baseline="ui/legacy-view.py" -->\n',
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('must be pruned');
  });
});

describe('what the directive will not accept', () => {
  it.each([
    // A baseline says "these known files may violate", which means nothing for
    // an assertion that is not forbidding anything - so the parser refuses the
    // attribute rather than the runner inventing a reading for it.
    [
      '<!-- @assert-count target="src" symbol="X" expected="1" baseline="src/app.ts" -->',
      'Unknown attribute "baseline" on @assert-count',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" baseline="src/a.ts src/a.ts" -->',
      'lists "src/a.ts" twice',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" baseline="src/a.ts:0" -->',
      'declares 0 matches',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" baseline="src/a.ts:many" -->',
      'must be a non-negative integer',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" baseline="../outside.ts" -->',
      'escapes the root directory',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" ratchet="sideways" baseline="src/a.ts" -->',
      'must be two-sided or one-way',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" ratchet="one-way" -->',
      'needs a baseline',
    ],
  ])('rejects %s', async (directive, message) => {
    const root = await repo({ ...LEGACY, 'docs/a.md': `${directive}\n` });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.errors[0]?.message).toContain(message);
  });
});

describe('--print-baseline', () => {
  it('prints the entries that would exempt today violations', async () => {
    const root = await repo({
      ...LEGACY,
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
    });

    const printed = formatBaselines(await run(root));

    expect(printed).toContain('src/legacy/gateway.ts:2');
    expect(printed).toContain('src/legacy/adapter.ts');
    expect(printed).not.toContain('src/app.ts');
  });

  it('pasting what it prints makes the same run pass', async () => {
    // The round trip is the claim worth testing: the output is not advice, it
    // is the exact attribute value that turns this failure into a pass.
    const root = await repo({
      ...LEGACY,
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
    });
    const printed = formatBaselines(await run(root));
    const value = /baseline="([\s\S]*?)"/.exec(printed)?.[1] as string;

    const pasted = await repo({ ...LEGACY, 'docs/a.md': SPEC(value) });

    expect((await run(pasted)).ok).toBe(true);
  });

  it('says so when there is nothing to baseline', async () => {
    const root = await repo({
      'src/app.ts': 'export const app = 1;\n',
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
    });

    expect(formatBaselines(await run(root))).toContain('nothing to baseline');
  });
});
