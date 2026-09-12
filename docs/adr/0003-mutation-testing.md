# ADR-0003: Mutation testing, and why vitest is pinned to 4.x

## Status

Accepted.

## Context

This repository reports high line coverage. Coverage is a weak signal: it says
a line executed, not that any assertion would notice if the line behaved
differently. For a tool that exists to make claims verifiable, shipping tests
whose strength is unmeasured would be self-defeating.

Mutation testing measures the thing coverage cannot. Stryker rewrites the
source one small change at a time - flipping `<` to `<=`, emptying a string,
removing a branch - and reports which changes the suite fails to notice.

## Decision

Run Stryker over `src/`, with the vitest test runner and `perTest` coverage
analysis, and **pin vitest to 4.x**.

The pin exists because of a silent failure, not a preference.

On vitest 5, `@stryker-mutator/vitest-runner` reports a score without ever
activating the mutants. The evidence was unambiguous: a mutant that replaced
an entire branch body with an empty string was reported as SURVIVED by the very
test that asserts that branch's output, and the run summarised itself as
`Ran 0.00 tests per mutant on average`. The overall score came out at 3.54%
against 99% line coverage. Nothing errored; the number was simply fiction. The
runner's peer range (`vitest >=2.0.0`) is optimistic about vitest 5's module
runner.

Two independent harnesses now agree on the same code, which is what makes the
current setup trustworthy:

| Harness | Result on `formatDuration` |
| --- | --- |
| `command` runner (framework-agnostic, activates via `__STRYKER_ACTIVE_MUTANT__`) | 5 killed, 3 survived - 62.50% |
| `vitest` runner on vitest 4 + `perTest` | 5 killed, 3 survived - 62.50% |

The `vitest` runner on vitest 4 is the one kept, because `perTest` analysis runs
about a dozen relevant tests per mutant instead of all 248. The command runner
needs a full suite run per mutant - around 9 seconds each, which is hours for
this project and unusable in CI.

The cost is that the everyday suite is slower on vitest 4 than on 5 (roughly 7s
versus 3s here). That is a real regression, accepted knowingly: a working
measurement of test strength is worth four seconds per run.

<!-- @assert-count target="package.json" symbol='"vitest": "^4' expected="1" reason="vitest 5 makes Stryker report a fictional score; see this ADR" -->
<!-- @assert-present file="stryker.config.mjs,vitest.mutation.config.ts,.github/workflows/mutation.yml" -->
<!-- @assert-present file="scripts/mutation-equivalence.mjs,scripts/mutation-probe.mjs" reason="the equivalence measurement in this ADR must stay reproducible" -->
<!-- @assert-count target="tests" symbol="ANY_FILE_PROBE" min="1" reason="its contract is a cost, which no output assertion reaches; see the any-file probe below" -->

## Result

The first honest run scored **77.23%** (1547 killed, 44 timed out, 417
survived). The weakest file was the reporter at 65.48%, and the reason was a
single habit rather than a missing test: nearly every reporter assertion was
`toContain` against colourless output. That leaves blank-line placement, colour
selection and every `> 0` boundary unpinned - a mutant could prepend a junk line
to the output array or turn `remaining > 0` into `remaining >= 0` and no
assertion would notice.

Seventy-five tests were added in response, split into two files that say why
they exist: exact whole-output comparison for the reporter, and a per-source
file of boundary and wording tests. That moved the score to **83.16%**.

| File | Before | After | Survivors |
| --- | --- | --- | --- |
| cli.ts | 94.68% | 94.68% | 6 |
| reporter.ts | 65.48% | 87.30% | 87 -> 32 |
| runner.ts | 76.17% | 85.74% | 105 -> 64 |
| parser.ts | 85.54% | 88.43% | 34 -> 28 |
| glob.ts | 76.78% | 78.28% | 61 -> 57 |
| engine.ts | 74.46% | 75.63% | 124 -> 117 |
| **total** | **77.23%** | **83.16%** | **417 -> 304** |

The engine and the walker moved least. Their survivors are concentrated in
subprocess plumbing and filesystem ordering, where a test would have to
manufacture a misbehaving ripgrep or an unordered directory listing to observe
the difference. One of them is worth naming: mutating the `entries.sort()` in
`walkFiles` survives, and it cannot be killed reliably on Windows because NTFS
returns directory entries in order anyway - the existing ordering test passes
for the wrong reason there, and only does real work on other filesystems.

### 0.2.0: 88.76%, and a dial that fakes it

Making the engine's internals testable (see ADR-0004) moved the score again:

| File | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| glob.ts | 78.28% | **92.57%** |
| runner.ts | 85.74% | **91.80%** |
| engine.ts | 75.63% | **83.05%** |
| parser.ts | 88.43% | 90.50% |
| reporter.ts | 87.30% | 87.30% |
| cli.ts | 94.68% | 94.68% |
| **total** | **83.16%** | **88.76%** |

The two files that barely moved in the first round moved most in the second,
because the fix was structural rather than more tests: the ripgrep JSON handling
and the batching decision were extracted into pure functions that can be
asserted directly.

**Timeouts are a dial, and it silently sets the score.** Stryker counts a
timed-out mutant as killed, which is right when the mutant genuinely hangs -
several here turn a binary search into an infinite loop. But the timeout is also
a tuning knob. Lowering `timeoutMS` from 60s to 15s, changing nothing else,
moved 220 mutants from *survived* to *timed out* and lifted the reported score
from 88.76% to **94.48%** without adding a single test. Those mutants finish
within 60s, and the suite passes when they do: they had survived, and the
shorter clock was merely calling slow code dead.

