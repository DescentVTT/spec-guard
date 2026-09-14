/**
 * `spec-guard query`: the rules in force for a path, without running any.
 *
 * The question an agent - or a person - asks before touching a file is not
 * "does the codebase pass" but "what am I allowed to do here". Answering it
 * from CI means writing the code first and finding out afterwards, which for a
 * model is a loop of generate, fail, read the log, regenerate. This answers it
 * up front, from the specs alone, in the time it takes to read them. ADR-0012.
 */

import path from 'node:path';

import { comparePaths } from './engine.js';
import { createExcludeMatcher, toPosix } from './glob.js';
import { nodeIo, type Io } from './io.js';
import { formatOptionLines } from './reporter.js';
import { checkProjectExcludes, elapsed, resolveDirective, specExclusions } from './runner.js';
import { createScope } from './scope.js';
import { governs, leftOutByOwnExclude, viewRule, within, type DocumentView, type QueryPath, type RuleView } from './rules.js';
import { readSpecs, specPath, type SpecDocument } from './specs.js';
import type { Assertion, ConfigUse, DirectiveError } from './types.js';

export interface RuleSetOptions {
  /** Globs or paths of the Markdown specs. */
  patterns: readonly string[];
  /** Absolute root the specs' paths are resolved against. */
  root: string;
  /** Count matches inside the spec files themselves, as `--include-specs` does. */
  includeSpecs?: boolean;
  /** Skip `.git`, `.hg`, `.svn` and `node_modules`, as a run does by default. */
  defaultSkips?: boolean;
  /** The project's exclusions, which govern what each rule covers as they do in a run. */
  exclude?: readonly string[];
}

/** Every rule the specs state, resolved, with the document that states it. */
export interface RuleSet {
  root: string;
  /** Root-relative paths of every spec file the patterns matched. */
  specFiles: string[];
  documents: SpecDocument[];
  rules: Array<{ assertion: Assertion; document: DocumentView }>;
  /** Unreadable specs, malformed directives and directives that do not resolve. */
  errors: DirectiveError[];
  /** The project's exclusions every rule was resolved with. */
  exclude: string[];
}

export function viewDocument(document: SpecDocument): DocumentView {
  return {
    file: document.relativeFile,
    title: document.title ?? null,
    status: document.status?.value ?? null,
    label: document.status?.label ?? null,
    inForce: document.inForce,
  };
}

/**
 * Reads and resolves every rule, in force or not.
 *
 * Resolution is the runner's own, so a query and a run cannot disagree about
 * what a directive means - including about which directives are errors.
 */
export async function loadRuleSet(options: RuleSetOptions): Promise<RuleSet> {
  const exclude = checkProjectExcludes(options.exclude);
  const specs = await readSpecs(options.patterns, options.root);
  const context = {
    root: options.root,
    excludeFiles: specExclusions(specs.files, options.includeSpecs ?? false),
    scope: createScope(options.defaultSkips ?? true),
    exclude,
  };
  const rules: RuleSet['rules'] = [];
  const errors = [...specs.errors];

  for (const document of specs.documents) {
    const view = viewDocument(document);
    for (const directive of document.directives) {
      const resolved = resolveDirective(directive, context);
      if ('error' in resolved) errors.push(resolved.error);
      else rules.push({ assertion: resolved.assertion, document: view });
    }
  }

  errors.sort((a, b) =>
    a.location.relativeFile === b.location.relativeFile
      ? a.location.line - b.location.line
      : comparePaths(a.location.relativeFile, b.location.relativeFile),
  );

  return {
    root: options.root,
    specFiles: specs.files.map((file) => specPath(options.root, file)),
    documents: specs.documents,
    rules,
    errors,
    exclude,
  };
}

/** A path argument that cannot be asked about. */
export class QueryPathError extends Error {}

/**
 * Turns a path as someone typed it into the path a rule is written against.
 *
 * Absolute paths are accepted as long as they are inside the root, because that
 * is what an agent's file tools hand around. A path that does not exist is
 * accepted too: "what rules will govern the file I am about to create" is the
 * question this command exists for. It is a file unless it exists as a
 * directory or is written with a trailing slash.
 */
export async function resolveQueryPath(input: string, root: string, io: Io = nodeIo): Promise<QueryPath & { exists: boolean }> {
  if (input.trim().length === 0) throw new QueryPathError('A path to query must not be empty.');
  // Separators normalised before resolving, so the path, the absolute path and
  // whether it exists all describe the same file on every platform.
  const absolutePath = path.resolve(root, toPosix(input));
  const relative = path.relative(root, absolutePath);
  const posix = toPosix(relative);
  if (posix === '..' || posix.startsWith('../') || path.isAbsolute(relative)) {
    throw new QueryPathError(`"${input}" is outside the root ${toPosix(root)}.`);
  }
  const stats = await io.stat(absolutePath);
  const shape = stats ? (stats.isDirectory() ? 'directory' : 'file') : /[\\/]$/.test(input) ? 'directory' : 'file';
  return { path: posix || '.', shape, absolutePath, exists: stats !== null };
}

