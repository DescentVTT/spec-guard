# ADR-0017: A comment that cites a decision is a claim

## Status

Accepted (2026-09-26).

## Context

Code comments cite decisions: `// ADR-0011: the domain imports no
infrastructure`, `# see ADR-7`, `/* Q-172 */`. Each is a claim about the
codebase - that a decision exists, and that it governs this code - and the
claim goes stale the way code does. The document is renumbered, or never
written; it is superseded, deprecated, rejected or archived. The comment then
sends the next reader, person or agent, to a decision that is not the one in
force, and nothing notices. spec-graph checks that documents agree with each
other and reads only Markdown, deliberately. A run reads only directives.

spec-core's ADR-0006 folded the planned `spec-code-graph` into this repository
as two commands, `cites` and `impact`. This is the first. It
needs what spec-guard already has: a classifier that knows what is a comment
in 68 extensions ([ADR-0006](0006-comment-classification.md)), and a reader
of each spec's title and status ([ADR-0010](0010-spec-status.md)).

## Decision

**`spec-guard cites [paths...]` reads the comment text of every source file in
scope for the ids of the documents a project names, and reports each citation
of a document that does not exist or is no longer in force.**

<!-- @assert-present file="src/cites.ts, tests/cites.test.ts, tests/fixtures/cites-corpus/.spec-guard.json" reason="the scanner, its tests, and the corpus it is held to" -->

### A family of documents

A project names what its comments cite in `.spec-guard.json` (or under
`"specGuard"` in `package.json`), one entry per family:

```json
{
  "cites": [
    { "id": "ADR-{n}", "files": "docs/adr/{n}-*.md" },
    { "id": "RFC-{n}", "files": "docs/rfcs/rfc-{n}.md" }
  ]
}
```

- **`id`** is literal text around `{n}`, a run of digits. It must have text
  before `{n}` - alone, every number in every comment would be a citation - and
  no digit where the text meets the number, or the two would run together.
- **`files`** is a path-dialect glob ([ADR-0015](0015-globs-from-spec-core.md))
  with `{n}` standing for the number, in the file name, after text that is
  literal: that is what says where in `0007-ledger.md` or `rfc-12.md` the number
  starts. The whole path is matched with `{n}` read as `*`, and then the name
  is read: the literal before, a run of digits as long as it goes, and a rest
  the text after `{n}` must match exactly. A `*` just after `{n}` is taken
  into that star, so `{n}*.md` is matched as `*.md`: two stars inside a name
  are a glob spec-core refuses.
- The number is compared as a number: `ADR-7`, `ADR-007` and `0007-x.md` are
  one document.
- An entry with any other key is refused, as an unknown option is: `"glob"`
  written for `"files"` would be a family with no documents. Every malformed
  entry is exit 2 before anything is read, naming the entry.

**Without `cites`, a family is read off the specs, or not at all.** A directory
of spec files whose names begin with digits is a numbered series. When every
document in it is titled with one id and its own number - `# ADR-0007: ...` in
`0007-x.md` - the series is cited that way, and the family is `ADR-{n}` over
`<dir>/{n}*.md`. Anything short of that is not guessed at: a series whose
titles disagree or carry no id gets a note saying to name it in `cites`, and a
project with nothing to look for exits 0 with a note saying so, rather than
inventing an id shape. This repository's ADRs derive `ADR-{n}`.

**A family whose `files` match no document is exit 2.** Every citation of it
would be a ghost, which is a report about a typo in the pattern, not about the
code.

### An id, found by a scanner

Ids are found by a small hand-written scanner: the family's literal prefix, a
run of digits, its literal suffix, and a word boundary on each side - no
letter, digit or underscore, in any script, running into either end. So
`XADR-1` and `ADR-12a` are not `ADR-{n}` citations, and `ADR-12.`, `(ADR-12)`
and `ADR-12's` are. A prefix that does not begin with a word character, `#{n}`,
needs no boundary before it.

**No template a project writes is compiled to a `RegExp`.** A `RegExp` built
from configuration is the backtracking ADR-0015 took out of every glob, and an
id template is a literal with a hole in it: `indexOf` finds the literal, and a
loop reads the digits. The file is searched once for each family, and the
citations that lie wholly inside a comment are kept by walking the two sorted
lists together - the first version searched once per comment, from the
comment to the next id, which on a file of 40,000 comments and no citations
until its last line took 3.9 s where one pass takes 35 ms.

