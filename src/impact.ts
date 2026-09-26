/**
 * `spec-guard impact`: who depends on a path, and which rules are in play
 * there. ADR-0018.
 *
 * The question an agent asks before an edit is not only "what may I do here"
 * - `query` answers that - but "what else does this change reach". This reads
 * the import graph backwards: for each path, the files that import it, and the
 * files that import those, with how far each is from the path; and the rules
 * in force that govern any of them, by the arithmetic a query uses.
 *
 * The graph is the one ADR-0011 built for cycles, and holds to its rule: a
 * reference is an edge only when path arithmetic names a file the walk found.
 * A reference that cannot be followed that way is counted or listed, never
 * guessed at, so a short list of dependents is never mistaken for a complete
 * one when it is not.
 */

import path from 'node:path';

import { comparePaths, MAX_CONCURRENT_READS } from './engine.js';
import { createExcludeMatcher, toPosix, walkPaths } from './glob.js';
import { isGraphFile, resolveReference, type GraphScope } from './graph.js';
import { ANALYSABLE_EXTENSIONS, createImportIndex, type ModuleReference } from './imports.js';
import { nodeIo, type Io } from './io.js';
import { languageFor, normalizeModule, type ModuleLanguage } from './polyglot.js';
import { loadRuleSet, resolveQueryPath, type RuleSetOptions } from './query.js';
import { governs, viewRule, within, type DocumentView, type QueryPath, type RuleView } from './rules.js';
import { formatOptionLines } from './reporter.js';
import { createScope } from './scope.js';
import type { ConfigUse } from './types.js';

/* -------------------------------------------------------------------- graph */

/** One import that makes an edge: the file that writes it, and the reference as written. */
interface Edge {
  from: string;
  reference: ModuleReference;
}

/** The files a relative Python import can name, most likely first. */
function pythonCandidates(resolved: string): string[] {
  return [`${resolved}.py`, `${resolved}.pyi`, `${resolved}/__init__.py`, `${resolved}/__init__.pyi`];
}

/**
 * The file a relative Python import names, or null.
 *
 * `from .db import x` names the module `db` beside the importing file:
 * `db.py`, or the package `db/__init__.py`. `from . import x` reaches the
 * reader as `.x` too, and there `x` may be a module or a name the package
 * defines, so when no module has the name the edge goes to the package's
 * `__init__.py`, which is where the name comes from. Arithmetic and
 * membership only, as ADR-0005 resolves every relative specifier.
 */
export function resolvePython(specifier: string, importingFile: string, files: ReadonlySet<string>): string | null {
  // Only ever called for a relative specifier, which starts with a dot. Each
  // dot after the first climbs a directory, and one that would climb out of
  // the root names nothing here.
  const dots = (/^\.+/.exec(specifier) as RegExpExecArray)[0];
  const directory = path.posix.dirname(importingFile);
  const depth = directory === '.' ? 0 : directory.split('/').length;
  if (dots.length - 1 > depth) return null;
  const resolved = normalizeModule(specifier, importingFile, 'python');
  const module = pythonCandidates(resolved).find((candidate) => files.has(candidate));
  if (module !== undefined) return module;
  const packageDirectory = normalizeModule(dots, importingFile, 'python');
  const prefix = packageDirectory === '.' ? '' : `${packageDirectory}/`;
  return [`${prefix}__init__.py`, `${prefix}__init__.pyi`].find((candidate) => files.has(candidate)) ?? null;
}

/** A reference the graph should have followed and could not, or one whose target no text names. */
export interface ImpactUnresolved {
  file: string;
  line: number;
  /** The specifier as written, or what could not be resolved, as `import(name)`. */
  specifier: string;
  /** `unresolved`: relative, or an alias that cannot be a package, and naming no file; `dynamic`: a computed name. */
  reason: 'unresolved' | 'dynamic';
}

/** The import graph of a whole tree, read backwards. */
export interface ReverseGraph {
  /** Every file the walk found, root-relative. */
  files: string[];
  /** The files an edge can reach: JavaScript, TypeScript and Python. */
  nodes: ReadonlySet<string>;
  /** For each file, the imports of it, by the file that writes each. */
  importers: Map<string, Edge[]>;
  unresolved: ImpactUnresolved[];
  /** References that name a module rather than a file, by language: counted, not followed. */
  unfollowed: Map<string, number>;
  /** Files whose imports could not be read in full. */
  gaps: Array<{ file: string; detail: string }>;
}

