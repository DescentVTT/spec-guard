/**
 * Comment-aware searching, at the engine and runner level.
 *
 * The classifier itself is covered in comments.test.ts. What matters here is
 * that both engines reach the same answer through it, that the exclusion is
 * reported rather than silently applied, and that a single assertion is treated
 * exactly like a batched one - a real bug lived in that gap, because only the
 * batch path had been made comment-aware.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { javascriptEngine, resolveEngine, runSearches, type SearchRequest } from '../src/engine.js';
import { runSpecGuard } from '../src/runner.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** One comment mention, one real use, in two different files. */
const MIXED_SOURCES = {
  'src/note.ts': '// LegacyThing was removed in ADR-398\nexport const ok = true;\n',
  'src/use.ts': 'export const value = LegacyThing;\n',
};

function request(root: string, symbol: string, ignoreComments: boolean): SearchRequest {
  return {
    root,
    symbol,
    targets: ['src'],
    options: searchOptions({ ignoreComments }),
  };
}

describe('the javascript engine', () => {
  it('counts code and reports what it left in comments', async () => {
    const root = await repo(MIXED_SOURCES);
    const result = await javascriptEngine.search(request(root, 'LegacyThing', true));

    expect(result.count).toBe(1);
    expect(result.commentMatches).toBe(1);
    expect(result.matches.map((match) => match.file)).toEqual(['src/use.ts']);
  });

  it('counts everything when comments are included', async () => {
    const root = await repo(MIXED_SOURCES);
    const result = await javascriptEngine.search(request(root, 'LegacyThing', false));

    expect(result.count).toBe(2);
    expect(result.commentMatches).toBe(0);
    expect(result.matches.map((match) => match.file)).toEqual(['src/note.ts', 'src/use.ts']);
  });

  it('counts a match in an unknown language, and says it could not classify it', async () => {
    const root = await repo({ 'src/notes.unknownext': 'LegacyThing lives on here\n' });
    const result = await javascriptEngine.search(request(root, 'LegacyThing', true));

    // The conservative direction: an unreadable file's matches all count.
    expect(result.count).toBe(1);
    expect(result.unclassifiedFiles).toBe(1);
  });

  it('does not blame files that never matched', async () => {
    const root = await repo({
      'src/use.ts': 'export const value = LegacyThing;\n',
      'src/data.unknownext': 'nothing of interest\n',
      'src/more.unknownext': 'also nothing\n',
    });
    const result = await javascriptEngine.search(request(root, 'LegacyThing', true));

    expect(result.count).toBe(1);
    // Two unknown files were read; neither matched, so neither is a caveat.
    expect(result.unclassifiedFiles).toBe(0);
  });

  it('leaves the count alone when a language has no comments to find', async () => {
    const root = await repo({ 'src/use.ts': 'export const value = LegacyThing;\n' });
    const result = await javascriptEngine.search(request(root, 'LegacyThing', true));

    expect(result.count).toBe(1);
    expect(result.commentMatches).toBe(0);
    expect(result.unclassifiedFiles).toBe(0);
  });
});

describe.skipIf(!rgPath)('ripgrep parity', () => {
  it('answers a single search the same way as the scanner', async () => {
    // The regression: searchBatch was comment-aware and search() was not, so a
    // spec with exactly one assertion silently kept its comment matches.
    const root = await repo(MIXED_SOURCES);
    process.env.SPEC_GUARD_RG = rgPath as string;
    const ripgrep = await resolveEngine('ripgrep');

    const viaRipgrep = await ripgrep.search(request(root, 'LegacyThing', true));
    const viaScanner = await javascriptEngine.search(request(root, 'LegacyThing', true));

    expect(viaRipgrep.count).toBe(1);
    expect(viaRipgrep.count).toBe(viaScanner.count);
    expect(viaRipgrep.commentMatches).toBe(viaScanner.commentMatches);
    expect(viaRipgrep.matches).toEqual(viaScanner.matches);
    // ripgrep did the searching, so that is what the result says.
    expect(viaRipgrep.engine).toBe('ripgrep');
  });

  it('answers a batch the same way as the scanner', async () => {
    const root = await repo({
      ...MIXED_SOURCES,
      'src/other.ts': '/* Widget is only mentioned here */\nexport const Gadget = 1;\n',
    });
    process.env.SPEC_GUARD_RG = rgPath as string;
    const ripgrep = await resolveEngine('ripgrep');

    const requests = ['LegacyThing', 'Widget', 'Gadget'].map((symbol) => request(root, symbol, true));
    const viaRipgrep = await runSearches(ripgrep, requests);
    const viaScanner = await runSearches(javascriptEngine, requests);

    expect(viaRipgrep.map((result) => result.count)).toEqual([1, 0, 1]);
    expect(viaRipgrep.map((result) => result.count)).toEqual(viaScanner.map((result) => result.count));
    expect(viaRipgrep.map((result) => result.commentMatches)).toEqual([1, 1, 0]);
    expect(viaRipgrep.map((result) => result.matches)).toEqual(viaScanner.map((result) => result.matches));
  });

  it('still agrees when comments are counted', async () => {
    const root = await repo(MIXED_SOURCES);
    process.env.SPEC_GUARD_RG = rgPath as string;
    const ripgrep = await resolveEngine('ripgrep');

    const viaRipgrep = await ripgrep.search(request(root, 'LegacyThing', false));
    const viaScanner = await javascriptEngine.search(request(root, 'LegacyThing', false));

    expect(viaRipgrep.count).toBe(2);
    expect(viaRipgrep.matches).toEqual(viaScanner.matches);
  });
});

describe('the comments attribute', () => {
  const spec = (attribute: string): string =>
    `<!-- @assert-absence target="src" symbol="LegacyThing"${attribute} -->\nGone.\n`;

  it('ignores comments by default, so the note about a removal is not the removal', async () => {
    const root = await repo({ ...MIXED_SOURCES, 'docs/adr.md': spec('') });
    const report = await runSpecGuard({ root, patterns: ['docs/*.md'], engine: 'javascript' });

    const [result] = report.results;
    expect(result?.actual).toBe(1);
    expect(result?.commentMatches).toBe(1);
  });

  it('counts them back in on request', async () => {
    const root = await repo({ ...MIXED_SOURCES, 'docs/adr.md': spec(' comments="include"') });
    const report = await runSpecGuard({ root, patterns: ['docs/*.md'], engine: 'javascript' });

    const [result] = report.results;
    expect(result?.actual).toBe(2);
    expect(result?.commentMatches).toBe(0);
  });

  it('passes an assertion that only a comment would have broken', async () => {
    const root = await repo({
      'src/note.ts': '// LegacyThing was removed in ADR-398\n',
      'docs/adr.md': spec(''),
    });
    const report = await runSpecGuard({ root, patterns: ['docs/*.md'], engine: 'javascript' });

    expect(report.ok).toBe(true);
    expect(report.results[0]?.commentMatches).toBe(1);
  });
});
