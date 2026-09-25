/**
 * `spec-guard prove`: can each rule actually fail? ADR-0016.
 *
 * A rule that cannot fail is a green light that proves nothing. A directory
 * renamed under a target, a `glob` that misses the extension the code is
 * written in, a module name nothing imports by that name: each leaves a rule
 * that passes today and would pass whatever the code did. A run cannot tell
 * that rule from one that holds, because both pass.
 *
 * So each rule in force is shown a violation of itself and has to fail. The
 * violation is made in memory - a file added, a line put at the top of one, a
 * file emptied or removed - through an overlay on the door every read goes
 * through, and the rule is executed over that tree exactly as a run executes
 * it. Nothing is written to disk and nothing touches git. A rule the violation
 * fails is `killed`; one that still passes `survived`, and the violation is
 * reported, because that is the finding; one no violation could be made for is
 * `unprovable`, with the reason.
 */

import path from 'node:path';

import { buildJsRegExp, createJavaScriptEngine, enumerateCandidates } from './engine.js';
import { createExcludeMatcher, createPathMatcher, moduleWitness } from './glob.js';
import { isGraphFile } from './graph.js';
import { ANALYSABLE_EXTENSIONS, createImportIndex, JS_EXTENSIONS } from './imports.js';
import { nodeIo, readText, type Io } from './io.js';
import { layerMatcher } from './layers.js';
import { overlayIo, readOnce, type TreeEdit } from './overlay.js';
import { governs, within } from './rules.js';
import { createScopeProbe, DEFAULT_MAX_SNIPPETS, elapsed, executeAssertion, planRun, type RunOptions } from './runner.js';
import { readSpecs, specPath } from './specs.js';
import { createTreeIndex, expandPartner } from './structure.js';
import type {
  Assertion,
  AssertionResult,
  ProveClaim,
  ProveProbe,
  ProveReport,
  ProveResult,
  SearchOptions,
  TreeChange,
} from './types.js';

export type ProveOptions = Pick<
  RunOptions,
  | 'patterns'
  | 'root'
  | 'allowMissingTargets'
  | 'strictTargets'
  | 'allowEmptyScope'
  | 'includeSpecs'
  | 'defaultSkips'
  | 'exclude'
  | 'ignoreStatus'
  | 'io'
>;

/** The name every file `prove` adds starts with, so a reader can tell which ones it made. */
export const PROVE_NAME = 'spec-guard-prove';

/** A violation to try: the edit that makes it, and how a report says what it did. */
interface Violation {
  violation: string;
  edit: TreeEdit;
}

/** What proving a rule needs, shared by every rule of the command. */
interface Context {
  root: string;
  /** The tree as it is, read once. */
  io: Io;
  options: ProveOptions;
}

/** Executes one assertion over a tree, sharing nothing with any other execution. */
function execute(assertion: Assertion, io: Io, context: Context): Promise<AssertionResult> {
  const { options, root } = context;
  return executeAssertion(assertion, {
    root,
    io,
    engine: createJavaScriptEngine(io),
    allowMissingTargets: options.allowMissingTargets ?? false,
    strictTargets: options.strictTargets ?? false,
    allowEmptyScope: options.allowEmptyScope ?? false,
    maxSnippets: DEFAULT_MAX_SNIPPETS,
    imports: createImportIndex(io),
    hasFiles: createScopeProbe(io),
    tree: createTreeIndex(root, io),
  });
}

const edit = (write: Map<string, string>, remove: Iterable<string> = []): TreeEdit => ({ write, remove: new Set(remove) });

/* ------------------------------------------------------------------ places */

/**
 * The files a violation goes beside, and whether the rule reads them.
 *
 * Beside the files the rule reads, when it reads any. When it reads none, the
 * files under its targets: the code it is pointed at. A violation there that
 * passes is exactly the finding a glob that misses the code's extension, or an
 * exclude that swallows its target, should produce - where a rule with nothing
 * in scope would otherwise be one nobody could show failing.
 */
interface Places {
  files: string[];
  read: boolean;
}

