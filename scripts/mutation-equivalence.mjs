/**
 * Is every surviving mutant really equivalent?
 *
 * "The remaining mutants are equivalent" is the rationalisation available to
 * anyone who does not want to write tests, and ADR-0003 says so. This settles
 * it one mutant at a time: each survivor from the authoritative CI report is
 * applied to the source at the exact span Stryker reported, compiled, and run
 * through `mutation-probe.mjs` - a fingerprint of the whole observable surface
 * over a real corpus, adversarial inputs, every reporter format, every command
 * and real searches with both engines.
 *
 * Nothing is patched in place. The source is copied under reports/equivalence
 * and the mutants are written into the copy, so the tree is as it was whenever
 * and however a run ends, and the probe reads a second copy that is never
 * patched at all.
 *
 * A mutant whose fingerprint differs is DISTINGUISHED: the suite is missing a
 * test, and the harness says which observation moved. One whose fingerprint is
 * identical is indistinguishable to everything this can reach - which is a
 * measurement, not an opinion, and its limits are the probe's limits.
 *
 * A measurement that cannot be trusted is refused, not printed. The report has
 * to be of this source, file for file, or its spans point at other code; the
 * fingerprint has to come out the same twice; and a control, a mutant that
 * changes an answer, has to be told apart before any survivor is asked.
 * `--check` is the first of those and the control's anchor, without a build:
 * tests/replay-scripts.test.ts runs it. From 0.6.0 to 0.19.1 this could not
 * run, and nothing said so (ADR-0003).
 *
 *   node scripts/mutation-equivalence.mjs [report] [fileFilter]
 *   node scripts/mutation-equivalence.mjs --check [report]
 *
 * The report is CI's: the `mutation-report` artifact of main's full sweep holds
 * `mutation.json` and the page, and either is read. Without one named, it is
 * reports/mutation/mutation.json.
 */
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'reports', 'equivalence');
/** The tree as it stands, copied once: what the probe reads, and never patched. */
const FROZEN = path.join(WORK, 'frozen');
/** A second copy of src/, which the mutants are written into and compiled from. */
const SOURCE = path.join(WORK, 'source');
const KILLED = new Set(['Killed', 'Timeout', 'RuntimeError']);

/**
 * A mutant that changes an answer, which the probe has to tell from the build
 * as it stands before "indistinguishable" means anything: `comparePaths` put
 * backwards, which reverses every list of files a search reports.
 */
const CONTROL = {
  file: 'src/engine.ts',
  original: 'return a < b ? -1 : a > b ? 1 : 0;',
  replacement: 'return a < b ? 1 : a > b ? -1 : 0;',
};

/** Why a run would measure nothing. */
class Refusal extends Error {}

const unixLines = (text) => text.replace(/\r\n/g, '\n');
const times = (text, part) => text.split(part).length - 1;

/**
 * The report in a file: Stryker's JSON, or the page that carries it.
 *
 * The page holds the report as a script expression between two lines of its
 * own, with every `<` split out of its string so that no source text can close
 * the script. It holds the tests' sources too, and one of them quotes both of
 * those lines, so the report ends at the last of them, not the first: reading
 * to the first is what stopped this at 0.9.0.
 */
function readReport(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Refusal(`${file} cannot be read (${error.code}): name the mutation.json or the page of CI's mutation-report artifact`);
  }
  let json = text;
  if (!text.trimStart().startsWith('{')) {
    const marker = 'app.report = ';
    const start = text.indexOf(marker);
    const end = text.lastIndexOf(';', text.lastIndexOf('function updateTheme'));
    if (start === -1 || end < start) throw new Refusal(`${file} is neither a mutation report nor the page that carries one`);
    json = text.slice(start + marker.length, end).replaceAll('<"+"', '<');
  }
  try {
    const report = JSON.parse(json);
    if (typeof report.files !== 'object' || report.files === null) throw new Error('it has no files');
    return report;
  } catch (error) {
    throw new Refusal(`${file} does not hold a mutation report: ${error.message}`);
  }
}

/** The mutants nothing killed, in the order of the source. */
function survivorsOf(report, only) {
  const survivors = [];
  for (const [file, data] of Object.entries(report.files)) {
    if (only && !file.includes(only)) continue;
    for (const mutant of data.mutants) {
      if (!KILLED.has(mutant.status)) survivors.push({ file, ...mutant });
    }
  }
  const place = ({ location }) => location.start.line * 1e6 + location.start.column;
  return survivors.sort((a, b) => (a.file === b.file ? place(a) - place(b) : a.file < b.file ? -1 : 1));
}

