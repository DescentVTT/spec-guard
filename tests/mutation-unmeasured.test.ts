/**
 * What the mutation sweep does not read (scripts/mutation-unmeasured.mjs).
 *
 * Stryker passes over everything under a TypeScript `as`, and no report says
 * so: a mutant that was never made is in no column. The script counts the
 * places a mutator would have applied there, and the sweep's score step fails
 * a count above the one recorded as left. A count is only worth failing a
 * sweep for while it is of what Stryker would do, so it is held here to the
 * instrumenter installed: over one source written with every kind of site,
 * Stryker makes no mutant under a cast, and with the casts taken away it
 * mutates exactly the places the script counted.
 *
 * Not part of a mutation run: it reads `src/` as text, which in Stryker's
 * sandbox carries every mutant at once, and it loads the instrumenter, which
 * every static mutant that survives would wait for.
 *
 * spec-core's test of the same script was adapted from this one and came to
 * hold more: a key written as a string and a type inside the expression,
 * which are no place; a mutant beside a cast on the cast's own line; a run
 * given two reports; and a run that no job asked a summary of. This one
 * holds those too, and reads no report from disk for them.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LEFT, loadParser, main, measure, treeSources, unmeasured, verdict, type Hidden, type Parse } from '../scripts/mutation-unmeasured.mjs';
import type { Report } from '../scripts/mutation-shards.mjs';
import mutationSuite from '../vitest.mutation.config.js';
import { PROJECT_ROOT } from './helpers.js';

// Each cast sits between two comments, so that the same source can be read
// with its casts and with spaces where they were, every other character where
// it was.
const CAST = /\/\*<\*\/.*?\/\*>\*\//g;
const WRITTEN = [
  'const ESC = String.fromCharCode(27);',
  "export const TABLE = { red: `${ESC}[31m`, plain: '', deep: [1, -2] }/*<*/ as const/*>*/;",
  'export function last(words: readonly string[], at: number): string {',
  '  const end = words[words.length - 1]/*<*/ as string/*>*/;',
  '  const named = end/*<*/ as string | undefined/*>*/;',
  '  return (words[at + 1] ?? named?.trim())/*<*/ as string/*>*/;',
  '}',
  "export const pick = (list: string[]) => list.filter((item) => item !== '' && !item.startsWith('#')).sort()[0]/*<*/ as string/*>*/;",
  "export const held = { a: 'x' } satisfies Record<string, string>;",
  'export const sure = (list: string[]) => list[list.length - 1]!;',
  "export const kind = 'file'/*<*/ as 'file' | 'directory'/*>*/;",
  "export const run = (() => { if (kind) { held.a.trim(); } for (;;) { throw new Error('x'); } })/*<*/ as () => void/*>*/;",
  "export const nested = [(TABLE.deep[0] + 1)/*<*/ as number/*>*/, 'b']/*<*/ as const/*>*/;",
  'export const quiet = (() => { held.a.at(0); throw new Error(); })/*<*/ as () => void/*>*/;',
  'export const either = (kind ? 1 : 2)/*<*/ as number/*>*/;',
  'let count = 0;',
  'export const step = (count++ > 0 || (count += 2) > 0 ? /a+/ : null)/*<*/ as RegExp | null/*>*/;',
  '',
].join('\n');
const UNCAST = WRITTEN.replace(CAST, (cast) => ' '.repeat(cast.length));

// Line by line, the places counted under each cast that has one.
const COUNTED: [number, number][] = [
  // The table, its template, its empty string, its list and the minus in it.
  [2, 5],
  // The subtraction in the index.
  [4, 1],
  // `??`, the addition, the optional chain and the `trim`.
  [6, 4],
  // Three methods, the arrow, `&&`, `!==`, `!` and two strings.
  [8, 9],
  // The value, and nothing of the type beside it.
  [11, 1],
  // Three blocks, the test of the `if`, the `trim`, a `for` with no test and
  // the string. Neither statement: each would not be its own only mutant.
  [12, 7],
  // The list, the addition under the cast inside it, and the string.
  [13, 3],
  // The block, and the call and the throw, each a statement's only mutant.
  [14, 3],
  // `||`, `>` twice, `++`, `+=` and the pattern.
  [17, 6],
];
const TOTAL = COUNTED.reduce((sum, [, sites]) => sum + sites, 0);

