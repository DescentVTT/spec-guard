/**
 * Minutes each file took in a CI mutation sweep, read off the sweep's log.
 *
 * Stryker's reports carry no timings, but its progress reporter prints a
 * timestamped "n/total tested" line every few seconds, and the order it tests
 * mutants in is fixed: mutants without coverage first, then every other mutant
 * file by file, alphabetically, with static mutants moved to the end (they
 * need the test environment reloaded, and Stryker sorts those last), again
 * file by file. So each file owns a known stretch of the count, and the log
 * says when that stretch began and ended.
 *
 * The order is an inference from Stryker's source, so the output checks it:
 * the timeouts the log counted inside each file's stretch should match the
 * timeouts the report gives that file, give or take a mutant or two where four
 * workers overlap a boundary. If they do not, the order has changed and the
 * minutes mean nothing.
 *
 *   gh run view <run> --job <job> --log > sweep.log
 *   node scripts/mutation-timeline.mjs <report: mutation.json or index.html> sweep.log
 *
 * A shard cancelled at its time limit leaves a log and no report. The script
 * reads only a report's counts, so any report of the same tree will do, such
 * as a pull request's merged one cut down to the shard's files; a stretch the
 * log never reached prints as "?".
 *
 * scripts/mutation-shards.mjs balances its shards on these numbers.
 */

import { readFileSync } from 'node:fs';

const [reportFile, logFile] = process.argv.slice(2);
if (!reportFile || !logFile) {
  console.error('usage: node scripts/mutation-timeline.mjs <mutation.json or index.html> <sweep log>');
  process.exit(2);
}

function readReport(file) {
  const text = readFileSync(file, 'utf8');
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  // The HTML page embeds the report as a script expression, with every "<"
  // split out of its string; see scripts/mutation-timeouts.mjs.
  const marker = 'app.report = ';
  const from = text.indexOf(marker) + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === String.fromCharCode(92)) escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return new Function(`return ${text.slice(from, index + 1)}`)();
    }
  }
  throw new Error(`no report found in ${file}`);
}

const report = readReport(reportFile);
const files = Object.keys(report.files)
  .sort()
  .map((name) => {
    const mutants = report.files[name].mutants;
    const tested = mutants.filter((m) => m.status !== 'NoCoverage');
    return {
      name,
      uncovered: mutants.length - tested.length,
      runtime: tested.filter((m) => !m.static).length,
      static: tested.filter((m) => m.static).length,
      timeouts: mutants.filter((m) => m.status === 'Timeout').length,
    };
  });

// Progress lines, and the end of the run as the point where everything was tested.
const points = [];
let total = 0;
let offset = 0;
let previous = -1;
for (const line of readFileSync(logFile, 'utf8').split('\n')) {
  const stamp = /T(\d\d):(\d\d):(\d\d(?:\.\d+)?)Z/.exec(line);
  if (!stamp) continue;
  let seconds = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]) + offset;
  if (seconds < previous) {
    offset += 86400;
    seconds += 86400;
  }
  const progress = /(\d+)\/(\d+) tested \(\d+ survived, (\d+) timed out\)/.exec(line);
  if (progress) {
    previous = seconds;
    total = Number(progress[2]);
    points.push({ seconds, tested: Number(progress[1]), timeouts: Number(progress[3]) });
  } else if (/MutationTestExecutor.*Done in/.test(line) && points.length > 0) {
    points.push({ seconds, tested: total, timeouts: points.at(-1).timeouts });
  }
}
if (points.length === 0) {
  console.error(`no progress lines in ${logFile}`);
  process.exit(1);
}

function at(count, field) {
  const index = points.findIndex((point) => point.tested >= count);
  if (index === -1) return undefined;
  if (index === 0 || field === 'timeouts') return points[index][field];
  const [a, b] = [points[index - 1], points[index]];
  return a.seconds + ((b.seconds - a.seconds) * (count - a.tested)) / Math.max(1, b.tested - a.tested);
}

const span = (from, to, field) => {
  const [start, end] = [at(from, field), at(to, field)];
  return start === undefined || end === undefined ? undefined : end - start;
};

let runtimeCursor = files.reduce((sum, file) => sum + file.uncovered, 0);
let staticCursor = runtimeCursor + files.reduce((sum, file) => sum + file.runtime, 0);
const rows = files.map((file) => {
  const row = {
    name: file.name,
    mutants: file.uncovered + file.runtime + file.static,
    runtime: span(runtimeCursor, runtimeCursor + file.runtime, 'seconds'),
    static: span(staticCursor, staticCursor + file.static, 'seconds'),
    timeouts: file.timeouts,
    counted: (span(runtimeCursor, runtimeCursor + file.runtime, 'timeouts') ?? 0) + (span(staticCursor, staticCursor + file.static, 'timeouts') ?? 0),
  };
  runtimeCursor += file.runtime;
  staticCursor += file.static;
  return row;
});

const minutes = (seconds) => (seconds === undefined ? '?' : (seconds / 60).toFixed(1));
const width = Math.max(4, ...rows.map((row) => row.name.length));
console.log(`${'file'.padEnd(width)}  mutants  minutes (runtime + static)  timeouts: report / counted`);
for (const row of rows) {
  const sum = row.runtime === undefined || row.static === undefined ? undefined : row.runtime + row.static;
  console.log(
    `${row.name.padEnd(width)}  ${String(row.mutants).padStart(7)}  ${minutes(sum).padStart(5)} (${minutes(row.runtime)} + ${minutes(row.static)})`.padEnd(width + 38) +
      `${String(row.timeouts).padStart(4)} / ${row.counted}`,
  );
}
console.log(`\nthe whole sweep: ${minutes(points.at(-1).seconds - points[0].seconds)} minutes from the first progress line`);
