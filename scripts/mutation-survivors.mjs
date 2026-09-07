/**
 * Lists surviving mutants from an HTML mutation report, grouped so the
 * structural causes stand out rather than the individual mutants.
 *
 *   node scripts/mutation-survivors.mjs [report.html] [--file src/reporter.ts]
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args.find((argument) => !argument.startsWith('--')) ?? 'reports/mutation/index.html';
const only = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

const html = readFileSync(path, 'utf8');
const marker = 'app.report = ';
const start = html.indexOf(marker);
if (start < 0) {
  console.error('no embedded report found');
  process.exit(1);
}

const from = start + marker.length;
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let index = from; index < html.length; index++) {
  const char = html[index];
  if (inString) {
    if (escaped) escaped = false;
    else if (char === String.fromCharCode(92)) escaped = true;
    else if (char === '"') inString = false;
    continue;
  }
  if (char === '"') {
    inString = true;
    continue;
  }
  if (char === '{') depth++;
  else if (char === '}') {
    depth--;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
}

// Stryker splits strings in the payload so it cannot break out of its own
// <script> tag, which makes this a JavaScript expression rather than JSON.
const report = new Function(`return ${html.slice(from, end)}`)();

const survivors = [];
for (const [file, data] of Object.entries(report.files)) {
  if (only && file !== only) continue;
  const lines = data.source.split('\n');
  for (const mutant of data.mutants) {
    if (mutant.status !== 'Survived') continue;
    survivors.push({
      file,
      line: mutant.location.start.line,
      mutator: mutant.mutatorName,
      replacement: (mutant.replacement ?? '').replace(/\s+/g, ' ').slice(0, 60),
      source: (lines[mutant.location.start.line - 1] ?? '').trim().slice(0, 90),
    });
  }
}

console.log(`survivors: ${survivors.length}\n`);

const byFile = {};
for (const survivor of survivors) byFile[survivor.file] = (byFile[survivor.file] ?? 0) + 1;
for (const [file, count] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}

const byLine = new Map();
for (const survivor of survivors) {
  const key = `${survivor.file}:${survivor.line}`;
  if (!byLine.has(key)) byLine.set(key, { count: 0, sample: survivor });
  byLine.get(key).count += 1;
}

console.log('\nhot lines:');
for (const [key, { count, sample }] of [...byLine.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(count).padStart(3)}x ${key}`);
  console.log(`       ${sample.source}`);
  console.log(`       -> [${sample.mutator}] ${sample.replacement}`);
}
