/**
 * A command names the package it runs.
 *
 * The tools are published as `@descent-vtt/<name>` and each installs a
 * command called `<name>`. Without the scope the names are not the family's:
 * on npm `spec-harness` is another publisher's package, and the other four
 * belonged to nobody on 2026-10-07. `npx <name>` runs the project's install
 * where there is one, and elsewhere fetches the package of the bare name and
 * runs it, unasked when no terminal is attached. `--no-install` in front of
 * the bare name stops the download and still runs a copy an earlier fetch
 * left in npm's cache, and where nothing is installed it reports the other
 * publisher's package as the one missing (npm 10.9.9, 11.20.0 and 12.2.0,
 * measured with a made-up name).
 *
 * So every command this repository writes for `npx`, `npm exec` or another
 * package manager's equivalent gives the package's full name, and this file
 * reads the repository for one that does not
 * (spec-core's ADR-0005, Names:
 * https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md#names).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** The commands the family's packages install: each is also a name on the registry that is not the family's. */
const NAMES: readonly string[] = ['spec-brief', 'spec-core', 'spec-graph', 'spec-guard', 'spec-harness'];

/** What fetches a package by the name it is given and runs it: npm's spellings, and the other package managers' own. */
const RUNNER = /(?<![\w@/.-])(?:npx|pnpx|bunx|npm\s+(?:exec|x)|pnpm\s+dlx|yarn\s+dlx|bun\s+x)(?![\w-])/g;

/** The flags of those runners whose value is the word after them. */
const TAKES_A_VALUE: readonly string[] = ['-p', '--package', '-w', '--workspace', '--cache', '--registry', '--prefix', '--userconfig', '--loglevel'];

