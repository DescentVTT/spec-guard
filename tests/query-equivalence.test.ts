/**
 * The claim `spec-guard query` rests on: arithmetic on a rule's scope agrees
 * with the walk the rule really makes.
 *
 * Nothing here trusts a model of the walk. Every file in the tree carries a
 * marker a rule can find - the text `MARK`, an import of `mark` in its own
 * language, an import of itself - so a real run reports exactly the files it
 * looked at: every searched file matches the text rule, every read file matches
 * the import rule, and every file in the import graph closes a cycle on itself.
 * The governed set has to equal that, file for file, under both engines.
 *
 * Directories are held to the direction that matters. A query may say a
 * directory is governed when a glob or a language filter leaves nothing in it
 * - the rule is shown with those filters - but it must never say a directory is
 * not governed while the run reads a file inside it.
 */

import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRuleSet } from '../src/query.js';
import { governs, type QueryPath } from '../src/rules.js';
import { runSpecGuard } from '../src/runner.js';
import type { AssertionResult } from '../src/types.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

const JS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** A file whose every way of being seen by a rule is visible in the report. */
function marked(relative: string): string {
  const extension = path.posix.extname(relative);
  const self = `./${path.posix.basename(relative)}`;
  if (JS.has(extension)) return `import 'mark';\nimport '${self}';\n// MARK\n`;
  if (extension === '.py') return 'import mark\n# MARK\n';
  if (extension === '.go') return 'package x\n\nimport "mark"\n\n// MARK\n';
  if (extension === '.rs') return 'use mark;\n// MARK\n';
  if (extension === '.cs') return 'using mark;\n// MARK\n';
  return 'MARK\n';
}

/** Every directory a list of files implies, the root included. */
function directoriesOf(files: readonly string[]): string[] {
  const directories = new Set<string>(['.']);
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  return [...directories].sort();
}

/**
 * The files a finished run looked at, read off its report - or, for a rule
 * about directories, the directories it held to their entries.
 *
 * A structure rule reads no contents, so its marker is its claim: a pattern no
 * name matches, a partner no file has and an entry no directory holds make
 * every subject in scope a violation, and the violations are the scope.
 */
function observed(result: AssertionResult): string[] {
  if (result.kind === 'assert-import-cycle') return result.matches.map((match) => match.file).sort();
  return result.fileMatches.map((entry) => entry.file).sort();
}

/** A file that does not exist: asking about one is asking about its directory. */
const PROBE = 'probe-that-is-not-there';

async function compare(files: readonly string[], directives: readonly string[], engine: 'javascript' | 'ripgrep'): Promise<number> {
  const tree: Record<string, string> = Object.fromEntries(files.map((file) => [file, marked(file)]));
  tree['docs/rules.md'] = `${directives.join('\n')}\n`;
  const root = await makeTempRepo(tree);
  temporary.push(root);
  const all = [...files, 'docs/rules.md'];

  const ruleSet = await loadRuleSet({ patterns: ['docs/rules.md'], root });
  expect(ruleSet.errors).toEqual([]);
  const report = await runSpecGuard({
    patterns: ['docs/rules.md'],
    root,
    engine,
    allowMissingTargets: true,
    allowEmptyScope: true,
    maxSnippets: 100_000,
  });
  expect(report.errors).toEqual([]);
  expect(report.warnings).toEqual([]);

  let checked = 0;
  for (const { assertion } of ruleSet.rules) {
    const result = report.results.find((candidate) => candidate.location.line === assertion.location.line) as AssertionResult;
    const seen = observed(result);
    const query = (relative: string, shape: QueryPath['shape']): QueryPath => ({ path: relative, shape, absolutePath: path.resolve(root, relative) });

    const governed =
      assertion.structure?.claim === 'required'
        ? directoriesOf(all).filter((directory) => governs(assertion, query(path.posix.join(directory, PROBE), 'file')))
        : all.filter((file) => governs(assertion, query(file, 'file'))).sort();
    expect(governed, `${engine}: ${assertion.description}`).toEqual(seen);

    for (const directory of directoriesOf(all)) {
      const holdsASeenFile = seen.some((file) => directory === '.' || file === directory || file.startsWith(`${directory}/`));
      if (holdsASeenFile) expect(governs(assertion, query(directory, 'directory')), `${engine}: ${assertion.description} on ${directory}/`).toBe(true);
    }
    checked += 1;
  }
  return checked;
}

const TREE = [
  'README.md',
  'package.json',
  'src/index.ts',
  'src/app.tsx',
  'src/util.mjs',
  'src/model.py',
  'src/styles.css',
  'src/deep/nested/core.ts',
  'src/deep/nested/core.test.ts',
  'src/legacy/old.ts',
  'src/legacy/old.go',
  'src/tests/helper.ts',
  'src/node_modules/vendored/index.js',
  'src/.git/HEAD',
  'src2/other.ts',
  'lib/server.go',
  'lib/client.rs',
  'lib/Program.cs',
  'lib/node_modules',
  'node_modules/pkg/index.js',
  'node_modules/pkg/node_modules/dep/index.js',
  'docs/guide.md',
  'docs/notes.txt',
];

