/**
 * `spec-guard cites`: the specs a codebase's comments cite, and whether each is
 * still there and still in force. ADR-0017.
 *
 * A comment such as `// ADR-0011: the domain imports no infrastructure` is a
 * claim about the codebase: that a decision exists, and governs this code.
 * When the document is gone, or superseded, the comment sends the next reader
 * to a decision that is not the one in force, and nothing notices - spec-graph
 * reads only Markdown, and a run only the directives. This reads the other
 * side: comment text, as ADR-0006's classifier finds it, for ids a project
 * names.
 *
 * An id is found by a small scanner, never by a regular expression built from
 * the template a project wrote: its literal text, a run of digits, and a word
 * boundary on each side. The digits are a number, so `ADR-7`, `ADR-007` and a
 * file called `0007-x.md` are one document.
 */

import path from 'node:path';

import { lexRanges, syntaxFor } from './comments.js';
import { comparePaths, MAX_CONCURRENT_READS, withinSizeLimit } from './engine.js';
import { createExcludeMatcher, createPathMatcher, globBase, isGlob, pathPatternError, toPosix, walkPaths } from './glob.js';
import { nodeIo, type Io } from './io.js';
import { INACTIVE_STATUSES, parseStatus, parseTitle } from './parser.js';
import { createScope, isBinary } from './scope.js';
import { readSpecs } from './specs.js';
import { lineStarts, locate } from './text.js';
import type { CiteFamily, CiteFamilyReport, CiteFinding, CiteGap, CitesReport, SpecStatus } from './types.js';

/* ---------------------------------------------------------------- templates */

/** Where the number goes, in an id template and in a file name. */
export const NUMBER = '{n}';

/** An id template, read: the text before the number, and the text after it. */
export interface IdTemplate {
  prefix: string;
  suffix: string;
}

const DIGIT = /^[0-9]$/;
// A letter or digit in any script, or an underscore: what a word boundary
// separates. Fixed here, and never built from anything a project wrote.
const WORD = /^[\p{L}\p{N}_]$/u;

// Both are asked about the character past either end of a text too, which is
// undefined: a pattern of one character never matches the word "undefined"
// that `test` makes of it, so there is no end of the text to test for first.
function isDigit(char: string | undefined): boolean {
  return DIGIT.test(char as string);
}

function isWord(char: string | undefined): boolean {
  return WORD.test(char as string);
}

/** How many times `{n}` occurs in a template. */
function numbers(template: string): number {
  return template.split(NUMBER).length - 1;
}

/**
 * Why an id template cannot be used, or null.
 *
 * The text around `{n}` is literal, and it has to be there: `{n}` alone would
 * make every number in every comment a citation. It may not be a digit where
 * it meets the number, or the two would run together - `A1{n}` would never
 * know where `A1` ended.
 */
export function citeIdError(template: string): string | null {
  const count = numbers(template);
  if (count !== 1) {
    return count === 0
      ? `"${template}" has no ${NUMBER}: an id template says where the number goes, as in ADR-${NUMBER}`
      : `"${template}" has ${NUMBER} more than once, and an id holds one number`;
  }
  const [prefix, suffix] = template.split(NUMBER) as [string, string];
  if (/[{}]/.test(prefix + suffix)) return `"${template}" holds a brace other than ${NUMBER}, and the rest of an id is literal`;
  if (prefix.trim() === '') return `"${template}" has nothing before ${NUMBER}, so every number in every comment would be a citation`;
  if (isDigit(prefix[prefix.length - 1]) || isDigit(suffix[0])) {
    return `"${template}" has a digit beside ${NUMBER}, where it would run into the number`;
  }
  return null;
}

/** An id template, read. Only ever given one `citeIdError` accepted. */
export function parseIdTemplate(template: string): IdTemplate {
  const [prefix, suffix] = template.split(NUMBER) as [string, string];
  return { prefix, suffix };
}

/** A files template, read: the glob that finds the documents, and the name around the number. */
export interface FilesTemplate {
  /** The template with `{n}` read as `*`: every path that could be a document. */
  glob: string;
  /** The file name before the number, which is literal. */
  before: string;
  /** The file name after the number, a glob of one segment, or empty. */
  after: string;
}

