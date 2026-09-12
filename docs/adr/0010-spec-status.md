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
parsed, validated, reported by name, and not executed.

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

Front-matter wins, then the section, then the label. Not a tie-break for its own
sake: a document carrying two of them is a document mid-migration between
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
