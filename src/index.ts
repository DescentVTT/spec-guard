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
export type { CliIO, CliOptions, Command, OutputFormat } from './cli.js';

export {
  buildJsRegExp,
  buildRipgrepArgs,
  createCachedEngine,
  createJavaScriptEngine,
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
  expandSpecPatterns,
  globBase,
  globToRegExp,
  isGlob,
  toPosix,
  walkFiles,
  walkPaths,
} from './glob.js';
export type { WalkedFile, WalkedPath, WalkOptions } from './glob.js';

export { nodeIo, readText } from './io.js';
export type { DirectoryReader, Io } from './io.js';

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
  logicalLines,
  matchingClose,
  normalizeModule,
  Reader,
  MAX_EXPANSION,
  POLYGLOT_EXTENSIONS,
} from './polyglot.js';
export type { ModuleLanguage } from './polyglot.js';

export {
  buildGraph,
  candidates,
  cyclicComponents,
  edgeKey,
  isGraphFile,
  resolveReference,
  stronglyConnected,
  witness,
} from './graph.js';
export type { GraphInput, GraphScope, ImportGraph, Resolution, Unresolved } from './graph.js';

export { checkLayers, layerMatcher } from './layers.js';
export type { LayerInput, LayerReport, LayerViolation } from './layers.js';

export { checkStructure, createTreeIndex, expandPartner, partnerTemplateIssue, requiredEntryIssue } from './structure.js';
export type { Listing, StructureCheck, StructureRequest, StructureViolation, Tree, TreeIndex } from './structure.js';

export { lineStarts, locate, maskRanges } from './text.js';

export { maskCode, parseAttributes, parseDirectives, parseDocument, parseStatus, parseTitle, INACTIVE_STATUSES } from './parser.js';
export type { ParseContext, ParsedDocument } from './parser.js';

export { readSpecs, specPath } from './specs.js';
export type { SpecDocument, SpecSet } from './specs.js';

export { governs, layerPosition, viewRule, within } from './rules.js';
export type { DocumentView, LayerPosition, PathShape, QueryPath, RuleView } from './rules.js';

export {
  answerQuery,
  formatQuery,
  formatQueryJson,
  inQueriedPaths,
  loadRuleSet,
  queryRules,
  resolveQueryPath,
  viewDocument,
  QueryPathError,
} from './query.js';
export type { PathRules, QueryOptions, QueryReport, RuleSet, RuleSetOptions } from './query.js';

export {
  classifyRequest,
  createMcpHandler,
  documentPath,
  documentUri,
  envelopeIssue,
  negotiateLegacyVersion,
  serveStdio,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  RESOURCE_TEMPLATES,
  TOOLS,
} from './mcp.js';
export type { Era, McpServerOptions, OutgoingMessage } from './mcp.js';

export {
  applyBaseline,
  createScopeProbe,
  executeAssertion,
  planRun,
  reportRun,
  resolveDirective,
  runSpecGuard,
  specExclusions,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_SNIPPETS,
} from './runner.js';
export type { ExecuteOptions, ResolveContext, RunOptions, RunPlan, RunResult } from './runner.js';

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
  InactiveSpec,
  MatchLocation,
  ParseResult,
  RatchetMode,
  RunReport,
  RunSummary,
  SearchOptions,
  SearchResult,
  SourceLocation,
  SpecStatus,
  StaleBaselineEntry,
  StructureClaim,
  StructureQuery,
} from './types.js';
