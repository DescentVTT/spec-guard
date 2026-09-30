# Contributing

What spec-guard does is in the [README](README.md), and why in the ADRs in
[`docs/adr`](docs/adr). This file is what a contributor needs besides: how to
build and test it, how its tests are measured, and how a release is made.
[CLAUDE.md](CLAUDE.md) holds the same working agreements, written for a coding
agent.

## Development setup

Node 22 or newer. There are no runtime dependencies.

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run test:coverage
npm run test:mutation  # stryker (eight parallel jobs in CI; hours locally)
npm run lint       # tsc --noEmit
npm run selfcheck  # run spec-guard on its own docs
```

CI also runs two commands against the build:

```bash
node ./bin/spec-guard.js prove  # every rule in this repository's specs is shown a violation of itself
node ./bin/spec-guard.js cites  # every ADR a comment in the code cites exists and is in force
```

The test suite runs every assertion case against **both** engines and asserts
they agree, so the fallback cannot quietly drift from ripgrep. `@vscode/ripgrep`
is a devDependency purely so that the ripgrep path is exercised on every
platform in CI, including machines that have no `rg` on PATH; it ships a
prebuilt binary and is never a runtime dependency.

`src/vendor/spec-core/` is spec-core's Markdown scanner, glob engine and the
rest of what the spec-* tools share, copied byte for byte and held to the
SHA-256 of every file by `tests/vendor.test.ts`. It is never edited here: change
spec-core, then copy it again with spec-core's `scripts/vendor.mjs --into`
([ADR-0015](docs/adr/0015-globs-from-spec-core.md)).

## Tests

- **New behaviour needs a test that fails without it**, and a new heuristic a
  test for the case that must *not* match.
- **Assert decisions, not shapes.** A test states behaviour a caller can
  observe - from the README, an ADR or a documented message - rather than
  restating the implementation.
- **A genuinely equivalent mutant gets no test**, and a comment beside the code
  saying why.
- **A test that writes to disk makes its tree with `makeTempRepo`** in
  `tests/helpers.ts`, under `tests/fixtures/.tmp` in a directory named for its
  process, and never changes a shared fixture: Stryker runs one test file in
  several workers at once.

## Mutation testing

Coverage says a line ran. It does not say an assertion would notice if the line
behaved differently. This repository measures the difference: line coverage is
**100%**, and CI's full sweep for 0.18.0 killed **99.15%** of 12,228 mutants,
with 101 survivors and 3 without coverage. Each release brings that figure up
to date in the README and in a section of its own in
[ADR-0003](docs/adr/0003-mutation-testing.md). The second number is the one
worth reading, and what was done about the survivors matters more than the
score. At 0.5.1 every surviving mutant was checked individually, every file
was above 95%, and the 101 left then produced byte-identical output. **Each
release since has replayed the survivors its own code added before it
shipped**: they were killed, deleted as dead code, or shown equivalent and
recorded in ADR-0003 with the evidence.

That gap is the point. The first run scored 77.23%, and the weakest file was the
reporter at 65.48% - not because it lacked tests, but because its tests were
almost all `toContain` against colourless output. A mutant could prepend a junk
line, drop a colour, or turn `remaining > 0` into `remaining >= 0` and every
test still passed. Exact whole-output comparison took it to 87.30%. The engine
and the walker were then rewritten for testability rather than papered over with
more tests, which is what moved them from 75%/78% to 83%/93%.

The 0.5.1 pass took every module to its ceiling, and its value was not the
number. Writing down four contracts that had only ever been checked through
their effect on a match count turned up four wrong answers: two assertions on
one symbol answered each other's comment handling, an unreadable directory went
unreported on any repository small enough to scan in process, snippets from CRLF
files carried a carriage return into the terminal, and an invalid pattern was
reported with its error message twice. Seventeen branches turned out to be
unable to decide anything and were deleted rather than pinned; thirty-five
negative controls - each defect reintroduced one at a time - confirm the suite
goes red for every one, and the changes meant to be invisible were checked
against 6,976 files of real code, reference for reference, against the published
0.5.0 build.

Then the survivors themselves were checked rather than excused. All 130 were
applied one at a time and run through a fingerprint of 4,176 observations, and
**29 of them turned out not to be equivalent at all** - a Rust brace counter
that only matters when a second statement follows, a type-only test that marks
`import A, { B } from 'x'` type-only when loosened, a comment check that opens a
block comment on `2*3`. All 29 are now tested and all 29 die. All of it is in
ADR-0003, including a Stryker limitation found on the way: a mutant that stops a
test file *loading* is reported as survived even though the suite is in fact
killing it.

### How CI runs it

CI runs it in **two tiers**, both gated at 97%:

- **Branches and pull requests** run Stryker incrementally, reusing the verdict
  for any mutant whose source and covering tests are both unchanged.
- **Pushes to `main`, the weekly schedule and manual runs** do the full sweep,
  which is the authoritative number and the one quoted above. A full sweep is
  also what publishes the cache the branches start from, so an incremental
  verdict can never be built on another incremental verdict.

The full sweep was 6m54s at 2,118 mutants, 15m51s at 3,493, and 42m39s at 7,763.
That growth is why the tiers exist: a check that gets quietly more expensive
every release is a check somebody eventually proposes lowering. It is also why
both tiers run in parallel shards: four from 0.9.0, when one runner could no
longer finish the full sweep reliably inside the job's limit, and eight from
0.12.0, when the sweep doubled. The answer each time was to split the sweep
rather than raise the limit or drop mutants. Each shard mutates its own files
(`scripts/mutation-shards.mjs`) against every test, and a final job merges the
reports. The merge refuses anything that is not exactly one sweep, and applies
the 97% gate to the merged score with the same library Stryker's gate uses.

### Locally, and for one change

Run it locally with `npm run test:mutation` if you like, but do not calibrate
anything on the result: on the Windows machine this was developed on the same
suite takes hours against 43 minutes of hosted time, and it scores *higher*,
because far more mutants hang there and Stryker counts a hang as a kill. Linux
CI is the measurement.

A change's own mutants are checked by hand before its pull request: write each
likely mutation into the source, run the test files that cover it, watch one
fail, and restore the source (`git diff` shows only the intended change
afterwards). A test file that fails to load counts as a survivor. The pull
request's incremental sweep then confirms it, and main's full sweep is what the
release reads.

Eight cautionary tales are in ADR-0003: a
run whose score was pure fiction because the mutants were never activated, a
tuning knob that lifted the score six points without adding a test, the platform
gap above, the baseline being re-anchored when a tokenizer arrived, and a score
that rose partly because code carrying hard-to-kill mutants was deleted rather
than because tests improved, and the 0.5.0 sweep that failed the build at 83.77%
because a suite can be thorough about the thing it was written to test and
silent about the machinery underneath it, and the excuse that let the tokenizer
sit at 73% for three releases because "that kind of code carries more equivalent
mutants" sounded like judgement rather than an unchecked assumption - along with
the real bugs that chasing the gate uncovered, and a class of mutant the runner
reports as survived while the suite is in fact killing it.

## Releasing

A release is a tag push. Nothing is published from a laptop, and there is no
npm token in this repository or in its secrets
([ADR-0019](docs/adr/0019-releases-are-staged-by-ci.md)). Releases are
batched, one per round of work, and the version says what an upgrade can do to
a run: a minor for anything that can turn a passing run red or change what a
script reads, a patch for what reports less, crashes, performance and
documentation (spec-core's
[ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md)).

1. **Merge the pull requests** the release carries, each with its `CHANGELOG.md`
   entries under `## Unreleased`.