<!-- @assert-absence target="src/cites.ts" symbol="new RegExp" reason="an id template a project wrote is found with indexOf and a loop, never compiled to a RegExp" -->

**Comment text only, by ADR-0006's classifier.** A citation in a string
literal is not a citation, whichever kind of string: a template, a raw string,
a verbatim one, a YAML scalar. **Markdown is not read** - it is spec-graph's -
and neither is a spec file, a cited document, a path the project's `exclude`
names, or `.git`, `.hg`, `.svn` and `node_modules` without `--no-default-skips`.
A file whose extension no comment syntax is known for is not read, and the
report counts those files by extension, so that a citation the check could not
see is never mistaken for one that is not there. A format known to have no
comments, JSON say, is not read either, since it can hold no citation.

A file that could not be read in full is named with the reason: unreadable,
binary, over the 20 MB every search stops at, or a scan that lost its place
because a literal or comment never closed. What was read of it still counts.

**One defect is one finding**: one per file, line and document, however the id
is spelled, so `ADR-9, ADR-09 and ADR-009` on one line is one citation.

### Another owner's ids

This repository's own code cites spec-core's decisions - `spec-core's
ADR-0005`, `spec-graph ADR-0017` - and read as this project's, those name a
document here that happens to have the number: a ghost when it does not, and
the wrong document quietly when it does. The first run of `cites` over this
repository found the second one as a ghost, in the copy of spec-core. So the
word just before an id is read, past one run of spaces, and the id is another
owner's when that word is a possessive - `'s`, `its`, `their`, but not the
`'s` of `it's` or `that's` - or a name with a `-` or `/` inside it, as package
and repository names have. Those ids are counted and not checked. `see ADR-7`,
`per ADR-7`, `(ADR-7)` and `e.g. ADR-7` are this project's. The cost is a
hyphenated word used as an ordinary one, `re-read ADR-7`, which is read as a
qualifier: a citation missed rather than one reported that is not wrong, which
is the side the family contract (spec-core's ADR-0005) says to err on.

**An id in a link is another owner's too.** `// See
https://github.com/org/repo/blob/main/docs/adr/ADR-0042.md` and `//
.../docs/ADR-0099.html` were each a ghost, and failed the run: an id read out
of a URL or a path names a document wherever that URL points - another
repository, a rendered page - and never one this family's `files` find. So
an id just after a `/`, `#`, `=` or `?` - a path, an anchor, a query - or
written after a `://` with no whitespace between is counted with the
qualified ones and not checked. The cost is a path to one of this project's
own documents, `docs/adr/ADR-0007.md` written out in a comment, which is not
checked either: missed, not reported wrongly.

### What is wrong with a citation

| Finding | When | Severity |
| --- | --- | --- |
| `ghost-citation` | no document of the family has the number | error |
| `stale-citation` | every document with the number is `superseded`, `deprecated`, `rejected` or `archived` | warning; error under `--strict` |

The stale words are ADR-0010's closed list less `draft` and `proposed`: a
proposal cited from the code that implements it is how a proposal gets built,
not a comment gone stale. The list is derived from ADR-0010's rather than
written again, so a word added there reaches this too.

<!-- @assert-count target="src/cites.ts" symbol="INACTIVE_STATUSES" min="1" reason="stale is ADR-0010's closed list less the two words for not yet, not a second list" -->

`archived` is on it on purpose, where spec-graph reads an archived document as
a record that depending on is normal. A document depending on a closed round is
history citing history; a comment in live code citing one is a pointer to a
goal that was met or abandoned, and the code has moved on from both.

Every finding says what to do next:

```text
✖ src/ledger.rs:28 cites ADR-0011, which no document defines  ghost-citation
    hint: no document matching docs/adr/{n}-*.md has the number 11; the nearest is ADR-0010
⚠ src/journal.rs:1 cites ADR-0007, which is superseded - cite ADR-0009 instead  stale-citation
    hint: docs/adr/0007-async-journal.md says "superseded by ADR-0009"
```

A ghost's hint names the nearest ids on either side of its number, which is
what a typo most often meant. A stale citation's successor is read from the
status line ADR-0010 keeps as written - `Superseded by ADR-0014`, or a link to
it - with every family's scanner, and followed while the successor is itself
retired, so the hint names the document in force and the ones passed through.
A successor that is not a document, or a loop, names none, and the hint says
to cite the decision in force or take the citation out.

### Exit codes and formats

Exit 1 for a ghost; under `--strict` also for a stale citation, for a file read
in part, and for a check that looked for nothing or read nothing, which the
family contract says a strict tool refuses rather than reports as clean. Exit 2
when the answer cannot be trusted: a malformed `cites`, a family with no
documents, a path outside the root or not there.

`--json` is versioned by `formatVersion`. `--format sarif` puts each finding on
its comment with the hint beneath and a fingerprint of the file, rule and id,
which survives the comment moving; `github` and `gitlab` place the same
findings as they place a run's.

## Out of scope

- **Symbol-level links.** "This function implements ADR-0011" needs to know
  where the function is, which is a parser per language. The family ships none:
  ADR-0008 measured Tree-sitter's grammars at 94 MB against a package of 0.3,
  and spec-core's ADR-0006 left symbol level waiting for a parser.
- **Citation by path.** `see docs/adr/0007-x.md` names a document by file, not
  by id. A link checker's question, and spec-graph's for Markdown.
- **Python docstrings.** A docstring is a string literal to the classifier, so a
  citation in one is not read. Reading them would mean deciding which strings
  are documentation, which is a parser's question again.
- **Documents that disagree with each other**: two documents with one number, a
  successor that does not supersede back. spec-graph checks documents against
  documents; here, a number with any document in force is in force.
- **A citation qualified in a way the rule above does not read**, such as a
  line break between `spec-core's` and the id. It is read as this project's.

## Consequences

### This repository

The first run over this repository, before this ADR existed, reported 38
ghosts. 31 were in build output and scratch trees - `dist`, `reports`, copies
under `tests/fixtures/.tmp` - which no rule reads either, and which
`package.json` now excludes with the fixtures. Of the seven in `src`:

- three were this ADR's own number, which the new code cited before the
  document existed;
- one was the example at the top of `comments.ts`, `// LegacyThing was removed
  in ADR-398`, an illustration written as a citation of nothing, and one the
  example at the top of `cites.ts` as first written; both are reworded;
- two were spec-core's own citations of spec-graph's ADR-0017 in the copy of
  `pattern`, which the qualifier rule above now reads as another owner's.

With those, every citation in this repository names an ADR in force: 168 in
119 files, and 13 ids another project qualifies. One test file,
`tests/parser-contracts.test.ts`, is named as read in part: it has backticks
inside a `${}` substitution, which the lexer does not re-enter - the open item
ADR-0006 records.

### A corpus and a budget

`tests/fixtures/cites-corpus` is a Rust workspace citing ten ADRs and two RFCs,
shaped like the monorepo spec-guard is used on: `//!` and `///` docs, nested
block comments, raw strings, lifetimes beside apostrophes, a TOML manifest, a
shell script and a workflow. It holds three ghosts, seven stale citations
across five statuses and two successor chains, two ids another project
qualifies, and ids in strings, raw strings, a YAML scalar and Markdown that must
not be read. The test pins every finding.

A tree of 3,000 TypeScript files of about 2 KB, one citing in three, is read in
under a second on the development machine, against a test budget of ten.
`node_modules` and this repository together, 4,573 source files read with the
default skips off, took 1.8 to 2.4 s.

*Amended 2026-09-30.* The budget of ten seconds went, and the two seconds
for a file of 40,000 comments with it: a machine running five suites at once
took 24.7 seconds over the tree, which says nothing about the code. The
tests now hold cost to a ratio, as spec-core's ADR-0007 holds its own: a tree
of 3,072 files in sixteen directories is read once whole and sixteen times a
directory at a time, taken in turn, the fastest of two rounds, and the whole
must take less than twice the sixteen reads and 200 ms; a file of 40,000
comments is read once against one of 2,500 read sixteen times, within twice
and 100 ms. A read that grows with the square of what it reads takes sixteen
times as long, and a busy machine slows both sides alike. The first read of
the tree is not timed - it pays for the disk cache and for compiling what
reads it - and is the one whose findings are checked; instrumented, only the
findings are, since reading the tree five times over for every mutant
costs a sweep more than it tells it.

### Held to the mutation bar

One local sweep of `cites.ts`, before its last round of tests, scored 95.4%:
634 mutants killed, 12 timed out, 31 survived. The survivors that were real -
a directory named alongside one of its own files, a successor chain that runs
into a loop past its start, numbers whose file names are not padded, a
configured family's source, the reads held to the engine's limit - now have
tests, and guards no input could reach were taken out rather than tested.
What is left is equivalent by construction, and named so that a sweep that
reports it is not read as a gap:

- the nearest ids compare against a number no document has, so `<` and `<=`,
  or `>` and `>=`, find the same ones;
- an unreadable document is read as the empty text, and any text with no
  title and no status line is read the same;
- when there is no family the walk is skipped, and a walk of a path that is
  not there finds the same nothing.

The regular expressions that use `\p{L}` are not mutated at all: Stryker's
regex parser does not read Unicode property escapes. The sweep that measures
this file is CI's.

## Amended 2026-09-30: a strict check that read nothing is a finding

Under `--strict` a check that looked for nothing, or found no source file to
read, exited 1 and said so in the human report alone: its JSON said
`"ok": false` with nothing to say why, and SARIF, GitHub and GitLab carried
no finding. ADR-0010's amendment of this date gave a run that verified nothing
a finding in every format, and a check of citations that read nothing is the
same fact.

It is now a `nothing-read` finding in every format that places findings: an
error, `major` in GitLab, on the first spec's first line - or, with no spec,
on the first document a family names, or on the root - known by its rule
alone, since there is one to a check and the file it is shown on is where it
is shown, not what it is about. Its message is the sentence the human report
ends with, which `--strict` refuses, and its hint says what to do: for a check
that looked for nothing, name the documents in `cites` or title numbered specs
with an id; for one that found nothing to read, point the paths at source
files whose comments spec-guard reads, or check what the exclusions leave out.
JSON carries `"nothingRead": true` beside `"ok": false`, and the human report's
last line is a failure, `✖`, where it was a warning. The exit code does not
change, and without `--strict` nothing does.

## Amended 2026-10-11: a spec pattern that matches no file is named, and fails a strict check that read its families off the specs

[ADR-0014](0014-configuration-and-watch.md)'s amendment of this date has a
run, `prove`, `impact` and `query` refuse a spec pattern that matches no file
beside others that do, and left `cites` as it was: a pattern that matched
nothing was dropped without a word, and where the families are read off the
specs, its family with it.

Measured through the launcher on 0.22.0 (Windows 11, Node 24.18.1), in a tree
with `docs/adr/0001-first.md` titled `ADR-0001`, `rfcs/0001-one.md` titled
`RFC-0001`, the specs `docs/**/*.md` and `rfcs/*.md`, and a source file whose
comments cite `ADR-0001`, `RFC-0001` and an `RFC-0099` no document defines;
then with `rfcs` renamed, and with `docs` renamed too. Each row was one
answer whether the patterns came from `--spec` or from `specs`, and in the
human report, `--json`, `sarif`, `github` and `gitlab` alike:

| The patterns | 0.22.0 | 0.22.0, `--strict` | Now | Now, `--strict` |
| --- | --- | --- | --- | --- |
| each matches | exit 1 for the ghost `RFC-0099` | the same | the same | the same |
| `rfcs/*.md` matches nothing; families read off the specs | exit 0, "every citation names a document in force", and no word of the pattern | the same, exit 0 | the same report, the pattern named on stderr, exit 0 | the same report, the line, exit 1 |
| `rfcs/*.md` matches nothing; `cites` names `ADR-{n}` | exit 0, and no word | exit 0 | the pattern named, exit 0 | the pattern named, exit 0 |
| `rfcs/*.md` matches nothing; `cites` names `RFC-{n}` over `rfcs/{n}-*.md` | exit 2, no document matches | exit 2 | the same | the same |
| none matches; families read off the specs | exit 0, and a note that there was nothing to look for | exit 1, a `nothing-read` finding | the same | the same |
| none matches; `cites` names a family that has documents | exit 0 | exit 0 | the same | the same |

```text
spec-guard: the pattern "rfcs/*.md" matched no spec file, so no citation of a document under it was looked for. Remove it from "specs" in package.json.
spec-guard: the pattern "rfcs/*.md" matched no spec file, so no citation of a document under it was looked for, which --strict refuses. Remove it from "specs" in package.json.
spec-guard: the pattern "rfcs/*.md" matched no spec file. Remove it from "specs" in package.json.
```

- **Each pattern is held to what the list is held to**, as ADR-0014 has it
  for the commands that refuse. With no spec at all `cites` says there was
  nothing to look for and exits 0, and 1 under `--strict`; so one pattern
  among several that matched none is said, and is 1 under `--strict`. That
  is the family contract's "nothing measured is not clean" (spec-core's
  [ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)):
  a check says what it did not inspect, and a strict one refuses. Without
  `--strict` the exit code is what it was.
