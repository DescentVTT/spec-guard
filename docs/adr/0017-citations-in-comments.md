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
  the text after `{n}` must match exactly.
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
