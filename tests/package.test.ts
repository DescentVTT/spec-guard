/**
 * The Markdown the package ships is read where the repository is not: on
 * npmjs.com, and in node_modules. A relative link there resolves against the
 * package, so a link to an ADR - which the package does not ship - leads
 * nowhere. Such a link is written as an absolute URL to the file on GitHub,
 * and a link to a file the package ships stays relative.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanMarkdown } from '../src/vendor/spec-core/markdown/index.js';
import { PROJECT_ROOT } from './helpers.js';

const text = (file: string): string => readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
const files = (JSON.parse(text('package.json')) as { files: string[] }).files;
/** An entry with a leading slash is anchored at the root, as npm reads it. */
const entries = files.map((entry) => entry.replace(/^\//, ''));
const ships = (file: string): boolean => entries.some((entry) => file === entry || file.startsWith(`${entry}/`));

/** Where an absolute link to a file of this repository points, on its main branch. */
const REPOSITORY = 'https://github.com/DescentVTT/spec-guard/blob/main/';

/**
 * The Markdown documents the package ships. `files` names the README
 * `/README.md`: npm reads a name with no slash at any depth, and a bare
 * `README.md` packed spec-core's vendored README beside its licence.
 */
const DOCUMENTS = ['README.md', 'CHANGELOG.md'];

/** Every link a renderer follows in a document, with the line it is on. */
function linksOf(document: string): Array<{ target: string; line: number }> {
  const source = text(document);
  // Read as a renderer reads it: a link shown in code, as the README does to
  // teach the syntax, is text there and never followed.
  return scanMarkdown(source).links.map(({ target, start }) => ({ target, line: source.slice(0, start).split('\n').length }));
}

describe('the documents the package ships', () => {
  it('are the ones it names in files, and no README of spec-core\'s', () => {
    expect(DOCUMENTS.filter((document) => !ships(document))).toEqual([]);
    expect(entries.filter((entry) => entry.endsWith('.md')).sort()).toEqual(['CHANGELOG.md', 'README.md']);
    expect(files).toContain('/README.md');
    expect(ships('src/vendor/spec-core/README.md')).toBe(false);
  });

  it('link to a file the package does not ship by absolute URL, so that the link works on npmjs.com and in node_modules', () => {
    const dead: string[] = [];
    for (const document of DOCUMENTS) {
      for (const { target, line } of linksOf(document)) {
        if (/^(?:[a-z][a-z+.-]*:|#)/i.test(target)) continue;
        const file = path.posix.join(path.posix.dirname(document), target.split('#')[0] as string);
        if (!ships(file) || !existsSync(path.join(PROJECT_ROOT, file))) dead.push(`${document}:${line} ${target}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('link by absolute URL only to files the repository holds', () => {
    // A link made absolute is no longer checked by anything that follows
    // relative links, so an ADR renamed would leave it dead on GitHub.
    const dead: string[] = [];
    const checked: string[] = [];
    for (const document of DOCUMENTS) {
      for (const { target, line } of linksOf(document)) {
        if (!target.startsWith(REPOSITORY)) continue;
        const file = decodeURI(target.slice(REPOSITORY.length).split('#')[0] as string);
        checked.push(file);
        if (!existsSync(path.join(PROJECT_ROOT, file))) dead.push(`${document}:${line} ${target}`);
      }
    }
    expect(dead).toEqual([]);
    // The ADRs the README and the changelog cite, and the release workflow.
    expect(checked.length).toBeGreaterThanOrEqual(60);
  });
});
