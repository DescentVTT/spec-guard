/**
 * The import graph: resolution, Tarjan, and the loop a report shows.
 *
 * Resolution is the part that can make a cycle detector lie, so it is tested
 * outcome by outcome against ADR-0011's table, and every outcome that produces
 * no edge is paired with the nearest input that does. An `external` that should
 * have been an `edge` is a cycle nobody will ever be told about.
 */

import { describe, expect, it } from 'vitest';

import {
  buildGraph,
  candidates,
  cyclicComponents,
  edgeKey,
  isGraphFile,
  resolveReference,
  stronglyConnected,
  witness,
  type GraphScope,
} from '../src/graph.js';
import type { ModuleReference } from '../src/imports.js';

function ref(specifier: string, line = 1, typeOnly = false): ModuleReference {
  return { specifier, kind: 'import', typeOnly, line, column: 1 };
}

function scope(nodes: string[], extra: { walked?: string[]; targets?: string[]; excluded?: string[] } = {}): GraphScope {
  const targets = extra.targets ?? ['src'];
  return {
    nodes: new Set(nodes),
    walked: new Set([...nodes, ...(extra.walked ?? [])]),
    covers: (path) => targets.some((target) => path === target || path.startsWith(`${target}/`)),
    excluded: (path) => (extra.excluded ?? []).some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
  };
}

const graphOf = (edges: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(edges));

/* --------------------------------------------------------------- resolution */

describe('the candidates a relative specifier is tried as', () => {
  it('tries an emitted extension as its TypeScript source first, then as written', () => {
    expect(candidates('src/b.js').slice(0, 4)).toEqual(['src/b.ts', 'src/b.tsx', 'src/b.js', 'src/b.js.ts']);
    expect(candidates('src/b.jsx').slice(0, 2)).toEqual(['src/b.tsx', 'src/b.jsx']);
    expect(candidates('src/b.mjs').slice(0, 2)).toEqual(['src/b.mts', 'src/b.mjs']);
    expect(candidates('src/b.cjs').slice(0, 2)).toEqual(['src/b.cts', 'src/b.cjs']);
  });

  it('is the whole table, in order, for an extensionless path', () => {
    // Written out rather than derived, so the order - which decides where an
    // edge goes when two files could be meant - is a thing a diff shows.
    const order = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
    expect(candidates('src/b')).toEqual([
      'src/b',
      ...order.map((extension) => `src/b${extension}`),
      ...order.map((extension) => `src/b/index${extension}`),
    ]);
  });

  it('has no TypeScript source for an extension nothing compiles to', () => {
    expect(candidates('src/b.ts')[0]).toBe('src/b.ts');
    expect(candidates('src/b.css')[0]).toBe('src/b.css');
  });
});

