/**
 * Names every JavaScript object answers to - `constructor`, `toString`,
 * `__proto__` - written where a person writes a word: an engine's name on
 * the command line or in a configuration, a document's status, a directive's
 * attribute.
 *
 * Each is an unknown word there, and is read as any other unknown word is.
 * The engines were kept as an object, which answered to them: `--engine
 * constructor` was an engine, neither `auto` nor the scanner, and so ran
 * ripgrep. The first half of this file holds that fix.
 *
 * The second half holds what was read safely already and must stay so, since
 * here an unknown word decides whether a rule runs: a status no list holds
 * keeps its document in force (ADR-0010), and an attribute a directive does
 * not take is refused by name, never dropped. Each test reads the name beside
 * a word nothing answers to, and expects the two to be read alike.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { ConfigError, engineNamed, parseConfig, parseStandaloneConfig } from '../src/config.js';
import { ALLOWED_ATTRIBUTES, parseAttributes, parseDirectives, parseStatus } from '../src/parser.js';
import { runSpecGuard } from '../src/runner.js';
import { DEMO_REPO, memoryIo } from './helpers.js';

const NAMES: readonly string[] = ['constructor', 'toString', '__proto__'];

/** A word of the same shape that nothing answers to. */
const PLAIN = 'nonesuch';

const refusal = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was refused');
};

/* ------------------------------------------------------------------ engine */

describe('the name of an engine', () => {
  it('is refused when it is one every object answers to, in the words any unknown name is', () => {
    for (const name of [...NAMES, 'valueOf', 'hasOwnProperty', 'CONSTRUCTOR', PLAIN]) {
      const error = refusal(() => engineNamed(name));
      expect(error, name).toBeInstanceOf(ConfigError);
      expect((error as Error).message, name).toBe(`Unknown engine "${name}". Expected auto, rg or js.`);
    }
  });

  it('is still each engine by each of its names', () => {
    expect(['auto', 'rg', 'ripgrep', 'js', 'javascript', 'node'].map(engineNamed)).toEqual([
      'auto',
      'ripgrep',
      'ripgrep',
      'javascript',
      'javascript',
      'javascript',
    ]);
  });

  it('is refused on the command line as a usage error, where it chose ripgrep', () => {
    for (const name of NAMES) {
      for (const argv of [['--engine', name], [`--engine=${name}`]]) {
        const error = refusal(() => parseArgs(argv, DEMO_REPO));
        expect(error, argv.join(' ')).toBeInstanceOf(UsageError);
        // The flag has always folded its value's case before naming it.
        expect((error as Error).message, argv.join(' ')).toBe(`Unknown engine "${name.toLowerCase()}". Expected auto, rg or js.`);
      }
    }
    expect(parseArgs(['--engine', 'RG'], DEMO_REPO).engine).toBe('ripgrep');
  });

  it('ends a run with exit 2 before any rule is read', async () => {
    for (const name of NAMES) {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, cwd: DEMO_REPO, isTTY: false };
      expect(await main(['--engine', name], io), name).toBe(EXIT_ERROR);
      expect(err.join('\n'), name).toContain(`Unknown engine "${name.toLowerCase()}". Expected auto, rg or js.`);
      expect(out.join('\n'), name).not.toContain('assertion');
    }
  });

  it('is refused in either configuration file, with the file and the key', () => {
    for (const name of NAMES) {
      const standalone = refusal(() => parseStandaloneConfig(JSON.stringify({ engine: name })));
      expect(standalone, name).toBeInstanceOf(ConfigError);
      expect((standalone as Error).message, name).toBe(`.spec-guard.json: "engine": Unknown engine "${name}". Expected auto, rg or js.`);
      const manifest = refusal(() => parseConfig(JSON.stringify({ specGuard: { engine: name } })));
      expect((manifest as Error).message, name).toBe(`package.json: "specGuard.engine": Unknown engine "${name}". Expected auto, rg or js.`);
    }
    expect(parseStandaloneConfig(JSON.stringify({ engine: 'RG' }))).toEqual({ engine: 'ripgrep' });
  });
});

describe('a key of a configuration', () => {
  it('is an unknown option when it is one every object answers to, as any unknown key is', () => {
    for (const key of [...NAMES, PLAIN]) {
      // Written as text: `__proto__` in an object literal would set what the object inherits from, and name no key.
      const error = refusal(() => parseStandaloneConfig(`{ "${key}": true }`));
      expect(error, key).toBeInstanceOf(ConfigError);
      expect((error as Error).message, key).toMatch(new RegExp(`^\\.spec-guard\\.json: unknown option "${key}"\\. Options are specs, `));
      const cited = refusal(() => parseStandaloneConfig(`{ "cites": [{ "id": "ADR-{n}", "files": "docs/adr/{n}-*.md", "${key}": 1 }] }`));
      expect((cited as Error).message, key).toBe(`.spec-guard.json: "cites" entry 1 has an unknown key "${key}"; an entry takes id and files.`);
    }
  });
});

/* -------------------------------------------- what must never go dark */

const ROOT = path.resolve('/object-names');
const CODE = { 'src/app.ts': 'const Legacy = 1;\n' };
const VIOLATION = '<!-- @assert-absence target="src" symbol="Legacy" -->\n';

const run = (document: string) =>
  runSpecGuard({ patterns: ['docs/*.md'], root: ROOT, engine: 'javascript', io: memoryIo(ROOT, { ...CODE, 'docs/adr.md': document }) });

