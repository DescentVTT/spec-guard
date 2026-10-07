/**
 * Every job says which image it runs on.
 *
 * A `-latest` label is GitHub's to move. `ubuntu-latest` goes from Ubuntu
 * 24.04 to 26.04 between 2026-10-19 and 2026-11-19, and for that month a job
 * is handed either (actions/runner-images issue 14748); `windows-latest` and
 * `macos-latest` both moved in June 2026. The mutation gate takes its
 * timeouts from timings measured on one image, every release so far was
 * packed and staged on that one, and a score read on two is two scores. So
 * a job names its image, as it names its actions by commit
 * (tests/action-pins.test.ts) and the release its npm by version, and an
 * image moves by an edit made on purpose: spec-core's ADR-0008 has the
 * labels and the steps.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/**
 * The labels that each name one image, read from the table in
 * actions/runner-images on 2026-10-07. `windows-2025` is not among them: it
 * is the label that moved to the Visual Studio 2026 image in June.
 */
const IMAGES: readonly string[] = ['ubuntu-24.04', 'ubuntu-26.04', 'windows-2025-vs2026', 'macos-26'];

/**
 * Where every job but the suite's matrix runs: the image the sweep's timings
 * and the coverage floors were measured on, and every release so far was
 * staged from. Moving it is the procedure in spec-core's ADR-0008.
 */
const GATES = 'ubuntu-24.04';

/** What `runs-on` says where the job's matrix chooses; the matrix's `os` entries are read in its place. */
const FROM_MATRIX = '${{ matrix.os }}';

interface Label {
  readonly where: string;
  readonly label: string;
  /** Whether a matrix lists it, rather than a job naming it. */
  readonly matrix: boolean;
}