- **A strict check fails only where the families are read off the specs.**
  What the list is held to depends on where the families come from. Read
  off the specs, a family kept under the pattern is one the check no longer
  has, and every citation of it goes unread: the second row. Named in
  `cites`, a family is found by its own glob, and the specs decide only
  which files the scan leaves out; with no spec at all such a check passes
  under `--strict`, in the last row, and failing it for one pattern of two
  would refuse the part where the whole is let through. There the pattern
  is named, and the exit code is as it was. A family in `cites` that lost
  its documents to the rename is exit 2 by its own glob, as it always was,
  which is the stronger answer and a reason to name families there.
- **The report is written as the check made it, and the line follows it.**
  No spec at all is a report with a note here, not a refusal, so nothing
  gives way to the line as a run's report does: every format is written,
  and the line is on stderr after it. It names the pattern in the words the
  other commands use (`unmatchedClause`), then what the check lost by it,
  then what to do, with the configuration file when `specs` wrote the
  pattern. Under `--strict` it says `which --strict refuses`, the words the
  report uses of a check that read nothing. The human report still ends
  "every citation names a document in force", of the citations it counted,
  as it does under `--strict` when a file was read in part and the exit
  code is 1.
- **`unmatchedSpecs` is a field added to `--json`**, after `families`: the
  patterns as written, in the order given, each once, and `"ok": false`
  beside it where a strict check failed for them. It is there when a
  pattern matched no file beside others that did. With no spec at all it
  is not, where a run's document has it: that is no refusal here, `notes`
  and `nothingRead` have always said it, and the document is the one it
  was. `formatVersion` stays 1.