/** What each language is called in a sentence. */
const LANGUAGE_NAMES: Readonly<Record<Exclude<ModuleLanguage, 'python'>, string>> = { go: 'Go', rust: 'Rust', csharp: 'C#' };

/** How a language's references are named where a report counts them. */
const UNFOLLOWED: Readonly<Record<ModuleLanguage, string>> = {
  python: 'absolute Python import',
  go: 'Go import',
  rust: 'Rust use',
  csharp: 'C# using',
};

/**
 * Reads every analysable file in the tree and builds the graph backwards.
 *
 * Nodes are the JavaScript, TypeScript and Python files in scope. A relative
 * JavaScript or TypeScript specifier follows ADR-0011's resolution table, and
 * a relative Python import names a module beside the importing file. Every
 * other reference names a module rather than a file - an absolute Python
 * import, a Go import path, a Rust `use`, a C# `using` - and which file that
 * is depends on `sys.path`, `go.mod`, the crate's module tree or the compiler's
 * symbol table. Those are counted by language and not followed.
 */
export async function buildReverseGraph(options: { root: string; exclude: readonly string[]; defaultSkips: boolean; io: Io }): Promise<ReverseGraph> {
  const excluded = createExcludeMatcher(options.exclude);
  const files: string[] = [];
  const absolute = new Map<string, string>();
  for await (const entry of walkPaths(options.root, { io: options.io, scope: createScope(options.defaultSkips) })) {
    if (excluded(entry.relativePath)) continue;
    files.push(entry.relativePath);
    absolute.set(entry.relativePath, entry.absolutePath);
  }
  files.sort(comparePaths);
  const walked = new Set(files);
  const javascript = new Set(files.filter(isGraphFile));
  const python = files.filter((file) => languageFor(file) === 'python');
  const nodes = new Set([...javascript, ...python]);
  const scope: GraphScope = { nodes: javascript, walked, covers: () => true, excluded };

  const index = createImportIndex(options.io);
  const importers = new Map<string, Edge[]>();
  const unresolved: ImpactUnresolved[] = [];
  const unfollowed = new Map<string, number>();
  const gaps: Array<{ file: string; detail: string }> = [];
  const analysable = files.filter((file) => ANALYSABLE_EXTENSIONS.has(path.posix.extname(file)));
  // Read in batches the size of the engine's read limit, as every other
  // reader of a whole tree is: all at once is an EMFILE on a large one.
  const analyses: Array<Awaited<ReturnType<typeof index.analyze>>> = [];
  while (analyses.length < analysable.length) {
    const batch = analysable.slice(analyses.length, analyses.length + MAX_CONCURRENT_READS);
    analyses.push(...(await Promise.all(batch.map((file) => index.analyze(absolute.get(file) as string, file)))));
  }

  analysable.forEach((file, position) => {
    const { references, notes } = analyses[position] as Awaited<ReturnType<typeof index.analyze>>;
    for (const note of notes) {
      if (note.kind === 'dynamic') unresolved.push({ file, line: note.line, specifier: note.detail, reason: 'dynamic' });
      else gaps.push({ file, detail: note.detail });
    }
    const language = languageFor(file);
    for (const reference of references) {
      let target: string | null = null;
      if (language === null) {
        const resolution = resolveReference(reference.specifier, file, scope);
        if (resolution.kind === 'edge') target = resolution.file;
        else if (resolution.kind === 'unresolved') unresolved.push({ file, line: reference.line, specifier: reference.specifier, reason: 'unresolved' });
      } else if (language === 'python' && reference.specifier.startsWith('.')) {
        target = resolvePython(reference.specifier, file, walked);
        if (target === null) unresolved.push({ file, line: reference.line, specifier: reference.specifier, reason: 'unresolved' });
      } else {
        const kind = UNFOLLOWED[language];
        unfollowed.set(kind, (unfollowed.get(kind) ?? 0) + 1);
      }
      if (target !== null && target !== file) importers.set(target, [...(importers.get(target) ?? []), { from: file, reference }]);
    }
  });

  unresolved.sort((a, b) => comparePaths(a.file, b.file) || a.line - b.line);
  return { files, nodes, importers, unresolved, unfollowed, gaps };
}

