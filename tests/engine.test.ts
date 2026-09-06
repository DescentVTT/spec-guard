import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildJsRegExp,
  buildRipgrepArgs,
  canBatchLiterals,
  createCachedEngine,
  escapeRegExp,
  findRipgrep,
  javascriptEngine,
  resetRipgrepProbe,
  resolveEngine,
  runSearches,
  scanContent,
  type Engine,
  type SearchRequest,
} from '../src/engine.js';
import { DEMO_REPO, findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const originalRg = process.env.SPEC_GUARD_RG;
const temporary: string[] = [];

beforeAll(() => {
  resetRipgrepProbe();
});

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
  resetRipgrepProbe();
});

afterAll(() => {
  if (originalRg === undefined) delete process.env.SPEC_GUARD_RG;
  else process.env.SPEC_GUARD_RG = originalRg;
});

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    root: DEMO_REPO,
    symbol: 'UserSessionManager',
    targets: ['src'],
    options: searchOptions(),
    ...overrides,
  };
}

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o',
    );
  });
});

describe('buildJsRegExp', () => {
  it('treats the symbol literally by default', () => {
    const regexp = buildJsRegExp('a.c', searchOptions());
    expect('abc'.match(regexp)).toBeNull();
    expect('a.c'.match(regexp)).toHaveLength(1);
  });

  it('honours regex mode', () => {
    expect('abc'.match(buildJsRegExp('a.c', searchOptions({ regex: true })))).toHaveLength(1);
  });

  it('honours word mode for literals and regexes', () => {
    expect('PrimaryButtonTestId'.match(buildJsRegExp('PrimaryButton', searchOptions({ word: true })))).toBeNull();
    expect('PrimaryButton x'.match(buildJsRegExp('PrimaryButton', searchOptions({ word: true })))).toHaveLength(1);
    expect('fooBar'.match(buildJsRegExp('foo', searchOptions({ word: true, regex: true })))).toBeNull();
  });

  it('honours ignore-case', () => {
    expect('PRIMARY'.match(buildJsRegExp('primary', searchOptions({ ignoreCase: true })))).toHaveLength(1);
  });
});

describe('scanContent', () => {
  it('counts every occurrence and groups snippets by line', () => {
    const content = ['const a = Foo;', 'const b = Foo + Foo;', 'const c = 1;'].join('\n');
    const result = scanContent(content, 'a.ts', buildJsRegExp('Foo', searchOptions()));

    expect(result.count).toBe(3);
    expect(result.locations).toHaveLength(2);
    expect(result.locations[0]).toMatchObject({ file: 'a.ts', line: 1, column: 11, count: 1 });
    expect(result.locations[1]).toMatchObject({ line: 2, count: 2, text: 'const b = Foo + Foo;' });
  });

  it('finds a match on the last line without a trailing newline', () => {
    const result = scanContent('a\nb\nFoo', 'a.ts', buildJsRegExp('Foo', searchOptions()));
    expect(result.locations[0]?.line).toBe(3);
  });

  it('does not loop forever on a zero-length match', () => {
    const result = scanContent('abc', 'a.ts', buildJsRegExp('x?', searchOptions({ regex: true })));
    expect(result.count).toBeGreaterThan(0);
  });

  it('truncates very long lines', () => {
    const content = `${'x'.repeat(500)}Foo`;
    const result = scanContent(content, 'a.ts', buildJsRegExp('Foo', searchOptions()));
    expect(result.locations[0]?.text.length).toBeLessThanOrEqual(201);
  });
});