/**
 * Why a files template cannot be used, or null.
 *
 * The number is read from a document's file name, so `{n}` has to be in the
 * last segment, and what comes before it there has to be literal: that is
 * what says where in `0007-ledger.md` or `rfc-12.md` the number starts.
 */
export function citeFilesError(template: string): string | null {
  const count = numbers(template);
  if (count !== 1) {
    return count === 0
      ? `"${template}" has no ${NUMBER}: a files template says where the number is, as in docs/adr/${NUMBER}-*.md`
      : `"${template}" has ${NUMBER} more than once, and a file name holds one number`;
  }
  const posix = toPosix(template);
  const name = posix.slice(posix.lastIndexOf('/') + 1);
  if (!name.includes(NUMBER)) return `"${template}" has ${NUMBER} in a directory, and the number is read from the file name`;
  const [before, after] = name.split(NUMBER) as [string, string];
  if (isGlob(before)) return `"${template}" has glob syntax before ${NUMBER} in the file name, which has to be literal to say where the number starts`;
  if (isDigit(before[before.length - 1]) || isDigit(after[0])) {
    return `"${template}" has a digit beside ${NUMBER}, where it would run into the number`;
  }
  const error = pathPatternError(posix.replace(NUMBER, '*'));
  return error === null ? null : `"${template}": ${error}`;
}

/** A files template, read. Only ever given one `citeFilesError` accepted. */
export function parseFilesTemplate(template: string): FilesTemplate {
  const posix = toPosix(template);
  const name = posix.slice(posix.lastIndexOf('/') + 1);
  const [before, after] = name.split(NUMBER) as [string, string];
  return { glob: posix.replace(NUMBER, '*'), before, after };
}

/** A number as a comparable key: its digits without leading zeros, and `0` for none. */
export function numberKey(digits: string): string {
  return digits.replace(/^0+(?=.)/, '');
}

/**
 * The number a document's path gives it under a files template - its digits
 * as the file name spells them - or null when the path is not one of the
 * template's documents.
 *
 * The whole path is matched against the glob, and then the file name is read:
 * the literal text before the number, a run of digits as long as it goes, and
 * a rest that the text after the number must match exactly. So `{n}-*.md`
 * reads `0007` from `0007-x.md`, and nothing from `0007x.md` or `x-0007.md`.
 */
export function documentNumber(template: string): (relativePath: string) => string | null {
  const { glob, before, after } = parseFilesTemplate(template);
  const matches = createPathMatcher(glob);
  const rest = after === '' ? (text: string) => text === '' : createPathMatcher(after);
  return (relativePath) => {
    if (!matches(relativePath)) return null;
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    if (!name.startsWith(before)) return null;
    let end = before.length;
    while (isDigit(name[end])) end += 1;
    const digits = name.slice(before.length, end);
    return digits !== '' && rest(name.slice(end)) ? digits : null;
  };
}

/* ------------------------------------------------------------------ scanner */

/** One id found in text: which template, where, the number, and how it was written. */
export interface Citation {
  /** Index of the template in the list the scanner was given. */
  family: number;
  /** Offset of the id's first character. */
  start: number;
  end: number;
  /** The number, as `numberKey` writes it. */
  number: string;
  /** The id as written. */
  written: string;
}

/**
 * Every id in a text, in order of position; the ids of one template before
 * another's where two begin at one place.
 *
 * For each template: its literal prefix, then a run of digits, then its
 * suffix, with no letter, digit or underscore running into either end - so
 * `XADR-1` and `ADR-12a` are not `ADR-{n}` citations, and `ADR-12.` is. The
 * whole text is read, once per template; which ids lie in a comment is
 * `inComments`'s question.
 */
