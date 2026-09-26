/**
 * Terminal and JSON reporting.
 *
 * The failure block is the whole product: a spec author who broke an invariant
 * should be able to fix it without opening a single file, so every failure
 * carries the spec location, the expectation, the observed count and real
 * snippets from the offending code.
 */

import { createHash } from 'node:crypto';

import { mergeLedgers, tallyLedger, type ScopeLedger } from './scope.js';
import type {
  AssertionResult,
  CitesReport,
  ConfigUse,
  DirectiveError,
  InactiveSpec,
  MaskedDirective,
  ProveClaim,
  ProveOutcome,
  ProveReport,
  ProveResult,
  SpecWarning,
} from './types.js';
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

function symbols(ascii: boolean): { pass: string; fail: string; warn: string; skip: string; more: string } {
  return ascii
    ? { pass: '+', fail: 'x', warn: '!', skip: 'o', more: '...' }
    : { pass: '✔', fail: '✖', warn: '⚠', skip: '○', more: '…' };
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
  baselinedMatches: number;
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
  if (result.baselinedMatches > 0) {
    // The third way a green can be bought rather than earned, after comment
    // exclusion and an unreadable file. Same treatment: say it every time.
    notes.push(
      `${countLabel(result.baselinedMatches, 'match')} excluded by the baseline`,
    );
  }
  return notes;
}

/**
 * Prose for the files an assertion did not inspect.
 *
 * This is the line that decides whether a green run can be trusted. A guard
 * that skips a directory and says nothing is indistinguishable from one that
 * searched it and found nothing, and only one of those is a reason to relax.
 */