async function placesFor(
  assertion: Assertion,
  context: Context,
  accepts: (file: string) => boolean,
  suits: (places: Places) => boolean = () => true,
): Promise<Places | string> {
  const targets: string[] = [];
  for (const target of assertion.targets) {
    if ((await context.io.stat(path.resolve(context.root, target))) !== null) targets.push(target);
  }
  if (targets.length === 0) return `none of its targets exists (${assertion.targets.join(', ')})`;
  const search = assertion.search as SearchOptions;
  const list = async (options: SearchOptions): Promise<string[]> =>
    (await enumerateCandidates({ root: context.root, targets, options }, undefined, context.io)).files
      .map((file) => file.relativePath)
      .filter(accepts);
  const read = { files: await list(search), read: true };
  if (read.files.length > 0 && suits(read)) return read;
  const under = { files: await list({ ...search, globs: [], excludeGlobs: [] }), read: false };
  if (under.files.length > 0) return under;
  return `nothing under ${targets.join(', ')} is a file a violation could be put beside`;
}

/** `dir/spec-guard-prove.ext`, numbered from the second: where an added file goes. */
function provePath(directory: string, extension: string, index: number, suffix: string): string {
  const name = `${PROVE_NAME}${index === 0 ? '' : `-${index + 1}`}${suffix}${extension}`;
  return directory === '.' ? name : `${directory}/${name}`;
}

/**
 * Each extension the files have, with the directory of the first file that has
 * it: one kind of file a violation can be written as, and where it goes.
 */
function kinds(files: readonly string[]): Map<string, string> {
  const directories = new Map<string, string>();
  for (const file of files) {
    const extension = path.posix.extname(file);
    if (!directories.has(extension)) directories.set(extension, path.posix.dirname(file));
  }
  return directories;
}

/** Whether a rule's scope would reach a file at this path. */
function reaches(assertion: Assertion, relativePath: string, context: Context): boolean {
  return governs(assertion, { path: relativePath, shape: 'file', absolutePath: path.resolve(context.root, relativePath) });
}

/**
 * New files beside the ones in `places`, `count` of each kind they hold, for
 * each kind in turn. Beside files the rule reads, only paths it would read
 * too, since a violation a rule cannot see shows nothing about it; and never
 * a path one of those files already has.
 */
function besides(
  assertion: Assertion,
  places: Places,
  context: Context,
  count: number,
  contents: (file: string) => string,
  suffix: string,
): Array<Map<string, string>> {
  return [...kinds(places.files)].flatMap(([extension, directory]) => {
    const paths = Array.from({ length: count }, (_, index) => provePath(directory, extension, index, suffix));
    const usable = paths.every((file) => !places.files.includes(file) && (!places.read || reaches(assertion, file, context)));
    return usable ? [new Map(paths.map((file) => [file, contents(file)]))] : [];
  });
}

/** What a report adds to a violation made beside code the rule does not read. */
function unread(assertion: Assertion, places: Places): string {
  return places.read ? '' : `, beside the code under ${assertion.targets.join(', ')}, none of which the rule reads`;
}

/** How many more violations the rule's maximum takes to exceed. */
function excess(assertion: Assertion, now: AssertionResult): number {
  return (assertion.bounds.max as number) - now.actual + 1;
}

/* -------------------------------------------------------------------- text */

/**
 * Text a regular expression matches, or null.
 *
 * Built for what a rule is written with - literals, escapes, classes, groups,
 * alternatives, counted repetition - and held to the rule's own matcher before
 * it is used, so a wrong guess is never reported as a violation: it makes the
 * rule `unprovable`, with the reason. Lookaround and backreferences are not
 * guessed at.
 */
export function regexWitness(source: string): string | null {
  const ESCAPES: Readonly<Record<string, string>> = { d: '0', D: 'a', w: 'a', W: '-', s: ' ', S: 'a', b: '', B: '', n: '\n', t: '\t' };
  let at = 0;

  const alternation = (): string | null => {
    const options = [sequence()];
    while (source.charAt(at) === '|') {
      at += 1;
      options.push(sequence());
    }
    return options.find((option) => option !== null) ?? null;
  };

  const sequence = (): string | null => {
    let text: string | null = '';
    while (at < source.length && source.charAt(at) !== '|' && source.charAt(at) !== ')') {
      const piece = atom();
      const times = repetition();
      text = text === null || piece === null ? null : text + piece.repeat(times);
    }
    return text;
  };

  const repetition = (): number => {
    const counted = /^(?:([*?])|(\+)|\{(\d+)(?:,\d*)?\})\??/.exec(source.slice(at));
    if (counted === null) return 1;
    at += counted[0].length;
    return counted[3] !== undefined ? Number(counted[3]) : counted[2] !== undefined ? 1 : 0;
  };

  const atom = (): string | null => {
    const char = source.charAt(at);
    at += 1;
    if (char === '(') {
      const group = /^(?:\?(?::|<[A-Za-z_]\w*>|(<?[=!])))?/.exec(source.slice(at)) as RegExpExecArray;
      at += group[0].length;
      const inner = alternation();
      at += 1;
      return group[1] === undefined ? inner : null;
    }
    if (char === '[') {
      // Up to the first `]` that is not escaped, even straight after the `[`:
      // in JavaScript `[]` is a class that matches nothing.
      const body = (/^(?:\\.|[^\\\]])*/.exec(source.slice(at)) as RegExpExecArray)[0];
      at += body.length + 1;
      const member = new RegExp(`^[${body}]$`);
      return ['a', '0', ...body].find((candidate) => member.test(candidate)) ?? null;
    }
    if (char === '\\') {
      const next = source.charAt(at);
      at += 1;
      return /[1-9kpPcxu]/.test(next) ? null : (ESCAPES[next] ?? next);
    }
    if (char === '.') return 'a';
    return char === '^' || char === '$' ? '' : char;
  };

  const text = alternation();
  return at === source.length && text !== '' ? text : null;
}