- **Left as it is: SARIF, GitHub and GitLab place no finding for it.** A
  strict check that read nothing is a `nothing-read` finding in each (the
  amendment of 2026-09-30); this one is the line and the exit code, and
  `executionSuccessful` in SARIF where the document has notifications.
- **No `--allow-empty`.** `cites` refuses the option, as it did: nothing
  here is exit 2 for it to let through. A project that keeps a pattern for
  a place nothing is written in yet, and checks citations under `--strict`,
  names its documents in `cites`.
- **Where it is decided.** `findCitations` in `src/cites.ts` carries the
  patterns on its report and, as it already does for a stale citation and a
  file read in part, folds `strict` into `ok`; `src/cli.ts` says the line.
  `tests/unmatched-specs.test.ts` holds each row beside the check that must
  still pass.

## Amended 2026-10-12: a strict check that failed says so in its report

The amendment of 2026-10-11 left two things as they were: the human report
"still ends 'every citation names a document in force', of the citations it
counted, as it does under `--strict` when a file was read in part and the
exit code is 1", and SARIF, GitHub and GitLab "place no finding" for a family
that went unread. Both are taken back here. A report that ends on the words
of a check that passed is read as one, whatever the exit code says, and a
job that is red with no annotation to show why is a job somebody reruns.