The 60s budget is kept - about five times the whole suite - so that reaching it
means a hang rather than a slowdown, and 88.76% is the number this project
claims. A metric that improves when you shorten a clock is not measuring test
strength.

**The score is platform-dependent, for the same reason.** The same commit under
the same configuration scores 88.76% on Windows and **86.40%** on Linux CI, and
the gap is entirely timeouts: 127 mutants hang on Windows against 43 on Linux,
and the 55 extra Linux survivors are those same mutants finishing in time to be
seen as survivors. Nothing about the tests differs; the machine is just faster.

The number this project quotes is therefore the CI one - the lower figure,
produced where the gate actually runs. A metric worth trusting should be quoted
at its least flattering measurement, not its best.

A second pass over the survivors took CI from 86.40% to **88.56%** (217 left,
down from 260). Two things came out of it that were not more tests. The sort at
the end of `scanContent` turned out to be dead code - `exec` scans forward and a
Map keeps insertion order, so its mutants survived because they could not change
any result, and the honest fix was deleting it. And three of the newly written
tests were thrown out for passing without proving anything; one of those had
never reached the validator it claimed to test, which is how the CLI came to
report "requires a value" for `--max-snippets=-1`.

The same trap caught a test of the batching rule: `sharesOnePass` compares
exclude sets by identity as its *last* condition, so building a fresh `new Set()`
per request made every group differ for that reason alone and none of the
earlier comparisons ever ran. The rewritten tests share one set and vary exactly
one field each.

The `break` threshold is 85: below the CI score, so a regression fails the build,
but not so tight that ordinary refactoring trips it.

### 0.3.0: a state machine moves the baseline

Adding `src/imports.ts` - a tokenizer for the import assertions in ADR-0005 -
dropped the CI score from 88.56% to **80.62%**, well under the gate of 87. The
gate failing is the gate working, and the response was to read the survivors
rather than move the floor.

Two rounds of tests took it from 80.62% to **84.63%**. What they bought:

- **A real bug.** Removing the `import.meta` guard survived every test written
  for it. Applying that mutant by hand and hunting for a distinguishing input
  showed why: with semicolons the clause scan stops at the `;` before it can
  reach `from`, so the guard looks redundant. Without semicolons - ordinary
  style under `prettier --no-semi` or standard - the `import` of `import.meta`
  runs on and claims the next statement's specifier, reporting an export on
  line 2 as an import on line 1. The analyser behaved differently on
  semicolon-less source and nothing tested it.
- **Positions.** Every analyser test asserted which specifier was found and none
  asserted where. Those numbers are what a failure report points the reader at.
- **Twenty-two real-world syntax shapes** pinned down: aliased and default
  re-exports, webpack magic comments, import attributes, shebangs, CRLF, a byte
  order mark, TSX generic arrows. None found a bug, which is why they are worth
  recording.

The floor is now **84**, against a CI measurement of 84.63%. The justification
is not "the remaining mutants are equivalent" - that is the rationalisation
available to anyone who does not want to write tests, and it was checked rather
than assumed by hand-applying mutants and looking for inputs that distinguish
them. It is that a tokenizer genuinely carries more indistinguishable mutants
than the string-searching code the old figure was calibrated on: branches inside
a state machine that no input reaches, and counters whose value never escapes.
`src/imports.ts` sits at 73.62% while every other file is between 84% and 96%.

> **This paragraph was wrong, and 0.5.1 below says how.** The claim that a
> tokenizer inherently carries more indistinguishable mutants was drawn from
> checking a handful of them by hand and generalising. Most of that 26% was
> reachable and simply untested.

The headroom is 0.63 rather than the ~1.5 used for the previous two settings.
That is deliberate: a marginal regression should trip this gate. If run-to-run
variance turns out to trip it instead, the honest fix is to lower it again with
that evidence recorded - not to widen it pre-emptively against a problem that
has not happened.

### 0.3.0: comment classification, and a first run that only just passed

`src/comments.ts` landed after the gate was re-anchored, and the first CI run
with it scored **84.10%** - over the floor of 84 by 0.10, where the setting had
been chosen with 0.63. Passing by that margin is not passing; it is the gate
telling you the next commit will fail for no reason of its own.

The drop was concentrated in the new code, so the survivor list was worked
through rather than explained away. Sixteen died to one focused round:

- **Nine in the language table.** No test distinguished the single-quote rule
  from no rule at all, an escape flag from its opposite, or C's block comments
  from Rust's nesting ones. The instructive one is the escape check inside
  `endOfString`: mutating it to "everything is an escape" makes a string run to
  the end of the file and swallow every comment after it - the silent-pass
  direction this feature exists to prevent - and all six existing string tests
  passed anyway, because each asserted on text *inside* a literal and none on a
  comment *after* one.
- **Five in the reporter**, one of which was a hole rather than a weak test: the
  `--verbose` per-assertion branch had no coverage at all, so every mutant that
  emptied it survived and the block could have been deleted unnoticed.
- **Two on the new CLI flag**, which `parseArgs` had never been asked about.

Three more were genuinely equivalent and were deleted rather than tested: a
short-circuit deciding whether a `find()` ran, when the branch ordering already
decided whether its result was used. Removing redundant code removes its
mutants honestly; asserting on it would not have.

That took CI to **84.86%** - above the 84.63 the floor was set against, so the
gate stays at 84 and the headroom returns to 0.86.

Two things worth recording for whoever grows this suite next:

