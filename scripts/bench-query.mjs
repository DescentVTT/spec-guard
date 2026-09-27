#!/usr/bin/env node
/**
 * What each request to `spec-guard mcp` costs, as a client sees it, over a
 * spec set of a given size. ADR-0012.
 *
 *   npm run build && node scripts/bench-query.mjs [--specs 19,130,1300]
 *     [--rounds 50] [--warmup 10] [--cold 5] [--only <text>,...]
 *     [--source <dir>] [--high-priority]
 *
 * For each size it builds a corpus in tests/fixtures/.tmp/bench-query-<pid>,
 * which git ignores: a copy of this repository's src, a package.json holding
 * its specGuard configuration, and the Markdown that configuration names - the
 * documents under docs and README.md - copied until there are that many. The
 * first copy sits where the originals do, so at 19 the corpus is this
 * repository's own spec set; each further copy goes under docs/copy-NNN.
 * ADR-0012's 13, 130 and 1,300 specs were this repository's specs copied once,
 * ten and a hundred times: their bytes and rules are exact multiples.
 * --source replicates the specs of another directory instead, such as an older
 * checkout of this one.
 *
 * Copies repeat the same rules over the same code, so a path the originals
 * govern is governed by every copy of those rules, and its answer grows with
 * the corpus. notes/today.txt is governed by none, which is what a request
 * costs apart from the size of its answer.
 *
 * It starts the server as a client does, `node bin/spec-guard.js mcp --root`
 * the corpus, which reads the configuration there, and speaks the 2026-07-28
 * revision over its stdin and stdout, one request at a time. A request is
 * timed from writing its line to reading the last byte of the response's.
 *
 * - Cold is a server's first request, on a server started for it: every spec
 *   parsed and hashed, and nothing yet compiled by the JIT. Taken --cold times
 *   for each kind of request, each on a new server.
 * - Warm is one server's requests after --warmup untimed rounds, over --rounds
 *   rounds, each asking every kind once in an order that rotates, so whatever
 *   else the machine does falls on every kind alike. After each round one spec
 *   is edited, its rules left as they were, and a query timed: a request after
 *   an edit, which parses that one document again.
 *
 * Medians and 95th percentiles are nearest-rank. "In server" is the duration
 * the tool reports itself, which leaves out the configuration read before it
 * and the serialising and piping after. Figures are for the machine it runs on,
 * printed with them; they are not a gate, and nothing in CI runs this.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(project, 'bin', 'spec-guard.js');
const SCRATCH = path.join(project, 'tests', 'fixtures', '.tmp', `bench-query-${process.pid}`);
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};
// A request that has not answered in this long has hung; waiting longer would hide it.
const REQUEST_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
  const options = { sizes: [19, 130, 1300], rounds: 50, warmup: 10, cold: 5, only: null, source: project, highPriority: false };
  const count = (flag, value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) usage(`${flag} takes a whole number, got "${value}"`);
    return number;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--specs') options.sizes = (index++, value.split(',').map((size) => count(flag, size)));
    else if (flag === '--rounds') options.rounds = count(flag, (index++, value));
    else if (flag === '--warmup') options.warmup = count(flag, (index++, value));
    else if (flag === '--cold') options.cold = count(flag, (index++, value));
    else if (flag === '--only') options.only = (index++, value.split(','));
    else if (flag === '--source') options.source = path.resolve((index++, value));
    else if (flag === '--high-priority') options.highPriority = true;
    else usage(`unknown option "${flag}"`);
  }
  if (options.rounds === 0) usage('--rounds must be at least 1');
  if (options.sizes.some((size) => size === 0)) usage('--specs must name sizes of at least 1');
  return options;
}

function usage(message) {
  console.error(`bench-query: ${message}`);
  console.error('usage: node scripts/bench-query.mjs [--specs 19,130,1300] [--rounds 50] [--warmup 10] [--cold 5] [--only <text>,...] [--source <dir>] [--high-priority]');
  process.exit(2);
}

/* ------------------------------------------------------------------ corpus */