// What the source above does not write, one cast to a source, with the
// places counted under it.
const MORE: [string, number][] = [
  // A key written as a string is no place: the table and its value are.
  ["export const TABLE = { 'a-b': 'x' }/*<*/ as const/*>*/;", 2],
  // A type inside the expression is no place, whatever it is written with:
  // the arrow is, and neither `true`.
  ['export const pick = ((flag: true): true | 2 => (flag ? flag : 2))/*<*/ as (flag: true) => true | 2/*>*/;', 1],
];

interface Made {
  mutatorName: string;
  replacement: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/** Stryker's own instrumenter, found as Stryker finds it, and the mutants it makes of one source. */
async function instrumenter(): Promise<(source: string) => Promise<Made[]>> {
  const core = createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
  const { Instrumenter } = (await import(pathToFileURL(core.resolve('@stryker-mutator/instrumenter')).href)) as {
    Instrumenter: new (logger: object) => { instrument(files: object[], options: object): Promise<{ mutants: Made[] }> };
  };
  const quiet = (): void => undefined;
  const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, isDebugEnabled: () => false };
  const options = { plugins: null, excludedMutations: [], mutationRange: [], ignorers: [], noHeader: true };
  return async (source) => (await new Instrumenter(logger).instrument([{ name: 'src/written.ts', mutate: true, content: source }], options)).mutants;
}

// The instrumenter counts lines and columns from 0, and a report from 1.
const under = ({ location: { start, end } }: Made, entry: Hidden): boolean =>
  (start.line + 1 > entry.line || (start.line + 1 === entry.line && start.column + 1 >= entry.column)) &&
  (end.line + 1 < entry.endLine || (end.line + 1 === entry.endLine && end.column + 1 <= entry.endColumn));
const place = ({ location: { start, end } }: Made): string => `${start.line}:${start.column}-${end.line}:${end.column}`;

// The time the suite gives a test, where vitest gives a hook ten seconds:
// beside every other file on a loaded machine, loading the parser took more.
let parse: Parse;
beforeAll(async () => {
  parse = await loadParser();
}, 60_000);

describe('what stands under an `as`', () => {
  it('is counted place by place, under the outermost cast only', () => {
    const read = unmeasured(WRITTEN, parse);
    expect(read.hidden.map(({ line, sites }) => [line, sites])).toEqual(COUNTED);
    // Twelve casts are written and one is inside another.
    expect(read.expressions).toBe(11);
    expect(read.hidden[0]).toEqual({ line: 2, column: 22, endLine: 2, endColumn: 83, sites: 5, text: "{ red: `${ESC}[31m`, plain: '', deep: [1, -2] }/*<*/ as const" });
  });

  it('is nothing for a cast on a name, a `satisfies`, a `!`, or a ternary that only chooses', () => {
    const lines = unmeasured(WRITTEN, parse).hidden.map(({ line }) => line);
    for (const line of [5, 9, 10, 15]) expect(lines).not.toContain(line);
    expect(unmeasured(UNCAST, parse)).toEqual({ expressions: 0, hidden: [] });
  });

  it('is nothing for a read by a written key whose object the cast names, and one place with the cast around the read', () => {
    // The shape the sources keep, as `(error as { code?: unknown }).code`
    // does in src/cli.ts: what is read is outside the cast.
    expect(unmeasured("export const id = (message: object) => (message as { id: string })['id'];", parse)).toEqual({ expressions: 1, hidden: [] });
    const [entry] = unmeasured("export const id = (message: Record<string, unknown>) => message['id'] as string;", parse).hidden;
    expect(entry).toMatchObject({ line: 1, sites: 1, text: "message['id'] as string" });
  });

  it("counts an enum's initialisers, which Stryker passes over the same way", () => {
    const read = unmeasured("export enum Mark { Pass = 'pass', Fail = 1 + 2, Skip }\nexport const one = [1];\n", parse);
    expect(read).toEqual({ expressions: 1, hidden: [expect.objectContaining({ line: 1, sites: 2 })] });
  });

  it('counts a pattern Stryker would make nothing of, and so errs towards saying that something is unread', () => {
    const [entry] = unmeasured('export const found = /b/.exec(process.title) as RegExpExecArray;', parse).hidden;
    expect(entry).toMatchObject({ line: 1, sites: 1, text: '/b/.exec(process.title) as RegExpExecArray' });
  });

  it('shortens a long expression to its two ends', () => {
    const table = `export const T = { ${Array.from({ length: 30 }, (_, at) => `k${at}: ${at}`).join(', ')} } as const;`;
    const [entry] = unmeasured(table, parse).hidden;
    expect(entry!.text).toHaveLength(64 + 5 + 28);
    expect(entry!.text.startsWith('{ k0: 0, k1: 1,')).toBe(true);
    expect(entry!.text.endsWith('k29: 29 } as const')).toBe(true);
  });
});

