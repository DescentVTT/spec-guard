# spec-guard

**Executable architecture assertions for Markdown specs & ADRs.**

Turn the claims your design documents make about your codebase into assertions
that run in CI, in milliseconds, with no runtime dependencies.

```md
The retired payment gateway is gone from the service layer.

<!-- @assert-absence target="src/services" symbol="LegacyPaymentGateway" -->
```

If someone reintroduces `LegacyPaymentGateway`, CI fails and points at the line
of the ADR that promised it was gone.

---

## Why this exists

Architecture Decision Records, RFCs and technical briefs are full of hard claims
about a repository:

- *"`LegacyPaymentGateway` no longer exists anywhere in the service layer."*
- *"There is exactly one `UserSessionManager`."*
- *"No secret is ever read from `process.env` outside `src/config`."*

Every one of those claims is true on the day it is written and unverified from
the day after. Prose does not fail a build. Six months later the document is
still confidently asserting something the code stopped doing in March.

That has always been an annoyance. It became a defect multiplier the moment
coding agents started reading these documents as ground truth. An agent that
reads *"module X does not exist yet"* will happily build a second X. A reviewer
who trusts *"this symbol occurs zero times"* skips the grep. Stale documentation
is now executable in the worst sense: it executes inside someone's head, or
inside a model's context window, and produces work that has to be thrown away.

spec-guard makes the claims executable in the good sense. It reads directives
written as ordinary HTML comments - invisible in every Markdown renderer - and
checks them against the real tree with ripgrep. A stale claim becomes a failing
build with a line number, not a landmine.

## Quickstart

```bash
npm install --save-dev @descent-vtt/spec-guard
npx spec-guard "docs/**/*.md"
```

**The package is scoped; the command is not.** Once installed, the binary is
plain `spec-guard`, so `npx spec-guard`, `npm scripts` and a global install all
use that name:

```bash
npm install -g @descent-vtt/spec-guard   # then: spec-guard "docs/**/*.md"
```

Without a local install, `npx` needs the full package name - `npx spec-guard`
on its own would resolve to a different package on the registry:

```bash
npx @descent-vtt/spec-guard "docs/**/*.md"
```

Add a directive to any Markdown file, directly under the sentence it makes
executable:

```md
## Decision

Session state has exactly one owner.

<!-- @assert-count target="src/" symbol="UserSessionManager" expected="1" -->
```

Run it:

```bash
npx spec-guard "docs/**/*.md" --verbose
```

```text
spec-guard 1 spec · 1 assertion · ripgrep

✔ docs/adr/0007-sessions.md:5  @assert-count "UserSessionManager" (1 match) in src

1 passed · 7ms
✔ every spec assertion holds
```

And when it drifts:

```text
✖ docs/adr/0007-sessions.md:5  @assert-count
    "UserSessionManager" must appear exactly 1 time in src
    expected exactly 1 match, found 3
      src/auth/UserSessionManager.ts:12:14   export class UserSessionManager {
      src/legacy/sessions.ts:4:22            import { UserSessionManager } from '../auth';
      src/workers/refresh.ts:9:10            const manager = new UserSessionManager();

0 passed · 1 failed · 9ms
```

Exit code 1. The ADR is now a test.

## Directives

Every directive is an HTML comment. It may span multiple lines. Attribute values
may use double or single quotes, and a bare attribute means `="true"`.

### `@assert-absence` - this symbol is gone

```md
<!-- @assert-absence target="src/controllers,src/services" symbol="LegacyPaymentGateway" -->
<!-- @assert-absence target="src/" symbol="STRIPE_SECRET_KEY" expected="0" -->
<!-- @assert-absence target="src/" symbol="TODO" expected="5" reason="burn down the backlog" -->
```

Fails when the symbol occurs more than `expected` times (default `0`).
`max="..."` is accepted as a synonym for `expected`.

### `exclude` - everywhere except

Most real rules are "nowhere except one place", not "not here":

```md
<!-- @assert-absence target="src" symbol="process.env" exclude="src/config/**" -->
```

That is the rule this README opens with - *no secret is ever read from
`process.env` outside `src/config`* - written as one assertion instead of a
hand-maintained list of every directory that is not `src/config`.

`exclude` follows gitignore rules, which are **not** the same as `glob`'s:

