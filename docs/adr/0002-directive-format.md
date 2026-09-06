# ADR-0002: HTML comments as the directive format

## Status

Accepted.

## Context

An executable assertion has to live inside a Markdown document without changing
how that document reads. The candidates were:

1. **YAML front-matter** - one block per file, far away from the prose it
   guards, and invisible to anyone reading the middle of a long ADR.
2. **A custom fenced block** (` ```spec-guard `) - visible in every renderer as
   a code block, cluttering the document with machinery.
3. **HTML comments** - invisible in every Markdown renderer, valid CommonMark,
   supported by GitHub, and legal anywhere in a document.

## Decision

Directives are HTML comments beginning with `@`:

```md
Payments no longer touch the retired gateway.

<!-- @assert-absence target="src/" symbol="LegacyGateway" -->
```

The format is `<!-- @assert-<kind> attribute="value" ... -->`, may span multiple
lines, and sits directly under the sentence it makes executable.

Two consequences fall out of choosing comments, and both are deliberate:

- **Fenced code and inline code are masked before parsing.** Documentation that
  shows the syntax - like this README and this ADR - must not execute it. The
  masking preserves byte offsets so reported line numbers stay exact.
- **Spec files are excluded from their own searches by default.** An ADR that
  says "`LegacyGateway` must not appear" contains the string `LegacyGateway`;
  without this rule every absence assertion would fail on itself. `--include-specs`
  turns the exclusion off.

<!-- @assert-count target="src/parser.ts" symbol="ALLOWED_ATTRIBUTES" min="2" reason="unknown attributes must stay a hard error" -->
<!-- @assert-count target="src" symbol="excludeFiles" min="4" reason="self-exclusion is threaded through both engines" -->

## Consequences

A spec-guard directive is invisible in rendered Markdown, so an ADR keeps
reading like an ADR. The cost is that directives are also invisible to authors
who never look at the source - which is why `--verbose` prints every assertion
it executed, including the ones that passed.
