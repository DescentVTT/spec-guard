/**
 * What this repository asks of npm, held to what npm 10, 11 and 12 all do.
 *
 * CI installs with the npm each Node carries, 10 with Node 22 and 11 with
 * Node 24 and 26, and a contributor may have 12, which the registry has
 * served as `latest` since July 2026. npm 12 changed three things a workflow
 * can lean on without noticing: a dependency's install script runs only when
 * `allowScripts` in package.json names the package, `npm pack --json` prints
 * an object keyed by the package's name where it printed an array, and a flag
 * npm does not define, or an abbreviation of one, is an error where it was a
 * warning. Each test holds the workflows to the reading all three share, so
 * that a release rehearsed under one npm is the release another makes.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

interface Command {
  readonly where: string;
  /** From `npm` to where the shell ends the command. */
  readonly text: string;
}

/**
 * The npm commands in `text`, comment lines apart. A command ends at a pipe,
 * a redirection, `&&`, `;` or a parenthesis. `npx` is not npm here: what
 * follows the command it runs belongs to that command.
 */
function npmCommands(text: string, file: string): Command[] {
  return text.split(/\r?\n/).flatMap((line, index) =>
    /^\s*#/.test(line)
      ? []
      : [...line.matchAll(/(?<![\w@/.-])npm(?= )[^|;&<>()]*/g)].map((match) => ({ where: `${file}:${index + 1}`, text: match[0].trim() })),
  );
}

/** The flags npm reads from a command: each `-x` and `--x` before a bare `--`, without its value. */
function flagsOf(command: string): string[] {
  const words = command.split(/\s+/);
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).filter((word) => /^--?[a-z]/.test(word)).map((word) => word.split('=')[0] as string);
}

/**
 * The flags the family's workflows and scripts pass to npm, each one a config
 * that npm 10.9.9, 11.20.0 and 12.2.0 define under this spelling, read from
 * the definitions each of them ships on 2026-10-07. A flag joins the list when
 * all three are seen to define it; `--json` is defined and stays out, because
 * what it prints is not the same under the three.
 */
const DEFINED: readonly string[] = ['--access', '--dry-run', '--ignore-scripts', '--no-save', '--pack-destination', '--provenance', '--tag', '--version', '-g'];

const workflows = readdirSync(`${ROOT}.github/workflows`)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();
const commands = [
  ...workflows.flatMap((name) => npmCommands(read(`.github/workflows/${name}`), name)),
  ...Object.entries((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts).flatMap(([name, script]) =>
    npmCommands(script, `package.json "${name}"`),
  ),
];
const shown = (found: readonly Command[]): string[] => found.map(({ where, text }) => `${where}: ${text}`);

describe('the workflows and the scripts, under any npm from 10 to 12', () => {
  it('are read, down to the commands a release runs', () => {
    // A workflow that moved, or a line this file no longer reads, would leave
    // the checks below nothing to fail on.
    expect(workflows).toEqual(expect.arrayContaining(['ci.yml', 'mutation.yml', 'release.yml']));
    const texts = commands.map(({ text }) => text);
    expect(texts).toContain('npm ci --ignore-scripts');
    expect(texts).toContain('npm run clean');
    expect(texts.some((text) => text.startsWith('npm stage publish '))).toBe(true);
  });

  it("install without any dependency's install script, which npm 12 refuses and npm 10 and 11 run unless told", () => {
    const installs = commands.filter(({ text }) => /^npm ci\b/.test(text));
    expect(installs.length).toBeGreaterThanOrEqual(6);
    expect(shown(installs.filter(({ text }) => !flagsOf(text).includes('--ignore-scripts')))).toEqual([]);
  });

  it('pass npm only flags that all three define, spelled in full: npm 12 refuses any other, and an abbreviation', () => {
    const refused = commands.filter(({ text }) => flagsOf(text).some((flag) => !DEFINED.includes(flag)));
    expect(shown(refused)).toEqual([]);
  });

  it("take the tarball's name from the directory npm packed into, and read no --json, whose shape npm 12 changed", () => {
    // `npm pack --json` is an array under npm 11 and an object keyed by the
    // package's name under npm 12; `npm view --json` and `npm pkg get` moved too.
    expect(shown(commands.filter(({ text }) => flagsOf(text).includes('--json') || /^npm pkg\b/.test(text)))).toEqual([]);
    const packs = commands.map(({ text }) => text).filter((text) => /^npm pack /.test(text) && flagsOf(text).length > 0);
    expect(packs).toEqual(['npm pack --pack-destination npm-package']);
  });
});

describe('the package, installed by any npm from 10 to 12', () => {
  it('has no install script, so npm 12 blocks nothing of it and its user has nothing to approve', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    // `prepare` runs when a package is installed from git, and counts with the rest.
    expect(Object.keys(scripts).filter((name) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(name))).toEqual([]);
    // npm reads a binding.gyp as an install script nobody wrote.
    expect(existsSync(`${ROOT}binding.gyp`)).toBe(false);
  });
});

describe('a contributor, with any npm from 10 to 12', () => {
  it('starts from `npm ci`, which leaves the lockfile as it is where `npm install` under npm 10 rewrites it', () => {
    // npm 10 writes the lockfile back without the `libc` fields npm 11 and 12
    // keep, so the first command a contributor is given must not be the one
    // that leaves a changed lockfile behind on Node 22.
    const first = /```bash\n([\s\S]*?)```/.exec(read('CONTRIBUTING.md'))?.[1] ?? '';
    const commands = first.split('\n').map((line) => line.split('#')[0]?.trim());
    expect(commands).toContain('npm ci');
    expect(commands).not.toContain('npm install');
  });
});