| Pattern | Excludes |
| --- | --- |
| `tests` | any directory or file named `tests`, at any depth, and everything under it |
| `src/config` | that directory and everything under it |
| `src/config/**` | the same, written explicitly |
| `*.test.ts` | any file with that name shape, at any depth |

The difference is deliberate. `glob="*.ts"` filters files, so basename matching
is what you want; `exclude="tests"` means the directory, because that is what
people mean when they write it - and it is what `rg -g '!tests'` does. Both
engines implement the same rule, and a parity matrix asserts they agree on it.

List attributes accept commas or whitespace, so both of these work:

```md
<!-- @assert-absence target="src" symbol="TODO" exclude="src/legacy/** tests" -->
<!-- @assert-absence target="src" symbol="TODO" exclude="src/legacy/**,tests" -->
```

(A path containing a space therefore cannot be written; there is no quoting
inside an attribute value.)

### `comments` - the note about a deletion is not the deletion

You delete a symbol and leave the explanation where the next person will look:

```ts
// LegacyThing was removed in ADR-398; do not reintroduce it.
```

A plain text search reads that comment as an occurrence, so the assertion that
keeps the symbol deleted fails on the sentence proving it was deleted. Both
fixes are bad: delete the note and lose the reason, or delete the rule.

So matches inside comments do not count:

```md
<!-- comments are ignored by default -->
<!-- @assert-absence target="src" symbol="LegacyThing" -->

<!-- ...unless you ask for them -->
<!-- @assert-absence target="src" symbol="Copyright" comments="include" -->
```

`comments="include"` is right for assertions that really are about text — a
licence header, or a name that must appear nowhere in the repository at all.

Because this is the one thing that can turn a failing run green without anyone
touching code, a run that passed this way says so:

```
⚠ 1 match inside comments was not counted; add comments="include" to count it

1 passed · 7ms
✔ every spec assertion holds
```

Comment syntax is known for around 59 extensions across 9 families (JS/TS, C,
C#, Rust, Go, Python-style `#`, SQL-style `--`, markup, and formats with no
comments at all). Strings are tracked too, because `//` inside a URL is not a
comment and reading it as one would hide real code. Where spec-guard is unsure —
an unknown extension, an unterminated literal — the text counts as code, and the
report says which files it could not classify. A match wrongly kept is a visible
failure you can argue with; a match wrongly dropped is a lie.

## What gets searched

An assertion is worth exactly as much as the set of files behind it, so
spec-guard is explicit about that set and never quietly narrows it.

**Four directory names are skipped**, and nothing else:

| Skipped | Why |
| --- | --- |
| `.git`, `.hg`, `.svn` | version-control stores hold compressed copies of code you deleted on purpose |
| `node_modules` | code you did not write, which your architecture rules are not about |

Everything else is searched. That includes **hidden directories** - `.github`,
`.husky`, `.claude-rules`, `.agents` - because that is where CI, hooks and agent
rules live, and a rule that cannot see your workflow files is not enforcing much.
It also includes `dist`, `build`, `out` and `coverage`, because spec-guard
cannot tell build output from a directory of build scripts, and guessing wrong
means a rule silently stops covering anything.

`.gitignore` is not consulted. It describes what git should carry, not what a
rule covers - and ripgrep applies it only inside a git repository, so honouring
it made the same tree answer differently depending on whether a `.git` directory
happened to exist above it.

To narrow scope, say so in the assertion:

```md
<!-- @assert-absence target="src" symbol="TODO" exclude="dist coverage" -->
```

`--no-default-skips` removes even those four, for a run that has to be certain.

### Nothing is skipped quietly

A file spec-guard could not read, or one whose bytes are not text but which
contained the symbol anyway, is a gap in the answer rather than a detail of it.
Those are reported, and `--strict` fails on them:

```text
✖ docs/adr.md:3  @assert-absence
    "ApiKey" must not appear in .
    expected no matches, found 0, and 1 file could not be inspected
    ⚠ 1 match in 1 binary file not counted: build/app.bin
```

The counts are in `--json` too, as `skipped` on each result.

### `@assert-count` - this symbol occurs exactly / at least / at most N times