/** The text a text rule forbids, or why none could be made. */
function forbidden(assertion: Assertion): { text: string } | { reason: string } {
  const symbol = assertion.symbol as string;
  const options = assertion.search as SearchOptions;
  const text = options.regex ? regexWitness(symbol) : symbol;
  if (text !== null && text.search(buildJsRegExp(symbol, options)) !== -1) return { text };
  return {
    reason: `no text could be made that the regular expression ${symbol} matches: prove writes text for literals, classes, groups, alternatives and counted repetition, not for lookaround or backreferences`,
  };
}

async function textViolations(assertion: Assertion, claim: ProveClaim, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  const symbol = assertion.symbol as string;
  if (claim === 'min') {
    // Every line holding a match goes, from every file that holds one, which
    // leaves none: fewer than any minimum a passing rule can have. A match that
    // spans lines survives that, and empties its file. Nothing is removed, since
    // a file the rule names as its target would then fail it for being missing.
    const matcher = buildJsRegExp(symbol, assertion.search as SearchOptions);
    const write = new Map<string, string>();
    const trimmed: string[] = [];
    const emptied: string[] = [];
    let taken = 0;
    for (const { file } of now.fileMatches) {
      const lines = (await readText(context.io, path.resolve(context.root, file))).split('\n');
      const kept = lines.filter((line) => line.search(matcher) === -1);
      const text = kept.join('\n');
      const spans = text.search(matcher) !== -1;
      write.set(file, spans ? '' : text);
      (spans ? emptied : trimmed).push(file);
      taken += spans ? 0 : lines.length - kept.length;
    }
    const parts = [
      ...(trimmed.length > 0 ? [`removed ${taken} line${taken === 1 ? '' : 's'} holding "${symbol}" from ${trimmed.join(', ')}`] : []),
      ...(emptied.length > 0 ? [`emptied ${emptied.join(', ')}, where a match spans lines`] : []),
    ];
    return [{ violation: parts.join(', and '), edit: edit(write) }];
  }
  const text = forbidden(assertion);
  if ('reason' in text) return text.reason;
  const places = await placesFor(assertion, context, () => true);
  if (typeof places === 'string') return places;
  const need = excess(assertion, now);
  const lines = Array.from({ length: need }, () => text.text).join('\n');
  const times = need === 1 ? '' : ` ${need} times`;
  const violations = besides(assertion, places, context, 1, () => lines, '').map((write) => ({
    violation: `added ${[...write.keys()][0]} holding "${text.text}"${times}${unread(assertion, places)}`,
    edit: edit(write),
  }));
  if (!places.read) return violations;
  // A rule whose glob names files rather than kinds reaches no new file, and
  // the text goes at the top of one it already reads: before anything a file
  // could open, so it is read as code.
  const first = places.files[0] as string;
  const source = await readText(context.io, path.resolve(context.root, first));
  return [...violations, { violation: `put "${text.text}"${times} at the top of ${first}`, edit: edit(new Map([[first, `${lines}\n${source}`]])) }];
}

/* ----------------------------------------------------------------- imports */

