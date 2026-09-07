/**
 * Programmatic API.
 *
 * The CLI is a thin shell over `runSpecGuard`; anything the CLI can do, a build
 * script or a custom reporter can do too.
 *
 * ```ts
 * import { runSpecGuard, formatReport } from '@descent-vtt/spec-guard';
 *
 * const report = await runSpecGuard({ patterns: ['docs/**\/*.md'], root: process.cwd() });
 * if (!report.ok) console.error(formatReport(report, { color: true, verbose: false }));
 * ```
 */

export { main, parseArgs, HELP, UsageError, EXIT_OK, EXIT_FAILED, EXIT_ERROR } from './cli.js';
export type { CliIO, CliOptions } from './cli.js';

export {
  buildJsRegExp,
  buildRipgrepArgs,
  canBatchLiterals,
  createCachedEngine,
  createRipgrepSink,
  enumerateCandidates,
  escapeRegExp,
  findRipgrep,
  isMissingBinary,
  javascriptEngine,
  resetRipgrepProbe,
  resolveEngine,
  runSearches,
  scanContent,
  sortLocations,
  shouldBatchPatterns,
  MAX_FILE_SIZE,
  SMALL_TREE_BUDGET,
} from './engine.js';
export type {
  BatchEngine,
  CachedEngine,
  Engine,
  EnginePreference,
  Enumeration,
  EnumerationBudget,
  RipgrepSink,
  SearchRequest,
} from './engine.js';

export {
  compareDirents,
  createGlobMatcher,
  defaultDirectoryReader,
  expandSpecPatterns,
  globBase,
  globToRegExp,
  isGlob,
  toPosix,
  walkFiles,
  DEFAULT_IGNORED_DIRECTORIES,
} from './glob.js';
export type { DirectoryReader, WalkedFile, WalkOptions } from './glob.js';

export { maskCode, parseAttributes, parseDirectives } from './parser.js';
export type { ParseContext } from './parser.js';

export {
  executeAssertion,
  resolveDirective,
  runSpecGuard,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_SNIPPETS,
} from './runner.js';
export type { ResolveContext, RunOptions, RunResult } from './runner.js';

export { createPainter, formatJson, formatReport, shouldUseAscii, shouldUseColor } from './reporter.js';
export type { ReporterOptions } from './reporter.js';

export type {
  Assertion,
  AssertionResult,
  Bounds,
  Directive,
  DirectiveError,
  DirectiveKind,
  EngineName,
  MatchLocation,
  ParseResult,
  RunReport,
  RunSummary,
  SearchOptions,
  SearchResult,
  SourceLocation,
} from './types.js';
