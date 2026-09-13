/**
 * The import graph behind `@assert-import-cycle`.
 *
 * Pure: no filesystem, no reading. The runner walks and tokenizes; everything
 * here is a function of the references it was handed and the list of files the
 * walk produced. That is the one thing ADR-0011 changed about resolution. A
 * specifier is still turned into a path by arithmetic alone, as ADR-0005
 * requires - but the path may now be compared with a set the run already holds,
 * and that membership test is what gives a reference a file to point at.
 *
 * Layering lives elsewhere, in `layers.ts`, and on purpose. A layering rule
 * matches names and never needs to know which file a reference is; a cycle
 * cannot be seen without knowing exactly that. The two rest on different
 * foundations, and keeping them in different modules keeps either from
 * borrowing the other's.
 */

import path from 'node:path';

import { comparePaths } from './engine.js';
import { JS_EXTENSIONS, type ModuleReference } from './imports.js';

/* --------------------------------------------------------------- resolution */

/** What an emitted extension was compiled from, in the order TypeScript tries. */
const SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Appended to an extensionless path, and to `/index`, in TypeScript's order. */
const APPENDED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/**
 * Every file a relative specifier might mean, most likely first.
 *
 * The whole resolver, and deliberately short enough to read in one go: the
 * TypeScript source of an emitted extension, the path as written, the path
 * with an extension, the directory's index. No `tsconfig` paths, no `exports`
 * maps, no guessing at a build - ADR-0011 has the table and the reasons.
 */
export function candidates(resolved: string): string[] {
  const extension = path.posix.extname(resolved);
  const stem = resolved.slice(0, resolved.length - extension.length);
  return [
    ...(SOURCE_EXTENSIONS[extension] ?? []).map((source) => `${stem}${source}`),
    resolved,
    ...APPENDED_EXTENSIONS.map((appended) => `${resolved}${appended}`),
    ...APPENDED_EXTENSIONS.map((appended) => `${resolved}/index${appended}`),
  ];
}

/**
 * Where a reference leads, as far as the graph is concerned.
 *
 * `edge` has a file. The other four do not, and they are distinguished because
 * only one of them is a hole in the answer: `outside`, `not-code` and
 * `external` are references the graph was never meant to follow, while
 * `unresolved` is one it should have followed and could not.
 */
export type Resolution =
  | { kind: 'edge'; file: string }
  | { kind: 'outside' }
  | { kind: 'not-code' }
  | { kind: 'external' }
  | { kind: 'unresolved' };

export interface GraphScope {
  /** The graph's nodes: JS and TS files in scope, root-relative, POSIX. */
  nodes: ReadonlySet<string>;
  /** Every file the walk produced, whatever its language. */
  walked: ReadonlySet<string>;
  /** Whether a root-relative path lies under one of the assertion's targets. */
  covers: (relativePath: string) => boolean;
  /** Whether a root-relative path is left out by the assertion's `exclude`. */
  excluded: (relativePath: string) => boolean;
}

function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * A non-relative specifier that no package could be named.
 *
 * `#` is Node's prefix for imports private to the importing package, and `@/`,
 * `~/` and a leading `/` are not valid package names. Something written that way
 * has to be an alias for code inside the project, so an edge that cannot be
 * followed is missing rather than absent. This is the only inference in the
 * resolver, and it is made from npm's naming rules, not from anyone's config.
 */
