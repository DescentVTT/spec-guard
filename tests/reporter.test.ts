import { describe, expect, it } from 'vitest';

import { createPainter, formatJson, formatReport, shouldUseAscii, shouldUseColor } from '../src/reporter.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { DEMO_REPO } from './helpers.js';

const ESC = String.fromCharCode(27);

async function report(pattern: string, options: Parameters<typeof runSpecGuard>[0] = { patterns: [] }) {
  return runSpecGuard({ ...options, patterns: [pattern], root: DEMO_REPO, engine: 'javascript' });
}

describe('shouldUseColor', () => {
  it('respects an explicit flag above everything else', () => {
    expect(shouldUseColor({ isTTY: false }, true, { NO_COLOR: '1' })).toBe(true);
    expect(shouldUseColor({ isTTY: true }, false, { FORCE_COLOR: '1' })).toBe(false);
  });

  it('honours NO_COLOR and FORCE_COLOR', () => {
    expect(shouldUseColor({ isTTY: true }, undefined, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, undefined, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldUseColor({ isTTY: false }, undefined, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('falls back to TTY detection', () => {
    expect(shouldUseColor({ isTTY: true }, undefined, {})).toBe(true);
    expect(shouldUseColor({}, undefined, {})).toBe(false);
  });
});

describe('shouldUseAscii', () => {
  it('only degrades on a bare Windows console', () => {
    expect(shouldUseAscii({}, 'win32')).toBe(true);
    expect(shouldUseAscii({ WT_SESSION: '1' }, 'win32')).toBe(false);
    expect(shouldUseAscii({ TERM: 'xterm' }, 'win32')).toBe(false);
    expect(shouldUseAscii({}, 'linux')).toBe(false);
  });
});

describe('createPainter', () => {
  it('emits SGR codes only when colour is on', () => {
    expect(createPainter(false)('x', 'red')).toBe('x');
    expect(createPainter(true)('x', 'red')).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(createPainter(true)('x')).toBe('x');
  });
});

describe('formatReport', () => {
  it('summarises a passing run', async () => {
    const output = formatReport(await report('docs/adr/0001-passing.md'), { color: false, verbose: false });

    expect(output).toContain('spec-guard 1 spec · 8 assertions · javascript');
    expect(output).toContain('8 passed');
    expect(output).toContain('every spec assertion holds');
    expect(output).not.toContain('failed');
  });

  it('lists passing assertions in verbose mode only', async () => {
    const result = await report('docs/adr/0001-passing.md');

    expect(formatReport(result, { color: false, verbose: true })).toContain('@assert-count "UserSessionManager"');
    expect(formatReport(result, { color: false, verbose: false })).not.toContain('UserSessionManager');
  });

  it('shows the spec location, expectation and snippets for a failure', async () => {
    const output = formatReport(await report('docs/adr/0002-failing.md'), { color: false, verbose: false });

    expect(output).toContain('docs/adr/0002-failing.md:6');
    expect(output).toContain('"LegacyPaymentGateway" must not appear in src');
    expect(output).toContain('expected no matches, found 2');
    expect(output).toContain('reason: retired in ADR-0002');
    expect(output).toContain('src/legacy/LegacyPaymentGateway.ts:2:14');
    expect(output).toContain('export class LegacyPaymentGateway {');
    expect(output).toContain('4 failed');
  });

  it('caps snippets and says how many matches were hidden', async () => {
    const result = await report('docs/adr/0002-failing.md');
    const output = formatReport(result, { color: false, verbose: false }, 1);

    expect(output).toContain('1 more match not shown');
  });

  it('renders invalid directives with their source line', async () => {
    const output = formatReport(await report('docs/adr/0003-invalid.md'), { color: false, verbose: false });

    expect(output).toContain('invalid directive');
    expect(output).toContain('Unknown attribute "expct"');
    expect(output).toContain('<!-- @assert-count target="src/" symbol="Whatever" expct="1" -->');
    expect(output).toContain('4 invalid');
  });

  it('surfaces target warnings in verbose mode', async () => {
    const output = formatReport(await report('docs/adr/0005-missing-target.md'), { color: false, verbose: true });
    expect(output).toContain('target path not found: src/does-not-exist');
  });

  it('mentions assertions skipped by fail-fast', async () => {
    const result = await runSpecGuard({
      patterns: ['docs/adr/0002-failing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
      failFast: true,
    });

    expect(formatReport(result, { color: false, verbose: false })).toContain('3 skipped');
  });

  it('omits the engine label when nothing was searched', async () => {
    const result = await runSpecGuard({ patterns: ['docs/**/*.rst'], root: DEMO_REPO, engine: 'javascript' });
    expect(formatReport(result, { color: false, verbose: false })).toContain('0 specs · 0 assertions\n');
  });

  it('renders run-level warnings', async () => {
    const result = await report('docs/adr/0001-passing.md');
    const withWarning: RunResult = { ...result, warnings: ['ripgrep failed, fell back'] };
    expect(formatReport(withWarning, { color: false, verbose: false })).toContain('ripgrep failed, fell back');
  });

  it('uses ASCII glyphs on request', async () => {
    const output = formatReport(await report('docs/adr/0002-failing.md'), {
      color: false,
      verbose: false,
      ascii: true,
    });

    expect(output).toContain('x docs/adr/0002-failing.md:6');
    expect(output).not.toContain('✖');
  });

  it('emits colour when asked', async () => {
    const output = formatReport(await report('docs/adr/0002-failing.md'), { color: true, verbose: false });
    expect(output).toContain(ESC);
  });

  it('formats durations above a second', async () => {
    const result = await report('docs/adr/0001-passing.md');
    expect(formatReport({ ...result, durationMs: 1500 }, { color: false, verbose: false })).toContain('1.50s');
  });
});

describe('formatJson', () => {
  it('produces a stable machine-readable shape', async () => {
    const parsed = JSON.parse(formatJson(await report('docs/adr/0002-failing.md')));

    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toMatchObject({ specs: 1, total: 4, passed: 0, failed: 4, skipped: 0 });
    expect(parsed.specFiles).toEqual(['docs/adr/0002-failing.md']);
    expect(parsed.engine).toBe('javascript');
    expect(typeof parsed.durationMs).toBe('number');

    const [first] = parsed.results;
    expect(first).toMatchObject({
      ok: false,
      kind: 'assert-absence',
      spec: { file: 'docs/adr/0002-failing.md', line: 6, column: 1 },
      symbol: 'LegacyPaymentGateway',
      targets: ['src'],
      bounds: { max: 0 },
      actual: 2,
      reason: 'retired in ADR-0002',
      engine: 'javascript',
    });
    expect(first.matches[0]).toMatchObject({
      file: 'src/legacy/LegacyPaymentGateway.ts',
      line: 2,
      column: 14,
      count: 1,
    });
  });

  it('includes directive errors', async () => {
    const parsed = JSON.parse(formatJson(await report('docs/adr/0003-invalid.md')));

    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors[0]).toMatchObject({
      spec: { file: 'docs/adr/0003-invalid.md', line: 5 },
    });
    expect(parsed.errors[0].message).toContain('Unknown attribute');
  });
});

describe('formatReport warnings on failures', () => {
  it('prints a target warning inside a failing assertion block', async () => {
    const result = await runSpecGuard({
      patterns: ['docs/adr/0002-failing.md'],
      root: DEMO_REPO,
      engine: 'javascript',
    });

    const failing = result.results[2];
    if (!failing) throw new Error('expected a failing assertion');
    const withWarning: RunResult = {
      ...result,
      results: [{ ...failing, warnings: ['target path not found: src/gone'] }],
    };

    const output = formatReport(withWarning, { color: false, verbose: false });
    expect(output).toContain('⚠ target path not found: src/gone');
  });
});