export function scanCitations(text: string, templates: readonly IdTemplate[]): Citation[] {
  const found: Citation[] = [];
  templates.forEach(({ prefix, suffix }, family) => {
    const needsBoundaryBefore = isWord(prefix[0]);
    for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
      if (needsBoundaryBefore && isWord(text[at - 1])) continue;
      const digitsStart = at + prefix.length;
      let digitsEnd = digitsStart;
      while (isDigit(text[digitsEnd])) digitsEnd += 1;
      if (digitsEnd === digitsStart || !text.startsWith(suffix, digitsEnd)) continue;
      const end = digitsEnd + suffix.length;
      if (isWord(text[end - 1]) && isWord(text[end])) continue;
      found.push({ family, start: at, end, number: numberKey(text.slice(digitsStart, digitsEnd)), written: text.slice(at, end) });
    }
  });
  // Stable, so ids at one place keep the order of their templates.
  return found.sort((a, b) => a.start - b.start);
}

/** Words whose `'s` is `is` or `us` rather than a possessive: `it's ADR-7` is this project's. */
const CONTRACTED: ReadonlySet<string> = new Set(['it', 'that', 'this', 'there', 'here', 'what', 'who', 'where', 'how', 'when', 'why', 'he', 'she', 'let']);

/** The characters a name before an id is made of: a project's, a package's, a repository's. */
const NAME = /^[\p{L}\p{N}_\-/'’]$/u;

/**
 * Whether an id is qualified by another owner, and so names that owner's
 * document rather than one of this project's.
 *
 * `spec-core's ADR-0005`, `spec-graph ADR-0017`, `its ADR-0012` and
 * `org/repo ADR-9` each cite a document in another repository, which only has
 * the same number as one here by coincidence: read as this project's, it is a
 * ghost when the number is not used here, and quietly the wrong document when
 * it is. So the word just before an id - past one run of spaces - is read,
 * and the id is another owner's when that word is a possessive (`'s`, `its`,
 * `their`) or a name with a `-` or `/` inside it. `see ADR-7`, `per ADR-7`,
 * `(ADR-7)`, `e.g. ADR-7` and `it's ADR-7` are this project's. What that
 * costs is a hyphenated word used as an ordinary one, `re-read ADR-7`, which
 * is read as a qualifier and not checked: a citation missed, rather than one
 * reported that is not wrong.
 */
export function qualified(text: string, start: number): boolean {
  // Neither loop needs to stop at the start of the text: before it is
  // undefined, which is no space and no character of a name.
  let end = start;
  while (text[end - 1] === ' ' || text[end - 1] === '\t') end -= 1;
  if (end === start) return false;
  let begin = end;
  while (NAME.test(text[begin - 1] as string)) begin -= 1;
  const word = text.slice(begin, end);
  if (/^(?:its|their)$/i.test(word)) return true;
  const possessive = /^(.*\p{L})['’]s$/u.exec(word);
  if (possessive !== null && !CONTRACTED.has((possessive[1] as string).toLowerCase())) return true;
  return /\p{L}[-/]\p{L}/u.test(word);
}

/**
 * The citations that lie wholly inside a comment. Both lists are in order of
 * position, so one walk through each answers every question: the file is
 * searched once for each template, rather than once per comment - which on a
 * file of many comments and no citations would search to its end each time.
 */
export function inComments(citations: readonly Citation[], comments: ReadonlyArray<readonly [number, number]>): Citation[] {
  const kept: Citation[] = [];
  let index = 0;
  for (const citation of citations) {
    while (index < comments.length && (comments[index] as readonly [number, number])[1] <= citation.start) index += 1;
    const comment = comments[index];
    if (comment !== undefined && comment[0] <= citation.start && citation.end <= comment[1]) kept.push(citation);
  }
  return kept;
}

/* ---------------------------------------------------------------- documents */

/**
 * Words that retire a document for anyone citing it.
 *
 * ADR-0010's closed list, less the two that mean "not yet": a proposal cited
 * from the code that implements it is how a proposal gets built. One list, so
 * a word added to it reaches this too.
 */
const NOT_YET: ReadonlySet<string> = new Set(['draft', 'proposed']);

export function isStale(status: string | undefined): boolean {
  // A document with no status is in no list, so there is nothing to test first.
  return INACTIVE_STATUSES.has(status as string) && !NOT_YET.has(status as string);
}

/** A document of a family, as a citation needs to know it. */
export interface CitedDocument {
  /** Root-relative path. */
  file: string;
  /** The number as its file name spells it: `0007`. */
  spelled: string;
  title?: string;
  status?: SpecStatus;
}

/** A family, ready to look up: its templates, and its documents by number. */
export interface ResolvedFamily extends CiteFamily {
  source: 'config' | 'derived';
  template: IdTemplate;
  documents: Map<string, CitedDocument[]>;
}

/** The id a family writes for a document: `ADR-0007`. */
function idOf(family: Pick<ResolvedFamily, 'template'>, spelled: string): string {
  return `${family.template.prefix}${spelled}${family.template.suffix}`;
}

/** Reads files in batches of the engine's read limit, as `readSpecs` does, keeping each failure. */
async function readAll(io: Io, files: readonly string[]): Promise<Array<Buffer | Error>> {
  const read: Array<Buffer | Error> = [];
  while (read.length < files.length) {
    const batch = files.slice(read.length, read.length + MAX_CONCURRENT_READS);
    read.push(...(await Promise.all(batch.map((file) => io.readFile(file).catch((error: unknown) => error as Error)))));
  }
  return read;
}

/**
 * The documents a files template names, by number.
 *
 * Walked from the template's literal base, skipping what a run skips. The
 * project's `exclude` is not applied: it says what no rule reads, and a
 * document it leaves out of the rules still exists to be cited. A document
 * that cannot be read is still a document, with no status.
 */
export async function findDocuments(family: CiteFamily, root: string, io: Io, defaultSkips: boolean): Promise<Map<string, CitedDocument[]>> {
  const numberOf = documentNumber(family.files);
  const { base } = globBase(parseFilesTemplate(family.files).glob);
  const found: Array<{ file: string; absolute: string; spelled: string }> = [];
  for await (const entry of walkPaths(path.resolve(root, base), { io, scope: createScope(defaultSkips) })) {
    const file = base === '' ? entry.relativePath : `${base}/${entry.relativePath}`;
    const spelled = numberOf(file);
    if (spelled !== null) found.push({ file, absolute: entry.absolutePath, spelled });
  }
  const sources = await readAll(io, found.map(({ absolute }) => absolute));
  const documents = new Map<string, CitedDocument[]>();
  found.forEach(({ file, spelled }, index) => {
    const source = sources[index] as Buffer | Error;
    const text = source instanceof Error ? '' : source.toString('utf8');
    const title = parseTitle(text);
    const status = parseStatus(text);
    const key = numberKey(spelled);
    documents.set(key, [
      ...(documents.get(key) ?? []),
      { file, spelled, ...(title === undefined ? {} : { title }), ...(status === undefined ? {} : { status }) },
    ]);
  });
  return documents;
}

/* ----------------------------------------------------------------- defaults */

/** The extensions Markdown is written in, which spec-graph reads and this does not. */
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);

/**
 * The families a project's specs imply, when it names none.
 *
 * A directory of spec files whose names begin with a number is a numbered
 * series, and a series whose documents all title themselves with one id and
 * that same number - `# ADR-0007: ...` in `0007-x.md` - says how it is cited.
 * Anything short of that is not guessed at: a series whose titles disagree, or
 * do not begin with an id, gets a note saying to configure `cites`.
 */
export function deriveFamilies(documents: ReadonlyArray<{ file: string; title?: string }>): { families: CiteFamily[]; notes: string[] } {
  const series = new Map<string, Array<{ name: string; digits: string; title?: string }>>();
  for (const { file, title } of documents) {
    const slash = file.lastIndexOf('/');
    const name = file.slice(slash + 1);
    const digits = /^[0-9]+/.exec(name)?.[0];
    if (digits === undefined) continue;
    const directory = file.slice(0, Math.max(slash, 0));
    series.set(directory, [...(series.get(directory) ?? []), { name, digits, ...(title === undefined ? {} : { title }) }]);
  }

  const families: CiteFamily[] = [];
  const notes: string[] = [];
  for (const [directory, members] of [...series].sort(([a], [b]) => comparePaths(a, b))) {
    const prefixes = new Set(
      members.map(({ digits, title }) => {
        const titled = title === undefined ? null : /^([A-Za-z]+-)([0-9]+)(?![0-9A-Za-z_])/.exec(title);
        return titled !== null && numberKey(titled[2] as string) === numberKey(digits) ? (titled[1] as string) : null;
      }),
    );
    const where = directory === '' ? 'the root' : directory;
    // A series has a member, so the set has at least one entry.
    const prefix = [...prefixes][0] as string | null;
    if (prefixes.size !== 1 || prefix === null) {
      notes.push(
        `${where} holds numbered specs whose titles do not all begin with one id and their own number, such as ADR-0001 in 0001-x.md, so how they are cited is not guessed; name them in "cites" to check citations of them`,
      );
      continue;
    }
    const extensions = new Set(members.map(({ name }) => path.posix.extname(name)));
    const [extension] = extensions;
    const glob = `${directory === '' ? '' : `${directory}/`}${NUMBER}*${extensions.size === 1 ? (extension as string) : ''}`;
    families.push({ id: `${prefix}${NUMBER}`, files: glob });
  }
  return { families, notes };
}

/* --------------------------------------------------------------------- scan */

export interface CitesOptions {
  /** Absolute root. */
  root: string;
  /** The spec globs: the files left out of the scan, and where families are derived from. */
  patterns: readonly string[];
  /** The families to look for; derived from the specs when absent. */
  families?: readonly CiteFamily[];
  /** Root-relative paths to read the comments of; the whole root when absent. */
  paths?: readonly string[];
  /** The project's exclusions, left out of the scan. */
  exclude?: readonly string[];
  /** Skip `.git`, `.hg`, `.svn` and `node_modules`, as a run does. */
  defaultSkips?: boolean;
  /** A stale citation is an error, and so is a file whose comments could not all be read. */
  strict?: boolean;
  io?: Io;
}

/** A configuration no answer can be trusted under: the report is not written, and the command exits 2. */
export class CitesError extends Error {}

/** The nearest ids a family has on either side of a number: what a typo most likely meant. */
function nearest(family: ResolvedFamily, number: string): string[] {
  const wanted = BigInt(number);
  // Numbers as big as a comment writes them, so compared as BigInt; the
  // difference's sign is all a sort needs, and Number keeps it.
  const values = [...family.documents.keys()].map((key) => BigInt(key)).sort((a, b) => Number(a - b));
  // The cited number is no document's, so nothing equals it.
  const sides = [values.filter((value) => value < wanted).pop(), values.find((value) => value > wanted)];
  return sides
    .filter((side) => side !== undefined)
    .map((side) => idOf(family, ((family.documents.get(side.toString()) as CitedDocument[])[0] as CitedDocument).spelled));
}

/** Where a stale document's status line points, followed until a document in force, or null. */
function successorOf(document: CitedDocument, own: { family: number; number: string }, families: readonly ResolvedFamily[]): { id: string; chain: string[] } | null {
  const templates = families.map(({ template }) => template);
  const seen = new Set([`${own.family}\u0000${own.number}`]);
  const chain: string[] = [];
  let current = document;
  for (;;) {
    // Only a stale document is followed, and a stale document has a status.
    const label = (current.status as SpecStatus).label;
    const next = scanCitations(label, templates).find((citation) => !seen.has(`${citation.family}\u0000${citation.number}`));
    if (next === undefined) return null;
    seen.add(`${next.family}\u0000${next.number}`);
    const family = families[next.family] as ResolvedFamily;
    const [target] = family.documents.get(next.number) ?? [];
    if (target === undefined) return null;
    const id = idOf(family, target.spelled);
    chain.push(id);
    if (!isStale(target.status?.value)) return { id, chain };
    current = target;
  }
}

/**
 * Reads the comments of every source file in scope and reports each citation
 * of a document that does not exist or is no longer in force.
 *
 * Throws `CitesError` when the answer could not be trusted: a family whose
 * files match no document, which would make every citation of it a ghost.
 */
export async function findCitations(options: CitesOptions): Promise<CitesReport> {
  const startedAt = performance.now();
  const io = options.io ?? nodeIo;
  const root = options.root;
  const defaultSkips = options.defaultSkips ?? true;
  const exclude = [...(options.exclude ?? [])];
  const specs = await readSpecs(options.patterns, root, io);
  const specFiles = new Set(specs.files);

  const derived = options.families === undefined ? deriveFamilies(specs.documents.map(({ relativeFile, title }) => ({ file: relativeFile, ...(title === undefined ? {} : { title }) }))) : null;
  const declared = options.families ?? (derived as { families: CiteFamily[] }).families;
  const notes = derived === null ? [] : [...derived.notes];
  const source = derived === null ? 'config' : 'derived';

  const families: ResolvedFamily[] = [];
  for (const family of declared) {
    const documents = await findDocuments(family, root, io, defaultSkips);
    if (documents.size === 0) {
      throw new CitesError(
        `no document matches ${family.files}, so every citation of ${family.id} would be reported as a ghost; check the files pattern against the documents' names`,
      );
    }
    families.push({ ...family, source, template: parseIdTemplate(family.id), documents });
  }
  if (families.length === 0) {
    notes.push(
      options.families === undefined
        ? 'nothing to look for: "cites" names no documents, and no directory of numbered specs titles them with an id such as ADR-0001, so no citation was read; name them in "cites"'
        : 'nothing to look for: "cites" is an empty list',
    );
  }

  const cited = new Set(families.flatMap((family) => [...family.documents.values()].flat().map(({ file }) => file)));
  const excluded = createExcludeMatcher(exclude);
  const templates = families.map(({ template }) => template);
  const scope = createScope(defaultSkips);
  const unclassified = new Map<string, number>();
  const candidates: Array<{ file: string; absolute: string }> = [];
  const starts = (options.paths ?? ['.']).map((entry) => (entry === '.' ? '' : entry));
  const seen = new Set<string>();

  for (const start of families.length === 0 ? [] : starts) {
    const absoluteStart = path.resolve(root, start);
    const stats = await io.stat(absoluteStart);
    const entries: Array<{ relativePath: string; absolutePath: string }> = [];
    if (stats?.isFile()) entries.push({ relativePath: start, absolutePath: absoluteStart });
    else {
      for await (const entry of walkPaths(absoluteStart, { io, scope })) {
        entries.push({ relativePath: start === '' ? entry.relativePath : `${start}/${entry.relativePath}`, absolutePath: entry.absolutePath });
      }
    }
    for (const { relativePath, absolutePath } of entries) {
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const extension = path.posix.extname(relativePath).toLowerCase();
      if (MARKDOWN.has(extension) || specFiles.has(absolutePath) || cited.has(relativePath) || excluded(relativePath)) continue;
      const syntax = syntaxFor(relativePath);
      if (syntax === null) {
        const name = extension === '' ? '(none)' : extension;
        unclassified.set(name, (unclassified.get(name) ?? 0) + 1);
        continue;
      }
      // A format known to have no comments has no citations to read.
      if (syntax.line.length === 0 && syntax.block.length === 0) continue;
      candidates.push({ file: relativePath, absolute: absolutePath });
    }
  }
  candidates.sort((a, b) => comparePaths(a.file, b.file));

  const strict = options.strict ?? false;
  const findings: CiteFinding[] = [];
  const gaps: CiteGap[] = [];
  let read = 0;
  let citations = 0;
  let others = 0;

  const scan = (file: string, bytes: Buffer | Error): void => {
    if (bytes instanceof Error) {
      gaps.push({ file, reason: 'unreadable', detail: `could not be read: ${bytes.message}` });
      return;
    }
    if (!withinSizeLimit(bytes.length)) {
      gaps.push({ file, reason: 'too-large', detail: 'is larger than 20 MB, which no search reads' });
      return;
    }
    if (isBinary(bytes)) {
      gaps.push({ file, reason: 'binary', detail: 'holds a NUL byte, so it is not text' });
      return;
    }
    read += 1;
    const text = bytes.toString('utf8');
    const lexed = lexRanges(text, syntaxFor(file) as NonNullable<ReturnType<typeof syntaxFor>>);
    if (lexed.unterminated) {
      gaps.push({ file, reason: 'lost-scan', detail: 'a string or comment was never closed, so what follows it may be misread' });
    }
    let lines: number[] | undefined;
    const once = new Set<string>();
    for (const citation of inComments(scanCitations(text, templates), lexed.comments)) {
      if (qualified(text, citation.start)) {
        others += 1;
        continue;
      }
      lines ??= lineStarts(text);
      const { line, column } = locate(lines, citation.start);
      const key = `${line}\u0000${citation.family}\u0000${citation.number}`;
      if (once.has(key)) continue;
      once.add(key);
      citations += 1;
      const finding = judge(citation, families, { file, line, column }, strict);
      if (finding !== null) findings.push(finding);
    }
  };
  // A batch at a time, each scanned as soon as it is read, so that no more
  // than one batch of a large tree is held in memory at once.
  for (let next = 0; next < candidates.length; next += MAX_CONCURRENT_READS) {
    const batch = candidates.slice(next, next + MAX_CONCURRENT_READS);
    const sources = await readAll(io, batch.map(({ absolute }) => absolute));
    batch.forEach(({ file }, index) => scan(file, sources[index] as Buffer | Error));
  }

  const ghosts = findings.filter((finding) => finding.rule === 'ghost-citation').length;
  const stale = findings.length - ghosts;
  const familyReports: CiteFamilyReport[] = families.map(({ id, files, source: from, documents }) => ({
    id,
    files,
    source: from,
    documents: [...documents.values()].reduce((total, list) => total + list.length, 0),
  }));

  return {
    // Under --strict, anything short of every comment read and every citation
    // in force fails: a stale citation, a file read in part, and a check that
    // looked for nothing or read nothing, which the family contract says a
    // strict run refuses rather than reports as clean.
    ok: ghosts === 0 && !(strict && (stale > 0 || gaps.length > 0 || families.length === 0 || read === 0)),
    root: toPosix(root),
    durationMs: performance.now() - startedAt,
    families: familyReports,
    summary: {
      files: read,
      citations,
      ghosts,
      stale,
      qualified: others,
      unclassified: [...unclassified.values()].reduce((total, count) => total + count, 0),
    },
    findings,
    gaps,
    unclassified: [...unclassified]
      .map(([extension, files]) => ({ extension, files }))
      .sort((a, b) => b.files - a.files || comparePaths(a.extension, b.extension)),
    notes,
    exclude,
  };
}

/** What one citation found: nothing wrong, a ghost, or a stale document. */
function judge(
  citation: Citation,
  families: readonly ResolvedFamily[],
  where: { file: string; line: number; column: number },
  strict: boolean,
): CiteFinding | null {
  const family = families[citation.family] as ResolvedFamily;
  const documents = family.documents.get(citation.number);
  const at = `${where.file}:${where.line}`;
  if (documents === undefined) {
    const near = nearest(family, citation.number);
    return {
      rule: 'ghost-citation',
      severity: 'error',
      ...where,
      cited: citation.written,
      family: family.id,
      message: `${at} cites ${citation.written}, which no document defines`,
      hint: `no document matching ${family.files} has the number ${citation.number}; the nearest ${near.length === 1 ? 'is' : 'are'} ${near.join(' and ')}`,
    };
  }
  // Two documents with one number are one id, and it is in force while either is.
  const document = documents.find((candidate) => !isStale(candidate.status?.value));
  if (document !== undefined) return null;
  const stale = documents[0] as CitedDocument;
  const status = (stale.status as SpecStatus).value;
  const successor = successorOf(stale, citation, families);
  const said = `${stale.file} says "${(stale.status as SpecStatus).label}"`;
  return {
    rule: 'stale-citation',
    severity: strict ? 'error' : 'warning',
    ...where,
    cited: citation.written,
    family: family.id,
    document: stale.file,
    status,
    ...(successor === null ? {} : { successor: successor.id }),
    message: `${at} cites ${citation.written}, which is ${status}${successor === null ? '' : ` - cite ${successor.id} instead`}`,
    hint:
      successor === null
        ? `${said}, and names no successor in force; cite the decision in force instead, or take the citation out`
        : successor.chain.length > 1
          ? `${said}; it was followed through ${successor.chain.slice(0, -1).join(', ')}, which ${successor.chain.length === 2 ? 'is' : 'are'} not in force either, to ${successor.id}`
          : `${said}`,
  };
}

