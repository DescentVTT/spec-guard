/**
 * Measures where ripgrep starts beating the built-in JavaScript scanner.
 *
 * Spawning a process costs the same whether the tree has ten files or ten
 * thousand; scanning in JavaScript costs proportionally more the bigger the
 * tree gets. Somewhere between those lines there is a crossover, and the
 * `auto` engine should sit on the right side of it. This script finds it
 * rather than guessing.
 *
 *   node scripts/bench-engines.mjs [--sizes 10,100,1000] [--runs 5] [--lines 40] [--common]
 *   node scripts/bench-engines.mjs --run 8x1,1x16 [--sizes 32,512] [--runs 5] [--lines 40]
 *
 * Without `--run`, one literal search over a tree of each size, asked of each
 * engine directly. `--common` searches for a word every file holds, so
 * ripgrep's list is the whole tree and the scanner reads all of it anyway.
 *
 * With `--run GxK`, a whole run through the runner, as the command line makes
 * one: G targets of `size` files each and K rules on each target. Rules on one
 * target share a pass; targets are searched eight at a time, each by a process
 * of its own under ripgrep.
 *
 * Every figure is a median, the engines taken in turn so that a busy stretch
 * slows all three. `auto` is timed beside the two it chooses between, with the
 * engine it chose. ripgrep is `SPEC_GUARD_RG`, or `rg` on PATH. ADR-0004.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { javascriptEngine, resolveEngine, SMALL_TREE_BUDGET } from '../dist/engine.js';
import { runSpecGuard } from '../dist/runner.js';
import { DEFAULT_SCOPE } from '../dist/scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.join(ROOT, 'tests', 'fixtures', '.tmp', `bench-engines-${process.pid}`);
const FILES_PER_DIRECTORY = 25;
const SPEC = 'docs/rules.md';

function parseArgs(argv) {
  const options = { sizes: null, runs: 5, lines: 40, common: false, layouts: [] };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--sizes') options.sizes = argv[++index].split(',').map(Number);
    if (argv[index] === '--runs') options.runs = Number(argv[++index]);
    if (argv[index] === '--lines') options.lines = Number(argv[++index]);
    if (argv[index] === '--common') options.common = true;
    if (argv[index] === '--run') {
      options.layouts = argv[++index].split(',').map((layout) => {
        const [groups, rules] = layout.split('x').map(Number);
        return { groups, rules };
      });
    }
  }
  options.sizes ??= options.layouts.length > 0 ? [8, 32, 128, 512] : [5, 25, 50, 100, 250, 500, 1000, 2000];
  return options;
}

/**
 * `groups` directories under `src`, each of `filesPerGroup` files of `lines`
 * lines and one sentinel no other file holds. Returns the bytes written.
 */
async function makeTree(root, groups, filesPerGroup, lines) {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  const files = [];
  for (let group = 0; group < groups; group++) {
    for (let index = 0; index < filesPerGroup; index++) {
      const body = Array.from({ length: lines }, (_, line) => `export const value${index}_${line} = ${line};`);
      body.push(`export class Sentinel${group}_${index} {}`);
      files.push({
        directory: path.join(root, 'src', `m${group}`, `d${Math.floor(index / FILES_PER_DIRECTORY)}`),
        name: `File${index}.ts`,
        content: `${body.join('\n')}\n`,
      });
    }
  }
  for (const directory of new Set(files.map((file) => file.directory))) await fs.mkdir(directory, { recursive: true });
  let bytes = 0;
  // A few at a time: one by one, 40,000 files take minutes on Windows.
  for (let start = 0; start < files.length; start += 64) {
    await Promise.all(
      files.slice(start, start + 64).map((file) => {
        bytes += file.content.length;
        return fs.writeFile(path.join(file.directory, file.name), file.content, 'utf8');
      }),
    );
  }
  return bytes;
}

const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

/**
 * The median time of each piece of work, and what its last run answered. One
 * untimed run of each first, which warms the filesystem cache and the JIT.
 */
async function timeInTurn(runs, work) {
  const names = Object.keys(work);
  const samples = Object.fromEntries(names.map((name) => [name, []]));
  const answers = {};
  for (const name of names) await work[name]();
  for (let run = 0; run < runs; run++) {
    for (const name of names) {
      const started = performance.now();
      answers[name] = await work[name]();
      samples[name].push(performance.now() - started);
    }
  }
  return { times: Object.fromEntries(names.map((name) => [name, median(samples[name])])), answers };
}

/** What starting ripgrep costs before it has searched anything: the fixed toll. */
async function spawnFloor(binary, runs = 20) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const child = spawn(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('close', resolve);
    });
    samples.push(performance.now() - started);
  }
  return median(samples);
}

function ripgrepVersion(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.once('error', () => resolve('unknown'));
    child.once('close', () => resolve(out.split('\n')[0].trim()));
  });
}