/** A line that depends on `module`, in the language of a file with this extension. */
export function importLine(extension: string, module: string): string {
  if (JS_EXTENSIONS.has(extension)) return `import '${module}';\n`;
  if (extension === '.py' || extension === '.pyi') return `import ${module.replaceAll('/', '.')}\n`;
  if (extension === '.go') return `package prove\n\nimport "${module}"\n`;
  if (extension === '.rs') return `use ${module.replaceAll('/', '::')};\n`;
  return `using ${module.replaceAll('/', '.')};\n`;
}

const analysable = (file: string): boolean => ANALYSABLE_EXTENSIONS.has(path.posix.extname(file));

async function importViolations(assertion: Assertion, claim: ProveClaim, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  if (claim === 'min') {
    // Emptied rather than removed: a file the rule names as its target would
    // otherwise fail it for being missing, which is not the claim.
    const files = now.fileMatches.map(({ file }) => file);
    const which = files.length === 1 ? 'the file' : 'the files';
    return [{ violation: `emptied ${files.join(', ')}, ${which} importing it`, edit: edit(new Map(files.map((file) => [file, '']))) }];
  }
  const modules = (assertion.imports as NonNullable<Assertion['imports']>).modules;
  const module = modules.map(moduleWitness).find((name) => name !== null);
  if (module === undefined) return `no module name matches ${modules.join(', ')}`;
  const places = await placesFor(assertion, context, analysable);
  if (typeof places === 'string') return places;
  const need = excess(assertion, now);
  const violations = besides(assertion, places, context, need, (file) => importLine(path.posix.extname(file), module), '').map((write) => ({
    violation: `added ${[...write.keys()].join(', ')} importing ${module}${unread(assertion, places)}`,
    edit: edit(write),
  }));
  // A rule whose exclude names files reaches no new one, and the import goes at
  // the top of the first file it reads. The unit is files, so that crosses a
  // maximum only when one more file is enough.
  if (!places.read || need > 1) return violations;
  const first = places.files[0] as string;
  const source = await readText(context.io, path.resolve(context.root, first));
  return [...violations, { violation: `made ${first} import ${module}`, edit: edit(new Map([[first, `${importLine(path.posix.extname(first), module)}${source}`]])) }];
}

async function cycleViolations(assertion: Assertion, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  const places = await placesFor(assertion, context, isGraphFile);
  if (typeof places === 'string') return places;
  const need = excess(assertion, now);
  // Extensionless, which the resolver reads as the path with each extension it knows.
  const specifier = (file: string): string => `./${path.posix.basename(file, path.posix.extname(file))}`;
  // `spec-guard-prove-a.ts` and `spec-guard-prove-b.ts`, beside each other.
  const partner = (first: string): string => {
    const extension = path.posix.extname(first);
    return `${first.slice(0, first.length - extension.length - 1)}b${extension}`;
  };
  const pairs = besides(assertion, places, context, need, (first) => `import '${specifier(partner(first))}';\n`, '-a');
  return pairs.map((firsts) => {
    const write = new Map<string, string>();
    for (const [first, text] of firsts) {
      write.set(first, text);
      write.set(partner(first), `import '${specifier(first)}';\n`);
    }
    return { violation: `added ${[...write.keys()].join(' and ')}, which import each other${unread(assertion, places)}`, edit: edit(write) };
  });
}

async function layerViolations(assertion: Assertion, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  const order = assertion.layers as string[];
  const layersOf = layerMatcher(order);
  // A file in a layer another is listed after. No file of a rule that passes is
  // claimed by two layers: the rule fails on it.
  const below = (file: string): boolean => layersOf(file).some((layer) => layer < order.length - 1);
  const places = await placesFor(assertion, context, analysable, (read) => read.files.some(below));
  if (typeof places === 'string') return places;
  const lower = places.files.find(below);
  if (lower === undefined) return 'no file under its targets belongs to exactly one layer that another layer is listed after';
  const layer = layersOf(lower)[0] as number;
  const upper = moduleWitness(order[layer + 1] as string);
  if (upper === null) return `no module name matches the layer ${order[layer + 1]}`;
  const need = excess(assertion, now);
  const line = importLine(path.posix.extname(lower), upper);
  const from = `from the layer ${order[layer + 1]} above it`;
  // The new files sit beside the lower file, so they share its layer unless
  // the layers are the files themselves, and then they are in none.
  const violations = besides(assertion, { files: [lower], read: places.read }, context, need, () => line, '')
    .filter((write) => layersOf(write.keys().next().value as string).join() === String(layer))
    .map((write) => ({
      violation: `added ${[...write.keys()].join(', ')} in the layer ${order[layer]}, importing ${upper} ${from}${unread(assertion, places)}`,
      edit: edit(write),
    }));
  // One file made to import across is one violating file, as above.
  if (!places.read || need > 1) return violations;
  const source = await readText(context.io, path.resolve(context.root, lower));
  return [...violations, { violation: `made ${lower}, in the layer ${order[layer]}, import ${upper} ${from}`, edit: edit(new Map([[lower, `${line}${source}`]])) }];
}

