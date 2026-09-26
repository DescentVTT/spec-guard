/**
 * A reader and editor for the front matter the spec-* tools use: a flat bag
 * of YAML scalars and lists, and optionally one level of nested mapping.
 *
 * Supported: `key: value` lines; plain, single-quoted and double-quoted
 * scalars; inline `[a, b]` sequences; block `- item` sequences; `#` comments.
 * Plain scalars follow the YAML 1.2 core schema, so `yes` is a word and `035`
 * keeps its leading zero for whoever reads it as text. With `nested`, a key
 * whose value is an indented block of keys is read as `parent.child` entries.
 *
 * Anything richer - deeper nesting, block scalars, anchors, tags, a value
 * continued onto the next line - is recognised and reported as unsupported
 * rather than guessed at. A YAML library would parse more, but it would not
 * give back the line and the offset of every value, and a report has to point
 * at the value it is about, and an edit has to leave every other line of the
 * file as it was.
 */

import { lineStarts, splitLines, stripBom } from '../text/index.js';
import { leadIndex } from './syntax.js';
import type { FrontMatterKind } from './types.js';

export interface YamlScalar {
  readonly text: string;
  readonly quoted: boolean;
}

export type YamlValue =
  | { readonly kind: 'scalar'; readonly scalar: YamlScalar }
  | { readonly kind: 'list'; readonly items: readonly YamlScalar[] }
  | { readonly kind: 'unsupported'; readonly reason: string };

export interface FrontMatterEntry {
  /** The key as written; a nested key is its parent's and its own, joined by a dot. */
  readonly key: string;
  /** The key compared: {@link keyName} of `key`, so `depends-on` is `dependsOn`. */
  readonly name: string;
  /** The parent key as written, for a nested key; `null` at the top level. */
  readonly parent: string | null;
  /** 0-based line of the key. */
  readonly line: number;
  /** 0-based line after the entry's last line. */
  readonly end: number;
  /** Offset of the key in the text read. */
  readonly keyStart: number;
  /**
   * Offsets of the value as written: a quoted scalar with its quotes, an
   * inline list with its brackets, a block list from its first item's text to
   * its last item's. An empty value is the empty range just past the colon.
   */
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: YamlValue;
}

export interface FrontMatterProblem {
  /** 0-based line. */
  readonly line: number;
  readonly message: string;
}

export interface FrontMatter {
  readonly kind: FrontMatterKind;
  /** 0-based line of the closing delimiter, or -1 when the block is never closed. */
  readonly close: number;
  readonly entries: readonly FrontMatterEntry[];
  readonly problems: readonly FrontMatterProblem[];
}

export interface ReadOptions {
  /**
   * Read one level of nested mapping as `parent.child` entries, instead of
   * reporting the parent's value as unsupported.
   */
  readonly nested?: boolean;
}

const YAML_OPEN = /^---[ \t]*$/;
const YAML_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const TOML_FENCE = /^\+\+\+[ \t]*$/;

/** The kind of front matter a document's first line opens, or `null` when it opens none. */
export function frontMatterKind(firstLine: string): FrontMatterKind | null {
  if (YAML_OPEN.test(firstLine)) return 'yaml';
  return TOML_FENCE.test(firstLine) ? 'toml' : null;
}

/** Whether a line closes front matter of a kind: `---` or `...` for YAML, `+++` for TOML. */
export function frontMatterCloses(line: string, kind: FrontMatterKind): boolean {
  return (kind === 'yaml' ? YAML_CLOSE : TOML_FENCE).test(line);
}

const KEY = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const SEQUENCE_ITEM = /^([ \t]*)-(?:[ \t]+(.*))?$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;