/* ------------------------------------------------------------------ queries */

export interface PathRules {
  path: string;
  shape: QueryPath['shape'];
  exists: boolean;
  /** The rules that govern the path, in document order. */
  rules: RuleView[];
  /**
   * Rules in documents not in force that would govern the path, and where.
   *
   * Counted whether or not they are listed. A rule that has stopped applying is
   * the thing ADR-0010 says a report must never be quiet about, and an agent
   * told "nothing governs this file" while a draft is about to govern it has
   * been told something false by omission.
   */
  withheld: { rules: number; documents: string[] };
  /**
   * The exclusions that keep rules off the path.
   *
   * "No rules govern this path" read the same for a path nothing was written
   * about and for one the project had set aside, and those call for different
   * things: writing a rule, or checking the exclusion is meant. The same
   * argument as `withheld` - a rule that does not reach a path must say why.
   */
  excluded: {
    /** The project's patterns that match the path itself, which no rule taking `exclude` then reads. */
    project: string[];
    /**
     * Rules whose scope reaches the path but for their own `exclude="..."`,
     * listed as `rules` are.
     */
    rules: RuleView[];
  };
}

export interface QueryReport {
  root: string;
  specFiles: string[];
  /** The project's exclusions, from a configuration or `--exclude`, and empty when there were none. */
  exclude: string[];
  results: PathRules[];
  /** The documents behind the listed rules, the withheld counts and the rules excluded, by path. */
  documents: DocumentView[];
  errors: Array<{ file: string; line: number; message: string }>;
  durationMs: number;
  /** What the command line took from the project's configuration, when it took anything. */
  config?: ConfigUse;
}

export interface QueryOptions extends RuleSetOptions {
  paths: readonly string[];
  /** List rules from documents that are not in force, as `--ignore-status` does. */
  includeInactive?: boolean;
}

/** The rules governing each path. */
export function answerQuery(ruleSet: RuleSet, paths: ReadonlyArray<QueryPath & { exists: boolean }>, includeInactive: boolean): Omit<QueryReport, 'durationMs'> {
  const cited = new Map<string, DocumentView>();

  const results = paths.map((query): PathRules => {
    const governing = ruleSet.rules.filter(({ assertion }) => governs(assertion, query));
    const listed = governing.filter(({ document }) => document.inForce || includeInactive);
    for (const { document } of governing) cited.set(document.file, document);
    const withheld = governing.filter(({ document }) => !document.inForce);
    const ownExclusions = ruleSet.rules.filter(
      ({ assertion, document }) => (document.inForce || includeInactive) && leftOutByOwnExclude(assertion, query, ruleSet.exclude),
    );
    for (const { document } of ownExclusions) cited.set(document.file, document);
    return {
      path: query.path,
      shape: query.shape,
      exists: query.exists,
      rules: listed.map(({ assertion, document }) => viewRule(assertion, document, query)),
      withheld: {
        rules: withheld.length,
        documents: [...new Set(withheld.map(({ document }) => document.file))],
      },
      excluded: {
        project: ruleSet.exclude.filter((pattern) => createExcludeMatcher([pattern])(query.path)),
        rules: ownExclusions.map(({ assertion, document }) => viewRule(assertion, document, query)),
      },
    };
  });

  return {
    root: toPosix(ruleSet.root),
    specFiles: ruleSet.specFiles,
    exclude: ruleSet.exclude,
    results,
    documents: [...cited.values()].sort((a, b) => comparePaths(a.file, b.file)),
    errors: ruleSet.errors.map((error) => ({
      file: error.location.relativeFile,
      line: error.location.line,
      message: error.message,
    })),
  };
}

/** Loads the rules once and answers for every path. */
export async function queryRules(options: QueryOptions): Promise<QueryReport> {
  const startedAt = performance.now();
  const paths = await Promise.all(options.paths.map((input) => resolveQueryPath(input, options.root)));
  const ruleSet = await loadRuleSet(options);
  return { ...answerQuery(ruleSet, paths, options.includeInactive ?? false), durationMs: elapsed(startedAt) };
}

