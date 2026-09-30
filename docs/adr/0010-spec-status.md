# ADR-0010: Document lifecycle status, and why withholding is not passing

## Status

Accepted.

## Context

An ADR is not a rule file. It is a ledger entry, and it has a life:

```text
Proposed  ->  Accepted  ->  Superseded by ADR-0014
                        \->  Deprecated
```

Until now spec-guard executed every directive in every matched document,
whatever the document said about itself. Two things follow, and both are bad
enough to have kept teams from adopting the tool at all.

**A draft breaks the build.** Writing "here is the architecture I propose, and
here are the assertions that would enforce it" turns a proposal into a failing
CI run on a decision nobody has taken yet. The workaround people reach for is
to write the directives commented out, or in a fence, or not at all - and a
proposal whose rules were never executable is a proposal nobody can evaluate.

**A superseded ADR keeps enforcing.** The text stays in `docs/adr/` because
deleting it deletes the reason a decision was made; that is the entire premise
of the format. But its directives keep running, so the options are to gut the
historical record or to leave CI failing. Both destroy something.

The request that prompted this was phrased as a lifecycle feature. It is really
a request for a mechanism that stops an assertion from running, which is the
most dangerous thing this codebase could grow. Everything below is about making
that mechanism safe rather than about parsing a heading.

## Decision

**A document's status is read from the document, and five words withhold it.**