```md
<!-- @assert-count target="src/" symbol="UserSessionManager" expected="1" -->
<!-- @assert-count target="src/ui/" symbol="PrimaryButton" min="1" -->
<!-- @assert-count target="src/core/" symbol="DeprecatedHelper" max="3" -->
<!-- @assert-count target="src/" symbol="Repository" min="2" max="10" -->
```

Requires `expected`, or `min` and/or `max`. `expected` cannot be combined with
`min`/`max`.

An exact count is the most brittle assertion in the set: a test that merely
mentions the symbol will break it. spec-guard does not silently skip test files
for you - an assertion that quietly ignores part of the tree is the failure mode
this tool exists to prevent - so say what you mean:

```md
<!-- @assert-count target="src" symbol="UserSessionManager" expected="1" exclude="*.test.ts *.spec.ts" -->
```

`min="1"` is often the better rule anyway: it says "this exists" without
breaking every time someone writes a second test.

### `@assert-import-absence` / `@assert-import-count` - dependencies, not text

The rules architecture documents actually contain are usually about
dependencies, and a text search answers those badly in both directions - it
matches a mention in a comment, and it misses `export * from '../db'`.

```md
<!-- @assert-import-absence target="src/ui" module="src/db" reason="the UI talks to services, not storage" -->
<!-- @assert-import-count target="src" module="axios" max="1" -->
```

These read the dependency rather than the text. A JavaScript/TypeScript
tokenizer - comments, strings, template substitutions and regular expressions,
no parser and no new dependency - extracts module references and counts the
**files** that depend on the module. It understands:

| Form | Counted |
| --- | --- |
| `import { A } from 'x'`, `import 'x'`, `import * as ns from 'x'` | yes |
| `import type { A } from 'x'` | yes, unless `types="ignore"` |
| `export * from 'x'`, `export { A } from 'x'` | yes - a re-export is a dependency, and a barrel file is how layering rules usually get broken |
| `require('x')` | yes, with a literal argument |
| `import('x')` | yes, with a literal argument |
| `import(name)`, `require(expr)` | **no - reported, see below** |

Relative specifiers are resolved by path arithmetic, so `module="src/db"`
matches `../db/client.js` seen from `src/ui/`. There is deliberately no
filesystem resolution: tsconfig `paths` aliases and package `exports` maps are
not followed, so an alias is written out as itself (`module="@app/db"`).

**It tells you what it could not see.** Roughly 1% of module references in real
code are dynamic, and about 0.09% of files defeat the tokenizer outright. Both
are reported rather than counted as clean:

```text
✔ docs/adr.md:1  @assert-import-absence "src/db" (0 matches) in src/core
⚠ 1 module reference could not be resolved statically
⚠   src/core/plugin.ts:1 import(name)
```

The count is still true of everything that could be seen; the warning is what
stops it being mistaken for a complete answer. `--strict` turns those warnings
into failures. Files in scope that are not JavaScript or TypeScript are counted
and reported too, so a rule pointed at the wrong tree says "analysed 1 of 3
files" rather than quietly passing.

[ADR-0005](docs/adr/0005-import-assertions.md) has the measurements and the
reasoning behind each boundary.

### `@assert-present` - this file exists

```md
<!-- @assert-present file="SECURITY.md" -->
<!-- @assert-present file="config/production.json,config/staging.json" -->
```

Passes when every listed path exists relative to `--root`. Directories count.

### Attributes

| Attribute | Applies to | Meaning |
| --- | --- | --- |
| `target` | absence, count | Comma-separated paths to search, relative to `--root`. Default `.` |
| `symbol` | absence, count | The literal string to search for (or a regex with `regex="true"`) |
| `file` | present | Comma-separated paths that must exist |
| `expected` | absence, count | Upper bound for absence; exact count for count |
| `min` / `max` | count (`max` also on absence) | Inclusive bounds |
| `glob` | absence, count | Include-only file filters, e.g. `*.ts,*.tsx` (ripgrep `-g` semantics) |
| `exclude` | absence, count | Paths to leave out, gitignore-style: `src/config/**`, `tests`, `*.test.ts` |
| `regex` | absence, count | Treat `symbol` as a regular expression |
| `word` | absence, count | Require word boundaries, so `Primary` does not match `PrimaryButton` |
| `ignore-case` | absence, count | Case-insensitive matching |
| `comments` | absence, count | `ignore` (default) or `include` for matches inside comments |
| `module` | import assertions | Which dependency, matched like `exclude` |
| `types` | import assertions | `include` (default) or `ignore` for `import type` |
| `reason` | all | Human-readable justification, printed on failure |

