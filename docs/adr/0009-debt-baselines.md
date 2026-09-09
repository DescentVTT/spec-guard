# ADR-0009: Debt baselines, the two-sided ratchet, and why there is no `--fix`

**Status:** accepted
**Date:** 2026-09-10

## Context

A strict assertion introduced into a mature codebase lands on violations that
already exist. spec-guard offered three ways to deal with that, and all three
are bad:

| what people do | what it costs |
| --- | --- |
| `exclude="src/legacy/**"` | A permanent, unmonitored blind spot. Nothing tells you when a new file appears in there, and nothing tells you when the last violation leaves. |
| `expected="5"` | Detects that the total changed. Cannot say *which* files, and cannot tell "one fixed, one added" from "nothing happened" - the count is 5 either way. |
| Do not adopt the rule | The most common outcome, and the worst. |

The gap is that none of them names the debt. A number is not reviewable; a list
of files is.

## Decision

`baseline="..."` on the absence assertions, listing the files that are allowed
to violate and how many matches each is allowed to contribute:

```md
<!-- @assert-absence target="src" symbol="LegacyGateway"
     baseline="src/legacy/gateway.ts:2
               src/legacy/adapter.ts" -->
```

A bare path means one match. The rule then holds when **no file outside the
baseline matches, and no file inside it matches more than it declares**.

### Files and counts, not line numbers

Line numbers are invalidated by every edit above them, which turns a baseline
into a file nobody can keep current, which turns it into a file people
regenerate blindly - and a blindly regenerated baseline is `exclude` with extra
steps.

Per-file counts survive refactoring and still catch the two things that matter:
a new file starting to violate, and an existing one violating more. What they do
not catch is a violation *moving within a file that is already on the list* -
delete one `LegacyGateway` on line 40, add one on line 900, and the count is
unchanged. That is a real hole and it is the price of a baseline anyone will
actually maintain.

### The ratchet is two-sided by default

The interesting half. When a baselined file is cleaned up, the entry becomes a
claim the code no longer supports: the spec says two violations live here, and
they do not. spec-guard **fails**, naming the entries to delete:

```
✖ docs/adr/0004.md:12  @assert-absence
    "LegacyGateway" must not appear in src
    expected no matches, found 0; the baseline is out of date and must be
    pruned: src/legacy/adapter.ts (no longer matches)
```

Failing someone for *fixing* code looks hostile, and the objection deserves a
straight answer. Three reasons it is right:

1. **It is the only thing that makes it a ratchet.** If paid-down debt may stay
   on the list, the list only grows, and in two years it is an `exclude` again.
2. **A stale entry is a spec that lies.** That is the defect class this whole
   tool exists to catch. Exempting the spec from its own standard because the
   lie is convenient is not a principle.
3. **The fix is deleting a line**, and the failure message says which one.

`ratchet="one-way"` relaxes it to a report-only note for teams that would rather
not block on it. The entry is still reported either way — not failing is not the
same as not knowing.

### `--print-baseline`, and the line it does not cross

Adopting a rule on a codebase with 200 violations means transcribing 200 paths.
Nobody does that; they write `exclude` instead. So:

```bash
spec-guard docs/adr.md --print-baseline
```

prints the `baseline="..."` attribute that would exempt exactly today's
violations, to stdout, for a human to paste in.

## Why there is no `--fix`

This was the question that produced the rule, so here is the rule:

> **spec-guard will only ever offer an edit that makes a rule stricter, and it
> will never apply one itself.**

An architectural assertion is not a lint rule with a mechanical repair. There is
no safe machine edit for "the UI layer imports the database": deleting the
import does not compile, and moving the code is a design decision. Every edit a
machine *can* make to a failing boundary assertion is an edit that records the
rule no longer holding — widen `expected`, add an `exclude`, append to the
baseline, insert an ignore comment.

So a `--fix` for architecture rules is a button that turns red into green
without changing any code. That is a bad button for a person and a much worse
one for an autonomous agent, which is running a loop whose terminating condition
is a green build. Handing that loop a one-flag path from red to green does not
produce a compliant codebase; it produces a codebase whose rules have all been
quietly widened, with a clean CI history the whole way down. The failure mode is
not that the agent cheats — it is that we built the shortcut and then expressed
disappointment.

Printing is different from applying in the way that matters. The author pastes
the output into the spec; the diff shows every exempted file by name; a reviewer
sees the exemption being granted, in the commit that grants it. The tool assists
and the human decides, which is the correct side of that line — and the reason
pruning a baseline is *not* offered as an automatic edit either, even though it
only ever tightens. It is one deleted line, and the message says which.

## What was considered and rejected

**A separate baseline file** (`.spec-guard-baseline.json`). Standard, and wrong
here. It breaks the zero-cost-exit invariant — the rule and its exemptions would
live in two places, one of them proprietary — and a separate file is a file
people regenerate with a script rather than review. Inline, the exemption sits
three lines from the rule it weakens, in the same reviewable diff. The cost is
that a 200-entry baseline is ugly in a Markdown document; that ugliness is
proportionate to the debt and is not obviously a bug.

**Hashing the violating line** instead of counting. Catches within-file
movement, which counts miss. Rejected: any reformat, rename or whitespace change
invalidates every hash at once, and a baseline that breaks on `prettier --write`
gets regenerated blindly, which is exactly the failure the design is avoiding.

**Baselines on the counting assertions.** `expected="5"` with a baseline of 2 has
no reading that is obvious enough to be safe, so the parser refuses the
attribute there. It can be widened later if a real use appears; the reverse is
not true.

## Consequences

- `AssertionResult` grows `baselinedMatches`, `staleBaseline` and `fileMatches`.
  The first is reported in the terminal next to the comment-exclusion note, and
  for the same reason: **a pass bought by an exemption is never silent.**
- `SearchResult` grows `fileCounts`, computed by the scanner and therefore
  identical under both engines — ripgrep pre-filters, the scanner counts, so
  there is no second implementation to disagree (ADR-0007).
- Failure snippets are filtered through the baseline. The first version of this
  was not, and it reported a brand-new violation by quoting a file that had been
  exempt for years. A file over its allowance still shows, because the excess is
  a real violation living in it.