- **A hang costs a minute.** Some mutants make a scanner loop forever, and each
  one burns the full `timeoutMS`. One of them found a real defect first: the
  scan loop could stand still while appending to an array, so it would not spin
  but exhaust memory - the same fault already fixed in `src/imports.ts`. The
  loop now has a single advance point. That is worth doing for the product; it
  does not make the mutants disappear, and chasing that would be optimising the
  metric instead of the code.
- **The job is no longer cheap.** 2,118 mutants at 6m54s became 3,019 at
  12m29s, and 3,493 at 15m51s, against a 30-minute cap. Measure it rather than
  assume it; the arithmetic that first set that cap was wrong by a factor of
  five, and the estimate for this growth was wrong too - the mutant count rose
  16% while the clock rose 27%, and timeouts were only 54 of the 474 new
  mutants.

### 0.4.0: the gate moves up, for once

The scope rewrite (ADR-0007) took CI from 84.86% to **85.61%**, and the floor
moved with it, to **85**.

Two things paid for that, and only one of them was writing tests:

- **Deleting code.** Making ripgrep a pre-filter removed its JSON parser, the
  byte-to-character column conversion and the whole safe-batching apparatus.
  Those existed to make ripgrep's own counting trustworthy, and they carried
  mutants that were hard to kill precisely because a correct batch and a
  correct set of separate passes are indistinguishable from outside. Code that
  does not exist has a perfect score, and this is the honest version of that
  joke: the behaviour did not disappear, the second implementation of it did.
- **A hole the score found before a user did.** `reporter.ts` came back at
  83.19% with twenty-six mutants that no test *executed* - not survivors,
  unreached code. Every reporter fixture carried an empty ledger, so the prose
  explaining a skipped file returned on its first line and had never been
  rendered once. That sentence is the entire user-visible surface of "nothing
  is skipped quietly"; without it a reader sees a green run and cannot tell a
  clean tree from an unread one. Eight tests later, `reporter.ts` is at 91.59%
  with no survivors and nothing uncovered.

The gate is raised rather than left at 84 because banking the difference as
slack is how a regression guard stops guarding. 0.61 of headroom is the same
discipline the 0.3.0 entry above argues for: tight enough that losing ground
fails the build, and if run-to-run variance turns out to trip it instead, the
honest fix is to lower it again with that evidence recorded.

### 0.5.0: two tiers, because the full sweep stopped being cheap

The full sweep was 6m54s at 2,118 mutants, 12m29s at 3,019, and 15m51s at 3,493.
Extrapolating that is not a plan. A check that gets quietly more expensive every
release is a check somebody eventually proposes lowering, and the argument for
lowering it always sounds like budgeting rather than like giving up.

So the trigger is split rather than the gate:

| when | mode | authority |
| --- | --- | --- |
| push to a branch, pull request | `--incremental` | provisional |
| push to `main`, weekly schedule, manual | full sweep (`--incremental --force`) | authoritative |

Stryker's incremental mode reuses the verdict for any mutant whose source *and*
covering tests are both unchanged, invalidating on file hashes. That is sound as
far as it goes, and "as far as it goes" is the important half: it is a
heuristic, and the full run is not. Three things keep that from becoming a lie:

1. **The gate applies in both tiers.** A branch cannot get worse unnoticed.
2. **Every push to `main` re-derives the score from scratch**, so nothing stays
   merged on a cached verdict for longer than one run.
3. **Only a full sweep publishes the cache.** An incremental run's file is
   derived from a cache rather than from the code; feeding it back in is how a
   stale verdict would survive indefinitely. A branch that finds no cache at all
   simply does a full run and is correct, only slower.

The job name carries the tier - `stryker (full)` or `stryker (incremental)` - so
a green tick in the checks list cannot be mistaken for an authority it does not
have.

**The full sweep is now 22m11s** at 4,512 mutants, against 15m51s at 3,493 and
6m54s at 2,118. The job cap moved from 30 minutes to 45 on that measurement:
five minutes of headroom is not headroom, and a cap that a normal run brushes
against fails builds for reasons that have nothing to do with the code. This is
the third time this number has been measured and the second time it has been
wrong to assume.

**Measured, on this repository.** A branch push whose commit touched only
documentation restored main's cache and finished in **13 seconds**, reporting
**87.21%** - the identical score, to the decimal and per file, that the 22m11s
full sweep produced. It executed no mutants at all.

That number is the argument for the design and the warning about it in the same
breath. A green `stryker (incremental)` tick can mean "every mutant was
re-verified" or "no mutant was verified and last week's answer was reprinted",
and nothing in the score distinguishes them. Which is why the tier is in the job
name, why the step summary says the verdicts were reused, why only a full sweep
publishes the cache, and why `main` re-derives the number from scratch on every
push. The saving is real; the authority is not transferable.

13 seconds is the floor - nothing changed, so nothing was re-run. A branch that
edits one source file re-runs that file's mutants: `polyglot.ts` is 603 of 4,512,
so roughly 3 minutes plus the floor. That last figure is arithmetic, not a
measurement, and is marked as such rather than quoted as one.

**What incremental mode does not save.** Measured locally over a single file
(52 mutants): 51 s cold, 23 s with a cache and nothing changed. It skips mutant
*execution*, not the sandbox setup or the initial coverage run, so there is a
floor that no amount of caching gets under. On a one-file scope that floor is
most of the run; on the full suite, where mutant execution dominates, the saving
is proportionally larger. Both numbers are worth knowing before anyone expects
incremental mode to make the check free.