describe('the count, held to the Stryker installed', () => {
  it('is of places Stryker makes no mutant at', async () => {
    const made = await (await instrumenter())(WRITTEN);
    // Were this to fail, Stryker reads under a cast now, and the script, its
    // step in the workflow and `LEFT` have nothing left to say.
    for (const entry of unmeasured(WRITTEN, parse).hidden) expect(made.filter((mutant) => under(mutant, entry))).toEqual([]);
    expect(made.length).toBeGreaterThan(0);
  });

  it('is of exactly the places Stryker mutates once the casts are taken away', async () => {
    const instrument = await instrumenter();
    const written = await instrument(WRITTEN);
    const uncast = await instrument(UNCAST);
    const { hidden } = unmeasured(WRITTEN, parse);

    for (const entry of hidden) {
      const places = new Set(uncast.filter((mutant) => under(mutant, entry)).map(place));
      expect([entry.line, places.size], [...places].join(' ')).toEqual([entry.line, entry.sites]);
    }
    // Every mutant the casts had kept from being made is at one of those
    // places: none was behind a cast the script counted nothing under.
    const freed = uncast.filter((mutant) => hidden.some((entry) => under(mutant, entry)));
    expect(uncast.length - written.length).toBe(freed.length);
    // A site is a place and not a mutant: Stryker makes more than one of some.
    expect(freed.length).toBeGreaterThan(hidden.reduce((sum, entry) => sum + entry.sites, 0));
  });

  it('is of the places Stryker mutates for a written key and for a type inside the expression, which are none', async () => {
    const instrument = await instrumenter();
    for (const [source, sites] of MORE) {
      const read = unmeasured(source, parse);
      expect(read.hidden.map((entry) => entry.sites), source).toEqual([sites]);
      const [entry] = read.hidden;
      expect((await instrument(source)).filter((mutant) => under(mutant, entry!)), source).toEqual([]);
      const uncast = await instrument(source.replace(CAST, (cast) => ' '.repeat(cast.length)));
      expect(new Set(uncast.filter((mutant) => under(mutant, entry!)).map(place)).size, source).toBe(sites);
    }
  });
});

