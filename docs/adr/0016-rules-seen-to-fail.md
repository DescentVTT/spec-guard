# ADR-0016: A rule is trusted when it has been seen to fail

## Status

Accepted (2026-09-26).

## Context

A passing rule says two things at once, and a report cannot tell them apart:
the code holds, or the rule cannot see the code. A target renamed away under an
`--allow-missing-targets` run, a `glob="*.js"` over a codebase written in
TypeScript, an `exclude` that takes in the whole target, a count whose maximum
no change can cross: each passes today and would pass whatever the code did.

ADR-0003 met the same problem in the tests and named it. Coverage says a line
ran; mutation testing says whether a test would notice the line behaving
differently, by changing the line and running the tests. A passing rule is a
covered line. Whether it would notice is a separate question, and the way to
ask it is the same: change the tree the way the rule forbids, and run the rule.

The spec-core family contract (its ADR-0005) says a tool never writes git and a
tool's answer is the same every time. Changing the tree on disk to find out
would break the first and, interrupted, leave a violation in someone's working
tree. ADR-0014 already put every read a run makes behind one door, and gave a
caller of the API that door as `RunOptions.io`.

## Decision

**`spec-guard prove [patterns...]` shows each rule in force a violation of
itself, in memory, and reports whether the rule failed.**

<!-- @assert-present file="src/prove.ts, src/overlay.ts, tests/prove.test.ts, tests/overlay.test.ts" reason="the proof and the door it makes its violations behind" -->

### In memory, one rule at a time

- **The violation is an overlay.** `overlayIo` answers a read from a map of
  files added, replaced and removed, and from the door beneath it otherwise, so
  a walk, a stat, a listing and a read all see one changed tree. Nothing is
  written, and nothing touches git. `tests/overlay.test.ts` and
  `tests/prove.test.ts` hash every file of a real tree before and after and
  require them equal.
- **Each rule is run as a run runs it**: `executeAssertion`, with the scanner
  reading through the overlay and caches of its own, so nothing one violation
  did is visible to the next. ripgrep cannot read through a door (ADR-0014), so
  `prove` never uses it and refuses `--engine`.
- **The disk is read once.** Every rule is run over the tree several times, and
  `readOnce` keeps what the door beneath the overlays read for the length of the
  command. Proving this repository's rules, 74 when this was written, took
  about a second.
- **The order is the specs' order**, one rule after another, so the report is
  the same every time the tree is. A test runs it twice and compares.

<!-- @assert-import-absence target="src/prove.ts, src/overlay.ts" module="node:fs, node:fs/promises, node:child_process" reason="a proof reads through the door and writes nothing" -->
<!-- @assert-absence target="src/prove.ts, src/overlay.ts" regex="true" symbol="\b(writeFile|appendFile|mkdir|rmSync|unlink|rename)\b" reason="the violation is made in a map, never on disk" -->

### What a violation is

A rule makes claims a violation can cross: its maximum, a minimum above zero,
and for `@assert-present` the files it names. Each is probed on its own, so a
rule with both bounds is proved on both, and survives if either survives.

| Rule | Past its maximum | Under its minimum |
| --- | --- | --- |
| `@assert-absence`, `@assert-count` | a file holding the text as many times as it takes | every line holding the text taken out of every file that holds it |
| `@assert-import-absence`, `@assert-import-count` | as many files as it takes, each importing the module, in the language of the files beside them | every file importing the module emptied |
| `@assert-import-cycle` | two files importing each other, for each cycle it takes | |
| `@assert-layers` | a file in a lower layer importing the next layer up | |
| `@assert-structure pattern` | a file named `spec-guard-prove` with the scope's extension | |
| `@assert-structure required` | the first entry taken out of the first directories the rule selects | |
| `@assert-structure partner` | the partners of the first files it reads taken away | |
| `@assert-present` | | the first file it names removed |

- **A violation goes beside the files the rule reads.** A new file is named
  `spec-guard-prove`, with the extension of a file the rule reads, in the
  directory of the first file with that extension, and is used only if the
  rule would read it: `governs`, from ADR-0012, answers that without a walk.
  Each extension is tried in turn, which is what an import rule over two
  languages needs: C# has no spelling for `left-pad`, and TypeScript does. A
  rule that reads no new file - one whose target is a file, or whose glob names
  files - gets the text or the import at the top of the first file it reads,
  before anything that file could open. An import there makes one more file,
  so it is tried only when one more file is what the maximum takes.
- **When a rule reads nothing, the violation goes beside the code under its
  targets.** That is the finding a glob that misses the code's extension ought
  to produce: the rule passes, and passes with the violation in place.