export function keyName(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Reads the front matter at the top of a text, or `null` when there is none.
 *
 * A leading byte-order mark is not part of the text read: offsets count from
 * the character after it, as a scan's do.
 */
export function readFrontMatter(source: string, options: ReadOptions = {}): FrontMatter | null {
  const text = stripBom(source);
  const lines = splitLines(text);
  const kind = frontMatterKind(lines[0] as string);
  if (kind === null) return null;
  const close = lines.findIndex((line, i) => i > 0 && frontMatterCloses(line, kind));
  if (close === -1) {
    return { kind, close, entries: [], problems: [{ line: 0, message: 'the front matter opened on line 1 is never closed' }] };
  }
  if (kind === 'toml') {
    return { kind, close, entries: [], problems: [{ line: 0, message: 'TOML front matter is not read; write YAML between "---" lines' }] };
  }

  const reader: Reader = {
    lines,
    starts: lineStarts(text),
    nested: options.nested === true,
    entries: [],
    problems: [],
    seen: new Map(),
  };
  let i = 1;
  while (i < close) {
    const line = lines[i] as string;
    if (BLANK_OR_COMMENT.test(line)) {
      i += 1;
      continue;
    }
    const match = KEY.exec(line);
    if (match === null) {
      reader.problems.push({
        line: i,
        message: /^\s/.test(line) ? 'an indented line belongs to no key' : 'not a "key: value" line',
      });
      i += 1;
      continue;
    }
    // The closing delimiter belongs to no value, so the block stops there.
    let end = i + 1;
    while (belongsToBlock(lines[end] as string)) end += 1;
    end = trimBlock(lines, end);
    readEntry(reader, { key: match[1] as string, parent: null, line: i, column: 0, inline: match[2] ?? '', end });
    i = end;
  }
  return { kind, close, entries: reader.entries, problems: reader.problems };
}

interface Reader {
  readonly lines: readonly string[];
  readonly starts: readonly number[];
  readonly nested: boolean;
  readonly entries: FrontMatterEntry[];
  readonly problems: FrontMatterProblem[];
  readonly seen: Map<string, number>;
}

interface KeyLine {
  /** The key as written on its line, without a parent. */
  readonly key: string;
  readonly parent: string | null;
  readonly line: number;
  /** Column of the key. */
  readonly column: number;
  /** What follows the colon and its whitespace, as written. */
  readonly inline: string;
  /** 0-based line after the key's value. */
  readonly end: number;
}

/** A line under a top-level key is part of its value when it is indented or starts a sequence item. */
function belongsToBlock(line: string): boolean {
  return /^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line) || line.trim() === '';
}

/**
 * Takes trailing blank and comment lines off a value's block: they belong to
 * no key. The key's own line is neither, so the walk stops there at the latest.
 */
function trimBlock(lines: readonly string[], end: number): number {
  let at = end;
  while (BLANK_OR_COMMENT.test(lines[at - 1] as string)) at -= 1;
  return at;
}

function note(reader: Reader, key: string, line: number): string {
  const name = keyName(key);
  const previous = reader.seen.get(name);
  if (previous === undefined) reader.seen.set(name, line);
  else reader.problems.push({ line, message: `"${key}" is declared twice (first on line ${previous + 1})` });
  return name;
}

function readEntry(reader: Reader, at: KeyLine): void {
  const { lines, starts } = reader;
  const text = lines[at.line] as string;
  const lineStart = starts[at.line] as number;
  const key = at.parent === null ? at.key : `${at.parent}.${at.key}`;
  // A key holds no colon and nothing before it does, so the first is its own.
  const colon = lineStart + text.indexOf(':') + 1;
  // What follows the colon starts after its whitespace; what ends it is
  // trimmed by whichever reader takes it.
  const inline = stripLeadingComment(at.inline);

  let read: Read;
  if (inline.length > 0) {
    const valueStart = lineStart + text.length - at.inline.length;
    const continued = contentLines(lines, at.line + 1, at.end).length > 0;
    const parsed = continued
      ? rough(unsupported('the value continues on the next line; keep it on one line, or quote it'), inline)
      : readInline(inline);
    read = { value: parsed.value, valueStart, valueEnd: valueStart + parsed.length };
  } else {
    const content = contentLines(lines, at.line + 1, at.end);
    const first = content[0];
    if (first !== undefined && at.parent === null && reader.nested && KEY.test((lines[first] as string).trim())) {
      note(reader, at.key, at.line);
      readChildren(reader, at.key, at.line + 1, at.end);
      return;
    }
    read = readBlock(reader, content, colon, at.parent === null);
  }

  reader.entries.push({
    key,
    name: note(reader, key, at.line),
    parent: at.parent,
    line: at.line,
    end: at.end,
    keyStart: lineStart + at.column,
    ...read,
  });
}

