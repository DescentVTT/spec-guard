/**
 * Measures where ripgrep starts beating the built-in JavaScript scanner.
 *
 * Spawning a process costs the same whether the tree has ten files or ten
 * thousand; scanning in JavaScript costs proportionally more the bigger the
 * tree gets. Somewhere between those lines there is a crossover, and the
 * `auto` engine should sit on the right side of it. This script finds it
 * rather than guessing.
 *
 *   node scripts/bench-engines.mjs [--sizes 10,100,1000] [--runs 5]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { javascriptEngine, resolveEngine } from '../dist/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.join(ROOT, 'tests', 'fixtures', '.tmp', 'bench-engines');

function parseArgs(argv) {
  const options = { sizes: [5, 25, 50, 100, 250, 500, 1000, 2000], runs: 5 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--sizes') options.sizes = argv[++index].split(',').map(Number);
    if (argv[index] === '--runs') options.runs = Number(argv[++index]);
  }
  return options;
}

/** ~40 lines per file, one unique sentinel per file. */
async function makeTree(root, fileCount) {
  await fs.rm(root, { recursive: true, force: true });
  const perDirectory = 25;
  for (let index = 0; index < fileCount; index++) {
    const directory = path.join(root, 'src', `module${Math.floor(index / perDirectory)}`);
    await fs.mkdir(directory, { recursive: true });
    const body = Array.from({ length: 40 }, (_, line) => `export const value${index}_${line} = ${line};`);
    body.push(`export class Sentinel${index} {}`);
    await fs.writeFile(path.join(directory, `File${index}.ts`), `${body.join('\n')}\n`, 'utf8');
  }
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else bytes += (await fs.stat(full)).size;
    }
  }
  return bytes;
}

async function timeSearch(engine, root, runs) {
  const request = {
    root,
    symbol: 'Sentinel0',
    targets: ['src'],
    options: { regex: false, word: true, ignoreCase: false, globs: [], excludeFiles: new Set() },
  };
  await engine.search(request); // warm the filesystem cache
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    await engine.search(request);
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

const options = parseArgs(process.argv.slice(2));
const ripgrep = await resolveEngine('ripgrep').catch(() => null);
if (!ripgrep) {
  console.error('ripgrep is not available; set SPEC_GUARD_RG or install rg.');
  process.exit(2);
}

console.log(`platform: ${process.platform}  node: ${process.version}  runs: ${options.runs} (median)\n`);
console.log('  files      size      js       rg    winner');
console.log('  ---------------------------------------------');

for (const size of options.sizes) {
  const root = path.join(SCRATCH, String(size));
  const bytes = await makeTree(root, size);
  const js = await timeSearch(javascriptEngine, root, options.runs);
  const rg = await timeSearch(ripgrep, root, options.runs);
  const winner = js < rg ? `js  (${(rg / js).toFixed(1)}x)` : `rg  (${(js / rg).toFixed(1)}x)`;
  console.log(
    `  ${String(size).padStart(5)}  ${(bytes / 1024).toFixed(0).padStart(6)}KB  ${js.toFixed(1).padStart(6)}ms  ${rg
      .toFixed(1)
      .padStart(6)}ms    ${winner}`,
  );
}

await fs.rm(SCRATCH, { recursive: true, force: true });
