/**
 * Reading the spec documents: which files, what each declares, and whether it
 * is in force.
 *
 * These lived in query.test.ts, because the query was the second consumer that
 * made `readSpecs` a module of its own. They are here because ADR-0013 asserts
 * every module has a test file of its own name, and the first thing that rule
 * found was this module without one.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readSpecs, specPath } from '../src/specs.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

let root: string;

const ADR = [
  '---',
  'title: not this one',
  '---',
  '',
  '# ADR-0007: Layers and a legacy client ##',
  '',
  '## Status',
  '',
  'Accepted (0.7.0)',
  '',
  '<!-- @assert-layers target="src" order="src/domain, src/app, src/infra" baseline="src/domain/bad.ts" reason="dependencies point inward" -->',
  '<!-- @assert-absence target="src" symbol="LegacyClient" baseline="src/app/old.ts:2" -->',
  '<!-- @assert-layers target="src" order="src, src/app" allow-empty -->',
  '',
].join('\n');

const DRAFT = ['# ADR-0008: Clocks', '', '**Status:** Proposed by the platform team', '', '<!-- @assert-absence target="src/domain" symbol="Date.now" -->', ''].join('\n');
const UNTITLED = 'No heading.\n\n<!-- @assert-present file="src/domain/user.ts" reason="the aggregate root" -->\n<!-- @assert-count symbol="X" -->\n';

beforeAll(async () => {
  root = await makeTempRepo({
    'docs/adr/0007-layers.md': ADR,
    'docs/adr/0008-clocks.md': DRAFT,
    'docs/untitled.md': UNTITLED,
  });
});

afterAll(async () => {
  await removeTempRepo(root);
});

describe('reading the specs', () => {
  it('reads every document in file order, with its title, status and whether it is in force', async () => {
    const specs = await readSpecs(['docs/**/*.md'], root);
    expect(specs.errors).toEqual([]);
    expect(specs.files).toEqual([
      path.join(root, 'docs/adr/0007-layers.md'),
      path.join(root, 'docs/adr/0008-clocks.md'),
      path.join(root, 'docs/untitled.md'),
    ]);
    expect(
      specs.documents.map((document) => [document.relativeFile, document.title, document.status?.value, document.inForce, document.directives.length]),
    ).toEqual([
      ['docs/adr/0007-layers.md', 'ADR-0007: Layers and a legacy client', 'accepted', true, 3],
      ['docs/adr/0008-clocks.md', 'ADR-0008: Clocks', 'proposed', false, 1],
      ['docs/untitled.md', undefined, undefined, true, 2],
    ]);
    expect(specs.documents[2]).not.toHaveProperty('title');
    expect(specs.documents[2]).not.toHaveProperty('status');
  });

  it('reads many specs together, but never more than 16 at once', async () => {
    // The bound is what stands between 1,200 ADRs and EMFILE, and reading them
    // all at once gives the same documents - so it is counted, not inferred.
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`docs/many/${String(index).padStart(2, '0')}.md`, `# Spec ${index}\n`]));
    const tree = await makeTempRepo(files);
    const real = fsp.readFile.bind(fsp);
    let inFlight = 0;
    let most = 0;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await real(...args);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fsp.readFile);
    try {
      const specs = await readSpecs(['docs/**/*.md'], tree);
      expect(specs.documents.map((document) => document.title)).toEqual(Array.from({ length: 40 }, (_, index) => `Spec ${index}`));
      expect(most).toBe(16);
    } finally {
      spy.mockRestore();
      await removeTempRepo(tree);
    }
  });
});

describe('specPath', () => {
  it('is the path from the root with forward slashes, and the whole path where there is no relative one', () => {
    expect(specPath(root, path.join(root, 'docs', 'adr', 'x.md'))).toBe('docs/adr/x.md');
    expect(specPath(path.join(root, 'docs'), path.join(root, 'README.md'))).toBe('../README.md');
    // The root itself is the one path `path.relative` makes empty.
    expect(specPath(root, root)).toBe(root.replace(/\\/g, '/'));
  });
});
