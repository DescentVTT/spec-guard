/**
 * The silent false green.
 *
 * spec-guard 0.3.0 would report a clean pass on a repository that contained the
 * forbidden symbol, in several independent ways at once. On a tree with eight
 * copies of a token, the scanner found two and ripgrep found four, and neither
 * said a word about the rest:
 *
 *   .github/workflows/ci.yml   both engines skipped hidden directories
 *   .husky/pre-commit          - which is where CI config and hooks live
 *   .hidden.ts
 *   dist/d.ts                  the scanner skipped a hardcoded name list;
 *   node_modules/pkg/e.ts      ripgrep did not, so the two disagreed
 *   ignored/c.ts               ripgrep honoured .gitignore, and only inside a
 *                              git repository, so the same tree answered
 *                              differently depending on where it sat
 *   blob.dat                   binary: skipped by one engine, searched by the
 *                              other, decided by an attribute about comments
 *
 * Every case below is one of those, kept as a test because a guard dog that
 * reports "clean" about a place it never looked is worse than no guard at all.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { javascriptEngine, resolveEngine, type SearchRequest } from '../src/engine.js';
import { walkFiles } from '../src/glob.js';
import { runSpecGuard } from '../src/runner.js';
import { SCAN_EVERYTHING } from '../src/scope.js';
import type { SearchResult } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo, searchOptions } from './helpers.js';

const rgPath = findTestRipgrep();
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const TOKEN = 'ForbiddenToken';

function request(root: string, overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { root, symbol: TOKEN, targets: ['.'], options: searchOptions(), ...overrides };
}

/** The parts of a result that decide whether an assertion passes. */
function verdict(result: SearchResult) {
  return {
    count: result.count,
    files: result.matches.map((match) => match.file),
    skipped: result.scope.skipped,
  };
}

/**
 * A tree with one copy of the token in each place spec-guard used to be blind.
 * `.gitignore` is real: ripgrep obeys it unless told not to.
 */
const BLIND_SPOT_TREE: Record<string, string | Buffer> = {
  '.github/workflows/ci.yml': `run: echo ${TOKEN}\n`,
  '.husky/pre-commit': `#!/bin/sh\necho ${TOKEN}\n`,
  '.claude-rules/policy.md': `Never use ${TOKEN}.\n`,
  '.hidden.ts': `export const a = '${TOKEN}';\n`,
  'ignored/c.ts': `export const c = '${TOKEN}';\n`,
  'dist/d.ts': `export const d = '${TOKEN}';\n`,
  'src/a.ts': `export const e = '${TOKEN}';\n`,
  '.gitignore': 'ignored/\ndist/\n',
};

describe('paths that used to be invisible', () => {
  it.each([
    ['.github/workflows/ci.yml', 'a workflow file'],
    ['.husky/pre-commit', 'a git hook'],
    ['.claude-rules/policy.md', 'an agent rule file'],
    ['.hidden.ts', 'a dotfile at the root'],
    ['dist/d.ts', 'a build output directory'],
    ['ignored/c.ts', 'a directory listed in .gitignore'],
  ])('finds the symbol in %s (%s)', async (file) => {
    const root = await repo(BLIND_SPOT_TREE);
    const result = await javascriptEngine.search(request(root));

    expect(result.matches.map((match) => match.file)).toContain(file);
  });

  it('finds every one of them, and says so through the CLI path', async () => {
    const root = await repo({
      ...BLIND_SPOT_TREE,
      'docs/adr.md': `<!-- @assert-absence target="." symbol="${TOKEN}" -->\n`,
    });
    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(false);
    // Seven planted copies; the spec file itself is excluded from its own search.
    expect(report.results[0]?.actual).toBe(7);
  });

  it('still skips the four directories that are not your code', async () => {
    const root = await repo({
      'node_modules/pkg/index.js': `const x = '${TOKEN}';\n`,
      '.git/objects/pack': `${TOKEN}\n`,
      'src/a.ts': 'clean\n',
    });
    const result = await javascriptEngine.search(request(root));

    expect(result.count).toBe(0);
  });

  it('searches even those when the run asks for certainty', async () => {
    const root = await repo({
      'node_modules/pkg/index.js': `const x = '${TOKEN}';\n`,
      'src/a.ts': 'clean\n',
    });
    const result = await javascriptEngine.search(
      request(root, { options: searchOptions({ scope: SCAN_EVERYTHING }) }),
    );

    expect(result.count).toBe(1);
  });
});