describe('buildRipgrepArgs', () => {
  it('uses fixed-strings by default', () => {
    const args = buildRipgrepArgs(request());
    expect(args).toContain('--fixed-strings');
    expect(args).toContain('--json');
    expect(args).toContain('--no-config');
    expect(args.slice(-4)).toEqual(['--regexp', 'UserSessionManager', '--', 'src']);
  });

  it('maps every search option onto a flag', () => {
    const args = buildRipgrepArgs(
      request({ options: searchOptions({ regex: true, word: true, ignoreCase: true, globs: ['*.ts', '*.tsx'] }) }),
    );
    expect(args).not.toContain('--fixed-strings');
    expect(args).toContain('--word-regexp');
    expect(args).toContain('--ignore-case');
    expect(args.filter((arg) => arg === '--glob')).toHaveLength(2);
  });

  it('falls back to the current directory when no target survives', () => {
    expect(buildRipgrepArgs(request({ targets: [] })).at(-1)).toBe('.');
  });
});

describe('findRipgrep', () => {
  it('returns null when the binary does not exist', async () => {
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    resetRipgrepProbe();
    expect(await findRipgrep()).toBeNull();
  });

  it('caches the probe result', async () => {
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    resetRipgrepProbe();
    const first = await findRipgrep();
    process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
    expect(await findRipgrep()).toBe(first);
  });

  it.runIf(rgPath)('finds a real binary', async () => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    expect(await findRipgrep()).toBe(rgPath);
  });
});

describe('resolveEngine', () => {
  it('returns the javascript engine on request', async () => {
    expect((await resolveEngine('javascript')).name).toBe('javascript');
  });

  it('fails loudly when ripgrep is required but missing', async () => {
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    resetRipgrepProbe();
    await expect(resolveEngine('ripgrep')).rejects.toThrow(/not available on PATH/);
  });

  it('falls back to javascript when auto cannot find ripgrep', async () => {
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    const engine = await resolveEngine('auto');
    const result = await engine.search(request());
    expect(result.count).toBe(1);
    expect(result.engine).toBe('javascript');
    expect(engine.name).toBe('javascript');
  });

  it.runIf(rgPath)('uses ripgrep when it is available', async () => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    const engine = await resolveEngine('auto');
    const result = await engine.search(request());
    expect(result.engine).toBe('ripgrep');
    expect(engine.name).toBe('ripgrep');
  });
});