function scopeNotes(ledger: ScopeLedger): string[] {
  const notes: string[] = [];
  const totals = tallyLedger(ledger);

  const unreadable = totals.get('unreadable') ?? 0;
  if (unreadable > 0) {
    const sample = ledger.skipped
      .filter((entry) => entry.reason === 'unreadable')
      .slice(0, 3)
      .map((entry) => entry.path);
    notes.push(`${countLabel(unreadable, 'path')} could not be read: ${sample.join(', ')}`);
  }

  const binary = ledger.skipped.filter((entry) => entry.reason === 'binary');
  if (binary.length > 0) {
    const matches = binary.reduce((total, entry) => total + (entry.matches ?? 0), 0);
    notes.push(
      `${countLabel(matches, 'match')} in ${countLabel(binary.length, 'binary file')} not counted: ${binary
        .slice(0, 3)
        .map((entry) => entry.path)
        .join(', ')}`,
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

  for (const note of [...commentNotes(result), ...scopeNotes(result.scope)]) {
    lines.push(`    ${paint(`${glyphs.warn} ${note}`, 'yellow')}`);
  }

  for (const warning of result.warnings) {
    lines.push(`    ${paint(`${glyphs.warn} ${warning}`, 'yellow')}`);
  }

  const shown = result.matches.slice(0, maxSnippets);
  for (const match of shown) {
    // A structure violation is a path, not a place in one; a line of 0 says so.
    const where = paint(match.line === 0 ? match.file : `${match.file}:${match.line}:${match.column}`, 'cyan');
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
      : result.symbol === undefined
        ? // A cycle or layer rule has no symbol to quote, and its description
          // already says what it is about and where.
          `${result.description} ${paint(`(${countLabel(result.actual, result.kind === 'assert-import-cycle' ? 'cycle' : result.kind === 'assert-structure' ? 'violation' : 'violating file')})`, 'dim')}`
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

/**
 * What changed how a document was read, on the line it happened. Yellow, as a
 * note is: nothing failed, but a rule may not have run where it was written.
 */
function formatSpecWarnings(warnings: readonly SpecWarning[] | undefined, paint: ReturnType<typeof createPainter>, glyphs: ReturnType<typeof symbols>): string[] {
  const lines = (warnings ?? []).map(
    (warning) => `${paint(glyphs.warn, 'yellow')} ${paint(`${warning.location.relativeFile}:${warning.location.line}  ${warning.message}`, 'yellow')}`,
  );
  return lines.length === 0 ? [] : [...lines, ''];
}

/** How many locations the line about masked directives names before it counts the rest. */
const MASKED_SHOWN = 5;

/**
 * The one line that counts the directive-shaped comments no rule was read
 * from, and says where: dim, as a withheld document is, since most are
 * examples shown on purpose. The first few are named, and every one under
 * `--verbose`; JSON names them all.
 */
function formatMasked(masked: readonly MaskedDirective[] | undefined, paint: ReturnType<typeof createPainter>, glyphs: ReturnType<typeof symbols>, verbose: boolean): string[] {
  const all = masked ?? [];
  if (all.length === 0) return [];
  const shown = verbose ? all : all.slice(0, MASKED_SHOWN);
  const places = shown.map(({ location }) => `${location.relativeFile}:${location.line}`).join(', ');
  const rest = all.length - shown.length;
  const was = all.length === 1 ? 'was' : 'were';
  return [
    paint(
      `${glyphs.skip} ${countLabel(all.length, 'directive-shaped comment')} in code, raw HTML or front matter ${was} not run: ${places}${rest > 0 ? ` and ${rest} more` : ''}`,
      'dim',
    ),
    '',
  ];
}

/** Directive-shaped comments as a script reads them, each with what hid it. */
function maskedJson(masked: readonly MaskedDirective[] | undefined): Array<{ spec: { file: string; line: number; column: number }; inside: string }> {
  return (masked ?? []).map(({ location, inside }) => ({ spec: { file: location.relativeFile, line: location.line, column: location.column }, inside }));
}

/** A document's warnings as a script reads them, placed as errors are. */
function specWarningsJson(warnings: readonly SpecWarning[] | undefined): Array<{ spec: { file: string; line: number; column: number }; message: string }> {
  return (warnings ?? []).map((warning) => ({
    spec: { file: warning.location.relativeFile, line: warning.location.line, column: warning.location.column },
    message: warning.message,
  }));
}

/**
 * The line that says which options came from a project's configuration.
 *
 * Unpainted, in every report that took any: an option in a file nobody is
 * looking at is the one kind of setting a reader cannot infer from the command
 * they typed. Keys the command line set as well are named too, since a reader
 * who finds `"strict": false` in the file needs to know it lost. ADR-0014.
 *
 * Given the exclusions in force, `exclude` is named with its patterns, applied
 * or overridden: a key alone said paths were left out without saying which.
 */
export function formatConfigUse(use: ConfigUse, exclude?: readonly string[]): string {
  const name = (key: string): string => (key === 'exclude' && exclude !== undefined ? `exclude (${patternList(exclude)})` : key);
  const applied = use.applied.length === 0 ? 'none' : use.applied.map(name).join(', ');
  const overridden = use.overridden.length === 0 ? '' : `; overridden on the command line: ${use.overridden.map(name).join(', ')}`;
  return `options from ${use.file}: ${applied}${overridden}`;
}

/** Patterns as a report names them, and `none` for a list emptied with `--exclude=`. */
function patternList(patterns: readonly string[]): string {
  return patterns.length === 0 ? 'none' : patterns.join(', ');
}

/**
 * The lines naming what a report ran under that its command may not show: the
 * options it took from a configuration, and the project's exclusions.
 *
 * Exclusions no configuration accounts for are the command line's, which is
 * where every command spec-guard ships takes them from. Without this line a
 * run under `--exclude` looked exactly like one without it.
 */
export function formatOptionLines(config: ConfigUse | undefined, exclude: readonly string[]): string[] {
  const lines = config === undefined ? [] : [formatConfigUse(config, exclude)];
  const named = config !== undefined && [...config.applied, ...config.overridden].includes('exclude');
  if (!named && exclude.length > 0) lines.push(`exclude from the command line: ${exclude.join(', ')}`);
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
  lines.push(...formatSpecWarnings(report.specWarnings, paint, glyphs));

  // A passing assertion's own warnings - references that could not be resolved,
  // files no layer constrains, a target that is not there - print whether or not
  // --verbose was passed. Nobody passes --verbose to a green run, which is when
  // they matter (ADR-0006). Its comment and scope notes are totalled below, and
  // are listed per assertion under --verbose.
  // Set off from what follows by a blank line, as every other block is.
  const passNotes = passes.flatMap((result) =>
    (options.verbose ? [...commentNotes(result), ...scopeNotes(result.scope), ...result.warnings] : result.warnings).map(
      (note) => `${paint(glyphs.warn, 'yellow')} ${paint(`${formatLocation(result)}  ${note}`, 'yellow')}`,
    ),
  );
  if (passNotes.length > 0) lines.push(...passNotes, '');

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
      baselinedMatches: sum.baselinedMatches + result.baselinedMatches,
    }),
    { commentMatches: 0, unclassifiedFiles: 0, baselinedMatches: 0 },
  );
  const summaryNotes = [...commentNotes(totals), ...scopeNotes(mergeLedgers(passes.map((result) => result.scope)))];
  if (summaryNotes.length > 0) {
    for (const note of summaryNotes) lines.push(`${paint(glyphs.warn, 'yellow')} ${paint(note, 'yellow')}`);
    lines.push('');
  }

  // Named, not totalled. A count of withheld rules tells a reader that some
  // part of their specification stopped being enforced without telling them
  // which part, and the whole reason to report this at all is that a rule
  // going quiet is indistinguishable from a rule passing.
  for (const spec of report.inactiveSpecs) {
    const detail =
      spec.directives === 0
        ? 'no directives to execute'
        : `${countLabel(spec.directives, 'assertion')} not executed`;
    lines.push(paint(`${glyphs.skip} ${spec.file} is ${spec.label} - ${detail}`, 'dim'));
  }
  if (report.inactiveSpecs.length > 0) lines.push('');
  lines.push(...formatMasked(report.maskedDirectives, paint, glyphs, options.verbose));

  const optionLines = formatOptionLines(report.config, report.exclude);
  if (optionLines.length > 0) lines.push(...optionLines, '');

  const parts = [
    paint(`${report.summary.passed} passed`, 'green'),
    failures.length > 0 ? paint(`${report.summary.failed} failed`, 'red', 'bold') : null,
    report.errors.length > 0 ? paint(`${report.errors.length} invalid`, 'yellow') : null,
    report.summary.skipped > 0 ? paint(`${report.summary.skipped} skipped`, 'dim') : null,
    report.summary.inactive > 0 ? paint(`${report.summary.inactive} not in force`, 'dim') : null,
    paint(formatDuration(report.durationMs), 'dim'),
  ].filter((part): part is string => part !== null);

  lines.push(parts.join(paint(' · ', 'dim')));

  if (report.ok) {
    // "Every assertion holds" over zero assertions is true and useless, and it
    // is the exact sentence someone reads as proof their specification is
    // being enforced. A run that verified nothing has to say so instead.
    lines.push(
      report.summary.total > 0
        ? paint(`${glyphs.pass} every spec assertion holds`, 'green')
        : paint(`${glyphs.warn} no assertion was executed, so nothing was verified`, 'yellow'),
    );
  }

  return lines.join('\n');
}

/**
 * The `baseline="..."` attribute that would exempt today's violations.
 *
 * The one machine-written edit spec-guard offers, and it is offered rather than
 * applied. `--fix` is refused for architecture rules on purpose (ADR-0009): the
 * only edits a machine can make to a failing boundary assertion are edits that
 * record the rule no longer holding, and a tool that ships a button turning red
 * into green without changing any code has shipped the wrong button - most of
 * all to an agent in a loop, for which that button is the shortest path to a
 * passing build.
 *
 * Printing is different from applying in the way that matters. The author
 * pastes it into the spec, and the diff shows every exempted file by name, to a
 * reviewer, in the commit that grants the exemption. Adopting a strict rule on
 * a codebase that already violates it is otherwise a hand-transcription job,
 * and the realistic alternative to that is not a clean codebase - it is no
 * rule at all.
 */
export function formatBaselines(report: RunResult): string {
  const lines: string[] = [];

  for (const result of report.results) {
    if (result.ok || result.fileMatches.length === 0) continue;
    const entries = result.fileMatches
      .map(({ file, count }) => (count === 1 ? file : `${file}:${count}`))
      .sort();
    lines.push(`# ${result.location.relativeFile}:${result.location.line}  ${result.description}`);
    lines.push(`baseline="${entries.join('\n          ')}"`);
    lines.push('');
  }

  if (lines.length === 0) return '# nothing to baseline: no failing assertion had a match to exempt';
  return lines.join('\n').trimEnd();
}

/**
 * The version of a run's `--json` document. A field removed or renamed moves
 * it; a field added does not. The family contract (spec-core's ADR-0005) asks
 * it of every machine-readable output. The run's document went without one
 * for eleven releases, and got it at 1, since nothing had been removed or
 * renamed in them.
 */
export const RUN_FORMAT_VERSION = 1;

/** Machine-readable output for CI consumers. */
export function formatJson(report: RunResult): string {
  return JSON.stringify(
    {
      formatVersion: RUN_FORMAT_VERSION,
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
        claim: result.claim,
        actual: result.actual,
        matches: result.matches,
        warnings: result.warnings,
        commentMatches: result.commentMatches,
        unclassifiedFiles: result.unclassifiedFiles,
        baselinedMatches: result.baselinedMatches,
        staleBaseline: result.staleBaseline,
        fileMatches: result.fileMatches,
        skipped: result.scope.skipped,
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
      specWarnings: specWarningsJson(report.specWarnings),
      maskedDirectives: maskedJson(report.maskedDirectives),
      inactiveSpecs: report.inactiveSpecs,
      // Always present, as every other list is: an audit records "no project
      // exclusions" as surely as it records which.
      exclude: report.exclude,
      // Left out, not null, when nothing came from a configuration: a key that
      // appears only when it means something is a key no reader has to test.
      config: report.config,
    },
    null,
    2,
  );
}

/* --------------------------------------------------------------------- sarif */

/**
 * A stable identity for one assertion, so a code-scanning service can tell
 * "the same alert, still open" from "a new alert". Derived from what the
 * assertion is about rather than where its matches landed, so moving the
 * offending code does not close and reopen the alert.
 */
function fingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/** SARIF severity for anything spec-guard reports. */
const SARIF_LEVEL = 'error';

/** One rule per directive kind, plus the one for a directive that will not parse. */
const SARIF_RULES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'assert-absence', text: 'A symbol that must not appear in a part of the codebase.' },
  { id: 'assert-count', text: 'A symbol that must appear an exact number of times.' },
  { id: 'assert-present', text: 'A file or directory the specification says must exist.' },
  { id: 'assert-import-absence', text: 'A dependency one part of the codebase must not have.' },
  { id: 'assert-import-count', text: 'A dependency count one part of the codebase must hold to.' },
  { id: 'assert-import-cycle', text: 'A set of files that depend on each other, directly or through others.' },
  { id: 'assert-layers', text: 'A file importing from a layer the architecture places above it.' },
  { id: 'assert-structure', text: 'A file or directory that breaks a naming or layout convention.' },
  { id: 'invalid-directive', text: 'A directive that could not be parsed, so nothing was checked.' },
];