Measured through the launcher on 0.23.0 (Windows 11, Node 24.18.1), over
each way a check fails and four pairs of them, without and with `--strict`,
in the human report, `--json`, `sarif`, `github` and `gitlab`: 24 runs. A
ghost, a stale citation under `--strict` and a check that read nothing each
ended on a line of its own and had a finding in every format, as the
sections above and the amendment of 2026-09-30 have it. Two did not, and
those two are every row that changed:

| A check under `--strict` that fails for | 0.23.0 | Now |
| --- | --- | --- |
| a file read in part: the last line | `✔ every citation names a document in force` | `✖ 1 file could not be read in full, which --strict refuses` |
| the same, in SARIF | no result; a notification, and `executionSuccessful: false` | an `unread-comments` result, `error`, on the file's first line, beside the notification |
| the same, for GitHub and GitLab | `notice`, `info` | `error`, `major`, saying `which --strict refuses`, with what to do |
| the same, in `--json` | `"ok": false`, and the file in `gaps` | the same, and `"unreadComments": true` |
| a family that went unread with a spec pattern: the last line | `✔ every citation names a document in force` | `✖ the pattern "docs/rfc/*.md" matched no spec file, so no citation of a document under it was looked for, which --strict refuses` |
| the same, in SARIF, for GitHub and for GitLab | nothing | an `unread-family` finding to each pattern, `error` and `major`, on the first spec's first line |
| the same, in `--json` | `"ok": false`, and the pattern in `unmatchedSpecs` | the same, and `"unreadFamily": true` |
| a ghost, or a stale citation, and a file read in part: the last lines | the citation's line | the citation's line, then the file's |

