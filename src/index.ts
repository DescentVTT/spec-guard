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

export { main, parseArgs, version, HELP, UsageError, EXIT_OK, EXIT_FAILED, EXIT_ERROR } from './cli.js';
export type { CliIO, CliOptions, OutputFormat } from './cli.js';

export {
  buildJsRegExp,
  buildRipgrepArgs,
  createCachedEngine,
  enumerateCandidates,
  escapeRegExp,
  ANY_FILE_PROBE,
  findRipgrep,
  parseRipgrepErrors,
  isMissingBinary,
  javascriptEngine,
  resetRipgrepProbe,
  resolveEngine,
  runSearches,
  scanContent,
  sortLocations,
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
  SearchRequest,
} from './engine.js';

export {
  compareDirents,
  createExcludeMatcher,
  createGlobMatcher,
  defaultDirectoryReader,
  expandSpecPatterns,
  globBase,
  globToRegExp,
  isGlob,
  toPosix,
  walkFiles,
} from './glob.js';
export type { DirectoryReader, WalkedFile, WalkOptions } from './glob.js';

export {
  createScope,
  isBinary,
  mergeLedgers,
  tallyLedger,
  LedgerBuilder,
  DEFAULT_SCOPE,
  DEFAULT_SKIPPED_DIRECTORIES,
  MAX_LEDGER_ENTRIES,
  SCAN_EVERYTHING,
  UNCERTAIN_REASONS,
} from './scope.js';
export type { ScopeLedger, ScopePolicy, SkippedPath, SkipReason } from './scope.js';

export {
  analyzeJavaScript,
  analyzeSource,
  createImportIndex,
  extractReferences,
  resolveModule,
  resolveSpecifier,
  tokenize,
  ANALYSABLE_EXTENSIONS,
  JS_EXTENSIONS,
} from './imports.js';
export type { AnalysisNote, FileImports, ImportIndex, ModuleReference, NoteKind, ReferenceKind } from './imports.js';

export {
  analyzePolyglot,
  expandUsePath,
  languageFor,
  literalValue,
  normalizeModule,
  MAX_EXPANSION,
  POLYGLOT_EXTENSIONS,
} from './polyglot.js';
export type { ModuleLanguage } from './polyglot.js';

export { lineStarts, locate, maskRanges } from './text.js';

export { maskCode, parseAttributes, parseDirectives } from './parser.js';
export type { ParseContext } from './parser.js';

export {
  applyBaseline,
  createScopeProbe,
  executeAssertion,
  resolveDirective,
  runSpecGuard,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_SNIPPETS,
} from './runner.js';
export type { ResolveContext, RunOptions, RunResult } from './runner.js';

export { createPainter, formatBaselines, formatJson, formatReport, formatSarif, shouldUseAscii, shouldUseColor } from './reporter.js';
export type { ReporterOptions } from './reporter.js';

export type {
  Assertion,
  AssertionResult,
  BaselineEntry,
  Bounds,
  Directive,
  DirectiveError,
  DirectiveKind,
  EngineName,
  ImportQuery,
  MatchLocation,
  ParseResult,
  RatchetMode,
  RunReport,
  RunSummary,
  SearchOptions,
  SearchResult,
  SourceLocation,
  StaleBaselineEntry,
} from './types.js';
