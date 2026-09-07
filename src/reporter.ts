/**
 * Terminal and JSON reporting.
 *
 * The failure block is the whole product: a spec author who broke an invariant
 * should be able to fix it without opening a single file, so every failure
 * carries the spec location, the expectation, the observed count and real
 * snippets from the offending code.
 */

import type { AssertionResult, DirectiveError } from './types.js';
import type { RunResult } from './runner.js';

export interface ReporterOptions {
  color: boolean;
  verbose: boolean;
  /** Symbols safe for legacy Windows consoles. */
  ascii?: boolean;
}

// Raw SGR codes - a colour library is not worth a dependency here.
const ESC = String.fromCharCode(27);

const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
} as const;

type Style = keyof typeof ANSI;

/** Creates a `paint(text, style)` helper honouring the color setting. */
export function createPainter(color: boolean): (text: string, ...styles: Style[]) => string {
  if (!color) return (text: string) => text;
  return (text: string, ...styles: Style[]) =>
    styles.length === 0 ? text : `${styles.map((style) => ANSI[style]).join('')}${text}${ANSI.reset}`;
}

/**
 * Colour is on only when the stream is a TTY and nobody asked otherwise.
 * Honours the NO_COLOR and FORCE_COLOR conventions.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag !== undefined) return flag;
  if (env['NO_COLOR']) return false;
  if (env['FORCE_COLOR'] && env['FORCE_COLOR'] !== '0') return true;
  return Boolean(stream.isTTY);
}

/** Legacy Windows consoles render box-drawing glyphs poorly; degrade to ASCII. */
export function shouldUseAscii(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  return !env['WT_SESSION'] && !env['TERM'] && !env['TERM_PROGRAM'];
}