describe('the gate', () => {
  const written = (): ReturnType<typeof measure> => measure({ 'src/written.ts': WRITTEN, 'src/plain.ts': UNCAST }, parse);

  it('fails a count above what is recorded as left, and names every expression', () => {
    const measured = written();
    expect(measured.sites).toBe(TOTAL);
    const over = verdict(measured, TOTAL - 1);
    expect(over.passed).toBe(false);
    expect(over.message).toBe(
      `${TOTAL} under an \`as\`, and ${TOTAL - 1} recorded as left: the sweep does not mutate the 1 more. Put each cast on a name, or use \`!\`, \`satisfies\` or \`literal()\` (ADR-0003, amended 2026-10-12).`,
    );
    expect(over.lines[0]).toBe(`2 sources, 11 \`as\` expressions and enums, outermost only; 9 of them stand over ${TOTAL} places a mutator applies.`);
    // The most first, so the table that hides the most is the first read.
    expect(over.lines.slice(1, 3)).toEqual([
      "    9  src/written.ts:8  list.filter((item) => item !== '' && !item.startsWith('#')).sort()[0]/*<*/ as string",
      "    7  src/written.ts:12  (() => { if (kind) { held.a.trim(); } for (;;) { throw new Error('x'); } })/*<*/ as () => void",
    ]);
    expect(over.lines).toHaveLength(1 + COUNTED.length);
  });

  it('passes a count that is what is left, or under it', () => {
    const at = verdict(written(), TOTAL);
    expect(at.passed).toBe(true);
    expect(at.message).toBe(`${TOTAL} under an \`as\`, and ${TOTAL} recorded as left.`);
    expect(verdict(written(), TOTAL + 1).passed).toBe(true);
    expect(verdict(measure({ 'src/plain.ts': UNCAST }, parse), 0)).toEqual({
      passed: true,
      lines: ['1 sources, 0 `as` expressions and enums, outermost only; 0 of them stand over 0 places a mutator applies.'],
      message: '0 under an `as`, and 0 recorded as left.',
    });
  });

  it('says of a report whether it has a mutant under a cast, which would end what the count is for', () => {
    const mutant = (line: number, column: number): Report['files'][string]['mutants'][number] => ({
      id: '0',
      status: 'Killed',
      mutatorName: 'ArithmeticOperator',
      location: { start: { line, column }, end: { line, column: column + 16 } },
    });
    const report = (mutants: Report['files'][string]['mutants']): Report => ({ files: { 'src/written.ts': { source: WRITTEN, mutants }, 'src/plain.ts': { source: UNCAST, mutants: [] } } });
    // `words.length - 1` on line 4 is under the cast; the same span a line
    // down is not under one.
    expect(verdict(written(), TOTAL, report([mutant(5, 21)])).lines[1]).toBe('The report has 0 mutants of those places.');
    // On the cast's own line, one that starts before the cast or ends after
    // it is beside it: the cast runs from column 15 to column 53.
    expect(verdict(written(), TOTAL, report([mutant(4, 1), mutant(4, 45)])).lines[1]).toBe('The report has 0 mutants of those places.');
    expect(verdict(written(), TOTAL, report([mutant(4, 21)])).lines[1]).toBe(
      'The report has 1 mutant of those places: Stryker reads under an `as` now, and this count is of something else than it was written for.',
    );
  });

  it('refuses a source Stryker could not have parsed, by name', () => {
    expect(() => measure({ 'src/plain.ts': UNCAST, 'src/broken.ts': 'export const = ;' }, parse)).toThrow(
      /^src\/broken\.ts could not be parsed, so what stands under an `as` in it was not counted: /,
    );
  });

  it('refuses to measure where the parser Stryker brings is not installed', async () => {
    const elsewhere = pathToFileURL(path.join(path.parse(PROJECT_ROOT).root, 'nowhere', 'scripts', 'mutation-unmeasured.mjs')).href;
    await expect(loadParser(elsewhere)).rejects.toThrow(
      'Cannot find @stryker-mutator/core, on the way to the parser Stryker reads a source with (@stryker-mutator/core, then @stryker-mutator/instrumenter, then @babel/core, then @babel/parser). Nothing was measured',
    );
  });
});

