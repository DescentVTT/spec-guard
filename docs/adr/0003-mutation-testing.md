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

## Consequences

Whoever bumps vitest to 5 will fail CI on the assertion above, and land on this
document explaining what breaks and how to check whether it is fixed: run
Stryker over a small range of a pure function and confirm the killed/survived
split matches the command runner. When the runner supports vitest 5, delete the
pin and this ADR's assertion.

Mutation testing runs on every push, breaking the build below 85. It was first
held back to a weekly schedule on the assumption that running the suite once per
mutant would be too slow for the critical path. That assumption was wrong by an
order of magnitude: the first hosted run finished in 6m54s, and a mutation score
is only worth having if it describes the code as it stands today. The schedule
and the manual trigger are kept as a backstop.

CI is the measurement, not a convenience. A local run of the same suite takes
over two hours on the Windows machine this was developed on, against 15m51s
hosted - the same 24x gap the ordinary test suite shows (3.2s hosted, 77s
local), and enough that local timings say nothing useful about the budget.