describe('files that cannot be read as text', () => {
  it('reports a match inside a binary file instead of dropping it', async () => {
    const root = await repo({
      'blob.dat': Buffer.concat([Buffer.from(TOKEN), Buffer.from([0, 1, 2])]),
      'src/a.ts': 'clean\n',
    });
    const result = await javascriptEngine.search(request(root));

    // Not counted - the bytes are not source - but not hidden either.
    expect(result.count).toBe(0);
    expect(result.scope.skipped).toEqual([{ path: 'blob.dat', reason: 'binary', matches: 1 }]);
  });

  it('says nothing about a binary file that did not match', async () => {
    // It was read and searched, so it is not a gap in the answer, and a line
    // about it on every run would bury the ones that matter.
    const root = await repo({ 'blob.dat': Buffer.from([0, 1, 2, 3]), 'src/a.ts': 'clean\n' });
    const result = await javascriptEngine.search(request(root));

    expect(result.scope.skipped).toEqual([]);
  });

  it('fails the run under --strict', async () => {
    const root = await repo({
      'blob.dat': Buffer.concat([Buffer.from(TOKEN), Buffer.from([0])]),
      'docs/adr.md': `<!-- @assert-absence target="." symbol="${TOKEN}" -->\n`,
    });

    const relaxed = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });
    expect(relaxed.ok).toBe(true);

    const strict = await runSpecGuard({
      patterns: ['docs/adr.md'],
      root,
      engine: 'javascript',
      strictTargets: true,
    });
    expect(strict.ok).toBe(false);
    expect(strict.results[0]?.message).toContain('could not be inspected');
  });
});

describe.skipIf(!rgPath)('the two engines are one implementation', () => {
  async function bothEngines(root: string, overrides: Partial<SearchRequest> = {}) {
    process.env.SPEC_GUARD_RG = rgPath as string;
    const ripgrep = await resolveEngine('ripgrep');
    const query = request(root, overrides);
    return {
      ripgrep: verdict(await ripgrep.search(query)),
      scanner: verdict(await javascriptEngine.search(query)),
    };
  }

  it('agrees on the tree that used to split them four ways', async () => {
    const root = await repo(BLIND_SPOT_TREE);
    const { ripgrep, scanner } = await bothEngines(root);

    expect(ripgrep).toEqual(scanner);
    expect(scanner.count).toBe(7);
  });

  it('agrees about binary files', async () => {
    const root = await repo({
      'blob.dat': Buffer.concat([Buffer.from(TOKEN), Buffer.from([0, 1])]),
      'src/a.ts': `const x = '${TOKEN}';\n`,
    });
    const { ripgrep, scanner } = await bothEngines(root);

    expect(ripgrep).toEqual(scanner);
    expect(scanner.skipped).toEqual([{ path: 'blob.dat', reason: 'binary', matches: 1 }]);
  });

  it('agrees when comments are counted, and when they are not', async () => {
    const root = await repo({ 'src/a.ts': `// ${TOKEN} was removed\nconst x = ${TOKEN};\n` });

    for (const ignoreComments of [true, false]) {
      const { ripgrep, scanner } = await bothEngines(root, {
        options: searchOptions({ ignoreComments }),
      });
      expect(ripgrep, `ignoreComments=${ignoreComments}`).toEqual(scanner);
    }
  });

  it('agrees about .gitignore, which neither of them obeys', async () => {
    // Not a matter of taste: ripgrep applies .gitignore only inside a git
    // repository, so obeying it made the answer depend on whether a .git
    // directory happened to exist somewhere above the target.
    const root = await repo({ '.gitignore': 'secret/\n', 'secret/a.ts': `const x = '${TOKEN}';\n` });
    const { ripgrep, scanner } = await bothEngines(root);

    expect(ripgrep).toEqual(scanner);
    expect(scanner.count).toBe(1);
  });

  it('agrees about the policy directories', async () => {
    const root = await repo({
      'node_modules/pkg/index.js': `const x = '${TOKEN}';\n`,
      '.git/config': `${TOKEN}\n`,
      'src/a.ts': `const x = '${TOKEN}';\n`,
    });
    const { ripgrep, scanner } = await bothEngines(root);

    expect(ripgrep).toEqual(scanner);
    expect(scanner.files).toEqual(['src/a.ts']);
  });

  it('agrees when the policy is turned off', async () => {
    const root = await repo({
      'node_modules/pkg/index.js': `const x = '${TOKEN}';\n`,
      'src/a.ts': `const x = '${TOKEN}';\n`,
    });
    const { ripgrep, scanner } = await bothEngines(root, {
      options: searchOptions({ scope: SCAN_EVERYTHING }),
    });

    expect(ripgrep).toEqual(scanner);
    expect(scanner.count).toBe(2);
  });

  it('agrees on a glob filter, which must not re-admit a skipped directory', async () => {
    const root = await repo({
      'node_modules/pkg/index.ts': `const x = '${TOKEN}';\n`,
      'src/a.ts': `const x = '${TOKEN}';\n`,
      'src/a.md': `${TOKEN}\n`,
    });
    const { ripgrep, scanner } = await bothEngines(root, {
      options: searchOptions({ globs: ['*.ts'] }),
    });

    expect(ripgrep).toEqual(scanner);
    expect(scanner.files).toEqual(['src/a.ts']);
  });

  it('agrees on an exclude pattern', async () => {
    const root = await repo({
      '.github/workflows/ci.yml': `${TOKEN}\n`,
      'src/a.ts': `const x = '${TOKEN}';\n`,
    });
    const { ripgrep, scanner } = await bothEngines(root, {
      options: searchOptions({ excludeGlobs: ['.github'] }),
    });

    expect(ripgrep).toEqual(scanner);
    expect(scanner.files).toEqual(['src/a.ts']);
  });
});

