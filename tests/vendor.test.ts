/**
 * The copy of spec-core under src/vendor/spec-core is spec-core's, byte for
 * byte.
 *
 * spec-core is copied into each tool rather than depended on, so that every
 * tool keeps `dependencies: {}` (spec-core ADR-0001). What a copy costs is that
 * it can be edited where it lies, and an edited glob engine is one the family
 * did not agree on and spec-core never measured: this repository leaves the
 * copy out of its own mutation sweep and coverage, on the strength of spec-core's.
 * VENDOR.json records the SHA-256 of every file as it was copied, and this file
 * recomputes them. The fix for a failure here is never an edit to VENDOR.json:
 * change spec-core, and copy again with its scripts/vendor.mjs. ADR-0015.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from './helpers.js';

const VENDOR = path.join(PROJECT_ROOT, 'src', 'vendor', 'spec-core');

interface VendorRecord {
  source: string;
  commit: string | null;
  modules: Record<string, { files: Record<string, string> }>;
}

const record = JSON.parse(readFileSync(path.join(VENDOR, 'VENDOR.json'), 'utf8')) as VendorRecord;

/** Every file the record names, as `module/file` with the hash it was copied with. */
const recorded = Object.entries(record.modules).flatMap(([module, { files }]) =>
  Object.entries(files).map(([file, hash]) => ({ file: `${module}/${file}`, hash })),
);

/** The hash in VENDOR.json's own form, which is spec-core's scripts/vendor.mjs's. */
function sha256(bytes: Buffer): string {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Every file under the copy, as a path relative to it. */
function copied(directory = VENDOR, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? copied(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

describe('the copy of spec-core', () => {
  it('names the commit it was copied from', () => {
    // A copy made from a spec-core with uncommitted changes records no commit,
    // and then nobody can say which spec-core this tool runs.
    expect(record.source).toBe('https://github.com/DescentVTT/spec-core');
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds the modules this tool reads, and the one they read', () => {
    // pattern for every glob, and path because pattern imports it. jsonrpc was
    // copied for the MCP server and is not yet read by it: ADR-0015 says why.
    expect(Object.keys(record.modules)).toEqual(['jsonrpc', 'path', 'pattern']);
  });

  it.each(recorded)('$file is the file that was copied', ({ file, hash }) => {
    expect(sha256(readFileSync(path.join(VENDOR, file)))).toBe(hash);
  });

  it('holds nothing the record does not account for', () => {
    // A file added beside the copies would be compiled and shipped, and belong
    // to neither repository.
    const expected = ['README.md', 'VENDOR.json', ...recorded.map(({ file }) => file)].sort();
    expect(copied().sort()).toEqual(expected);
  });

  it('notices a copy edited in place', () => {
    // The check is only worth something if a changed byte changes the answer.
    // A carriage return is the edit most likely to happen by accident: a
    // checkout that ignores .gitattributes.
    const [first] = recorded;
    const bytes = readFileSync(path.join(VENDOR, (first as { file: string }).file));
    const edited = Buffer.from(bytes.toString('utf8').replace('\n', '\r\n'), 'utf8');
    expect(sha256(edited)).not.toBe((first as { hash: string }).hash);
  });

  it('imports nothing outside itself', () => {
    // spec-core promises that no module reads the disk, the clock or the
    // environment (its ADR-0002), which is what lets this repository's own
    // rules about node:fs and processes hold for a copy it did not write.
    let imports = 0;
    for (const { file } of recorded) {
      const source = readFileSync(path.join(VENDOR, file), 'utf8');
      for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^'"]*?from ['"]([^'"]+)['"]/gm)) {
        imports += 1;
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\//);
        const resolved = path.resolve(path.dirname(path.join(VENDOR, file)), specifier as string);
        expect(resolved.startsWith(VENDOR + path.sep), `${file} imports ${specifier}`).toBe(true);
      }
    }
    // Every index re-exports, so a reading that found none has stopped reading.
    expect(imports).toBeGreaterThan(recorded.length / 2);
  });
});
