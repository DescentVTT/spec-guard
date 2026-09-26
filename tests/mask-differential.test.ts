/**
 * The code masking of 0.11.0, held against spec-core's scanner, which replaced
 * it.
 *
 * What is code and what is a comment is now decided by spec-core's Markdown
 * scanner (ADR-0002). It parts from 0.11.0 on purpose in the shapes named at
 * the bottom of this file, each of which has tests of its own in
 * parser-contracts.test.ts. This holds the other half of the claim - that it
 * parts from 0.11.0 nowhere else - on every Markdown document in this
 * repository, and on random documents built from lines both read alike.
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
import { scanMarkdown } from '../src/vendor/spec-core/markdown/index.js';
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

/**
 * The two alike but for carriage returns. 0.11.0 blanked one inside code with
 * the rest of the code; the scanner keeps every line terminator where it was,
 * a lone `\r` included, since CommonMark ends a line there.
 */
function withoutCarriageReturns(masked: string): string {
  return masked.replace(/\r/g, ' ');
}

/** Where a directive-shaped comment starts in a masked text, as the parser finds one. */
function directiveOffsets(masked: string): number[] {
  return [...masked.matchAll(/<!--\s*@([a-zA-Z][\w-]*)([\s\S]*?)-->/g)].map((match) => match.index);
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
 * Lines both read alike: fences indented three spaces at most and with no info
 * string, beside prose, blank lines and code spans that close on their own
 * line. Left out, each for a reason the scanner has: a run that pairs with
 * nothing on its line, since a code span ends with its paragraph and 0.11.0
 * paired runs across the whole document; a line indented four columns, which
 * after a blank line is indented code; and a line with an info string, which
 * inside a block is one of the fence shapes, depending on where it lands.
 */
const SHARED_LINES = [
  '```',
  '````',
  '~~~',
  '~~~~',
  ' ```',
  '   ~~~',
  '```  ',
  '~~~\t',
  '~~',
  '`a` and ``b``',
  'prose',
  '',
  '<!-- @assert-absence symbol="X" -->',
];

describe('the masking of 0.11.0, against the scanner that replaced it', () => {
  it('masks every Markdown document in this repository as 0.11.0 did, but for what 0.11.0 did not know', async () => {
    const files = await corpus();
    // The corpus has to be the one described: the README, the changelog, the
    // ADRs and the fixtures, or agreeing would prove little.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files).toContain(path.join(PROJECT_ROOT, 'README.md'));

    const unknown: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      const name = path.relative(PROJECT_ROOT, file);
      const before = withoutCarriageReturns(maskedBefore(source)).split('\n');
      const after = withoutCarriageReturns(maskCode(source)).split('\n');
      // The same comments are read as directives, at the same offsets.
      expect(directiveOffsets(maskCode(source)), name).toEqual(directiveOffsets(maskedBefore(source)));
      // And a line masked differently is one 0.11.0 had no notion of: front
      // matter, indented code, or an element whose content is not Markdown.
      const lines = scanMarkdown(source).lines;
      before.forEach((line, index) => {
        if (line === after[index]) return;
        const scanned = lines[index];
        expect(scanned?.frontMatter || scanned?.html || (scanned?.code && scanned.indent >= 4), `${name}:${index + 1}`).toBe(true);
        unknown.push(`${name}:${index + 1}`);
      });
    }
    // The control: the corpus holds such lines, so the loop above was asked
    // something. ADR-0003 quotes a terminal session as indented code.
    expect(unknown).toContain(path.join('docs', 'adr', '0003-mutation-testing.md:483'));
  });

  it('masks random documents built from lines both read alike exactly as 0.11.0 did', () => {
    const next = random(20260926);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    for (let document = 0; document < 3000; document++) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(SHARED_LINES));
      const source = lines.join(pick(['\n', '\r\n']));
      expect(withoutCarriageReturns(maskCode(source)), JSON.stringify(source)).toBe(withoutCarriageReturns(maskedBefore(source)));
    }
  });

  it('and does part from it on each of the shapes the changelog names', () => {
    // The control. Were the two implementations one, the tests above would
    // pass without comparing anything. Each shape is read one way by 0.11.0
    // and the other by the scanner.
    const directive = (symbol: string): string => `<!-- @assert-absence symbol="${symbol}" -->`;
    const read = (masked: string): string[] => [...masked.matchAll(/symbol="(\w+)"/g)].map((match) => match[1] as string);
    const shapes: Array<[string, string[], string[]]> = [
      // A backtick fence's info string holds no backtick.
      [`\`\`\`js\`x\n${directive('X')}\n`, [], ['X']],
      // A closing fence has no info string.
      [`\`\`\`\n\`\`\`js\n${directive('X')}\n\`\`\`\n${directive('Y')}\n`, ['X'], ['Y']],
      // A fence indented with the list item it sits in.
      [`- a\n  1. b\n     ~~~\n     ${directive('X')}\n     ~~~\n`, ['X'], []],
      // A code span ends with its paragraph.
      [`Press \` to open the console.\n\n${directive('X')}\n\nOr \`.\n`, [], ['X']],
      // An escaped backtick opens nothing.
      [`Escape it: \\\`, then ${directive('X')} and a \`.\n`, [], ['X']],
      // A fence shown inside a comment opens nothing.
      [`<!--\n\`\`\`\n-->\n${directive('X')}\n`, [], ['X']],
      // Indented code, raw-text HTML and front matter are not read.
      [`para\n\n    ${directive('X')}\n`, ['X'], []],
      [`<pre>\n${directive('X')}\n</pre>\n`, ['X'], []],
      [`---\nx: ${directive('X')}\n---\n`, ['X'], []],
    ];
    for (const [source, before, after] of shapes) {
      expect(read(maskedBefore(source)), JSON.stringify(source)).toEqual(before);
      expect(read(maskCode(source)), JSON.stringify(source)).toEqual(after);
    }
    // A backtick inside a comment is a character, where 0.11.0 paired it.
    const quoted = '<!-- @assert-absence target="src/" symbol="`eval`" -->\n';
    expect(maskedBefore(quoted)).not.toContain('`eval`');
    expect(maskCode(quoted)).toBe(quoted);
    // A carriage return inside code is kept where it was.
    expect(maskedBefore('```\r\nx\r\n```\r\n')).toBe('    \n  \n    \n');
    expect(maskCode('```\r\nx\r\n```\r\n')).toBe('   \r\n \r\n   \r\n');
  });
});