function symbols(ascii: boolean): { pass: string; fail: string; warn: string; more: string } {
  return ascii
    ? { pass: '+', fail: 'x', warn: '!', more: '...' }
    : { pass: '✔', fail: '✖', warn: '⚠', more: '…' };
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function countLabel(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  // "match" -> "matches", "spec" -> "specs".
  return `${count} ${noun}${/(?:s|x|z|ch|sh)$/.test(noun) ? 'es' : 's'}`;
}

function formatLocation(result: { location: { relativeFile: string; line: number } }): string {
  return `${result.location.relativeFile}:${result.location.line}`;
}

/**
 * Prose for the two ways comment classification changed a count.
 *
 * Kept next to each other because they pull in opposite directions: excluded
 * matches make an assertion easier to satisfy, unclassified files make it
 * harder. Both are worth saying out loud.
 */
function commentNotes(result: {
  commentMatches: number;
  unclassifiedFiles: number;
}): string[] {
  const notes: string[] = [];
  if (result.commentMatches > 0) {
    notes.push(
      `${countLabel(result.commentMatches, 'match')} inside comments ${
        result.commentMatches === 1 ? 'was' : 'were'
      } not counted; add comments="include" to count ${result.commentMatches === 1 ? 'it' : 'them'}`,
    );
  }
  if (result.unclassifiedFiles > 0) {
    notes.push(
      `comment syntax unknown for ${countLabel(result.unclassifiedFiles, 'matching file')}; comments in ${
        result.unclassifiedFiles === 1 ? 'it' : 'them'
      } counted as code`,
    );
  }
  return notes;
}

function formatFailure(
  result: AssertionResult,
  paint: ReturnType<typeof createPainter>,
  glyphs: ReturnType<typeof symbols>,
  maxSnippets: number,
): string[] {
  const lines: string[] = [];
  lines.push(
    `${paint(glyphs.fail, 'red', 'bold')} ${paint(formatLocation(result), 'bold')}  ${paint(`@${result.kind}`, 'magenta')}`,
  );
  lines.push(`    ${result.description}`);
  lines.push(`    ${paint(result.message, 'red')}`);
  if (result.reason) lines.push(`    ${paint(`reason: ${result.reason}`, 'dim')}`);

  for (const note of commentNotes(result)) {
    lines.push(`    ${paint(`${glyphs.warn} ${note}`, 'yellow')}`);
  }

  for (const warning of result.warnings) {
    lines.push(`    ${paint(`${glyphs.warn} ${warning}`, 'yellow')}`);
  }

  const shown = result.matches.slice(0, maxSnippets);
  for (const match of shown) {
    const where = paint(`${match.file}:${match.line}:${match.column}`, 'cyan');
    lines.push(`      ${where}  ${paint(match.text.trim(), 'gray')}`);
  }

  const remaining = result.actual - shown.reduce((total, match) => total + match.count, 0);
  if (remaining > 0) {
    lines.push(`      ${paint(`${glyphs.more} ${countLabel(remaining, 'more match')} not shown`, 'dim')}`);
  }

  return lines;
}

function formatPass(
  result: AssertionResult,
  paint: ReturnType<typeof createPainter>,
  glyphs: ReturnType<typeof symbols>,
): string {
  const detail =
    result.kind === 'assert-present'
      ? result.files.join(', ')
      : `"${result.symbol}" ${paint(`(${countLabel(result.actual, 'match')})`, 'dim')} in ${result.targets.join(', ')}`;
  return `${paint(glyphs.pass, 'green')} ${paint(formatLocation(result), 'dim')}  ${paint(`@${result.kind}`, 'dim')} ${detail}`;
}

function formatError(
  error: DirectiveError,
  paint: ReturnType<typeof createPainter>,
  glyphs: ReturnType<typeof symbols>,
): string[] {
  const lines = [
    `${paint(glyphs.warn, 'yellow', 'bold')} ${paint(formatLocation(error), 'bold')}  ${paint('invalid directive', 'yellow')}`,
    `    ${error.message}`,
  ];
  if (error.raw) lines.push(`    ${paint(error.raw.split('\n')[0] as string, 'dim')}`);
  return lines;
}

/** Renders the full human-readable report. */
export function formatReport(report: RunResult, options: ReporterOptions, maxSnippets = 5): string {
  const paint = createPainter(options.color);
  const glyphs = symbols(options.ascii ?? false);
  const lines: string[] = [];

  const failures = report.results.filter((result) => !result.ok);
  const passes = report.results.filter((result) => result.ok);

  // The engine label is only meaningful once something was actually searched.
  const searched = report.results.some((result) => result.engine !== undefined);
  const headline = [
    countLabel(report.summary.specs, 'spec'),
    countLabel(report.summary.total, 'assertion'),
    ...(searched ? [report.engine] : []),
  ].join(' · ');
  lines.push(`${paint('spec-guard', 'bold', 'blue')} ${paint(headline, 'dim')}`);
  lines.push('');

  if (options.verbose) {
    for (const result of passes) lines.push(formatPass(result, paint, glyphs));
    if (passes.length > 0) lines.push('');
  }

  for (const warning of report.warnings) {
    lines.push(`${paint(glyphs.warn, 'yellow')} ${paint(warning, 'yellow')}`);
  }
  if (report.warnings.length > 0) lines.push('');

  if (options.verbose) {
    for (const result of passes) {
      for (const note of [...commentNotes(result), ...result.warnings]) {
        lines.push(`${paint(glyphs.warn, 'yellow')} ${paint(`${formatLocation(result)}  ${note}`, 'yellow')}`);
      }
    }
  }

  for (const error of report.errors) {
    lines.push(...formatError(error, paint, glyphs));
    lines.push('');
  }

  for (const failure of failures) {
    lines.push(...formatFailure(failure, paint, glyphs, maxSnippets));
    lines.push('');
  }

  // Passing assertions only. A failure prints its own notes above; a pass prints
  // nothing at all, and a pass that owes itself to comment exclusion is exactly
  // the thing that must not stay quiet.
  const totals = passes.reduce(
    (sum, result) => ({
      commentMatches: sum.commentMatches + result.commentMatches,
      unclassifiedFiles: sum.unclassifiedFiles + result.unclassifiedFiles,
    }),
    { commentMatches: 0, unclassifiedFiles: 0 },
  );
  const summaryNotes = commentNotes(totals);
  if (summaryNotes.length > 0) {
    for (const note of summaryNotes) lines.push(`${paint(glyphs.warn, 'yellow')} ${paint(note, 'yellow')}`);
    lines.push('');
  }

  const parts = [
    paint(`${report.summary.passed} passed`, 'green'),
    failures.length > 0 ? paint(`${report.summary.failed} failed`, 'red', 'bold') : null,
    report.errors.length > 0 ? paint(`${report.errors.length} invalid`, 'yellow') : null,
    report.summary.skipped > 0 ? paint(`${report.summary.skipped} skipped`, 'dim') : null,
    paint(formatDuration(report.durationMs), 'dim'),
  ].filter((part): part is string => part !== null);

  lines.push(parts.join(paint(' · ', 'dim')));

  if (report.ok) {
    lines.push(paint(`${glyphs.pass} every spec assertion holds`, 'green'));
  }

  return lines.join('\n');
}

/** Machine-readable output for CI consumers. */
export function formatJson(report: RunResult): string {
  return JSON.stringify(
    {
      ok: report.ok,
      root: report.root,
      engine: report.engine,
      durationMs: Math.round(report.durationMs * 1000) / 1000,
      summary: report.summary,
      specFiles: report.specFiles,
      results: report.results.map((result) => ({
        ok: result.ok,
        kind: result.kind,
        spec: {
          file: result.location.relativeFile,
          line: result.location.line,
          column: result.location.column,
        },
        description: result.description,
        message: result.message,
        reason: result.reason,
        symbol: result.symbol,
        targets: result.targets,
        files: result.files,
        bounds: result.bounds,
        actual: result.actual,
        matches: result.matches,
        warnings: result.warnings,
        commentMatches: result.commentMatches,
        unclassifiedFiles: result.unclassifiedFiles,
        engine: result.engine,
        durationMs: Math.round(result.durationMs * 1000) / 1000,
      })),
      errors: report.errors.map((error) => ({
        spec: {
          file: error.location.relativeFile,
          line: error.location.line,
          column: error.location.column,
        },
        message: error.message,
        raw: error.raw,
      })),
      warnings: report.warnings,
    },
    null,
    2,
  );
}