/** One level of keys under a parent, all at the indentation of the first. */
function readChildren(reader: Reader, parent: string, from: number, end: number): void {
  const { lines } = reader;
  const first = lines[contentLines(lines, from, end)[0] as number] as string;
  const lead = first.slice(0, leadIndex(first));
  let i = from;
  while (i < end) {
    const line = lines[i] as string;
    if (BLANK_OR_COMMENT.test(line)) {
      i += 1;
      continue;
    }
    // A line deeper than the keys is always taken by the key above it, so only
    // one at their indentation or shallower reaches here.
    const match = line.startsWith(lead) ? KEY.exec(line.slice(lead.length)) : null;
    if (match === null) {
      reader.problems.push({ line: i, message: 'not a "key: value" line at the indentation of the keys before it' });
      i += 1;
      continue;
    }
    // Past the parent's value, a line belongs to a child only when it is blank
    // or a comment, and those are trimmed off again.
    let childEnd = i + 1;
    while (belongsToChild(lines[childEnd] as string, lead)) childEnd += 1;
    childEnd = trimBlock(lines, childEnd);
    readEntry(reader, { key: match[1] as string, parent, line: i, column: lead.length, inline: match[2] ?? '', end: childEnd });
    i = childEnd;
  }
}

/** A line under a nested key is part of its value when it is deeper, or a sequence item at the key's indentation. */
function belongsToChild(line: string, lead: string): boolean {
  if (line.trim() === '') return true;
  if (!line.startsWith(lead)) return false;
  return /^(?:[ \t]|-(?:[ \t]|$))/.test(line.slice(lead.length));
}