What this trades away is honest to state: a mutant killed only by a test that
was changed in a way Stryker's hashing does not catch would go unnoticed until
the next `main` run. That is a post-merge detection rather than a pre-merge one.
The alternative - a full sweep on every branch push - was the status quo, and it
is the thing that stops being affordable.

### 0.5.0: the gate earning its keep

The first full sweep of 0.5.0 came back at **83.77%** and failed the build. That
is the entry worth having in this document, because everything else in it is
about a number going up.

Roughly 700 lines of new code had gone in with what looked like thorough tests:
92 cases for the four new language readers, 25 for the baseline, 17 for SARIF,
13 for the empty-scope check. Every one of them passed. Every defect in the
negative-control pass - 13 of them, each reintroduced by hand - was caught. And
`polyglot.ts` still came back at **77.45% with 132 survivors**.

The gap was not in the languages. It was in the two hundred lines of cursor,
bracket and literal arithmetic that all four readers share, and it was invisible
from where the tests were standing:

- `logicalLines` tracks `(`, `[` and `{`. Every test used `(`. Twenty-seven
  mutants lived on two lines, including one that let a stray `)` push the depth
  below zero and fuse the rest of the file into a single statement.
- `Reader.skipSpace` checks four character codes. Every test used a space.
- `literalValue` distinguishes `startsWith` from `endsWith`, which are the same
  answer for every *well-formed* literal - so only an unterminated docstring
  tells them apart, and no test had one.
- Eight mutants in `cli.ts` had no coverage at all: `--print-baseline` was
  tested through `formatBaselines` and never once through the CLI.

74 more cases later, `polyglot.ts` is 91.71% and `runner.ts` 87.98%, and the
sweep is **87.21%** - above the 85.61% that 0.4.0 finished at. The lesson is not
"write more tests". It is that a suite can be thorough about the thing it was
written to test and silent about the thing underneath it, and that testing what
a reader does with Python says nothing about what its cursor does at the end of
a file. Coverage said those lines ran. They did run - through the front door,
with the values the front door supplies.

### 0.5.1: the excuse that had been sitting there for three releases

`imports.ts` had been the lowest-scoring file since 0.2.0, and ADR-0003 had an
explanation for it: a tokenizer carries branches inside a state machine that no
input reaches and counters whose value never escapes, so its score is
structurally lower than string-searching code. That explanation was written
after hand-checking a few of the survivors, and it was believable enough that it
stood for three releases while the file sat at 73.62%.

It was mostly wrong. 114 targeted tests took `src/imports.ts` from **73.74% to
91.94%**, killing 113 mutants and closing all 28 lines that no test executed.

What the real gap was:

- **Every other test of the analyser asserts on module references**, which is
  blind to almost everything the tokenizer does. A template resumption that
  loses its place, a regex escape that skips one character too few, a `$` that
  is not a substitution - none of those change the reference list for any file
  anyone thought to write a test for. The whole second half of the template
  scanner, the path that handles `` `${a}${b}` ``, had **no coverage at all**.
- **A third of the survivors were table entries.** `REGEX_AFTER_WORD`,
  `REGEX_AFTER_PUNCT` and `JS_EXTENSIONS` mutate one string at a time, and
  nothing asserted the tables. Those are not incidental constants - `<` being
  *absent* from the punctuation list is a documented decision that stops JSX
  closing tags from starting a regular expression, and a hole that has to stay a
  hole. They are now asserted entry by entry.

The fix was a test file that treats the tokenizer as a thing with an output
rather than as a step on the way to something else. 11 of 11 reintroduced
defects were caught, including the two that the previous suite would have let
through in silence: a second `${` going unnoticed, and a dropped table entry.

One structural change came with it. The word branch guarded against a
zero-width read with an `if (scan === index) scan += 1` afterwards, which was
unreachable - every identifier-start character is also an identifier-part
character - and therefore untestable. It now starts the scan one character in,
so progress is unconditional by construction rather than a consequence of a
relation between two predicates that nothing enforces. Verified
behaviour-preserving on 53.6 MB of real JavaScript: 17,491 references and 6
unreadable files, identical before and after.

**What is left, and how it was checked.** 51 survivors remain. Eight of them
are the same shape - `while (index < source.length)` loosened to `<=` - and
rather than argue that past the end of the input every branch is false, each
occurrence was mutated *on its own* and both tokenizers were run over 5,488
inputs: every prefix of a real source file, twenty-nine inputs designed to end
mid-construct, and 2,500 files from `node_modules`, comparing the whole token
stream and the desynced flag. Seven are equivalent. The eighth - the main loop -
is not, and is killed by `tokenize('')`, which is the cheapest test in the file.

That is the difference between the two claims. "These are equivalent" was
checked and turned out to be true for seven of eight; the version of it that
stood for three releases had not been checked at all.

**The floor moves to 89**, against a CI measurement of **89.84%** over 4,509
mutants - the largest single jump this project has recorded, and the only one
that came from a single file. 0.84 of headroom, in line with the 0.61 and 0.63
used for the previous two settings. Every file is now above 83%, where the
spread used to run from 73% to 96%; `src/engine.ts` at 83.65% is the new lowest,
and this document is no longer offering a reason why that is fine.

The lesson is the one this document keeps relearning in different clothes. "The
remaining mutants are equivalent" is the rationalisation available to anyone who
does not want to write tests, and this ADR says so at line 172. It then made a
softer version of the same move - "this *kind of code* carries more equivalent
mutants" - and that version survived three releases because it sounded like
engineering judgement rather than an excuse.

### 0.5.1, continued: every module, and what writing it down turned up