describe('engine behaviour', () => {
  const queries: Array<{ name: string; request: SearchRequest; count: number }> = [
    { name: 'literal symbol', request: request(), count: 1 },
    { name: 'absent symbol', request: request({ symbol: 'STRIPE_SECRET_KEY' }), count: 0 },
    {
      name: 'multiple targets',
      request: request({ symbol: 'LegacyPaymentGateway', targets: ['src/controllers', 'src/services'] }),
      count: 0,
    },
    { name: 'multi-match file', request: request({ symbol: 'DeprecatedHelper', targets: ['src/core'] }), count: 3 },
    {
      name: 'word boundaries',
      request: request({ symbol: 'PrimaryButton', targets: ['src/ui'], options: searchOptions({ word: true }) }),
      count: 1,
    },
    {
      name: 'regex mode',
      request: request({ symbol: 'class [A-Z][A-Za-z]+', options: searchOptions({ regex: true }) }),
      count: 4,
    },
    {
      name: 'ignore case',
      request: request({ symbol: 'primarybutton', options: searchOptions({ ignoreCase: true }) }),
      count: 2,
    },
    {
      name: 'glob filter',
      request: request({ symbol: 'export', options: searchOptions({ globs: ['*.tsx'] }) }),
      count: 2,
    },
    { name: 'binary files are skipped', request: request({ symbol: 'BinaryOnlySymbol' }), count: 0 },
    { name: 'single file target', request: request({ targets: ['src/services/UserSessionManager.ts'] }), count: 1 },
    // No target at all means "the whole root", which includes the docs folder.
    { name: 'empty target list', request: request({ targets: [] }), count: 2 },
  ];

  const engines: Array<[string, () => Promise<Engine>]> = [['javascript', async () => javascriptEngine]];
  if (rgPath) {
    engines.push([
      'ripgrep',
      async () => {
        process.env.SPEC_GUARD_RG = rgPath;
        resetRipgrepProbe();
        return resolveEngine('ripgrep');
      },
    ]);
  }

  for (const [engineName, factory] of engines) {
    describe(engineName, () => {
      for (const query of queries) {
        it(`counts ${query.name}`, async () => {
          const engine = await factory();
          const result = await engine.search(query.request);
          expect(result.count).toBe(query.count);
        });
      }

      it('reports usable snippets', async () => {
        const engine = await factory();
        const result = await engine.search(request({ symbol: 'DeprecatedHelper', targets: ['src/core'] }));
        expect(result.matches[0]).toMatchObject({
          file: 'src/core/DeprecatedHelper.ts',
          line: 2,
          count: 1,
        });
        expect(result.matches[0]?.text).toContain('export function DeprecatedHelper');
        expect(result.matches[1]?.count).toBe(2);
      });

      it('excludes the spec files themselves when asked', async () => {
        const engine = await factory();
        const excluded = path.resolve(DEMO_REPO, 'src/services/UserSessionManager.ts');
        const result = await engine.search(
          request({ options: searchOptions({ excludeFiles: new Set([excluded]) }) }),
        );
        expect(result.count).toBe(0);
      });
    });
  }

  it.runIf(rgPath)('agrees with the javascript engine on every query', async () => {
    process.env.SPEC_GUARD_RG = rgPath as string;
    resetRipgrepProbe();
    const ripgrep = await resolveEngine('ripgrep');

    for (const query of queries) {
      const [fromRipgrep, fromJs] = await Promise.all([
        ripgrep.search(query.request),
        javascriptEngine.search(query.request),
      ]);
      expect(fromRipgrep.count, query.name).toBe(fromJs.count);
      expect(fromRipgrep.matches.map((match) => `${match.file}:${match.line}:${match.count}`), query.name).toEqual(
        fromJs.matches.map((match) => `${match.file}:${match.line}:${match.count}`),
      );
    }
  });

  it('skips files larger than the size limit', async () => {
    const root = await makeTempRepo({ 'big.ts': `${'x'.repeat(21 * 1024 * 1024)}\nHugeSymbol\n` });
    temporary.push(root);
    const result = await javascriptEngine.search({
      root,
      symbol: 'HugeSymbol',
      targets: ['.'],
      options: searchOptions(),
    });
    expect(result.count).toBe(0);
  });

  it('skips a single-file target that is too large', async () => {
    const root = await makeTempRepo({ 'big.ts': `${'x'.repeat(21 * 1024 * 1024)}\nHugeSymbol\n` });
    temporary.push(root);
    const result = await javascriptEngine.search({
      root,
      symbol: 'HugeSymbol',
      targets: ['big.ts'],
      options: searchOptions(),
    });
    expect(result.count).toBe(0);
  });
});

describe('createCachedEngine', () => {
  it('runs an identical query only once', async () => {
    let calls = 0;
    const engine = createCachedEngine({
      name: 'javascript',
      async search(searchRequest) {
        calls += 1;
        return javascriptEngine.search(searchRequest);
      },
    });

    const [a, b] = await Promise.all([engine.search(request()), engine.search(request())]);

    expect(calls).toBe(1);
    expect(a.count).toBe(b.count);
  });

  it('treats different options as different queries', async () => {
    let calls = 0;
    const engine = createCachedEngine({
      name: 'javascript',
      async search(searchRequest) {
        calls += 1;
        return javascriptEngine.search(searchRequest);
      },
    });

    await engine.search(request());
    await engine.search(request({ options: searchOptions({ ignoreCase: true }) }));

    expect(calls).toBe(2);
  });

  it('falls back to the javascript engine when the primary engine fails', async () => {
    const engine = createCachedEngine({
      name: 'ripgrep',
      async search() {
        throw new Error('rg exploded');
      },
    });

    const result = await engine.search(request());

    expect(result.count).toBe(1);
    expect(result.engine).toBe('javascript');
    expect(engine.fallbacks).toEqual(['rg exploded']);
  });

  it('does not swallow javascript engine failures', async () => {
    const engine = createCachedEngine(javascriptEngine);
    await expect(
      engine.search(request({ symbol: '(', options: searchOptions({ regex: true }) })),
    ).rejects.toThrow();
  });

  it('reports the engine name lazily', async () => {
    process.env.SPEC_GUARD_RG = path.join(DEMO_REPO, 'definitely-not-ripgrep');
    const engine = createCachedEngine(await resolveEngine('auto'));
    expect(engine.name).toBe('ripgrep');
    await engine.search(request());
    expect(engine.name).toBe('javascript');
  });
});