/** A file that depends on a path, how far from it, and the import that takes it one step closer. */
export interface ImpactDependent {
  file: string;
  /** 1 for a file that imports the path itself, 2 for one that imports such a file, and so on. */
  depth: number;
  /** The first import, in source order, of a file one step closer. */
  via: { imports: string; line: number; specifier: string };
}

/**
 * The files that depend on `start`, breadth-first, each at its shortest
 * distance, as deep as `maxDepth` allows. A cycle is safe: a file is visited
 * once. Neighbours are taken in path order, so the answer is the same every
 * time.
 */
export function dependentsOf(graph: Pick<ReverseGraph, 'importers'>, start: readonly string[], maxDepth = Number.POSITIVE_INFINITY): ImpactDependent[] {
  const seen = new Set(start);
  const found: ImpactDependent[] = [];
  let frontier = [...start].sort(comparePaths);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const target of frontier) {
      const edges = [...(graph.importers.get(target) ?? [])].sort((a, b) => comparePaths(a.from, b.from) || a.reference.line - b.reference.line);
      for (const { from, reference } of edges) {
        if (seen.has(from)) continue;
        seen.add(from);
        next.push(from);
        found.push({ file: from, depth, via: { imports: target, line: reference.line, specifier: reference.specifier } });
      }
    }
    frontier = next.sort(comparePaths);
  }
  return found.sort((a, b) => a.depth - b.depth || comparePaths(a.file, b.file));
}

/* ------------------------------------------------------------------- report */

export interface ImpactOptions extends RuleSetOptions {
  /** The paths to ask about, as typed. */
  paths: readonly string[];
  /** How many steps of dependents to follow; all of them when absent. */
  depth?: number;
  /** List rules from documents not in force, as `--ignore-status` does. */
  includeInactive?: boolean;
}

export interface ImpactPath {
  path: string;
  shape: QueryPath['shape'];
  /** The files of the path the graph holds: the file itself, or those under the directory. */
  files: string[];
  /** Why no dependent can be shown for this path, when none can. */
  note?: string;
  dependents: ImpactDependent[];
}

export interface ImpactReport {
  root: string;
  specFiles: string[];
  exclude: string[];
  /** The depth asked for, or null for every dependent. */
  depth: number | null;
  results: ImpactPath[];
  /** Rules in force - or every rule, with `includeInactive` - that govern a path or a dependent, with the ones each governs. */
  rules: Array<RuleView & { governs: string[] }>;
  /** Rules in documents not in force that would govern them, counted, and their documents. */
  withheld: { rules: number; documents: string[] };
  documents: DocumentView[];
  /** References in scope that could depend on these paths and could not be followed. */
  unresolved: ImpactUnresolved[];
  /** References that name a module rather than a file, by kind, and how many. */
  unfollowed: Array<{ kind: string; references: number }>;
  gaps: Array<{ file: string; detail: string }>;
  errors: Array<{ file: string; line: number; message: string }>;
  /** Files the walk found. */
  scanned: number;
  durationMs: number;
  /** What the command line took from the project's configuration, when it took anything. */
  config?: ConfigUse;
}

/** A thrown reason the question cannot be answered. */
export class ImpactError extends Error {}

/** Why a path's dependents cannot be shown, or undefined when they can. */
function unreachable(query: QueryPath, files: readonly string[]): string | undefined {
  if (files.length > 0) return undefined;
  if (query.shape === 'directory') return 'no JavaScript, TypeScript or Python file under it is in scope';
  const language = languageFor(query.path);
  if (language === null ? isGraphFile(query.path) : language === 'python') {
    return "it is not in scope: the project's exclude, or a directory the walk skips, leaves it out";
  }
  return language === null
    ? 'it is not JavaScript, TypeScript or Python, so no import names it as a file'
    : `a ${LANGUAGE_NAMES[language as Exclude<ModuleLanguage, 'python'>]} file is imported by the name of a module, not by its path, so what depends on it is not computed (ADR-0018)`;
}

