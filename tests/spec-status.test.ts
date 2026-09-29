/**
 * Document lifecycle status, and the rule that withholding is not passing.
 *
 * An ADR is a ledger. It is Proposed before anyone agrees to it and Superseded
 * long before anyone deletes it, and spec-guard used to execute all three
 * states identically - so a draft broke CI on a decision nobody had taken yet,
 * and a superseded ADR kept enforcing the rule its own heading says was
 * replaced. The remedy is a mechanism for not running an assertion, which is
 * the single most dangerous thing this codebase could grow.
 *
 * Every test here is therefore paired. It is not enough to show that a
 * withheld rule did not fail the run: a rule that was never real would look
 * exactly the same. Each one shows the assertion failing under
 * `ignoreStatus`, so what the status suppressed is known to have been a live
 * violation rather than nothing at all.
 *
 * See ADR-0010.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, type CliIO } from '../src/cli.js';
import { INACTIVE_STATUSES, parseDocument, parseStatus } from '../src/parser.js';
import { formatGitlab, formatJson, formatReport, formatSarif, runAnnotations } from '../src/reporter.js';
import { runSpecGuard, type RunResult } from '../src/runner.js';
import { makeTempRepo, PROJECT_ROOT, removeTempRepo } from './helpers.js';

/** The ANSI escape, spelled the way the reporter's own tests spell it. */
const ESC = String.fromCharCode(27);

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

const run = (root: string, patterns = ['docs/*.md'], options = {}) =>
  runSpecGuard({ patterns, root, engine: 'javascript', ...options });

/** A rule that is definitely violated, so "did not fail" is never ambiguous. */
const VIOLATION = '<!-- @assert-absence target="src" symbol="Legacy" -->\n';
const CODE = { 'src/app.ts': 'const Legacy = 1;\n' };

/* ------------------------------------------------------------- extraction */

describe('where a status is read from', () => {
  it('reads a Nygard `## Status` section', () => {
    const status = parseStatus('# ADR-1\n\n## Status\n\nAccepted.\n\n## Context\n');

    expect(status).toEqual({ value: 'accepted', label: 'Accepted.', source: 'heading', active: true });
  });

  it('reads MADR front-matter', () => {
    const status = parseStatus('---\nstatus: proposed\ndate: 2026-01-01\n---\n\n# ADR-1\n');

    expect(status).toEqual({ value: 'proposed', label: 'proposed', source: 'frontmatter', active: false });
  });

  it('reads a bold `**Status:**` label, in either place the colon lands', () => {
    expect(parseStatus('# ADR-1\n\n**Status:** accepted\n\n## Context\n')?.value).toBe('accepted');
    expect(parseStatus('# ADR-1\n\n**Status**: accepted\n\n## Context\n')?.value).toBe('accepted');
    expect(parseStatus('# ADR-1\n\nStatus: accepted\n\n## Context\n')?.source).toBe('label');
  });

  it('reads a bold value without eating half of it', () => {
    // The pattern used to allow optional emphasis after the colon, which cannot
    // tell the key's closing `**` from the value's opening one - so this
    // reached the report as "Draft**", the exact half-mangled line the label
    // rule below exists to prevent. Found by a regex mutant CI reported alive.
    expect(parseStatus('Status: **Draft**\n')).toMatchObject({ value: 'draft', label: 'Draft' });
    expect(parseStatus('**Status:** **Draft**\n')).toMatchObject({ value: 'draft', label: 'Draft' });
    expect(parseStatus('**Status**:**Draft**\n')).toMatchObject({ value: 'draft', label: 'Draft' });
    expect(parseStatus('__Status__: draft\n')).toMatchObject({ value: 'draft', label: 'draft' });
  });

  it('reads the label however the whitespace around it falls', () => {
    // Up to three spaces of indent is CommonMark's own allowance, and a missing
    // space after the colon is a typo that should not decide whether a
    // superseded document keeps enforcing.
    expect(parseStatus('   **Status:** superseded\n')?.value).toBe('superseded');
    expect(parseStatus('Status:Superseded\n')).toMatchObject({ value: 'superseded', label: 'Superseded' });
    expect(parseStatus('**Status:**superseded\n')?.value).toBe('superseded');
    expect(parseStatus('##  Status\n\nDraft\n')?.value).toBe('draft');
  });

  it("reads MADR's quoted front-matter", () => {
    // MADR's own template writes `status: "{proposed | rejected | ...}"`. Quotes
    // left in leave no first word to read, so a document written from the
    // template that the ADR names stayed in force.
    expect(parseStatus('---\nstatus: "proposed"\n---\n')).toMatchObject({ value: 'proposed', label: 'proposed' });
    expect(parseStatus("---\nstatus: 'superseded by ADR-0007'\n---\n")).toMatchObject({
      value: 'superseded',
      label: 'superseded by ADR-0007',
    });
    // Only front-matter is YAML. In prose a quote is a character.
    expect(parseStatus('Status: "draft"\n')).toBeUndefined();
  });

  it('reads a front-matter status the way YAML reads it, comments and all', () => {
    // A trailing comment is not part of the value, whether the value is quoted
    // or not. Read with both ends of the quotes anchored, the first of these
    // declared no status - a withdrawn proposal left in force.
    expect(parseStatus('---\nstatus: "proposed" # decided at review\n---\n')).toMatchObject({
      value: 'proposed',
      label: 'proposed',
      active: false,
    });
    expect(parseStatus('---\nstatus: draft # see "ADR-0012"\n---\n')).toMatchObject({ value: 'draft', label: 'draft' });
    expect(parseStatus('---\nstatus: "draft" # see "ADR-0012"\n---\n')?.label).toBe('draft');
    // And the same characters where YAML says they are content: a `#` inside
    // quotes, a `#` with no space before it, a quote inside a plain scalar.
    expect(parseStatus('---\nstatus: "superseded by #12"\n---\n')?.label).toBe('superseded by #12');
    expect(parseStatus('---\nstatus: superseded by ADR#12\n---\n')?.label).toBe('superseded by ADR#12');
    expect(parseStatus('---\nstatus: superseded by "ADR-0007"\n---\n')).toMatchObject({
      value: 'superseded',
      label: 'superseded by "ADR-0007"',
    });
  });

  it('tolerates whitespace before the colon in every spelling of the key', () => {
    // The plain form always allowed it; the two bold forms have to agree, or
    // an autoformatter's spacing decides whether a document is enforced.
    expect(parseStatus('Status : superseded\n')?.value).toBe('superseded');
    expect(parseStatus('**Status** : superseded\n')?.value).toBe('superseded');
    expect(parseStatus('**Status :** superseded\n')?.value).toBe('superseded');
  });

  it('keeps front-matter in charge when its fences carry trailing whitespace', () => {
    // Stated as a disagreement on purpose. The label reader would pick the
    // `status:` line up anyway, so a fence that failed to parse only shows when
    // front-matter and the section say different things - and then it decides
    // whether the document is enforced.
    const conflicting = '--- \nstatus: superseded\n---\t\n\n# ADR-1\n\n## Status\n\nAccepted.\n';

    expect(parseStatus(conflicting)).toMatchObject({ value: 'superseded', source: 'frontmatter', active: false });
  });

  it('reads front-matter in a file that ends at the closing fence', () => {
    // No trailing newline. Quoted, because the label reader does not unquote -
    // so if the block is not recognised as front-matter, nothing is recognised.
    expect(parseStatus('---\nstatus: "superseded"\n---')).toMatchObject({ value: 'superseded', source: 'frontmatter' });
  });

  it('prefers front-matter to a heading, and a heading to a label', () => {
    // Not a tie-break for its own sake: a document carrying two of these is a
    // document mid-migration between conventions, and the machine-readable one
    // is the one someone wrote for a machine.
    const both = '---\nstatus: superseded\n---\n\n# ADR-1\n\n## Status\n\nAccepted.\n';
    expect(parseStatus(both)).toMatchObject({ value: 'superseded', source: 'frontmatter' });

    const headingAndLabel = '# ADR-1\n\n**Status:** superseded\n\n## Status\n\nAccepted.\n';
    expect(parseStatus(headingAndLabel)).toMatchObject({ value: 'accepted', source: 'heading' });
  });

  it('keeps the line as written while normalising the word', () => {
    // "superseded" tells a reader the rule stopped applying. "Superseded by
    // ADR-0007" tells them where it went, which is the whole question they are
    // about to ask.
    expect(parseStatus('## Status\n\nSuperseded by [ADR-0007](0007.md)\n')).toMatchObject({
      value: 'superseded',
      label: 'Superseded by [ADR-0007](0007.md)',
    });
    expect(parseStatus('## Status\n\nAccepted (0.3.0).\n')).toMatchObject({
      value: 'accepted',
      label: 'Accepted (0.3.0).',
    });
    // Emphasis comes off when it wraps the whole value, so `**Draft**` is a
    // status rather than an unrecognised word that quietly stays in force.
    expect(parseStatus('## Status\n\n**Draft**\n')).toMatchObject({ value: 'draft', label: 'Draft' });
    expect(parseStatus('## Status\n\n*Draft*\n')).toMatchObject({ value: 'draft', label: 'Draft' });
    expect(parseStatus('**Status:** __proposed__\n')).toMatchObject({ value: 'proposed', label: 'proposed' });
  });

  it('leaves the line alone where the emphasis is part of the sentence', () => {
    // One marker off each end of "Superseded by *ADR-0007*" is a half-mangled
    // sentence, and the report prints this line verbatim.
    expect(parseStatus('## Status\n\nSuperseded by *ADR-0007*\n')?.label).toBe('Superseded by *ADR-0007*');
    expect(parseStatus('## Status\n\nSuperseded by ADR_0007\n')?.label).toBe('Superseded by ADR_0007');
  });

  it('reads the word through leading emphasis without unwrapping the line', () => {
    // `**Superseded** by ADR-0007` is the commonest way anyone writes this,
    // and a rule that only unwrapped balanced markers made it declare nothing
    // at all - a superseded ADR left quietly in force.
    expect(parseStatus('## Status\n\n**Superseded** by ADR-0007\n')).toEqual({
      value: 'superseded',
      label: '**Superseded** by ADR-0007',
      source: 'heading',
      active: false,
    });
  });

  it('trims the line before reading it', () => {
    // Trailing whitespace on a Markdown line is invisible, ubiquitous, and
    // would otherwise reach the report inside the status it prints.
    expect(parseStatus('**Status:** accepted   \n')).toMatchObject({ value: 'accepted', label: 'accepted' });
    expect(parseStatus('## Status\n\n  Draft  \n')).toMatchObject({ value: 'draft', label: 'Draft' });
  });

  it('walks past a line that holds nothing but whitespace', () => {
    // Not the same as a blank line, and an editor leaves them everywhere. A
    // section whose separator happens to hold two spaces still declares what
    // the line under it says.
    expect(parseStatus('# ADR-1\n\n## Status\n  \nSuperseded.\n')?.value).toBe('superseded');
  });

  it('reads a document that uses CRLF line endings', () => {
    // A trailing carriage return defeats every `$` in the line patterns, so a
    // Windows checkout declared no status at all - silently, which is the one
    // way this feature must never fail. Found by running the parser over this
    // repository's own ADR-0003, which happened to be CRLF on disk.
    const lf = '# ADR-1\n\n## Status\n\nSuperseded.\n';

    expect(parseStatus(lf.replace(/\n/g, '\r\n'))).toEqual(parseStatus(lf));
    expect(parseStatus(lf.replace(/\n/g, '\r\n'))?.value).toBe('superseded');
    expect(parseStatus('---\r\nstatus: draft\r\n---\r\n\r\n# ADR-1\r\n')?.value).toBe('draft');
  });
});