Unknown attributes are an error, not a shrug: `expct="1"` fails the run instead
of silently asserting nothing.

## CLI

```bash
spec-guard [patterns...] [options]
```

| Option | Description |
| --- | --- |
| `-r, --root <path>` | Codebase root that assertions resolve against (default: cwd) |
| `-v, --verbose` | Print passing assertions too |
| `--fail-fast` | Stop at the first failing assertion |
| `--json` | Machine-readable report on stdout |
| `--engine <auto\|rg\|js>` | Search engine (default `auto`: scanner for small trees, ripgrep for big ones) |
| `--strict` | Treat analysis that could not be completed as a failure |
| `--allow-missing-targets` | Warn instead of failing when a `target` path does not exist |
| `--no-default-skips` | Search `.git`, `.hg`, `.svn` and `node_modules` too |
| `--include-specs` | Also count matches inside the spec files themselves |
| `--max-snippets <n>` | Failure snippets per assertion (default 5) |
| `--concurrency <n>` | Search passes in flight at once (default 8) |
| `--allow-empty` | Exit 0 when no spec file matched the patterns |
| `--color` / `--no-color` | Force colour on or off (`NO_COLOR` honoured) |

Patterns are expanded by spec-guard itself, so quoted globs behave identically
on Windows, macOS and Linux. A directory expands to the Markdown files in it.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every assertion held |
| `1` | An assertion failed, or a directive was malformed |
| `2` | spec-guard could not run: bad usage, no spec files matched, `--engine rg` with no ripgrep |

## CI integration

```yaml
# .github/workflows/specs.yml
name: Specs
on: [push, pull_request]

jobs:
  spec-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
      - run: npx @descent-vtt/spec-guard "docs/**/*.md" "README.md" --verbose
```

That job needs nothing else installed. GitHub-hosted runners do **not** ship
ripgrep on `PATH` - spec-guard's own CI reports `engine: javascript` there - so
the fallback is what actually runs, and it produces identical results. If your
repository is large enough that you want ripgrep's speed, install it first:

```yaml
      - run: sudo apt-get update && sudo apt-get install -y ripgrep
```

Or point spec-guard at a binary you already have with `SPEC_GUARD_RG=/path/to/rg`.

As a pre-commit hook (assuming a local install, so the bare command resolves):

```bash
npx spec-guard "docs/**/*.md" --fail-fast
```

## How it works

```text
parser  ──▶ Directive[] ──▶ runner ──▶ Assertion[] ──▶ engine ──▶ AssertionResult[] ──▶ reporter
(pure)                      (I/O)                     (rg | js)                        (pure)
```

1. **Parse.** Markdown is scanned for `<!-- @assert-* -->` comments. Fenced code
   blocks and inline code spans are masked first, so documentation that shows
   the syntax (like this README) never executes it.
2. **Resolve.** Each directive becomes a typed assertion. Bad numbers, unknown
   booleans, unknown attributes and paths escaping `--root` are rejected here,
   before any I/O.
3. **Search.** Assertions that share a target list and flags are answered by a
   *single* pass over the tree.
4. **Report.** ANSI output with the spec location, the expectation, the observed
   count, and up to five real snippets; or JSON for tooling.

### Performance

Scanning a tree costs about the same whether you look for one symbol or twenty,
so spec-guard groups assertions by target set and flags and answers each group
in one pass.

`auto` then picks between the two engines **per search group**, because they
have different shapes of cost: ripgrep is dominated by process startup and
barely notices tree size, while the built-in scanner has no startup cost and
grows linearly. Starting a process to search a handful of files is a bad trade.
Re-measured for 0.4.0 on Windows 11 / Node 24, median of three, one symbol over
a synthetic tree:

