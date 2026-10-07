/**
 * What this repository asks of npm, held to what npm 10, 11 and 12 all do.
 *
 * CI installs with the npm each Node carries, 10 with Node 22 and 11 with
 * Node 24 and 26, and a contributor may have 12, the registry's `latest` on
 * 2026-10-07. npm 12 changed three things a workflow can lean on without
 * noticing: a dependency's install script runs only when
 * `allowScripts` in package.json names the package, `npm pack --json` prints
 * an object keyed by the package's name where it printed an array, and a flag
 * npm does not define, or an abbreviation of one, is an error where it was a
 * warning. Each test holds the workflows to the reading all three share, so
 * that a release rehearsed under one npm is the release another makes.
 */

import { spawnSync } from 'node:child_process';
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
const DEFINED: readonly string[] = ['--access', '--dry-run', '--ignore-scripts', '--loglevel', '--no-save', '--pack-destination', '--provenance', '--tag', '--version', '-g'];

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

/** Each script of `workflow` as the runner hands it to bash: what follows a `run:` on its line, or the block under `run: |`. */
function scriptsOf(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    const run = /^(\s*(?:- )?)run: (.*)$/.exec(line);
    if (run === null) return [];
    const before = (run[1] as string).length;
    if (run[2] !== '|') return [run[2] as string];
    const block: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.length - next.trimStart().length <= before) break;
      block.push(next.slice(before + 2));
    }
    return [`${block.join('\n').trimEnd()}\n`];
  });
}

/** The step of `workflow` named `name`: what its `env:` hands it, and its script. */
function stepNamed(workflow: string, name: string): { env: string[]; script: string } {
  const after = workflow.replaceAll('\r\n', '\n').split(`\n      - name: ${name}\n`)[1];
  if (after === undefined) throw new Error(`no step is named "${name}"`);
  const before = after.split('\n        run: |\n')[0] as string;
  return {
    env: before
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== 'env:'),
    script: scriptsOf(after)[0] as string,
  };
}

interface Outcome {
  readonly status: number;
  /** Each command npm was given, as `ran: npm ...`, among what the step printed, and then what it wrote to the run's summary. */
  readonly said: readonly string[];
}

/**
 * What `script` does in each of `runs`, an environment apiece, in one bash
 * with `-e` as the runner starts it. npm is a stand-in that installs nothing:
 * it says what it was given, and answers `--version` with the version it was
 * last told to install, or with `ANSWERS` where a run sets it. node is a
 * stand-in too. The summary is a file of the system's temporary directory
 * that bash names and removes.
 */
function outcomesOf(script: string, runs: ReadonlyArray<Readonly<Record<string, string>>>): Outcome[] {
  const names = ['GITHUB_EVENT_NAME', 'CANDIDATE', 'DRY_RUN', 'ANSWERS'];
  const driver = [
    'npm() { if [ "$1" = --version ]; then echo "${ANSWERS:-$told}"; else echo "ran: npm $*"; told="${3#npm@}"; fi; }',
    'node() { echo v24.0.0; }',
    'step() {',
    script,
    '}',
    'export GITHUB_STEP_SUMMARY="$(mktemp)"',
    'trap \'rm -f "$GITHUB_STEP_SUMMARY"\' EXIT',
    'for run in $RUNS; do',
    '  : > "$GITHUB_STEP_SUMMARY"',
    `  ( for name in ${names.join(' ')}; do from="RUN_\${run}_$name"; export "$name=\${!from-}"; done; set -e; step )`,
    '  status=$?',
    '  while IFS= read -r line; do echo "$line"; done < "$GITHUB_STEP_SUMMARY"',
    '  echo "--- $status"',
    'done',
  ].join('\n');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', RUNS: runs.map((_, index) => index).join(' ') };
  runs.forEach((run, index) => {
    for (const [name, value] of Object.entries(run)) env[`RUN_${index}_${name}`] = value;
  });
  const bash = spawnSync('bash', ['-c', driver], { encoding: 'utf8', env });
  const outcomes: Outcome[] = [];
  let said: string[] = [];
  for (const line of (bash.stdout ?? '').split('\n')) {
    const end = /^--- (\d+)$/.exec(line);
    if (end === null) said.push(line);
    else {
      outcomes.push({ status: Number(end[1]), said });
      said = [];
    }
  }
  if (bash.status !== 0 || outcomes.length !== runs.length) throw new Error(`bash ended ${outcomes.length} of ${runs.length} runs: ${bash.stderr ?? bash.error}`);
  return outcomes;
}