describe('canBatchLiterals', () => {
  it('accepts patterns that can never overlap', () => {
    expect(canBatchLiterals(['Alpha', 'Bravo', 'Charlie'])).toBe(true);
  });

  it('rejects containment', () => {
    expect(canBatchLiterals(['Primary', 'PrimaryButton'])).toBe(false);
    expect(canBatchLiterals(['PrimaryButton', 'Primary'])).toBe(false);
  });

  it('rejects dovetailing patterns', () => {
    // "abc" and "cd" both match inside "abcd", but one alternation pass would
    // find only the first.
    expect(canBatchLiterals(['abc', 'cd'])).toBe(false);
  });

  it('accepts a single pattern', () => {
    expect(canBatchLiterals(['Alpha'])).toBe(true);
  });
});

describe('batched searches', () => {
  const overlapping = ['Primary', 'PrimaryButton', 'ButtonTest'];

  async function repoWithOverlaps(): Promise<string> {
    const root = await makeTempRepo({
      'src/a.ts': [
        'export const Primary = 1;',
        'export const PrimaryButton = 2;',
        'export const ButtonTestId = "PrimaryButtonTest";',
        'const x = Primary + PrimaryButton;',
      ].join('\n'),
      'src/b.ts': 'export { Primary } from "./a.js";\n',
    });
    temporary.push(root);
    return root;
  }

  function requestsFor(root: string, symbols: string[], overrides = {}): SearchRequest[] {
    const options = searchOptions(overrides);
    return symbols.map((symbol) => ({ root, symbol, targets: ['src'], options }));
  }

  it.each(rgPath ? ['javascript', 'ripgrep'] : ['javascript'])(
    'gives the same answer batched as unbatched [%s]',
    async (engineName) => {
      const root = await repoWithOverlaps();
      process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
      resetRipgrepProbe();
      const engine = await resolveEngine(engineName === 'ripgrep' ? 'ripgrep' : 'javascript');

      const requests = requestsFor(root, overlapping);
      const batched = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(requests);
      const individually = await Promise.all(requests.map((request) => engine.search(request)));

      expect(batched.map((result) => result.count)).toEqual(individually.map((result) => result.count));
      expect(batched.map((result) => result.matches)).toEqual(individually.map((result) => result.matches));
      // Sanity: these counts are what a human would count by hand.
      expect(batched.map((result) => result.count)).toEqual([6, 3, 2]);
    },
  );

  it.each(rgPath ? ['javascript', 'ripgrep'] : ['javascript'])(
    'batches non-overlapping patterns without changing counts [%s]',
    async (engineName) => {
      const root = await repoWithOverlaps();
      process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
      resetRipgrepProbe();
      const engine = await resolveEngine(engineName === 'ripgrep' ? 'ripgrep' : 'javascript');

      const requests = requestsFor(root, ['Primary', 'export']);
      const batched = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(requests);
      const individually = await Promise.all(requests.map((request) => engine.search(request)));

      expect(batched.map((result) => result.count)).toEqual(individually.map((result) => result.count));
    },
  );

  it.each(rgPath ? ['javascript', 'ripgrep'] : ['javascript'])(
    'falls back to separate passes for regex and ignore-case groups [%s]',
    async (engineName) => {
      const root = await repoWithOverlaps();
      process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
      resetRipgrepProbe();
      const engine = await resolveEngine(engineName === 'ripgrep' ? 'ripgrep' : 'javascript');

      const regexRequests = requestsFor(root, ['Primary[A-Za-z]*', 'Button[A-Za-z]*'], { regex: true });
      const regexBatched = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(regexRequests);
      const regexIndividually = await Promise.all(regexRequests.map((request) => engine.search(request)));
      expect(regexBatched.map((r) => r.count)).toEqual(regexIndividually.map((r) => r.count));

      const caseRequests = requestsFor(root, ['primary', 'primarybutton'], { ignoreCase: true });
      const caseBatched = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(caseRequests);
      const caseIndividually = await Promise.all(caseRequests.map((request) => engine.search(request)));
      expect(caseBatched.map((r) => r.count)).toEqual(caseIndividually.map((r) => r.count));
    },
  );

  it('returns nothing for an empty batch', async () => {
    expect(await javascriptEngine.searchBatch([])).toEqual([]);
    expect(await runSearches(javascriptEngine, [])).toEqual([]);
  });

  it('does not batch requests with different targets', async () => {
    const root = await repoWithOverlaps();
    const options = searchOptions();
    const results = await runSearches(javascriptEngine, [
      { root, symbol: 'Primary', targets: ['src'], options },
      { root, symbol: 'Primary', targets: ['src/b.ts'], options },
    ]);
    expect(results.map((result) => result.count)).toEqual([6, 1]);
  });

  it('caches batched results across calls', async () => {
    const root = await repoWithOverlaps();
    let passes = 0;
    const engine = createCachedEngine({
      name: 'javascript',
      search: (request) => javascriptEngine.search(request),
      searchBatch: (requests) => {
        passes += 1;
        return javascriptEngine.searchBatch(requests);
      },
    });

    const requests = requestsFor(root, ['Primary', 'export']);
    const first = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(requests);
    const second = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(requests);

    expect(passes).toBe(1);
    expect(second.map((result) => result.count)).toEqual(first.map((result) => result.count));
  });

  it('falls back to the javascript engine when a batched ripgrep pass fails', async () => {
    const root = await repoWithOverlaps();
    const engine = createCachedEngine({
      name: 'ripgrep',
      search: async () => {
        throw new Error('rg exploded');
      },
      searchBatch: async () => {
        throw new Error('rg exploded');
      },
    });

    const results = await (engine.searchBatch as NonNullable<Engine['searchBatch']>)(
      requestsFor(root, ['Primary', 'export']),
    );

    expect(results.map((result) => result.count)).toEqual([6, 4]);
    expect(engine.fallbacks).toEqual(['rg exploded']);
  });
});

describe('ripgrep failure handling', () => {
  it('rejects when the binary exits with an error code', async () => {
    // node(1) rejects ripgrep's flags, exits non-zero and writes to stderr,
    // which is exactly the shape of a broken ripgrep.
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const engine = await resolveEngine('ripgrep');

    await expect(engine.search(request())).rejects.toThrow(/ripgrep exited with code/);
  });

  it('falls back to the javascript engine when ripgrep misbehaves mid-run', async () => {
    process.env.SPEC_GUARD_RG = process.execPath;
    resetRipgrepProbe();
    const engine = createCachedEngine(await resolveEngine('auto'));

    const result = await engine.search(request());

    expect(result.count).toBe(1);
    expect(result.engine).toBe('javascript');
    expect(engine.fallbacks[0]).toMatch(/ripgrep exited with code/);
  });

  it('returns nothing for an empty ripgrep batch', async () => {
    process.env.SPEC_GUARD_RG = rgPath ?? 'rg';
    resetRipgrepProbe();
    const engine = await resolveEngine('ripgrep');
    expect(await (engine.searchBatch as NonNullable<Engine['searchBatch']>)([])).toEqual([]);
  });
});