| files | scanner | ripgrep | |
| --- | --- | --- | --- |
| 100 | **17 ms** | 214 ms | scanner, 12.9x |
| 500 | **70 ms** | 263 ms | scanner, 3.8x |
| 1,000 | 216 ms | **181 ms** | ripgrep, 1.2x |
| 3,000 | 735 ms | **222 ms** | ripgrep, 3.3x |
| 5,000 | 1,046 ms | **241 ms** | ripgrep, 4.3x |

The decision uses a bounded enumeration as its probe: spec-guard walks the
target set until it either finishes - in which case the file list is already in
hand and the scanner runs against it, with no process and no second walk - or
exceeds a budget, in which case ripgrep takes over. The crossover above sits
between 500 and 1,000 files, which is what the Windows budget of 512 encodes;
on Linux it is far lower, because what is really being measured is process
spawn cost. `scripts/bench-engines.mjs` reproduces this, and
[ADR-0004](docs/adr/0004-adaptive-engine.md) has the full tables.

Treat single measurements from one machine with suspicion. On the development
machine used here, an absence assertion over 2,000 files measures 303 ms with
the scanner and 399 ms with ripgrep, but ripgrep's own spread across five runs
was 379-1039 ms - wide enough that the two are not really distinguishable at
that size. The order-of-magnitude differences at the ends of the table are the
part worth trusting.

Two honest caveats:

- **The reported engine is the one that ran, not the one available.** On a small
  repository `--json` reports `"engine": "javascript"` even with ripgrep
  installed. That is the optimisation working, not a failure to find `rg`.
- **The engines are one implementation, not two that agree.** This used to say
  that ripgrep was the reference and the scanner merely matched it "on
  everything the test suite covers", with a note that the two treated
  `.gitignore` and ignored directories differently and that you should pin an
  engine if it mattered. It did matter: on a tree with eight copies of a symbol
  the scanner found two and ripgrep found four. Since 0.4.0 ripgrep answers only
  *which files contain this text*, and the scanner does all the counting,
  classification and reporting for both. `--engine` now changes how long a run
  takes and nothing about its verdict, and the suite asserts that on trees built
  from every case that used to split them.

## Programmatic API

```ts
import { runSpecGuard, formatReport } from '@descent-vtt/spec-guard';

const report = await runSpecGuard({
  patterns: ['docs/**/*.md'],
  root: process.cwd(),
});

if (!report.ok) {
  console.error(formatReport(report, { color: true, verbose: false }));
  process.exitCode = 1;
}
```

`runSpecGuard` returns the full report: every assertion, its bounds, the
observed count, match locations, warnings and timings. The parser
(`parseDirectives`) and reporter (`formatReport`, `formatJson`) are pure
functions you can use on their own.

## Design decisions

This tool was specified loosely and built opinionatedly. Where the
implementation departs from the obvious reading of the brief, here is why.

**Spec files are excluded from their own searches.** An ADR that says
"`LegacyGateway` must not appear" contains the string `LegacyGateway`. Without
this rule, absence assertions would fail on the document asserting them - the
single most confusing possible first-run experience. `--include-specs` restores
the naive behaviour, and counts the prose of your specs; the directives
themselves stay uncounted, because a directive is an HTML comment and a rule
whose own text trips it can never be satisfied. `comments="include"` counts even
those.

