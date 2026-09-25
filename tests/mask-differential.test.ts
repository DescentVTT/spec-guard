/**
 * The fence rule of 0.11.0, held against the one that replaced it.
 *
 * The replacement parts from the old rule in three shapes, on purpose: a
 * backtick in a backtick fence's info string, an info string on a closing
 * fence, and a fence indented more than three spaces. Those have tests of their
 * own in parser-contracts.test.ts. This holds the other half of the claim - that
 * it parts from the old rule nowhere else - on every Markdown document in this
 * repository, and on random documents built from lines both rules read alike.
 *
 * The old rule is copied here verbatim rather than imported from a build of
 * 0.11.0, because a comparison that needs a published package to run is a
 * comparison that stops running.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { maskCode } from '../src/parser.js';
import { maskRanges } from '../src/text.js';
import { PROJECT_ROOT } from './helpers.js';

/** `maskCode` as 0.11.0 shipped it. */
function maskedBefore(source: string): string {
  const fenceRe = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  const fences: Array<{ index: number; end: number; marker: string }> = [];
  while ((match = fenceRe.exec(source)) !== null) {
    fences.push({ index: match.index, end: match.index + match[0].length, marker: match[1] as string });
  }
  const consumed: Array<[number, number]> = [];
  for (let i = 0; i < fences.length; i++) {
    const open = fences[i] as { index: number; end: number; marker: string };
    if (consumed.some(([s, e]) => open.index >= s && open.index < e)) continue;
    const char = open.marker[0] as string;
    let closeEnd = source.length;
    for (let j = i + 1; j < fences.length; j++) {
      const candidate = fences[j] as { index: number; end: number; marker: string };
      if (candidate.marker[0] === char && candidate.marker.length >= open.marker.length) {
        closeEnd = candidate.end;
        break;
      }
    }
    consumed.push([open.index, closeEnd]);
  }

  const masked = maskRanges(source, consumed);
  const spans: Array<[number, number]> = [];
  const runs: Array<{ index: number; length: number }> = [];
  const runRe = /`+/g;
  let run: RegExpExecArray | null;
  while ((run = runRe.exec(masked)) !== null) {
    runs.push({ index: run.index, length: run[0].length });
  }
  for (let index = 0; index < runs.length; index++) {
    const open = runs[index] as { index: number; length: number };
    const closeIndex = runs.findIndex((candidate, position) => position > index && candidate.length === open.length);
    if (closeIndex === -1) continue;
    const close = runs[closeIndex] as { index: number; length: number };
    spans.push([open.index, close.index + close.length]);
    index = closeIndex;
  }
  return maskRanges(masked, spans);
}

/** Every Markdown file in the repository that is not a dependency or a leftover. */
async function corpus(): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.tmp', '.stryker-tmp', 'dist', 'reports', 'coverage'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.(md|markdown|mdx)$/i.test(entry.name)) found.push(absolute);
    }
  };
  await visit(PROJECT_ROOT);
  return found.sort();
}

/** mulberry32, as the watch equivalence test uses it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lines both rules read alike: fences indented three spaces at most and with no
 * info string, beside prose, code spans and runs that pair with nothing. A line
 * with an info string is left out, because inside a block it is the second of
 * the three shapes, and that depends on where it lands.
 */
const SHARED_LINES = [
  '```',
  '````',
  '~~~',
  '~~~~',
  ' ```',
  '   ~~~',
  '\t```',
  '```  ',
  '~~~\t',
  '``',
  '~~',
  '`a` and ``b``',
  'x ``` y',
  'a ` b',
  'prose',
  '',
  '<!-- @assert-absence symbol="X" -->',
];

describe('the fence rule, against the one it replaced', () => {
  it('masks every Markdown document in this repository exactly as 0.11.0 did', async () => {
    const files = await corpus();
    // The corpus has to be the one described: the README, the changelog, the
    // ADRs and the fixtures, or agreeing would prove little.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files).toContain(path.join(PROJECT_ROOT, 'README.md'));

    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      expect(maskCode(source), path.relative(PROJECT_ROOT, file)).toBe(maskedBefore(source));
    }
  });

  it('masks random documents built from lines both rules read alike exactly as 0.11.0 did', () => {
    const next = random(20260926);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    for (let document = 0; document < 3000; document++) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(SHARED_LINES));
      const source = lines.join(pick(['\n', '\r\n']));
      expect(maskCode(source), JSON.stringify(source)).toBe(maskedBefore(source));
    }
  });

  it('and does part from it on each of the three shapes', () => {
    // The control. Were the two implementations one, the tests above would
    // pass without comparing anything.
    for (const source of [
      '```js`x\n<!-- @assert-absence symbol="X" -->\n',
      '```\n```js\n<!-- @assert-absence symbol="X" -->\n```\n<!-- @assert-absence symbol="Y" -->\n',
      '- a\n  1. b\n     ~~~\n     <!-- @assert-absence symbol="X" -->\n     ~~~\n',
    ]) {
      expect(maskCode(source), JSON.stringify(source)).not.toBe(maskedBefore(source));
    }
  });
});