describe('what is not a status', () => {
  it('ignores one inside a fenced code block', () => {
    // The README documents this syntax. A tool that reads its own
    // documentation as configuration disables itself by being documented.
    const fenced = '# Guide\n\n```md\n## Status\n\nSuperseded.\n```\n\n## Context\n';

    expect(parseStatus(fenced)).toBeUndefined();
    // The control: the same six lines, unfenced, are read.
    expect(parseStatus(fenced.replace(/```md\n|```\n/g, ''))?.value).toBe('superseded');
  });

  it('ignores a sentence that merely begins with the word', () => {
    expect(parseStatus('# ADR-1\n\nStatuses are hard to keep current.\n\n## Context\n')).toBeUndefined();
  });

  it('ignores a key that only begins with the word', () => {
    expect(parseStatus('# ADR-1\n\nStatuses: none recorded yet\n\n## Context\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\nStatusline: proposed layout\n\n## Context\n')).toBeUndefined();
  });

  it('ignores a bold key that never closes', () => {
    // Malformed Markdown, so no status - which leaves the document in force,
    // the direction a parsing failure is supposed to fall.
    expect(parseStatus('**Status: superseded\n')).toBeUndefined();
  });

  it('does not end the preamble at a `##` in the middle of a line', () => {
    // The preamble ends at a heading, not at a pair of hashes. Unanchored, a
    // title that mentions them hides the status line under it.
    expect(parseStatus('# ADR-7: Replace ## markers\n\nStatus: draft\n\n## Context\n')?.value).toBe('draft');
  });

  it('ends the preamble at an indented section heading', () => {
    // Indented up to three spaces is still a heading, so the preamble is over.
    expect(parseStatus('# ADR-1\n\n   ## Context\n\nStatus: rejected\n')).toBeUndefined();
  });

  it('ignores the word in the middle of a line, colon and all', () => {
    // The label pattern is anchored to the start of a line. Unanchored, every
    // sentence containing "status:" becomes metadata, and a document could be
    // withheld by a phrase in its own prose.
    expect(parseStatus('# ADR-1\n\nSee the status: rejected section below.\n\n## Context\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\nA note (status: draft) on this.\n\n## Context\n')).toBeUndefined();
  });

  it('ignores a heading that only starts with the word', () => {
    // `## Status` is the section; `## Status of the migration` is a section
    // about something, and reading the sentence under it as a status word
    // means reading arbitrary prose as a lifecycle state.
    expect(parseStatus('# ADR-1\n\n## Status of the migration\n\nDraft work continues.\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n## Statuses\n\nDraft.\n')).toBeUndefined();
  });

  it('ignores a heading indented into a code block', () => {
    // Four spaces is an indented code block in CommonMark, not a heading. The
    // three-space allowance is the spec's, and without the ceiling an example
    // indented under a list item would declare a status.
    expect(parseStatus('# ADR-1\n\n   ## Status\n\n   Draft\n')?.value).toBe('draft');
    expect(parseStatus('# ADR-1\n\n    ## Status\n\n    Draft\n')).toBeUndefined();
  });

  it('ignores a front-matter-shaped block that is not front-matter', () => {
    // `---` is also a horizontal rule, so the front-matter reader is anchored
    // to the first byte of the file. Unanchored, any later block of key-value
    // prose would be read as metadata - and the preamble bound that stops the
    // loose label form does not apply to it.
    const late = '# ADR-1\n\n## Context\n\nProse.\n\n---\nstatus: superseded\n---\n';

    expect(parseStatus(late)).toBeUndefined();
    // The control: the identical block at the top of the file is read.
    expect(parseStatus('---\nstatus: superseded\n---\n\n# ADR-1\n')?.value).toBe('superseded');
    // And a `status:` line in the preamble is the label form whether or not
    // somebody drew a rule above it. That is not front-matter; it is prose
    // that says what the prose form says.
    expect(parseStatus('# ADR-1\n\n---\nstatus: draft\n\n---\n\n## Context\n')).toMatchObject({
      value: 'draft',
      source: 'label',
    });
    // A rule drawn directly under it is no rule: `---` under a line of text
    // underlines a heading, which is a section of its own and ends the
    // preamble. Every renderer shows "status: draft" as a heading there, and
    // it was read as the label until the scanner's headings were used.
    expect(parseStatus('# ADR-1\n\n---\nstatus: draft\n---\n\n## Context\n')).toBeUndefined();
  });

  it('ignores a label once the preamble is over', () => {
    // The loose form is a line of prose with a colon in it. Accepted anywhere
    // in a long document, one eventually turns up inside a sentence.
    const late = '# ADR-1\n\n## Context\n\nStatus: rejected was the outcome of the review.\n';

    expect(parseStatus(late)).toBeUndefined();
    // The control: the identical line above the first section heading is read.
    expect(parseStatus('# ADR-1\n\nStatus: rejected\n\n## Context\n')?.value).toBe('rejected');
  });

  it('ignores a `## Status` section with nothing under it', () => {
    expect(parseStatus('# ADR-1\n\n## Status\n\n## Context\n\nText.\n')).toBeUndefined();
    // And the same section as the last thing in the file, which runs off the
    // end of the document rather than into the next heading.
    expect(parseStatus('# ADR-1\n\n## Status\n\n')).toBeUndefined();
  });

  it('falls through front-matter that declares everything except a status', () => {
    // The block exists, so the front-matter reader runs and finds nothing in
    // it. It has to hand over rather than answer, or a MADR document with a
    // `date:` and a Nygard section would be read as declaring nothing.
    const both = '---\ndate: 2026-01-01\ntags: [storage]\n---\n\n# ADR-1\n\n## Status\n\nDraft\n';

    expect(parseStatus(both)).toMatchObject({ value: 'draft', source: 'heading' });
    expect(parseStatus('---\ndate: 2026-01-01\n---\n\n# ADR-1\n\nProse.\n')).toBeUndefined();
  });

  it('returns nothing at all for a document that declares nothing', () => {
    expect(parseStatus('# A plain document\n\nSome prose.\n')).toBeUndefined();
    // And one with no heading to hide behind: with no `## Status` to find,
    // the section reader must not fall back to reading the top of the file,
    // or the first sentence of every brief becomes its lifecycle state.
    expect(parseStatus('Some prose in a file with no headings at all.\n')).toBeUndefined();
  });

  it('finds a Status section that is the first line of the file', () => {
    // The boundary at the other end of the same search. A document that opens
    // on the section, or on a blank line before it, still declares what it
    // says.
    expect(parseStatus('## Status\n\nDraft\n')?.value).toBe('draft');
    expect(parseStatus('\n## Status\n\nDraft\n')?.value).toBe('draft');
  });

  it('ignores a status section holding something that is not a word', () => {
    // A date, a table row, a horizontal rule. There is no first word to
    // normalise, and inventing one would mean guessing which of these five
    // withholding words a "2026-01-01" was meant to be.
    for (const value of ['2026-01-01', '---', '| accepted |', '42']) {
      expect(parseStatus(`## Status\n\n${value}\n`)).toBeUndefined();
    }
  });
});

/*
 * Where the headings are is spec-core's scanner's to say, and the front matter
 * is its reader's (ADR-0002, amended 2026-09-26).
 */

describe('the headings a status is read by', () => {
  it('ignores a `## Status` kept in a comment, which is a template not yet filled in', () => {
    const template = '# ADR-1\n\n<!--\n## Status\n\nDraft\n-->\n\n## Context\n';
    expect(parseStatus(template)).toBeUndefined();
    // The control: the same section out of the comment is read.
    expect(parseStatus(template.replace('<!--\n', '').replace('-->\n', ''))?.value).toBe('draft');
  });

  it('does not end the preamble at a `##` kept in a comment or shown in code', () => {
    expect(parseStatus('# ADR-1\n\n<!--\n## Template\n-->\n\nStatus: draft\n\n## Context\n')?.value).toBe('draft');
    expect(parseStatus('# ADR-1\n\n```md\n## Example\n```\n\nStatus: draft\n\n## Context\n')?.value).toBe('draft');
  });

  it('reads a setext `Status` section, and ends the preamble at a setext section', () => {
    // An underlined heading is a heading, to CommonMark and to every renderer.
    expect(parseStatus('# ADR-1\n\nStatus\n------\n\nSuperseded.\n')).toMatchObject({ value: 'superseded', source: 'heading' });
    expect(parseStatus('# ADR-1\n\nContext\n-------\n\nStatus: draft\n')).toBeUndefined();
    // A level-one heading is the title, and the preamble goes on under it.
    expect(parseStatus('ADR-1\n=====\n\nStatus: draft\n')?.value).toBe('draft');
  });

  it('reads the section by its text as a reader sees it', () => {
    // A comment after the word is not part of the heading's text; a code span
    // is, and `Status` in one is a heading about the word.
    expect(parseStatus('## Status <!-- one of: draft, accepted -->\n\nAccepted\n')?.value).toBe('accepted');
    expect(parseStatus('## `Status`\n\nDraft\n')).toBeUndefined();
  });
});