const ms = (value) => `${value.toFixed(1)} ms`;
const size = (bytes) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function row(cells) {
  console.log(`| ${cells.join(' | ')} |`);
}

function verdict(times) {
  const { javascript, ripgrep } = times;
  return javascript < ripgrep ? `scanner, ${(ripgrep / javascript).toFixed(1)}x` : `ripgrep, ${(javascript / ripgrep).toFixed(1)}x`;
}

/** One literal search over `src`, asked of each engine directly. */
async function benchSearches(options, ripgrep) {
  console.log(`\n### One search over src${options.common ? ', for a word every file holds' : ''} (${options.lines} lines a file)\n`);
  row(['files', 'size', 'scanner', 'ripgrep', 'auto', 'auto chose', 'faster']);
  row(['---:', '---:', '---:', '---:', '---:', '---', '---']);
  for (const files of options.sizes) {
    const root = path.join(SCRATCH, `search-${files}`);
    const bytes = await makeTree(root, 1, files, options.lines);
    const request = {
      root,
      symbol: options.common ? 'export' : 'Sentinel0_0',
      targets: ['src'],
      options: {
        regex: false,
        word: true,
        ignoreCase: false,
        globs: [],
        excludeGlobs: [],
        ignoreComments: false,
        scope: DEFAULT_SCOPE,
        excludeFiles: new Set(),
      },
    };
    const { times, answers } = await timeInTurn(options.runs, {
      javascript: () => javascriptEngine.search(request),
      ripgrep: () => ripgrep.search(request),
      // A new one each time: an adaptive engine keeps its probe of a tree.
      auto: async () => (await resolveEngine('auto')).search(request),
    });
    const counts = new Set(Object.values(answers).map((answer) => answer.count));
    if (counts.size !== 1) throw new Error(`the engines disagree over ${files} files: ${JSON.stringify([...counts])}`);
    row([files, size(bytes), ms(times.javascript), ms(times.ripgrep), ms(times.auto), answers.auto.engine, verdict(times)]);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** A run of `groups` targets, `rules` rules on each, over trees of each size. */
async function benchRuns(options, layout) {
  const { groups, rules } = layout;
  console.log(`\n### A run of ${groups * rules} rules: ${groups} ${groups === 1 ? 'target' : 'targets'}, ${rules} on each (${options.lines} lines a file)\n`);
  row(['files a target', 'files', 'size', 'scanner', 'ripgrep', 'auto', 'auto chose', 'faster']);
  row(['---:', '---:', '---:', '---:', '---:', '---:', '---', '---']);
  for (const files of options.sizes) {
    const root = path.join(SCRATCH, `run-${groups}x${rules}-${files}`);
    const bytes = await makeTree(root, groups, files, options.lines);
    const directives = [];
    for (let group = 0; group < groups; group++) {
      for (let rule = 0; rule < rules; rule++) {
        directives.push(`<!-- @assert-absence target="src/m${group}" symbol="Forbidden${rule}" -->`);
      }
    }
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, SPEC), `# Rules\n\n${directives.join('\n')}\n`, 'utf8');

    const run = (engine) => () => runSpecGuard({ patterns: [SPEC], root, engine });
    const { times, answers } = await timeInTurn(options.runs, {
      javascript: run('javascript'),
      ripgrep: run('ripgrep'),
      auto: run('auto'),
    });
    for (const [engine, answer] of Object.entries(answers)) {
      const { total, passed } = answer.summary;
      if (!answer.ok || total !== groups * rules || passed !== total) {
        throw new Error(`${engine} over ${groups}x${rules} at ${files} files: ${JSON.stringify(answer.summary)} ${JSON.stringify(answer.warnings)}`);
      }
    }
    row([files, groups * files, size(bytes), ms(times.javascript), ms(times.ripgrep), ms(times.auto), answers.auto.engine, verdict(times)]);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const options = parseArgs(process.argv.slice(2));
const binary = process.env.SPEC_GUARD_RG || 'rg';
const ripgrep = await resolveEngine('ripgrep').catch(() => null);
if (!ripgrep) {
  console.error('ripgrep is not available; set SPEC_GUARD_RG or install rg.');
  process.exit(2);
}

const cpus = os.cpus();
console.log(`platform: ${process.platform} ${os.release()} ${process.arch}, ${cpus[0]?.model.trim() ?? 'unknown'} x${cpus.length}`);
console.log(`node: ${process.version}  ripgrep: ${await ripgrepVersion(binary)} (${binary})`);
console.log(`starting ripgrep: ${ms(await spawnFloor(binary))} (median of 20)`);
console.log(`auto scans in process up to ${SMALL_TREE_BUDGET.maxFiles} files and ${size(SMALL_TREE_BUDGET.maxBytes)}`);
console.log(`runs: ${options.runs} (median, engines in turn)`);

try {
  if (options.layouts.length === 0) await benchSearches(options, ripgrep);
  for (const layout of options.layouts) await benchRuns(options, layout);
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true, maxRetries: 3 });
}