/** Answers the question for every path, from one read of the tree and the specs. */
export async function impactOf(options: ImpactOptions): Promise<ImpactReport> {
  const startedAt = performance.now();
  const io = options.io ?? nodeIo;
  const queries = await Promise.all(options.paths.map((input) => resolveQueryPath(input, options.root, io)));
  for (const query of queries) {
    if (!query.exists) throw new ImpactError(`"${query.path}" does not exist, so nothing depends on it yet`);
  }
  const ruleSet = await loadRuleSet({ ...options, io });
  const graph = await buildReverseGraph({ root: options.root, exclude: ruleSet.exclude, defaultSkips: options.defaultSkips ?? true, io });

  const results = queries.map((query): ImpactPath => {
    const files = [...graph.nodes].filter((file) => (query.shape === 'file' ? file === query.path : within(file, query.path))).sort(comparePaths);
    const note = unreachable(query, files);
    return {
      path: query.path,
      shape: query.shape,
      files,
      ...(note === undefined ? {} : { note }),
      dependents: dependentsOf(graph, files, options.depth),
    };
  });

  // Every path asked about, as asked, and every dependent as a file: the rules
  // a query would show for each of them.
  const governed: QueryPath[] = [
    ...queries,
    ...[...new Set(results.flatMap((result) => result.dependents.map((dependent) => dependent.file)))].map((file) => ({
      path: file,
      shape: 'file' as const,
      absolutePath: path.resolve(options.root, file),
    })),
  ];
  const includeInactive = options.includeInactive ?? false;
  const rules: ImpactReport['rules'] = [];
  const withheld = new Set<string>();
  let withheldRules = 0;
  const cited = new Map<string, DocumentView>();
  for (const { assertion, document } of ruleSet.rules) {
    const covered = governed.filter((query) => governs(assertion, query)).map((query) => query.path);
    if (covered.length === 0) continue;
    if (!document.inForce) {
      withheldRules += 1;
      withheld.add(document.file);
      cited.set(document.file, document);
      if (!includeInactive) continue;
    }
    cited.set(document.file, document);
    rules.push({ ...viewRule(assertion, document), governs: covered });
  }

  return {
    root: toPosix(options.root),
    specFiles: ruleSet.specFiles,
    exclude: ruleSet.exclude,
    depth: options.depth ?? null,
    results,
    rules,
    withheld: { rules: withheldRules, documents: [...withheld] },
    documents: [...cited.values()].sort((a, b) => comparePaths(a.file, b.file)),
    unresolved: graph.unresolved,
    unfollowed: [...graph.unfollowed].map(([kind, references]) => ({ kind, references })).sort((a, b) => b.references - a.references || comparePaths(a.kind, b.kind)),
    gaps: graph.gaps,
    errors: ruleSet.errors.map((error) => ({ file: error.location.relativeFile, line: error.location.line, message: error.message })),
    scanned: graph.files.length,
    durationMs: performance.now() - startedAt,
  };
}

/* --------------------------------------------------------------- formatting */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** At most this many unresolved references are listed in the human report; JSON has them all. */
const SHOWN_UNRESOLVED = 10;

/** At most this many files are named under a rule in the human report; JSON has them all. */
const SHOWN_GOVERNED = 5;