The section above ended with `src/engine.ts` at 83.65% and no excuse offered.
The rest of the same release took every module to its ceiling. The point of recording it is not the
number; it is what happened on the way.

**Four wrong answers, not four missing tests.** Each of these was found by
trying to write down a contract that had only ever been checked through its
effect on a match count.

- The result cache keyed on the symbol, the targets and the search flags, but
  not on `comments`. A spec with two assertions on one symbol - one of them
  `comments="include"` - was answered for both with whichever count ran first.
- The grouping test had the same omission, so those two assertions were also
  merged into one pass and the second was scanned with the first's mask.
- Neither considered `scope`. One `ScopePolicy` per run today; the day that
  stopped being true it would have been the same defect a third time.
- The adaptive engine had the walk's skip ledger in hand and returned without
  it on any tree small enough to scan in process. An unreadable directory was a
  reported gap on a large repository and silence on a small one - the same tree
  answered two ways, decided by its size, which is precisely the drift ADR-0007
  exists to remove.

The first three are one defect: "when are two requests the same question" was
answered by three hand-maintained lists of fields, and lists like that drift.
There is now one definition in three nested scopes - walk, pass, search - each
being the one inside it plus what that layer adds. The fourth is what a
`toContain` on a count cannot see.

Two smaller ones came with them. Every snippet from a CRLF file carried a
carriage return into the report, because the trim looked for `\r?\n` at the end
of a line the caller had already cut at the newline - a pattern that cannot
match anything it is given. And a bad `regex="true"` pattern was reported as
`Invalid regular expression: Invalid regular expression: /(/: ...`, because V8's
message already says it once.

**A harness limitation, reproduced.** Eleven mutants in `src/comments.ts` sat in
module-level `.map()` callbacks that build the extension-to-language table.
Stryker reported all eleven as survived. The suite kills every one of them:
applying any of them by hand makes `new Map` throw on an entry that is not a
pair, and every test file that imports the module fails to load.

    $ # (extension) => [extension, C_SHARP]   ->   () => undefined
    $ npx vitest run tests/comments.test.ts
    FAIL  tests/comments.test.ts [ tests/comments.test.ts ]
    TypeError: Iterator value undefined is not an entry object
    Test Files  1 failed (1)

Stryker ran the whole suite for each of them - the log says "Ran all tests for
this mutant" - and reported Survived anyway. Reproduced locally with
`--mutate 'src/comments.ts:140-185'`, so it is not a property of the hosted
runner.

What is measured is the contradiction. The explanation that fits it is that a
mutant which stops a test file *loading* produces no test *results*, and zero
failing tests reads to the runner as no test having killed it - vitest reports
that case as "1 failed | no tests". What rules out the simpler explanation, that
module-level code is never re-executed under a mutant, is that on the very same
lines `StringLiteral` and `ArrayDeclaration` mutants are killed normally: 156 of
the 184 static mutants in this file die, and only the ones that break the import
survive.

Two things follow. The first is that `ignoreStatic` was *not* turned on.
Measured on the sweep this decision was taken against, it would have removed all
473 static mutants from the score, of which 414 die honestly - discarding those
to hide 59 artefacts hides more than it reveals. Where a static survivor is a
false one, it is better to say so here.

The second took two attempts, and the failed attempt is the more instructive.
The table was rewritten as plain data - an array of `[extensions, syntax]` rows
filled in by a loop - and this document said the construct was gone. It was not.
A row emptied to `[]` destructures to `undefined` and the module throws while
loading, which is the same failure mode in a different spelling: ten mutants
moved from one shape into the other and went on being reported as survived.
Removing the callback was not the same as removing the property that mattered.

What matters is that a mutant produce a *wrong answer* rather than a *dead
module*. The table is now a `register(syntax, extensions)` call per language.
Emptying an argument list cannot throw; it leaves `syntaxFor('a.cs')` answering
null, which is something a test can see, and one does. The lesson generalises
past this table: when a mutant is unmeasurable, the question is which shape
makes its failure visible - not whether some rewrite will do.

**What was deleted rather than tested.** Seventeen branches turned out to be
unable to decide anything, and deleting a branch is a cleaner kill than pinning
it. The recurring shape was a presence check in front of a comparison that
already handled absence: `bounds.min !== undefined && count < bounds.min` guards
nothing, because `count < undefined` is false for every count. The same shape
appeared in the min-greater-than-max check. The rest, in one list: a floor of
one reader for a list of no files; a guard around an empty batch the caller had
already answered; a shortcut for a single request that `searchBatch` handles
identically; an empty-list guard in a function only ever called with a non-empty
one; a `typeof` narrowing a `Set` lookup already performed; a `catch` around a
`spawn` that cannot throw; an uncertainty filter over a ledger that only ever
holds uncertainty; a `symbol: ""` invented for a walk that never searches for
one; a `language === 'csharp'` branch returning exactly what the general case
below it returned; a backslash on a regex-escape list that `toPosix` guarantees
cannot arrive; a bracket counter in the C# generic skip, which ends at the
directive's `;` whatever is nested inside it; and the "no bounds at all" branch
of two prose functions that are only reached from a resolver which refuses a
directive with no bounds. (`describeBounds` keeps its fourth branch: the
published `executeAssertion` *can* be handed an unbounded assertion, so that one
is reachable, and it is now tested.)

Four more were rewritten so that the case that could not be reached became one
that could. `maskRanges` advances its cursor to the furthest point reached, so
an empty, inverted or already-masked range is a no-op by arithmetic rather than
by a special case; `locate` searches a half-open interval, so the `- 1` that
converged to the right answer whichever way it was perturbed is gone;
`literalAt` compares three ways with the hit last, so both of its remaining
comparisons decide something; and `comparePaths` states what it does with a tie,
which no call site can produce and which is exactly why it had to be written
down.

