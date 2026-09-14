#!/usr/bin/env node
/**
 * What a watch session costs, on a copy of this repository. ADR-0014.
 *
 *   npm run build && node --expose-gc scripts/bench-watch.mjs [iterations] [--every-event-deep]
 *
 * Copies docs, src, tests (without their scratch trees), README.md and
 * package.json into reports/bench-watch, which git ignores, so nothing of the
 * real repository is edited, and times four kinds of edit through a session:
 * a source file, a test file, a file no rule reads, and an ADR. Each edit is made, reported to
 * the session the way Windows reports a save - the file and each directory
 * above it - and timed from that report to the session's answer. Then it is
 * undone, reported, and answered again, untimed, so every iteration starts
 * from the same tree.
 *
 * The turnaround is observe plus run: the batch, not the quiet window before
 * it. A plain warm run of the same tree is printed alongside, and so is what
 * the session holds.
 *
 * --every-event-deep treats every event as a rename, evicting everything beneath
 * the path it names. That is what the session would cost without trusting a
 * `change` on a directory to be about the directory alone, which ADR-0014
 * weighs.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSession, runSpecGuard, FACT_POLICY } = await import(pathToUrl(path.join(project, 'dist', 'index.js')));

function pathToUrl(file) {
  return new URL(`file:///${file.replace(/\\/g, '/').replace(/^\//, '')}`).href;
}

const iterations = Number(process.argv.slice(2).find((argument) => /^\d+$/.test(argument)) ?? 15);
const everyEventDeep = process.argv.includes('--every-event-deep');
const policy = everyEventDeep
  ? { ...FACT_POLICY, evictions: (events, root, known) => FACT_POLICY.evictions(events.map((event) => ({ ...event, type: 'rename' })), root, known) }
  : undefined;
const root = path.join(project, 'reports', 'bench-watch');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
for (const entry of ['docs', 'src', 'tests', 'README.md', 'package.json']) {
  cpSync(path.join(project, entry), path.join(root, entry), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.tmp`) && !source.includes(`${path.sep}node_modules`),
  });
}
mkdirSync(path.join(root, 'notes'), { recursive: true });

const patterns = ['docs/**/*.md', 'README.md'];
const settings = async () => ({ patterns, run: {} });
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const fixed = (value) => value.toFixed(1);

/** Events as Windows reports a save: the file, then each directory above it. */
function saved(relative) {
  const parts = relative.split('/');
  return [
    { type: 'change', filename: parts.join(path.sep) },
    ...parts.slice(0, -1).map((_, depth) => ({ type: 'change', filename: parts.slice(0, depth + 1).join(path.sep) })),
  ];
}

const edits = [
  { name: 'a file in src', file: 'src/runner.ts', change: (text) => `${text}\n// an edit\n` },
  { name: 'a test file', file: 'tests/glob.test.ts', change: (text) => `${text}\n// an edit\n` },
  { name: 'a file no rule reads', file: 'notes/today.txt', change: (text) => `${text}more\n` },
  { name: 'an ADR', file: 'docs/adr/0012-query-and-mcp.md', change: (text) => `${text}\nAn added sentence.\n` },
];

// A plain run, warm, for comparison.
const plain = [];
for (let index = 0; index < iterations + 3; index++) {
  const started = performance.now();
  await runSpecGuard({ patterns, root, engine: 'javascript' });
  plain.push(performance.now() - started);
}

// Collected before and after, so the difference is what the session holds
// rather than whatever the collector had not yet reclaimed. Without
// --expose-gc there is no collector to call, and the figure says so.
globalThis.gc?.();
// Heap and buffers both: a file's bytes live outside the JavaScript heap.
const held = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const heapBefore = held();
const session = createSession({ root, settings, ...(policy ? { policy } : {}) });
let started = performance.now();
const first = await session.run();
const firstMs = performance.now() - started;
started = performance.now();
const second = await session.run();
const quietMs = performance.now() - started;

const lines = [
  `node ${process.version}, ${process.platform}, ${first.report.summary.specs} specs, ${first.report.summary.total} rules, ${iterations} iterations${everyEventDeep ? ', every event deep' : ''}`,
  `plain run, warm, engine js: median ${fixed(median(plain.slice(3)))} ms, best ${fixed(Math.min(...plain.slice(3)))} ms`,
  `session, first run: ${fixed(firstMs)} ms (${first.executed} executed); a run with nothing changed: ${fixed(quietMs)} ms (${second.executed} executed)`,
];

for (const edit of edits) {
  const file = path.join(root, edit.file);
  if (!existsSync(file)) writeFileSync(file, '');
  const original = readFileSync(file, 'utf8');
  const times = [];
  const executed = [];
  for (let index = 0; index < iterations; index++) {
    writeFileSync(file, edit.change(original));
    started = performance.now();
    await session.observe(saved(edit.file));
    const answer = await session.run();
    times.push(performance.now() - started);
    executed.push(answer.executed);

    writeFileSync(file, original);
    await session.observe(saved(edit.file));
    await session.run();
  }
  lines.push(`${edit.name.padEnd(22)} median ${fixed(median(times)).padStart(6)} ms  best ${fixed(Math.min(...times)).padStart(6)} ms  worst ${fixed(Math.max(...times)).padStart(6)} ms  rules re-executed ${median(executed)} of ${first.report.summary.total}`);
}

globalThis.gc?.();
const memory = globalThis.gc ? `${((held() - heapBefore) / 1024 / 1024).toFixed(1)} MB of heap and buffers` : 'an unmeasured amount of memory (run with --expose-gc)';
lines.push(`session holds ${session.facts} facts and ${memory}`);
console.log(lines.join('\n'));
rmSync(root, { recursive: true, force: true });