describe('front matter, read by spec-core', () => {
  /** The one-line reader the front matter used to be read with, verbatim. */
  function yamlScalar(raw: string): string {
    const text = raw.trim();
    const quoted = /^(["'])(.*?)\1/.exec(text);
    return quoted ? (quoted[2] as string) : text.replace(/\s#.*/, '');
  }

  it('reads every value the one-line reader read, as that reader read it', () => {
    // Quoted up to the closing quote, plain up to a comment: the two things the
    // old reader existed to get right.
    for (const value of [
      'proposed',
      '"proposed"',
      "'superseded by ADR-0007'",
      '"proposed" # decided at review',
      'draft # see "ADR-0012"',
      '"draft" # see "ADR-0012"',
      '"superseded by #12"',
      'superseded by ADR#12',
      'superseded by "ADR-0007"',
      "it's accepted",
      '  accepted   ',
      'Superseded by [ADR-0007](0007.md)',
      '_Draft_',
    ]) {
      const read = parseStatus(`---\nstatus: ${value}\n---\n`);
      expect(read?.label, value).toBe(parseStatus(`## Status\n\n${yamlScalar(value)}\n`)?.label);
      expect(read?.source, value).toBe('frontmatter');
    }
  });

  it('declares nothing with a value the reader refuses, which leaves the document in force', () => {
    // Each of these is a value YAML reads differently or not at all, and the
    // one-line reader guessed at: a `: ` in a plain value, text after a
    // closing quote, a value continued on the next line, an alias.
    for (const block of [
      'status: superseded: see ADR-0007',
      'status: "draft" (see the review)',
      'status: superseded\n  by ADR-0007',
      'status: *Draft*',
    ]) {
      expect(parseStatus(`---\n${block}\n---\n\n# ADR-1\n`), block).toBeUndefined();
    }
  });

  it('reads the key the document has, not one nested under another', () => {
    // A `status` under `review:` is the review's.
    expect(parseStatus('---\nreview:\n  status: proposed\n---\n')).toBeUndefined();
    expect(parseStatus('---\nStatus: proposed\n---\n')?.value).toBe('proposed');
  });

  it('reads front matter behind a byte-order mark, and closed by `...`', () => {
    expect(parseStatus('﻿---\nstatus: draft\n---\n')).toMatchObject({ value: 'draft', source: 'frontmatter' });
    expect(parseStatus('---\nstatus: draft\n...\n')).toMatchObject({ value: 'draft', source: 'frontmatter' });
  });

});

describe('TOML front matter', () => {
  // Front matter between `+++` lines decides the status as YAML front matter
  // does (ADR-0010, amended 2026-09-29). It was not read for one before, so
  // the section or the label decided, and `status = "accepted"` above a
  // section still saying `Proposed` was withheld by it.
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, kind, message }) => [location.line, kind, message]);
  const said = (reason: string) =>
    `the status in front matter cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place`;
  const toml = (body: string, below = '') => `+++\n${body}\n+++\n\n# ADR-1\n${below}`;
  const PROPOSED = '\n## Status\n\nProposed\n';
  const ACCEPTED = '\n## Status\n\nAccepted\n';

  /**
   * Every kind of value TOML has, each hiding a `status` line or a `[status]`
   * header that is not one, above the key the document has. A walk that loses
   * its place in any of them reads one of those instead, or takes a line of an
   * array for a table header and ends the top level before the key.
   */
  const WALKED = [
    'title = "ADR-1: \\"quoted\\" # not a comment"',
    'description = """',
    '\\""" is not the end',
    'status = "draft"',
    '"""',
    "notes = '''",
    "status = 'draft'",
    '[status]',
    "'''",
    `path = '''C:\\'''`,
    "more = '''",
    'status = "draft"',
    "'''",
    'matrix = [',
    '  [1, 2], # a nested array, and a comment holding """',
    '  { name = "a", note = "}", list = [1, 2], nested = { x = 1 } },',
    "  {}, 'a, ] b',",
    '  1979-05-27 07:32:00Z # ] is in a comment',
    `  , 'C:\\', """ends in quotes""""", """`,
    'status = "draft"',
    '[status]',
    '""",',
    ']',
    'meta = { status = "draft" }',
    'other.status = "draft"',
    '# status = "draft"',
    'status = "accepted"',
    '[extra]',
    'status = "draft"',
  ].join('\n');

  it('reads every status word from a TOML string as from YAML', () => {
    for (const word of [
      ...INACTIVE_STATUSES,
      'accepted',
      'Accepted (0.3.0).',
      'superseded by ADR-0007',
      'Superseded by [ADR-0007](0007.md)',
      '**Draft**',
      '_Draft_',
      'implemented',
      'done',
    ]) {
      const yaml = parseStatus(`---\nstatus: "${word}"\n---\n`);
      expect(yaml?.source, word).toBe('frontmatter');
      expect(parseStatus(`+++\nstatus = "${word}"\n+++\n`), word).toEqual(yaml);
      expect(parseStatus(`+++\nstatus = '${word}'\n+++\n`), word).toEqual(yaml);
    }
  });

  it('decides the status, so neither the section nor the label is read in its place', () => {
    // The first two were withheld by the prose, and the third ran the rules
    // its front matter took out of force.
    expect(parseStatus(toml('status = "accepted"', PROPOSED))).toEqual({ value: 'accepted', label: 'accepted', source: 'frontmatter', active: true });
    expect(parseStatus(toml("status = 'accepted'", '\n**Status:** draft\n'))).toMatchObject({ value: 'accepted', source: 'frontmatter', active: true });
    expect(parseStatus(toml('status = "superseded by ADR-7"', ACCEPTED))).toEqual({
      value: 'superseded',
      label: 'superseded by ADR-7',
      source: 'frontmatter',
      active: false,
    });
  });

  it('reads the key with the blanks and the comments TOML allows around it, quoted or not', () => {
    for (const line of [
      '  status   =   "accepted"   # decided on 2024-05-01',
      '\tstatus\t=\t"accepted"\t',
      'status="accepted"#no blank before the comment',
      '"status" = "accepted"',
      "'status' = 'accepted'",
      // Compared as the YAML reader compares keys.
      'Status = "accepted"',
    ]) {
      expect(parseStatus(toml(line, PROPOSED)), line).toMatchObject({ value: 'accepted', label: 'accepted', source: 'frontmatter' });
    }
    // Among other keys, blank lines and comments, and behind a byte-order mark with CRLF endings.
    const among = toml('# ADR metadata\ntitle = "ADR-1"\n\nstatus = "accepted" # see the review\ndate = 2024-05-01\ntags = ["a", "b"]', PROPOSED);
    expect(parseStatus(among)).toMatchObject({ value: 'accepted', source: 'frontmatter' });
    expect(parseStatus(`${String.fromCharCode(0xfeff)}${among.replace(/\n/g, '\r\n')}`)).toMatchObject({ value: 'accepted', source: 'frontmatter' });
  });

  it('reads a string as TOML does: escapes in a basic string, none in a literal one', () => {
    expect(parseStatus(toml('status = "superseded by \\"ADR-7\\" # not a comment"'))?.label).toBe('superseded by "ADR-7" # not a comment');
    expect(parseStatus(toml('status = "draft \\b\\t\\n\\f\\r\\" \\\\ \\u0041 \\U0001F600 \\U0010FFFF end"'))).toMatchObject({
      value: 'draft',
      label: `draft \b\t\n\f\r" \\ A ${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x10ffff)} end`,
    });
    expect(parseStatus(toml("status = 'superseded by C:\\adr\\7'"))?.label).toBe('superseded by C:\\adr\\7');
    expect(parseStatus(toml("status = 'draft\\'"))?.label).toBe('draft\\');
    expect(parseStatus(toml(`status = 'superseded by "ADR-7"'`))?.label).toBe('superseded by "ADR-7"');
  });

  it('walks over every other value to its end, whatever lines it is on', () => {
    for (const source of [toml(WALKED, PROPOSED), toml(WALKED, PROPOSED).replace(/\n/g, '\r\n')]) {
      expect(parseStatus(source)).toMatchObject({ value: 'accepted', source: 'frontmatter' });
      expect(warningOf(source)).toBeUndefined();
    }
  });

  it('reads only the top-level key, and none in a comment or a string', () => {
    for (const body of [
      '[meta]\nstatus = "draft"',
      'title = "ADR-1"\n[meta]\nstatus = "draft"\n[[authors]]\nstatus = "draft"',
      'meta.status = "draft"',
      'meta = { status = "draft" }',
      '# status = "draft"',
      '  # status = "draft"',
      'notes = "status = draft"',
      'statusline = "draft"',
      'status-page = "draft"',
      '"status.value" = "draft"',
      '  [meta]\n  status = "draft"',
      // A header that names no key still ends the top level.
      '[]\nstatus = "draft"',
      '[ ]\nstatus = "draft"',
      '[[]]\nstatus = "draft"',
      'description = """\nstatus = "draft"\n"""',
      "description = '''\nstatus = 'draft'\n'''",
      // A multi-line string never closed runs to the end of the front matter.
      'description = """\nstatus = "draft"',
      "description = '''\nstatus = 'draft'",
    ]) {
      expect(parseStatus(toml(body, ACCEPTED)), body).toMatchObject({ value: 'accepted', source: 'heading' });
      expect(warningOf(toml(body, ACCEPTED)), body).toBeUndefined();
    }
    // YAML is read as it was: a TOML line in it is not "key: value", and names no key.
    expect(parseStatus(`---\nstatus = "draft"\n---\n\n# ADR-1\n${ACCEPTED}`)).toMatchObject({ value: 'accepted', source: 'heading' });
  });

  it('passes over a line it cannot follow to its end, as the YAML reader passes over one that is not "key: value"', () => {
    // None of these is TOML. What follows each is read as the next line of
    // the block, not as the rest of a string or an array that never began.
    for (const body of ['"status\nstatus = "accepted"', '= """\nstatus = "accepted"\n"""', 'x = [1 }]\nstatus = "accepted"', 'x = [["a" b, """\nstatus = "accepted"\n"""]]']) {
      expect(parseStatus(toml(body, PROPOSED)), body).toMatchObject({ value: 'accepted', source: 'frontmatter' });
    }
  });

  it('hands over to the section and the label without the key, as YAML front matter does', () => {
    expect(parseStatus(toml('title = "ADR-1"\ndate = 2024-05-01', PROPOSED))).toEqual(parseStatus(`---\ntitle: ADR-1\ndate: 2024-05-01\n---\n\n# ADR-1\n${PROPOSED}`));
    expect(parseStatus(toml('title = "ADR-1"', PROPOSED))).toMatchObject({ value: 'proposed', source: 'heading' });
    expect(parseStatus('+++\n+++\n\n# ADR-1\n\n**Status:** draft\n')).toMatchObject({ value: 'draft', source: 'label' });
    expect(parseStatus(toml('title = "ADR-1"'))).toBeUndefined();
    expect(warningOf(toml('title = "ADR-1"', PROPOSED))).toBeUndefined();
  });

  it('declares no status in any other form, which leaves the document in force, and says why on the line of the key', () => {
    const multiline = 'a multi-line string is not read; write it as "..." on one line';
    const cases: Array<[string, number, string]> = [
      ['status = """accepted"""', 2, multiline],
      ["title = 'ADR-1'\nstatus = '''\naccepted\n'''", 3, multiline],
      ['status = ["accepted"]', 2, 'an array is not a status'],
      ['status = { value = "accepted" }', 2, 'a table is not a status'],
      ['status.value = "accepted"', 2, 'a table is not a status'],
      ['title = "ADR-1"\n\n[status]\nvalue = "accepted"', 4, 'a table is not a status'],
      ['title = "ADR-1"\n[meta]\n[ "status" . value ]', 4, 'a table is not a status'],
      ['[[status]]\nvalue = "accepted"', 2, 'an array of tables is not a status'],
      ['status = accepted', 2, 'it is not a string; quote it'],
      ['status = true', 2, 'it is not a string; quote it'],
      ['status = 2024-05-01', 2, 'it is not a string; quote it'],
      ['status =', 2, 'it is empty'],
      ['status = # to be decided', 2, 'it is empty'],
      ['status = ""', 2, 'it is empty'],
      ["status = '  '", 2, 'it is empty'],
      ['status = "2024"', 2, '"2024" does not begin with a word'],
      ['status = "accepted', 2, 'the string is never closed on its line'],
      ["status = 'accepted", 2, 'the string is never closed on its line'],
      ['status = "accepted\\', 2, 'the string is never closed on its line'],
      ['status = "accepted" (2024-05-01)', 2, 'text follows a closing quote'],
      ["status = 'it''s accepted'", 2, 'text follows a closing quote'],
      ['status: accepted', 2, '"=" does not follow the key'],
      ['status = "accepted \\e"', 2, '"\\e" is not an escape this reader knows'],
      ['status = "accepted \\u00eX"', 2, '"\\u" is not an escape this reader knows'],
      ['status = "accepted \\uX041"', 2, '"\\u" is not an escape this reader knows'],
      ['status = "accepted \\U00110000"', 2, '"\\U00110000" is not a character'],
    ];
    for (const [body, line, reason] of cases) {
      const source = toml(body, PROPOSED);
      expect(parseStatus(source), body).toBeUndefined();
      expect(warningOf(source), body).toEqual([[line, 'unreadable-status', said(reason)]]);
    }
    // Behind a byte-order mark and with CRLF endings the key's line is counted as a reader counts it.
    expect(warningOf(`${String.fromCharCode(0xfeff)}+++\r\nid = 7\r\nstatus = [1]\r\n+++\r\n`)).toEqual([[3, 'unreadable-status', said('an array is not a status')]]);
  });

  it('runs the rules the prose alone would have withheld, withholds those the prose alone would have run, and says why in every format', async () => {
    const root = await repo({
      'docs/a.md': `${toml('status = "accepted"', PROPOSED)}\n${VIOLATION}`,
      'docs/b.md': `${toml('status = ["accepted"]', PROPOSED)}\n${VIOLATION}`,
      'docs/c.md': `${toml('status = "superseded by ADR-3"', ACCEPTED)}\n${VIOLATION}`,
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({ total: 2, failed: 2, inactive: 1 });
    expect(report.results.map(({ location }) => location.relativeFile)).toEqual(['docs/a.md', 'docs/b.md']);
    expect(report.inactiveSpecs).toEqual([{ file: 'docs/c.md', status: 'superseded', label: 'superseded by ADR-3', directives: 1 }]);
    const unreadable = said('an array is not a status');
    expect(report.specWarnings?.map(({ location, kind, message }) => [location.relativeFile, location.line, kind, message])).toEqual([
      ['docs/b.md', 2, 'unreadable-status', unreadable],
    ]);

    const human = formatReport(report, { color: false, verbose: false });
    expect(human).toContain(`⚠ docs/b.md:2  ${unreadable}`);
    expect(human).toContain('○ docs/c.md is superseded by ADR-3 - 1 assertion not executed');
    expect(human).not.toContain('is Proposed');
    const json = JSON.parse(formatJson(report)) as { summary: { inactive: number }; inactiveSpecs: unknown; specWarnings: unknown };
    expect(json.summary.inactive).toBe(1);
    expect(json.inactiveSpecs).toEqual([{ file: 'docs/c.md', status: 'superseded', label: 'superseded by ADR-3', directives: 1 }]);
    expect(json.specWarnings).toEqual([{ spec: { file: 'docs/b.md', line: 2, column: 1 }, kind: 'unreadable-status', message: unreadable }]);
    const sarif = JSON.parse(formatSarif(report)) as { runs: Array<{ invocations?: Array<{ toolExecutionNotifications: unknown }> }> };
    expect(sarif.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual([
      { level: 'note', message: { text: 'docs/c.md is superseded by ADR-3, so its 1 assertion was not executed.' } },
      { level: 'warning', message: { text: `docs/b.md:2 ${unreadable}` } },
    ]);
    expect(runAnnotations(report).filter(({ rule }) => rule === 'spec-warning' || rule === 'not-in-force')).toEqual([
      { rule: 'spec-warning', identity: ['spec-warning', 'docs/b.md', 'unreadable-status'], level: 'warning', severity: 'minor', file: 'docs/b.md', line: 2, message: unreadable, hint: 'write a status word spec-guard reads, such as accepted or superseded' },
      {
        rule: 'not-in-force',
        identity: ['not-in-force', 'docs/c.md'],
        level: 'notice',
        severity: 'info',
        file: 'docs/c.md',
        line: 1,
        message: 'docs/c.md is superseded by ADR-3, so its 1 assertion was not executed',
        hint: '--ignore-status executes the rules of a document not in force',
      },
    ]);
  });

  it('changes the exit code of a run from the command line, and a status that cannot be read fails nothing under --strict', async () => {
    const root = await repo({
      'docs/a.md': `${toml('status = "accepted"', PROPOSED)}\n${VIOLATION}`,
      'docs/b.md': `${toml('status = accepted', PROPOSED)}\n<!-- @assert-absence target="src" symbol="Nowhere" -->\n`,
      ...CODE,
    });
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: { NO_COLOR: '1' }, cwd: root, isTTY: false };

    expect(await main(['docs/a.md', '--engine', 'js'], io)).toBe(EXIT_FAILED);
    expect(out.join('\n')).not.toContain('not in force');
    out.length = 0;
    expect(await main(['docs/b.md', '--engine', 'js', '--strict', '--json'], io)).toBe(EXIT_OK);
    const json = JSON.parse(out.join('\n')) as { summary: unknown; inactiveSpecs: unknown; specWarnings: unknown };
    expect(json.summary).toMatchObject({ total: 1, passed: 1, inactive: 0 });
    expect(json.inactiveSpecs).toEqual([]);
    expect(json.specWarnings).toEqual([{ spec: { file: 'docs/b.md', line: 2, column: 1 }, kind: 'unreadable-status', message: said('it is not a string; quote it') }]);
  });
});

describe('a front-matter status that cannot be read', () => {
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, message }) => [location.line, message]);
  const said = (reason: string) =>
    `the status in front matter cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place`;

  it('decides the status, so nothing below it is read in its place', () => {
    // The review's two documents: 0.11.0's reader took the first word of each
    // and ran the rule; reading the prose instead took them out of force.
    expect(parseStatus('---\nstatus: "accepted" (2024-05-01)\n---\n\n# ADR-1\n\n## Status\n\nProposed in review.\n')).toBeUndefined();
    expect(parseStatus('---\nstatus: accepted: x\n---\n\n# ADR-1\n\nStatus: draft\n')).toBeUndefined();
    // Without the key, the section and the label are read as before.
    expect(parseStatus('---\ntitle: x\n---\n\n## Status\n\nProposed\n')?.value).toBe('proposed');
  });

  it('says why, on the line of the key', () => {
    expect(warningOf('---\nid: 7\nstatus: "accepted" (2024-05-01)\n---\n\n## Status\n\nProposed\n')).toEqual([[3, said('text follows a closing quote')]]);
    expect(warningOf('---\nstatus: accepted: x\n---\n\nStatus: draft\n')).toEqual([[2, said('a plain value cannot contain ": "; quote it')]]);
    expect(warningOf('---\nstatus:\n---\n\n## Status\n\nDraft\n')).toEqual([[2, said('it is empty')]]);
    // Quoted spaces are as empty as nothing at all: there is no word in either.
    expect(warningOf('---\nstatus: "  "\n---\n')).toEqual([[2, said('it is empty')]]);
    expect(warningOf('---\nstatus: "2024"\n---\n')).toEqual([[2, said('"2024" does not begin with a word')]]);
    expect(warningOf('---\nstatus: [draft]\n---\n')).toEqual([[2, said('a list is not a status')]]);
    expect(warningOf('---\nstatus:\n  [draft]\n---\n')).toEqual([[2, said('an inline list starts on the line after its key; write it after the colon')]]);
    expect(warningOf('---\nstatus: *Draft*\n---\n')).toEqual([[2, said('anchors, aliases and tags are not supported')]]);
  });

  it('says nothing of a word it can read, a word it does not know, or no key at all', () => {
    expect(warningOf('---\nstatus: draft\n---\n')).toBeUndefined();
    expect(warningOf('---\nstatus: implemented\n---\n')).toBeUndefined();
    expect(warningOf('---\ntitle: x\n---\n\n## Status\n\nProposed\n')).toBeUndefined();
  });

  it('runs the rules of a document the prose alone would have withheld, and says why in every format', async () => {
    const root = await repo({
      'docs/a.md': `---\nstatus: "accepted" (2024-05-01)\n---\n\n# ADR-1\n\n## Status\n\nProposed, pending review.\n\n${VIOLATION}`,
      'docs/b.md': `---\nstatus: accepted: x\n---\n\n# ADR-2\n\nStatus: draft\n\n${VIOLATION}`,
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({ total: 2, failed: 2, inactive: 0 });
    expect(report.inactiveSpecs).toEqual([]);
    expect(report.specWarnings?.map(({ location }) => `${location.relativeFile}:${location.line}`)).toEqual(['docs/a.md:2', 'docs/b.md:2']);

    const human = formatReport(report, { color: false, verbose: false });
    expect(human).toContain(`⚠ docs/a.md:2  ${said('text follows a closing quote')}`);
    const json = JSON.parse(formatJson(report)) as { specWarnings: Array<{ spec: { file: string; line: number }; kind: string; message: string }> };
    expect(json.specWarnings.map(({ spec }) => [spec.file, spec.line])).toEqual([['docs/a.md', 2], ['docs/b.md', 2]]);
    const sarif = JSON.parse(formatSarif(report)) as { runs: Array<{ invocations?: Array<{ toolExecutionNotifications: Array<{ level: string; message: { text: string } }> }> }> };
    expect(sarif.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual([
      { level: 'warning', message: { text: `docs/a.md:2 ${said('text follows a closing quote')}` } },
      { level: 'warning', message: { text: `docs/b.md:2 ${said('a plain value cannot contain ": "; quote it')}` } },
    ]);
    expect(runAnnotations(report).filter(({ rule }) => rule === 'spec-warning')).toEqual([
      { rule: 'spec-warning', identity: ['spec-warning', 'docs/a.md', 'unreadable-status'], level: 'warning', severity: 'minor', file: 'docs/a.md', line: 2, message: said('text follows a closing quote'), hint: 'write a status word spec-guard reads, such as accepted or superseded' },
      { rule: 'spec-warning', identity: ['spec-warning', 'docs/b.md', 'unreadable-status'], level: 'warning', severity: 'minor', file: 'docs/b.md', line: 2, message: said('a plain value cannot contain ": "; quote it'), hint: 'write a status word spec-guard reads, such as accepted or superseded' },
    ]);
    expect(json.specWarnings.map(({ kind }) => kind)).toEqual(['unreadable-status', 'unreadable-status']);
  });
});

describe('a status in the body that cannot be read', () => {
  // A `## Status` section decides as front matter's key does, readable or
  // not: one that could not be read handed over to a `Status:` line in the
  // preamble, and a status that cannot be read withheld a document by
  // accident. ADR-0010's amendment of 2026-09-30.
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, message }) => [location.line, message]);
  const section = (reason: string, heading = 'Status') =>
    `the status under the heading "${heading}" cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written elsewhere in the document is not read in its place`;
  const label = (reason: string) => `the status label cannot be read (${reason}), so its status is unrecognised and the document stays in force`;

  it('keeps its document in force, and the label is not read in its place', async () => {
    const source = `# ADR-1\n\nStatus: draft\n\n## Status\n\n2024-05-01: accepted\n\n${VIOLATION}`;
    expect(parseStatus(source)).toBeUndefined();
    expect(warningOf(source)).toEqual([[7, section('"2024-05-01: accepted" does not begin with a word')]]);
    // The rule runs, where the label alone would have withheld it.
    const report = await run(await repo({ 'docs/a.md': source, ...CODE }));
    expect(report.summary).toMatchObject({ total: 1, failed: 1, inactive: 0 });
    expect(report.specWarnings?.map(({ kind }) => kind)).toEqual(['unreadable-status']);
    // The control: the label alone is read, and withholds.
    expect(parseStatus(`# ADR-1\n\nStatus: draft\n\n## Context\n\n${VIOLATION}`)?.value).toBe('draft');
  });

  it('reads the section to the next heading, and one with nothing under it is empty, on its heading', () => {
    expect(warningOf('# ADR-1\n\nStatus: superseded\n\n## Status\n\n## Context\n\nProse.\n')).toEqual([[5, section('it is empty')]]);
    expect(parseStatus('# ADR-1\n\nStatus: superseded\n\n## Status\n\n## Context\n\nProse.\n')).toBeUndefined();
    // A heading under it ends it, whatever its level, as it ends any section's prose.
    expect(warningOf('# ADR-1\n\n## Status\n\n### Decided\n\nAccepted\n')).toEqual([[3, section('it is empty')]]);
    expect(warningOf('# ADR-1\n\nStatus\n======\n\n## Next\n\nAccepted\n')).toEqual([[3, section('it is empty')]]);
    // The last section runs to the end of the document.
    expect(warningOf('# ADR-1\n\n## Status\n')).toEqual([[3, section('it is empty')]]);
    expect(parseStatus('# ADR-1\n\n## Status\n\nAccepted\n')?.value).toBe('accepted');
  });

  it('names the heading as it was written', () => {
    expect(warningOf('# ADR-1\n\n## STATUS\n\n- [x] accepted\n')).toEqual([[5, section('"- [x] accepted" does not begin with a word', 'STATUS')]]);
  });

  it('says so of a label, which decides as the first one in the preamble', () => {
    expect(warningOf('# ADR-1\n\n**Status:** 2024-05-01\n\nStatus: draft\n')).toEqual([[3, label('"2024-05-01" does not begin with a word')]]);
    expect(parseStatus('# ADR-1\n\n**Status:** 2024-05-01\n\nStatus: draft\n')).toBeUndefined();
    expect(warningOf('# ADR-1\n\nStatus:\n')).toEqual([[3, label('it is empty')]]);
  });

  it('says nothing of a status it can read, a word it does not know, or none at all', () => {
    expect(warningOf('# ADR-1\n\n## Status\n\nAccepted\n')).toBeUndefined();
    expect(warningOf('# ADR-1\n\n## Status\n\nIn review\n')).toBeUndefined();
    expect(warningOf('# ADR-1\n\nStatus: provisional\n')).toBeUndefined();
    expect(warningOf('# ADR-1\n\n## Context\n\nProse.\n')).toBeUndefined();
  });
});

