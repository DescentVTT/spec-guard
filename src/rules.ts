/**
 * Which rules govern a path, decided from the specs alone.
 *
 * Pure. Nothing here reads the codebase: whether an assertion's scope reaches a
 * path is arithmetic on the assertion's own `target`, `exclude` and `glob`, the
 * run's skipped directory names, and the path's extension. That is the whole
 * reason a query can answer in milliseconds - and it is also a claim, that the
 * arithmetic agrees with the walk the assertion would really make. The suite
 * holds it to that claim by comparing the two over real trees; ADR-0012 lists
 * the three things arithmetic cannot see.
 *
 * A file is governed or it is not. A directory is governed when some file under
 * it could be, and "could" is doing work: whether `glob="*.py"` matches anything
 * in `src/` is a question about files that are not read here. The rule is shown
 * with its filters rather than being guessed away.
 */

import path from 'node:path';

import { createExcludeMatcher, createGlobMatcher } from './glob.js';
import { isGraphFile } from './graph.js';
import { ANALYSABLE_EXTENSIONS } from './imports.js';
import { layerMatcher } from './layers.js';
import type { Assertion, BaselineEntry, Bounds, DirectiveKind, SearchOptions } from './types.js';

/** Whether a query is about one file or everything under a directory. */
export type PathShape = 'file' | 'directory';

export interface QueryPath {
  /** Root-relative, forward slashes; `.` for the root itself. */
  path: string;
  shape: PathShape;
  /** Absolute, so it can be compared with the spec files a search leaves out. */
  absolutePath: string;
}

/** Whether `child` is `parent` or lies under it. */
export function within(child: string, parent: string): boolean {
  return parent === '.' || child === parent || child.startsWith(`${parent}/`);
}

/** Whether the file-reading part of an assertion can read this file at all. */
function readable(kind: DirectiveKind, relativePath: string): boolean {
  if (kind === 'assert-import-cycle') return isGraphFile(relativePath);
  if (kind === 'assert-import-absence' || kind === 'assert-import-count' || kind === 'assert-layers') {
    return ANALYSABLE_EXTENSIONS.has(path.posix.extname(relativePath));
  }
  return true;
}

/**
 * Whether the walk from `target` would step into a skipped directory on its way
 * to `relativePath`.
 *
 * Only the directories below the target count, which is how the walk behaves: it
 * never checks the name of the directory it was started in, so
 * `target="node_modules/pkg"` is searched and `target="src"` does not reach
 * `src/node_modules`.
 */
function skippedOnTheWay(target: string, relativePath: string, options: SearchOptions, isFile: boolean): boolean {
  // A target that is the path itself leaves this empty, and it splits into one
  // empty name - which no skipped directory has.
  const directories = path.posix.relative(target, relativePath).split('/');
  if (isFile) directories.pop();
  return directories.some((name) => options.scope.skippedDirectories.has(name));
}

/**
 * Whether an assertion's scope reaches a path.
 *
 * For a file, exactly what the walk would do: under a target, not excluded, not
 * inside a skipped directory, matched by `glob`, not one of the spec files, and
 * in a language the assertion reads. For a directory, whether any of that could
 * be true of something under it.
 */
export function governs(assertion: Assertion, query: QueryPath): boolean {
  if (assertion.kind === 'assert-present') {
    return assertion.files.some((file) => (query.shape === 'file' ? file === query.path : within(file, query.path)));
  }

  const options = assertion.search as SearchOptions;
  const excluded = createExcludeMatcher(options.excludeGlobs);

  if (query.shape === 'file') {
    return (
      assertion.targets.some(
        (target) => within(query.path, target) && !skippedOnTheWay(target, query.path, options, true),
      ) &&
      !excluded(query.path) &&
      createGlobMatcher(options.globs)(query.path) &&
      !options.excludeFiles.has(query.absolutePath) &&
      readable(assertion.kind, query.path)
    );
  }

  return assertion.targets.some((target) => {
    // The directory is inside the target: everything under it is walked unless
    // the directory itself is skipped or excluded - and an excluded directory
    // excludes all of its contents, because `exclude` tests every ancestor.
    if (within(query.path, target)) {
      return !skippedOnTheWay(target, query.path, options, false) && !excluded(query.path);
    }
    // The target is inside the directory: its files are under the directory.
    return within(target, query.path) && !excluded(target);
  });
}