/** The specs to copy: the Markdown under docs and README.md, root-relative, sorted. */
function sourceSpecs(source) {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.md')) found.push(child);
    }
  };
  if (existsSync(path.join(source, 'docs'))) walk('docs');
  if (existsSync(path.join(source, 'README.md'))) found.push('README.md');
  if (found.length === 0) usage(`no specs under ${source}: it holds neither docs nor README.md`);
  return found.sort();
}

/** Writes a corpus of `count` specs, and returns their bytes. */
function buildCorpus(root, count, source, specs) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(path.join(project, 'src'), path.join(root, 'src'), { recursive: true });
  const { specGuard } = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'bench-query-corpus', private: true, specGuard }, null, 2)}\n`);
  const contents = specs.map((relative) => readFileSync(path.join(source, relative)));
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const copy = Math.floor(index / specs.length);
    const relative = specs[index % specs.length];
    const placed = copy === 0 ? relative : `docs/copy-${String(copy).padStart(3, '0')}/${relative.replace(/^docs\//, '')}`;
    mkdirSync(path.dirname(path.join(root, placed)), { recursive: true });
    writeFileSync(path.join(root, placed), contents[index % specs.length]);
    bytes += contents[index % specs.length].length;
  }
  return bytes;
}

/* ------------------------------------------------------------------ server */

/** A server started as a client starts one, and a way to ask it one thing at a time. */
function startServer(root, highPriority) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let prioritised = false;
  if (highPriority) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_HIGH);
      prioritised = true;
    } catch {
      // Refused by the system: the figures are then at normal priority, and the header says so.
    }
  }
  const waiting = new Map();
  let stderr = '';
  let parts = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    // Taken before anything is parsed, so a large answer is timed to its last byte, not past it.
    const arrived = performance.now();
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf('\n', start)) !== -1) {
      parts.push(chunk.slice(start, newline));
      const line = parts.join('');
      parts = [];
      start = newline + 1;
      const message = JSON.parse(line);
      waiting.get(message.id)?.({ arrived, message, size: line.length });
      waiting.delete(message.id);
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
  child.stderr.setEncoding('utf8');
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes('MCP server on stdio')) resolve();
    });
    exited.then((code) => reject(new Error(`the server exited with ${code} before it was ready: ${stderr.trim()}`)));
  });
  ready.catch(() => {});
  let next = 1;

  return {
    ready,
    prioritised,
    async request(method, params) {
      const id = next++;
      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } })}\n`;
      let timer;
      const answered = new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        timer = setTimeout(() => reject(new Error(`${method} did not answer in ${REQUEST_TIMEOUT_MS / 1000} s`)), REQUEST_TIMEOUT_MS);
      });
      const started = performance.now();
      child.stdin.write(line);
      const { arrived, message, size } = await answered.finally(() => clearTimeout(timer));
      if (message.error) throw new Error(`${method} failed: ${message.error.message}`);
      if (message.result.isError) throw new Error(`${method} failed: ${message.result.content[0].text}`);
      return { ms: arrived - started, result: message.result, size };
    },
    async close() {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new Error(`the server exited with ${code}: ${stderr.trim()}`);
    },
    kill: () => child.kill(),
  };
}

/* ---------------------------------------------------------------- requests */

const QUERIED = 'src/parser.ts';
const UNGOVERNED = 'notes/today.txt';
const EDITED = 'README.md';

const KINDS = [
  { label: 'tools/list, which reads no spec', method: 'tools/list', params: {} },
  { label: `get_architectural_rules ${QUERIED}`, method: 'tools/call', params: { name: 'get_architectural_rules', arguments: { path: QUERIED } } },
  { label: `get_architectural_rules ${UNGOVERNED}`, method: 'tools/call', params: { name: 'get_architectural_rules', arguments: { path: UNGOVERNED } } },
  { label: `get_dependents ${QUERIED}`, method: 'tools/call', params: { name: 'get_dependents', arguments: { paths: [QUERIED] } } },
  { label: `check_architecture ${QUERIED}`, method: 'tools/call', params: { name: 'check_architecture', arguments: { paths: [QUERIED] } } },
  { label: 'resources/list', method: 'resources/list', params: {} },
  { label: 'resources/read spec://rules', method: 'resources/read', params: { uri: 'spec://rules' } },
  { label: `resources/read spec://doc/${EDITED}`, method: 'resources/read', params: { uri: `spec://doc/${EDITED}` } },
];
const AFTER_EDIT = { label: `get_architectural_rules ${QUERIED}, after an edit`, method: KINDS[1].method, params: KINDS[1].params };