/** The human-readable form of an impact report. */
export function formatImpact(report: ImpactReport): string {
  const out: string[] = [];
  for (const result of report.results) {
    const kind = result.shape === 'directory' ? ` (directory, ${plural(result.files.length, 'file', 'files')} in the graph)` : '';
    out.push(`${result.path}${kind}`);
    if (result.note !== undefined) {
      out.push(`  no dependents shown: ${result.note}`, '');
      continue;
    }
    const direct = result.dependents.filter((dependent) => dependent.depth === 1).length;
    const deepest = result.dependents.reduce((most, dependent) => Math.max(most, dependent.depth), 0);
    out.push(
      result.dependents.length === 0
        ? '  nothing in scope imports it'
        : `  ${plural(result.dependents.length, 'file depends', 'files depend')} on it, ${direct} directly${deepest > 1 ? `, up to ${deepest} imports away` : ''}`,
    );
    const width = Math.max(0, ...result.dependents.map((dependent) => dependent.file.length));
    for (const dependent of result.dependents) {
      out.push(`    ${dependent.depth}  ${dependent.file.padEnd(width)}  imports ${dependent.via.imports} (line ${dependent.via.line})`);
    }
    out.push('');
  }
  if (report.depth !== null) out.push(`only dependents up to ${plural(report.depth, 'import', 'imports')} away are shown (--depth ${report.depth})`, '');

  const documents = new Map(report.documents.map((document) => [document.file, document]));
  const byDocument = new Map<string, ImpactReport['rules']>();
  for (const rule of report.rules) byDocument.set(rule.document, [...(byDocument.get(rule.document) ?? []), rule]);
  out.push(
    report.specFiles.length === 0
      ? 'no spec files matched, so no rules are shown'
      : report.rules.length === 0
        ? 'no rules in force govern these files'
        : `${plural(report.rules.length, 'rule governs', 'rules govern')} these files, from ${plural(byDocument.size, 'document', 'documents')}`,
  );
  for (const [file, rules] of byDocument) {
    const document = documents.get(file) as DocumentView;
    const status = document.inForce ? '' : `, ${document.status} - not in force`;
    out.push('', `  ${document.title ?? file}  (${file}${status})`);
    for (const rule of rules) {
      out.push(`    :${rule.line} @${rule.kind}  ${rule.description}`);
      const more = rule.governs.length - SHOWN_GOVERNED;
      out.push(`      governs: ${rule.governs.slice(0, SHOWN_GOVERNED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
      if (rule.reason !== null) out.push(`      reason: ${rule.reason}`);
    }
  }
  const unlisted = report.withheld.rules - report.rules.filter((rule) => !rule.inForce).length;
  if (unlisted > 0) {
    out.push(
      '',
      `  ${plural(unlisted, 'more rule', 'more rules')} would govern them if ${report.withheld.documents.join(', ')} ${report.withheld.documents.length === 1 ? 'were' : 'were all'} in force; --ignore-status lists ${unlisted === 1 ? 'it' : 'them'}`,
    );
  }
  out.push('');

  if (report.unfollowed.length > 0) {
    const counts = report.unfollowed.map(({ kind, references }) => plural(references, kind, `${kind}s`)).join(', ');
    out.push(`not followed: ${counts} name modules rather than files, so a file that depends on these paths through one is not shown (ADR-0018)`, '');
  }
  if (report.unresolved.length > 0) {
    out.push(`${plural(report.unresolved.length, 'import', 'imports')} could not be resolved, and may depend on these paths:`);
    for (const entry of report.unresolved.slice(0, SHOWN_UNRESOLVED)) {
      out.push(`  ${entry.file}:${entry.line}  ${entry.specifier}${entry.reason === 'dynamic' ? '' : ' (names no file)'}`);
    }
    if (report.unresolved.length > SHOWN_UNRESOLVED) out.push(`  and ${report.unresolved.length - SHOWN_UNRESOLVED} more; --json lists them all`);
    out.push('');
  }
  if (report.gaps.length > 0) {
    out.push(`${plural(report.gaps.length, 'file', 'files')} whose imports could not all be read:`);
    for (const gap of report.gaps) out.push(`  ${gap.file}: ${gap.detail}`);
    out.push('');
  }
  if (report.errors.length > 0) {
    out.push(`${plural(report.errors.length, 'directive', 'directives')} could not be read, so ${report.errors.length === 1 ? 'its rule governs' : 'their rules govern'} nothing:`);
    for (const error of report.errors) out.push(`  ${error.file}:${error.line} ${error.message}`);
    out.push('');
  }
  const optionLines = formatOptionLines(report.config, report.exclude);
  if (optionLines.length > 0) out.push(...optionLines, '');

  out.push(`${plural(report.scanned, 'file', 'files')} and ${plural(report.specFiles.length, 'spec file', 'spec files')} read in ${report.durationMs.toFixed(1)}ms`);
  return out.join('\n');
}

/**
 * The version of `impact --json`'s document. A field removed or renamed moves
 * it; a field added does not.
 */
export const IMPACT_FORMAT_VERSION = 1;

/** The JSON form of an impact report. */
export function formatImpactJson(report: ImpactReport): string {
  return JSON.stringify({ formatVersion: IMPACT_FORMAT_VERSION, ...report, durationMs: Math.round(report.durationMs * 1000) / 1000 }, null, 2);
}