Every exit code is what it was, and so is every run without `--strict`: a
file read in part is named there and is a notice, a pattern that matched no
file is named on stderr, and the report ends as the report of a check that
passed, which it is.

- **The last line is the all-clear only when the check passed.** The report
  ends on one line for a citation, as it did - a ghost, else nothing looked
  for or read, else a stale citation - and then a line for each of the two
  that had none, which `--strict` alone can fail a check for. So a report
  that failed ends on a failure, and one that failed for two things says
  both: a ghost beside a file read in part used to say the ghost, and the
  file was the next run's news. A ghost beside a stale citation under
  `--strict` still ends on the ghost alone, as it always has; the count
  line above it has both.
- **The report says by name what failed it.** `findCitations` folded
  `strict` into `ok` and into nothing else, so a format could not tell a
  file read in part that failed the check from one that did not. Its report
  now carries `unreadComments` and `unreadFamily` as it carries
  `nothingRead`: there when the check failed for that, absent otherwise,
  the second with the file its findings are shown on. `--json` has each as
  `true` beside `"ok": false`, after `nothingRead` and before `root`;
  `formatVersion` stays 1, since fields were added.
- **A file read in part is one finding, and what `--strict` makes of it is
  its level.** It is `unread-comments` with the identity it had, its file
  and what stopped the read, so GitLab does not see a new finding where an
  old one changed level: a notice and `info` without `--strict`, an error
  and `major` with it, as a stale citation is a warning and then an error.
  The error says `which --strict refuses`, and has a hint: make it a file
  whose comments can all be read, or leave it out with `--exclude`. In
  SARIF it stays a notification either way, and under `--strict` is a
  result as well: a notification says how the run went, and code scanning
  shows results.
- **A family that went unread is a finding without a line, and is placed
  where the others are.** A run that verified nothing and a check that read
  nothing are each about the specs and no line of them, and each is shown
  on the first spec's first line (ADR-0010 and the amendment of 2026-09-30
  above). A spec pattern that matched no file is the same kind of fact, so
  `unread-family` goes there too, by the rule `nothingRead` is placed by:
  one finding to each pattern, known by the pattern, `major` as the other
  two are. Its message is the line on stderr without its last sentence, and
  its hint is that sentence and the other way out: remove the pattern, or
  name the documents in `cites`. The line itself is still written, after
  the report, in every format.
- **One wording.** The clause "so no citation of a document under it was
  looked for" is written once, in `src/reporter.ts`, and the command line's
  line, the report's last line and the finding's message take it from
  there.
- **Not changed: `--help`.** It says when `cites` exits 1 and says nothing
  of how a report ends or what a format places, here or for any command.
- **A minor**, by spec-core's
  [ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md):
  no run that passed fails, and a script that reads the report's last line,
  GitHub's commands, or the errors of a GitLab or SARIF document reads
  something else for a strict check that was already exit 1.

`tests/cites.test.ts` holds each of the two in every format beside the check
that must not fail, and that no report of a check that failed ends as one
that passed, over each way of failing and each pair; and
`tests/unmatched-specs.test.ts` holds the rows above through the command
line.
