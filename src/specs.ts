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
import { NO_MEMO, type Memo } from './memo.js';
import { parseDocument } from './parser.js';
import type { Directive, DirectiveError, SpecStatus } from './types.js';

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
  const documents: SpecDocument[] = [];
  const errors: DirectiveError[] = [];

  // Read in batches the size of the engine's read limit, then handled in file
  // order. One read at a time took 0.9s over 1,200 specs, and an unbounded
  // Promise.all over that many files is an EMFILE on a system with the usual
  // limit of 1,024 open descriptors. Batches rather than a pool of readers
  // sharing a cursor, because a cursor that is advanced wrongly still reads
  // every file - which is a defect no test can see.
  const sources: Array<Buffer | Error> = [];
  while (sources.length < files.length) {
    const batch = files.slice(sources.length, sources.length + MAX_CONCURRENT_READS);
    sources.push(...(await Promise.all(batch.map((file) => io.readFile(file).catch((error: unknown) => error as Error)))));
  }

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
    documents.push({
      file,
      relativeFile,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      inForce: parsed.status?.active ?? true,
      directives: parsed.directives,
    });
  });

  return { files, documents, errors };
}
