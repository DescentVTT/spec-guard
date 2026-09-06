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

The `break` threshold is set at 80: below the measured score, so a regression
fails the build, but not so tight that ordinary refactoring trips it.

## Consequences

Whoever bumps vitest to 5 will fail CI on the assertion above, and land on this
document explaining what breaks and how to check whether it is fixed: run
Stryker over a small range of a pure function and confirm the killed/survived
split matches the command runner. When the runner supports vitest 5, delete the
pin and this ADR's assertion.

Mutation testing does not run on every push - it runs the whole suite per
mutant group and is far slower than the tests themselves. It runs weekly, on
demand, and on pull requests that touch `src/` or `tests/`.
