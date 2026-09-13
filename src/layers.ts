/**
 * The layering rule behind `@assert-layers`.
 *
 * Pure, and built on almost nothing new. A layer is a pattern in the language
 * `module=` and `exclude` already speak; a file belongs to a layer when its path
 * matches, and a reference points into one when any name it can denote does -
 * see `referenceForms`. That is why layering needs no resolver and works in
 * every language spec-guard reads: it never asks which file a reference *is*,
 * only which areas it could be about.
 *
 * Cycles are the opposite case, and live in `graph.ts` - see ADR-0011.
 */

import { createExcludeMatcher } from './glob.js';
import { candidates, isGraphFile } from './graph.js';
import { resolveModule, type ModuleReference } from './imports.js';
import { languageFor } from './polyglot.js';

/**
 * Every name a reference can be matched under.
 *
 * The specifier as written and the module it resolves to, as `module=` tries -
 * and, for the two languages whose modules are files, the files that module can
 * denote. Without the last, a layer that names a file could never be reached:
 * `src/runner.ts` is where the file is, `./runner.js` is what imports it, and
 * the first rule this project wrote with file-sized layers passed while its
 * order was reversed, because no reference matched any layer at all.
 *
 * Names only. Nothing here asks whether a candidate exists, which is why a layer
 * outside the assertion's target still works: `../infrastructure/db.js` reaches
 * `src/infrastructure/db.ts` whether or not the walk ever went there.
 */
export function referenceForms(specifier: string, importingFile: string): string[] {
  const module = resolveModule(specifier, importingFile);
  if (isGraphFile(importingFile)) return [specifier, ...candidates(module)];
  if (languageFor(importingFile) === 'python') return [specifier, module, `${module}.py`, `${module}/__init__.py`];
  return [specifier, module];
}

export interface LayerInput {
  /** Root-relative path of the importing file. */
  file: string;
  references: readonly ModuleReference[];
}

export interface LayerViolation {
  file: string;
  /** The layer the file belongs to, as an index into the order. */
  from: number;
  /** The latest layer its reference reaches, also an index. */
  to: number;
  /** The first reference, in source order, that reaches a later layer. */
  reference: ModuleReference;
}

export interface LayerReport {
  /** Files in scope matched by each layer, by index. */
  members: number[];
  /** Files in scope that no layer matches, and which are therefore unconstrained. */
  unassigned: string[];
  /** Files matched by more than one layer, with every layer that matched. */
  ambiguous: Array<{ file: string; layers: number[] }>;
  /** At most one per file. */
  violations: LayerViolation[];
}

/** A function from a path to the indices of every layer that matches it. */
export function layerMatcher(order: readonly string[]): (relativePath: string) => number[] {
  const matchers = order.map((pattern) => createExcludeMatcher([pattern]));
  return (relativePath) =>
    matchers.flatMap((matches, layer) => (matches(relativePath) ? [layer] : []));
}

/**
 * Checks each file's references against the order.
 *
 * A file may import from its own layer and from layers listed before it. The
 * unit of violation is the file, as it is for every import assertion: one
 * import statement split into two is not twice the problem.
 *
 * A file two layers claim is not checked for violations - which layer's rule
 * applies is exactly the thing that is unknown - and is reported instead. So is
 * every file no layer claims, because a shared utility and a directory someone
 * forgot to assign look identical from here and only the author can say which a
 * count describes.
 */
export function checkLayers(inputs: readonly LayerInput[], order: readonly string[], includeTypes: boolean): LayerReport {
  const layersOf = layerMatcher(order);
  // Every file in a directory imports the same few modules, and each reference
  // is matched under some twenty names, so the same name is matched against the
  // same patterns thousands of times on a large tree. The answer depends on the
  // name alone. Measured on 6,977 files of node_modules: see ADR-0011.
  const seen = new Map<string, readonly number[]>();
  const reachedBy = (name: string): readonly number[] => {
    let layers = seen.get(name);
    if (layers === undefined) {
      layers = layersOf(name);
      seen.set(name, layers);
    }
    return layers;
  };
  const members = order.map(() => 0);
  const unassigned: string[] = [];
  const ambiguous: LayerReport['ambiguous'] = [];
  const violations: LayerViolation[] = [];

  for (const { file, references } of inputs) {
    const own = layersOf(file);
    for (const layer of own) members[layer] = (members[layer] as number) + 1;
    if (own.length === 0) {
      unassigned.push(file);
      continue;
    }
    if (own.length > 1) {
      ambiguous.push({ file, layers: own });
      continue;
    }

    const from = own[0] as number;
    for (const reference of references) {
      if (reference.typeOnly && !includeTypes) continue;
      const reached = referenceForms(reference.specifier, file).flatMap(reachedBy);
      const to = Math.max(from, ...reached);
      if (to > from) {
        violations.push({ file, from, to, reference });
        break;
      }
    }
  }

  return { members, unassigned, ambiguous, violations };
}
