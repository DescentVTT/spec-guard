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

import { EXIT_FAILED, EXIT_OK, main, parseArgs, type CliIO } from '../src/cli.js';
import { INACTIVE_STATUSES, parseStatus } from '../src/parser.js';
import { formatJson, formatReport, formatSarif } from '../src/reporter.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

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
    // somebody drew rules around it. That is not front-matter; it is prose
    // that says what the prose form says.
    expect(parseStatus('# ADR-1\n\n---\nstatus: draft\n---\n\n## Context\n')).toMatchObject({
      value: 'draft',
      source: 'label',
    });
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

describe('which words withhold a document', () => {
  it('is exactly these five', () => {
    // Written out rather than derived. Every word here is another way for a
    // rule to stop being enforced, so the list growing is a decision someone
    // has to make on purpose and a reviewer gets to see in a diff.
    expect([...INACTIVE_STATUSES].sort()).toEqual([
      'deprecated',
      'draft',
      'proposed',
      'rejected',
      'superseded',
    ]);
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

/* ---------------------------------------------------------------- the CLI */

describe('--ignore-status', () => {
  function createIO(root: string): { io: CliIO; out: string[] } {
    const out: string[] = [];
    return {
      out,
      io: { stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: root, isTTY: false },
    };
  }

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