`draft`, `proposed`, `rejected`, `deprecated`, `superseded` - the words that mean
"not in force" in Nygard's template and in MADR's between them, plus `draft`,
which is the one people actually type. A document carrying any of them is
parsed, validated, reported by name, and not executed. A sixth, `archived`, was
added later; see [Amended 2026-09-26](#amended-2026-09-26-archived).

<!-- @assert-count target="src/parser.ts" symbol="INACTIVE_STATUSES" min="2" reason="the closed list has to stay wired into the status reader" -->

### Three spellings, because three are in use

```md
---
status: proposed          # MADR front-matter
---

## Status                 <!-- Nygard's section -->

Accepted (0.3.0).

**Status:** accepted      <!-- a bold label in the preamble -->
```

Front-matter wins, then the section, then the label. A front-matter `status`
wins whether or not its value can be read, and so does front matter that never
closes (the amendments below). Not a
tie-break for its own sake: a document carrying two of them is a document mid-migration between
conventions, and the machine-readable one is the one somebody wrote for a
machine. This repository turned out to need two of the three - ADRs 0001-0007
use the section and 0008-0009 use the label - which is how far a convention
drifts inside a nine-document corpus one author wrote in one week.

The value is normalised to its first word and the line is kept as written.
"superseded" tells a reader a rule stopped applying; "Superseded by ADR-0007"
tells them where it went, which is the question they are about to ask. The
word is read through leading emphasis, so `**Superseded** by ADR-0007` is
superseded; the line loses its emphasis only when the markers wrap all of it,
so `**Draft**` is shown as "Draft" and "Superseded by *ADR-0007*" is shown as
written.

Front-matter values are unquoted, because MADR's own template writes
`status: "proposed"` and a quote leaves no first word to read. Nowhere else is:
in YAML a quote is syntax, and in a sentence it is a character.

The loose `**Status:**` form is only read in the preamble, above the first `##`.
It is a line of prose with a colon in it, and accepted anywhere in a long
document one eventually turns up inside a sentence.

Code is masked before any of this, by the same `maskCode` the directive parser
uses. A tool that reads its own documentation as configuration disables itself
by being documented.

### An unrecognised word stays in force

This is the load-bearing default. `Provisional`, `In review`, and `Supersedded`
with the typo all keep enforcing. So does a document with no status at all,
which is every README and brief on earth.

The asymmetry is deliberate and it runs the same direction as every other
default in this tool. A word we failed to anticipate that keeps enforcing
produces a visible failure with an obvious remedy. A word we failed to
anticipate that stops enforcing produces a green build over a rule nobody is
checking - and nothing in the output would ever say so. The list is closed and
short for the same reason: every word added to it is another way for a document
to go dark, so adding one is a decision someone makes on purpose and a reviewer
sees in a diff.

### Withheld is reported, never quiet

A mechanism for not running an assertion is a mechanism for silently passing,
unless the report refuses to be silent. It does:

```text
○ docs/adr/0011-queues.md is Proposed. - 2 assertions not executed

12 passed · 2 not in force · 48ms
```

By name, not by count. A total tells a reader that some part of their
specification stopped being enforced without telling them which part, and the
only reason to report this at all is that a rule going quiet is otherwise
indistinguishable from a rule passing.

The same fact reaches the JSON report as `inactiveSpecs` and `summary.inactive`,
and reaches SARIF as a note-level `toolExecutionNotification` - which is that
format's own answer to "something happened that is not a finding". Without it a
repository whose ADRs had all gone dormant would show a clean code-scanning page.

<!-- @assert-count target="src/reporter.ts" symbol="inactiveSpecs" min="4" reason="withheld documents are named by all three output formats, not merely counted by one of them" -->

A document is listed even when it held no directives. "docs/adr/0011.md is a
draft" is the answer to "why is my new rule doing nothing", and a report that
only mentions documents it happened to find directives in cannot give it.

### Withheld is still validated

A directive in a draft is parsed, its attributes are checked, and it is
resolved - bad numbers, absolute paths and `..` escapes are still errors. Only
execution is withheld.

This is the half of the design that pays for the other half. A typo found on the
day a draft is written costs a minute. The same typo found on the day the ADR is
accepted is found after everyone has agreed the rule is right and stopped
looking at it, which is exactly when a silently-passing assertion does its
damage.

### `--ignore-status` runs everything

The way to ask "would this draft pass if we accepted it today", and the escape
hatch for a team whose `Proposed` means something else. Off by default, because
the point of reading the status is to honour it.

## A hole this opened, and closing it

A run in which every document is withheld executes no assertions, and the
report used to end:

```text
✔ every spec assertion holds
```

True, useless, and the exact sentence someone reads as proof their specification
is being enforced. It now says `no assertion was executed, so nothing was
verified` whenever the total is zero. That hole predates this ADR - a spec file
with no directives in it already produced the sentence - but nothing made it
easy to reach until withholding did.

<!-- @assert-count target="src/reporter.ts" symbol="nothing was verified" expected="1" reason="the sentence that replaced the lie has to stay in the reporter" -->

## Alternatives rejected

**A per-directive `if-status="accepted"`.** The proposal that prompted this
suggested it. It is a switch that disables one assertion inside an accepted
document, invisible in every Markdown renderer, reviewable only by someone
reading the raw source of a file they have no reason to open. Document status is
visible to every reader of the rendered document; that visibility is the only
thing making this safe. The adjacent case - a superseded ADR half of whose rules
still hold - has an honest remedy already: move the surviving rules into the ADR
that superseded it. That is what "superseded" means.

**A `--status <list>` filter.** Two knobs that interact, when one covers the
need. `--ignore-status` can be joined by a filter later if anyone wants one;
a filter cannot be taken away.

**Treating a withheld document as a `--strict` failure.** `--strict` means
"anything spec-guard could not fully verify is a failure". A withheld document
is not an incompleteness - it is an author's decision, stated in the document,
reported in the output. Folding the two together would make `--strict` unusable
on any repository that has ever superseded an ADR.

**Silently skipping.** Considered only long enough to name it, because it is
what most tools do and it is the whole failure mode this project exists to
prevent.

**Inferring status from the filename or from git history.** A file named
`0005-superseded-approach.md`, or an ADR not touched in two years, is a guess.
Guessing at a resolution algorithm is how a tool starts being confidently wrong
- the same reasoning that keeps tsconfig `paths` out of ADR-0005.

## Consequences

A proposed ADR can be written with its assertions live and its build green, and
turning it on is a one-word edit that a reviewer sees. A superseded ADR stays on
disk, intact, enforcing nothing. Neither costs a passing build that verified
less than it claimed, because every withheld document is named in every output
format this tool has.

The cost is a new way for a rule to stop running. Everything above - the closed
list, the unrecognised-word default, the per-name reporting, the validation that
still happens, the sentence that no longer lies about an empty run - is spent on
making that cost visible rather than on making it small.

<!-- @assert-count target="tests/spec-status.test.ts" symbol="ignoreStatus" min="2" reason="a test that a withheld rule did not fail is worth nothing without the control showing it would have" -->

## Amended 2026-09-26: `archived`

A task brief has a life as well. `spec-brief` closes a round by setting
`status: archived` in the brief's front-matter and moving it to an archive
directory, and the brief stays as the record of what the round was for. Its
directives stated the round's premises ("`LedgerClient` does not exist yet") and
its goals, and once the round is closed they are history: its own work made the
premises false. Executed anyway, they fail, and the remedies were the two this
ADR refused for a superseded ADR - gut the record or leave CI red. A goal that
should outlive the round belongs in an ADR, as a surviving rule of a superseded
ADR belongs in the one that superseded it.

<!-- @assert-count target="src/parser.ts" symbol="'archived'" expected="1" reason="the sixth word is in the closed list, and in no second list beside it" -->

This word and no other. Every word on the list is a way for a document to go
dark, so a word joins only when it cannot mean anything but "kept for the
record, not in force". `archived` is written by a tool as the last step of
closing a round, never typed into a document still meant to govern. The words
near it are not: `done`, `complete` and `closed` describe a brief whose goals
were met - which is when rules about the finished state should start holding -
and `inactive`, `obsolete` and `retired` are words nothing writes and anyone
might. They stay in force, as do `archive` and `archival`, by the rule above.

Everything else here applies unchanged: an archived document is parsed,
validated and named in every output format, and `--ignore-status` executes it.

## Amended 2026-09-26: read through spec-core's scanner

The three spellings, their order and the words are as above. Where each is
found is now spec-core's Markdown scanner's to say, as what is code is
([ADR-0002](0002-directive-format.md)'s amendment), and "code is masked before
any of this, by the same `maskCode`" now reads: by the same scanner.

- **Front matter is read by spec-core's reader**, the one the family's tools
  share. A quoted value is taken to its closing quote and a plain one to a
  comment, as the one-line reader did, so MADR's `status: "proposed"` and
  `status: draft # see review` read as they did. A value the reader refuses
  declares nothing, which leaves the document in force - this ADR's direction
  for anything that cannot be read: a `: ` in a plain value, text after a
  closing quote, a value continued on the next line, `*Draft*`, which YAML reads
  as an alias. A `status` nested under another key is that key's.
- **A front-matter `status` decides, readable or not.** Nothing below the
  front matter is read in place of a value the reader refuses, an empty one,
  one with no word in it, or a list: the status is unrecognised, the document
  stays in force, and the report carries a warning on the key's line naming
  the reason, in every format. The first reading of this amendment fell
  through to the section and the label instead, and that took documents out
  of force: `status: "accepted" (2024-05-01)` above a `## Status` section
  still saying `Proposed`, or `status: accepted: x` above `Status: draft`,
  ran its rules under 0.11.0 and was withheld by the fall-through. Falling
  through can only ever find a word the machine-readable field did not say,
  and a word that withholds is the one that must never be found by accident. Front matter
  behind a byte-order mark, or closed by `...`, is read; before, the first was
  not, and both fell through to the label.
- **The `## Status` section and the end of the preamble are headings the
  scanner reads**: ATX or setext, and never one kept in a comment or shown in
  code. A template's commented-out `## Status` no longer withholds the document
  it sits in, and a `##` inside a comment no longer ends the preamble early. An
  underlined `Status` is the section, and an underlined heading ends the
  preamble, so a `status: draft` line with `---` directly under it is a heading
  and not a label, as every renderer shows it.
- **The section's value and the label are read as they were**, with code masked
  and comments kept, from the lines under the heading and the lines of the
  preamble.

On every Markdown file of the five spec-* repositories, every status is read as
it was.

## Amended 2026-09-28: front matter never closed

A first line of `---` that nothing closes opens no front matter - spec-core's
scanner reads it as a thematic break, as every renderer shows it - so the
rule that a front-matter `status` decides, readable or not, does not reach a
`status` under it: there is no front matter for it to decide in. The document
is read as one without front matter, and its status is its section's or its
label's, as it was before this amendment. What changes is that it is no
longer silent: the report warns on line 1 that the front matter was not read
and how to close it, in every format, failing nothing
([ADR-0002](0002-directive-format.md)'s amendment of 2026-09-28).

The warning is what shows which way it went, since it can go either way:
`status: superseded` above a section saying `Accepted` runs the rules its
author took out of force, and `status: accepted` above one still saying
`Proposed` withholds them. The amendment of 2026-09-29, below, keeps such a
document in force instead.

## Amended 2026-09-29: front matter never closed keeps its document in force

The amendment of 2026-09-28 read front matter that nothing closes as none, so
the section or the label decided, and warned on line 1. That is the
fall-through the second amendment refused for a status that cannot be read,
and it found what that amendment said it would: `status: accepted` above a
section still saying `Proposed` withheld its rules, and so did `status: draft`
above no section at all, since the block's own line was read as a label in the
preamble. The warning said which way the status went; it did not keep it from
going the way that withholds.

Front matter that opens on the first line and never closes is now read as
front matter whose status cannot be read. Its author wrote front matter, and
nothing says where it ends, so nothing in it can be read: the status is
unrecognised, the document stays in force, and neither the section nor the
label is read in its place. `+++` is read so, as `---` is. Nothing else moves:
the scanner still reads the opening line as a thematic break and the rest as
Markdown, so a directive under it runs and none of it is masked, and a first
line with only blank lines after it is still no warning, with no status to
read either way.

<!-- @assert-count target="src/parser.ts" symbol="scan.unclosedFrontMatter !== null" min="1" reason="front matter never closed decides the status as front matter that cannot be read does, so the prose is not read in its place" -->

The warning stays on line 1, of the kind it was, in every format it reached,
and says what the warning for a status that cannot be read says, in its words:
none of it is read as front matter, its status is unrecognised and the
document stays in force, and a status written below the front matter is not
read in its place; then how to close it, as before
([ADR-0002](0002-directive-format.md)'s amendment of 2026-09-29). It fails
nothing, under `--strict` either. `prove` proves the rules of such a document,
and `cites` reads its status as a run does, so a citation of it is not stale.

Closing the front matter makes its `status` decide; taking the opening line out
leaves a document without front matter, whose section or label decides. No
flag restores the reading of 2026-09-28: `--ignore-status` runs every
document, which is not that reading. One kind of document pays for this that
did not: one whose first line is a thematic break meant as no front matter at
all, and whose section says it is superseded, is now in force, and the warning
names it on line 1. A thematic break anywhere but the first line is read as it
was.

TOML front matter that closes is still not read for a status, and hands over to
the section, as the second amendment says; only front matter that never closes
is read this way. The amendment below reads it.

None of the 164 Markdown files of the five spec-* repositories has front matter
that never closes, so every status there is read as it was, and a run,
`prove`, `cites` and `query` of each answer as they did.

## Amended 2026-09-29: TOML front matter decides the status

Front matter between `+++` lines was not read for a status: spec-core's
reader reads YAML, and handed TOML back with nothing in it, so the document
was read as front matter with no `status` key and the section or the label
decided. That is the fall-through the second amendment refused for a status
that cannot be read, and it found what that amendment said it would:
`status = "accepted"` above a section still saying `Proposed` withheld its
rules, and `status = "superseded"` above one saying `Accepted` ran them. The
amendment above closed the hole for front matter that never closes and left
this one open.

TOML front matter that closes now decides the status as YAML front matter
does. Its top-level `status` key is read when it is a string on one line -
`status = "accepted"` or `status = 'accepted'`, with the blanks and the
comment TOML allows around it - and the string is read as a YAML value is:
its first word, through the same closed list, with the line kept as written.
A basic string's escapes are TOML 1.0's, and a literal string has none.
spec-guard depends on nothing, so this is not a TOML parser. It reads that
one key in that one form, and walks the rest of the block only as far as it
must to know where each value ends, so that a `status = "draft"` line inside
a multi-line string is not taken for the key, nor a `[1, 2]` line inside an
array for a table header, which would end the top level before the key.

<!-- @assert-count target="src/parser.ts" symbol="block.kind === 'toml'" min="1" reason="closed TOML front matter is read for its status, so the prose is not read in its place" -->

The key is the document's when it comes before the first table header, and
it is compared as the YAML reader compares keys, so `Status` is it. A
`status` under a header such as `[meta]`, in an inline table, or after a dot,
as in `meta.status`, is that table's, and one in a comment is not written.
Any other form of the key is a status that cannot be read: a multi-line
string, even one on one line; an array; a table, whether inline, dotted as in
`status.value`, or named by a `[status]` or `[[status]]` header; a value that
is not a string, such as a bare word, a date or `true`; a string never closed
on its line; text after its closing quote; the key with no `=` after it. Then
the document stays in force, neither the section nor the label is read in
its place, and the report warns on the key's line, as it does for a YAML
value the reader refuses, with the reason, in every format and failing
nothing. TOML front matter without the key hands over to the section and the
label, as YAML front matter without one does, and a line the walk cannot
follow is passed over to its end, as the YAML reader passes over a line that
is not `key: value`.

`prove` proves the rules of such a document as a run executes them, and
`cites` reads its status as a run does. Taking the key out of the front
matter leaves the section or the label to decide, which is the old reading
for that document. No flag restores it for every document: `--ignore-status`
runs every document, which is not that reading. The documents that pay are
those whose TOML `status` says what their prose does not. One whose key
holds a word this tool does not know, above a section that withholds, is now
in force; one whose key says `draft` above a section saying `Accepted` is now
withheld, as the same YAML front matter is.

None of the 164 Markdown files of the five spec-* repositories has TOML
front matter, so every status there is read as it was, and a run, `prove`,
`cites` and `query` of each answer as they did.

## Amended 2026-09-30: a strict run that verified nothing fails

[A hole this opened](#a-hole-this-opened-and-closing-it) made a run that
executed nothing say so, in the human report alone, and exit 0 whatever the
options. That left the family contract half kept: spec-core's ADR-0005 says a
check that measured nothing is not clean, says so, and under `--strict`
refuses. `cites` refused already, when it read no file; a run and `prove` did
not, and their JSON said `"ok": true`, their SARIF a successful run with no
result, and GitLab an empty report.

Under `--strict`, or `"strict": true` in the configuration, a run whose specs
matched and state no rule in force - every document withheld, no directive in
any, or none that can be read - now fails, exit 1, and says so in every format:
the human report's last line is `✖` and the same sentence, which `--strict`
refuses; JSON has `"ok": false` and `"nothingVerified": true`; SARIF, GitHub and
GitLab carry a `nothing-verified` finding, an error and `major`, on the first
spec's first line, with a hint that says to put a rule in force or point the
patterns at the documents that state them. `prove --strict` fails the same way
when no rule was proved. The sentence is written once in the reporter, and the
assertion above still finds it once.

Two things are not this, and pass. A selection that leaves out every rule
there is - the MCP server's `check_architecture` given paths no rule governs -
verified what it was asked to; the rules exist, and the server says how many.
And a run that matched no spec is the command line's to refuse, as exit 2, or
to allow with `--allow-empty`. The alternative this ADR rejected stays
rejected: a withheld document is not a strict failure, and one rule in force
anywhere passes whatever else is withheld. What fails is a strict run that
verified nothing at all, which no reading of `--strict` can call complete.

Without `--strict` nothing changes: the report says the run verified nothing,
and it exits 0. The repositories that pay are those that run `--strict` over
specs with no rule in force, whose green said nothing; the remedy is a rule in
force, the right spec patterns, or `--no-strict` for a run meant to check
nothing.

## Amended 2026-09-30: a section or a label that cannot be read decides

The second amendment made front matter's `status` decide, readable or not,
because falling through to the prose can only find a word the field did not
say, and the word that must never be found by accident is one that withholds.
The section and the label were left to fall through: a `## Status` section
whose value could not be read declared nothing, and the `Status:` label in the
preamble was read in its place, so `2024-05-01: accepted` under the section
and `Status: draft` above it withheld the document.

A section that is there now decides as front matter does. Its value is its
first line of prose before the next heading; when that line begins with no
word, or there is none, the status is unrecognised, the document stays in
force, the report warns on that line or on the heading's, kind
`unreadable-status`, in every format and failing nothing, and neither the
table below nor the label is read in its place. The first label in the
preamble decides the same way, and warns on its line. Each warning names the
spelling it could not read and why, in the words front matter's use.

<!-- @assert-count target="src/parser.ts" symbol="fromFrontmatter(scan) ?? fromHeading(scan) ?? fromTable(scan) ?? fromLabel(scan) ?? {}" expected="1" reason="the first spelling that is there decides, readable or not, and nothing falls through" -->

On the 146 Markdown files of the five spec-* repositories every status and
every warning is read as it was. `prove`, `cites` and `query` read the status
as a run does.

## Amended 2026-09-30: a status in Chinese, and a status in a table

**The list stays closed.** A status written in Chinese is read as the English
word it translates, by the family's table (spec-core's ADR-0005), Traditional
and Simplified, and the English then does here what it already does. These
are translations of the words this ADR lists, and of words it leaves in
force; none is a word added to either. `INACTIVE_STATUSES` keeps its six
words, and a Chinese word withholds a document only when the English it
translates is one of them: 已取代 is `superseded` and withholds, 延後 is
`deferred` and stays in force, as `deferred` does here and not in spec-graph,
which retires both. The value a report and `cites` read is the English word;
the line is kept as written. The translations are keyed by the English, so
the assertion that `'archived'` is written once still holds.

The English word is the first run of letters; Chinese puts no space between
words, so the word is the listed one the value begins with, and only when a
space, punctuation or the end follows it. Each rule below reads less, since a
Chinese word read by accident is a document gone dark:

- `草稿已核准` and `暫定接受` begin with no word listed - 暫定 is
  `provisionally`, which is not `accepted` - and keep their document in force.
- 被, then within thirty characters 取代, 替代 or 取而代之, is `superseded`, as
  "superseded by" is: `被 ADR-0003 取代`. 取代 without 被 is what this
  document supersedes, and `已接受（取代 ADR-0002）` is accepted.
- A negation - 不, 未, 非, 沒, 没, 無, 无, 勿, 不再 - before the verb is not read,
  and neither is a value that begins with one, such as `未接受`; 不採納 is a
  word the table lists, and is read.
- `已取代` before a document reference, past spaces or a colon, usually names
  the document this one supersedes, and is not read: `已取代 ADR-0002` is a
  status that cannot be read. Around anything else, `已取代` is superseded.
- `已接受，後被ADR-0003取代` is accepted: the first word decides, as
  "Accepted, later superseded by ADR-0003" does here.

A Chinese value that is no word listed is a status that cannot be read, and
keeps its document in force with the warning above, which says it begins with
no status word spec-guard reads.

**The key** is read in Chinese, `狀態` or `状态`, wherever `status` is: a
heading, compared whole; a label, with an ASCII or a full-width colon, since a
label is prose and Chinese prose writes `：`; YAML front matter, where
spec-core's reader, from its copy of `5666c96`, reads a key of any script, so
`狀態` is an entry as `status` is and its value is read as that key's is,
`status` deciding first, then `狀態`, then `状态`; and TOML front matter,
quoted, since TOML's bare keys are ASCII. YAML ends a key at an ASCII colon
and at nothing else, so `状态：草稿` in front matter is a line YAML would not
read as the key, and the reader passes over it: where no key names the status,
it is a status that cannot be read, which keeps the document in force, reads
nothing below the front matter in its place, and warns with the hint to write
`状态:` with an ASCII colon, where every other such warning's hint is to write
a word spec-guard reads. Until that copy the reader read ASCII keys alone, and
the key in Chinese was found beside it, on the first line that held either
spelling.

**A table** is a fourth spelling: one of exactly two columns before the first
section heading, one of whose rows, the header row among them, names the
status in its left cell - `Status`, `State`, `狀態` or `状态`, compared whole,
without the emphasis that wraps it and in any case - and gives it in its right,
read with code masked as a section's line is. It ranks where the section
ranks, after it and before the label, and decides as the section does. A table
of more columns, or one past the first section, is a register or a legend of
other documents, whose status column is theirs, and is never read.

On the 146 Markdown files of the five spec-* repositories every status is read
as it was: none is written in Chinese or in a table.
