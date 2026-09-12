/**
 * Is every surviving mutant really equivalent?
 *
 * "The remaining mutants are equivalent" is the rationalisation available to
 * anyone who does not want to write tests, and ADR-0003 says so. This settles
 * it one mutant at a time: each survivor from the authoritative CI report is
 * applied to the real source at the exact span Stryker reported, compiled, and
 * run through `mutation-probe.mjs` - a fingerprint of the whole observable
 * surface over
 * a real corpus, adversarial inputs, every reporter format, and real searches
 * with both engines.
 *
 * It patches `src/` in place and restores it, so the tree must be clean before
 * it runs and will be clean after - including after an interruption, which is
 * what the `finally` is for.
 *
 * A mutant whose fingerprint differs is DISTINGUISHED: the suite is missing a
 * test, and the harness says which observation moved. One whose fingerprint is
 * identical is indistinguishable to everything this can reach - which is a
 * measurement, not an opinion, and its limits are the probe's limits.
 *
 *   node scripts/mutation-equivalence.mjs [report.html] [fileFilter]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'reports', 'equivalence');
const KILLED = new Set(['Killed', 'Timeout', 'RuntimeError']);

const reportPath = process.argv[2] ?? path.join(ROOT, 'reports', 'mutation', 'index.html');
const only = process.argv[3];

const html = readFileSync(reportPath, 'utf8');
const marker = 'app.report = ';
const start = html.indexOf(marker) + marker.length;
const end = html.lastIndexOf(';', html.indexOf('function updateTheme'));
const report = new Function(`return ${html.slice(start, end)}`)();

const survivors = [];
for (const [file, data] of Object.entries(report.files)) {
  if (only && !file.includes(only)) continue;
  for (const mutant of data.mutants) {
    if (KILLED.has(mutant.status)) continue;
    survivors.push({ file, ...mutant });
  }
}
survivors.sort((a, b) => (a.file === b.file ? a.location.start.line - b.location.start.line : a.file < b.file ? -1 : 1));

/** Offset of a 1-based line/column in `text`. */
function offsetOf(text, { line, column }) {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next === -1) return text.length;
    at = next + 1;
  }
  return Math.min(at + column - 1, text.length);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...options });
}

const pristine = new Map();
for (const file of new Set(survivors.map((s) => s.file))) {
  pristine.set(file, readFileSync(path.join(ROOT, file), 'utf8'));
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

/**
 * A ripgrep for the probe to spawn, so the subprocess boundary is crossed.
 *
 * Resolved from the devDependency rather than PATH: the point of the probe is
 * that two builds are compared under the same conditions, and "whatever rg the
 * machine happens to have" is not one.
 */
function ripgrep() {
  try {
    const require = createRequire(import.meta.url);
    return { SPEC_GUARD_RG: require('@vscode/ripgrep').rgPath };
  } catch {
    // Without one the probe still compares everything except the ripgrep path.
    return {};
  }
}

const env = { ...process.env, ...ripgrep() };

const FROZEN = path.join(WORK, 'frozen');
// A snapshot taken before anything is patched. The probe reads its corpus from
// here, so patching a source file cannot change the probe's own input.
for (const dir of ['src', 'tests', 'docs']) {
  cpSync(path.join(ROOT, dir), path.join(FROZEN, dir), { recursive: true });
}
cpSync(path.join(ROOT, 'README.md'), path.join(FROZEN, 'README.md'));

// The builds live at <WORK>/base and <WORK>/mutant, so `cli.version()` resolves
// `../package.json` to <WORK>/package.json. Without this the probe measures a
// broken install - which is a real state, but not the one the package ships in.
cpSync(path.join(ROOT, 'package.json'), path.join(WORK, 'package.json'));

function probe(dist, full) {
  const args = [path.join(HERE, 'mutation-probe.mjs'), dist, '--corpus', FROZEN];
  if (full) args.push('--full', full);
  return run(process.execPath, args, { env }).trim();
}

// The baseline, from the tree exactly as committed.
run('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', path.join(WORK, 'base')], { shell: true });
const baseline = probe(path.join(WORK, 'base'), path.join(WORK, 'base.txt'));
console.log(`baseline ${baseline}\n`);

