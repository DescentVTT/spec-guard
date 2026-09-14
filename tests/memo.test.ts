/**
 * Pure work, remembered by the bytes it came from. ADR-0014.
 *
 * What a memo can get wrong is which calls it treats as the same call. So each
 * test here is a pair: two calls that must share a result, beside two that
 * must not.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { createJavaScriptEngine } from '../src/engine.js';
import { createImportIndex } from '../src/imports.js';
import { contentHash, createMemo, NO_MEMO } from '../src/memo.js';
import { readSpecs } from '../src/specs.js';
import { memoryIo, searchOptions } from './helpers.js';

function counter(): { compute: () => number; calls: () => number } {
  let calls = 0;
  return {
    compute: () => {
      calls += 1;
      return calls;
    },
    calls: () => calls,
  };
}

describe('NO_MEMO', () => {
  it('computes every time, and hashes nothing a plain run would pay for', () => {
    const { compute, calls } = counter();
    const bytes = Buffer.from('same');
    expect(NO_MEMO.remember(bytes, ['a'], compute)).toBe(1);
    expect(NO_MEMO.remember(bytes, ['a'], compute)).toBe(2);
    expect(calls()).toBe(2);
  });
});

describe('contentHash', () => {
  it('is the SHA-256 of the bytes, in hex', () => {
    const bytes = Buffer.from('spec-guard');
    expect(contentHash(bytes)).toBe(createHash('sha256').update('spec-guard').digest('hex'));
  });

  it('is the same for equal bytes in different buffers, and different for different bytes', () => {
    expect(contentHash(Buffer.from('abc'))).toBe(contentHash(Buffer.from('abc')));
    expect(contentHash(Buffer.from('abc'))).not.toBe(contentHash(Buffer.from('abd')));
  });

  it('is taken once per buffer', () => {
    // A session never changes a buffer it has handed out, so a buffer is its
    // bytes. Changing one after hashing it is the only way to see that the
    // hash was remembered rather than taken again.
    const bytes = Buffer.from('a');
    const first = contentHash(bytes);
    bytes[0] = 0x62;
    expect(contentHash(bytes)).toBe(first);
    expect(contentHash(Buffer.from('b'))).not.toBe(first);
  });
});

describe('createMemo', () => {
  it('computes once for the same bytes and inputs, whichever buffer holds the bytes', () => {
    const memo = createMemo();
    const { compute, calls } = counter();
    expect(memo.remember(Buffer.from('x'), ['scan', 'a.ts'], compute)).toBe(1);
    expect(memo.remember(Buffer.from('x'), ['scan', 'a.ts'], compute)).toBe(1);
    expect(calls()).toBe(1);
    expect(memo.size).toBe(1);
  });

  it('computes again when the bytes or any input differ', () => {
    const memo = createMemo();
    const { compute, calls } = counter();
    memo.remember(Buffer.from('x'), ['scan', 'a.ts'], compute);
    expect(memo.remember(Buffer.from('y'), ['scan', 'a.ts'], compute)).toBe(2);
    expect(memo.remember(Buffer.from('x'), ['scan', 'b.ts'], compute)).toBe(3);
    expect(memo.remember(Buffer.from('x'), ['imports', 'a.ts'], compute)).toBe(4);
    expect(memo.remember(Buffer.from('x'), ['scan'], compute)).toBe(5);
    expect(calls()).toBe(5);
  });

  it('keeps inputs apart that a separator would run together', () => {
    const memo = createMemo();
    const { compute } = counter();
    expect(memo.remember(Buffer.from('x'), ['a,b'], compute)).toBe(1);
    expect(memo.remember(Buffer.from('x'), ['a', 'b'], compute)).toBe(2);
    expect(memo.remember(Buffer.from('x'), ['a\u0000b'], compute)).toBe(3);
  });

  it('keeps what a run asked for through one sweep, and drops what the next run did not ask for', () => {
    const memo = createMemo();
    const { compute, calls } = counter();
    const bytes = Buffer.from('x');

    memo.remember(bytes, ['kept'], compute);
    memo.remember(bytes, ['dropped'], compute);
    memo.sweep();
    expect(memo.size).toBe(2);

    // Asked for again after a sweep: served, not computed, and kept for another.
    expect(memo.remember(bytes, ['kept'], compute)).toBe(1);
    expect(memo.remember(bytes, ['kept'], compute)).toBe(1);
    memo.sweep();
    expect(memo.size).toBe(1);

    expect(memo.remember(bytes, ['dropped'], compute)).toBe(3);
    expect(memo.remember(bytes, ['kept'], compute)).toBe(1);
    expect(calls()).toBe(3);

    memo.sweep();
    memo.sweep();
    expect(memo.size).toBe(0);
    expect(memo.remember(bytes, ['kept'], compute)).toBe(4);
  });

  it('counts an entry held both from before the sweep and since it once', () => {
    const memo = createMemo();
    const bytes = Buffer.from('x');
    memo.remember(bytes, ['a'], () => 1);
    memo.sweep();
    memo.remember(bytes, ['a'], () => 2);
    memo.remember(bytes, ['b'], () => 3);
    expect(memo.size).toBe(2);
  });
});

describe('what each caller keys its work by', () => {
  // Two files with the same bytes, at two paths. Each caller's result names the
  // path it was computed for, so a key without the path hands the second file
  // the first one's answer.
  const root = path.resolve('/spec-guard-virtual-root');

  it('an import analysis, by the file\'s path', async () => {
    const source = "const name = pick();\nrequire(name);\n";
    const io = memoryIo(root, { 'a.js': source, 'b.js': source });
    const index = createImportIndex(io, createMemo());
    const a = await index.analyze(path.join(root, 'a.js'), 'a.js');
    const b = await index.analyze(path.join(root, 'b.js'), 'b.js');
    expect(a.notes.map((note) => note.file)).toEqual(['a.js']);
    expect(b.notes.map((note) => note.file)).toEqual(['b.js']);
  });

  it('a spec, by its paths', async () => {
    const source = '<!-- @assert-present file="x" -->\n';
    const io = memoryIo(root, { 'docs/a.md': source, 'docs/b.md': source });
    const specs = await readSpecs(['docs/*.md'], root, io, createMemo());
    expect(specs.documents.map((document) => document.directives[0]?.location.relativeFile)).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('a scan, by the file\'s path and the patterns', async () => {
    const io = memoryIo(root, { 'a.ts': 'Widget Gadget', 'b.ts': 'Widget Gadget' });
    const scanner = createJavaScriptEngine(io, createMemo());
    const ask = (symbol: string) => ({ root, symbol, targets: [], options: searchOptions() });
    expect((await scanner.search(ask('Widget'))).matches.map((match) => match.file)).toEqual(['a.ts', 'b.ts']);
    expect((await scanner.search(ask('Gadget'))).matches.map((match) => `${match.file}:${match.column}`)).toEqual(['a.ts:8', 'b.ts:8']);
  });
});