**What is still unkillable, and why - measured, not argued.** This paragraph
originally listed the classes of mutant left alive and explained why each was
equivalent. That is the move this document warns against at line 172, made one
more time, and it was wrong about a fifth of them.

`scripts/mutation-equivalence.mjs` settles it. Every one of the 130 survivors in
the authoritative report was applied to the source at the exact span Stryker
reported, compiled, and run through `scripts/mutation-probe.mjs` - a fingerprint
of **4,176 observations**: the analyser over 1,200 files of real
JavaScript and TypeScript, every seventh prefix of a real source file, and a
hundred inputs designed to stop mid-construct in five languages; the tokenizer's
stream and its `desynced` flag; the comment lexer's ranges and its
`unterminated` flag against nine profiles; the directive grammar over the
project's own documents and twenty adversarial ones; the glob compiler's emitted
regular expression over 26 patterns crossed with 16 paths; every offset, engine
and runner helper; 240 directive resolutions; every reporter format - terminal
in eight colour, verbosity and ascii combinations, JSON, SARIF and the baseline
printer - over twenty result shapes; thirteen real runs over a real tree with
both engines, including a ripgrep subprocess; and 46 invocations of the command
line. The fingerprint is deterministic across repeated runs and demonstrably
sensitive: a control mutation of `comparePaths` changes it.

**29 of the 130 changed something.** Distinguishable is not the same as tested,
so each was then applied again and the *suite* required to go red: 29 of 29.
The interesting ones are the ones this document had already excused:

- Rust's brace counter *is* load-bearing. The argument for equivalence - that
  `expandUsePath` ignores text after the closing brace - holds only when there
  is no second `use` statement to swallow, and every fixture had one statement.
- The type-only chain's `&&` matters for `import A, { B } from 'x'`, a shape the
  tests did not have. Loosened, it marks an ordinary import type-only, and
  `types="ignore"` then drops it silently.
- Checking `*` without `/` opens a block comment on `2*3`. No adversarial input
  contained a multiplication; 1,200 files of real code contain thousands.
- `from .` defeats the Python pattern where `from import x` - the input the test
  used - quietly matches with an empty module name.
- `normalizeModule('.')` is the single relative marker whose stray slash
  `path.normalize` does not collapse. Every longer form hides it.

The 101 that changed nothing are indistinguishable to everything the probe can
reach, which is a measurement rather than an opinion - and worth stating with
its limits, because "indistinguishable" is only as strong as the instrument:

- `while (index < source.length)` loosened to `<=` reads one position past the
  end, where every branch is false. Checked exhaustively in 0.5.1 over 5,488
  inputs, and again here over every prefix of a real file.
- `.catch(() => null)` mutated to `() => undefined` is invisible to any caller
  that tests for falsiness, which is why `statOrNull` exists: one place where
  the difference is the contract.
- **Spawn options.** The probe starts a real ripgrep, but `windowsHide` has no
  effect on a process with no console to hide, and `stdio: ['ignore','pipe',
  'pipe']` emptied to `[]` gets the same defaults filled back in. Identical
  output is not a claim about identical behaviour on a Windows desktop.
- **Memoisation.** The enumeration cache and the `ripgrepMissing` latch change
  how much work happens, not what comes out. An instrument that measured work
  would separate them; this one measures output, on purpose.
- **The request keys**, which are conservative by construction: equal keys mean
  the same answer, and two spellings of one question cost only a repeated
  search, so a mutant that makes a key *finer* cannot change a result.

**And one of those bullets was hiding a real hole.** "An instrument that
measured work would separate them; this one measures output, on purpose" is an
honest statement of the probe's limits and a comfortable place to file anything
that survives. Reading the 22 engine survivors back one at a time turned up a
mutant that does not belong there:

```
ANY_FILE_PROBE: EnumerationBudget = { maxFiles: 0, maxBytes: 0 }   ->   {}
```

Emptied, both comparisons in `admit` become `x > undefined`, which is false for
every `x`, so `exceeded` never trips. Its one consumer here - `createScopeProbe`,
though the constant is exported and a caller of the library can pass it too -
asks `enumeration.files.length > 0`, and that answer is unchanged: the walk finds
the same first file, having read every directory in the scope and stat'd every
file in them to get there. This repository's own `src/` is flat and
thirteen files deep, so it would not have noticed; a nested source tree is a
full recursive traversal per distinct scope, and the cache this probe sits
behind exists because a spec asks the question once per assertion.

The difference between this and the memoisation bullet is that there the cost is
an optimisation over a behaviour that exists anyway. Here the cost *is* the
behaviour. `ANY_FILE_PROBE` has no other reason to exist - the constant is
named for the question it answers cheaply - so a survivor that removes the
cheapness removes the whole thing, and filing it under "the instrument measures
output" was the equivalence rationalisation this document opens by warning
against, arrived at from the other direction.

It is now pinned by a cost contract rather than by its shape. Asserting
`maxFiles === 0` would restate the source in the test file and kill the mutant
without establishing anything; what the tests assert is the traversal. A tree of
24 directories holding 192 files is walked twice through an injected
`DirectoryReader` that records which directories it was asked for: budgeted, the
probe reads two and returns one file with `exceeded` set; unbudgeted, the same
tree and the same reader cost 25 reads and yield all 192. The second half is
what makes the first half mean something - a bound of two proves nothing about a
fixture that only has two directories in it. A third test holds `createScopeProbe`
itself to the same bound with `fs.readdir` counted, because a cheap constant is
worth nothing if the caller stops passing it, and the boolean cannot tell.