/* ---------------------------------------------------------------- the views */

/** A spec document, as a rule's reader needs to see it. */
export interface DocumentView {
  file: string;
  title: string | null;
  /** The normalised status word, or null for a document that declares none. */
  status: string | null;
  /** The status line as written. */
  label: string | null;
  inForce: boolean;
}

/** A layer position: where a path sits in an `@assert-layers` order. */
export interface LayerPosition {
  /** The layer the path belongs to, or null when no layer or two layers match it. */
  layer: string | null;
  /** 1-based position of that layer in the order. */
  position: number | null;
  /** Every layer that matches the path - more than one is a rule that fails. */
  matches: string[];
  /** The layers its imports may reach: its own and every one listed before it. */
  mayImport: string[];
  /** The layers its imports must not reach. */
  mustNotImport: string[];
}

/** One rule, as a query reports it. */
export interface RuleView {
  document: string;
  line: number;
  kind: DirectiveKind;
  description: string;
  reason: string | null;
  /** Whether the document stating it is in force. */
  inForce: boolean;
  bounds: Bounds;
  /** `@assert-present` only. */
  files?: string[];
  targets?: string[];
  exclude?: string[];
  /** The text rules. */
  glob?: string[];
  symbol?: string;
  regex?: boolean;
  word?: boolean;
  ignoreCase?: boolean;
  comments?: 'ignore' | 'include';
  /** The import rules. */
  modules?: string[];
  types?: 'include' | 'ignore';
  order?: string[];
  /** Files exempted by a baseline - for a query, only those at or under the path. */
  baseline?: readonly BaselineEntry[];
  /** For `@assert-layers` asked about a path: where the path sits. */
  position?: LayerPosition;
}

/**
 * Where a path sits in a layer order.
 *
 * For a directory, the layer that matches the directory itself - which then
 * matches every file under it, since a layer is an `exclude`-style pattern and
 * those test every ancestor. A directory no layer matches may still hold files
 * that one does, and is reported as belonging to none rather than guessed at.
 */
export function layerPosition(order: readonly string[], relativePath: string): LayerPosition {
  const indices = layerMatcher(order)(relativePath);
  const matches = indices.map((index) => order[index] as string);
  if (indices.length !== 1) return { layer: null, position: null, matches, mayImport: [], mustNotImport: [] };
  const index = indices[0] as number;
  return {
    layer: order[index] as string,
    position: index + 1,
    matches,
    mayImport: order.slice(0, index + 1),
    mustNotImport: order.slice(index + 1),
  };
}

/**
 * A rule as a report shows it, optionally as it applies to one path.
 *
 * Every field is what the directive said, resolved - never a default invented
 * for display. A text rule reports its `glob` even when empty, because "every
 * file" is a statement about scope a reader should not have to infer.
 */
export function viewRule(assertion: Assertion, document: DocumentView, query?: QueryPath): RuleView {
  const view: RuleView = {
    document: document.file,
    line: assertion.location.line,
    kind: assertion.kind,
    description: assertion.description,
    reason: assertion.reason ?? null,
    inForce: document.inForce,
    bounds: assertion.bounds,
  };

  if (assertion.kind === 'assert-present') return { ...view, files: assertion.files };

  const options = assertion.search as SearchOptions;
  const baseline = query ? assertion.baseline.filter((entry) => within(entry.path, query.path)) : assertion.baseline;
  const scoped: RuleView = { ...view, targets: assertion.targets, exclude: options.excludeGlobs };

  if (assertion.imports === undefined) {
    return {
      ...scoped,
      glob: options.globs,
      symbol: assertion.symbol as string,
      regex: options.regex,
      word: options.word,
      ignoreCase: options.ignoreCase,
      comments: options.ignoreComments ? 'ignore' : 'include',
      baseline,
    };
  }

  const types = assertion.imports.includeTypes ? 'include' : 'ignore';
  if (assertion.kind === 'assert-import-cycle') return { ...scoped, types };
  if (assertion.layers === undefined) return { ...scoped, modules: assertion.imports.modules, types, baseline };
  return {
    ...scoped,
    order: assertion.layers,
    types,
    baseline,
    ...(query ? { position: layerPosition(assertion.layers, query.path) } : {}),
  };
}
