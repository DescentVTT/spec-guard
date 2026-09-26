/**
 * Reading the spec documents: which files, what they declare, whether they are
 * in force.
 *
 * One function, used by every consumer of a spec - the run, the query and the
 * MCP server. It used to be the first half of `runSpecGuard`, and the second
 * consumer of it would otherwise have been a copy. A copy of the status rule is
 * a second opinion on which documents are in force, and ADR-0010's whole
 * argument is that withholding a rule must never happen by accident.
 */

import path from 'node:path';

import { MAX_CONCURRENT_READS } from './engine.js';
import { expandSpecPatterns, toPosix } from './glob.js';
import { nodeIo, type Io } from './io.js';
import { createMemo, NO_MEMO, type Memo } from './memo.js';
import { parseDocument } from './parser.js';
import type { Directive, DirectiveError, MaskedDirective, SpecStatus, SpecWarning } from './types.js';

/** One spec document, as read. */
export interface SpecDocument {
  /** Absolute path. */
  file: string;
  /** Path relative to the root, forward slashes. */
  relativeFile: string;
  /** Its first level-one heading, when it has one. */
  title?: string;
  /** The lifecycle status it declares, when it declares one. */
  status?: SpecStatus;
  /**
   * Whether the document is in force by its own account: it declares no status,
   * or a status that does not withhold it. `--ignore-status` is the caller's
   * business and is deliberately not folded in here - a query that lists a
   * draft's rules still has to say the draft is a draft.
   */
  inForce: boolean;
  /** Syntactically valid directives, in source order. */
  directives: Directive[];
}

export interface SpecSet {
  /** Every file the patterns matched, absolute, sorted. */
  files: string[];
  /** The documents that could be read, in file order. */
  documents: SpecDocument[];
  /** Unreadable files and malformed directives. Resolution errors are not here. */
  errors: DirectiveError[];
  /** What changed how a document was read, in file order: see `SpecWarning`. */
  warnings: SpecWarning[];
  /** Directive-shaped comments in text no directive is read from, in file order. */
  masked: MaskedDirective[];
}

/** The root-relative display path of a spec file. */
export function specPath(root: string, file: string): string {
  // A spec outside the root keeps its absolute path rather than becoming an
  // empty string, which is what `path.relative` makes of the root itself.
  return toPosix(path.relative(root, file)) || toPosix(file);
}

/** Expands the patterns and reads every document they match. */
export async function readSpecs(patterns: readonly string[], root: string, io: Io = nodeIo, memo: Memo = NO_MEMO): Promise<SpecSet> {
  const files = await expandSpecPatterns(patterns, root, undefined, io);
  return parseSpecs(root, files, await readSources(files, io), memo);
}

/**
 * Parsed spec documents, kept from one read of the specs to the next.
 *
 * For a process that reads the specs again for every request - the MCP server
 * - where parsing them is most of what a request costs (ADR-0012's amendment
 * of 2026-09-27). Every file is still found and read on every request, so an
 * edit is seen by the next one; only a document whose bytes are the ones it
 * was parsed from is not parsed again. It is the watch session's memo
 * (ADR-0014), keyed as a spec is there: by the SHA-256 of the bytes and both
 * paths, which the directives' locations carry. It cannot serve a stale rule,
 * because nothing is kept under bytes a file no longer has.
 *
 * A one-shot run gains nothing from it and passes none: `readSpecs` then
 * parses every document and hashes none.
 */
export interface DocumentMemo {
  /** `readSpecs`, with every document parsed before from the same bytes and paths served from memory. */
  read(patterns: readonly string[], root: string, io?: Io): Promise<SpecSet>;
  /** Documents held: the readable ones of the spec set read last. */
  readonly size: number;
}

export function createDocumentMemo(): DocumentMemo {
  const memo = createMemo();
  return {
    async read(patterns, root, io = nodeIo) {
      const files = await expandSpecPatterns(patterns, root, undefined, io);
      const specs = parseSpecs(root, files, await readSources(files, io), memo);
      // What bounds it. A sweep drops every entry this read did not ask for, so
      // what is held afterwards is one parse of each document the current spec
      // set names: a document that left the set, or whose bytes changed, is
      // gone with the read that did not ask for it. The sweep follows the
      // parse with no await between them, so a request the server answers
      // concurrently cannot sweep away entries another has just asked for.
      memo.sweep();
      return specs;
    },
    get size() {
      return memo.size;
    },
  };
}

/**
 * Every file's bytes, or why it could not be read, in file order.
 *
 * Read in batches the size of the engine's read limit. One read at a time
 * took 0.9s over 1,200 specs, and an unbounded Promise.all over that many
 * files is an EMFILE on a system with the usual limit of 1,024 open
 * descriptors. Batches rather than a pool of readers sharing a cursor, because
 * a cursor that is advanced wrongly still reads every file - which is a defect
 * no test can see.
 */
async function readSources(files: readonly string[], io: Io): Promise<Array<Buffer | Error>> {
  const sources: Array<Buffer | Error> = [];
  while (sources.length < files.length) {
    const batch = files.slice(sources.length, sources.length + MAX_CONCURRENT_READS);
    sources.push(...(await Promise.all(batch.map((file) => io.readFile(file).catch((error: unknown) => error as Error)))));
  }
  return sources;
}

/** What each document declares, in file order, parsed through `memo`. */
function parseSpecs(root: string, files: string[], sources: ReadonlyArray<Buffer | Error>, memo: Memo): SpecSet {
  const documents: SpecDocument[] = [];
  const errors: DirectiveError[] = [];
  const warnings: SpecWarning[] = [];
  const masked: MaskedDirective[] = [];

  files.forEach((file, index) => {
    const relativeFile = specPath(root, file);
    const source = sources[index] as Buffer | Error;
    if (source instanceof Error) {
      errors.push({
        location: { file, relativeFile, line: 1, column: 1 },
        raw: '',
        message: `Unable to read spec file: ${source.message}`,
      });
      return;
    }

    const parsed = memo.remember(source, [file, relativeFile], () => parseDocument(source.toString('utf8'), { file, relativeFile }));
    errors.push(...parsed.errors);
    warnings.push(...(parsed.warnings ?? []));
    masked.push(...(parsed.masked ?? []));
    documents.push({
      file,
      relativeFile,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      inForce: parsed.status?.active ?? true,
      directives: parsed.directives,
    });
  });

  return { files, documents, errors, warnings, masked };
}