Applied as a negative control, the mutant takes all three tests red and nothing
else: 3 failed, 199 passed. Stryker over that line alone reports 1 killed, 0
survived, and `src/engine.ts` goes from 22 unkilled mutants in 505 to 21 -
**95.64% to 95.84%**, with the whole project at **97.67% over 100 survivors**.
Both are CI measurements on this commit. They were written here first as
arithmetic on the previous report and confirmed unchanged, for the reason in the
next paragraph.

**A local sweep cannot confirm it, and finding out why is worth more than the
number was.** Re-running Stryker over the whole of `src/engine.ts` on this
machine returned **98.22%** - better than CI by more than two points, from one
new test. It is not better. Comparing the two reports mutant by mutant, 43
changed status and 42 of them are the same change: `Killed -> Timeout` for 30
mutants CI had killed outright, and `Survived -> Timeout` for 12 that CI
reported alive, including every spawn option in `findRipgrep` - code no test
added here goes near. The local run took 28m55s against CI's 17m56s for four
times as many mutants. The machine was loaded, mutants that merely ran slowly
crossed `timeoutMS`, and Stryker scores a timeout as a kill. CI then settled it:
the same tree, the same tests, **5 timeouts in `engine.ts` against the local
run's 47** - unchanged from the sweep before this commit.

That is the failure mode this document has been guarding against from the other
end. A timeout is a legitimate kill when the mutant genuinely hangs, and a free
one when the machine is busy - so a local score drifts *upward* under load,
which is the direction that feels like progress. It is the reason the gate is
checked in CI and the reason `timeoutMS` sits at 60s rather than somewhere
tighter, and it is now also the reason no score in this document comes from a
developer machine. Exactly one status change in that run survives the scrutiny:
`666:50 ObjectLiteral -> {}` moved `Survived -> Killed`, which the single-line
run and the negative control both confirm independently - the tests fail on
their assertions, not by hanging.

**The floor moves to 97**, against a CI measurement of **97.65%** over 4,299
mutants. Every file is above 95%, where the spread ran from 83% to 95% a release
ago, and three are at 100%. The survivor count CI reports is 101, which is
exactly the number the sweep proved indistinguishable *in output*: the ceiling is
measured, so the headroom is a regression guard rather than a cushion. One of the
101 turned out to be distinguishable in cost, and is now killed - see the
any-file probe above, after which CI reports 100 and 97.67%. Nine new test files, none of them a rewrite of an existing one: they test
each module as a thing with an output rather than as a step towards a count.
Where the old tests read a report with colour off - which is almost everywhere -
the colour arguments could have named any colour at all; the SARIF document is
now asserted whole, because a serialisation format is a contract with a machine
that is not in the room.

Thirty-five negative controls back it up, all thirty-five caught: each defect
fixed here, and each mutation a new test was written to kill, was reintroduced
one at a time and the suite had to go red. The harness refuses to run unless it
can confirm its patch applied, because a control whose anchor has moved passes
for the wrong reason - and the first pass turned up three that had not really
run, one of which was a genuine hole. The test written for the adaptive engine's
dropped ledger called `searchFiles` directly, which is not the branch that had
the bug; reintroducing the bug left the suite green, and the test now goes
through the engine with its directory reader intercepted. The other two were the
harness's own: an anchor written with `\n` against a CRLF file, and a "defect"
that was the deleted dead branch put back, which is not a defect at all.

And the changes that are meant to be invisible were checked against a corpus
rather than argued for. The analyser at this commit and the published 0.5.0
build were run over **6,976 files, 51.2 MB** of `node_modules` and compared file
by file - every reference with its kind, specifier, type-only flag and position,
and every note. 17,491 references, 156 notes, identical on every file.

### 0.6.0: a new feature, held to the same bar before it shipped

Document status ([ADR-0010](0010-spec-status.md)) was the first feature written
after the gate moved to 97, so it was swept before it landed rather than after.
The first sweep of the new code returned **93.04%** over 284 mutants - under the
gate - and what the seventeen survivors were is the point of recording this.

Eleven were reporter output nobody had asserted exactly: colour arguments
(`'dim'` -> `""`), the blank line separating the withheld list from the totals,
and the SARIF singular/plural. Cheap to kill and worth killing - a `paint(...,
"")` that nothing notices is a colour that can be deleted, and the blank line
is the difference between a block and a run-on.

Two were the honest kind of finding. A surviving `startsWith('#')` guard in the
`## Status` reader turned out to be **dead**, not untested: every ATX heading
begins with `#`, and a value that does not begin with a letter is already no
status at all, so the guard could not decide anything on any input. It was
deleted rather than pinned by a contrived test - the distinction the mutation
report is good at making is "nothing can tell this from its absence", and that
is a reason to remove code, not to write a test that restates it.

The other was an emphasis-stripping rule, and it is worth the whole section,
because the first fix for it was also wrong and the next sweep said so. Two
surviving regex mutants pointed at a rule that took one marker off each end of
a line, so "Superseded by *ADR-0007*" would have reached the report as
"Superseded by *ADR-0007". It was changed to unwrap only balanced markers - and
the sweep after that reported a surviving `$` anchor on the new pattern. The
mutant that survives an assertion is the one whose behaviour no input
distinguishes, so the question is always *which* input was missing, and here it
was `**Superseded** by ADR-0007`: the commonest way anyone writes the line.
Balanced-only unwrapping left that starting with an asterisk, no first word to
read, **no status at all** - a superseded ADR quietly left in force, which is
precisely the failure [ADR-0010](0010-spec-status.md) exists to prevent. The
word is now read *through* leading emphasis and the label is unwrapped only
when the markers balance: two rules, because they answer two questions.