**Fenced code and inline code are masked before parsing.** A README documenting
the syntax must not execute it. Masking preserves byte offsets, so reported line
numbers stay exact. (This is subtle: pairing backtick runs the naive way
desynchronises after a stray unmatched run and un-masks real prose. spec-guard
uses CommonMark's equal-length pairing rule, and there is a regression test.)

**Malformed directives fail the run.** A typo like `expct="1"` could be ignored
as "not a directive". It is instead an error, because a spec tool whose typos
silently assert nothing is worse than no spec tool.

**Four attributes were added beyond the original brief** - `word`, `regex`,
`glob` and `ignore-case` - because `symbol="Primary"` matching `PrimaryButton`
is the first thing every user hits, and `reason` because a failure message
should say *why* the rule exists.

**`min`/`max` are accepted on `@assert-absence` too.** "At most 5 TODOs" is an
absence claim with a budget, and burning a budget down is a real workflow.

**The engine is detected lazily.** Probing with `rg --version` up front costs a
process spawn (~27 ms on Windows) on the critical path of every run, including
runs where ripgrep is missing. Discovering its absence from the first real
search is free.

**Assertions are batched, but only when provably safe.** Merging literals into
one ripgrep alternation can lose matches two ways: containment (`Primary` /
`PrimaryButton`) and dovetailing (`abc` / `cd` in `abcd`). spec-guard checks for
both and falls back to separate passes when either is possible, and never
batches regexes or case-insensitive searches. Speed is never traded for a wrong
count.

**Exit code 2 exists.** "Your specs failed" and "spec-guard could not run" are
different facts, and CI should be able to tell them apart.

**A missing `target` fails the run.** It used to warn and search what was left,
which meant an assertion pointed at a renamed directory searched nothing, found
nothing, and reported success — the exact shape of a green check that verified
nothing. `--allow-missing-targets` restores the old behaviour for repositories
where a path is legitimately optional.

**Hidden directories are searched, and `.gitignore` is not consulted.** An
audit of 0.3.0 found the tool reporting a clean pass on a repository whose
forbidden symbol sat in `.github/workflows/ci.yml`; the scanner and ripgrep also
disagreed with each other, finding two matches and four on the same tree. Scope
is now one policy that both engines are driven by, the skip list is four names
long, and anything spec-guard could not inspect is reported rather than assumed
clean ([ADR-0007](docs/adr/0007-search-scope.md)).

**Comments are excluded by default, and the exclusion is reported.** Counting
the note that records a deletion as an occurrence of the thing deleted punishes
the documentation this tool exists to keep honest ([ADR-0006](docs/adr/0006-comment-classification.md)).
The reverse risk — a rule that quietly stops checking anything because every
match now sits in a comment — is why every run says how many matches it dropped.

## spec-guard checks itself

The invariants in [`docs/adr/0001-invariants.md`](docs/adr/0001-invariants.md)
and [`docs/adr/0002-directive-format.md`](docs/adr/0002-directive-format.md) are
executed against this repository on every CI run. The CLI never calls
`console.log`, nothing outside the engine spawns a process, and the parser and
reporter never touch the filesystem - because those documents say so, and the
build fails if they stop being true.

This README is executable too:

<!-- @assert-present file="src/parser.ts,src/engine.ts,src/reporter.ts,src/runner.ts,src/cli.ts,src/comments.ts" -->

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run test:coverage
npm run test:mutation  # stryker (~16 min in CI; much slower locally)
npm run lint       # tsc --noEmit
npm run selfcheck  # run spec-guard on its own docs
```

The test suite runs every assertion case against **both** engines and asserts
they agree, so the fallback cannot quietly drift from ripgrep. `@vscode/ripgrep`
is a devDependency purely so that the ripgrep path is exercised on every
platform in CI, including machines that have no `rg` on PATH; it ships a
prebuilt binary and is never a runtime dependency.

### Mutation testing

Coverage says a line ran. It does not say an assertion would notice if the line
behaved differently. This repository measures the difference: **84.63%** of
2,949 mutants are killed in CI, against high line coverage.

That gap is the point. The first run scored 77.23%, and the weakest file was the
reporter at 65.48% - not because it lacked tests, but because its tests were
almost all `toContain` against colourless output. A mutant could prepend a junk
line, drop a colour, or turn `remaining > 0` into `remaining >= 0` and every
test still passed. Exact whole-output comparison took it to 87.30%. The engine
and the walker were then rewritten for testability rather than papered over with
more tests, which is what moved them from 75%/78% to 83%/93%.

CI runs it on **every push**, gated at 85%, and the CI figure is the one quoted
above. Run it locally with `npm run test:mutation` if you like, but do not
calibrate anything on the result: on the Windows machine this was developed on
the same suite takes over two hours against 13 minutes hosted, and it scores
*higher*, because far more mutants hang there and Stryker counts a hang as a
kill. Linux CI is the measurement.

Four cautionary tales are in [ADR-0003](docs/adr/0003-mutation-testing.md): a
run whose score was pure fiction because the mutants were never activated, a
tuning knob that lifted the score six points without adding a test, the platform
gap above, and the baseline being re-anchored when a tokenizer arrived - along
with the real bug that chasing the gate uncovered.

## Requirements

- Node.js 22 or newer (native ESM)
- ripgrep optional - used when present, replaced by a built-in scanner when not

## License

MIT
