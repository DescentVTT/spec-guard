/**
 * Extracts timeout mutants from the HTML mutation report.
 *
 * Stryker counts a timeout as a kill, which is usually right - a mutant that
 * makes the suite hang has been detected. But a large jump in timeouts can also
 * mean the tests merely got slower, which would inflate the score without
 * pinning down any behaviour. This prints them so the difference can be judged
 * rather than assumed.
 */

import { readFileSync } from 'node:fs';

const html = readFileSync(process.argv[2] ?? 'reports/mutation/index.html', 'utf8');
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

// Not JSON.parse: Stryker splits strings in the embedded payload (you see
// things like "index <"+"= argv.length") so the report cannot break out of its
// own <script> tag. That makes it a JavaScript expression, not JSON. This reads
// a file this repository just generated, not anything untrusted.
const report = new Function(`return ${html.slice(from, end)}`)();
const counts = {};
const timeouts = [];

for (const [file, data] of Object.entries(report.files)) {
  for (const mutant of data.mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    if (mutant.status === 'Timeout') {
      timeouts.push({
        file,
        line: mutant.location.start.line,
        mutator: mutant.mutatorName,
        replacement: (mutant.replacement ?? '').replace(/\s+/g, ' ').slice(0, 80),
      });
    }
  }
}

console.log('status counts:', counts);

const byFile = {};
for (const timeout of timeouts) byFile[timeout.file] = (byFile[timeout.file] ?? 0) + 1;
console.log('\ntimeouts by file:');
for (const [file, count] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}

const byLine = new Map();
for (const timeout of timeouts) {
  const key = `${timeout.file}:${timeout.line}`;
  byLine.set(key, (byLine.get(key) ?? 0) + 1);
}
console.log('\nhot lines:');
for (const [key, count] of [...byLine.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const sample = timeouts.find((timeout) => `${timeout.file}:${timeout.line}` === key);
  console.log(`  ${String(count).padStart(3)}x ${key.padEnd(24)} [${sample.mutator}] ${sample.replacement}`);
}
