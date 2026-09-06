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

### `@assert-count` - this symbol occurs exactly / at least / at most N times

```md
<!-- @assert-count target="src/" symbol="UserSessionManager" expected="1" -->
<!-- @assert-count target="src/ui/" symbol="PrimaryButton" min="1" -->
<!-- @assert-count target="src/core/" symbol="DeprecatedHelper" max="3" -->
<!-- @assert-count target="src/" symbol="Repository" min="2" max="10" -->
```

Requires `expected`, or `min` and/or `max`. `expected` cannot be combined with
`min`/`max`.

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
| `glob` | absence, count | Comma-separated file filters, e.g. `*.ts,*.tsx` (ripgrep `-g` semantics) |
| `regex` | absence, count | Treat `symbol` as a regular expression |
| `word` | absence, count | Require word boundaries, so `Primary` does not match `PrimaryButton` |
| `ignore-case` | absence, count | Case-insensitive matching |
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
| `--engine <auto\|rg\|js>` | Search engine (default `auto`: ripgrep when available) |
| `--strict` | Treat a `target` that does not exist as a failure, not a warning |
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
in one pass. Measured on Windows 11 / Node 24 / ripgrep 15 against a synthetic
2,000-file, 5.1 MB tree with 8 assertions:

| | one pass per assertion | batched (current) |
| --- | --- | --- |
| ripgrep engine | ~280 ms | **~72 ms** |
| JavaScript fallback | ~780 ms | **~283 ms** |

Two honest caveats:

- **Process spawning is expensive on Windows** (~27 ms each). On a small tree
  the JavaScript engine can beat ripgrep outright - spec-guard checks its own
  repository in ~15 ms with `--engine js` versus ~170 ms with ripgrep. On Linux
  and macOS, where spawning costs a few milliseconds, ripgrep wins at every
  size. If your repository is small and you care about the last millisecond,
  `--engine js` is a legitimate choice.
- **ripgrep is the reference implementation.** The fallback matches it on
  everything the test suite covers - counts, snippets, word boundaries, globs,
  binary skipping, file-size limits - but ripgrep also honours `.gitignore`,
  while the fallback uses a fixed ignore list (`node_modules`, `dist`, `build`,
  `coverage`, `.git`, dotfiles, and friends).

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
the naive behaviour.

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

## spec-guard checks itself

The invariants in [`docs/adr/0001-invariants.md`](docs/adr/0001-invariants.md)
and [`docs/adr/0002-directive-format.md`](docs/adr/0002-directive-format.md) are
executed against this repository on every CI run. The CLI never calls
`console.log`, nothing outside the engine spawns a process, and the parser and
reporter never touch the filesystem - because those documents say so, and the
build fails if they stop being true.

This README is executable too:

<!-- @assert-present file="src/parser.ts,src/engine.ts,src/reporter.ts,src/runner.ts,src/cli.ts" -->

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run test:coverage
npm run test:mutation  # stryker (~20 minutes)
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
behaved differently. This repository measures the difference: **83.16%** of
2,060 mutants are killed, against 98.98% line coverage.

That gap is the point. The first run scored 77.23%, and the weakest file was
the reporter at 65.48% - not because it lacked tests, but because its tests were
almost all `toContain` against colourless output. A mutant could prepend a junk
line to the output, drop a colour, or turn `remaining > 0` into `remaining >= 0`
and every test still passed. Seventy-five tests later - exact whole-output
comparison instead of substring matching - the reporter is at 87.30%.

`npm run test:mutation` runs it. CI runs it weekly, on demand, and on pull
requests that touch `src/` or `tests/`, with the score gated at 80%. The full
story, including a run whose score turned out to be fiction, is in
[ADR-0003](docs/adr/0003-mutation-testing.md).

## Requirements

- Node.js 22 or newer (native ESM)
- ripgrep optional - used when present, replaced by a built-in scanner when not

## License

MIT
