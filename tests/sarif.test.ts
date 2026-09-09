/**
 * SARIF output.
 *
 * The answer to "how do people find out sooner", chosen over an editor language
 * server. What is asserted here is the contract a code-scanning service relies
 * on: one alert per broken rule, anchored on the offending line, with an
 * identity that survives the code moving.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { formatSarif } from '../src/reporter.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { DEMO_REPO, makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

interface Sarif {
  version: string;
  runs: Array<{
    tool: { driver: { name: string; version: string; rules: Array<{ id: string }> } };
    results: Array<{
      ruleId: string;
      level: string;
      message: { text: string };
      locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
      relatedLocations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
      partialFingerprints: { specGuardAssertion: string };
    }>;
  }>;
}

const sarif = (report: RunResult): Sarif => JSON.parse(formatSarif(report, { version: '9.9.9' })) as Sarif;

describe('the document', () => {
  it('declares the version and schema a consumer keys off', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0002-failing.md'], root: DEMO_REPO, engine: 'javascript' });
    const document = sarif(report);

    expect(document.version).toBe('2.1.0');
    expect(JSON.parse(formatSarif(report))['$schema']).toBe(
      'https://json.schemastore.org/sarif-2.1.0.json',
    );
    expect(document.runs).toHaveLength(1);
    expect(document.runs[0]?.tool.driver.name).toBe('spec-guard');
    expect(document.runs[0]?.tool.driver.version).toBe('9.9.9');
  });

  it('declares a rule for every directive kind', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0001-passing.md'], root: DEMO_REPO, engine: 'javascript' });
    const ids = sarif(report).runs[0]?.tool.driver.rules.map((rule) => rule.id);

    expect(ids).toEqual([
      'assert-absence',
      'assert-count',
      'assert-present',
      'assert-import-absence',
      'assert-import-count',
      'invalid-directive',
    ]);
  });
});

describe('what becomes a result', () => {
  it('reports nothing when every assertion holds', async () => {
    const report = await runSpecGuard({ patterns: ['docs/adr/0001-passing.md'], root: DEMO_REPO, engine: 'javascript' });

    expect(sarif(report).runs[0]?.results).toEqual([]);
  });

  it('anchors a failure on the offending line, not the spec', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
      'src/app.ts': 'const x = 1;\nconst y = LegacyGateway;\n',
    });

    const [result] = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).runs[0]
      ?.results as Sarif['runs'][0]['results'];

    expect(result?.ruleId).toBe('assert-absence');
    expect(result?.level).toBe('error');
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('src/app.ts');
    expect(result?.locations[0]?.physicalLocation.region.startLine).toBe(2);
    // The directive is always reachable from the alert, because that is often
    // where the fix goes.
    expect(result?.relatedLocations.map((location) => location.physicalLocation.artifactLocation.uri)).toContain(
      'docs/a.md',
    );
  });

  it('anchors a failure with no match on the directive', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-present file="MISSING.md" -->\n',
      'src/app.ts': 'const x = 1;\n',
    });

    const [result] = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).runs[0]
      ?.results as Sarif['runs'][0]['results'];

    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('docs/a.md');
    expect(result?.relatedLocations).toEqual([]);
  });

  it('reports a directive that will not parse', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" -->\n',
      'src/app.ts': 'const x = 1;\n',
    });

    const [result] = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).runs[0]
      ?.results as Sarif['runs'][0]['results'];

    expect(result?.ruleId).toBe('invalid-directive');
    expect(result?.message.text).toContain('requires a non-empty symbol');
  });

  it('emits one result per broken rule, not per match', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
      'src/a.ts': 'const a = LegacyGateway;\n',
      'src/b.ts': 'const b = LegacyGateway;\n',
      'src/c.ts': 'const c = LegacyGateway;\n',
    });

    const results = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).runs[0]
      ?.results as Sarif['runs'][0]['results'];

    expect(results).toHaveLength(1);
    expect(results[0]?.relatedLocations.length).toBe(3); // two more matches, plus the directive
  });
});

describe('alert identity', () => {
  it('survives the offending code moving', async () => {
    // The point of a fingerprint: a code-scanning service must see the same
    // still-open alert rather than closing one and opening another every time
    // somebody adds a line above the violation.
    const before = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
      'src/app.ts': 'const y = LegacyGateway;\n',
    });
    const after = await repo({
      'docs/a.md': '<!-- @assert-absence target="src" symbol="LegacyGateway" -->\n',
      'src/app.ts': '// a new comment\n\nconst y = LegacyGateway;\n',
    });

    const one = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root: before, engine: 'javascript' }));
    const two = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root: after, engine: 'javascript' }));

    expect(one.runs[0]?.results[0]?.locations[0]?.physicalLocation.region.startLine).toBe(1);
    expect(two.runs[0]?.results[0]?.locations[0]?.physicalLocation.region.startLine).toBe(3);
    expect(one.runs[0]?.results[0]?.partialFingerprints.specGuardAssertion).toBe(
      two.runs[0]?.results[0]?.partialFingerprints.specGuardAssertion,
    );
  });

  it('differs between two assertions in the same spec', async () => {
    const root = await repo({
      'docs/a.md':
        '<!-- @assert-absence target="src" symbol="AlphaGone" -->\n<!-- @assert-absence target="src" symbol="BetaGone" -->\n',
      'src/app.ts': 'const a = AlphaGone;\nconst b = BetaGone;\n',
    });

    const results = sarif(await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).runs[0]
      ?.results as Sarif['runs'][0]['results'];

    expect(results).toHaveLength(2);
    expect(results[0]?.partialFingerprints.specGuardAssertion).not.toBe(
      results[1]?.partialFingerprints.specGuardAssertion,
    );
  });
});

describe('--format', () => {
  it.each([
    ['human', 'human'],
    ['json', 'json'],
    ['sarif', 'sarif'],
    ['SARIF', 'sarif'],
  ])('accepts %s', (input, expected) => {
    expect(parseArgs(['--format', input], DEMO_REPO).format).toBe(expected);
  });

  it('defaults to human, and --json still selects json', () => {
    expect(parseArgs([], DEMO_REPO).format).toBe('human');
    expect(parseArgs(['--json'], DEMO_REPO)).toMatchObject({ format: 'json', json: true });
  });

  it('rejects a format it does not have', () => {
    expect(() => parseArgs(['--format', 'xml'], DEMO_REPO)).toThrow(UsageError);
    expect(() => parseArgs(['--format', 'xml'], DEMO_REPO)).toThrow('Unknown format "xml"');
  });

  it('reaches stdout through the CLI', async () => {
    const out: string[] = [];
    const io: CliIO = { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };

    const code = await main(['docs/adr/0002-failing.md', '--engine', 'js', '--format', 'sarif'], io);

    expect(code).toBe(EXIT_FAILED);
    expect(JSON.parse(out.join('\n')).runs[0].results.length).toBeGreaterThan(0);
  });

  it('still emits a document when no spec file matched', async () => {
    const out: string[] = [];
    const io: CliIO = { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: DEMO_REPO, isTTY: false };

    const code = await main(['docs/**/*.rst', '--engine', 'js', '--format', 'sarif'], io);

    expect(code).toBe(EXIT_ERROR);
    expect(JSON.parse(out.join('\n')).runs[0].results).toEqual([]);
  });
});