const results = [];
try {
  for (const [index, mutant] of survivors.entries()) {
    const source = pristine.get(mutant.file);
    const from = offsetOf(source, mutant.location.start);
    const to = offsetOf(source, mutant.location.end);
    const original = source.slice(from, to);
    const patched = source.slice(0, from) + mutant.replacement + source.slice(to);
    const label = `${mutant.file}:${mutant.location.start.line} ${mutant.mutatorName}`;

    if (patched === source) {
      results.push({ label, verdict: 'NO-OP PATCH', detail: 'replacement equals the original text' });
      console.log(`[${index + 1}/${survivors.length}] NO-OP        ${label}`);
      continue;
    }

    writeFileSync(path.join(ROOT, mutant.file), patched, 'utf8');
    const outDir = path.join(WORK, 'mutant');
    rmSync(outDir, { recursive: true, force: true });

    let verdict;
    let detail = '';
    try {
      run('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', outDir, '--noEmitOnError', 'false'], { shell: true });
    } catch (error) {
      // Type errors do not stop emit, so this only fires on a syntax error.
      if (!error.stdout?.includes('error TS')) {
        results.push({ label, verdict: 'BUILD FAILED', detail: String(error.message).slice(0, 200) });
        console.log(`[${index + 1}/${survivors.length}] BUILD FAILED ${label}`);
        writeFileSync(path.join(ROOT, mutant.file), source, 'utf8');
        continue;
      }
    }

    try {
      const digest = probe(outDir);
      if (digest === baseline) {
        verdict = 'indistinguishable';
      } else {
        verdict = 'DISTINGUISHED';
        probe(outDir, path.join(WORK, 'mutant.txt'));
        const before = readFileSync(path.join(WORK, 'base.txt'), 'utf8').split('\n');
        const after = readFileSync(path.join(WORK, 'mutant.txt'), 'utf8').split('\n');
        let changed = 0;
        let first = '';
        for (let line = 0; line < Math.max(before.length, after.length); line++) {
          if (before[line] !== after[line]) {
            changed += 1;
            if (!first) first = `${(before[line] ?? '(absent)').slice(0, 140)}  ->  ${(after[line] ?? '(absent)').slice(0, 140)}`;
          }
        }
        detail = `${changed} observations differ; first: ${first}`;
      }
    } catch (error) {
      // A mutant that makes the probe throw is caught by anything that loads
      // the module, which is every test file.
      verdict = 'DISTINGUISHED';
      detail = `probe threw: ${String(error.stderr || error.message).split('\n').find((l) => l.includes('Error')) ?? ''}`.slice(0, 200);
    }

    results.push({ label, verdict, detail, original: original.slice(0, 80), replacement: String(mutant.replacement).slice(0, 80) });
    console.log(`[${index + 1}/${survivors.length}] ${verdict === 'DISTINGUISHED' ? 'DISTINGUISHED' : 'equivalent   '} ${label}`);
    if (detail && verdict === 'DISTINGUISHED') console.log(`               ${detail}`);

    writeFileSync(path.join(ROOT, mutant.file), source, 'utf8');
  }
} finally {
  for (const [file, source] of pristine) writeFileSync(path.join(ROOT, file), source, 'utf8');
}

const distinguished = results.filter((r) => r.verdict === 'DISTINGUISHED');
const odd = results.filter((r) => r.verdict !== 'DISTINGUISHED' && r.verdict !== 'indistinguishable');
console.log(`\n${results.length} survivors: ${distinguished.length} distinguished, ${results.length - distinguished.length - odd.length} indistinguishable, ${odd.length} other`);
for (const r of [...distinguished, ...odd]) {
  console.log(`\n${r.verdict}  ${r.label}\n  ${r.original}  ->  ${r.replacement}\n  ${r.detail}`);
}
writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
cpSync(path.join(WORK, 'base.txt'), path.join(WORK, 'baseline-observations.txt'));