- **A minimum is crossed by taking away, never by removing a target.** Lines
  are taken out, or a file emptied, so a rule over one file fails on its count
  and not for a target that is gone.
- **Text for a regular expression is written, then checked.** `regexWitness`
  writes text for literals, escapes, classes, groups, alternatives and counted
  repetition, and the rule's own matcher must match it before it is used. A
  pattern it cannot write for, lookaround or a backreference, makes the rule
  unprovable with that reason; a guess is never reported as a violation.
- **A module is named by spec-core's witness search**: a literal is itself,
  and `@app/db/**` a name just below `@app/db`.

### What each rule is found to be

- **`killed`**: the rule failed with the violation in place. Each violation
  only adds what the rule forbids or takes away what it requires, and never
  takes away a target, so the failure is the one the violation was made for.
- **`survived`**: the rule still passed. The violation is reported, with what
  the rule counted, because that is the finding. Each change it made is listed
  with its path and, for a file written, how many bytes it holds.
- **`unprovable`**: no violation could be made, and the report says why: the
  rule fails already, its targets are missing, its scope holds nothing to put a
  violation beside, no text matches its pattern, no file sits below another
  layer, no directory is selected.

A rule that fails on the tree as it stands is `unprovable`: no change can be
shown to be what fails it. `spec-guard` itself reports that failure.

`prove` exits 1 when a rule survived or a directive could not be read, and 2
when it could not run, as a run does. Under `--strict` an unprovable rule exits
1 too: a rule nobody can show failing is analysis that could not be completed,
which is what `--strict` has always refused. `--json` writes a document with a
`formatVersion`, which moves when a field is removed or renamed.
`--format sarif` puts a survivor on its directive as an error and an unprovable
rule there as a note. Rules in documents not in force are not proved, and are
named, unless `--ignore-status`.

## Consequences

### What `killed` does not mean

A kill means the rule can fail. It does not mean the rule catches the spelling
the code uses. A rule about `module="src/db.ts"` is killed by
`import 'src/db.ts'`, while every file in the repository writes
`import './db.js'`, which it does not match. A misspelled module name is killed
the same way. `prove` makes the most direct violation of what the rule says,
and that is a floor: a rule that survives it passed with the plainest
violation of itself in place, and a rule killed by it can fail, which is all a
kill claims. What the code actually writes is the
run's to check, and `query` shows what a rule asks of a path.

### This repository

The first proof of this repository's own rules, 71 at the time, found one that
could not fail as written. ADR-0008 held `src/polyglot.ts` to `expected="1"` import of
`src/imports.js`, with a reason saying it failed if the import became a value
import. Over a target of one file, the count of importing files is one at most,
so the maximum could never be crossed, and a value import still counts one: it
passed with the import made twice. The minimum was sound. That rule is now
`min="1"`, and its reason says which rule catches which change. A second rule
was unprovable on that proof, and only because it was failing: ADR-0013's rule
that every module has a test of its own name, which `src/prove.ts` and
`src/overlay.ts` did not yet have. With them, and with this ADR's three, all 74
it then held were seen to fail, and CI runs `spec-guard prove` beside the run,
so every rule added since is held to the same.

It runs without `--strict`, as the run does. Under `--strict` every import rule
over `src` fails on the tree as it stands, on the one `require(manifest)` in
`cli.ts` that no rule can resolve, and a rule that fails already is
unprovable. `--strict` is a statement about how rules are run, and a proof runs
them as the project does.

### What it costs

Every rule runs at least twice, once as the tree is and once per violation
tried. Violations are tried until one fails the rule: a new file of each
extension the rule reads, then the top of the first file it reads, so a rule
that survives has been run once for each. On this repository proving its 74
rules took about a second when this was written, against a fifth of one for
the run. It is a check for a
change to the rules more than for a change to the code: a rule's teeth change
when its directive does.

### Held to the mutation bar

Stryker over `prove.ts`, `overlay.ts` and the lines of `cli.ts`, `reporter.ts`
and `glob.ts` this added: 1,115 mutants, one survivor. It adds an exclusion
to the search that looks for code under a rule's targets, and Stryker's
pattern is one no path meets, so it excludes nothing: equivalent.

The first sweep scored 85%, and what it found was worth more than the number.
Some of it was tests that never looked: the report in colour, a list of two,
an option left at its default. The rest was code that did work no report could
show. A minimum was crossed by taking lines out of a file, and emptying the file
reached the same count, so which one happened was invisible; each change now
carries the bytes it wrote, and the violation says how many lines went. A rule
could be named with every reason a claim had none, and only a maximum can have
one. A layer file claimed by two layers was guarded against, and a rule that
passes has none. And an import at the top of a file was tried when two files
were needed, where it could only ever add one.
