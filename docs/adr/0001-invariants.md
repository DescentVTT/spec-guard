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
<!-- @assert-import-absence target="src" module="node:child_process" exclude="src/engine.ts" reason="as a dependency, not as a string: a comment mentioning it is not a violation" -->

That second rule used to be written as an explicit list of the five files that
must *not* mention `child_process` - a list that silently stopped covering
anything new. Stated as "everywhere except the engine" it cannot rot, which is
what `exclude` is for.

Both rules are stated twice on purpose: once as a text search and once as a
dependency. The text version would fail on a comment that merely names the
module; the import version reads the actual dependency and ignores prose. Where
they disagree, the import version is the one that means what the sentence above
it says. See ADR-0005.

**The parser and the reporter are pure.** Neither touches the filesystem, which
is why both can be tested on plain strings.

<!-- @assert-absence target="src/parser.ts,src/reporter.ts" symbol="node:fs" reason="parsing and reporting are pure functions" -->
<!-- @assert-import-absence target="src/parser.ts,src/reporter.ts" module="node:fs" reason="the same rule, checked as a dependency rather than as text" -->
<!-- @assert-import-count target="src/parser.ts" module="src/vendor/spec-core/markdown" min="1" reason="what is code is decided by spec-core's scanner, and it must stay wired into the parser" -->

That rule counted the name `maskCode` in `src` until 2026-09-26, when the
parser moved onto spec-core's Markdown scanner (ADR-0002's amendment).
`maskCode` is still exported, and its definition and its export alone met the
count with nothing calling it. What keeps code from executing is now the
scanner, so the rule asks for the import.

**Strict typing, no escape hatches.**

<!-- @assert-absence target="src" symbol=": any\b" regex="true" reason="strict typing is the point of a spec tool" -->

The first rule was a literal `: any` until 2026-09-26, when it failed on
`last ? a : anyDirectories(b)` in the copy of spec-core (ADR-0015). A word
boundary cannot be added with `word="true"`: that bounds both ends of the
match, and the character before `: any` in `value: any` is a letter, so the
rule would have stopped matching the thing it forbids. The boundary goes after
`any` alone.
<!-- @assert-absence target="src" symbol="@ts-ignore" -->

**The published surface exists.**

<!-- @assert-present file="bin/spec-guard.js" -->
<!-- @assert-present file="LICENSE" -->
<!-- @assert-present file=".github/workflows/ci.yml" -->

## Consequences

If someone adds a `console.log` to `src/`, or reaches for `child_process`
outside the engine, CI fails with the line number of this document. The ADR and
the code cannot drift apart, because the ADR is a test.

## Amended 2026-10-08: an error nothing expected is exit 2

`main()` returns an exit code, and for an error no command expected it
rejected instead: a write the stream refused, a defect in a formatter, a
server whose input failed. The launcher ends on
`process.exitCode = await cli.main()`, so the rejection was Node's uncaught
error, the stack and exit 1, which the exit codes read as a failed assertion
and the family contract (spec-core's ADR-0005) as "it found something".
Measured on 0.19.1 through the launcher, with a stdout that throws:
`--version`, `--help`, a run, `query`, `prove`, `cites` and `impact` each
exited 1. An error thrown where no promise holds it - a stream's `error`
event, as when a reader closes the pipe, or a timer's callback in a watch
session or the server - never reaches `main()`, and exited 1 the same way.

`main()` now resolves to 2 for every error it awaits that nothing expected:
`spec-guard: unexpected error:` and the stack on stderr, so that a report of
it says where, and nothing on stdout, where a script reads a document. The
launcher answers what nothing awaits the same way. It owns the process, which
`main()` does not: a caller of `main()` from the package gets 2 where it got a
rejection, and no handler it did not ask for. `runSpecGuard`, `queryRules` and
the rest of the API throw as they did.

<!-- @assert-count target="bin/spec-guard.js" symbol="uncaughtException" expected="1" reason="the launcher answers an error nothing awaits with exit 2, and the test that runs the launcher is skipped where nothing is built" -->

What already answered is unchanged. An error inside a command's own run is
its message and exit 2. A watch session that meets one in a later run prints
it and keeps watching, and ends with 2 only when it cannot start or its
watcher fails (ADR-0014). The server answers a request that fails with an
error for that request and serves the next (ADR-0012).

## Amended 2026-10-08: a reader that closed the output is answered in a line

The amendment above made a pipe its reader closed one more error nothing
expected. Measured on 0.20.0 through the launcher (Windows 11, Node 24.18.1):
`spec-guard impact src --json | head -c 10` in this repository, an answer of
79 KB, printed `spec-guard: unexpected error: Error: EPIPE: broken pipe,
write` and eight lines of stack, exit 2; so did `spec-guard --help` into a
reader that had already left. A reader that stops reading is an everyday
thing, and a stack sends a person looking for a defect that is not there.

It is now one line on stderr and no stack,
`spec-guard: stdout was closed before all of the output was written`, in the
words every tool of the family uses (spec-core's ADR-0005). The exit stays 2:
the answer did not arrive, and what a script was handed of a document is not
the document.

Every way it arrived was the stream's `error` event, which nothing awaits:
from `--version`, `--help`, a run, `query`, `prove`, `cites` and `impact`,
from a watch session at its first report or a later one, and from the server
at the first answer it could not write. The process's own stdout never threw
it where `main()` awaits. So the launcher answers it, and `main()` answers in
the same words where a write does throw it, as a caller's own stream may. It
is told from every other error by its code, `EPIPE`: stdout and stderr are the
only pipes spec-guard writes to, ripgrep being given no input. When stderr is
the one that closed there is nowhere left to say anything: nothing is written,
to stdout either, and the exit is 2. A write that fails for another reason, a
full disk under `> report.json`, keeps `unexpected error:` and its stack.

<!-- @assert-count target="bin/spec-guard.js" symbol="EPIPE" expected="1" reason="the launcher answers a closed stdout in a line, and the tests that run the launcher are skipped where nothing is built" -->

An output smaller than the pipe is written whole before its reader leaves, and
that run ends as it would have: `spec-guard --help | head -c 10` exits 0.