2. **Wait for main's full mutation sweep** on the last of them. Compare its
   survivors with the last release's, in ADR-0003's newest release section.
   Each new one is killed by a test, deleted with the code that decides nothing,
   or shown equivalent: a comment beside the code says why, and ADR-0003 records
   it. A change to `src/` other than such a comment goes through a pull request,
   and back to the start of this step.
3. **Commit `release: <x.y.z>` on main**:
   `npm version <x.y.z> --no-git-tag-version` for `package.json` and
   `package-lock.json`; `## Unreleased` renamed `## <x.y.z>`; the sweep's
   figures in the README's line under "spec-guard checks itself" and in a new
   `### <x.y.z>: ...` section of ADR-0003, above the last release's. The commit
   message gives the sweep - its commit, score, mutants and survivors - and
   what was done about each new survivor.
4. **Tag it and push both**:

   ```bash
   git tag -a v<x.y.z> -m v<x.y.z>
   git push origin main v<x.y.z>
   ```

5. **CI stages it**, as below.
6. **The maintainer approves it** with a second factor.

[`release.yml`](.github/workflows/release.yml) then:

1. refuses the release unless the tag, `package.json` and a `## <version>`
   heading in `CHANGELOG.md` all agree;
2. type checks, builds, runs the suite and executes this repository's own ADRs.
   A tag push does not run CI, so the release job runs those steps itself;
3. `npm pack`s the tarball, prints its file list and its SHA-256, and hands that
   exact file to the publishing job. Nothing is rebuilt in between, so what
   reaches the registry is the artifact the tests ran against;
4. stages it with `npm stage publish --provenance`. The job authenticates with a
   short-lived OIDC token that GitHub mints for `release.yml` running in the
   `npm` environment, and npmjs.com accepts it only for that combination - npm's
   trusted publishing, so there is no credential to leak or to rotate.

The publishing job installs no dependencies and checks nothing out. Everything
that runs third-party code - `npm ci`, a postinstall that downloads a ripgrep
binary, the test suite - happens in the earlier job, which has no token.

Staging is not publishing. The version sits on npmjs.com visible to maintainers
and installable by nobody until:

```bash
npm stage list @descent-vtt/spec-guard
npm stage view <stage-id>
npm stage approve <stage-id>   # asks for a second factor
```

`npm stage reject <stage-id>` discards it instead, and the tag can be deleted
and remade. Approving needs 2FA and therefore a person: CI can build a release,
but it cannot decide to publish one.

Two repository settings hold the other end of this. The `npm` environment
accepts deployments only from `main` and from `v*` tags, so no branch can reach
the publishing job. A `Release tags` ruleset lets only repository admins create,
move or delete a `v*` tag - under this workflow, pushing one is the release, and
an accidental push should not be able to start it.

`Actions -> Release -> Run workflow` with `dry_run` left on verifies, packs and
hands the tarball to npm without spending a version number. It stops at the
registry's version check - a dispatch runs from `main`, whose version is already
published - and it does not exercise authentication, because the OIDC exchange
happens only on a publish that intends to write. The first real tag is what
proves that end.

## Reporting a vulnerability

Privately, never in a public issue: [SECURITY.md](SECURITY.md) says how.

## Style

Match the surrounding code. Comments explain *why*, never *what*: if a comment
restates the line below it, delete one of them. Prose in comments, messages and
commit bodies is plain: no exclamation marks, no hedging, no apologising for the
code.

## Licence

By contributing you agree that your contributions are licensed under the MIT
licence that covers the project.