describe('a status written in Chinese', () => {
  // The family's table: each Chinese word is read as the English word it
  // translates, in Traditional and in Simplified, and the English then does
  // what it does here (ADR-0010's amendment of 2026-09-30). Every word of it,
  // by the English it is read as.
  const TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['superseded', ['已被取代', '被取代', '已取代']],
    ['deprecated', ['已棄用', '棄用', '已廢棄', '廢棄', '已停用', '已過時', '已弃用', '弃用', '已废弃', '废弃', '已过时']],
    ['rejected', ['已否決', '否決', '已拒絕', '不採納', '已否决', '否决', '已拒绝', '不采纳']],
    ['withdrawn', ['已撤回', '撤回', '已作廢', '作廢', '已作废', '作废']],
    ['deferred', ['延後', '暫緩', '擱置', '延后', '暂缓', '搁置']],
    ['archived', ['封存', '已封存', '歸檔', '已歸檔', '归档', '已归档']],
    ['final', ['已定案', '定案', '已凍結', '已冻结']],
    ['provisionally', ['暫定', '暂定']],
    ['accepted', ['已接受', '接受', '已採納', '採納', '已核准', '核准', '已批准', '批准', '已生效', '生效', '已采纳', '采纳']],
    ['implemented', ['已實施', '已完成', '已实施']],
    ['draft', ['草稿', '草案']],
    ['proposed', ['提議', '提案', '審查中', '審核中', '討論中', '待審', '待審核', '提议', '审查中', '审核中', '讨论中', '待审', '待审核']],
  ];
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, message }) => [location.line, message]);

  it.each(TABLE)('reads the words for %s as it, and withholds a document only if it is one of the six', (english, words) => {
    for (const word of words) {
      const expected = { value: english, label: word, source: 'heading', active: !INACTIVE_STATUSES.has(english) };
      expect(parseStatus(`# ADR-1\n\n## Status\n\n${word}\n`), word).toEqual(expected);
      // Followed by punctuation, a date in brackets, or in bold, it is the same word.
      expect(parseStatus(`# ADR-1\n\n## Status\n\n${word}（2024-05-01）。\n`)?.value, word).toBe(english);
      expect(parseStatus(`# ADR-1\n\n## Status\n\n**${word}**\n`), word).toEqual(expected);
    }
  });

  it('keeps in force a document whose word is none of the six, as the English keeps it', () => {
    expect(parseStatus('# ADR-1\n\n## Status\n\n延後\n')).toMatchObject({ value: 'deferred', active: true });
    expect(parseStatus('# ADR-1\n\n## Status\n\n已撤回\n')).toMatchObject({ value: 'withdrawn', active: true });
    expect(parseStatus('# ADR-1\n\n## Status\n\n暫定\n')).toMatchObject({ value: 'provisionally', active: true });
    expect(parseStatus('# ADR-1\n\n## Status\n\n封存\n')).toMatchObject({ value: 'archived', active: false });
  });

  it('reads only a word followed by a space, punctuation or the end, so a longer word is no word listed', () => {
    for (const text of ['草稿已核准', '暫定接受', '接受度', '被 ADR-3 取代了', '已接受了']) {
      expect(parseStatus(`# ADR-1\n\n## Status\n\n${text}\n`), text).toBeUndefined();
    }
    expect(parseStatus('# ADR-1\n\n## Status\n\n已接受 (Accepted)\n')?.value).toBe('accepted');
    expect(parseStatus('# ADR-1\n\n## Status\n\n已接受\t2024\n')?.value).toBe('accepted');
  });

  it('reads 被 and a verb of superseding within thirty characters as superseded', () => {
    // A negation elsewhere than before the verb is part of what superseded it.
    for (const text of ['被 ADR-0003 取代', '已被 ADR-0003 取代', '被 ADR-0003 替代', '被 ADR-0003 取而代之', `被${'x'.repeat(30)}取代`, '被不同的 ADR-3 取代']) {
      expect(parseStatus(`# ADR-1\n\n## Status\n\n${text}\n`), text).toMatchObject({ value: 'superseded', label: text, active: false });
    }
    expect(parseStatus(`# ADR-1\n\n## Status\n\n被${'x'.repeat(31)}取代\n`)).toBeUndefined();
    // Without 被, 取代 says what this document supersedes, and is no retirement.
    expect(parseStatus('# ADR-1\n\n## Status\n\n已接受（取代 ADR-0002）\n')).toMatchObject({ value: 'accepted', active: true });
    expect(parseStatus('# ADR-1\n\n## Status\n\n取代 ADR-0002\n')).toBeUndefined();
  });

  it('does not read a negation, or 已取代 before a document reference, and says why', () => {
    const said = (reason: string) =>
      `the status under the heading "Status" cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written elsewhere in the document is not read in its place`;
    // Nor a word or 被 that does not begin the value.
    for (const text of ['未接受', '尚未核准', '不再生效', '非草稿', '被 ADR-0003 未取代', '被 ADR-0003 尚未取代', '被 ADR-0003 不再取代', '進行中', '進行，草稿', '此決議已被 X 取代']) {
      expect(warningOf(`# ADR-1\n\n## Status\n\n${text}\n`), text).toEqual([[5, said(`"${text}" does not begin with a status word spec-guard reads`)]]);
    }
    // A word the table lists that begins with a negation is that word.
    expect(parseStatus('# ADR-1\n\n## Status\n\n不採納\n')?.value).toBe('rejected');
    for (const text of ['已取代 ADR-0002', '已取代：ADR-0002', '已取代: adr-2', '已取代 0002', '已取代　RFC 7']) {
      expect(warningOf(`# ADR-1\n\n## Status\n\n${text}\n`), text).toEqual([[5, said('"已取代" before a document reference names the document this one supersedes, not this one\'s status')]]);
    }
    // Around anything else it is superseded.
    for (const text of ['已取代', '已取代。', '已取代（見 ADR-0003）', '**已取代**', '已取代 - 見下']) {
      expect(parseStatus(`# ADR-1\n\n## Status\n\n${text}\n`)?.value, text).toBe('superseded');
    }
  });

  it('reads the key in Chinese wherever it reads status: a heading, a label, front matter', () => {
    expect(parseStatus('# ADR-1\n\n## 狀態\n\n已取代\n')).toEqual({ value: 'superseded', label: '已取代', source: 'heading', active: false });
    expect(parseStatus('# ADR-1\n\n## 状态\n\n草稿\n')).toMatchObject({ value: 'draft', source: 'heading' });
    for (const line of ['狀態：已取代', '狀態: 已取代', '状态：已取代', '**狀態：** 已取代', '**狀態**：已取代', '__状态__: 已取代']) {
      expect(parseStatus(`# ADR-1\n\n${line}\n\n## Context\n`), line).toMatchObject({ value: 'superseded', source: 'label' });
    }
    expect(parseStatus('---\n狀態: 已取代\n---\n\n## Status\n\nAccepted\n')).toEqual({ value: 'superseded', label: '已取代', source: 'frontmatter', active: false });
    expect(parseStatus('---\ntitle: x\n状态：草稿 # 審查後改\n---\n')).toMatchObject({ value: 'draft', source: 'frontmatter' });
    expect(parseStatus('---\n狀態: "已棄用"\n---\n')).toMatchObject({ value: 'deprecated' });
    expect(parseStatus('---\n狀態 : 已棄用\n---\n')).toMatchObject({ value: 'deprecated' });
    expect(parseStatus('+++\n"狀態" = "已棄用"\n+++\n')).toMatchObject({ value: 'deprecated', source: 'frontmatter' });
    // An English status is read as it was, in any spelling, with a Chinese key or without.
    expect(parseStatus('# ADR-1\n\n狀態：Accepted\n')).toMatchObject({ value: 'accepted', source: 'label' });
    expect(parseStatus('---\nstatus: 已取代\n---\n')).toMatchObject({ value: 'superseded', source: 'frontmatter' });
  });

  it('lets front matter\'s status key decide before its Chinese one, and reads the Chinese one as that key is read', () => {
    expect(parseStatus('---\n狀態: 草稿\nstatus: accepted\n---\n')?.value).toBe('accepted');
    const said = (reason: string) =>
      `the status in front matter cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place`;
    expect(warningOf('---\n狀態:\n---\n\n## Status\n\nDraft\n')).toEqual([[2, said('it is empty')]]);
    expect(warningOf('---\n狀態: # 待定\n---\n')).toEqual([[2, said('it is empty')]]);
    expect(warningOf('---\n狀態: [草稿]\n---\n')).toEqual([[2, said('a list is not a status')]]);
    expect(warningOf('---\n狀態:\n  草稿\n---\n')).toEqual([[2, said('the value continues on the next line; keep it on one line, or quote it')]]);
    expect(warningOf('---\n狀態: "已取代" 2024\n---\n')).toEqual([[2, said('text follows a closing quote')]]);
    expect(warningOf('---\n狀態: 進行中\n---\n')).toEqual([[2, said('"進行中" does not begin with a status word spec-guard reads')]]);
    // Not the key: under another key, or with no space after YAML's colon.
    expect(parseStatus('---\nmeta:\n  狀態: 草稿\n---\n')).toBeUndefined();
    expect(parseStatus('---\n狀態:草稿\n---\n')).toBeUndefined();
    expect(parseStatus('---\n狀態碼: 草稿\n---\n')).toBeUndefined();
  });

  it('withholds a document a Chinese word takes out of force, and names it by its line as written', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## 狀態\n\n已被 ADR-0003 取代\n\n${VIOLATION}`,
      'docs/b.md': `# ADR-2\n\n狀態：延後\n\n${VIOLATION}`,
      ...CODE,
    });
    const report = await run(root);
    expect(report.summary).toMatchObject({ total: 1, failed: 1, inactive: 1 });
    expect(report.inactiveSpecs).toEqual([{ file: 'docs/a.md', status: 'superseded', label: '已被 ADR-0003 取代', directives: 1 }]);
    expect(formatReport(report, { color: false, verbose: false })).toContain('○ docs/a.md is 已被 ADR-0003 取代 - 1 assertion not executed');
  });
});