describe('a status that is a name every object answers to', () => {
  /** Every place a status is read from, with the word in it. */
  const FORMS: readonly (readonly [string, (word: string) => string])[] = [
    ['YAML front matter', (word) => `---\nstatus: ${word}\n---\n# ADR\n\n${VIOLATION}`],
    ['TOML front matter', (word) => `+++\nstatus = "${word}"\n+++\n# ADR\n\n${VIOLATION}`],
    ['a Status section', (word) => `# ADR\n\n## Status\n\n${word}\n\n${VIOLATION}`],
    ['a status table', (word) => `# ADR\n\n| Status | ${word} |\n| --- | --- |\n\n${VIOLATION}`],
    ['a Status label', (word) => `# ADR\n\n**Status:** ${word}\n\n${VIOLATION}`],
  ];

  it('is a status no list holds, so the document stays in force, wherever it is written', () => {
    for (const [where, form] of FORMS) {
      for (const word of [...NAMES, 'Constructor', PLAIN]) {
        const status = parseStatus(form(word));
        expect(status?.active, `${where}: ${word}`).toBe(true);
        // The word as a report shows it: its letters, in lower case.
        expect(status?.value, `${where}: ${word}`).toBe(/[a-z]+/i.exec(word)?.[0]?.toLowerCase());
      }
    }
  });

  it('withholds no rule: the violation under it fails the run, as under a word nothing answers to', async () => {
    for (const [where, form] of FORMS) {
      for (const word of [...NAMES, PLAIN]) {
        const result = await run(form(word));
        expect(result.ok, `${where}: ${word}`).toBe(false);
        expect(result.summary, `${where}: ${word}`).toMatchObject({ total: 1, failed: 1, inactive: 0 });
        expect(result.inactiveSpecs, `${where}: ${word}`).toEqual([]);
        expect(result.errors, `${where}: ${word}`).toEqual([]);
      }
    }
  });

  it('is not the status when it is another key of the front matter, whatever that key holds', async () => {
    for (const key of [...NAMES, PLAIN]) {
      // `draft` under any key but `status` withholds nothing.
      expect(parseStatus(`---\n${key}: draft\n---\n# ADR\n`), key).toBeUndefined();
      const result = await run(`---\n${key}: draft\nstatus: accepted\n---\n# ADR\n\n${VIOLATION}`);
      expect(result.summary, key).toMatchObject({ total: 1, failed: 1, inactive: 0 });
    }
  });

  it('still withholds under a status the list holds, so the tests above are not blind', async () => {
    const result = await run(`---\nstatus: draft\n---\n# ADR\n\n${VIOLATION}`);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ total: 0, failed: 0, inactive: 1 });
    expect(result.inactiveSpecs.map((spec) => `${spec.file}: ${spec.status}, ${spec.directives}`)).toEqual(['docs/adr.md: draft, 1']);
  });
});

describe('an attribute that is a name every object answers to', () => {
  const context = { file: path.join(ROOT, 'docs/adr.md'), relativeFile: 'docs/adr.md' };
  const allowed = [...ALLOWED_ATTRIBUTES['assert-absence']].join(', ');

  it('is kept by the reader as an attribute of its own, so it is there to refuse', () => {
    expect(Object.entries(parseAttributes('target="src" constructor="a" toString="b" nonesuch'))).toEqual([
      ['target', 'src'],
      ['constructor', 'a'],
      ['tostring', 'b'],
      ['nonesuch', 'true'],
    ]);
    // An attribute begins with a letter, so the underscores are no part of one.
    expect(Object.entries(parseAttributes('__proto__="a" __nonesuch__="b"'))).toEqual([
      ['proto__', 'a'],
      ['nonesuch__', 'b'],
    ]);
  });

  it('is refused by name on a directive that does not take it, with a value or bare', () => {
    for (const [written, named] of [
      ['constructor', 'constructor'],
      ['toString', 'tostring'],
      ['__proto__', 'proto__'],
      [PLAIN, PLAIN],
    ] as const) {
      for (const attribute of [`${written}="x"`, written]) {
        const parsed = parseDirectives(`<!-- @assert-absence target="src" symbol="Legacy" ${attribute} -->\n`, context);
        expect(parsed.directives, attribute).toEqual([]);
        expect(parsed.errors.map((error) => error.message), attribute).toEqual([
          `Unknown attribute "${named}" on @assert-absence. Allowed: ${allowed}.`,
        ]);
      }
    }
  });

  it('fails the run it is in, and the rule beside it still runs', async () => {
    for (const written of [...NAMES, PLAIN]) {
      const result = await run(`# ADR\n\n<!-- @assert-absence target="src" symbol="Legacy" ${written}="x" -->\n${VIOLATION}`);
      expect(result.ok, written).toBe(false);
      expect(result.errors, written).toHaveLength(1);
      expect(result.summary, written).toMatchObject({ total: 1, failed: 1, inactive: 0 });
    }
  });

  it('names no directive: one written with it is refused when it begins as an assertion, and is a comment otherwise', () => {
    for (const word of [...NAMES, PLAIN]) {
      const parsed = parseDirectives(`<!-- @${word} target="src" -->\n<!-- @assert-${word} target="src" -->\n${VIOLATION}`, context);
      expect(parsed.directives.map((directive) => directive.kind), word).toEqual(['assert-absence']);
      expect(parsed.errors.map((error) => error.message.split('.')[0]), word).toEqual([`Unknown directive "@assert-${word.toLowerCase()}"`]);
    }
  });
});