/** A comment that begins so says the lines under it, up to the next blank one, show the bare form as what not to write. */
const SHOWN = /(?:<!--|\/\/|#)\s*bare-name:/;

/**
 * The words after a runner, as a shell, a code span or an array of strings
 * separates them. A comma counts only after a quoted word, so that "through
 * npx, spec-guard reads" is prose and `['npx', 'spec-guard']` is not.
 */
function wordsOf(tail: string): string[] {
  return tail
    .replace(/["'`]\s*,/g, ' ')
    .replace(/["'`[\](){}]/g, ' ')
    .replace(/^\s*args\s*:/, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && word !== '\\');
}

/** A word as a package name: the version after it and the punctuation of a sentence dropped, a scope kept. */
function nameOf(word: string): string {
  const name = word.replace(/[.,;:!?]+$/, '');
  const version = name.indexOf('@', 1);
  return version === -1 ? name : name.slice(0, version);
}

/**
 * The bare name a runner would fetch, given what follows it on its line and
 * on the two lines after: the word it takes for a command, where no
 * `--package` says which package that command is in, or a `--package` that
 * is itself bare. The next line is read only when the runner's own ends
 * before a command, as `"command": "npx",` does over its `"args"`.
 */
function bareNameAfter(tails: readonly string[]): string | null {
  const packages: string[] = [];
  let command: string | null = null;
  reading: for (const tail of tails) {
    const words = wordsOf(tail);
    for (let at = 0; at < words.length; at += 1) {
      const word = words[at] as string;
      if (!word.startsWith('-')) {
        command = word;
        break reading;
      }
      const equals = word.indexOf('=');
      const flag = equals === -1 ? word : word.slice(0, equals);
      // `--call` hands the shell a string: npm fetches nothing for a word in it.
      if (flag === '-c' || flag === '--call') break reading;
      if (flag === '-p' || flag === '--package') packages.push(equals === -1 ? (words[at + 1] ?? '') : word.slice(equals + 1));
      if (equals === -1 && TAKES_A_VALUE.includes(flag)) at += 1;
    }
  }
  const named = packages.map(nameOf).find((name) => NAMES.includes(name));
  if (named !== undefined) return named;
  return packages.length === 0 && command !== null && NAMES.includes(nameOf(command)) ? nameOf(command) : null;
}

interface Run {
  readonly where: string;
  readonly name: string;
  readonly written: string;
  /** Where the `bare-name:` comment over it is, if one is. */
  readonly shownBy: string | null;
}

/** Every place in `text` where a runner is given one of the family's names without its scope. */
function bareRuns(text: string, file: string): Run[] {
  const lines = text.split(/\r?\n/);
  let comment: string | null = null;
  return lines.flatMap((line, index) => {
    if (line.trim() === '') comment = null;
    else if (SHOWN.test(line)) comment = `${file}:${index + 1}`;
    const shownBy = comment;
    return [...line.matchAll(RUNNER)].flatMap((match) => {
      const name = bareNameAfter([line.slice(match.index + match[0].length), lines[index + 1] ?? '', lines[index + 2] ?? '']);
      return name === null ? [] : [{ where: `${file}:${index + 1}`, name, written: line.trim(), shownBy }];
    });
  });
}

describe('reading a line for a bare name behind a runner', () => {
  const found = (text: string): string[] => bareRuns(text, 'x').map((run) => run.name);

  it.each([
    ['npx spec-guard "docs/**/*.md"', 'spec-guard'],
    ['$ npx spec-harness init --write', 'spec-harness'],
    ['      - run: npx spec-graph --format github', 'spec-graph'],
    ['Run `npx spec-brief lint`.', 'spec-brief'],
    ['then `npx spec-core`.', 'spec-core'],
    ['Run npx spec-guard, then read on.', 'spec-guard'],
    ['npx -y spec-guard@latest', 'spec-guard'],
    ['npx --yes spec-guard@0.19.0 --verbose', 'spec-guard'],
    ['npm exec spec-brief lint', 'spec-brief'],
    ['npm exec -- spec-brief lint', 'spec-brief'],
    ['npm x -- spec-graph check', 'spec-graph'],
    ['npx --registry https://example.test spec-guard', 'spec-guard'],
    ['npx --package=spec-guard spec-guard', 'spec-guard'],
    ["npx -p spec-guard -c 'spec-guard --version'", 'spec-guard'],
    ['pnpm dlx spec-guard', 'spec-guard'],
    ['yarn dlx spec-guard', 'spec-guard'],
    ['bunx spec-guard', 'spec-guard'],
    ['pnpx spec-guard', 'spec-guard'],
    ["const hook = 'npx spec-harness hook claude';", 'spec-harness'],
    ["spawnSync('npx', ['spec-brief', 'lint'])", 'spec-brief'],
    ["{ command: 'npx', args: ['spec-harness', 'mcp'] }", 'spec-harness'],
    ['"command": "npx",\n"args": ["spec-guard", "mcp"]', 'spec-guard'],
    ['npx \\\n  spec-guard --format github', 'spec-guard'],
  ])('finds the name in %j', (text, name) => {
    expect(found(text)).toEqual([name]);
  });

  it.each([
    // `--no-install` stops a download, and not a copy npm already holds.
    ['exec npx --no-install spec-harness hook git', 'spec-harness'],
    ['npx --no spec-brief lint', 'spec-brief'],
    ['npm exec --no -- spec-brief lint', 'spec-brief'],
    ['"command": "npx",\n"args": ["--no-install", "spec-guard", "mcp"]', 'spec-guard'],
  ])('finds it behind a flag that only refuses to download, in %j', (text, name) => {
    expect(found(text)).toEqual([name]);
  });

  it.each([
    ['npx --no-install @descent-vtt/spec-guard "docs/**/*.md"'],
    ['npx @descent-vtt/spec-guard@0.19.0 --verbose'],
    ['npm exec --no -- @descent-vtt/spec-brief lint'],
    ['Run `npx --no-install @descent-vtt/spec-brief lint`.'],
    ['"command": "npx",\n"args": ["--no-install", "@descent-vtt/spec-guard", "mcp"]'],
    // The package is named, and the word after it is a command inside it.
    ['npx --package=@descent-vtt/spec-guard spec-guard --version'],
    ['npx -p @descent-vtt/spec-guard spec-guard --version'],
    // A string for the shell: npm fetches nothing for a word in it.
    ['npx -c "spec-guard --version"'],
    // Not a runner: nothing here fetches by the command's name.
    ['npm install --save-dev @descent-vtt/spec-guard'],
    ['npm run selfcheck'],
    ['"specs": "spec-guard --format github"'],
    ['node node_modules/@descent-vtt/spec-guard/bin/spec-guard.js'],
    ['pnpm exec spec-guard'],
    // Another command, with the name further along.
    ['npx stryker run --mutate src/spec-guard.ts'],
    ['npx vitest run tests/spec-brief.test.ts'],
    ['npx ./node_modules/.bin/spec-guard'],
    // Another package.
    ['npx spec-guardian'],
    ['npx spec-guard-plugin'],
    ['npx @example/spec-guard'],
    // Prose that has both words and runs nothing.
    ['Without a local install, `npx` needs the full name, and spec-guard is not it.'],
    ['Neither can rely on `npx` finding spec-harness.'],
    ['A hook that runs through npx: spec-harness says so.'],
    ['It goes through npx, spec-guard and all.'],
    ['`npm cache npx ls` lists it, under the `_npx` directory.'],
    // A key between the two ends the reading: a miss, taken so that a line of prose under `npx` is not a find.
    ['"command": "npx",\n"timeout": 60,\n"args": ["spec-guard"]'],
  ])('finds nothing in %j', (text) => {
    expect(found(text)).toEqual([]);
  });

  it('takes a comment that says so as showing the lines under it, up to the next blank line and no further', () => {
    const text = [
      '<!-- bare-name: what not to write -->',
      'Never `npx spec-guard`,',
      'nor `npx spec-brief`.',
      '',
      'Run `npx spec-graph`.',
      '// bare-name: what 0.1 wrote',
      "const old = 'npx spec-harness hook';",
    ].join('\n');
    expect(bareRuns(text, 'x').map((run) => [run.where, run.name, run.shownBy])).toEqual([
      ['x:2', 'spec-guard', 'x:1'],
      ['x:3', 'spec-brief', 'x:1'],
      ['x:5', 'spec-graph', null],
      ['x:7', 'spec-harness', 'x:6'],
    ]);
    // The words in a sentence are not the comment.
    expect(bareRuns('A `bare-name:` comment goes above it.\nRun `npx spec-guard`.', 'x').map((run) => run.shownBy)).toEqual([null]);
  });
});

/**
 * Every file a person or an agent reads a command from, or that runs one:
 * the documents, records included, the workflows, the scripts and the
 * sources. The tests stay out: the cases above are written to be found.
 */
function files(): string[] {
  const skip = new Set(['node_modules', 'dist', 'coverage', 'reports', '.stryker-tmp', '.git', 'tests', 'package-lock.json']);
  const below = (directory: string): string[] =>
    readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      if (skip.has(entry.name)) return [];
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) return below(path);
      return /\.(?:md|ya?ml|json|[cm]?[jt]s|sh)$/.test(entry.name) ? [path] : [];
    });
  return below('').sort();
}

describe('the commands this repository writes', () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
  const all = files();
  const runs = all.flatMap((file) => bareRuns(read(file), file));
  const readme = read('README.md');

  it('are read: the documents, the records, the workflows, the scripts and the sources', () => {
    // A directory that moved, or an extension this file no longer reads,
    // would leave the checks below nothing to fail on.
    expect(all).toEqual(
      expect.arrayContaining([
        'README.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'docs/adr/0019-releases-are-staged-by-ci.md',
        '.github/workflows/ci.yml',
        '.github/workflows/release.yml',
        'package.json',
        'bin/spec-guard.js',
        'scripts/mutation-shards.mjs',
        'src/cli.ts',
      ]),
    );
    // The README is where the commands are: the quick start, the two forms under Names, and the CI jobs.
    expect(readme.match(/npx --no-install @descent-vtt\/spec-guard\b/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it("give a runner the package's full name, never the command's alone", () => {
    expect(runs.filter((run) => run.shownBy === null).map((run) => `${run.where}: ${run.written}`)).toEqual([]);
  });

  it('show the bare form as what not to write in one place, the README that says why', () => {
    // A place joins this list on purpose, with the comment over it.
    expect([...new Set(runs.flatMap((run) => (run.shownBy === null ? [] : [run.where.split(':')[0]])))]).toEqual(['README.md']);
    // And a comment with nothing under it has outlived what it stood over.
    const comments = all.flatMap((file) => read(file).split(/\r?\n/).flatMap((line, index) => (SHOWN.test(line) ? [`${file}:${index + 1}`] : [])));
    expect(comments.filter((comment) => !runs.some((run) => run.shownBy === comment))).toEqual([]);
  });

  it('start a reader from the install, and then from the full name', () => {
    const first = (/```bash\n([\s\S]*?)```/.exec(readme)?.[1] ?? '').trim().split('\n');
    expect(first[0]).toBe('npm install --save-dev @descent-vtt/spec-guard');
    expect(first.length).toBeGreaterThan(1);
    expect(first.slice(1).filter((line) => !/^npx --no-install @descent-vtt\/spec-guard(?: |$)/.test(line))).toEqual([]);
  });

  it('say whose the name is where a reader looks, under the quick start', () => {
    // As a reader sees it: a sentence is one line, wherever the file wraps it.
    const section = (/^## Names$([\s\S]*?)^## /m.exec(readme)?.[1] ?? '').replace(/\s+/g, ' ');
    expect(section).toContain('The package is `@descent-vtt/spec-guard`, and the command it installs is `spec-guard`.');
    expect(section).toContain('The name without the scope is not this project');
    expect(section).toContain('`npx --no-install @descent-vtt/spec-guard`');
    expect(section).toContain('`npx @descent-vtt/spec-guard`');
    // The quick start comes first, and the names are the next section under
    // it. A `## ` inside a fence is an example's, not a heading.
    let fenced = false;
    let started = false;
    const sections = readme.split(/\r?\n/).filter((line) => {
      if (line.startsWith('```')) {
        fenced = !fenced;
        started ||= line === '```bash';
      }
      return started && !fenced && line.startsWith('## ');
    });
    expect(sections[0]).toBe('## Names');
  });

  it('register the MCP server by the full name, which a client starts with no terminal and wherever it stands', () => {
    const entry = /"mcpServers": \{\s*"spec-guard": (\{[\s\S]*?\})\s*\}/.exec(readme)?.[1] ?? '{}';
    const { command, args } = JSON.parse(entry) as { command?: string; args?: string[] };
    expect(command).toBe('npx');
    // Without `--no-install` a tree with no install would fetch on every start.
    expect(args?.slice(0, 3)).toEqual(['--no-install', '@descent-vtt/spec-guard', 'mcp']);
  });
});