describe('the npm that stages: the pin for a release, and for a dry run the one exact version it names', () => {
  const release = read('.github/workflows/release.yml');
  const step = stepNamed(release, 'An npm new enough to stage');
  const pin = /^pin=(\d+\.\d+\.\d+)$/m.exec(step.script)?.[1] ?? 'no pin';
  /** A version that is not the pin, and no older. */
  const candidate = pin.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const tag = { GITHUB_EVENT_NAME: 'push' };
  const rehearsal = { GITHUB_EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'true' };
  const installed = (version: string): string => `ran: npm install -g npm@${version}`;
  const thePin = `npm ${pin} on node v24.0.0, the pin`;
  const aCandidate = `npm ${candidate} on node v24.0.0, a candidate: a release stages with the pin, ${pin}`;
  // The script is run where the workflow runs it, on Linux and in its bash:
  // elsewhere bash is another bash, or there is none.
  const onLinux = process.platform === 'linux';

  it('is pinned in the step and again as what the input defaults to, and the two agree', () => {
    // An input cannot read a step, so the pin is written twice. Moved in one
    // place alone, a rehearsal that names no npm would try another than the
    // one a tag stages with.
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(/^ {6}npm_version:\n(?: {8}.*\n)*? {8}default: '(.*)'$/m.exec(release.replaceAll('\r\n', '\n'))?.[1]).toBe(pin);
  });

  it('is named to one step, through its environment, and written into no script', () => {
    const uses = release
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line) && line.includes('inputs.npm_version'))
      .map((line) => line.trim());
    expect(uses).toEqual(['CANDIDATE: ${{ inputs.npm_version }}']);
    expect(step.env).toEqual(['DRY_RUN: ${{ inputs.dry_run }}', 'CANDIDATE: ${{ inputs.npm_version }}']);
    // An expression in a script is pasted into it before bash reads a word of
    // it, so text from outside would be run where it should be compared.
    expect(scriptsOf(release).length).toBeGreaterThanOrEqual(5);
    expect(scriptsOf(release).filter((script) => script.includes('${{'))).toEqual([]);
  });

  it("stages in one command, the tag's, and rehearses in the other: a dry run, at the one level npm reports its token exchange", () => {
    const stages = commands.filter(({ where, text }) => where.startsWith('release.yml:') && text.startsWith('npm stage publish '));
    expect(stages.map(({ text }) => flagsOf(text).filter((flag) => flag === '--dry-run' || flag === '--loglevel'))).toEqual([[], ['--dry-run', '--loglevel']]);
    expect(stages[1]?.text).toContain(' --loglevel verbose');
  });

  it.runIf(onLinux)('is the pin for a tag, whatever the run was handed', () => {
    const handed = ['', pin, candidate, '99.0.0', 'latest', '^12', '$(id)'];
    const outcomes = outcomesOf(
      step.script,
      handed.map((CANDIDATE) => ({ ...tag, CANDIDATE })),
    );
    expect(outcomes).toEqual(handed.map(() => ({ status: 0, said: [installed(pin), thePin] })));
  });

  it.runIf(onLinux)('is the version a rehearsal names, and the run says whether that is the pin', () => {
    const [pinned, tried] = outcomesOf(step.script, [
      { ...rehearsal, CANDIDATE: pin },
      { ...rehearsal, CANDIDATE: candidate },
    ]);
    expect(pinned).toEqual({ status: 0, said: [installed(pin), thePin, `Dry run with ${thePin}.`] });
    expect(tried).toEqual({ status: 0, said: [installed(candidate), aCandidate, `Dry run with ${aCandidate}.`] });
  });

  it.runIf(onLinux)('is nothing at all unless the name is one exact version: no range, tag, address or path, and nothing beside it', () => {
    const refused = [
      // Nothing, part of a version, more than one.
      '',
      ' ',
      '12',
      '12.2',
      '12.2.0.1',
      '12.2.0 11.20.0',
      // A range, and what npm reads as one.
      '^12.2.0',
      '~12.2.0',
      '>=12.2.0',
      '12.x',
      '12.2.x',
      '*',
      '12.2.0 || 11.20.0',
      '12.2.0 - 12.3.0',
      // A dist-tag.
      'latest',
      'next-11',
      // A version with more to it than three numbers.
      'v12.2.0',
      '=12.2.0',
      '12.2.0-pre.1',
      '12.2.0+build',
      '012.2.0',
      '12.02.0',
      '12.2.00',
      '+12.2.0',
      '1e1.2.0',
      '12-2-0',
      '12 2 0',
      // An address, a repository, a path.
      'https://example.test/npm.tgz',
      'github:npm/cli',
      'npm/cli',
      'file:../npm',
      '../npm',
      '12.2.0/../x',
      // Something for the shell, or for npm.
      '$(id)',
      '`id`',
      '12.2.0; id',
      '12.2.0 && id',
      '12.2.0" "x',
      "12.2.0' 'x",
      '-g',
      '--registry=https://example.test',
      '12.2.0 --registry=https://example.test',
      // Space around it, and a second line under it.
      ' 12.2.0',
      '12.2.0 ',
      '12.2.0\t',
      '12.2.0\n',
      '\n12.2.0',
      '12.2.0\n--registry=https://example.test',
      '12.2.0\r',
      // Digits that are not the ten.
      '\u0661\u0662.\u0662.\u0660',
      '\uff11\uff12.\uff12.\uff10',
    ];
    const outcomes = outcomesOf(
      step.script,
      refused.map((CANDIDATE) => ({ ...rehearsal, CANDIDATE })),
    );
    const stopped = JSON.stringify({ status: 1, said: [`::error::npm_version must be one exact npm version, such as ${pin}; nothing was installed`] });
    expect(refused.filter((_, index) => JSON.stringify(outcomes[index]) !== stopped)).toEqual([]);
  });

  it.runIf(onLinux)('is nothing at all when the version named is older than 11.15.0, the first that stages', () => {
    const [first, ...older] = outcomesOf(
      step.script,
      ['11.15.0', '11.14.99', '11.9.0', '10.99.99', '2.0.0', '0.0.0'].map((CANDIDATE) => ({ ...rehearsal, CANDIDATE })),
    );
    expect(first?.said[0]).toBe(installed('11.15.0'));
    expect(older.map(({ status, said }) => [status, ...said])).toEqual(
      ['11.14.99', '11.9.0', '10.99.99', '2.0.0', '0.0.0'].map((version) => [1, `::error::npm ${version} is older than 11.15.0, which npm stage publish needs; nothing was installed`]),
    );
  });

  it.runIf(onLinux)('is the npm that answers afterwards, or the run stops before anything is staged', () => {
    const [onTag, onRehearsal] = outcomesOf(step.script, [
      { ...tag, ANSWERS: '11.19.0' },
      { ...rehearsal, CANDIDATE: candidate, ANSWERS: pin },
    ]);
    expect(onTag).toEqual({ status: 1, said: [installed(pin), `::error::npm 11.19.0 answers where npm ${pin} was installed`] });
    expect(onRehearsal).toEqual({ status: 1, said: [installed(candidate), `::error::npm ${pin} answers where npm ${candidate} was installed`] });
  });

  it.runIf(onLinux)('is the pin for a dispatch that stages, which stops when it names another', () => {
    const staging = { GITHUB_EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'false' };
    const [withThePin, withAnother, unsaid, inexact] = outcomesOf(step.script, [
      { ...staging, CANDIDATE: pin },
      { ...staging, CANDIDATE: candidate },
      // The step that stages does so unless the run says it is a dry run, and this one reads it the same way.
      { GITHUB_EVENT_NAME: 'workflow_dispatch', CANDIDATE: candidate },
      { ...staging, CANDIDATE: 'latest' },
    ]);
    const stopped = { status: 1, said: [`::error::a release stages with npm ${pin}, and another npm is for a dry run; nothing was installed`] };
    expect(withThePin).toEqual({ status: 0, said: [installed(pin), thePin] });
    expect(withAnother).toEqual(stopped);
    expect(unsaid).toEqual(stopped);
    expect(inexact).toEqual({ status: 1, said: [`::error::npm_version must be one exact npm version, such as ${pin}; nothing was installed`] });
  });
});
