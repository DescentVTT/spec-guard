/**
 * Every regex mutant Stryker would generate for the status reader, applied by
 * hand.
 *
 * A regex literal at module scope is a static mutant: Stryker cannot attribute
 * it to the tests that cover it, so it runs the whole suite against it, and a
 * test that fails for any reason at all is scored a kill. On a loaded machine a
 * subprocess test that hits vitest's 30s timeout fails against every mutant,
 * and a local sweep of these patterns once reported 100% over eleven mutants CI
 * then found alive. ADR-0003 has the whole account.
 *
 * So these are not left to a sweep. weapon-regex at mutation level 1 - the
 * generator and the level Stryker's regex mutator uses - produces each mutant;
 * this writes it into the real source, runs only the suites that read a status,
 * and restores the file whatever happens.
 *
 * The table below is the patterns as written. When one changes, the harness
 * refuses to run until it is updated, rather than quietly mutating nothing.
 *
 *   node scripts/mutation-regex.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Stryker's own dependency, not a direct one of this package, and deliberately
// so: a separately pinned copy could drift from the generator the gate uses.
import * as weapon from 'weapon-regex';

const FILE = 'src/parser.ts';
const SUITE = 'tests/spec-status.test.ts tests/parser.test.ts tests/parser-contracts.test.ts';

const LITERALS = [
  ['FRONTMATTER_RE', String.raw`^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)`, ''],
  ['STATUS_LABEL_RE', String.raw`^[ \t]{0,3}(?:(\*\*|__)status(?:\1[ \t]*:|[ \t]*:\1)|status[ \t]*:)(.*)`, 'i'],
  ['yamlScalar quoted', String.raw`^(["'])(.*?)\1`, ''],
  ['yamlScalar comment', String.raw`\s#.*`, ''],
  ['STATUS_HEADING_RE', String.raw`^[ \t]{0,3}#{1,6}[ \t]+status[ \t]*#*[ \t]*$`, 'i'],
  ['SECTION_HEADING_RE', String.raw`^[ \t]{0,3}#{2,6}[ \t]`, ''],
  ['toStatus word', String.raw`^[*_]*([a-zA-Z]+)`, ''],
  ['toStatus unwrap', String.raw`^(\*{1,2}|_{1,2})(.*)\1$`, ''],
  ['toLines', String.raw`\r?\n`, ''],
];

const original = readFileSync(FILE, 'utf8');

for (const [name, pattern, flags] of LITERALS) {
  const occurrences = original.split(`/${pattern}/${flags}`).length - 1;
  if (occurrences !== 1) {
    console.error(`${name}: /${pattern}/${flags} appears ${occurrences} times in ${FILE}; update the table.`);
    process.exit(2);
  }
}

let killed = 0;
let invalid = 0;
const alive = [];

try {
  for (const [name, pattern, flags] of LITERALS) {
    const literal = `/${pattern}/${flags}`;
    for (const mutant of weapon.mutate(pattern, flags, { mutationLevels: [1] })) {
      try {
        new RegExp(mutant.pattern, flags);
      } catch {
        // Throws at import, so every test fails. Counted apart so an invalid
        // pattern can never pad the kills.
        invalid++;
        continue;
      }
      writeFileSync(FILE, original.replace(literal, `/${mutant.pattern}/${flags}`));
      try {
        execSync(`npx vitest run ${SUITE}`, { stdio: 'pipe', timeout: 300_000 });
        alive.push(`${name}: ${mutant.description}  =>  /${mutant.pattern}/${flags}`);
        console.log(`ALIVE   ${alive.at(-1)}`);
      } catch {
        killed++;
        console.log(`killed  ${name}: ${mutant.description}`);
      }
    }
  }
} finally {
  writeFileSync(FILE, original);
}

console.log(`\n${killed} killed, ${alive.length} alive, ${invalid} invalid (not run); ${FILE} restored`);
process.exitCode = alive.length === 0 ? 0 : 1;