/* --------------------------------------------------------------- structure */

async function structureViolations(assertion: Assertion, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  const structure = assertion.structure as NonNullable<Assertion['structure']>;
  const need = excess(assertion, now);

  if (structure.claim === 'required') {
    // The first entry, out of the first directories the rule selects.
    const directories = await selected(assertion, context);
    if (directories.length === 0) return 'it selects no directory, so there is no entry to take away';
    const [entry] = structure.values as [string];
    const named = createPathMatcher(path.posix.basename(entry));
    const remove: string[] = [];
    for (const directory of directories.slice(0, need)) {
      const holder = path.posix.join(directory, path.posix.dirname(entry));
      const listing = await context.io.readDirectory(path.resolve(context.root, holder));
      remove.push(...listing.filter((item) => named(item.name)).map((item) => path.posix.join(holder, item.name)).sort());
    }
    return [{ violation: `removed ${remove.join(', ')}, which ${entry} names`, edit: edit(new Map(), remove) }];
  }

  const places = await placesFor(assertion, context, () => true);
  if (typeof places === 'string') return places;
  if (structure.claim === 'partner' && places.read) {
    // Every partner of the first files the rule reads, taken away.
    const remove: string[] = [];
    const orphans = places.files.slice(0, need);
    for (const file of orphans) {
      const target = assertion.targets.find((candidate) => within(file, candidate)) as string;
      for (const template of structure.values) {
        const partner = expandPartner(template, file, target);
        if ((await context.io.stat(path.resolve(context.root, partner)))?.isFile()) remove.push(partner);
      }
    }
    return [{ violation: `removed ${remove.join(', ')}, the partner of ${orphans.join(', ')}`, edit: edit(new Map(), remove) }];
  }
  // A file no pattern names, or one with no partner, beside the files the rule reads.
  const says = structure.claim === 'pattern' ? `named by none of ${structure.values.join(', ')}` : 'with no partner';
  return besides(assertion, places, context, need, () => '', '').map((write) => ({
    violation: `added ${[...write.keys()].join(', ')}, ${says}${unread(assertion, places)}`,
    edit: edit(write),
  }));
}

/** The directories a required-entries rule holds to its entries, in walk order. */
async function selected(assertion: Assertion, context: Context): Promise<string[]> {
  const structure = assertion.structure as NonNullable<Assertion['structure']>;
  const search = assertion.search as SearchOptions;
  const excluded = createExcludeMatcher(search.excludeGlobs);
  const tree = createTreeIndex(context.root, context.io);
  const directories: string[] = [];
  for (const target of assertion.targets) {
    if (!(await context.io.stat(path.resolve(context.root, target)))?.isDirectory()) continue;
    if (structure.dirs === undefined) {
      if (!excluded(target)) directories.push(target);
      continue;
    }
    const selects = createPathMatcher(structure.dirs);
    const walked = await tree.walk(target, search.scope);
    directories.push(...walked.directories.filter((directory) => !excluded(directory) && selects(path.posix.relative(target, directory))));
  }
  return directories;
}

/* ------------------------------------------------------------------- rules */

/** The claims of a rule a violation can cross: its maximum, and a minimum above zero. */
function claimsOf(assertion: Assertion): ProveClaim[] {
  if (assertion.kind === 'assert-present') return ['present'];
  const claims: ProveClaim[] = [];
  if (assertion.bounds.max !== undefined) claims.push('max');
  if ((assertion.bounds.min ?? 0) > 0) claims.push('min');
  return claims;
}

function violationsFor(assertion: Assertion, claim: ProveClaim, now: AssertionResult, context: Context): Promise<Violation[] | string> {
  switch (assertion.kind) {
    case 'assert-present': {
      const [file] = assertion.files as [string];
      return Promise.resolve([{ violation: `removed ${file}`, edit: edit(new Map(), [file]) }]);
    }
    case 'assert-import-absence':
    case 'assert-import-count':
      return importViolations(assertion, claim, now, context);
    case 'assert-import-cycle':
      return cycleViolations(assertion, now, context);
    case 'assert-layers':
      return layerViolations(assertion, now, context);
    case 'assert-structure':
      return structureViolations(assertion, now, context);
    default:
      return textViolations(assertion, claim, now, context);
  }
}

