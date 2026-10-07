/**
 * Every regex mutant Stryker would generate for the parser, applied by hand.
 *
 * A regex literal at module scope is a static mutant: Stryker cannot attribute
 * it to the tests that cover it, so it runs the whole suite against it, and a
 * test that fails for any reason at all is scored a kill. On a loaded machine a
 * subprocess test that hits vitest's timeout fails against every mutant, and a
 * local sweep of the status reader's patterns once reported 100% over eleven
 * mutants CI then found alive. ADR-0003 has the whole account.
 *
 * So these are not left to a sweep. weapon-regex at mutation level 1 - the
 * generator and the level Stryker's regex mutator uses - produces each mutant;
 * this writes it into a copy of the tree under reports/regex, runs there only
 * the suites that read a spec, and leaves the tree itself as it was. A mutant
 * is killed when a test fails on it: the suite has to pass on the copy first,
 * and a test that ran out of time is counted apart.
 *
 * The table below is the patterns as written, and every one the file holds.
 * When one changes, goes or arrives, the harness refuses to run until the
 * table is updated, rather than quietly mutating nothing. From 0.12.0 to
 * 0.19.1 it refused, and nothing ran it to say so: the status reader had moved
 * onto spec-core's scanner and six of the nine patterns then on the table had
 * gone with it. `--check` is that refusal on its own, in under a second, and
 * tests/replay-scripts.test.ts runs it.
 *
 *   node scripts/mutation-regex.mjs [name]     replay every mutant, or those of the patterns so named
 *   node scripts/mutation-regex.mjs --check [--source <file>]
 */
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stryker's own dependencies, not direct ones of this package, and deliberately
// so: separately pinned copies could drift from the parser and the generator
// the gate uses.
import { parse } from '@babel/parser';
import * as weapon from 'weapon-regex';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'reports', 'regex');
const TREE = path.join(WORK, 'tree');

const FILE = 'src/parser.ts';
const SUITE = ['tests/spec-status.test.ts', 'tests/parser.test.ts', 'tests/parser-contracts.test.ts'];

// The patterns src/vendor/spec-core holds are not here: front matter, headings
// and lines are read by spec-core's scanner now, which this repository copies
// and never mutates (ADR-0015). Its own sweep holds them.
const LITERALS = [
  ['STATUS_LABEL_RE', String.raw`^[ \t]{0,3}(?:(\*\*|__)status(?:\1[ \t]*:|[ \t]*:\1)|status[ \t]*:)(.*)`, 'i'],
  ['toStatus word', String.raw`^[*_]*([a-zA-Z]+)`, ''],
  ['unwrapped', String.raw`^(\*{1,2}|_{1,2})(.*)\1$`, ''],
  ['TOML_BARE_KEY', String.raw`[A-Za-z0-9_-]`, ''],
  ['tomlStatus hex', String.raw`^[0-9A-Fa-f]+$`, ''],
  ['DIRECTIVE_RE', String.raw`<!--\s*@([a-zA-Z][\w-]*)([\s\S]*?)-->`, 'g'],
  ['DIRECTIVE_SHAPE_RE', String.raw`<!--\s*@([a-zA-Z][\w-]*)`, 'g'],
  ['ATTRIBUTE_RE', String.raw`([a-zA-Z][\w-]*)(?:\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'=<>` + '`' + String.raw`]+)))?`, 'g'],
  ['unescape', String.raw`\\(["'\\])`, 'g'],
];

/** Every regex the source holds, as Stryker's parser reads it: a literal, or a string handed to `new RegExp`. */
function patternsIn(source) {
  const found = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'RegExpLiteral') {
      found.push({ pattern: node.pattern, flags: node.flags, start: node.start, end: node.end, line: node.loc.start.line });
    } else if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'RegExp' && node.arguments[0]?.type === 'StringLiteral') {
      // Mutated by Stryker as a literal is, and not something this harness can
      // write back as one: it is listed so that the table is told about it.
      found.push({ pattern: node.arguments[0].value, flags: node.arguments[1]?.value ?? '', line: node.loc.start.line });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments' && key !== 'innerComments') visit(child);
    }
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program);
  return found;
}

const sameAs = (pattern, flags) => (held) => held.pattern === pattern && held.flags === flags;

/** The mutants weapon-regex makes of one pattern that are still patterns. One that is not throws at import, and is no kill. */
function mutantsOf(pattern, flags) {
  const valid = [];
  let invalid = 0;
  for (const mutant of weapon.mutate(pattern, flags, { mutationLevels: [1] })) {
    try {
      new RegExp(mutant.pattern, flags);
      valid.push(mutant);
    } catch {
      invalid += 1;
    }
  }
  return { valid, invalid };
}