const DIRECTIVES = [
  '<!-- @assert-absence symbol="MARK" comments="include" -->',
  '<!-- @assert-absence target="src" symbol="MARK" comments="include" -->',
  '<!-- @assert-absence target="src, lib" symbol="MARK" comments="include" exclude="tests legacy" -->',
  '<!-- @assert-absence target="src" symbol="MARK" comments="include" exclude="src/deep/**/*.test.ts" glob="*.ts" -->',
  '<!-- @assert-absence symbol="MARK" comments="include" glob="src/*.ts" -->',
  '<!-- @assert-absence target="src/index.ts, docs" symbol="MARK" comments="include" -->',
  '<!-- @assert-absence target="node_modules/pkg" symbol="MARK" comments="include" -->',
  '<!-- @assert-absence target="missing, src/deep" symbol="MARK" comments="include" -->',
  '<!-- @assert-count target="docs" symbol="MARK" comments="include" min="1" -->',
  '<!-- @assert-import-absence module="mark" -->',
  '<!-- @assert-import-absence target="src" module="mark" exclude="legacy" -->',
  '<!-- @assert-import-count target="lib, src/legacy" module="mark" max="0" -->',
  '<!-- @assert-import-cycle max="0" -->',
  '<!-- @assert-import-cycle target="src" exclude="src/deep" max="0" -->',
  '<!-- @assert-structure pattern="NONE" -->',
  '<!-- @assert-structure target="src, lib" glob="*.ts, *.go" exclude="legacy" pattern="NONE" -->',
  '<!-- @assert-structure target="docs, src/index.ts" pattern="NONE" -->',
  '<!-- @assert-structure target="src/index.ts, src/app.tsx, lib" exclude="index.ts" pattern="NONE" -->',
  '<!-- @assert-structure target="src" exclude="src/deep/**/*.test.ts" partner="[name].none" -->',
  '<!-- @assert-structure target="node_modules/pkg, missing" partner="tests/[dir]/[name].none" -->',
  '<!-- @assert-structure required="NONE" -->',
  '<!-- @assert-structure target="src, lib" required="NONE" -->',
  '<!-- @assert-structure target="src" dirs="*" required="NONE" -->',
  '<!-- @assert-structure target="src, lib" dirs="**" exclude="legacy" required="NONE" -->',
  '<!-- @assert-structure dirs="*/node_modules" required="NONE" -->',
  '<!-- @assert-structure target="node_modules" dirs="**" exclude="dep" required="NONE" -->',
];

describe('a query against the walk it stands in for', () => {
  it('governs exactly the files the JavaScript engine searches, reads and graphs', async () => {
    expect(await compare(TREE, DIRECTIVES, 'javascript')).toBe(DIRECTIVES.length);
  });

  it.skipIf(findTestRipgrep() === null)('governs exactly the files ripgrep searches', async () => {
    const previous = process.env.SPEC_GUARD_RG;
    process.env.SPEC_GUARD_RG = findTestRipgrep() as string;
    try {
      expect(await compare(TREE, DIRECTIVES, 'ripgrep')).toBe(DIRECTIVES.length);
    } finally {
      if (previous === undefined) delete process.env.SPEC_GUARD_RG;
      else process.env.SPEC_GUARD_RG = previous;
    }
  });

  it('holds over randomly generated trees and rules', async () => {
    let seed = 20260913;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;
    const segments = ['src', 'lib', 'app', 'tests', 'legacy', 'gen', 'node_modules', '.git', 'domain', 'web'];
    const names = ['a.ts', 'b.test.ts', 'c.py', 'd.go', 'e.css', 'f.md', 'g.mjs', 'h.rs', 'i.txt', 'j.tsx'];
    const excludes = ['tests', 'legacy', 'gen', 'src/legacy', '**/*.test.ts', '*.py', 'app/web', 'domain/**'];
    const globs = ['*.ts', '*.py', 'src/**', '*.{ts,py}', 'lib/*'];

    for (let round = 0; round < 8; round++) {
      const files = new Set<string>();
      for (let count = 0; count < 25; count++) {
        const depth = random(4);
        const parts = Array.from({ length: depth }, () => pick(segments));
        files.add([...parts, pick(names)].join('/'));
      }
      // A directory and a file may not share a path.
      const list = [...files].filter((file) => ![...files].some((other) => other.startsWith(`${file}/`)));

      const directives: string[] = [];
      for (let count = 0; count < 6; count++) {
        const targets = Array.from({ length: random(3) }, () => Array.from({ length: 1 + random(2) }, () => pick(segments)).join('/'));
        const target = targets.length > 0 ? ` target="${targets.join(', ')}"` : '';
        const exclude = random(2) === 0 ? ` exclude="${pick(excludes)}"` : '';
        const kind = random(5);
        const glob = random(2) === 0 ? ` glob="${pick(globs)}"` : '';
        if (kind === 0) {
          directives.push(`<!-- @assert-absence${target} symbol="MARK" comments="include"${exclude}${glob} -->`);
        } else if (kind === 1) {
          directives.push(`<!-- @assert-import-absence${target} module="mark"${exclude} -->`);
        } else if (kind === 2) {
          directives.push(`<!-- @assert-import-cycle${target}${exclude} max="0" -->`);
        } else if (kind === 3) {
          const claim = random(2) === 0 ? 'pattern="NONE"' : 'partner="tests/[dir]/[name].none"';
          directives.push(`<!-- @assert-structure${target}${exclude}${glob} ${claim} -->`);
        } else {
          const dirs = random(3) === 0 ? '' : ` dirs="${pick(['*', '**', '*/*', 'src', '**/web', 'lib/*'])}"`;
          directives.push(`<!-- @assert-structure${target}${exclude}${dirs} required="NONE" -->`);
        }
      }

      expect(await compare(list, directives, 'javascript')).toBe(directives.length);
    }
  });
});