/**
 * Why the report's spans would not land where Stryker put them, a line for
 * each file: a span is a line and a column in the source the sweep ran on, and
 * means nothing in any other.
 */
function staleFiles(report, survivors) {
  const found = [];
  for (const file of new Set(survivors.map((survivor) => survivor.file))) {
    const at = path.join(ROOT, file);
    if (!existsSync(at)) {
      found.push(`${file} has survivors in the report and is not in this tree.`);
      continue;
    }
    const here = unixLines(readFileSync(at, 'utf8')).split('\n');
    const swept = unixLines(String(report.files[file].source ?? '')).split('\n');
    const line = here.findIndex((text, index) => text !== swept[index]);
    if (line !== -1 || here.length !== swept.length) {
      found.push(`${file} is not the source the report was made from (line ${line === -1 ? Math.min(here.length, swept.length) + 1 : line + 1} differs): check out the commit the sweep ran on.`);
    }
  }
  return found;
}

/** Why the control would not be the mutant it is meant to be. */
function staleControl() {
  const at = path.join(ROOT, CONTROL.file);
  const found = existsSync(at) ? times(readFileSync(at, 'utf8'), CONTROL.original) : 0;
  return found === 1 ? [] : [`the control's anchor \`${CONTROL.original}\` appears ${found} times in ${CONTROL.file}; update CONTROL.`];
}

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