/** A line without its comment, since a comment runs nothing. */
const code = (line: string): string => line.replace(/(?:^|\s)#.*$/, '');

/**
 * The labels `text` hands its jobs: what follows each `runs-on:`, and each
 * entry of an `os:` a matrix or one of its `include` entries has. A list is
 * read as written on one line, which is how the workflows here write theirs.
 */
function labelsOf(text: string, file: string): Label[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*(?:-\s+)?(runs-on|os):\s*(\S.*?)\s*$/.exec(code(line));
    if (match === null || match[2] === FROM_MATRIX) return [];
    return (match[2] as string)
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((word) => word.trim().replace(/^(["'])(.*)\1$/, '$2'))
      .filter((word) => word !== '')
      .map((label) => ({ where: `${file}:${index + 1}`, label, matrix: match[1] === 'os' }));
  });
}

/** What is wrong with a label, if anything. */
function faultOf(label: string): string | null {
  if (IMAGES.includes(label)) return null;
  return /-latest(?:-|$)/.test(label) ? 'is a label GitHub moves' : "is not an image spec-core's ADR-0008 names";
}

/**
 * Each line of `text` that says a `-latest` label anywhere but in a comment.
 * A matrix written as a block list, and a step's condition on one leg, name
 * a label with no `runs-on` and no `os` on the line.
 */
function movingIn(text: string, file: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => (/\b(?:ubuntu|windows|macos)-(?:[\w.]+-)*latest\b/.test(code(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
}

const workflows = readdirSync(join(ROOT, '.github/workflows'))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => [name, readFileSync(join(ROOT, '.github/workflows', name), 'utf8')] as const);

describe('the image a job runs on', () => {
  const faults = (text: string): Array<string | null> => labelsOf(text, 'x').map(({ label }) => faultOf(label));

  it.each([
    ['    runs-on: ubuntu-latest', 1],
    ['        os: [ubuntu-latest, windows-latest, macos-latest]', 3],
    ['          - os: macos-latest', 1],
    ["    runs-on: 'windows-latest'", 1],
    // The larger macOS runners have a `-latest` of their own.
    ['    runs-on: macos-latest-large', 1],
  ])('is one GitHub moves, as %j names it', (text, count) => {
    expect(faults(text)).toEqual(Array.from({ length: count }, () => 'is a label GitHub moves'));
  });

  it.each([
    // The label that moved in June 2026, and an image nothing here was measured on.
    ['    runs-on: windows-2025', 1],
    ['    runs-on: ubuntu-22.04', 1],
    ['    runs-on: [self-hosted, linux]', 2],
    // An expression other than the matrix's names nothing this file can read.
    ['    runs-on: ${{ inputs.os }}', 1],
  ])("is not one spec-core's ADR-0008 names, as %j names it", (text, count) => {
    expect(faults(text)).toEqual(Array.from({ length: count }, () => "is not an image spec-core's ADR-0008 names"));
  });

  it.each([
    ['    runs-on: ubuntu-24.04', 1],
    ['        os: [ubuntu-24.04, ubuntu-26.04, windows-2025-vs2026, macos-26]', 4],
    ['    runs-on: ubuntu-24.04 # what ubuntu-latest was until 2026-10-19', 1],
  ])('is in order as %j names it', (text, count) => {
    expect(faults(text)).toEqual(Array.from({ length: count }, () => null));
  });

  it.each([
    ['    runs-on: ${{ matrix.os }}'],
    ['    # runs-on: ubuntu-latest'],
    ['    name: test (${{ matrix.os }}, node ${{ matrix.node }})'],
    ["          node-version: '24'"],
  ])('is not what %j names: the matrix is read where it is written, and a comment runs nothing', (text) => {
    expect(faults(text)).toEqual([]);
  });
});

describe('a `-latest` label, wherever a workflow says one', () => {
  it.each([
    ['    runs-on: ubuntu-latest'],
    ["        if: always() && matrix.os == 'ubuntu-latest' && matrix.node == '22'"],
    ['          - windows-latest'],
    ['    runs-on: macos-latest-large'],
  ])('is found in %j', (text) => {
    expect(movingIn(text, 'x')).toEqual([`x:1: ${text.trim()}`]);
  });

  it.each([
    ['    runs-on: ubuntu-24.04'],
    ["        if: always() && matrix.os == 'ubuntu-24.04' && matrix.node == '22'"],
    ['      # `ubuntu-latest` hands a job either image from 2026-10-19.'],
    ['    runs-on: ubuntu-24.04 # what ubuntu-latest was'],
    // npm's dist-tag, and words that only end like a label.
    ['          npm install -g npm@latest'],
    ['          echo "ubuntu-latestish, the-latest"'],
  ])('is not found in %j', (text) => {
    expect(movingIn(text, 'x')).toEqual([]);
  });
});

describe('the workflows here', () => {
  const labels = workflows.flatMap(([name, text]) => labelsOf(text, name));
  const shown = (found: readonly Label[]): string[] => found.map(({ where, label }) => `${where}: ${label} ${faultOf(label) ?? ''}`.trim());

  it('are read, down to each job and the matrix', () => {
    // A workflow that moved, or a `runs-on` this file no longer reads, would
    // leave the checks below nothing to fail on.
    expect(workflows.map(([name]) => name)).toEqual(expect.arrayContaining(['ci.yml', 'mutation.yml', 'release.yml']));
    const written = workflows.flatMap(([, text]) => text.split(/\r?\n/).filter((line) => /^\s*runs-on:/.test(line)));
    const fromMatrix = written.filter((line) => line.includes(FROM_MATRIX));
    expect(fromMatrix).toHaveLength(1);
    expect(labels.filter(({ matrix }) => !matrix)).toHaveLength(written.length - fromMatrix.length);
    expect(written.length).toBeGreaterThanOrEqual(7);
    // The suite runs where its coverage and its sweep are measured.
    expect(labels.filter(({ matrix }) => matrix).map(({ label }) => label)).toContain(GATES);
  });

  it('name no `-latest` label, in a job, a matrix or a condition on either', () => {
    expect(workflows.flatMap(([name, text]) => movingIn(text, name))).toEqual([]);
  });

  it("run every job on an image spec-core's ADR-0008 names", () => {
    expect(shown(labels.filter(({ label }) => faultOf(label) !== null))).toEqual([]);
  });

  it('run everything but the matrix on the one image the gates were measured on', () => {
    // A gate on another image is another measurement: spec-core's ADR-0008
    // says what moving one takes, and this constant moves with it.
    expect(labels.filter(({ matrix, label }) => !matrix && label !== GATES).map(({ where, label }) => `${where}: ${label}, where the gates run on ${GATES}`)).toEqual([]);
  });
});