/** A tool's answer without the one field two identical answers differ in. */
const untimed = (result) => JSON.stringify({ ...result.structuredContent, durationMs: undefined });

/** Nearest-rank percentile. */
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Busy and total processor time so far, over every logical processor. */
function processorTimes() {
  return os.cpus().reduce(
    (sum, { times }) => {
      const total = times.user + times.nice + times.sys + times.irq + times.idle;
      return { busy: sum.busy + total - times.idle, total: sum.total + total };
    },
    { busy: 0, total: 0 },
  );
}

async function measure(size, options, specs) {
  const root = path.join(SCRATCH, String(size));
  const buildStarted = performance.now();
  const bytes = buildCorpus(root, size, options.source, specs);
  const buildMs = performance.now() - buildStarted;
  const selected = (kind) => options.only === null || options.only.some((text) => kind.label.includes(text));
  const kinds = KINDS.filter(selected);
  const samples = new Map([...kinds, AFTER_EDIT].map((kind) => [kind.label, { cold: [], warm: [], server: [], size: 0 }]));
  const servers = [];
  const started = (server) => (servers.push(server), server);

  try {
    for (let round = 0; round < options.cold; round++) {
      for (const kind of kinds) {
        const server = started(startServer(root, options.highPriority));
        await server.ready;
        const { ms, size: answer } = await server.request(kind.method, kind.params);
        await server.close();
        samples.get(kind.label).cold.push(ms);
        samples.get(kind.label).size = answer;
      }
    }

    const server = started(startServer(root, options.highPriority));
    await server.ready;
    const first = {};
    for (const kind of kinds) first[kind.label] = (await server.request(kind.method, kind.params)).result;
    const original = readFileSync(path.join(root, EDITED));
    const edited = path.join(root, EDITED);
    let last = {};
    let processors;
    for (let round = 0; round < options.warmup + options.rounds; round++) {
      const timed = round >= options.warmup;
      if (round === options.warmup) processors = processorTimes();
      for (let offset = 0; offset < kinds.length; offset++) {
        const kind = kinds[(round + offset) % kinds.length];
        const { ms, result, size: answer } = await server.request(kind.method, kind.params);
        const sample = samples.get(kind.label);
        if (timed) {
          sample.warm.push(ms);
          if (typeof result.structuredContent?.durationMs === 'number') sample.server.push(result.structuredContent.durationMs);
        }
        sample.size = answer;
        last[kind.label] = result;
      }
      if (selected(AFTER_EDIT)) {
        // Prose appended after every directive, so the rules and their lines stay as they were.
        writeFileSync(edited, Buffer.concat([original, Buffer.from(`\nAn edit, round ${round}.\n`)]));
        const { ms, result, size: answer } = await server.request(AFTER_EDIT.method, AFTER_EDIT.params);
        const sample = samples.get(AFTER_EDIT.label);
        if (timed) {
          sample.warm.push(ms);
          sample.server.push(result.structuredContent.durationMs);
        }
        sample.size = answer;
      }
    }
    const after = processorTimes();
    writeFileSync(edited, original);
    await server.close();

    const rulesResource = last[KINDS[6].label] ?? first[KINDS[6].label];
    const rules = rulesResource === undefined ? null : JSON.parse(rulesResource.contents[0].text);
    const queried = last[KINDS[1].label] ?? first[KINDS[1].label];
    const tools = kinds.filter((kind) => kind.method === 'tools/call');
    const sameAnswer = tools.length === 0 ? null : tools.every((kind) => untimed(first[kind.label]) === untimed(last[kind.label]));

    return {
      size,
      bytes,
      buildMs,
      rules: rules?.rules.length ?? null,
      governing: queried?.structuredContent.results[0].rules.length ?? null,
      samples,
      sameAnswer,
      // The system counts processor time in ticks, and rounds too short to span one have none to divide.
      busy: processors === undefined || after.total === processors.total ? null : (after.busy - processors.busy) / (after.total - processors.total),
      prioritised: server.prioritised,
    };
  } catch (error) {
    for (const server of servers) server.kill();
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ report */

const fixed = (value) => (value === undefined ? '-' : value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0));
const thousands = (value) => value.toLocaleString('en-US');

function print(outcome, options) {
  const { size, bytes, buildMs, rules, governing, samples, sameAnswer, busy } = outcome;
  const counts = rules === null ? '' : `, ${thousands(rules)} rules in force`;
  const governed = governing === null ? '' : ` (${thousands(governing)} govern ${QUERIED})`;
  console.log(`\n${thousands(size)} specs, ${(bytes / 1024 / 1024).toFixed(1)} MB${counts}${governed}; corpus written in ${(buildMs / 1000).toFixed(1)} s`);
  console.log(`cold: ${options.cold} new servers per request; warm: ${options.rounds} rounds after ${options.warmup}; milliseconds`);
  const width = Math.max(...[...samples.keys()].map((label) => label.length));
  console.log(`${'request'.padEnd(width)}  cold median     p95  warm median     p95  in server   answer`);
  for (const [label, sample] of samples) {
    if (sample.cold.length === 0 && sample.warm.length === 0) continue;
    const cold = sample.cold.length === 0 ? [undefined, undefined] : [percentile(sample.cold, 0.5), percentile(sample.cold, 0.95)];
    const warm = sample.warm.length === 0 ? [undefined, undefined] : [percentile(sample.warm, 0.5), percentile(sample.warm, 0.95)];
    const server = sample.server.length === 0 ? undefined : percentile(sample.server, 0.5);
    console.log(
      `${label.padEnd(width)}  ${fixed(cold[0]).padStart(11)} ${fixed(cold[1]).padStart(7)}  ${fixed(warm[0]).padStart(11)} ${fixed(warm[1]).padStart(7)}  ${fixed(server).padStart(9)}  ${`${Math.ceil(sample.size / 1024)} KB`.padStart(7)}`,
    );
  }
  if (busy !== null) console.log(`the machine was ${(busy * 100).toFixed(0)}% busy over the warm rounds, this benchmark and the server included`);
  if (sameAnswer !== null) console.log(`every tool answered warm exactly as it answered cold: ${sameAnswer ? 'yes' : 'NO'}`);
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(path.join(project, 'dist', 'cli.js'))) usage('dist/cli.js is missing: run "npm run build" first');
const specs = sourceSpecs(options.source);
const cpus = os.cpus();
console.log(
  `node ${process.version}, ${process.platform} ${process.arch}, ${cpus[0]?.model.trim() ?? 'an unknown processor'}, ${cpus.length} logical processors, ` +
    `${Math.round(os.totalmem() / 1024 ** 3)} GB; ${specs.length} specs copied from ${path.relative(project, options.source) || 'this repository'}`,
);
try {
  for (const size of options.sizes) {
    const outcome = await measure(size, options, specs);
    if (options.highPriority && !outcome.prioritised) console.log('\nthe server could not be given high priority; it ran at normal priority');
    print(outcome, options);
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
