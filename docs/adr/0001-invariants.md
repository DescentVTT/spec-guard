# ADR-0001: spec-guard's own architectural invariants

## Status

Accepted.

## Context

spec-guard exists because prose about a codebase drifts. It would be absurd for
this repository to document its own rules in prose that drifts. Every claim
below is executed by spec-guard against spec-guard on every CI run.

## Decision

**The CLI never writes to the console directly.** `main()` receives a `CliIO`
object and returns an exit code, which is what makes the whole CLI unit-testable
in-process without spawning anything.

<!-- @assert-absence target="src" symbol="console.log" reason="output goes through the injected CliIO" -->
<!-- @assert-absence target="src" symbol="process.exit(" reason="main() returns an exit code; only bin/spec-guard.js sets process.exitCode" -->

**Process spawning is confined to the engine.** Nothing outside `src/engine.ts`
is allowed to know that ripgrep is a subprocess; that is what lets the
JavaScript fallback be a drop-in replacement.

<!-- @assert-count target="src" symbol="node:child_process" expected="1" reason="only the engine spawns processes" -->
<!-- @assert-absence target="src" symbol="child_process" exclude="src/engine.ts" reason="everything except the engine" -->

That second rule used to be written as an explicit list of the five files that
must *not* mention `child_process` - a list that silently stopped covering
anything new. Stated as "everywhere except the engine" it cannot rot, which is
what `exclude` is for.

**The parser and the reporter are pure.** Neither touches the filesystem, which
is why both can be tested on plain strings.

<!-- @assert-absence target="src/parser.ts,src/reporter.ts" symbol="node:fs" reason="parsing and reporting are pure functions" -->
<!-- @assert-count target="src" symbol="maskCode" min="2" reason="fenced-code masking must stay wired into the parser" -->

**Strict typing, no escape hatches.**

<!-- @assert-absence target="src" symbol=": any" reason="strict typing is the point of a spec tool" -->
<!-- @assert-absence target="src" symbol="@ts-ignore" -->

**The published surface exists.**

<!-- @assert-present file="bin/spec-guard.js" -->
<!-- @assert-present file="LICENSE" -->
<!-- @assert-present file=".github/workflows/ci.yml" -->

## Consequences

If someone adds a `console.log` to `src/`, or reaches for `child_process`
outside the engine, CI fails with the line number of this document. The ADR and
the code cannot drift apart, because the ADR is a test.