describe('a status given in a table', () => {
  // A table of two columns in the preamble whose left cell names the status
  // (the family's decision; ADR-0010's amendment of 2026-09-30).
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, message }) => [location.line, message]);

  it('reads the row that names the status, the header row among them', () => {
    expect(parseStatus('# ADR-1\n\n| 狀態 | 已接受 |\n| --- | --- |\n\n## Context\n')).toEqual({ value: 'accepted', label: '已接受', source: 'table', active: true });
    expect(parseStatus('# ADR-1\n\n| Field | Value |\n| --- | --- |\n| Date | 2024-05-01 |\n| Status | Superseded by ADR-3 |\n\n## Context\n')).toEqual({
      value: 'superseded',
      label: 'Superseded by ADR-3',
      source: 'table',
      active: false,
    });
    for (const key of ['**Status**', 'STATE', 'state', '状态', '__狀態__', '*Status*']) {
      expect(parseStatus(`# ADR-1\n\n| ${key} | draft |\n| :-- | --: |\n`)?.value, key).toBe('draft');
    }
  });

  it('reads no table of more columns, none after the first section, and no cell that only begins with the key', () => {
    expect(parseStatus('# ADR-1\n\n| Status | Draft | Note |\n| --- | --- | --- |\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n| Status |\n| --- |\n| Draft |\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n## Context\n\n| Status | Draft |\n| --- | --- |\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n| Status of the migration | Draft |\n| --- | --- |\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n| `Status` | Draft |\n| --- | --- |\n')).toBeUndefined();
    // A register of other documents names theirs, in a column of its own.
    expect(parseStatus('# ADRs\n\n| ADR | Status |\n| --- | --- |\n| 0001 | Superseded |\n')).toBeUndefined();
    expect(parseStatus('# ADR-1\n\n```md\n| Status | Draft |\n| --- | --- |\n```\n')).toBeUndefined();
    // A table in the preamble of a document with no section is read.
    expect(parseStatus('# ADR-1\n\nIntro.\n\n| Status | Draft |\n| --- | --- |\n')?.value).toBe('draft');
  });

  it('ranks where the section does: after front matter and the section, before the label', () => {
    const table = '| Status | Draft |\n| --- | --- |\n';
    expect(parseStatus(`---\nstatus: accepted\n---\n\n# ADR-1\n\n${table}`)).toMatchObject({ value: 'accepted', source: 'frontmatter' });
    expect(parseStatus(`# ADR-1\n\n${table}\n## Status\n\nAccepted\n`)).toMatchObject({ value: 'accepted', source: 'heading' });
    expect(parseStatus(`# ADR-1\n\nStatus: accepted\n\n${table}`)).toMatchObject({ value: 'draft', source: 'table' });
    // The first table that names it decides.
    expect(parseStatus(`# ADR-1\n\n${table}\n| Status | Accepted |\n| --- | --- |\n`)?.value).toBe('draft');
  });

  it('keeps its document in force when its value cannot be read, says so on its row, and reads no label in its place', () => {
    const said = (reason: string) =>
      `the status in the table cannot be read (${reason}), so its status is unrecognised and the document stays in force; a status written elsewhere in the document is not read in its place`;
    const source = '# ADR-1\n\nStatus: draft\n\n| Field | Value |\n| --- | --- |\n| Status | 2024-05-01 |\n';
    expect(parseStatus(source)).toBeUndefined();
    expect(warningOf(source)).toEqual([[7, said('"2024-05-01" does not begin with a word')]]);
    expect(warningOf('# ADR-1\n\n| Status | `draft` |\n| --- | --- |\n')).toEqual([[3, said('it is empty')]]);
    expect(warningOf('# ADR-1\n\n| Field | Value |\n| --- | --- |\n| Status |\n')).toEqual([[5, said('it is empty')]]);
    expect(warningOf('# ADR-1\n\n| 狀態 | 已取代 ADR-0002 |\n| --- | --- |\n')).toEqual([
      [3, said('"已取代" before a document reference names the document this one supersedes, not this one\'s status')],
    ]);
  });

  it('withholds the rules of a document its table takes out of force', async () => {
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n| 狀態 | 已棄用 |\n| --- | --- |\n\n## Context\n\n${VIOLATION}`, ...CODE });
    const report = await run(root);
    expect(report.summary).toMatchObject({ total: 0, inactive: 1 });
    expect(report.inactiveSpecs).toEqual([{ file: 'docs/a.md', status: 'deprecated', label: '已棄用', directives: 1 }]);
  });
});