/** Why the table cannot be replayed against `source`, one line for each reason; none when it can. */
function problems(source, file) {
  const held = patternsIn(source);
  const found = [];
  for (const [name, pattern, flags] of LITERALS) {
    const occurrences = held.filter(sameAs(pattern, flags));
    if (occurrences.length !== 1 || occurrences[0].start === undefined) {
      found.push(`${name}: /${pattern}/${flags} appears ${occurrences.filter((one) => one.start !== undefined).length} times as a literal in ${file}; update the table.`);
    } else if (mutantsOf(pattern, flags).valid.length === 0) {
      found.push(`${name}: weapon-regex makes no mutant of /${pattern}/${flags} that can be run.`);
    }
  }
  for (const { pattern, flags, line } of held) {
    if (!LITERALS.some(([, listed, listedFlags]) => listed === pattern && listedFlags === flags)) {
      found.push(`${file}:${line} holds /${pattern}/${flags}, which is not on the table: add it, so that its mutants are replayed.`);
    }
  }
  for (const suite of SUITE) {
    if (!existsSync(path.join(ROOT, suite))) found.push(`${suite} is not there to run.`);
  }
  return found;
}

/** The tree as git sees it, copied: what is committed, what is changed and what is new, and nothing git ignores. */
function copyTree() {
  rmSync(WORK, { recursive: true, force: true });
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const file of listed.split('\0')) {
    // A file deleted and not yet committed is still listed.
    if (file === '' || !existsSync(path.join(ROOT, file))) continue;
    mkdirSync(path.dirname(path.join(TREE, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(TREE, file));
  }
}

/** One run of the suites in the copy: whether it passed, and whether a failure was a test running out of time. */
function runSuite() {
  try {
    // `--no-install`: the suite runs with the vitest `npm ci` installed, and
    // without one npx stops rather than fetch whatever the registry has under
    // the name. `.npmrc` says the same for every command (tests/npm.test.ts).
    execSync(`npx --no-install vitest run --root "${TREE}" ${SUITE.join(' ')}`, { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
    return { passed: true, timedOut: false, output: '' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return { passed: false, timedOut: error.code === 'ETIMEDOUT' || /Test timed out in \d+ms/.test(output), output };
  }
}

function main(argv) {
  const sourceIndex = argv.indexOf('--source');
  const sourceAt = sourceIndex === -1 ? path.join(ROOT, FILE) : path.resolve(argv[sourceIndex + 1] ?? '');
  const check = argv.includes('--check');
  const only = argv.find((argument, index) => !argument.startsWith('--') && (sourceIndex === -1 || index !== sourceIndex + 1));
  // A replay mutates the copy of the tree's own file, so another source is one to check only.
  if (sourceIndex !== -1 && !check) {
    console.error('usage: node scripts/mutation-regex.mjs [name] | --check [--source <file>]');
    return 2;
  }

  const original = readFileSync(sourceAt, 'utf8');
  const found = problems(original, check ? path.relative(ROOT, sourceAt).replace(/\\/g, '/') : FILE);
  if (found.length > 0) {
    for (const problem of found) console.error(problem);
    return 2;
  }
  const held = patternsIn(original);
  const table = LITERALS.map(([name, pattern, flags]) => ({ name, pattern, flags, at: held.find(sameAs(pattern, flags)), ...mutantsOf(pattern, flags) }));
  const total = table.reduce((sum, entry) => sum + entry.valid.length, 0);

  if (check) {
    for (const entry of table) console.log(`${FILE}:${String(entry.at.line).padEnd(4)} ${entry.name.padEnd(19)} ${String(entry.valid.length).padStart(2)} mutants`);
    console.log(`\n${table.length} patterns, every one ${FILE} holds, and ${total} mutants of them; ${SUITE.length} suites to run them against`);
    return 0;
  }

  const chosen = table.filter((entry) => only === undefined || entry.name.includes(only));
  if (chosen.length === 0) {
    console.error(`No pattern on the table is named "${only}": ${table.map((entry) => entry.name).join(', ')}.`);
    return 2;
  }

  copyTree();
  const copy = path.join(TREE, FILE);
  const baseline = runSuite();
  if (!baseline.passed) {
    console.error(`The suites fail on ${FILE} as it stands, so a failure on a mutant would say nothing:\n${baseline.output.slice(-2000)}`);
    return 2;
  }

  let killed = 0;
  let invalid = 0;
  const alive = [];
  const timedOut = [];
  const started = Date.now();
  for (const { name, flags, at, valid, invalid: unrunnable } of chosen) {
    invalid += unrunnable;
    for (const mutant of valid) {
      writeFileSync(copy, `${original.slice(0, at.start)}/${mutant.pattern}/${flags}${original.slice(at.end)}`);
      const run = runSuite();
      const label = `${name}: ${mutant.description}  =>  /${mutant.pattern}/${flags}`;
      if (run.passed) {
        alive.push(label);
        console.log(`ALIVE   ${label}`);
      } else if (run.timedOut) {
        timedOut.push(label);
        console.log(`TIMEOUT ${label}`);
      } else {
        killed += 1;
        console.log(`killed  ${name}: ${mutant.description}`);
      }
    }
  }
  writeFileSync(copy, original);

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `\n${killed} killed, ${alive.length} alive, ${timedOut.length} timed out, ${invalid} invalid (not run), of ${chosen.length} patterns in ${seconds}s; mutated in ${path.relative(ROOT, copy)}, ${FILE} untouched`,
  );
  return alive.length === 0 && timedOut.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