/** Each change an edit made, named against the tree as it is. */
async function changesOf(change: TreeEdit, context: Context): Promise<TreeChange[]> {
  const changes: TreeChange[] = [];
  for (const [file, text] of change.write) {
    const exists = (await context.io.stat(path.resolve(context.root, file))) !== null;
    changes.push({ path: file, change: exists ? 'replaced' : 'added', bytes: Buffer.byteLength(text) });
  }
  for (const file of change.remove) changes.push({ path: file, change: 'removed' });
  return changes;
}

/**
 * Tries each violation made for a claim until one fails the rule on it.
 *
 * The first that does is the probe. When none does, the first is: it is the
 * most direct violation of the claim, and the one a reader should look at.
 */
async function probe(assertion: Assertion, claim: ProveClaim, now: AssertionResult, context: Context): Promise<ProveProbe | string> {
  const violations = await violationsFor(assertion, claim, now, context);
  if (typeof violations === 'string') return violations;
  if (violations.length === 0) return 'every place a violation could go is one the rule does not read, or holds a file already';
  let first: ProveProbe | undefined;
  for (const { violation, edit: change } of violations) {
    const result = await execute(assertion, overlayIo(context.io, context.root, change), context);
    const tried: ProveProbe = {
      claim,
      outcome: result.ok ? 'survived' : 'killed',
      violation,
      changes: await changesOf(change, context),
      message: result.message,
      actual: result.actual,
    };
    if (tried.outcome === 'killed') return tried;
    first ??= tried;
  }
  return first as ProveProbe;
}

async function proveAssertion(assertion: Assertion, context: Context): Promise<ProveResult> {
  const startedAt = performance.now();
  const base = { kind: assertion.kind, location: assertion.location, description: assertion.description, reason: assertion.reason };
  const now = await execute(assertion, context.io, context);
  if (!now.ok) {
    return {
      ...base,
      outcome: 'unprovable',
      unprovable: `it fails on the tree as it stands (${now.message}), so no change can be shown to be what fails it`,
      probes: [],
      durationMs: elapsed(startedAt),
    };
  }
  // Only a maximum can be a claim no violation is made for: a minimum a passing
  // rule holds has matches to take away, and a presence rule a file to remove.
  const probes: ProveProbe[] = [];
  let unprovable: string | undefined;
  for (const claim of claimsOf(assertion)) {
    const found = await probe(assertion, claim, now, context);
    if (typeof found === 'string') unprovable = found;
    else probes.push(found);
  }
  const outcome = probes.some((found) => found.outcome === 'survived') ? 'survived' : unprovable === undefined ? 'killed' : 'unprovable';
  return {
    ...base,
    outcome,
    ...(unprovable === undefined ? {} : { unprovable }),
    probes,
    durationMs: elapsed(startedAt),
  };
}

/**
 * Shows each rule in force a violation of itself, in memory, and reports which
 * ones failed.
 *
 * Reads through `options.io` as a run does, and through the filesystem when it
 * is given none, and writes nothing. Rules are proved one at a time, each over
 * its own tree, in the order the specs state them, so the report is the same
 * every time the tree is.
 */
export async function proveSpecGuard(options: ProveOptions): Promise<ProveReport> {
  const startedAt = performance.now();
  const root = path.resolve(options.root ?? process.cwd());
  const io = readOnce(options.io ?? nodeIo);
  const plan = planRun(await readSpecs(options.patterns, root, io), root, options);
  const context: Context = { root, io, options };

  const results: ProveResult[] = [];
  for (const assertion of plan.assertions) results.push(await proveAssertion(assertion, context));

  const count = (outcome: ProveResult['outcome']): number => results.filter((result) => result.outcome === outcome).length;
  return {
    ok: count('survived') === 0 && plan.errors.length === 0,
    root,
    durationMs: elapsed(startedAt),
    summary: {
      specs: plan.specFiles.length,
      total: results.length,
      killed: count('killed'),
      survived: count('survived'),
      unprovable: count('unprovable'),
      inactive: plan.withheld,
    },
    results,
    errors: plan.errors,
    inactiveSpecs: plan.inactiveSpecs,
    exclude: plan.exclude,
    specFiles: plan.specFiles.map((file) => specPath(root, file)),
  };
}