describe('this repository', () => {
  const said: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    said.length = 0;
  });
  const listen = (): void => {
    vi.spyOn(console, 'log').mockImplementation((line: string) => void said.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void said.push(line));
  };

  it('keeps no more under an `as` than it records as left', async () => {
    const { default: stryker } = (await import(pathToFileURL(path.join(PROJECT_ROOT, 'stryker.config.mjs')).href)) as { default: { mutate: string[] } };
    const sources = treeSources(stryker.mutate, PROJECT_ROOT);
    // What a sweep mutates: this repository's own files, and not spec-core's copy.
    expect(Object.keys(sources)).toContain('src/reporter.ts');
    expect(Object.keys(sources).filter((file) => file.startsWith('src/vendor/') || file === 'src/types.ts')).toEqual([]);
    const result = verdict(measure(sources, parse));
    expect(result.passed, [result.message, ...result.lines].join('\n')).toBe(true);
    expect(LEFT).toBe(0);
  });

  it("fails the sweep's score step for a merged report with more than that, and passes one without", async () => {
    const entry = (source: string): Report['files'][string] => ({ language: 'typescript', source, mutants: [] });
    // A report is read and the summary appended through what the run is
    // handed, so nothing here is written to disk.
    const reports: Record<string, string> = {
      'over.json': JSON.stringify({ files: { 'src/written.ts': entry(WRITTEN) } }),
      'within.json': JSON.stringify({ files: { 'src/plain.ts': entry(UNCAST) } }),
    };
    const summary: [string, string][] = [];
    const io = { read: (file: string) => reports[file]!, append: (file: string, text: string) => void summary.push([file, text]) };
    listen();
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_STEP_SUMMARY', 'summary.md');

    expect(await main(['over.json'], io)).toBe(1);
    expect(said.at(-1)).toMatch(new RegExp(`^::error::${TOTAL} under an \`as\`, and 0 recorded as left: the sweep does not mutate the ${TOTAL} more\\. `));
    expect(said[0]).toContain('The report has 0 mutants of those places.');

    expect(await main(['within.json'], io)).toBe(0);
    expect(said.at(-1)).toBe('0 under an `as`, and 0 recorded as left.');
    expect(summary).toEqual([
      ['summary.md', expect.stringMatching(new RegExp(`^What the sweep does not read: ${TOTAL} under an \`as\`, and 0 recorded as left: .*\\n\\n$`))],
      ['summary.md', 'What the sweep does not read: 0 under an `as`, and 0 recorded as left.\n\n'],
    ]);

    // One report or none: anything else is a usage error, and reads nothing.
    expect(await main(['--report', 'x'], io)).toBe(2);
    expect(await main(['-x'], io)).toBe(2);
    expect(await main(['over.json', 'within.json'], io)).toBe(2);
    expect(said.at(-1)).toMatch(/^usage: node scripts\/mutation-unmeasured\.mjs /);
    expect(summary).toHaveLength(2);
  });

  it('writes no summary where no job asks for one, and marks no line for a run outside one', async () => {
    const summary: string[] = [];
    const io = { read: () => JSON.stringify({ files: { 'src/written.ts': { language: 'typescript', source: WRITTEN, mutants: [] } } }), append: (_file: string, text: string) => void summary.push(text) };
    listen();
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    expect(await main(['over.json'], io)).toBe(1);
    expect(said.at(-1)).toMatch(new RegExp(`^${TOTAL} under an \`as\`, and 0 recorded as left: `));
    expect(summary).toEqual([]);
  });

  it("runs in the sweep's score job, on the merged report, and is left out of a mutation run", () => {
    const workflow = readFileSync(path.join(PROJECT_ROOT, '.github/workflows/mutation.yml'), 'utf8');
    const score = workflow.slice(workflow.indexOf('\n  score:'));
    const merge = score.indexOf('run: node scripts/mutation-shards.mjs merge reports/shards');
    const count = score.indexOf('run: node scripts/mutation-unmeasured.mjs reports/mutation/mutation.json');
    expect(merge).toBeGreaterThan(-1);
    // After the merge, which writes the report it reads.
    expect(count).toBeGreaterThan(merge);
    expect(mutationSuite.test?.exclude).toContain('tests/mutation-unmeasured.test.ts');
  });
});
