/**
 * The scope policy and the ledger.
 *
 * Small, pure, and load-bearing: this module decides what an assertion is
 * allowed to look at, and what it must admit to not having looked at.
 */

import { describe, expect, it } from 'vitest';

import {
  createScope,
  isBinary,
  mergeLedgers,
  tallyLedger,
  LedgerBuilder,
  DEFAULT_SCOPE,
  DEFAULT_SKIPPED_DIRECTORIES,
  MAX_LEDGER_ENTRIES,
  SCAN_EVERYTHING,
  UNCERTAIN_REASONS,
} from '../src/scope.js';

describe('the default policy', () => {
  it('skips version control stores and dependencies, and nothing else', () => {
    // The list is short on purpose. Every name here is a place where a match
    // would mislead rather than inform: a VCS store answers "did this ever
    // exist", and a dependency tree answers for code nobody here wrote.
    expect([...DEFAULT_SKIPPED_DIRECTORIES.keys()].sort()).toEqual(['.git', '.hg', '.svn', 'node_modules']);
  });

  it('does not skip build output, which it cannot recognise', () => {
    // `dist` might be compiled output or a directory of scripts, and guessing
    // wrong is how a rule silently stops covering anything.
    for (const name of ['dist', 'build', 'out', 'coverage', '.next', '.github', '.husky']) {
      expect(DEFAULT_SKIPPED_DIRECTORIES.has(name), name).toBe(false);
    }
  });

  it('labels each skip with why it happened', () => {
    expect(DEFAULT_SKIPPED_DIRECTORIES.get('.git')).toBe('vcs');
    expect(DEFAULT_SKIPPED_DIRECTORIES.get('node_modules')).toBe('dependencies');
  });

  it('separates deliberate omissions from gaps in the answer', () => {
    // Only the second kind is a reason to distrust a pass, and only the second
    // kind fails a --strict run.
    expect(UNCERTAIN_REASONS.has('unreadable')).toBe(true);
    expect(UNCERTAIN_REASONS.has('binary')).toBe(true);
    expect(UNCERTAIN_REASONS.has('vcs')).toBe(false);
    expect(UNCERTAIN_REASONS.has('dependencies')).toBe(false);
  });

  it('offers a policy that skips nothing at all', () => {
    expect(SCAN_EVERYTHING.skippedDirectories.size).toBe(0);
  });

  it('chooses between them', () => {
    expect(createScope(true)).toBe(DEFAULT_SCOPE);
    expect(createScope(false)).toBe(SCAN_EVERYTHING);
  });
});

describe('isBinary', () => {
  it('calls a NUL byte binary wherever it appears', () => {
    expect(isBinary(Buffer.from([0]))).toBe(true);
    expect(isBinary(Buffer.from('text'))).toBe(false);
  });

  it('looks past any prefix window', () => {
    // The old heuristic sniffed 8KB, which meant a file with a late NUL was
    // text here and binary to ripgrep - the same bytes, two answers.
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(isBinary(late)).toBe(true);
  });

  it('treats an empty file as text', () => {
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe('LedgerBuilder', () => {
  it('records a path, its reason, and any matches found in it', () => {
    const ledger = new LedgerBuilder();
    ledger.add('a.bin', 'binary', 2);
    ledger.add('b.txt', 'unreadable');

    expect(ledger.build().skipped).toEqual([
      { path: 'a.bin', reason: 'binary', matches: 2 },
      { path: 'b.txt', reason: 'unreadable' },
    ]);
  });

  it('counts everything, including what it stopped listing', () => {
    const ledger = new LedgerBuilder();
    for (let index = 0; index < MAX_LEDGER_ENTRIES + 10; index++) {
      ledger.add(`file-${index}.bin`, 'binary', 1);
    }

    // The sample is capped so a pathological tree cannot exhaust memory; the
    // count is not, so the report never understates the problem.
    expect(ledger.build().skipped).toHaveLength(MAX_LEDGER_ENTRIES);
    expect(ledger.count('binary')).toBe(MAX_LEDGER_ENTRIES + 10);
  });

  it('counts each reason separately, and zero for one never seen', () => {
    const ledger = new LedgerBuilder();
    ledger.add('a.bin', 'binary', 1);
    ledger.add('b.bin', 'binary', 1);
    ledger.add('c.txt', 'unreadable');

    expect(ledger.count('binary')).toBe(2);
    expect(ledger.count('unreadable')).toBe(1);
    expect(ledger.count('vcs')).toBe(0);
  });

  it('omits the matches field when there is nothing to say', () => {
    const ledger = new LedgerBuilder();
    ledger.add('a.txt', 'unreadable');
    expect(ledger.build().skipped[0]).not.toHaveProperty('matches');
  });
});

describe('tallyLedger', () => {
  it('totals a ledger by reason', () => {
    const ledger = new LedgerBuilder();
    ledger.add('a.bin', 'binary', 1);
    ledger.add('b.bin', 'binary', 3);
    ledger.add('c.txt', 'unreadable');

    const totals = tallyLedger(ledger.build());
    expect(totals.get('binary')).toBe(2);
    expect(totals.get('unreadable')).toBe(1);
    expect(totals.get('vcs')).toBeUndefined();
  });

  it('totals an empty ledger to nothing', () => {
    expect(tallyLedger({ skipped: [] }).size).toBe(0);
  });
});

describe('mergeLedgers', () => {
  it('combines several searches without repeating a path', () => {
    // Assertions in one run share a tree, so the same unreadable file turns up
    // in each of their ledgers; the reader should be told once.
    const merged = mergeLedgers([
      { skipped: [{ path: 'a.bin', reason: 'binary', matches: 1 }] },
      { skipped: [{ path: 'a.bin', reason: 'binary', matches: 1 }] },
      { skipped: [{ path: 'b.txt', reason: 'unreadable' }] },
    ]);

    expect(merged.skipped).toEqual([
      { path: 'a.bin', reason: 'binary', matches: 1 },
      { path: 'b.txt', reason: 'unreadable' },
    ]);
  });

  it('keeps one path twice when the reasons differ', () => {
    const merged = mergeLedgers([
      { skipped: [{ path: 'a', reason: 'binary', matches: 1 }] },
      { skipped: [{ path: 'a', reason: 'unreadable' }] },
    ]);

    expect(merged.skipped).toHaveLength(2);
  });

  it('caps the merged sample too', () => {
    const ledgers = Array.from({ length: MAX_LEDGER_ENTRIES + 5 }, (_, index) => ({
      skipped: [{ path: `f-${index}`, reason: 'binary' as const, matches: 1 }],
    }));

    expect(mergeLedgers(ledgers).skipped).toHaveLength(MAX_LEDGER_ENTRIES);
  });

  it('merges nothing into nothing', () => {
    expect(mergeLedgers([])).toEqual({ skipped: [] });
  });
});