/**
 * SARIF's slot for "something happened during this run that is not a finding".
 *
 * A document that is not in force produces no result, and a format that only
 * carries results would show a clean code-scanning page for a repository whose
 * rules had gone dormant - the same silence the human report refuses. This is
 * the standard's own answer to that: a note-level execution notification,
 * which GitHub surfaces as run information rather than as an alert.
 */
function inactiveNotifications(report: RunResult): Array<{ level: string; message: { text: string } }> {
  return [
    ...report.inactiveSpecs.map((spec) => ({
      level: 'note',
      message: {
        text:
          `${spec.file} is ${spec.label}, so ` +
          `${spec.directives === 1 ? 'its 1 assertion was' : `its ${spec.directives} assertions were`} not executed.`,
      },
    })),
    // A document read differently from how it was written runs different
    // rules, and the page a reviewer reads would otherwise not say so.
    ...(report.specWarnings ?? []).map((warning) => ({
      level: 'warning',
      message: { text: `${warning.location.relativeFile}:${warning.location.line} ${warning.message}` },
    })),
  ];
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: { startLine: number; startColumn: number };
  };
  message?: { text: string };
}

function sarifLocation(uri: string, line: number, column: number, text?: string): SarifLocation {
  const location: SarifLocation = {
    physicalLocation: { artifactLocation: { uri }, region: { startLine: line, startColumn: column } },
  };
  if (text) location.message = { text };
  return location;
}