/**
 * Files that cannot be read at all.
 *
 * Awkward to arrange honestly - Windows ignores chmod and CI often runs as root
 * - so these use the seam the walker already exposes for testing: a directory
 * reader that reports entries which are not there. The failure it produces is
 * the real one, `fs.stat` and `fs.readFile` on a path that has vanished, which
 * is also what a permission denial looks like from here.
 */
describe('paths that cannot be read', () => {
  it('records a file that vanished between listing and reading', async () => {
    const root = await repo({ 'src/a.ts': 'clean\n' });

    const [result] = await javascriptEngine.searchFiles(
      [{ absolutePath: `${root}/src/gone.ts`, relativePath: 'src/gone.ts' }],
      [request(root)],
    );

    // Not "found nothing": we never looked, and the report has to say so.
    expect(result?.count).toBe(0);
    expect(result?.scope.skipped).toEqual([{ path: 'src/gone.ts', reason: 'unreadable' }]);
  });

  it('carries an unreadable path reported by ripgrep into the same ledger', async () => {
    const root = await repo({ 'src/a.ts': 'clean\n' });

    const [result] = await javascriptEngine.searchFiles([], [request(root)], ['src/locked.ts']);

    expect(result?.scope.skipped).toEqual([{ path: 'src/locked.ts', reason: 'unreadable' }]);
  });

  it('reports a file the walk could see but not stat', async () => {
    const root = await repo({ 'src/a.ts': 'clean\n' });
    const skipped: Array<[string, string]> = [];

    const found = [];
    for await (const file of walkFiles(root, {
      onSkip: (p, reason) => skipped.push([p, reason]),
      readDirectory: async (directory) =>
        directory === root
          ? ([{ name: 'phantom.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }] as never)
          : [],
    })) {
      found.push(file.relativePath);
    }

    expect(found).toEqual([]);
    expect(skipped).toEqual([['phantom.ts', 'unreadable']]);
  });

  it('reports a directory it could not list', async () => {
    const root = await repo({ 'src/a.ts': 'clean\n' });
    const skipped: Array<[string, string]> = [];

    const found = [];
    for await (const file of walkFiles(root, {
      onSkip: (p, reason) => skipped.push([p, reason]),
      readDirectory: async () => {
        throw new Error('EACCES');
      },
    })) {
      found.push(file.relativePath);
    }

    expect(found).toEqual([]);
    expect(skipped).toEqual([['.', 'unreadable']]);
  });
});