describe('front matter never closed', () => {
  // A first line of `---` or `+++` that nothing closes opens no front matter,
  // but its author wrote some, and what it says cannot be read: the status is
  // unrecognised and the document stays in force, as with a front-matter
  // status the reader refuses (ADR-0010, amended 2026-09-29). 0.13.0 read it
  // as a document with none, so the section or the label decided, and
  // `status: accepted` above a section still saying `Proposed` was withheld.
  const context = { file: '/r/docs/a.md', relativeFile: 'docs/a.md' };
  const warningOf = (source: string) => parseDocument(source, context).warnings?.map(({ location, kind, message }) => [location.line, kind, message]);
  const said = (delimiter: string) =>
    `the front matter opened here with ${delimiter} is never closed, so none of it is read as front matter, its status is unrecognised and the document stays in force; a status written below the front matter is not read in its place; close it with ${delimiter} on a line of its own`;
  const SUPERSEDED_ABOVE_ACCEPTED = '---\nstatus: superseded\n\n# ADR-1\n\n## Status\n\nAccepted\n';
  const ACCEPTED_ABOVE_PROPOSED = '---\nstatus: accepted\n\n# ADR-2\n\n## Status\n\nProposed\n';

  it('is a warning on the line it opened on, for YAML and for TOML, saying the document stays in force and how to close it', () => {
    expect(warningOf(SUPERSEDED_ABOVE_ACCEPTED)).toEqual([[1, 'unclosed-front-matter', said('---')]]);
    expect(warningOf(ACCEPTED_ABOVE_PROPOSED)).toEqual([[1, 'unclosed-front-matter', said('---')]]);
    expect(warningOf('+++\nstatus = "draft"\n\n# ADR-1\n')).toEqual([[1, 'unclosed-front-matter', said('+++')]]);
    // Behind a byte-order mark and with CRLF endings the first line is still line 1.
    expect(warningOf(`${String.fromCharCode(0xfeff)}---\r\nstatus: draft\r\n\r\n# ADR-1\r\n`)).toEqual([[1, 'unclosed-front-matter', said('---')]]);
  });

  it('leaves the status unrecognised, so neither the section nor the label is read in its place', () => {
    // Each of these was read from the prose - the section's word, or a label
    // in the preamble, which may be the block's own `status:` line - and all
    // but the first were withheld by it.
    for (const source of [
      SUPERSEDED_ABOVE_ACCEPTED,
      ACCEPTED_ABOVE_PROPOSED,
      '---\nstatus: superseded\n# ADR-1\n',
      '---\ntitle: ADR-1\n\n# ADR-1\n\n**Status:** draft\n',
      '+++\nstatus = "accepted"\n\n# ADR-1\n\n## Status\n\nProposed\n',
      `${String.fromCharCode(0xfeff)}---\r\nstatus: draft\r\n\r\n# ADR-1\r\n`,
    ]) {
      expect(parseStatus(source), source).toBeUndefined();
    }
  });

  it('reads the directives under its opening line, as it did', () => {
    // None of it is front matter, so a directive there is a directive and is
    // not counted among those front matter hides.
    const document = parseDocument(`---\n${VIOLATION}\n# ADR-1\n`, context);
    expect(document.directives.map(({ location }) => location.line)).toEqual([2]);
    expect(document.masked).toBeUndefined();
  });

  it('reads the status as before where front matter closes, where there is none, and where a `---` comes further down', () => {
    expect(parseStatus('---\nstatus: accepted\n---\n\n# ADR-2\n\n## Status\n\nProposed\n')).toMatchObject({ value: 'accepted', source: 'frontmatter' });
    expect(parseStatus('---\nstatus: draft\n...\n\n# ADR-1\n')).toMatchObject({ value: 'draft', source: 'frontmatter' });
    // A first line of `---` closed by the next is front matter with no status in it, which hands over.
    expect(parseStatus('---\n---\n\n# ADR-2\n\n## Status\n\nProposed\n')).toMatchObject({ value: 'proposed', source: 'heading' });
    expect(parseStatus('# ADR-2\n\n## Status\n\nProposed\n')).toMatchObject({ value: 'proposed', source: 'heading' });
    // A `---` further down, in a document with no front matter, is a thematic break, and the line under it prose.
    expect(parseStatus('# ADR-1\n\nContext.\n\n---\n\nstatus: draft\n')).toMatchObject({ value: 'draft', source: 'label' });
  });

  it('is no warning for front matter that closes, for none, or for a first line with nothing after it', () => {
    expect(warningOf('---\nstatus: draft\n---\n\n# ADR-1\n')).toBeUndefined();
    expect(warningOf('---\nstatus: draft\n...\n\n# ADR-1\n')).toBeUndefined();
    expect(warningOf('+++\nstatus = "draft"\n+++\n\n# ADR-1\n')).toBeUndefined();
    // A first line of `---` closed by the next is front matter with nothing in it.
    expect(warningOf('---\n---\n\n# ADR-1\n')).toBeUndefined();
    // A `---` further down, in a document with no front matter, is a thematic break.
    expect(warningOf('# ADR-1\n\nContext.\n\n---\n\nstatus: draft\n')).toBeUndefined();
    expect(warningOf('# ADR-1\n\n## Status\n\nAccepted\n')).toBeUndefined();
    // Nothing after the opening line: there is no front matter to have lost.
    expect(warningOf('---\n')).toBeUndefined();
    expect(warningOf('---\n\n  \n')).toBeUndefined();
  });

  it('comes before a block never closed, in the order they are in the document', () => {
    expect(warningOf('---\nstatus: draft\n\n# ADR-1\n\n```sh\nnpm test\n')?.map(([line, kind]) => [line, kind])).toEqual([
      [1, 'unclosed-front-matter'],
      [6, 'unclosed-block'],
    ]);
  });

  it('runs the rules the prose alone would have withheld, and says why in every format', async () => {
    const root = await repo({
      'docs/a.md': `${SUPERSEDED_ABOVE_ACCEPTED}\n${VIOLATION}`,
      'docs/b.md': `${ACCEPTED_ABOVE_PROPOSED}\n${VIOLATION}`,
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({ total: 2, failed: 2, inactive: 0 });
    expect(report.inactiveSpecs).toEqual([]);
    expect(report.specWarnings?.map(({ location, kind }) => [location.relativeFile, location.line, kind])).toEqual([
      ['docs/a.md', 1, 'unclosed-front-matter'],
      ['docs/b.md', 1, 'unclosed-front-matter'],
    ]);

    const human = formatReport(report, { color: false, verbose: false });
    expect(human).toContain(`⚠ docs/a.md:1  ${said('---')}`);
    expect(human).toContain(`⚠ docs/b.md:1  ${said('---')}`);
    expect(human).not.toContain('docs/b.md is Proposed');
    expect(human).not.toContain('not in force');
    const json = JSON.parse(formatJson(report)) as { summary: { inactive: number }; inactiveSpecs: unknown; specWarnings: unknown };
    expect(json.summary.inactive).toBe(0);
    expect(json.inactiveSpecs).toEqual([]);
    expect(json.specWarnings).toEqual([
      { spec: { file: 'docs/a.md', line: 1, column: 1 }, kind: 'unclosed-front-matter', message: said('---') },
      { spec: { file: 'docs/b.md', line: 1, column: 1 }, kind: 'unclosed-front-matter', message: said('---') },
    ]);
    const sarif = JSON.parse(formatSarif(report)) as { runs: Array<{ invocations?: Array<{ toolExecutionNotifications: unknown }> }> };
    expect(sarif.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual([
      { level: 'warning', message: { text: `docs/a.md:1 ${said('---')}` } },
      { level: 'warning', message: { text: `docs/b.md:1 ${said('---')}` } },
    ]);
    expect(runAnnotations(report).filter(({ rule }) => rule === 'spec-warning' || rule === 'not-in-force')).toEqual([
      { rule: 'spec-warning', identity: ['spec-warning', 'docs/a.md', 'unclosed-front-matter'], level: 'warning', severity: 'minor', file: 'docs/a.md', line: 1, message: said('---') },
      { rule: 'spec-warning', identity: ['spec-warning', 'docs/b.md', 'unclosed-front-matter'], level: 'warning', severity: 'minor', file: 'docs/b.md', line: 1, message: said('---') },
    ]);
  });

  it('runs a rule under TOML its section would have withheld, fails nothing from the command line, --strict included, and is in its --json', async () => {
    const root = await repo({ 'docs/a.md': '+++\nstatus = "accepted"\n\n# ADR-1\n\n## Status\n\nProposed\n\n<!-- @assert-absence target="src" symbol="Nowhere" -->\n', ...CODE });
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: { NO_COLOR: '1' }, cwd: root, isTTY: false };

    expect(await main(['docs/a.md', '--engine', 'js', '--strict'], io)).toBe(EXIT_OK);
    const human = out.join('\n');
    expect(human).toContain(`docs/a.md:1  ${said('+++')}`);
    expect(human).toContain('1 passed');
    expect(human).not.toContain('not in force');
    out.length = 0;
    expect(await main(['docs/a.md', '--engine', 'js', '--strict', '--json'], io)).toBe(EXIT_OK);
    const json = JSON.parse(out.join('\n')) as { summary: unknown; inactiveSpecs: unknown; specWarnings: unknown };
    expect(json.summary).toMatchObject({ total: 1, passed: 1, inactive: 0 });
    expect(json.inactiveSpecs).toEqual([]);
    expect(json.specWarnings).toEqual([{ spec: { file: 'docs/a.md', line: 1, column: 1 }, kind: 'unclosed-front-matter', message: said('+++') }]);
  });
});

describe('which words withhold a document', () => {
  it('is exactly these six', () => {
    // Written out rather than derived. Every word here is another way for a
    // rule to stop being enforced, so the list growing is a decision someone
    // has to make on purpose and a reviewer gets to see in a diff. It grew
    // once, by `archived`, and ADR-0010's amendment says why that word and no
    // other.
    expect([...INACTIVE_STATUSES].sort()).toEqual([
      'archived',
      'deprecated',
      'draft',
      'proposed',
      'rejected',
      'superseded',
    ]);
  });

  it('withholds an archived brief, and nothing merely near the word', () => {
    // `archived` is what spec-brief writes when it closes a round. The words
    // around it are ones a live document can carry - a brief that is `done`
    // is the one whose rules about the finished state should start holding -
    // so they stay in force, like every word nobody decided about.
    expect(parseStatus('---\nid: 0042\nstatus: archived\n---\n\n# Brief 0042\n')).toEqual({
      value: 'archived',
      label: 'archived',
      source: 'frontmatter',
      active: false,
    });
    expect(parseStatus('## Status\n\nArchived on 2026-09-26.\n')?.active).toBe(false);
    for (const word of ['archive', 'Archival', 'unarchived', 'done', 'closed', 'complete', 'obsolete', 'inactive']) {
      expect(parseStatus(`---\nstatus: ${word}\n---\n`)?.active, word).toBe(true);
    }
  });

  it('leaves an unrecognised word in force', () => {
    // The direction of the failure is the whole point. A word nobody
    // anticipated - "In review", "Provisional", or `Supersedded` with the
    // typo - must keep enforcing, because the other direction turns a
    // misspelling into a silently disabled rule.
    for (const word of ['In review.', 'Provisional', 'Supersedded', 'Accepted']) {
      expect(parseStatus(`## Status\n\n${word}\n`)?.active).toBe(true);
    }
    for (const word of [...INACTIVE_STATUSES]) {
      expect(parseStatus(`## Status\n\n${word}\n`)?.active).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------- the run */

describe('a document that is not in force', () => {
  it('does not execute its directives, and they would have failed', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nProposed.\n\n${VIOLATION}`,
      ...CODE,
    });

    const withheld = await run(root);
    expect(withheld.ok).toBe(true);
    expect(withheld.results).toEqual([]);
    expect(withheld.summary).toMatchObject({ specs: 1, total: 0, inactive: 1 });

    // The control, and the reason this test means anything: the same directive
    // over the same tree is a live failure. What the status suppressed was a
    // violation, not an empty rule.
    const executed = await run(root, ['docs/*.md'], { ignoreStatus: true });
    expect(executed.ok).toBe(false);
    expect(executed.summary).toMatchObject({ total: 1, failed: 1, inactive: 0 });
    expect(executed.inactiveSpecs).toEqual([]);
  });

  it('does not execute an archived brief, and --ignore-status does', async () => {
    // A closed round's brief: its premise ("Legacy is still here") was true
    // when the round opened and the round made it false. Executed, it fails.
    const root = await repo({
      'briefs/archive/0042-retire-legacy.md': `---\nid: 0042\nstatus: archived\n---\n\n# Retire Legacy\n\n${VIOLATION}`,
      ...CODE,
    });

    const withheld = await run(root, ['briefs/**/*.md']);
    expect(withheld.ok).toBe(true);
    expect(withheld.summary).toMatchObject({ specs: 1, total: 0, inactive: 1 });
    expect(withheld.inactiveSpecs).toEqual([
      { file: 'briefs/archive/0042-retire-legacy.md', status: 'archived', label: 'archived', directives: 1 },
    ]);

    const executed = await run(root, ['briefs/**/*.md'], { ignoreStatus: true });
    expect(executed.ok).toBe(false);
    expect(executed.summary).toMatchObject({ total: 1, failed: 1, inactive: 0 });
  });

  it('is named in the report, with the line it declared and what it cost', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nSuperseded by ADR-0007.\n\n${VIOLATION}${VIOLATION}`,
      ...CODE,
    });

    const report = await run(root);

    expect(report.inactiveSpecs).toEqual([
      { file: 'docs/a.md', status: 'superseded', label: 'Superseded by ADR-0007.', directives: 2 },
    ]);
    expect(report.summary.inactive).toBe(2);
  });

  it('is named even when it held no directives', async () => {
    // "docs/adr/0011.md is a draft" is the answer to "why is my new rule doing
    // nothing", and a report that only mentions documents it found directives
    // in cannot give it.
    const root = await repo({ 'docs/a.md': '# ADR-1\n\n## Status\n\nDraft\n\nNo rules yet.\n' });

    const report = await run(root);

    expect(report.inactiveSpecs).toEqual([
      { file: 'docs/a.md', status: 'draft', label: 'Draft', directives: 0 },
    ]);
    expect(report.summary.inactive).toBe(0);
    expect(formatReport(report, { color: false, verbose: false })).toContain(
      'docs/a.md is Draft - no directives to execute',
    );
  });

  it('is still held to being well-formed', async () => {
    // Not in force is not the same as not checked. A draft's typo found on the
    // day it is written costs a minute; found on the day the ADR is accepted,
    // it is found after everyone has agreed the rule is right and stopped
    // looking at it.
    const root = await repo({
      'docs/a.md': '# ADR-1\n\n## Status\n\nDraft\n\n<!-- @assert-absence target="src" sybmol="Legacy" -->\n',
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message).toContain('sybmol');
    // The count still reflects that nothing ran: an invalid directive is not
    // an executed one.
    expect(report.summary.total).toBe(0);
  });

  it('reports a resolution error too, not only a parse error', async () => {
    // Resolution is the second half of well-formed: bad numbers, absolute
    // paths, `..` escapes. It happens before any I/O, so it costs a draft
    // nothing to be held to it.
    const root = await repo({
      'docs/a.md': '# ADR-1\n\n## Status\n\nProposed\n\n<!-- @assert-count target="src" symbol="L" min="5" max="2" -->\n',
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.errors[0]?.message).toContain('greater than');
  });

  it('counts an invalid directive once, as invalid, and not again as a rule not in force', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n<!-- @assert-count target="src" symbol="L" min="5" max="2" -->\n${VIOLATION}`,
      'docs/b.md': '# ADR-2\n\n## Status\n\nProposed\n\n<!-- @assert-absence target="src" symbol="L" glob="src/**.ts" -->\n',
      ...CODE,
    });

    const report = await run(root);

    expect(report.errors).toHaveLength(2);
    expect(report.summary).toMatchObject({ total: 0, inactive: 1 });
    expect(report.inactiveSpecs.map(({ file, directives }) => [file, directives])).toEqual([
      ['docs/a.md', 1],
      ['docs/b.md', 0],
    ]);
    expect(formatReport(report, { color: false, verbose: false }).split('\n').at(-1)).toMatch(/^0 passed · 2 invalid · 1 not in force · (?:\d+ms|\d+\.\d{2}s)$/);
  });

  it('leaves every other document in the run alone', async () => {
    const root = await repo({
      'docs/dead.md': `# ADR-1\n\n## Status\n\nSuperseded.\n\n${VIOLATION}`,
      'docs/live.md': `# ADR-2\n\n## Status\n\nAccepted.\n\n${VIOLATION}`,
      ...CODE,
    });

    const report = await run(root);

    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({ specs: 2, total: 1, failed: 1, inactive: 1 });
    expect(report.inactiveSpecs.map((spec) => spec.file)).toEqual(['docs/dead.md']);
  });

  it('is still excluded from the searches the live documents run', async () => {
    // Self-exclusion is about a document containing the symbol it forbids, and
    // that is as true of a superseded document as of an accepted one. If
    // withholding a document also dropped it from the exclusion set, every
    // rule naming a symbol a retired ADR mentions would start failing.
    const root = await repo({
      'docs/dead.md': '# ADR-1\n\n## Status\n\nSuperseded.\n\n<!-- @assert-absence target="src" symbol="Ghost" -->\n',
      'docs/live.md': '# ADR-2\n\n<!-- @assert-absence target="." symbol="Ghost" -->\n',
      'src/app.ts': 'const ok = 1;\n',
    });

    const report = await run(root);

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, passed: 1, inactive: 1 });
  });
});