The score went **93.04% -> 97.54% -> 98.91%** over three sweeps of the changed
code, 17 survivors down to 3, and a fourth sweep of the status reader on its
own reported **100% over 104 mutants with none alive**. That was recorded here,
and in the commit that shipped the feature, as the result.

**It was false, and CI said so.** The full sweep on `main` put the project at
97.52%, down from 97.67%, with every new survivor in `parser.ts` - nine alive
before the feature, twenty after. All eleven were regex mutants on the five
module-level pattern constants the "100%" sweep had covered. Applied to the
source by hand and run against the suite, all eleven survived. CI was right.

Finding out why the local run disagreed mattered more than the eleven, because
every targeted sweep in this section was a local run. The same mutant - the
`[ \t]+` after a heading's hashes, reduced to `[ \t]` - swept on its own on a
quiet machine is reported **Survived**, and the eleven mutants on that line
that were killed credit tests about status headings. The sweep that called it
killed had credited its kills to `ripgrep engine 'bare directory name' -> 5
files` and to `does not stop early when fail-fast finds no failure (killed
11)`. Neither reads a status line. Both spawn ripgrep.

The mechanism is a third form of the load artefact. A regex literal at module
scope is a *static* mutant: it is evaluated once at import, so Stryker cannot
attribute it to the tests that cover it and runs the whole suite against it
instead. The sweep ran while another repository's Stryker was saturating the
machine and while this suite was also running beside it - the run in which four
subprocess tests timed out at exactly vitest's 30s. Under that load those tests
fail against *any* mutant. A failed test is a kill. And because the failure is
vitest's per-test timeout rather than Stryker's per-mutant one, it is scored
**Killed**, not Timeout - so the warning this document already gives about
timeouts inflating a score could not see it. 0.5.1 found timeouts that were
kills in disguise; this is a failing test that is a timeout in disguise.

So the rule gets stricter. A local sweep is evidence only when the machine is
quiet, and never for static mutants: those are verified by applying each one to
the source by hand. For the status reader that is fifty-six mutants - every
level-1 mutant weapon-regex generates for its nine patterns, the generator and
the level Stryker's own regex mutator uses - and after the fixes below **all
fifty-six are killed**. `scripts/mutation-regex.mjs` writes each into the real
file, refuses to count one whose literal does not appear exactly once, and
restores the source.

<!-- @assert-present file="scripts/mutation-regex.mjs" reason="static mutants are verified by hand, not by a sweep; this is the hand" -->

The eleven were not all missing tests. Two were, in the plain sense: the
indent and space allowances in the label and heading patterns had no input
that exercised them. The rest pointed at behaviour:

- **`Status: **Draft**` reached the report as "Draft\*\*".** The label pattern
  allowed optional emphasis after the colon, which cannot tell the key's
  closing `**` from the value's opening one. It is now three alternatives - the
  three ways the key is spelled - and emphasis after the colon is consumed only
  when it closes emphasis that opened the key.
- **MADR's own template declared no status.** It writes
  `status: "{proposed | ...}"`; a quote leaves no first word to read, so a
  document written from the template that ADR-0010 names stayed in force. And
  the first repair, a quoted-value pattern anchored at both ends, read
  `status: "proposed" # decided at review` - valid YAML - as nothing, which two
  more surviving anchor mutants reported. Front-matter values are now read the
  way YAML reads one line: quoted up to the closing quote, plain up to a comment.
- **Front-matter with trailing whitespace on a fence was not front-matter**, and
  a file ending at the closing fence was not either. Invisible while the label
  reader picked up the same `status:` line, and decisive the moment front-matter
  and the `## Status` section disagree - which is the case precedence exists for.

Local timeouts moved 24 -> 36 -> 13 across the first three sweeps with no
change to any loop. Nothing on this machine measures anything while something
else is using it, and the number that counts is the hosted one.

A separate finding, from running the new parser over this repository rather
than over fixtures: **ADR-0003 is CRLF on disk**, and the status patterns are
anchored to end-of-line. A trailing carriage return defeated every one of them,
so the feature would have shipped silently inert on a Windows checkout. No
mutant would have found that - the code was correct about the fixtures it was
given. It took pointing the thing at real files.

## Consequences

Whoever bumps vitest to 5 will fail CI on the assertion above, and land on this
document explaining what breaks and how to check whether it is fixed: run
Stryker over a small range of a pure function and confirm the killed/survived
split matches the command runner. When the runner supports vitest 5, delete the
pin and this ADR's assertion.

Mutation testing runs on every push, breaking the build below the gate -
incrementally on a branch, in full on `main`. It was first held back to a weekly schedule on
the assumption that running the suite once per mutant would be too slow for the
critical path. That assumption was wrong by an order of magnitude: the first
hosted run finished in 6m54s, and a mutation score is only worth having if it
describes the code as it stands today. It has since become expensive enough that
the tiering above exists; the schedule and the manual trigger are kept as a
backstop for both.

CI is the measurement, not a convenience. A local run of the same suite takes
over two hours on the Windows machine this was developed on, against 15m51s
hosted - the same 24x gap the ordinary test suite shows (3.2s hosted, 77s
local), and enough that local timings say nothing useful about the budget.