/**
 * The static analysis interchange format, which is how a failure becomes a
 * line-level annotation on a pull request.
 *
 * Chosen over an editor language server for the fast-feedback problem, and the
 * reason is what spec-guard checks rather than how fast it is. Its claims are
 * about a whole repository - "this symbol appears nowhere in src" - and a
 * language server is handed one buffer at a time. Answering a repository-wide
 * question on every keystroke means rescanning the tree on every keystroke; the
 * alternative is answering a different, smaller question and calling it the
 * same one. SARIF needs no daemon, no editor extension per editor and no
 * protocol version matrix, and it puts the failure on the offending line for
 * every reviewer rather than only for the author who has the plugin installed.
 *
 * One result per failing assertion, not per match: the thing that broke is the
 * rule. The primary location is the first offending line so the annotation
 * lands on the code; the directive that was violated is always a related
 * location, because that is where the fix usually goes.
 */
export function formatSarif(report: RunResult, options: { version?: string } = {}): string {
  const results = [];

  for (const result of report.results) {
    if (result.ok) continue;
    const spec = sarifLocation(
      result.location.relativeFile,
      result.location.line,
      result.location.column,
      'the assertion that failed',
    );
    // A directory missing an entry has no file to annotate, so it is named in
    // the message and the result sits at the directive. A misnamed or
    // partnerless file has no line, and is annotated at its top.
    const directories = result.claim === 'required' ? result.matches : [];
    const matches = (directories.length > 0 ? [] : result.matches).map((match) =>
      sarifLocation(match.file, Math.max(match.line, 1), Math.max(match.column, 1), match.text.trim()),
    );

    results.push({
      ruleId: result.kind,
      level: SARIF_LEVEL,
      message: {
        text: [`${result.description}: ${result.message}`, ...directories.map((match) => `${match.file}  ${match.text}`)].join('\n'),
      },
      // A failure with no match - a missing target, an empty scope, a stale
      // baseline - is anchored on the directive, which is where its fix goes.
      locations: [matches[0] ?? spec],
      relatedLocations: matches[0] ? [...matches.slice(1), spec] : [],
      partialFingerprints: {
        specGuardAssertion: fingerprint([
          result.location.relativeFile,
          result.kind,
          // The description only where there is nothing else to tell two
          // assertions apart. A cycle or layer rule names no symbol and no
          // file, so two on one target - `types="ignore"` beside the default -
          // would share an identity and be merged into one alert. Every kind
          // that has a symbol or a file list keeps the fingerprint it had.
          result.symbol ?? (result.files.length > 0 ? result.files.join(',') : result.description),
          result.targets.join(','),
        ]),
      },
    });
  }

  for (const error of report.errors) {
    results.push({
      ruleId: 'invalid-directive',
      level: SARIF_LEVEL,
      message: { text: error.message },
      locations: [
        sarifLocation(error.location.relativeFile, error.location.line, error.location.column),
      ],
      relatedLocations: [],
      partialFingerprints: {
        specGuardAssertion: fingerprint([error.location.relativeFile, 'invalid', error.message]),
      },
    });
  }

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          // Present only when there is something to say. An empty invocations
          // block is noise in every consumer that renders one.
          ...(report.inactiveSpecs.length + (report.specWarnings?.length ?? 0) > 0
            ? {
                invocations: [
                  { executionSuccessful: report.ok, toolExecutionNotifications: inactiveNotifications(report) },
                ],
              }
            : {}),
          tool: {
            driver: {
              name: 'spec-guard',
              informationUri: 'https://github.com/DescentVTT/spec-guard',
              version: options.version ?? '0.0.0',
              rules: SARIF_RULES.map((rule) => ({
                id: rule.id,
                name: rule.id,
                shortDescription: { text: rule.text },
              })),
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

/* -------------------------------------------------------------------- prove */

/** What each outcome is called where a person reads it. */
const PROVE_WORDS: Readonly<Record<ProveOutcome, string>> = {
  killed: 'seen to fail',
  survived: 'passed with a violation in place',
  unprovable: 'no violation could be made',
};

/** The claim a probe crossed, as a report names it. */
const CLAIM_WORDS: Readonly<Record<ProveClaim, string>> = { max: 'maximum', min: 'minimum', present: 'presence' };

function formatProveResult(
  result: ProveResult,
  paint: ReturnType<typeof createPainter>,
  glyphs: ReturnType<typeof symbols>,
): string[] {
  const glyph =
    result.outcome === 'killed'
      ? paint(glyphs.pass, 'green')
      : result.outcome === 'survived'
        ? paint(glyphs.fail, 'red', 'bold')
        : paint(glyphs.skip, 'yellow');
  const lines = [
    `${glyph} ${paint(formatLocation(result), 'bold')}  ${paint(`@${result.kind}`, 'magenta')}  ${PROVE_WORDS[result.outcome]}`,
    `    ${result.description}`,
  ];
  for (const probe of result.probes) {
    const verdict = probe.outcome === 'killed' ? paint('and it failed', 'green') : paint('and it still passed', 'red', 'bold');
    lines.push(`    ${CLAIM_WORDS[probe.claim]}: ${probe.violation}, ${verdict}: ${paint(probe.message, 'dim')}`);
  }
  if (result.unprovable !== undefined) lines.push(`    ${paint(result.unprovable, 'yellow')}`);
  if (result.reason !== undefined) lines.push(`    ${paint(`reason: ${result.reason}`, 'dim')}`);
  return lines;
}

/**
 * Renders what `spec-guard prove` found, for a person.
 *
 * A rule that survived is the finding, and is printed whatever the options;
 * so is one no violation could be made for, since a rule nobody can show
 * failing is not yet one anybody should trust. A rule seen to fail is printed
 * under `--verbose`, with the violation that failed it. Survivors come first.
 */
export function formatProve(report: ProveReport, options: ReporterOptions): string {
  const paint = createPainter(options.color);
  const glyphs = symbols(options.ascii ?? false);
  const { summary } = report;
  const lines = [
    `${paint('spec-guard prove', 'bold', 'blue')} ${paint(`${countLabel(summary.specs, 'spec')} · ${countLabel(summary.total, 'rule')}`, 'dim')}`,
    '',
  ];

  for (const outcome of ['survived', 'unprovable', 'killed'] as const) {
    if (outcome === 'killed' && !options.verbose) continue;
    for (const result of report.results.filter((entry) => entry.outcome === outcome)) {
      lines.push(...formatProveResult(result, paint, glyphs), '');
    }
  }

  for (const error of report.errors) lines.push(...formatError(error, paint, glyphs), '');
  lines.push(...formatSpecWarnings(report.specWarnings, paint, glyphs));

  for (const spec of report.inactiveSpecs) {
    lines.push(paint(`${glyphs.skip} ${spec.file} is ${spec.label} - ${countLabel(spec.directives, 'rule')} not proved`, 'dim'));
  }
  if (report.inactiveSpecs.length > 0) lines.push('');
  lines.push(...formatMasked(report.maskedDirectives, paint, glyphs, options.verbose));

  const optionLines = formatOptionLines(report.config, report.exclude);
  if (optionLines.length > 0) lines.push(...optionLines, '');

  const parts = [
    paint(`${summary.killed} seen to fail`, 'green'),
    summary.survived > 0 ? paint(`${summary.survived} survived`, 'red', 'bold') : null,
    summary.unprovable > 0 ? paint(`${summary.unprovable} unprovable`, 'yellow') : null,
    report.errors.length > 0 ? paint(`${report.errors.length} invalid`, 'yellow') : null,
    summary.inactive > 0 ? paint(`${summary.inactive} not in force`, 'dim') : null,
    paint(formatDuration(report.durationMs), 'dim'),
  ].filter((part): part is string => part !== null);
  lines.push(parts.join(paint(' · ', 'dim')));

  if (summary.survived > 0) {
    const them = summary.survived === 1 ? 'itself' : 'themselves';
    lines.push(paint(`${glyphs.fail} ${countLabel(summary.survived, 'rule')} passed with a violation of ${them} in place`, 'red', 'bold'));
  } else if (summary.total === 0) {
    lines.push(paint(`${glyphs.warn} no rule was proved, so nothing was shown`, 'yellow'));
  } else if (summary.killed === summary.total) {
    lines.push(paint(`${glyphs.pass} every rule in force was seen to fail`, 'green'));
  }
  return lines.join('\n');
}

/**
 * The version of `spec-guard prove --json`'s document. A field removed or
 * renamed moves it; a field added does not.
 */
export const PROVE_FORMAT_VERSION = 1;

/** What `spec-guard prove` found, for a script. */
export function formatProveJson(report: ProveReport): string {
  return JSON.stringify(
    {
      formatVersion: PROVE_FORMAT_VERSION,
      ok: report.ok,
      root: report.root,
      durationMs: Math.round(report.durationMs * 1000) / 1000,
      summary: report.summary,
      specFiles: report.specFiles,
      results: report.results.map((result) => ({
        outcome: result.outcome,
        kind: result.kind,
        spec: { file: result.location.relativeFile, line: result.location.line, column: result.location.column },
        description: result.description,
        reason: result.reason,
        unprovable: result.unprovable,
        probes: result.probes,
        durationMs: Math.round(result.durationMs * 1000) / 1000,
      })),
      errors: report.errors.map((error) => ({
        spec: { file: error.location.relativeFile, line: error.location.line, column: error.location.column },
        message: error.message,
        raw: error.raw,
      })),
      specWarnings: specWarningsJson(report.specWarnings),
      maskedDirectives: maskedJson(report.maskedDirectives),
      inactiveSpecs: report.inactiveSpecs,
      exclude: report.exclude,
      config: report.config,
    },
    null,
    2,
  );
}

/** One rule per finding `spec-guard prove` makes. */
const PROVE_RULES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'rule-cannot-fail', text: 'A rule that passed with a violation of itself in place.' },
  { id: 'rule-unprovable', text: 'A rule no violation could be made for.' },
  { id: 'invalid-directive', text: 'A directive that could not be parsed, so nothing was checked.' },
];

/**
 * What `spec-guard prove` found, for code scanning.
 *
 * A rule that survived is an error on its directive, which is where the fix
 * goes: a target that reaches the code, a glob that names its kind, a bound
 * that can be crossed. A rule no violation could be made for is a note there,
 * which GitHub shows without failing anything. A rule seen to fail is not a
 * finding and is not a result.
 */
export function formatProveSarif(report: ProveReport, options: { version?: string } = {}): string {
  const results = report.results
    .filter((result) => result.outcome !== 'killed')
    .map((result) => {
      const survived = result.outcome === 'survived';
      const detail = survived
        ? result.probes
            .filter((probe) => probe.outcome === 'survived')
            .map((probe) => `${probe.violation}, and it still passed: ${probe.message}`)
            .join('; ')
        : (result.unprovable as string);
      return {
        ruleId: survived ? 'rule-cannot-fail' : 'rule-unprovable',
        level: survived ? SARIF_LEVEL : 'note',
        message: { text: `${result.description}: ${detail}` },
        locations: [sarifLocation(result.location.relativeFile, result.location.line, result.location.column)],
        partialFingerprints: {
          specGuardAssertion: fingerprint([result.location.relativeFile, result.kind, result.description]),
        },
      };
    });
  for (const error of report.errors) {
    results.push({
      ruleId: 'invalid-directive',
      level: SARIF_LEVEL,
      message: { text: error.message },
      locations: [sarifLocation(error.location.relativeFile, error.location.line, error.location.column)],
      partialFingerprints: { specGuardAssertion: fingerprint([error.location.relativeFile, 'invalid', error.message]) },
    });
  }
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'spec-guard prove',
              informationUri: 'https://github.com/DescentVTT/spec-guard',
              version: options.version ?? '0.0.0',
              rules: PROVE_RULES.map((rule) => ({ id: rule.id, name: rule.id, shortDescription: { text: rule.text } })),
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

/* -------------------------------------------------------- gitlab and github */

/** GitLab Code Quality's words for how much a finding matters, in the four this tool uses. */
export type GitlabSeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * One finding, placed, before any format is chosen for it.
 *
 * Every format that puts findings on lines - GitLab's Code Quality report and
 * GitHub's workflow commands here, SARIF above - says the same few things: which
 * rule, how bad, where, and what. Written once per report and rendered by each
 * format, so the two cannot come to disagree about which findings a run had.
 */
export interface Annotation {
  /** The rule's id: GitLab's `check_name`, GitHub's `title`. */
  rule: string;
  /** How GitHub shows it: `error`, `warning` or `notice`. */
  level: 'error' | 'warning' | 'notice';
  severity: GitlabSeverity;
  /** Root-relative path, forward slashes. */
  file: string;
  /** 1-based; a finding about a whole file is placed on its first line. */
  line: number;
  message: string;
}

/**
 * A finding as GitLab Code Quality reads it.
 *
 * The fingerprint is the SHA-256 of the rule, the file and the message, which is
 * what GitLab compares between a merge request and its target to tell a finding
 * that is new from one that was already there. The same three things are one
 * finding, so a second copy of them is not written.
 */
export function formatGitlab(annotations: readonly Annotation[]): string {
  const seen = new Set<string>();
  const issues = [];
  for (const annotation of annotations) {
    const fingerprint = createHash('sha256').update([annotation.rule, annotation.file, annotation.message].join('\u0000')).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    issues.push({
      description: annotation.message,
      check_name: annotation.rule,
      fingerprint,
      severity: annotation.severity,
      location: { path: annotation.file, lines: { begin: Math.max(annotation.line, 1) } },
    });
  }
  return JSON.stringify(issues, null, 2);
}

/** A workflow command's message: `%`, and the line breaks that would end the command. */
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** A workflow command's property: as a message, and the `:` and `,` that would end the property. */
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Findings as GitHub Actions workflow commands, one line each, which a job's log
 * turns into annotations on the pull request's diff without an upload step.
 * Nothing at all when there is nothing to annotate.
 */
export function formatGithub(annotations: readonly Annotation[]): string {
  return annotations
    .map(
      (annotation) =>
        `::${annotation.level} file=${escapeProperty(annotation.file)},line=${Math.max(annotation.line, 1)},title=${escapeProperty(annotation.rule)}::${escapeData(annotation.message)}`,
    )
    .join('\n');
}

/** Where a document that is not in force is named, in a format with no room for a note beside the findings. */
function inactiveAnnotations(inactive: readonly InactiveSpec[], what: 'assertion' | 'rule', done: 'executed' | 'proved'): Annotation[] {
  return inactive.map((spec) => ({
    rule: 'not-in-force',
    level: 'notice',
    severity: 'info',
    file: spec.file,
    line: 1,
    message: `${spec.file} is ${spec.label}, so ${spec.directives === 1 ? `its 1 ${what} was` : `its ${spec.directives} ${what}s were`} not ${done}.`,
  }));
}

/** What changed how a document was read, on the line it happened: a warning, which fails nothing. */
function warningAnnotations(warnings: readonly SpecWarning[] | undefined): Annotation[] {
  return (warnings ?? []).map((warning) => ({
    rule: 'spec-warning',
    level: 'warning',
    severity: 'minor',
    file: warning.location.relativeFile,
    line: warning.location.line,
    message: warning.message,
  }));
}

/** A directive that could not be read: nothing it states was checked. */
function errorAnnotations(errors: readonly DirectiveError[]): Annotation[] {
  return errors.map((error) => ({
    rule: 'invalid-directive',
    level: 'error',
    severity: 'major',
    file: error.location.relativeFile,
    line: error.location.line,
    message: error.message,
  }));
}

/**
 * A run's findings, placed as SARIF places them.
 *
 * Each failing assertion is one finding, on its first offending line, since the
 * thing that broke is the rule; one with no match - a missing target, an empty
 * scope, a directory missing an entry - sits on its directive. `critical`,
 * because it fails the run. A directive that could not be read fails the run
 * too, and is `major`: it is the rule, not the code, that needs the fix. A
 * document not in force is `info`, named rather than left out, for ADR-0010's
 * reason.
 */
export function runAnnotations(report: RunResult): Annotation[] {
  const failed = report.results
    .filter((result) => !result.ok)
    .map((result): Annotation => {
      const match = result.claim === 'required' ? undefined : result.matches[0];
      return {
        rule: result.kind,
        level: 'error',
        severity: 'critical',
        file: match?.file ?? result.location.relativeFile,
        line: match?.line ?? result.location.line,
        message: `${result.description}: ${result.message} (${result.location.relativeFile}:${result.location.line})`,
      };
    });
  return [
    ...failed,
    ...errorAnnotations(report.errors),
    ...warningAnnotations(report.specWarnings),
    ...inactiveAnnotations(report.inactiveSpecs, 'assertion', 'executed'),
  ];
}

/**
 * What `spec-guard prove` found, placed on each rule's directive.
 *
 * A rule that survived is `critical`: it passed with a violation of itself in
 * place, and fails the proof. One no violation could be made for is `minor`, a
 * notice, as it is a note in SARIF. A rule seen to fail is not a finding.
 */
export function proveAnnotations(report: ProveReport): Annotation[] {
  const results = report.results
    .filter((result) => result.outcome !== 'killed')
    .map((result): Annotation => {
      const survived = result.outcome === 'survived';
      const detail = survived
        ? result.probes
            .filter((probe) => probe.outcome === 'survived')
            .map((probe) => `${probe.violation}, and it still passed: ${probe.message}`)
            .join('; ')
        : (result.unprovable as string);
      return {
        rule: survived ? 'rule-cannot-fail' : 'rule-unprovable',
        level: survived ? 'error' : 'notice',
        severity: survived ? 'critical' : 'minor',
        file: result.location.relativeFile,
        line: result.location.line,
        message: `${result.description}: ${detail}`,
      };
    });
  return [
    ...results,
    ...errorAnnotations(report.errors),
    ...warningAnnotations(report.specWarnings),
    ...inactiveAnnotations(report.inactiveSpecs, 'rule', 'proved'),
  ];
}

/* -------------------------------------------------------------------- cites */

/** How a family is introduced: its id, its documents, and where it came from. */
function familyLine(family: CitesReport['families'][number]): string {
  const from = family.source === 'derived' ? ", read off the specs' titles" : '';
  return `${family.id} (${countLabel(family.documents, 'document')} matching ${family.files}${from})`;
}

/**
 * Renders what `spec-guard cites` found, for a person.
 *
 * Each ghost and each stale citation is printed with the hint that says what
 * to do. So are the files whose comments could not all be read, and the files
 * no comment syntax is known for, counted by extension: a citation in either
 * was not looked at, and a report that stayed quiet about them would read as
 * though it had been.
 */
export function formatCites(report: CitesReport, options: ReporterOptions): string {
  const paint = createPainter(options.color);
  const glyphs = symbols(options.ascii ?? false);
  const { summary } = report;
  const families = report.families.length === 0 ? 'no families' : report.families.map(familyLine).join('; ');
  const lines = [`${paint('spec-guard cites', 'bold', 'blue')} ${paint(families, 'dim')}`, ''];

  for (const finding of report.findings) {
    const glyph = finding.severity === 'error' ? paint(glyphs.fail, 'red', 'bold') : paint(glyphs.warn, 'yellow', 'bold');
    lines.push(`${glyph} ${finding.message}  ${paint(finding.rule, 'dim')}`, `    ${paint(`hint: ${finding.hint}`, 'dim')}`);
  }
  if (report.findings.length > 0) lines.push('');

  if (report.gaps.length > 0) {
    const them = report.gaps.length === 1 ? 'it' : 'them';
    lines.push(paint(`${glyphs.skip} ${countLabel(report.gaps.length, 'file')} could not be read in full, so a citation in ${them} may have been missed:`, 'yellow'));
    for (const gap of report.gaps) lines.push(`    ${gap.file} ${gap.detail}`);
    lines.push('');
  }
  if (summary.unclassified > 0) {
    const kinds = report.unclassified.map(({ extension, files }) => `${extension} ${files}`).join(', ');
    lines.push(paint(`${glyphs.skip} ${countLabel(summary.unclassified, 'file')} in no language spec-guard knows the comments of, and not read: ${kinds}`, 'dim'), '');
  }
  if (summary.qualified > 0) {
    const verb = summary.qualified === 1 ? 'names' : 'name';
    const were = summary.qualified === 1 ? 'was' : 'were';
    lines.push(paint(`${glyphs.skip} ${countLabel(summary.qualified, 'id')} ${verb} another project's document, as spec-core's ADR-0005 does, and ${were} not checked`, 'dim'), '');
  }
  for (const note of report.notes) lines.push(paint(`${glyphs.skip} ${note}`, 'dim'));
  if (report.notes.length > 0) lines.push('');

  const optionLines = formatOptionLines(report.config, report.exclude);
  if (optionLines.length > 0) lines.push(...optionLines, '');

  const parts = [
    `${countLabel(summary.citations, 'citation')} in ${countLabel(summary.files, 'file')}`,
    summary.ghosts > 0 ? paint(countLabel(summary.ghosts, 'ghost'), 'red', 'bold') : null,
    summary.stale > 0 ? paint(`${summary.stale} stale`, 'yellow') : null,
    paint(formatDuration(report.durationMs), 'dim'),
  ].filter((part): part is string => part !== null);
  lines.push(parts.join(paint(' · ', 'dim')));

  const names = (count: number): string => `${countLabel(count, 'citation')} ${count === 1 ? 'names' : 'name'}`;
  if (summary.ghosts > 0) {
    lines.push(paint(`${glyphs.fail} ${names(summary.ghosts)} a document that does not exist`, 'red', 'bold'));
  } else if (report.families.length === 0) {
    lines.push(paint(`${glyphs.warn} no citation was looked for, so nothing was checked`, 'yellow'));
  } else if (summary.files === 0) {
    lines.push(paint(`${glyphs.warn} no source file was read, so nothing was checked`, 'yellow'));
  } else if (summary.stale > 0) {
    lines.push(paint(`${report.ok ? glyphs.warn : glyphs.fail} ${names(summary.stale)} a document no longer in force`, 'yellow', 'bold'));
  } else {
    lines.push(paint(`${glyphs.pass} every citation names a document in force`, 'green'));
  }
  return lines.join('\n');
}

/**
 * The version of `spec-guard cites --json`'s document. A field removed or
 * renamed moves it; a field added does not.
 */
export const CITES_FORMAT_VERSION = 1;

/** What `spec-guard cites` found, for a script. */
export function formatCitesJson(report: CitesReport): string {
  return JSON.stringify(
    {
      formatVersion: CITES_FORMAT_VERSION,
      ok: report.ok,
      root: report.root,
      durationMs: Math.round(report.durationMs * 1000) / 1000,
      families: report.families,
      summary: report.summary,
      findings: report.findings,
      gaps: report.gaps,
      unclassified: report.unclassified,
      notes: report.notes,
      exclude: report.exclude,
      config: report.config,
    },
    null,
    2,
  );
}

const CITE_SARIF_RULES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'ghost-citation', text: 'A comment cites a document that does not exist.' },
  { id: 'stale-citation', text: 'A comment cites a document that is no longer in force.' },
];