describe('where a reference leads', () => {
  const nodes = ['src/a.ts', 'src/b.ts', 'src/util/index.ts', 'src/legacy.js', 'src/types.d.ts'];

  it('follows the emitted-extension convention TypeScript projects write', () => {
    expect(resolveReference('./b.js', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/b.ts' });
  });

  it('follows an extensionless import, a directory index, and a declaration file', () => {
    expect(resolveReference('./b', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/b.ts' });
    expect(resolveReference('./util', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/util/index.ts' });
    expect(resolveReference('./util/', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/util/index.ts' });
    expect(resolveReference('./types', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/types.d.ts' });
  });

  it('follows a plain JavaScript file as written', () => {
    expect(resolveReference('./legacy.js', 'src/a.ts', scope(nodes))).toEqual({ kind: 'edge', file: 'src/legacy.js' });
  });

  it('prefers the TypeScript source where both it and its output are in scope', () => {
    const both = scope(['src/a.ts', 'src/b.ts', 'src/b.js']);
    expect(resolveReference('./b.js', 'src/a.ts', both)).toEqual({ kind: 'edge', file: 'src/b.ts' });
  });

  it('follows `.` and `..`, which are relative without a slash', () => {
    const tree = scope(['src/index.ts', 'src/deep/index.ts', 'src/deep/leaf.ts']);
    expect(resolveReference('.', 'src/deep/leaf.ts', tree)).toEqual({ kind: 'edge', file: 'src/deep/index.ts' });
    expect(resolveReference('..', 'src/deep/leaf.ts', tree)).toEqual({ kind: 'edge', file: 'src/index.ts' });
  });

  it('calls a reference out of scope outside, and the same reference in scope an edge', () => {
    expect(resolveReference('../lib/x.js', 'src/a.ts', scope(nodes))).toEqual({ kind: 'outside' });
    expect(resolveReference('../lib/x.js', 'src/a.ts', scope([...nodes, 'lib/x.ts'], { targets: ['src', 'lib'] }))).toEqual({
      kind: 'edge',
      file: 'lib/x.ts',
    });
  });

  it('calls an excluded file outside rather than missing', () => {
    // Excluded files are not nodes, so without this they would be reported as
    // imports that could not be resolved - noise about a choice the author made.
    const excluded = scope(['src/a.ts'], { excluded: ['src/generated'] });
    expect(resolveReference('./generated/api.js', 'src/a.ts', excluded)).toEqual({ kind: 'outside' });
  });

  it('recognises an excluded file under the name the import gives it', () => {
    // `exclude` names `src/b.ts`; the import says `./b.js`. Tested against the
    // specifier alone, the excluded file was a broken import.
    expect(resolveReference('./b.js', 'src/a.ts', scope(['src/a.ts'], { excluded: ['src/b.ts'] }))).toEqual({
      kind: 'outside',
    });
    // The control: the same import, nothing excluded, nothing there.
    expect(resolveReference('./b.js', 'src/a.ts', scope(['src/a.ts']))).toEqual({ kind: 'unresolved' });
  });

  it('calls a file that exists but is not code not-code, by membership rather than by extension', () => {
    const tree = scope(['src/a.ts'], { walked: ['src/app.css', 'src/data.json'] });
    expect(resolveReference('./app.css', 'src/a.ts', tree)).toEqual({ kind: 'not-code' });
    expect(resolveReference('./data.json', 'src/a.ts', tree)).toEqual({ kind: 'not-code' });
    // The control: an extension that looks like an asset does not make a file
    // that is not there into one that is merely not code.
    expect(resolveReference('./missing.css', 'src/a.ts', tree)).toEqual({ kind: 'unresolved' });
  });

  it('calls a relative import into scope that matches nothing unresolved', () => {
    // `.service` is not an extension anyone should be trusted to recognise:
    // `widget.service.ts` resolves, and a missing one is a broken import.
    const tree = scope(['src/a.ts', 'src/widget.service.ts']);
    expect(resolveReference('./widget.service', 'src/a.ts', tree)).toEqual({ kind: 'edge', file: 'src/widget.service.ts' });
    expect(resolveReference('./gone.service', 'src/a.ts', tree)).toEqual({ kind: 'unresolved' });
  });

  it('calls anything that can name a package external', () => {
    for (const specifier of ['react', '@scope/pkg', 'node:fs', 'lodash/fp', '@app/db']) {
      expect(resolveReference(specifier, 'src/a.ts', scope(nodes)), specifier).toEqual({ kind: 'external' });
    }
  });

  it('calls anything that cannot name a package unresolved, because it has to be an alias', () => {
    for (const specifier of ['#internal/db', '@/db', '~/db', '/abs/db']) {
      expect(resolveReference(specifier, 'src/a.ts', scope(nodes)), specifier).toEqual({ kind: 'unresolved' });
    }
  });

  it('does not mistake a name that merely starts like an alias for one', () => {
    expect(resolveReference('@scope/x', 'src/a.ts', scope(nodes))).toEqual({ kind: 'external' });
    expect(resolveReference('tilde~/x', 'src/a.ts', scope(nodes))).toEqual({ kind: 'external' });
  });

  it('holds only JavaScript and TypeScript files', () => {
    for (const file of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx']) expect(isGraphFile(`src/${file}`)).toBe(true);
    for (const file of ['a.py', 'a.go', 'a.rs', 'a.cs', 'a.json', 'README']) expect(isGraphFile(`src/${file}`)).toBe(false);
  });
});

/* -------------------------------------------------------------------- graph */

describe('building the graph', () => {
  const nodes = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

  it('keeps one edge per pair, in path order, remembering the first reference in source order', () => {
    const graph = buildGraph(
      [{ file: 'src/a.ts', references: [ref('./c.js', 3), ref('./b.js', 5), ref('./b', 9)] }],
      scope(nodes),
      true,
    );

    expect(graph.successors.get('src/a.ts')).toEqual(['src/b.ts', 'src/c.ts']);
    expect(graph.via.get(edgeKey('src/a.ts', 'src/b.ts'))?.line).toBe(5);
    expect(graph.nodes).toEqual(nodes);
  });

  it('lists its nodes in path order whatever order the walk handed them over', () => {
    const graph = buildGraph([], scope(['src/c.ts', 'src/a.ts', 'src/b.ts']), true);
    expect(graph.nodes).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('leaves type-only references out when asked to', () => {
    const inputs = [{ file: 'src/a.ts', references: [ref('./b.js', 1, true)] }];

    expect(buildGraph(inputs, scope(nodes), true).successors.get('src/a.ts')).toEqual(['src/b.ts']);
    expect(buildGraph(inputs, scope(nodes), false).successors.has('src/a.ts')).toBe(false);
  });

  it('leaves dynamic imports out when asked to, and keeps an edge a static import also makes', () => {
    const dynamic: ModuleReference = { ...ref('./b.js', 2), kind: 'dynamic-import' };
    const inputs = [{ file: 'src/a.ts', references: [dynamic] }];

    expect(buildGraph(inputs, scope(nodes), true).successors.get('src/a.ts')).toEqual(['src/b.ts']);
    expect(buildGraph(inputs, scope(nodes), true, true).successors.get('src/a.ts')).toEqual(['src/b.ts']);
    expect(buildGraph(inputs, scope(nodes), true, false).successors.has('src/a.ts')).toBe(false);

    const both = buildGraph([{ file: 'src/a.ts', references: [dynamic, ref('./b.js', 5)] }], scope(nodes), true, false);
    expect(both.successors.get('src/a.ts')).toEqual(['src/b.ts']);
    expect(both.via.get(edgeKey('src/a.ts', 'src/b.ts'))?.line).toBe(5);
  });

  it('does not hold a dynamic import against the graph as unresolved when dynamic imports are ignored', () => {
    const gone: ModuleReference = { ...ref('./gone.js'), kind: 'dynamic-import' };
    expect(buildGraph([{ file: 'src/a.ts', references: [gone] }], scope(nodes), true, false).unresolved).toEqual([]);
    expect(buildGraph([{ file: 'src/a.ts', references: [gone] }], scope(nodes), true).unresolved).toHaveLength(1);
  });

  it('collects unresolved references and nothing else that failed to become an edge', () => {
    const graph = buildGraph(
      [{ file: 'src/a.ts', references: [ref('react'), ref('./gone.js', 4), ref('../outside.js'), ref('@/alias', 6)] }],
      scope(nodes),
      true,
    );

    expect(graph.unresolved.map(({ reference }) => reference.line)).toEqual([4, 6]);
    expect(graph.successors.size).toBe(0);
  });

  it('does not hold a type-only reference against the graph as unresolved when types are ignored', () => {
    const graph = buildGraph([{ file: 'src/a.ts', references: [ref('./gone.js', 1, true)] }], scope(nodes), false);
    expect(graph.unresolved).toEqual([]);
  });
});

/* ------------------------------------------------------------------- cycles */

describe("Tarjan's components", () => {
  const sorted = (components: string[][]): string[][] => components.map((c) => [...c].sort()).sort();

  it('finds every component, including the nodes in none', () => {
    const successors = graphOf({ a: ['b'], b: ['c'], c: ['a', 'd'], d: [] });
    expect(sorted(stronglyConnected(['a', 'b', 'c', 'd'], successors))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('treats a file missing from the map as importing nothing', () => {
    // Which is how `buildGraph` records every file with no imports, so this -
    // not `d: []` - is the shape a real graph has at its leaves.
    const successors = graphOf({ a: ['b'], b: ['a', 'd'] });
    expect(sorted(stronglyConnected(['a', 'b', 'd'], successors))).toEqual([['a', 'b'], ['d']]);
  });

  it('separates two cycles joined by a one-way edge', () => {
    const successors = graphOf({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c'] });
    expect(sorted(stronglyConnected(['a', 'b', 'c', 'd'], successors))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('finds a component reached from the middle of the node list', () => {
    // The low-link update from a child that was already finished is the line
    // the recursive textbook form hides in its return; here it is explicit.
    const successors = graphOf({ a: ['c'], b: ['a'], c: ['b', 'd'], d: ['e'], e: ['d'] });
    expect(sorted(stronglyConnected(['d', 'a', 'e', 'b', 'c'], successors))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('gives the same components whatever order the nodes arrive in', () => {
    const successors = graphOf({ a: ['b'], b: ['c', 'e'], c: ['a'], d: ['e'], e: ['f'], f: ['d'] });
    const expected = [['a', 'b', 'c'], ['d', 'e', 'f']];
    for (const order of [['a', 'b', 'c', 'd', 'e', 'f'], ['f', 'e', 'd', 'c', 'b', 'a'], ['c', 'f', 'a', 'd', 'b', 'e']]) {
      expect(sorted(stronglyConnected(order, successors)), order.join('')).toEqual(expected);
    }
  });

  it('survives a dependency chain long enough to overflow a recursive walk', () => {
    // The reason it is iterative. The textbook recursive visit, run on this
    // same chain, throws "Maximum call stack size exceeded" at 10,000 files and
    // is fine at 1,000 - so the ceiling is a monorepo, not a curiosity.
    const count = 200_000;
    const nodes = Array.from({ length: count }, (_, at) => `n${at}`);
    const successors = new Map(nodes.map((node, at) => [node, at + 1 < count ? [`n${at + 1}`] : [`n0`]]));

    const components = stronglyConnected(nodes, successors);

    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(count);
  });
});

describe('which components are cycles', () => {
  it('is every component of two or more, and a single file only when it imports itself', () => {
    const components = cyclicComponents({
      nodes: ['a', 'b', 'c', 'd', 'e'],
      successors: graphOf({ a: ['b'], b: ['a'], c: ['c'], d: ['e'] }),
    });

    // `e` imports nothing and so is not in the map; `d` imports something else.
    expect(components).toEqual([['a', 'b'], ['c']]);
  });

  it('orders members and components by path, so a report does not depend on walk order', () => {
    const components = cyclicComponents({
      nodes: ['z', 'y', 'm', 'b', 'a'],
      successors: graphOf({ z: ['y'], y: ['z'], b: ['m'], m: ['a'], a: ['b'] }),
    });

    expect(components).toEqual([['a', 'b', 'm'], ['y', 'z']]);
  });
});

describe('the loop a report shows', () => {
  it('is a file that imports itself, closed on itself', () => {
    expect(witness(['a'], graphOf({ a: ['a'] }))).toEqual(['a', 'a']);
  });

  it('starts and ends at the first file of the component', () => {
    expect(witness(['a', 'b', 'c'], graphOf({ a: ['b'], b: ['c'], c: ['a'] }))).toEqual(['a', 'b', 'c', 'a']);
  });

  it('is the shortest loop through that file when there are several', () => {
    // a -> b -> c -> a and a -> z -> a both close. The shorter one runs through
    // the file that sorts last, so neither path order nor a depth-first search
    // would find it, and the report names two imports rather than three.
    const successors = graphOf({ a: ['b', 'z'], b: ['c'], c: ['a'], z: ['a'] });
    expect(witness(['a', 'b', 'c', 'z'], successors)).toEqual(['a', 'z', 'a']);
  });

  it('never looks outside its component, because nothing there can lead back', () => {
    // A cost contract: the answer would be the same, and the time would not be.
    // On a large tree with many small cycles, a search that wandered out of each
    // one would walk most of the graph once per cycle.
    const reads: string[] = [];
    const successors = new (class extends Map<string, string[]> {
      override get(key: string): string[] | undefined {
        reads.push(key);
        return super.get(key);
      }
    })(Object.entries({ a: ['b', 'x'], b: ['a'], x: ['y'], y: ['z'], z: [] }));

    expect(witness(['a', 'b'], successors)).toEqual(['a', 'b', 'a']);
    expect(reads.filter((key) => !['a', 'b'].includes(key))).toEqual([]);
  });
});