/* ------------------------------------------------------------- the report */

describe('how withholding is reported', () => {
  it('names the document and its status in the human report', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nSuperseded by ADR-0007.\n\n${VIOLATION}`,
      ...CODE,
    });
    const report = await run(root);

    const text = formatReport(report, { color: false, verbose: false });

    // The blank line is part of the assertion: with the separator gone the
    // withheld list runs into the totals, and with a stray line inserted it
    // no longer reads as one block. Both are invisible to a `toContain` on
    // the sentence alone.
    expect(text).toContain(
      '○ docs/a.md is Superseded by ADR-0007. - 1 assertion not executed\n\n0 passed',
    );
    expect(text).toContain('1 not in force');
  });

  it('is dimmed, not shouted, when colour is on', async () => {
    // Withholding is information, not a failure. It is painted like the
    // skipped count next to it rather than like a warning - and a colour
    // nobody asserts is a colour that can be dropped.
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft.\n\n${VIOLATION}`, ...CODE });

    const text = formatReport(await run(root), { color: true, verbose: false });

    expect(text).toContain(`${ESC}[2m○ docs/a.md is Draft. - 1 assertion not executed${ESC}[0m`);
    expect(text).toContain(`${ESC}[2m1 not in force${ESC}[0m`);
    expect(text).toContain(`${ESC}[33m⚠ no assertion was executed, so nothing was verified${ESC}[0m`);
  });

  it('has an ASCII glyph for the consoles that cannot draw the other one', async () => {
    // Legacy Windows consoles render `○` as a box. Every other glyph in the
    // report has an ASCII twin; a new one without a test is a line that
    // degrades to a leading space nobody notices is missing.
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft.\n\n${VIOLATION}`, ...CODE });

    const text = formatReport(await run(root), { color: false, verbose: false, ascii: true });

    expect(text).toContain('o docs/a.md is Draft. - 1 assertion not executed');
  });

  it('refuses to call a run that executed nothing a run in which everything holds', async () => {
    // "Every spec assertion holds" over zero assertions is true, useless, and
    // the exact sentence someone reads as proof their specification is being
    // enforced.
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n${VIOLATION}`, ...CODE });
    const report = await run(root);

    const text = formatReport(report, { color: false, verbose: false });

    expect(report.ok).toBe(true);
    expect(text).toContain('no assertion was executed, so nothing was verified');
    expect(text).not.toContain('every spec assertion holds');

    // The control: one live assertion and the usual sentence comes back.
    const live = await repo({ 'docs/a.md': VIOLATION, 'src/app.ts': 'const ok = 1;\n' });
    expect(formatReport(await run(live), { color: false, verbose: false })).toContain(
      'every spec assertion holds',
    );
  });

  it('carries the withheld documents in the JSON report', async () => {
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n${VIOLATION}`, ...CODE });

    const json = JSON.parse(formatJson(await run(root))) as {
      summary: { inactive: number };
      inactiveSpecs: Array<{ file: string; status: string }>;
    };

    expect(json.summary.inactive).toBe(1);
    expect(json.inactiveSpecs).toEqual([
      { file: 'docs/a.md', status: 'draft', label: 'Draft', directives: 1 },
    ]);
  });

  it('tells a code-scanning service, which otherwise sees a clean page', async () => {
    // SARIF carries results, and a withheld rule produces none. Left there,
    // a repository whose ADRs had all gone dormant would show green. The
    // standard's own answer is an execution notification.
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n${VIOLATION}`, ...CODE });

    const sarif = JSON.parse(formatSarif(await run(root))) as {
      runs: Array<{ invocations?: Array<{ toolExecutionNotifications: Array<{ level: string; message: { text: string } }> }> }>;
    };
    const notifications = sarif.runs[0]?.invocations?.[0]?.toolExecutionNotifications ?? [];

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe('note');
    expect(notifications[0]?.message.text).toBe('docs/a.md is Draft, so its 1 assertion was not executed.');

    // A result a caller built may leave out its spec warnings, which are
    // optional, and says just as much about what it withheld.
    const built: RunResult = { ...(await run(root)) };
    delete built.specWarnings;
    const older = JSON.parse(formatSarif(built)) as typeof sarif;
    expect(older.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual(notifications);

    // Both sides of the count, because one of them is a hardcoded "1" away
    // from being wrong in a way a singular-only test cannot see.
    const two = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n${VIOLATION}${VIOLATION}`,
      ...CODE,
    });
    const plural = JSON.parse(formatSarif(await run(two))) as typeof sarif;
    expect(plural.runs[0]?.invocations?.[0]?.toolExecutionNotifications[0]?.message.text).toBe(
      'docs/a.md is Draft, so its 2 assertions were not executed.',
    );

    // The control: nothing withheld, no invocations block at all.
    const live = await repo({ 'docs/a.md': VIOLATION, 'src/app.ts': 'const ok = 1;\n' });
    expect(JSON.parse(formatSarif(await run(live))).runs[0].invocations).toBeUndefined();
  });
});

/* ------------------------------------------------ a strict run that verified nothing */

describe('a run under --strict that verified nothing', () => {
  // The family contract: a check that measured nothing is not clean, and a
  // strict one refuses (spec-core's ADR-0005). Every format and the exit code
  // say the same thing; ADR-0010's amendment of 2026-09-30.
  const REFUSED = 'no assertion was executed, so nothing was verified, which --strict refuses';
  const HINT = 'put a rule in force, or point the spec patterns at the documents that state the rules; --ignore-status also runs those of documents not in force';

  async function cli(root: string, argv: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const io: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: { NO_COLOR: '1', TERM: 'xterm' }, cwd: root, isTTY: false };
    return { code: await main([...argv, '--engine', 'js'], io), out: out.join('\n') };
  }

  it('fails, and says so the same way in every format', async () => {
    const root = await repo({ 'docs/a.md': `# ADR-1\n\n## Status\n\nDraft\n\n${VIOLATION}`, ...CODE });

    const human = await cli(root, ['docs/a.md', '--strict']);
    expect(human.code).toBe(EXIT_FAILED);
    expect(human.out.split('\n').at(-1)).toBe(`✖ ${REFUSED}`);
    expect(human.out).not.toContain('⚠ no assertion was executed');

    const json = await cli(root, ['docs/a.md', '--strict', '--json']);
    expect(json.code).toBe(EXIT_FAILED);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, nothingVerified: true, summary: { total: 0, failed: 0, inactive: 1 }, errors: [] });

    const gitlab = await cli(root, ['docs/a.md', '--strict', '--format', 'gitlab']);
    expect(gitlab.code).toBe(EXIT_FAILED);
    const issues = JSON.parse(gitlab.out) as Array<{ check_name: string; severity: string; description: string; location: unknown }>;
    expect(issues.map(({ check_name, severity, location }) => [check_name, severity, location])).toEqual([
      ['nothing-verified', 'major', { path: 'docs/a.md', lines: { begin: 1 } }],
      ['not-in-force', 'info', { path: 'docs/a.md', lines: { begin: 1 } }],
    ]);
    expect(issues[0]?.description).toBe(`${REFUSED}. ${HINT}`);

    const github = await cli(root, ['docs/a.md', '--strict', '--format', 'github']);
    expect(github.code).toBe(EXIT_FAILED);
    expect(github.out.split('\n')[0]).toBe(`::error file=docs/a.md,line=1,title=nothing-verified::${REFUSED}. ${HINT}`);

    const sarif = await cli(root, ['docs/a.md', '--strict', '--format', 'sarif']);
    expect(sarif.code).toBe(EXIT_FAILED);
    const run = (JSON.parse(sarif.out) as { runs: Array<{ results: Array<Record<string, unknown>>; invocations: Array<{ executionSuccessful: boolean }> }> }).runs[0];
    expect(run?.results).toEqual([
      {
        ruleId: 'nothing-verified',
        level: 'error',
        message: { text: `${REFUSED}. ${HINT}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'docs/a.md' }, region: { startLine: 1, startColumn: 1 } } }],
        relatedLocations: [],
        partialFingerprints: { specGuardAssertion: expect.stringMatching(/^[0-9a-f]{32}$/) },
      },
    ]);
    expect(run?.invocations[0]?.executionSuccessful).toBe(false);
  });

  it('is one GitLab issue whatever spec it is shown on, fingerprinted by its rule alone', async () => {
    // It is about the specs matched, not a line of one, so a spec added in
    // front of the first does not make it a new issue.
    const fingerprintOf = async (files: Record<string, string>): Promise<string[]> => {
      const report = await run(await repo({ ...files, ...CODE }), ['docs/*.md'], { strictTargets: true });
      return (JSON.parse(formatGitlab(runAnnotations(report))) as Array<{ check_name: string; fingerprint: string; location: { path: string } }>)
        .filter(({ check_name }) => check_name === 'nothing-verified')
        .map(({ fingerprint, location }) => `${location.path} ${fingerprint}`);
    };
    const expected = createHash('sha256').update('nothing-verified').digest('hex');
    expect(await fingerprintOf({ 'docs/b.md': '# Notes\n' })).toEqual([`docs/b.md ${expected}`]);
    expect(await fingerprintOf({ 'docs/a.md': '# More notes\n', 'docs/b.md': '# Notes\n' })).toEqual([`docs/a.md ${expected}`]);
  });

  it('fails when the configuration asks for strict, and passes when the command line says --no-strict', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ specGuard: { specs: ['docs/*.md'], strict: true } }),
      'docs/a.md': `# ADR-1\n\n## Status\n\nProposed\n\n${VIOLATION}`,
      ...CODE,
    });
    const strict = await cli(root, []);
    expect(strict.code).toBe(EXIT_FAILED);
    expect(strict.out.split('\n').at(-1)).toBe(`✖ ${REFUSED}`);
    const relaxed = await cli(root, ['--no-strict']);
    expect(relaxed.code).toBe(EXIT_OK);
    expect(relaxed.out.split('\n').at(-1)).toBe('⚠ no assertion was executed, so nothing was verified');
  });

  it('fails over specs that state no rule at all, and over rules that cannot be read', async () => {
    const root = await repo({ 'docs/a.md': '# Notes\n\nNo rules here.\n', 'docs/b.md': '<!-- @assert-count target="src" symbol="L" -->\n', ...CODE });
    const empty = await run(root, ['docs/a.md'], { strictTargets: true });
    expect([empty.ok, empty.nothingVerified]).toEqual([false, true]);
    // An invalid directive fails the run already; that it verified nothing is said beside it.
    const invalid = await run(root, ['docs/b.md'], { strictTargets: true });
    expect([invalid.ok, invalid.nothingVerified, invalid.errors.length]).toEqual([false, true, 1]);
    expect(runAnnotations(invalid).map(({ rule }) => rule)).toEqual(['invalid-directive', 'nothing-verified']);
  });

  it('passes with one rule in force, whatever else is withheld, and says nothing of it', async () => {
    // ADR-0010 refused to treat a withheld document as a strict failure, and
    // still does: only a run that verified nothing at all is refused.
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nSuperseded\n\n${VIOLATION}`,
      'docs/b.md': '# ADR-2\n\n<!-- @assert-absence target="src" symbol="Nowhere" -->\n',
      ...CODE,
    });
    const report = await run(root, ['docs/*.md'], { strictTargets: true });
    expect(report.ok).toBe(true);
    expect(report).not.toHaveProperty('nothingVerified');
    expect(JSON.parse(formatJson(report))).not.toHaveProperty('nothingVerified');
    expect(runAnnotations(report).map(({ rule }) => rule)).toEqual(['not-in-force']);
    expect((await cli(root, ['docs/*.md', '--strict'])).code).toBe(EXIT_OK);
  });

  it('is no concern of a selection that leaves out every rule there is, which verified what it was asked to', async () => {
    const root = await repo({ 'docs/a.md': VIOLATION, ...CODE });
    const none = await run(root, ['docs/a.md'], { strictTargets: true, select: () => false });
    expect([none.ok, none.summary.total]).toEqual([true, 0]);
    expect(none).not.toHaveProperty('nothingVerified');
    // A selection over no rule in force verified nothing because there was nothing.
    const withheld = await repo({ 'docs/a.md': `**Status:** draft\n\n${VIOLATION}`, ...CODE });
    const empty = await run(withheld, ['docs/a.md'], { strictTargets: true, select: () => false });
    expect([empty.ok, empty.nothingVerified]).toEqual([false, true]);
  });

  it('leaves a run that matched no spec to the command line, which refuses it unless --allow-empty says otherwise', async () => {
    const root = await repo({ ...CODE });
    expect((await cli(root, ['docs/*.md', '--strict'])).code).toBe(2);
    expect((await cli(root, ['docs/*.md', '--strict', '--allow-empty'])).code).toBe(EXIT_OK);
    const report = await run(root, ['docs/*.md'], { strictTargets: true });
    expect([report.ok, report.summary.specs]).toEqual([true, 0]);
  });
});

/* ---------------------------------------------------------------- the CLI */

describe('--ignore-status', () => {
  function createIO(root: string): { io: CliIO; out: string[] } {
    const out: string[] = [];
    return {
      out,
      io: { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: root, isTTY: false },
    };
  }

  it('is described by every word that withholds a document, in --help and in the README', async () => {
    // Both said "draft, proposed and superseded" for two releases after
    // rejected, deprecated and archived joined the list.
    const directives = HELP.slice(HELP.indexOf('\nDirectives\n'));
    const readme = await fs.readFile(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
    const row = readme.split('\n').find((line) => line.startsWith('| `--ignore-status`')) as string;
    for (const word of INACTIVE_STATUSES) {
      expect(directives, word).toContain(word);
      expect(row, word).toContain(word);
    }
    expect(HELP).toContain('--ignore-status     Execute directives in documents not in force too (see Directives)');
  });

  it('is off by default', () => {
    expect(parseArgs([], '/repo').ignoreStatus).toBe(false);
    expect(parseArgs(['--ignore-status'], '/repo').ignoreStatus).toBe(true);
  });

  it('reaches the run and changes the exit code', async () => {
    const root = await repo({
      'docs/a.md': `# ADR-1\n\n## Status\n\nProposed.\n\n${VIOLATION}`,
      ...CODE,
    });

    const honoured = createIO(root);
    expect(await main(['docs/a.md', '--root', root, '--engine', 'js'], honoured.io)).toBe(EXIT_OK);
    expect(honoured.out.join('\n')).toContain('not in force');

    const ignored = createIO(root);
    expect(
      await main(['docs/a.md', '--root', root, '--engine', 'js', '--ignore-status'], ignored.io),
    ).toBe(EXIT_FAILED);
    expect(ignored.out.join('\n')).not.toContain('not in force');
  });
});