/**
 * What `spec-guard cites` found, for code scanning: each finding on the line
 * of the comment, with its hint beneath. The fingerprint is the file, the rule
 * and the id as written, which survives the comment moving. A file whose
 * comments could not all be read, and every note, is a notification.
 */
export function formatCitesSarif(report: CitesReport, options: { version?: string } = {}): string {
  const notifications = [
    ...report.gaps.map((gap) => ({ level: 'warning', message: { text: `${gap.file} ${gap.detail}` } })),
    ...report.notes.map((note) => ({ level: 'note', message: { text: note } })),
  ];
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          ...(notifications.length > 0 ? { invocations: [{ executionSuccessful: report.ok, toolExecutionNotifications: notifications }] } : {}),
          tool: {
            driver: {
              name: 'spec-guard cites',
              informationUri: 'https://github.com/DescentVTT/spec-guard',
              version: options.version ?? '0.0.0',
              rules: CITE_SARIF_RULES.map((rule) => ({ id: rule.id, name: rule.id, shortDescription: { text: rule.text } })),
            },
          },
          results: report.findings.map((finding) => ({
            ruleId: finding.rule,
            level: finding.severity,
            message: { text: `${finding.message}\n${finding.hint}` },
            locations: [sarifLocation(finding.file, finding.line, finding.column)],
            partialFingerprints: { specGuardCitation: fingerprint([finding.file, finding.rule, finding.cited]) },
          })),
        },
      ],
    },
    null,
    2,
  );
}

/**
 * What `spec-guard cites` found, placed for GitLab and GitHub.
 *
 * A ghost is `critical`, an error. A stale citation is a warning and `minor`,
 * and under `--strict`, where it fails the check, an error and `critical`. A
 * file whose comments could not all be read is a notice on its first line.
 */
export function citesAnnotations(report: CitesReport): Annotation[] {
  return [
    ...report.findings.map(
      (finding): Annotation => ({
        rule: finding.rule,
        level: finding.severity === 'error' ? 'error' : 'warning',
        severity: finding.severity === 'error' ? 'critical' : 'minor',
        file: finding.file,
        line: finding.line,
        message: `${finding.message}. ${finding.hint}`,
      }),
    ),
    ...report.gaps.map(
      (gap): Annotation => ({
        rule: 'unread-comments',
        level: 'notice',
        severity: 'info',
        file: gap.file,
        line: 1,
        message: `${gap.file} ${gap.detail}, so a citation in it may have been missed`,
      }),
    ),
  ];
}