function cannotBePackage(specifier: string): boolean {
  return /^(?:#|@\/|~\/|\/)/.test(specifier);
}

/** Resolves one specifier written in `importingFile` against the graph's scope. */
export function resolveReference(specifier: string, importingFile: string, scope: GraphScope): Resolution {
  if (!isRelative(specifier)) {
    return cannotBePackage(specifier) ? { kind: 'unresolved' } : { kind: 'external' };
  }

  const resolved = path.posix.join(path.posix.dirname(importingFile), specifier).replace(/\/$/, '');
  const names = candidates(resolved);
  const file = names.find((candidate) => scope.nodes.has(candidate));
  if (file !== undefined) return { kind: 'edge', file };
  // Every name for `exclude`, not only the path as written: `exclude="src/b.ts"`
  // names the file and `./b.js` is what imports it, and tested against the
  // specifier alone an excluded file looked like a broken import and failed
  // --strict. Targets need no such care - a candidate only ever appends to the
  // path, so it is under a target exactly when the path is.
  if (!scope.covers(resolved) || names.some(scope.excluded)) return { kind: 'outside' };
  // Membership, not an extension list. `./styles.css` that exists is not code;
  // `./widget.service` that does not exist is a broken import, whatever its
  // suffix happens to look like.
  if (scope.walked.has(resolved)) return { kind: 'not-code' };
  return { kind: 'unresolved' };
}

/** Whether a path is a file the graph can hold. */
export function isGraphFile(relativePath: string): boolean {
  return JS_EXTENSIONS.has(path.posix.extname(relativePath));
}

/* -------------------------------------------------------------------- graph */

export interface GraphInput {
  /** Root-relative path of the importing file. */
  file: string;
  references: readonly ModuleReference[];
}

export interface Unresolved {
  file: string;
  reference: ModuleReference;
}

export interface ImportGraph {
  /** Every node, in path order. */
  nodes: string[];
  /** Out-edges of each node that has any, in path order, without duplicates. */
  successors: Map<string, string[]>;
  /** The first reference, in source order, that produced each edge. */
  via: Map<string, ModuleReference>;
  /** References that should have produced an edge and did not. */
  unresolved: Unresolved[];
}

/** The key `via` stores an edge under. */
export function edgeKey(from: string, to: string): string {
  return `${from}\n${to}`;
}

/**
 * Builds the graph from each file's references.
 *
 * Type-only references are left out when `includeTypes` is false, which is the
 * difference between the coupling question and the runtime one - erased imports
 * create no load-order cycle.
 */
export function buildGraph(inputs: readonly GraphInput[], scope: GraphScope, includeTypes: boolean): ImportGraph {
  const targets = new Map<string, Set<string>>();
  const via = new Map<string, ModuleReference>();
  const unresolved: Unresolved[] = [];

  for (const { file, references } of inputs) {
    for (const reference of references) {
      if (reference.typeOnly && !includeTypes) continue;
      const resolution = resolveReference(reference.specifier, file, scope);
      if (resolution.kind === 'unresolved') unresolved.push({ file, reference });
      if (resolution.kind !== 'edge') continue;

      const out = targets.get(file) ?? new Set<string>();
      targets.set(file, out);
      out.add(resolution.file);
      const key = edgeKey(file, resolution.file);
      if (!via.has(key)) via.set(key, reference);
    }
  }

  const successors = new Map([...targets].map(([file, out]) => [file, [...out].sort(comparePaths)]));
  return { nodes: [...scope.nodes].sort(comparePaths), successors, via, unresolved };
}

/* ------------------------------------------------------------------- cycles */

/**
 * Tarjan's strongly connected components, iteratively.
 *
 * The recursive form is the textbook one and recurses once per node on a
 * dependency chain, so a long enough chain - a generated barrel file will make
 * one - overflows the stack. Here the call stack is an explicit array of frames,
 * each remembering how far through its out-edges it had got.
 *
 * Every component is returned, including the single nodes that are not in any
 * cycle; `cyclicComponents` is the filter.
 */
export function stronglyConnected(nodes: readonly string[], successors: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): { node: string; next: number } => {
    const order = index.size;
    index.set(node, order);
    low.set(node, order);
    stack.push(node);
    onStack.add(node);
    return { node, next: 0 };
  };

  for (const start of nodes) {
    if (index.has(start)) continue;
    const frames = [visit(start)];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { node: string; next: number };
      const out = successors.get(frame.node) ?? [];

      if (frame.next < out.length) {
        const next = out[frame.next++] as string;
        if (!index.has(next)) frames.push(visit(next));
        else if (onStack.has(next)) low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(next) as number));
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }

  return components;
}

/**
 * The components that contain a cycle, each in path order, ordered by first
 * member.
 *
 * A component of one node is a cycle only if that node imports itself. The
 * ordering is for the report: the same tree yields the same list, whichever
 * order the walk or the tokenizer happened to finish in.
 */
export function cyclicComponents(graph: Pick<ImportGraph, 'nodes' | 'successors'>): string[][] {
  return stronglyConnected(graph.nodes, graph.successors)
    .filter(
      (component) =>
        component.length > 1 || (graph.successors.get(component[0] as string) ?? []).includes(component[0] as string),
    )
    .map((component) => component.sort(comparePaths))
    .sort((a, b) => comparePaths(a[0] as string, b[0] as string));
}

/**
 * One concrete cycle through a component: the shortest through its first file.
 *
 * A component is a set, and nobody fixes a set. What someone changes is an
 * import, so the report has to name the imports that close a loop. Breadth-first
 * from the first file, confined to the component - a node outside it cannot lead
 * back, so searching there costs time and cannot change the answer - and the
 * first node reached that imports the start closes the shortest loop.
 *
 * Returned with the start at both ends: `[a, b, a]`, or `[a, a]` for a file that
 * imports itself.
 */
export function witness(component: readonly string[], successors: ReadonlyMap<string, readonly string[]>): string[] {
  const start = component[0] as string;
  const members = new Set(component);
  const previous = new Map<string, string>();
  const queue = [start];

  // No `?? []` on these lookups. Every file in a cyclic component imports at
  // least one other file in it - that is what being in one means - so the
  // fallback could never be taken, and a branch nothing can reach reads exactly
  // like one that something can.
  const out = (node: string): readonly string[] => successors.get(node) as readonly string[];

  for (let at = 0; at < queue.length; at++) {
    const node = queue[at] as string;
    for (const next of out(node)) {
      if (!members.has(next) || previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }

  const last = queue.find((node) => out(node).includes(start)) as string;
  const loop = [start];
  for (let node = last; node !== start; node = previous.get(node) as string) loop.splice(1, 0, node);
  return [...loop, start];
}