interface Read {
  readonly value: YamlValue;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** Indices of the lines in a range that are neither blank nor a comment. */
function contentLines(lines: readonly string[], from: number, end: number): number[] {
  const out: number[] = [];
  for (let i = from; i < end; i += 1) if (!BLANK_OR_COMMENT.test(lines[i] as string)) out.push(i);
  return out;
}

/** A value written on the lines under its key. */
function readBlock(reader: Reader, content: readonly number[], colon: number, topLevel: boolean): Read {
  const { lines, starts } = reader;
  const first = content[0];
  if (first === undefined) return { value: { kind: 'scalar', scalar: { text: '', quoted: false } }, valueStart: colon, valueEnd: colon };

  // An unsupported block is reported over all of its content lines.
  const firstText = lines[first] as string;
  const last = content[content.length - 1] as number;
  const whole = (value: YamlValue): Read => ({
    value,
    valueStart: (starts[first] as number) + leadIndex(firstText),
    valueEnd: (starts[last] as number) + (lines[last] as string).trimEnd().length,
  });

  const head = SEQUENCE_ITEM.exec(firstText);
  if (head === null) {
    // Quoting a list would make it a string, so a list gets its own advice.
    if (firstText.trim().startsWith('[')) return whole(unsupported('an inline list starts on the line after its key; write it after the colon'));
    if (!KEY.test(firstText.trim())) return whole(unsupported('the value continues on the next line; keep it on one line, or quote it'));
    return whole(
      unsupported(topLevel ? 'nested mappings are not supported; flatten the key' : 'only one level of nesting is read; flatten the key'),
    );
  }
  const indent = (head[1] as string).length;
  const items: YamlScalar[] = [];
  const spans: [number, number][] = [];
  for (const index of content) {
    const line = lines[index] as string;
    const item = SEQUENCE_ITEM.exec(line);
    if (item === null || (item[1] as string).length !== indent) {
      return whole(unsupported('a list item is continued or nested; keep each item on one line'));
    }
    // The item's text starts after its whitespace, as a key's value does.
    const written = item[2] ?? '';
    const text = stripLeadingComment(written);
    if (text.length === 0) return whole(unsupported('a list item is empty'));
    const parsed = readInline(text);
    if (parsed.value.kind !== 'scalar') {
      return whole(parsed.value.kind === 'list' ? unsupported('nested lists are not supported') : parsed.value);
    }
    const start = (starts[index] as number) + line.length - written.length;
    spans.push([start, start + parsed.length]);
    items.push(parsed.value.scalar);
  }
  return { value: { kind: 'list', items }, valueStart: (spans[0] as [number, number])[0], valueEnd: (spans[spans.length - 1] as [number, number])[1] };
}

function stripLeadingComment(text: string): string {
  return text.startsWith('#') ? '' : text;
}

function unsupported(reason: string): YamlValue {
  return { kind: 'unsupported', reason };
}

interface Parsed {
  readonly value: YamlValue;
  /** Characters of the text the value spans. */
  readonly length: number;
}

/** An unsupported value spans its text up to any comment. */
function rough(value: YamlValue, text: string): Parsed {
  return { value, length: stripTrailingComment(text).length };
}

/** Parses a value written on the key's own line. `text` is trimmed and non-empty. */
export function parseInline(text: string): YamlValue {
  return readInline(text).value;
}

/** `text` starts with the value; whitespace after it is allowed. */
function readInline(text: string): Parsed {
  const head = text.charAt(0);
  if (head === '"' || head === "'") {
    const quoted = head === '"' ? readDoubleQuoted(text) : readSingleQuoted(text);
    if (typeof quoted === 'string') return rough(unsupported(quoted), text);
    return trailingIsComment(text.slice(quoted.next))
      ? { value: { kind: 'scalar', scalar: { text: quoted.text, quoted: true } }, length: quoted.next }
      : rough(unsupported('text follows a closing quote'), text);
  }
  if (head === '[') return parseFlowSequence(text);
  if (head === '{') return rough(unsupported('inline mappings are not supported'), text);
  if (head === '|' || head === '>') return rough(unsupported('block scalars are not supported; keep the value on one line'), text);
  if (head === '&' || head === '*' || head === '!') return rough(unsupported('anchors, aliases and tags are not supported'), text);
  if (head === '@' || head === '`') return rough(unsupported(`a plain value cannot start with "${head}"; quote it`), text);
  const plain = stripTrailingComment(text);
  if (/:(?:\s|$)/.test(plain)) return rough(unsupported('a plain value cannot contain ": "; quote it'), text);
  if (/^-(?:\s|$)/.test(plain)) return rough(unsupported('a list must start on the line after its key'), text);
  return { value: { kind: 'scalar', scalar: { text: plain, quoted: false } }, length: plain.length };
}

/** A comment starts at a `#` after whitespace; a `#` inside a word is text. */
function stripTrailingComment(text: string): string {
  return (text.split(/\s#/, 1)[0] as string).trim();
}

/** Nothing after a closing quote or bracket, or whitespace and then a comment. */
function trailingIsComment(rest: string): boolean {
  return /^(?:\s+(?:#.*)?)?$/.test(rest);
}

interface Quoted {
  readonly text: string;
  /** Index just past the closing quote. */
  readonly next: number;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  '0': '\u0000',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const HEX_ESCAPE_LENGTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** Reads a double-quoted scalar starting at index 0, or returns why it cannot. */
function readDoubleQuoted(text: string): Quoted | string {
  let out = '';
  for (let i = 1; ; i += 1) {
    const ch = text.charAt(i);
    if (ch === '') return 'a double-quoted value is never closed';
    if (ch === '"') return { text: out, next: i + 1 };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const code = text.charAt(i + 1);
    const simple = ESCAPES[code];
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }
    // An escape this reader does not know has no digits to read, and no
    // digits are not a number.
    const width = HEX_ESCAPE_LENGTH[code] ?? 0;
    const hex = text.slice(i + 2, i + 2 + width);
    if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return `"\\${code}" is not an escape this reader knows`;
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff) return `"\\${code}${hex}" is not a character`;
    out += String.fromCodePoint(point);
    i += 1 + width;
  }
}

function readSingleQuoted(text: string): Quoted | string {
  let out = '';
  for (let i = 1; ; i += 1) {
    const ch = text.charAt(i);
    if (ch === '') return 'a single-quoted value is never closed';
    if (ch !== "'") {
      out += ch;
      continue;
    }
    if (text.charAt(i + 1) !== "'") return { text: out, next: i + 1 };
    out += "'";
    i += 1;
  }
}

/** The first index at or after `from` that is not whitespace. */
function skipSpace(text: string, from: number): number {
  let i = from;
  while (/\s/.test(text.charAt(i))) i += 1;
  return i;
}

function parseFlowSequence(text: string): Parsed {
  const items: YamlScalar[] = [];
  const fail = (reason: string): Parsed => rough(unsupported(reason), text);
  let i = 1;
  for (;;) {
    i = skipSpace(text, i);
    const ch = text.charAt(i);
    if (ch === '') return fail('an inline list is never closed; keep it on one line');
    if (ch === ']') {
      return trailingIsComment(text.slice(i + 1))
        ? { value: { kind: 'list', items }, length: i + 1 }
        : fail('text follows the end of an inline list');
    }
    if (ch === '[' || ch === '{') return fail('nested lists and mappings are not supported');
    if (ch === ',') return fail('an inline list has an empty item');
    if (ch === '"' || ch === "'") {
      const rest = text.slice(i);
      const quoted = ch === '"' ? readDoubleQuoted(rest) : readSingleQuoted(rest);
      if (typeof quoted === 'string') return fail(quoted);
      items.push({ text: quoted.text, quoted: true });
      i += quoted.next;
    } else {
      let j = i;
      // One step past the end reads nothing and slices nothing more, so the
      // bound could be one further and still stop the walk.
      while (j < text.length && text.charAt(j) !== ',' && text.charAt(j) !== ']') j += 1;
      const plain = text.slice(i, j).trim();
      if (/[[{]/.test(plain) || /:(?:\s|$)/.test(plain) || plain.includes(' #')) {
        return fail(`"${plain}" needs quoting inside an inline list`);
      }
      items.push({ text: plain, quoted: false });
      i = j;
    }
    i = skipSpace(text, i);
    // After a comma the next pass reads an item or, legally in YAML, the
    // bracket; at the end of the text it says the list is never closed.
    const next = text.charAt(i);
    if (next === ',') i += 1;
    else if (next !== ']' && next !== '') return fail('inline list items must be separated by commas');
  }
}

/** Null in the YAML 1.2 core schema: empty, `~` or `null` in any of its three spellings. */
export function isNull(scalar: YamlScalar): boolean {
  return !scalar.quoted && ['', '~', 'null', 'Null', 'NULL'].includes(scalar.text);
}

/** Renders a string as a scalar that reads back as the same string. */
export function renderScalar(value: string): string {
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
  const plain = /^[A-Za-z][A-Za-z0-9 ._/+-]*$/.test(value) && !value.endsWith(' ');
  return plain && !reserved ? value : JSON.stringify(value);
}

export function findEntry(frontMatter: FrontMatter | null, key: string): FrontMatterEntry | undefined {
  const name = keyName(key);
  return frontMatter?.entries.find((entry) => entry.name === name);
}

/**
 * Sets one key, leaving every other line as it was.
 *
 * `lines` are the lines of the text the front matter was read from, as
 * `splitLines` gives them. An existing entry keeps the spelling and the
 * indentation of its key; a new one goes last, at the top level. A text with
 * no front matter gains a block.
 */
export function setEntry(lines: readonly string[], frontMatter: FrontMatter | null, key: string, rendered: string): string[] {
  if (frontMatter === null) return ['---', `${key}: ${rendered}`, '---', ...lines];
  if (frontMatter.close === -1) throw new Error('cannot edit front matter that is never closed');
  if (frontMatter.kind === 'toml') throw new Error('cannot edit TOML front matter');
  const entry = findEntry(frontMatter, key);
  if (entry === undefined) {
    return [...lines.slice(0, frontMatter.close), `${key}: ${rendered}`, ...lines.slice(frontMatter.close)];
  }
  const written =
    entry.parent === null
      ? `${entry.key}: ${rendered}`
      : `${(lines[entry.line] as string).slice(0, leadIndex(lines[entry.line] as string))}${entry.key.slice(entry.parent.length + 1)}: ${rendered}`;
  return [...lines.slice(0, entry.line), written, ...lines.slice(entry.end)];
}

/** Removes one key and its value lines; a key that is absent changes nothing. */
export function removeEntry(lines: readonly string[], frontMatter: FrontMatter | null, key: string): string[] {
  const entry = findEntry(frontMatter, key);
  if (entry === undefined) return [...lines];
  return [...lines.slice(0, entry.line), ...lines.slice(entry.end)];
}