/* --------------------------------------------------------------- formatting */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The lines under a rule that say what it asks of this path. */
function ruleDetails(rule: RuleView): string[] {
  const lines: string[] = [];
  if (rule.position) {
    const { layer, position, matches, mayImport, mustNotImport } = rule.position;
    const order = rule.order as string[];
    if (layer === null) {
      lines.push(
        matches.length === 0
          ? 'layer: none - no layer matches this path'
          : `layer: ambiguous - ${matches.map((match) => `"${match}"`).join(' and ')} all match, and the rule fails until one does`,
      );
    } else {
      lines.push(`layer: ${layer} (${position} of ${order.length})`);
      lines.push(`may import: ${mayImport.join(', ')}`);
      if (mustNotImport.length > 0) lines.push(`must not import: ${mustNotImport.join(', ')}`);
    }
  }
  if (rule.named !== undefined) {
    lines.push(rule.named ? 'name: allowed' : `name: not allowed - it matches none of ${(rule.pattern as string[]).join(', ')}`);
  }
  if (rule.partners) lines.push(`partner: ${rule.partners.join(' or ')}`);
  if (rule.baseline && rule.baseline.length > 0) {
    lines.push(`baseline: ${rule.baseline.map((entry) => `${entry.path} (${entry.declared})`).join(', ')}`);
  }
  if (rule.reason !== null) lines.push(`reason: ${rule.reason}`);
  return lines;
}

/** The human-readable form of a query. */
export function formatQuery(report: QueryReport): string {
  const out: string[] = [];
  const documents = new Map(report.documents.map((document) => [document.file, document]));

  for (const result of report.results) {
    const note = result.exists ? '' : result.shape === 'directory' ? ' (directory, does not exist yet)' : ' (does not exist yet)';
    out.push(`${result.path}${note}`);

    const byDocument = new Map<string, RuleView[]>();
    for (const rule of result.rules) byDocument.set(rule.document, [...(byDocument.get(rule.document) ?? []), rule]);

    // When nothing governs the path, why: an exclusion is a decision someone
    // made about it, and "no rules" alone reads as nobody having written one.
    const { project, rules: leftOut } = result.excluded;
    const none = 'no rules in force govern this path';
    out.push(
      result.rules.length > 0
        ? `  ${plural(result.rules.length, 'rule', 'rules')} from ${plural(byDocument.size, 'document', 'documents')}`
        : project.length > 0
          ? `  ${none}: the project's exclude leaves it out (${project.join(', ')})`
          : leftOut.length > 0
            ? `  ${none}: exclude="..." leaves it out of ${plural(leftOut.length, 'rule', 'rules')}`
            : `  ${none}`,
    );

    for (const [file, rules] of byDocument) {
      const document = documents.get(file) as DocumentView;
      const status = document.label === null ? '' : `, ${document.inForce ? document.status : `${document.status} - not in force`}`;
      out.push('', `  ${document.title ?? file}  (${file}${status})`);
      for (const rule of rules) {
        out.push(`    :${rule.line} @${rule.kind}  ${rule.description}`);
        for (const detail of ruleDetails(rule)) out.push(`      ${detail}`);
      }
    }

    const unlisted = result.withheld.rules - result.rules.filter((rule) => !rule.inForce).length;
    if (unlisted > 0) {
      const where = result.withheld.documents
        .map((file) => `${file} (${(documents.get(file) as DocumentView).status})`)
        .join(', ');
      out.push(
        '',
        `  ${plural(unlisted, 'more rule', 'more rules')} would govern this path if ${where} were in force; --ignore-status lists ${unlisted === 1 ? 'it' : 'them'}`,
      );
    }
    // Only a rule that takes no exclude, @assert-present, can govern a path the
    // project excludes, and the line above then says nothing about exclusion.
    if (result.rules.length > 0 && project.length > 0) {
      out.push('', `  the project's exclude leaves this path out of every rule that takes one (${project.join(', ')})`);
    }
    if (leftOut.length > 0) {
      out.push('', '  left out by exclude="...":');
      for (const rule of leftOut) out.push(`    ${rule.document}:${rule.line} @${rule.kind}  ${rule.description}`);
    }
    out.push('');
  }

  if (report.errors.length > 0) {
    out.push(`${plural(report.errors.length, 'directive', 'directives')} could not be read, so ${report.errors.length === 1 ? 'its rule governs' : 'their rules govern'} nothing:`);
    for (const error of report.errors) out.push(`  ${error.file}:${error.line} ${error.message}`);
    out.push('');
  }

  const optionLines = formatOptionLines(report.config, report.exclude);
  if (optionLines.length > 0) out.push(...optionLines, '');

  out.push(`${plural(report.specFiles.length, 'spec file', 'spec files')} read in ${report.durationMs.toFixed(1)}ms`);
  return out.join('\n');
}

/** The JSON form of a query, stable enough for a script to depend on. */
export function formatQueryJson(report: QueryReport): string {
  return JSON.stringify({ ...report, durationMs: Math.round(report.durationMs * 1000) / 1000 }, null, 2);
}

/** Whether a location lies in any of the queried paths. */
export function inQueriedPaths(file: string, paths: readonly QueryPath[]): boolean {
  return paths.some((query) => within(file, query.path));
}
