/**
 * Options in package.json, under "specGuard", or in .spec-guard.json. ADR-0014.
 *
 * Two claims. A configuration is validated before anything runs, and every way
 * it can be malformed is refused in words naming the file and the key. And the
 * command line wins over it in both directions, with every run saying what it
 * took from the file - so an option nobody can see never decides a result.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import { applyConfig, EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError, version, type CliIO } from '../src/cli.js';
import {
  CONFIG_KEYS,
  ConfigError,
  engineNamed,
  CONFIG_FILE,
  findConfig,
  INVOCATION_OPTIONS,
  loadConfig,
  parseConfig,
  parseStandaloneConfig,
  type ProjectConfig,
} from '../src/config.js';
import { formatConfigUse, formatOptionLines } from '../src/reporter.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** A package.json holding these options. */
const manifest = (options: unknown): string => JSON.stringify({ name: 'x', [ 'specGuard' ]: options });

function refusal(text: string): string {
  try {
    parseConfig(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be refused');
}

/* ------------------------------------------------------------- parseConfig */

describe('parseConfig', () => {
  it('reads no configuration from a package.json that says nothing', () => {
    expect(parseConfig('{"name":"x"}')).toEqual({});
    // Something that is not an object has no "specGuard" in it either.
    for (const text of ['[]', '"specGuard"', 'null', '3']) expect(parseConfig(text), text).toEqual({});
  });

  it('keeps exactly the keys it was given, and invents no defaults', () => {
    expect(parseConfig(manifest({}))).toEqual({});
    expect(parseConfig(manifest({ strict: false }))).toEqual({ strict: false });
    const everything = {
      specs: ['docs/**/*.md', 'README.md'],
      exclude: ['target', 'dist/**'],
      engine: 'js',
      strict: true,
      allowMissingTargets: false,
      allowEmptyScope: true,
      ignoreStatus: false,
      includeSpecs: true,
      defaultSkips: false,
      maxSnippets: 0,
      concurrency: 1,
      cites: [{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }],
    };
    expect(parseConfig(manifest(everything))).toEqual({ ...everything, engine: 'javascript' });
    expect(Object.keys(everything)).toEqual(CONFIG_KEYS);
  });

  it('reads an engine by any name the flag accepts, in any case', () => {
    expect(parseConfig(manifest({ engine: 'RG' }))).toEqual({ engine: 'ripgrep' });
    expect(parseConfig(manifest({ engine: 'node' }))).toEqual({ engine: 'javascript' });
    expect(parseConfig(manifest({ engine: 'auto' }))).toEqual({ engine: 'auto' });
  });

  it('refuses text that is not JSON, and says the options could not be read', () => {
    expect(refusal('{"specGuard": {')).toMatch(/^package\.json is not valid JSON \(.+\), so its "specGuard" options cannot be read\.$/);
  });

  it('refuses a "specGuard" that is not an object, naming what it is', () => {
    expect(refusal(manifest([]))).toBe('package.json: "specGuard" must be an object, got an array.');
    expect(refusal(manifest(null))).toBe('package.json: "specGuard" must be an object, got null.');
    expect(refusal(manifest('strict'))).toBe('package.json: "specGuard" must be an object, got "strict".');
    expect(refusal(manifest(true))).toBe('package.json: "specGuard" must be an object, got true.');
  });

  it('refuses an unknown key, and lists the keys there are', () => {
    expect(refusal(manifest({ stict: true }))).toBe(
      'package.json: unknown option "stict" in "specGuard". Options are specs, exclude, engine, strict, allowMissingTargets, allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips, maxSnippets, concurrency, cites.',
    );
    // Not a way to reach an object's prototype, either.
    expect(refusal('{"specGuard": {"__proto__": {"strict": true}}}')).toMatch(/^package\.json: unknown option "__proto__"/);
  });

  it('refuses each option that belongs to one invocation, by name', () => {
    expect([...INVOCATION_OPTIONS]).toEqual(['root', 'format', 'json', 'verbose', 'color', 'failFast', 'printBaseline', 'allowEmpty', 'watch']);
    for (const key of INVOCATION_OPTIONS) {
      expect(refusal(manifest({ [key]: true }))).toBe(`package.json: "specGuard.${key}" is chosen on the command line, not in package.json.`);
    }
  });

  it('refuses a boolean written as anything but true or false', () => {
    for (const key of ['strict', 'allowMissingTargets', 'allowEmptyScope', 'ignoreStatus', 'includeSpecs', 'defaultSkips']) {
      expect(refusal(manifest({ [key]: 'yes' }))).toBe(`package.json: "specGuard.${key}" must be true or false, got "yes".`);
      expect(refusal(manifest({ [key]: 1 }))).toBe(`package.json: "specGuard.${key}" must be true or false, got 1.`);
    }
  });

  it('refuses specs that are not a non-empty list of globs', () => {
    for (const specs of [[], 'docs/**/*.md', ['docs/**/*.md', 3], ['  '], [''], null]) {
      expect(refusal(manifest({ specs })), JSON.stringify(specs)).toMatch(/^package\.json: "specGuard\.specs" must be a non-empty list of spec globs, got /);
    }
    expect(refusal(manifest({ specs: 'docs' }))).toBe('package.json: "specGuard.specs" must be a non-empty list of spec globs, got "docs".');
    expect(refusal(manifest({ specs: [] }))).toBe('package.json: "specGuard.specs" must be a non-empty list of spec globs, got an array.');
  });

  it('reads exclude as a list of paths, which may be empty, and refuses anything else', () => {
    expect(parseConfig(manifest({ exclude: ['target', 'bin', 'obj/**'] }))).toEqual({ exclude: ['target', 'bin', 'obj/**'] });
    expect(parseConfig(manifest({ exclude: [] }))).toEqual({ exclude: [] });
    for (const exclude of ['target', ['target', 3], [''], ['  '], null, { target: true }]) {
      expect(refusal(manifest({ exclude })), JSON.stringify(exclude)).toMatch(/^package\.json: "specGuard\.exclude" must be a list of paths or globs to exclude, got /);
    }
    expect(refusal(manifest({ exclude: 'target' }))).toBe('package.json: "specGuard.exclude" must be a list of paths or globs to exclude, got "target".');
  });

  // A list pasted from .gitignore kept "build" and silently dropped the "!"
  // line re-including one file, so the exclusion was wider than it read.
  it('refuses an exclude pattern that could never exclude anything, naming the first', () => {
    expect(refusal(manifest({ exclude: ['build', '!build/generated/needed.ts', '../shared'] }))).toBe(
      'package.json: "specGuard.exclude" has an invalid exclude pattern "!build/generated/needed.ts": negation patterns are not supported in exclude.',
    );
    expect(refusal(manifest({ exclude: ['../shared'] }))).toBe(
      'package.json: "specGuard.exclude" has an invalid exclude pattern "../shared": ".." leads out of the root, and only paths inside it are searched.',
    );
    expect(() => parseStandaloneConfig(JSON.stringify({ exclude: ['target', 'C:/repo/bin'] }))).toThrow(
      new ConfigError('.spec-guard.json: "exclude" has an invalid exclude pattern "C:/repo/bin": exclusions are relative to the root, and a drive path is not.'),
    );
    expect(parseConfig(manifest({ exclude: ['/target', './bin', 'obj/', 'src\\gen'] }))).toEqual({ exclude: ['/target', './bin', 'obj/', 'src\\gen'] });
  });

  it('refuses an engine that is not a string, or not an engine, in the flag\'s own words', () => {
    expect(refusal(manifest({ engine: 3 }))).toBe('package.json: "specGuard.engine" must be a string, got 3.');
    expect(refusal(manifest({ engine: 'rgg' }))).toBe('package.json: "specGuard.engine": Unknown engine "rgg". Expected auto, rg or js.');
    expect(() => parseArgs(['--engine', 'rgg'], process.cwd())).toThrow(new UsageError('Unknown engine "rgg". Expected auto, rg or js.'));
  });

  it('refuses counts that are not whole numbers in range, or are numbers written as strings', () => {
    expect(parseConfig(manifest({ maxSnippets: 0, concurrency: 1 }))).toEqual({ maxSnippets: 0, concurrency: 1 });
    expect(refusal(manifest({ maxSnippets: -1 }))).toBe('package.json: "specGuard.maxSnippets" must be an integer, 0 or more, got -1.');
    expect(refusal(manifest({ maxSnippets: 1.5 }))).toBe('package.json: "specGuard.maxSnippets" must be an integer, 0 or more, got 1.5.');
    expect(refusal(manifest({ maxSnippets: '2' }))).toBe('package.json: "specGuard.maxSnippets" must be an integer, 0 or more, got "2".');
    expect(refusal(manifest({ concurrency: 0 }))).toBe('package.json: "specGuard.concurrency" must be an integer, 1 or more, got 0.');
    expect(refusal(manifest({ concurrency: { n: 2 } }))).toBe('package.json: "specGuard.concurrency" must be an integer, 1 or more, got an object.');
  });

  it('reads cites as a list of id and files entries, each held to the template rules, and refuses anything else by entry', () => {
    const families = [
      { id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' },
      { id: 'RFC {n}', files: 'rfcs/rfc-{n}.md' },
    ];
    expect(parseConfig(manifest({ cites: families }))).toEqual({ cites: families });
    const cases: Array<[unknown, string]> = [
      [[], 'must be a non-empty list of entries such as { "id": "ADR-{n}", "files": "docs/adr/{n}-*.md" }, got an array'],
      [{ id: 'ADR-{n}' }, 'must be a non-empty list of entries such as { "id": "ADR-{n}", "files": "docs/adr/{n}-*.md" }, got an object'],
      ['ADR-{n}', 'must be a non-empty list of entries such as { "id": "ADR-{n}", "files": "docs/adr/{n}-*.md" }, got "ADR-{n}"'],
      [[families[0], 'ADR-{n}'], 'entry 2 must be an object with "id" and "files", got "ADR-{n}"'],
      [[[1]], 'entry 1 must be an object with "id" and "files", got an array'],
      [[null], 'entry 1 must be an object with "id" and "files", got null'],
      [[{ id: 'ADR-{n}', files: 'd/{n}.md', glob: '*.md' }], 'entry 1 has an unknown key "glob"; an entry takes id and files'],
      [[{ files: 'd/{n}.md' }], 'entry 1 needs "id" as a string, got undefined'],
      [[{ id: 'ADR-{n}', files: 7 }], 'entry 1 needs "files" as a string, got 7'],
      [[{ id: 'ADR', files: 'd/{n}.md' }], 'entry 1: "ADR" has no {n}: an id template says where the number goes, as in ADR-{n}'],
      [[{ id: 'ADR-{n}', files: 'd/*.md' }], 'entry 1: "d/*.md" has no {n}: a files template says where the number is, as in docs/adr/{n}-*.md'],
    ];
    for (const [cites, issue] of cases) {
      expect(refusal(manifest({ cites })), JSON.stringify(cites)).toBe(`package.json: "specGuard.cites" ${issue}.`);
    }
    expect(() => parseStandaloneConfig(JSON.stringify({ cites: [{ id: '{n}', files: 'd/{n}.md' }] }))).toThrow(
      new ConfigError('.spec-guard.json: "cites" entry 1: "{n}" has nothing before {n}, so every number in every comment would be a citation.'),
    );
  });

  it('names the file it was told it is reading', () => {
    expect(() => parseConfig('{"specGuard": 1}', 'packages/a/package.json')).toThrow('packages/a/package.json: "specGuard" must be an object, got 1.');
    expect(() => parseConfig('{"specGuard": {"root": "."}}', 'x.json')).toThrow('x.json: "specGuard.root" is chosen on the command line, not in x.json.');
  });
});

describe('parseStandaloneConfig', () => {
  const standalone = (text: string): string => {
    try {
      parseStandaloneConfig(text);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error('expected the configuration to be refused');
  };

  it('reads the options at the top level, validated as those in package.json are', () => {
    expect(CONFIG_FILE).toBe('.spec-guard.json');
    expect(parseStandaloneConfig('{}')).toEqual({});
    expect(parseStandaloneConfig(JSON.stringify({ specs: ['docs/*.md'], exclude: ['target'], engine: 'rg', strict: true }))).toEqual({
      specs: ['docs/*.md'],
      exclude: ['target'],
      engine: 'ripgrep',
      strict: true,
    });
  });

  it('names the file and the key, without the package.json nesting, in every refusal', () => {
    expect(standalone('{ "strict": ')).toMatch(/^\.spec-guard\.json is not valid JSON \(.+\), so its options cannot be read\.$/);
    expect(standalone('[]')).toBe('.spec-guard.json must hold an object of options, got an array.');
    expect(standalone('null')).toBe('.spec-guard.json must hold an object of options, got null.');
    expect(standalone('{"stict": true}')).toBe(`.spec-guard.json: unknown option "stict". Options are ${CONFIG_KEYS.join(', ')}.`);
    // The package.json form, copied over whole, is the likeliest mistake.
    expect(standalone('{"specGuard": {"strict": true}}')).toMatch(/^\.spec-guard\.json: unknown option "specGuard"\./);
    expect(standalone('{"format": "sarif"}')).toBe('.spec-guard.json: "format" is chosen on the command line, not in .spec-guard.json.');
    expect(standalone('{"strict": "yes"}')).toBe('.spec-guard.json: "strict" must be true or false, got "yes".');
    expect(standalone('{"engine": "rgg"}')).toBe('.spec-guard.json: "engine": Unknown engine "rgg". Expected auto, rg or js.');
  });
});

describe('engineNamed', () => {
  it('knows every name for every engine, in any case', () => {
    expect(['auto', 'rg', 'ripgrep', 'js', 'javascript', 'node', 'JS', 'Auto'].map(engineNamed)).toEqual([
      'auto',
      'ripgrep',
      'ripgrep',
      'javascript',
      'javascript',
      'javascript',
      'javascript',
      'auto',
    ]);
    expect(() => engineNamed('grep')).toThrow(new ConfigError('Unknown engine "grep". Expected auto, rg or js.'));
  });
});

/* -------------------------------------------------------------- loadConfig */

describe('loadConfig', () => {
  const failing = (code: string) => async (): Promise<string> => {
    throw Object.assign(new Error(`${code}: nope`), { code });
  };

  /** A root holding these files and no others. */
  const holding =
    (files: Record<string, string>, asked: string[] = []) =>
    async (file: string): Promise<string> => {
      asked.push(file);
      const name = file.slice(file.lastIndexOf('/') + 1);
      const text = files[name];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
      return text;
    };

  it('reads package.json and .spec-guard.json in the root, whichever separator the root ends with', async () => {
    const asked: string[] = [];
    const read = holding({ 'package.json': manifest({ strict: true }) }, asked);
    expect(await loadConfig('/repo', read)).toEqual({ strict: true });
    await loadConfig('/repo/', read);
    await loadConfig('C:\\repo\\', read);
    await loadConfig('/repo//', read);
    expect(asked).toEqual([
      '/repo/package.json',
      '/repo/.spec-guard.json',
      '/repo/package.json',
      '/repo/.spec-guard.json',
      'C:\\repo/package.json',
      'C:\\repo/.spec-guard.json',
      '/repo/package.json',
      '/repo/.spec-guard.json',
    ]);
  });

  it('says which file the options came from', async () => {
    expect(await findConfig('/repo', holding({ 'package.json': manifest({ strict: true }) }))).toEqual({ config: { strict: true }, file: 'package.json' });
    expect(await findConfig('/repo', holding({ '.spec-guard.json': '{"strict": true}' }))).toEqual({ config: { strict: true }, file: '.spec-guard.json' });
    // A package.json that holds no options leaves the root to .spec-guard.json.
    expect(await findConfig('/repo', holding({ 'package.json': '{"name": "web"}', '.spec-guard.json': '{"strict": true}' }))).toEqual({
      config: { strict: true },
      file: '.spec-guard.json',
    });
    expect(await findConfig('/repo', holding({}))).toEqual({ config: {}, file: 'package.json' });
  });

  it('refuses options in both files, even empty ones, rather than letting one be ignored', async () => {
    for (const options of [{ strict: true }, {}]) {
      await expect(findConfig('/repo', holding({ 'package.json': manifest(options), '.spec-guard.json': '{"exclude": ["target"]}' }))).rejects.toThrow(
        new ConfigError(
          'Options are set in both package.json ("specGuard") and .spec-guard.json. Keep them in one of the two, so that no option is written somewhere nothing reads.',
        ),
      );
    }
  });

  it('refuses a broken package.json even when .spec-guard.json holds the options', async () => {
    await expect(findConfig('/repo', holding({ 'package.json': '{ not json', '.spec-guard.json': '{}' }))).rejects.toThrow(/^package\.json is not valid JSON/);
  });

  it('refuses a .spec-guard.json that is there and cannot be read', async () => {
    const read = async (file: string): Promise<string> => {
      if (file.endsWith('package.json')) throw Object.assign(new Error('ENOENT: nope'), { code: 'ENOENT' });
      throw Object.assign(new Error('EACCES: nope'), { code: 'EACCES' });
    };
    await expect(findConfig('/repo', read)).rejects.toThrow(new ConfigError('.spec-guard.json could not be read (EACCES: nope), so its options cannot be read.'));
  });

  it('finds no configuration where there is no package.json, or no directory to hold one', async () => {
    expect(await loadConfig('/repo', failing('ENOENT'))).toEqual({});
    expect(await loadConfig('/repo', failing('ENOTDIR'))).toEqual({});
  });

  it('refuses a package.json that is there and cannot be read, since nobody knows what it says', async () => {
    await expect(loadConfig('/repo', failing('EACCES'))).rejects.toThrow(
      new ConfigError('package.json could not be read (EACCES: nope), so its "specGuard" options cannot be read.'),
    );
    await expect(loadConfig('/repo', failing('EISDIR'))).rejects.toBeInstanceOf(ConfigError);
  });

  it('validates what it read', async () => {
    await expect(loadConfig('/repo', holding({ 'package.json': manifest({ strict: 'yes' }) }))).rejects.toThrow('"specGuard.strict" must be true or false, got "yes".');
    await expect(loadConfig('/repo', holding({ '.spec-guard.json': '{"strict": "yes"}' }))).rejects.toThrow('.spec-guard.json: "strict" must be true or false, got "yes".');
  });

  it('reads a real package.json from disk through the command line', async () => {
    const root = await repo({ 'package.json': manifest({ ignoreStatus: true }) });
    expect(await loadConfig(root, (file) => fs.readFile(file, 'utf8'))).toEqual({ ignoreStatus: true });
  });
});

/* -------------------------------------------------------- the command line */

describe('flags that a configuration can set', () => {
  it('gains the opposite of every on/off option, each setting its value either way', () => {
    const pairs: Array<[string, string, keyof ReturnType<typeof parseArgs>]> = [
      ['--strict', '--no-strict', 'strictTargets'],
      ['--allow-missing-targets', '--no-allow-missing-targets', 'allowMissingTargets'],
      ['--allow-empty-scope', '--no-allow-empty-scope', 'allowEmptyScope'],
      ['--ignore-status', '--no-ignore-status', 'ignoreStatus'],
      ['--include-specs', '--no-include-specs', 'includeSpecs'],
      ['--default-skips', '--no-default-skips', 'defaultSkips'],
    ];
    for (const [on, off, field] of pairs) {
      expect(parseArgs([on], process.cwd())[field], on).toBe(true);
      expect(parseArgs([off], process.cwd())[field], off).toBe(false);
      // The last one written wins, as for every other flag.
      expect(parseArgs([on, off], process.cwd())[field]).toBe(false);
      expect(parseArgs([off, on], process.cwd())[field]).toBe(true);
    }
  });

  it('records which configurable options the command line set, and nothing else', () => {
    expect([...parseArgs([], process.cwd()).fromCommandLine]).toEqual([]);
    expect([...parseArgs(['--verbose', '--json', '--fail-fast', '--color', '--print-baseline', '--allow-empty'], process.cwd()).fromCommandLine]).toEqual([]);
    expect(
      [
        ...parseArgs(
          ['a.md', '--exclude', 'dist', '--engine', 'js', '--no-strict', '--allow-missing-targets', '--no-allow-empty-scope', '--ignore-status', '--no-include-specs', '--default-skips', '--max-snippets', '1', '--concurrency', '2'],
          process.cwd(),
        ).fromCommandLine,
      ].sort(),
      // Every key but cites, which names documents and has no flag.
    ).toEqual(CONFIG_KEYS.filter((key) => key !== 'cites').sort());
    expect([...parseArgs(['--spec', 'a.md'], process.cwd()).fromCommandLine]).toEqual(['specs']);
    expect([...parseArgs(['query', 'src', '--spec', 'a.md'], process.cwd()).fromCommandLine]).toEqual(['specs']);
  });

  it('refuses the opposites where the options themselves are refused', () => {
    for (const option of ['--no-strict', '--no-allow-missing-targets', '--no-allow-empty-scope']) {
      expect(() => parseArgs(['query', 'src', option], process.cwd()), option).toThrow(new UsageError(`Option ${option} does not apply to spec-guard query.`));
    }
    expect(parseArgs(['query', 'src', '--no-ignore-status', '--no-include-specs', '--default-skips'], process.cwd())).toMatchObject({
      ignoreStatus: false,
      includeSpecs: false,
      defaultSkips: true,
    });
  });

  it('reads --exclude as lists, repeatable, and --exclude= as none', () => {
    expect(parseArgs(['--exclude', 'target'], process.cwd()).exclude).toEqual(['target']);
    expect(parseArgs(['--exclude', 'bin, obj', '--exclude=dist/**'], process.cwd()).exclude).toEqual(['bin', 'obj', 'dist/**']);
    const cleared = parseArgs(['--exclude='], process.cwd());
    expect(cleared.exclude).toEqual([]);
    expect([...cleared.fromCommandLine]).toEqual(['exclude']);
    expect(parseArgs([], process.cwd()).exclude).toEqual([]);
    expect(() => parseArgs(['--exclude'], process.cwd())).toThrow(new UsageError('Option --exclude requires a value.'));
    expect(parseArgs(['query', 'src', '--exclude', 'target'], process.cwd()).exclude).toEqual(['target']);
  });

  it('refuses an --exclude pattern that could never exclude anything, whichever list it is in', () => {
    expect(() => parseArgs(['--exclude', 'target', '--exclude', 'build, !build/keep.ts'], process.cwd())).toThrow(
      new UsageError('Option --exclude has an invalid exclude pattern "!build/keep.ts": negation patterns are not supported in exclude.'),
    );
    expect(() => parseArgs(['query', 'src', '--exclude=../vendor'], process.cwd())).toThrow(
      new UsageError('Option --exclude has an invalid exclude pattern "../vendor": ".." leads out of the root, and only paths inside it are searched.'),
    );
  });

  it('documents both files, exclude, and the opposites in the help', () => {
    expect(HELP).toContain("--exclude <globs>   Paths no assertion looks at, beside each directive's exclude; repeatable");
    expect(HELP).toContain('maxSnippets and concurrency under "specGuard"; a root with no package.json can');
    expect(HELP).toContain('keep them in .spec-guard.json instead, but not in both. A flag wins over the');
    expect(HELP).toContain('--default-skips, ...), and --exclude= with nothing clears exclude.');
  });
});

describe('applyConfig', () => {
  const cwd = process.cwd();
  const everything: ProjectConfig = {
    specs: ['rules/*.md'],
    exclude: ['target'],
    engine: 'ripgrep',
    strict: true,
    allowMissingTargets: true,
    allowEmptyScope: true,
    ignoreStatus: true,
    includeSpecs: true,
    defaultSkips: false,
    maxSnippets: 9,
    concurrency: 3,
    cites: [{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }],
  };
  /** What a run reads: everything but cites, which is spec-guard cites' own. */
  const RUN_KEYS = CONFIG_KEYS.filter((key) => key !== 'cites');

  it('fills in every option the command line left alone, and says so in the order of the keys', () => {
    const options = parseArgs([], cwd);
    expect(applyConfig(options, everything)).toEqual({ file: 'package.json', applied: RUN_KEYS, overridden: [] });
    expect(options).toMatchObject({
      patterns: ['rules/*.md'],
      exclude: ['target'],
      engine: 'ripgrep',
      strictTargets: true,
      allowMissingTargets: true,
      allowEmptyScope: true,
      ignoreStatus: true,
      includeSpecs: true,
      defaultSkips: false,
      maxSnippets: 9,
      concurrency: 3,
    });
  });

  it('leaves every option the command line set, either way, and names it as overridden', () => {
    const options = parseArgs(['a.md', '--exclude=', '--engine', 'js', '--no-strict', '--no-allow-missing-targets', '--no-allow-empty-scope', '--no-ignore-status', '--no-include-specs', '--default-skips', '--max-snippets', '2', '--concurrency', '4'], cwd);
    expect(applyConfig(options, everything, 'pkg/package.json')).toEqual({ file: 'pkg/package.json', applied: [], overridden: RUN_KEYS });
    expect(options).toMatchObject({
      patterns: ['a.md'],
      exclude: [],
      engine: 'javascript',
      strictTargets: false,
      allowMissingTargets: false,
      allowEmptyScope: false,
      ignoreStatus: false,
      includeSpecs: false,
      defaultSkips: true,
      maxSnippets: 2,
      concurrency: 4,
    });
  });

  it("replaces the file's exclude with the command line's, and keeps its own copy", () => {
    const config: ProjectConfig = { exclude: ['target', 'bin'] };
    const replaced = parseArgs(['--exclude', 'dist'], cwd);
    expect(applyConfig(replaced, config)).toEqual({ file: 'package.json', applied: [], overridden: ['exclude'] });
    expect(replaced.exclude).toEqual(['dist']);

    const taken = parseArgs([], cwd);
    expect(applyConfig(taken, config, '.spec-guard.json')).toEqual({ file: '.spec-guard.json', applied: ['exclude'], overridden: [] });
    taken.exclude.push('obj');
    expect(config.exclude).toEqual(['target', 'bin']);
  });

  it('replaces the default specs rather than adding to them, and keeps its own copy', () => {
    const config: ProjectConfig = { specs: ['a.md', 'b.md'] };
    const options = parseArgs([], cwd);
    applyConfig(options, config);
    expect(options.patterns).toEqual(['a.md', 'b.md']);
    options.patterns.push('c.md');
    expect(config.specs).toEqual(['a.md', 'b.md']);
  });

  it('applies to a query only what a query reads', () => {
    const options = parseArgs(['query', 'src'], cwd);
    expect(applyConfig(options, everything)).toEqual({ file: 'package.json', applied: ['specs', 'exclude', 'ignoreStatus', 'includeSpecs', 'defaultSkips'], overridden: [] });
    expect(options).toMatchObject({ strictTargets: false, engine: 'auto', maxSnippets: 5 });
    expect(applyConfig(parseArgs(['query', 'src', '--spec', 'x.md'], cwd), { specs: ['y.md'], strict: true })).toEqual({ file: 'package.json', applied: [], overridden: ['specs'] });
  });

  it('applies to a watch session everything but the engine, which it does not use', () => {
    const options = parseArgs(['--watch'], cwd);
    const use = applyConfig(options, everything);
    expect(use?.applied).toEqual(RUN_KEYS.filter((key) => key !== 'engine'));
    expect(options.engine).toBe('auto');
  });

  it('applies cites to spec-guard cites alone, with what else it reads, and a copy of each family', () => {
    const options = parseArgs(['cites'], cwd);
    expect(applyConfig(options, everything)).toEqual({ file: 'package.json', applied: ['specs', 'exclude', 'strict', 'defaultSkips', 'cites'], overridden: [] });
    expect(options.cites).toEqual([{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }]);
    (options.cites?.[0] as { id: string }).id = 'X-{n}';
    expect(everything.cites?.[0]?.id).toBe('ADR-{n}');
    for (const argv of [[], ['query', 'src'], ['prove'], ['mcp'], ['--watch']]) {
      expect(applyConfig(parseArgs(argv, cwd), { cites: everything.cites }), argv.join(' ')).toBeUndefined();
    }
  });

  it('says nothing when a configuration had nothing for this command', () => {
    expect(applyConfig(parseArgs([], cwd), {})).toBeUndefined();
    expect(applyConfig(parseArgs(['query', 'src'], cwd), { strict: true, engine: 'javascript' })).toBeUndefined();
    expect(applyConfig(parseArgs(['--watch'], cwd), { engine: 'javascript' })).toBeUndefined();
  });
});

describe('formatConfigUse', () => {
  it('names what was applied, and what the command line overrode', () => {
    expect(formatConfigUse({ file: 'package.json', applied: ['specs', 'strict'], overridden: [] })).toBe('options from package.json: specs, strict');
    expect(formatConfigUse({ file: 'package.json', applied: ['specs'], overridden: ['engine', 'strict'] })).toBe(
      'options from package.json: specs; overridden on the command line: engine, strict',
    );
    expect(formatConfigUse({ file: 'package.json', applied: [], overridden: ['strict'] })).toBe('options from package.json: none; overridden on the command line: strict');
  });

  it('names the exclusions in force beside exclude, wherever the key is listed', () => {
    expect(formatConfigUse({ file: '.spec-guard.json', applied: ['exclude'], overridden: [] }, ['target', 'bin', 'obj', 'dist'])).toBe(
      'options from .spec-guard.json: exclude (target, bin, obj, dist)',
    );
    expect(formatConfigUse({ file: 'package.json', applied: ['specs'], overridden: ['exclude', 'strict'] }, ['dist'])).toBe(
      'options from package.json: specs; overridden on the command line: exclude (dist), strict',
    );
    expect(formatConfigUse({ file: 'package.json', applied: [], overridden: ['exclude'] }, [])).toBe(
      'options from package.json: none; overridden on the command line: exclude (none)',
    );
    // Not told the patterns, it names the key alone, as it always did.
    expect(formatConfigUse({ file: 'package.json', applied: ['exclude'], overridden: [] })).toBe('options from package.json: exclude');
  });
});

describe('formatOptionLines', () => {
  const use = (applied: string[], overridden: string[] = []) => ({ file: '.spec-guard.json', applied, overridden });

  it('says nothing when there was no configuration and no exclusion', () => {
    expect(formatOptionLines(undefined, [])).toEqual([]);
  });

  it('names exclusions from the command line on a line of their own when no configuration accounts for them', () => {
    expect(formatOptionLines(undefined, ['dist', 'build'])).toEqual(['exclude from the command line: dist, build']);
    expect(formatOptionLines(use(['specs']), ['dist'])).toEqual(['options from .spec-guard.json: specs', 'exclude from the command line: dist']);
    expect(formatOptionLines(use(['specs']), [])).toEqual(['options from .spec-guard.json: specs']);
  });

  it('names them once, in the configuration line, when the file set them or the command line overrode them', () => {
    expect(formatOptionLines(use(['specs', 'exclude']), ['target'])).toEqual(['options from .spec-guard.json: specs, exclude (target)']);
    expect(formatOptionLines(use([], ['exclude']), ['dist'])).toEqual(['options from .spec-guard.json: none; overridden on the command line: exclude (dist)']);
    expect(formatOptionLines(use([], ['exclude']), [])).toEqual(['options from .spec-guard.json: none; overridden on the command line: exclude (none)']);
  });
});

/* ---------------------------------------------------------- a run, a query */

function io(cwd: string, stdin?: PassThrough): { cli: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd, isTTY: false, ...(stdin ? { stdin } : {}) };
  return { cli, out, err };
}

/** A project whose rules only a configuration can find, and whose one strict gap only --strict fails. */
const PROJECT = {
  'rules/a.md': '# A\n\n<!-- @assert-absence target="src" symbol="Legacy" -->\n',
  'rules/draft.md': '# Draft\n\n**Status:** draft\n\n<!-- @assert-absence target="src" symbol="Current" -->\n',
  'src/a.ts': 'export const Current = 1;\n',
};

describe('a run under a configuration', () => {
  it('runs the specs the file names, and ends its report saying which options came from it', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/*.md'], ignoreStatus: true, strict: false }) });
    const { cli, out, err } = io(root);
    expect(await main(['--engine', 'js'], cli)).toBe(EXIT_FAILED);
    expect(err).toEqual([]);
    const report = out.join('\n');
    expect(report).toContain('spec-guard 2 specs · 2 assertions');
    expect(report).toMatch(/\noptions from package\.json: specs, strict, ignoreStatus\n\n1 passed · 1 failed/);
  });

  it('lets the command line win, either way, and says it did', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/*.md'], ignoreStatus: true }) });
    const { cli, out } = io(root);
    expect(await main(['--engine', 'js', '--no-ignore-status'], cli)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('options from package.json: specs; overridden on the command line: ignoreStatus');

    const json = io(root);
    expect(await main(['--engine', 'js', '--json', 'rules/a.md'], json.cli)).toBe(EXIT_OK);
    const parsed = JSON.parse(json.out.join('\n')) as { summary: { specs: number }; config: unknown };
    expect(parsed.summary.specs).toBe(1);
    expect(parsed.config).toEqual({ file: 'package.json', applied: ['ignoreStatus'], overridden: ['specs'] });
  });

  it('says nothing about a configuration there is not, in text or in JSON', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest(undefined) });
    const { cli, out } = io(root);
    expect(await main(['--engine', 'js', '--json', '--spec', 'rules/a.md'], cli)).toBe(EXIT_OK);
    expect(JSON.parse(out.join('\n'))).not.toHaveProperty('config');
    const text = io(root);
    await main(['--engine', 'js', '--spec', 'rules/a.md'], text.cli);
    expect(text.out.join('\n')).not.toContain('options from');
  });

  it('refuses to run under a malformed configuration: exit 2, the reason, and nothing else', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ strict: 'yes' }) });
    const { cli, out, err } = io(root);
    expect(await main(['--engine', 'js', '--spec', 'rules/a.md'], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['spec-guard: package.json: "specGuard.strict" must be true or false, got "yes".']);
  });

  it('still answers --help and --version in a project whose package.json is broken', async () => {
    const root = await repo({ 'package.json': '{ not json' });
    const help = io(root);
    expect(await main(['--help'], help.cli)).toBe(EXIT_OK);
    expect(help.out).toEqual([HELP]);
    const shown = io(root);
    expect(await main(['--version'], shown.cli)).toBe(EXIT_OK);
    expect(shown.out).toEqual([version()]);
  });

  it('reads the configuration of the root it was pointed at, not of the directory it was run from', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/a.md'] }) });
    const elsewhere = await repo({ 'package.json': manifest({ strict: 'broken' }) });
    const { cli, out } = io(elsewhere);
    expect(await main(['--root', root, '--engine', 'js', '--json'], cli)).toBe(EXIT_OK);
    expect((JSON.parse(out.join('\n')) as { specFiles: string[] }).specFiles).toEqual(['rules/a.md']);
  });
});

describe('a query under a configuration', () => {
  it('takes its specs and statuses from the file, and says so', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/*.md'], ignoreStatus: true, strict: true }) });
    const { cli, out } = io(root);
    expect(await main(['query', 'src/a.ts'], cli)).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('2 rules from 2 documents');
    expect(text).toMatch(/\noptions from package\.json: specs, ignoreStatus\n\n2 spec files read in/);

    const json = io(root);
    expect(await main(['query', 'src/a.ts', '--format', 'json', '--no-ignore-status'], json.cli)).toBe(EXIT_OK);
    expect((JSON.parse(json.out.join('\n')) as { config: unknown }).config).toEqual({ file: 'package.json', applied: ['specs'], overridden: ['ignoreStatus'] });
  });

  it('refuses a malformed configuration the way a run does', async () => {
    const root = await repo({ 'package.json': manifest({ specs: [] }) });
    const { cli, err } = io(root);
    expect(await main(['query', 'src/a.ts'], cli)).toBe(EXIT_ERROR);
    expect(err).toEqual(['spec-guard: package.json: "specGuard.specs" must be a non-empty list of spec globs, got an array.']);
  });
});

describe('an MCP server under a configuration', () => {
  /** Sends one request and waits for its answer. */
  async function ask(stdin: PassThrough, out: string[], id: number, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const before = out.length;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    for (let waited = 0; out.length === before; waited++) {
      if (waited > 2000) throw new Error('no answer');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return (JSON.parse(out[before] as string) as { result: Record<string, unknown> }).result;
  }

  it('reads the configuration again for every request, so an edit reaches the next answer', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/*.md'], defaultSkips: true }) });
    const stdin = new PassThrough();
    const { cli, out, err } = io(root, stdin);
    const exit = main(['mcp', '--engine', 'js'], cli);

    const first = await ask(stdin, out, 1, 'check_architecture');
    expect(first['structuredContent']).toMatchObject({ rules: { inForce: 1 } });

    await fs.writeFile(path.join(root, 'package.json'), manifest({ specs: ['rules/*.md'], ignoreStatus: true }));
    const second = await ask(stdin, out, 2, 'check_architecture');
    expect(second['structuredContent']).toMatchObject({ ok: false, rules: { inForce: 2, failed: 1 } });
    const rules = await ask(stdin, out, 3, 'get_architectural_rules', { path: 'src/a.ts' });
    expect(rules['structuredContent']).toMatchObject({ results: [{ rules: [{}, { inForce: false }] }] });

    await fs.writeFile(path.join(root, 'package.json'), manifest({ specs: 'rules' }));
    const broken = await ask(stdin, out, 4, 'check_architecture');
    expect(broken).toMatchObject({ isError: true, content: [{ text: 'spec-guard failed: package.json: "specGuard.specs" must be a non-empty list of spec globs, got "rules".' }] });

    stdin.end();
    expect(await exit).toBe(EXIT_OK);
    expect(err).toEqual([`spec-guard ${version()}: MCP server on stdio, rules from rules/*.md under ${root}, options from package.json: specs, defaultSkips`]);
  });

  it('keeps the command line winning on every request', async () => {
    const root = await repo({ ...PROJECT, 'package.json': manifest({ specs: ['rules/*.md'], ignoreStatus: true }) });
    const stdin = new PassThrough();
    const { cli, out, err } = io(root, stdin);
    const exit = main(['mcp', '--engine', 'js', '--spec', 'rules/a.md', '--no-ignore-status'], cli);
    expect((await ask(stdin, out, 1, 'check_architecture'))['structuredContent']).toMatchObject({ rules: { inForce: 1 } });
    await fs.writeFile(path.join(root, 'package.json'), manifest({ specs: ['rules/draft.md'], ignoreStatus: true }));
    expect((await ask(stdin, out, 2, 'check_architecture'))['structuredContent']).toMatchObject({ rules: { inForce: 1 }, inactiveSpecs: [] });
    stdin.end();
    expect(await exit).toBe(EXIT_OK);
    // Everything the file said was overridden, so the server does not claim to serve any of it.
    expect(err).toEqual([`spec-guard ${version()}: MCP server on stdio, rules from rules/a.md under ${root}`]);
  });

  it("serves under a .spec-guard.json, its exclusions in every answer", async () => {
    const root = await repo({
      ...PROJECT,
      // The whole root, so only the exclusions keep target/ out of the rule.
      'rules/a.md': '# A\n\n<!-- @assert-absence symbol="Legacy" -->\n',
      'target/gen.ts': 'export const Legacy = 1;\n',
      '.spec-guard.json': JSON.stringify({ specs: ['rules/a.md'], exclude: ['target'] }),
    });
    const stdin = new PassThrough();
    const { cli, out, err } = io(root, stdin);
    const exit = main(['mcp', '--engine', 'js'], cli);

    const config = { file: '.spec-guard.json', applied: ['specs', 'exclude'], overridden: [] };
    const check = await ask(stdin, out, 1, 'check_architecture');
    expect(check['structuredContent']).toMatchObject({ ok: true, exclude: ['target'], config });
    expect((check['content'] as Array<{ text: string }>)[0]?.text).toContain('\noptions from .spec-guard.json: specs, exclude (target)\n');
    const excluded = await ask(stdin, out, 2, 'get_architectural_rules', { path: 'target/gen.ts' });
    expect(excluded['structuredContent']).toMatchObject({
      exclude: ['target'],
      config,
      results: [{ rules: [], excluded: { project: ['target'], rules: [] } }],
    });
    expect((excluded['content'] as Array<{ text: string }>)[0]?.text).toContain("no rules in force govern this path: the project's exclude leaves it out (target)");
    expect((await ask(stdin, out, 3, 'get_architectural_rules', { path: 'src/a.ts' }))['structuredContent']).toMatchObject({
      results: [{ rules: [{}], excluded: { project: [], rules: [] } }],
    });

    stdin.end();
    expect(await exit).toBe(EXIT_OK);
    expect(err).toEqual([`spec-guard ${version()}: MCP server on stdio, rules from rules/a.md under ${root}, options from .spec-guard.json: specs, exclude (target)`]);
  });

  it('will not start under a malformed configuration', async () => {
    const root = await repo({ 'package.json': manifest({ watch: true }) });
    const { cli, out, err } = io(root, new PassThrough());
    expect(await main(['mcp'], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['spec-guard: package.json: "specGuard.watch" is chosen on the command line, not in package.json.']);
  });
});

/* ------------------------------------------------------------------ --watch */

describe('--watch on the command line', () => {
  it('is a check, and neither a query nor a server', () => {
    expect(parseArgs(['--watch'], process.cwd()).watch).toBe(true);
    expect(parseArgs([], process.cwd()).watch).toBe(false);
    expect(() => parseArgs(['query', 'src', '--watch'], process.cwd())).toThrow(new UsageError('Option --watch does not apply to spec-guard query.'));
    expect(() => parseArgs(['mcp', '--watch'], process.cwd())).toThrow(new UsageError('Option --watch does not apply to spec-guard mcp.'));
  });

  it.each([
    [['--json'], 'Option --json does not apply to spec-guard --watch: a session prints reports for a person, not one document.'],
    [['--format', 'json'], 'Option --format does not apply to spec-guard --watch: a session prints reports for a person, not one document.'],
    [['--format=sarif'], 'Option --format does not apply to spec-guard --watch: a session prints reports for a person, not one document.'],
    [['--print-baseline'], 'Option --print-baseline does not apply to spec-guard --watch: it prints once and exits.'],
    [['--fail-fast'], 'Option --fail-fast does not apply to spec-guard --watch: a session runs every rule, so each report can be compared with the last.'],
    [['--allow-empty'], 'Option --allow-empty does not apply to spec-guard --watch: a session has no exit code to relax.'],
    [['--engine', 'js'], 'Option --engine does not apply to spec-guard --watch: a session always scans in-process, where it can see what each rule reads.'],
  ])('refuses %j, before or after --watch', (flags, message) => {
    expect(() => parseArgs(['--watch', ...flags], process.cwd())).toThrow(new UsageError(message));
    expect(() => parseArgs([...flags, '--watch'], process.cwd())).toThrow(new UsageError(message));
    expect(() => parseArgs(flags, process.cwd())).not.toThrow();
  });

  it('accepts the human format by name, since that is what it prints', () => {
    expect(parseArgs(['--watch', '--format', 'human', '--verbose', '--strict', '--max-snippets', '2'], process.cwd())).toMatchObject({ watch: true, format: 'human' });
  });
});