/** The tree as git sees it, copied: what is committed, what is changed and what is new, and nothing git ignores. */
function freeze() {
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const file of listed.split('\0')) {
    // A file deleted and not yet committed is still listed.
    if (file === '' || !existsSync(path.join(ROOT, file))) continue;
    mkdirSync(path.dirname(path.join(FROZEN, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(FROZEN, file));
  }
}

/**
 * Compiles the copy into `outDir`. `--no-install`: the compiler is the one
 * `npm ci` installed, and without it npx stops rather than fetch the
 * registry's `tsc`, which is not the `typescript` package. Type errors do not
 * stop the emit, so this throws for a mutant only on a syntax error.
 */
function build(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  try {
    execSync(`npx --no-install tsc -p "${path.join(SOURCE, 'tsconfig.json')}" --outDir "${outDir}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (!String(error.stdout).includes('error TS')) throw error;
  }
}

function main(argv) {
  const check = argv.includes('--check');
  const [named, only] = argv.filter((argument) => !argument.startsWith('--'));
  const reportPath = named ?? path.join(ROOT, 'reports', 'mutation', 'mutation.json');

  const stale = staleControl();
  let survivors = [];
  if (named !== undefined || !check) {
    const report = readReport(reportPath);
    survivors = survivorsOf(report, only);
    stale.push(...staleFiles(report, survivors));
  }
  if (stale.length > 0) throw new Refusal(stale.join('\n'));

  if (check) {
    const files = new Set(survivors.map((survivor) => survivor.file)).size;
    console.log(`the control finds its anchor in ${CONTROL.file}`);
    if (named !== undefined) console.log(`${survivors.length} survivors in ${files} files of ${path.relative(ROOT, reportPath)}, each in the source the report was made from`);
    return 0;
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  freeze();
  cpSync(path.join(ROOT, 'src'), path.join(SOURCE, 'src'), { recursive: true });
  // Declarations and maps are for people who read a build; the probe runs one.
  writeFileSync(
    path.join(SOURCE, 'tsconfig.json'),
    JSON.stringify({
      extends: path.relative(SOURCE, path.join(ROOT, 'tsconfig.build.json')).replace(/\\/g, '/'),
      compilerOptions: { rootDir: 'src', declaration: false, declarationMap: false, sourceMap: false, noEmitOnError: false },
      include: ['src/**/*.ts'],
    }),
  );
  // The builds live at <WORK>/base and <WORK>/mutant, so `cli.version()` resolves
  // `../package.json` to <WORK>/package.json. Without this the probe measures a
  // broken install - which is a real state, but not the one the package ships in.
  copyFileSync(path.join(ROOT, 'package.json'), path.join(WORK, 'package.json'));

  const env = { ...process.env, ...ripgrep() };
  const probe = (dist, full, timeout) =>
    execFileSync(process.execPath, [path.join(HERE, 'mutation-probe.mjs'), dist, '--corpus', FROZEN, '--full', full], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env, timeout,
    }).trim();

  // The baseline, from the tree exactly as it stands.
  const BASE = path.join(WORK, 'base');
  const MUTANT = path.join(WORK, 'mutant');
  build(BASE);
  const started = Date.now();
  const baseline = probe(BASE, path.join(WORK, 'base.txt'));
  // A mutant that makes a scan stand still never finishes; ten baselines is
  // long enough that a slow machine is not taken for one.
  const patience = Math.max(120_000, (Date.now() - started) * 10);
  const again = probe(BASE, path.join(WORK, 'again.txt'));
  if (again !== baseline) throw new Refusal(`the probe gives two fingerprints for one build, ${baseline} and ${again}: nothing can be measured against it`);
  const before = readFileSync(path.join(WORK, 'base.txt'), 'utf8').split('\n');
  console.log(`baseline ${baseline}, twice\n`);

  /** One mutant written into the copy, compiled and probed; the copy is put back whatever comes of it. */
  const measure = (file, patched) => {
    const copy = path.join(SOURCE, file);
    const source = readFileSync(copy, 'utf8');
    writeFileSync(copy, patched, 'utf8');
    try {
      try {
        build(MUTANT);
      } catch (error) {
        return { verdict: 'BUILD FAILED', detail: String(error.message).slice(0, 200) };
      }
      let digest;
      try {
        digest = probe(MUTANT, path.join(WORK, 'mutant.txt'), patience);
      } catch (error) {
        if (error.code === 'ETIMEDOUT') return { verdict: 'HUNG', detail: `the probe had not finished after ${Math.round(patience / 1000)}s` };
        // A mutant the probe cannot get through is one it tells apart.
        const said = String(error.stderr || error.message).split('\n').find((line) => /Error|mutation-probe:/.test(line)) ?? '';
        return { verdict: 'DISTINGUISHED', detail: `the probe stopped: ${said.trim()}`.slice(0, 300) };
      }
      if (digest === baseline) return { verdict: 'indistinguishable', detail: '' };
      const after = readFileSync(path.join(WORK, 'mutant.txt'), 'utf8').split('\n');
      let changed = 0;
      let first = '';
      for (let line = 0; line < Math.max(before.length, after.length); line++) {
        if (before[line] === after[line]) continue;
        changed += 1;
        if (!first) first = `${(before[line] ?? '(absent)').slice(0, 140)}  ->  ${(after[line] ?? '(absent)').slice(0, 140)}`;
      }
      return { verdict: 'DISTINGUISHED', detail: `${changed} observations differ; first: ${first}` };
    } finally {
      writeFileSync(copy, source, 'utf8');
    }
  };

  const pristine = readFileSync(path.join(SOURCE, CONTROL.file), 'utf8');
  const control = measure(CONTROL.file, pristine.replace(CONTROL.original, () => CONTROL.replacement));
  if (control.verdict !== 'DISTINGUISHED') throw new Refusal(`the control in ${CONTROL.file} is ${control.verdict}: the probe cannot tell a changed answer from the build as it stands`);
  console.log(`control  DISTINGUISHED ${CONTROL.file}: ${control.detail.split(';')[0]}\n`);

  const results = [];
  const began = Date.now();
  for (const [index, mutant] of survivors.entries()) {
    const source = readFileSync(path.join(SOURCE, mutant.file), 'utf8');
    const from = offsetOf(source, mutant.location.start);
    const to = offsetOf(source, mutant.location.end);
    const patched = source.slice(0, from) + mutant.replacement + source.slice(to);
    const label = `${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column} ${mutant.mutatorName}`;
    const { verdict, detail } =
      patched === source ? { verdict: 'NO-OP PATCH', detail: 'replacement equals the original text' } : measure(mutant.file, patched);
    results.push({
      label, verdict, detail, status: mutant.status,
      original: source.slice(from, to).slice(0, 80), replacement: String(mutant.replacement).slice(0, 80),
    });
    console.log(`[${index + 1}/${survivors.length}] ${verdict.padEnd(17)} ${label}`);
    if (verdict !== 'indistinguishable') console.log(`               ${detail}`);
  }

  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const other = results.filter((result) => result.verdict !== 'DISTINGUISHED' && result.verdict !== 'indistinguishable');
  console.log(
    `\n${results.length} survivors in ${Math.round((Date.now() - began) / 1000)}s: ${count('DISTINGUISHED')} distinguished, ${count('indistinguishable')} indistinguishable, ${other.length} other`,
  );
  for (const result of results.filter((one) => one.verdict !== 'indistinguishable')) {
    console.log(`\n${result.verdict}  ${result.label}\n  ${result.original}  ->  ${result.replacement}\n  ${result.detail}`);
  }
  writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  copyFileSync(path.join(WORK, 'base.txt'), path.join(WORK, 'baseline-observations.txt'));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`mutation-equivalence: ${error.message}`);
  process.exitCode = 2;
}
