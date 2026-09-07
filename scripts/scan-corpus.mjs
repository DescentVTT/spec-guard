/**
 * Measures the import analyser against a real corpus.
 *
 * The numbers quoted in ADR-0005 come from this, pointed at node_modules. The
 * one that matters is how often the scan loses sync, because that is the
 * fraction of files the analyser must decline to answer for rather than report
 * as clean.
 *
 *   node scripts/scan-corpus.mjs node_modules
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ANALYSABLE_EXTENSIONS, analyzeSource } from '../dist/imports.js';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node scripts/scan-corpus.mjs <dir>...');
  process.exit(2);
}

async function* walk(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (ANALYSABLE_EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

const counts = { files: 0, bytes: 0, references: 0, typeOnly: 0, dynamic: 0, unreadable: 0 };
const byKind = {};
const samples = [];
const started = performance.now();

for (const root of roots) {
  for await (const file of walk(root)) {
    const source = await fs.readFile(file, 'utf8').catch(() => null);
    if (source === null || source.length > 2_000_000) continue;
    counts.files += 1;
    counts.bytes += source.length;

    const result = analyzeSource(source, file);
    counts.references += result.references.length;
    for (const reference of result.references) {
      byKind[reference.kind] = (byKind[reference.kind] ?? 0) + 1;
      if (reference.typeOnly) counts.typeOnly += 1;
    }
    for (const note of result.notes) {
      if (note.kind === 'dynamic') counts.dynamic += 1;
      else {
        counts.unreadable += 1;
        if (samples.length < 6) samples.push(file);
      }
    }
  }
}

const elapsed = performance.now() - started;
const megabytes = counts.bytes / 1024 / 1024;

console.log(`files              ${counts.files}`);
console.log(`bytes              ${megabytes.toFixed(1)} MB`);
console.log(`references         ${counts.references}`);
for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(16)} ${count}`);
}
console.log(`  type-only        ${counts.typeOnly}`);
console.log(`dynamic sites      ${counts.dynamic}`);
console.log(
  `unanalysable       ${counts.unreadable}  (${((counts.unreadable / Math.max(counts.files, 1)) * 100).toFixed(3)}%)`,
);
console.log(`elapsed            ${elapsed.toFixed(0)} ms  (${(megabytes / (elapsed / 1000)).toFixed(1)} MB/s)`);
for (const sample of samples) console.log(`  unanalysable: ${sample}`);
