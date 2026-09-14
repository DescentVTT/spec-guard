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

These read the dependency rather than the text, in **five languages**:

| Language | Extensions | Reads |
| --- | --- | --- |
| JavaScript / TypeScript | `.js .mjs .cjs .jsx .ts .mts .cts .tsx` | `import`, `export ... from`, `require()`, `import()` |
| Python | `.py .pyi` | `import a.b`, `from .rel import x`, `importlib.import_module("x")` |
| Go | `.go` | `import "x"` and grouped `import ( ... )`, including aliases and `_` |
| Rust | `.rs` | `use a::{b, c}` with nested groups, `pub use`, `extern crate` |
| C# | `.cs .csx` | `using`, `using static`, `global using`, `using X = A.B` |

No parser and no new dependency. JavaScript gets a full tokenizer because a
module reference can appear anywhere in an expression; the other four are read
by masking comments and string literals with the classifier from
[ADR-0006](docs/adr/0006-comment-classification.md) and then reading statements
off what is left. Tree-sitter would have cost 94 MB unpacked against this
package's 0.33 MB - [ADR-0008](docs/adr/0008-polyglot-imports.md) has the
measurements, and the list of things a real parser would genuinely see that
this does not.

Module patterns are matched against the resolved `/`-separated path *and*
against the specifier as written, so `module="System.Text.Json"` and
`module="System/Text/Json"` both work. Matching is case-sensitive, so a rule
spanning C# and Go needs both conventions:
`module="app/db/** App/Db/**"`.

The unit counted is **files** that depend on the module. For JavaScript and
TypeScript it understands:

| Form | Counted |
| --- | --- |
| `import { A } from 'x'`, `import 'x'`, `import * as ns from 'x'` | yes |
| `import type { A } from 'x'` | yes, unless `types="ignore"` |
| `export * from 'x'`, `export { A } from 'x'` | yes - a re-export is a dependency, and a barrel file is how layering rules usually get broken |
| `require('x')` | yes, with a literal argument |
| `import('x')` | yes, with a literal argument |
| `import(name)`, `require(expr)` | **no - reported, see below** |

Relative specifiers are resolved by path arithmetic, so `module="src/db"`
matches `../db/client.js` seen from `src/ui/`, and Python's `from ..core import
x` resolves against the importing file the same way. There is deliberately no
filesystem resolution: tsconfig `paths` aliases and package `exports` maps are
not followed, so an alias is written out as itself (`module="@app/db"`).

**It tells you what it could not see.** Roughly 1% of module references in real
code are dynamic, and about 0.09% of files defeat the tokenizer outright. Both
are reported rather than counted as clean:

```text
⚠ docs/adr.md:1  1 module reference could not be resolved statically
⚠ docs/adr.md:1    src/core/plugin.ts:1 import(name)

1 passed · 9ms
✔ every spec assertion holds
```

The count is still true of everything that could be seen; the warning is what
stops it being mistaken for a complete answer. A passing rule prints it without
`--verbose` too, since a green run is when it would otherwise go unread.
`--strict` turns those warnings into failures. Files in scope that are not JavaScript or TypeScript are counted
and reported too, so a rule pointed at the wrong tree says "analysed 2 of 3
files" rather than quietly passing - and if *none* of them can be read, the
assertion fails rather than passing on an empty analysis.

[ADR-0005](docs/adr/0005-import-assertions.md) has the measurements and the
reasoning behind each boundary.

### `@assert-layers` - dependencies point one way

"Domain must not depend on infrastructure" across three layers is three
import rules, and across five it is ten - a triangle nobody writes down, and
the row somebody forgets when a layer is added. One directive states the order:

```md
<!-- @assert-layers target="src" order="src/domain, src/application, src/infrastructure" -->
```

**Order runs from the layer everything may depend on to the layer that may
depend on everything.** A file may import from its own layer and from any layer
listed before it; importing from a layer listed after it is a violation, and
the report says which way it went:

```text
✖ docs/architecture.md:12  @assert-layers
    src must keep its layers in order, src/domain < src/application < src/infrastructure
    expected no violating files, found 1
      src/domain/user.ts:3:1  src/domain -> src/infrastructure: import ../infrastructure/db.js
```

A layer is a pattern in the same language as `module=` and `exclude`, which is
why this works in all five languages above: `src/domain` is anchored at the
root, and a bare `domain` matches that segment anywhere - in `src/domain/user.ts`,
in Python's `app.domain.user`, in Rust's `crate::domain::user`. A layer may also
be a single file; `order="src/parser.ts, src/cli.ts"` understands that
`./parser.js` is `src/parser.ts`.

The unit is files, and `max`, `types`, `exclude` and `baseline` mean what they
mean on `@assert-import-absence`. Three things fail rather than pass, because
each is a rule that would otherwise check less than it says: a layer that
matches no file (`order="domain, aplication"`), a file two layers both claim,
and a target that does not exist. Files that no layer claims are left alone and
counted, so a directory nobody assigned shows up as a number rather than as
silence.

### `@assert-import-cycle` - no file depends on itself

```md
<!-- @assert-import-cycle target="src" types="ignore" -->
```

A cycle is reported as one concrete loop, with the line of every import on it:

```text
✖ docs/architecture.md:20  @assert-import-cycle
    src must have no import cycles (type-only imports ignored)
    expected no import cycles, found 1
      src/orders/cart.ts:4:1  src/orders/cart.ts:4 -> src/billing/invoice.ts:2 -> src/orders/cart.ts
```

The count is **knots, not loops**: a set of files each reachable from the others
counts once however many routes run around it, so adding an import inside a
tangle that already exists does not move the number. `max="2"` adopts the rule
on a codebase that already has two, and fails on the third.

`types="ignore"` asks the runtime question - erased imports create no load-order
cycle - and the default asks the coupling one. This repository needs both: its
`src/` has exactly one cycle, and it is type-only.

**Cycles are JavaScript and TypeScript only**, because a cycle needs to know that
`./b.js` *is* `src/b.ts`, and in the other four languages an import names a
module, package or namespace rather than a file. A scope with no JavaScript or
TypeScript in it fails instead of reporting no cycles. The resolver is a short,
fixed table - the TypeScript source of an emitted `.js`, the path as written,
the path with each extension, the directory's `index` - checked against files
the walk already found, never against the disk.

It says what it could not follow. An import that should have become an edge and
did not - a relative path matching no file, or an alias like `@/db` or
`#internal/db` that cannot be a package - is reported, and fails the run under
`--strict`. An alias spelled like a real package, `@app/db` through `tsconfig`
paths, is the one thing it cannot see and cannot report: that would mean
reading `tsconfig.json`, which is the resolver
[ADR-0011](docs/adr/0011-layers-and-cycles.md) declines to become, for the
reasons it gives.

### `@assert-structure` - what files are called, and what comes with them

Architecture documents state conventions over sets of files rather than naming
files one by one. Each directive makes exactly one of three claims:

```md
<!-- @assert-structure target="src/domain" exclude="*.test.ts" pattern="*.entity.ts, index.ts" -->
<!-- @assert-structure target="packages" dirs="*" required="package.json, README.md" -->
<!-- @assert-structure target="src/handlers" exclude="*.test.ts" partner="[name].test.ts" -->
```

- **`pattern`** - every file in scope is named by one of the patterns. They are
  globs, read like `glob=`: without a `/` against the file name, with one
  against the path from the root.
- **`required`** - every directory holds every entry. Without `dirs` the
  directories are the targets; `dirs="*"` means their immediate children and
  `dirs="**"` every directory below them. An entry may be a path
  (`src/index.ts`), may end in a glob (`*.csproj`), and must be a directory
  when it ends in `/`.
- **`partner`** - every file has a partner, named by a template.

Each failure names the file or directory, since there is no line to point at:

```text
✖ docs/architecture.md:3  @assert-structure
    files in src/domain must be named *.entity.ts or index.ts (excluding *.test.ts)
    expected no misnamed files, found 1
      src/domain/helpers.ts  matches none of *.entity.ts, index.ts

✖ docs/architecture.md:4  @assert-structure
    directories matching * under packages must contain package.json, README.md
    expected no directories missing an entry, found 2
      packages/billing  missing README.md
      packages/web  missing package.json, README.md

✖ docs/architecture.md:5  @assert-structure
    files in src/handlers must each have a partner [name].test.ts (excluding *.test.ts)
    expected no files without a partner, found 1
      src/handlers/refund.ts  has no partner src/handlers/refund.test.ts
```

A partner template has three placeholders and nothing else - no regular
expressions, no conditionals - so a reader can expand one by eye:

| Placeholder | For `src/api/user.handler.ts`, `target="src"` |
| --- | --- |
| `[name]` | `user.handler` - the file name up to its last dot |
| `[ext]` | `ts` - what follows that dot |
| `[dir]` | `api` - the file's directory below the target, empty at the top |

A template without a `/` names a file beside it. One with a `/` is a path from
the root, which is how a mirrored test tree is written:
`partner="tests/[dir]/test_[name].py"`. A comma-separated list gives
alternatives, any one of which will do.

The partners themselves are in scope unless `exclude` says otherwise. Forgetting
to exclude them is loud rather than silent, and says what probably happened:

```text
      src/handlers/order.test.ts  has no partner src/handlers/order.test.test.ts (it is the partner of src/handlers/order.ts - exclude it?)
```

Some things fail rather than pass, because each is a rule that would otherwise
check nothing:
- a scope holding no files, or selecting no directories (`allow-empty` as
  everywhere else);
- a template that names the file itself (`partner="[name].[ext]"`);
- a `required` target that is a file.

**Names are compared exactly, on every platform.** Whether `README.md` exists is
decided by reading its directory, never by asking the filesystem for the path.
That lookup finds `Readme.md` on Windows and macOS and does not find it on Linux,
and the same rule would pass on a laptop and fail in CI.

A structure rule reads names, never contents. It walks with the run's usual
skips, follows no symbolic link, and counts the spec files - which every other
rule leaves out, and which a naming rule about `docs/adr` is about. `max`,
`baseline` and `ratchet` work as they do on `@assert-absence`, and a baseline
lists files or directories. `spec-guard query` shows what a rule asks of a file
that does not exist yet:

```text
src/handlers/invoice.ts (does not exist yet)
  1 rule from 1 document

  Architecture  (docs/architecture.md)
    :5 @assert-structure  files in src/handlers must each have a partner [name].test.ts (excluding *.test.ts)
      partner: src/handlers/invoice.test.ts
```

[ADR-0013](docs/adr/0013-structure-assertions.md) has the design and what it
costs.

### `@assert-present` - this file exists

```md
<!-- @assert-present file="SECURITY.md" -->
<!-- @assert-present file="config/production.json,config/staging.json" -->
```

Passes when every listed path exists relative to `--root`. Directories count.

### Attributes

| Attribute | Applies to | Meaning |
| --- | --- | --- |
| `target` | all but present | Comma-separated paths, relative to `--root`. Default `.` |
| `symbol` | absence, count | The literal string to search for (or a regex with `regex="true"`) |
| `file` | present | Comma-separated paths that must exist |
| `expected` | all but present | Exact count for count; an upper bound everywhere else |
| `min` / `max` | count (`max` on all but present) | Inclusive bounds |
| `glob` | absence, count, structure | Include-only file filters, e.g. `*.ts,*.tsx` (ripgrep `-g` semantics) |
| `exclude` | all but present | Paths to leave out, gitignore-style: `src/config/**`, `tests`, `*.test.ts` |
| `regex` | absence, count | Treat `symbol` as a regular expression |
| `word` | absence, count | Require word boundaries, so `Primary` does not match `PrimaryButton` |
| `ignore-case` | absence, count | Case-insensitive matching |
| `comments` | absence, count | `ignore` (default) or `include` for matches inside comments |
| `module` | import-absence, import-count | Which dependency, matched like `exclude` |
| `order` | layers | The layers, from the one everything may depend on to the one that may depend on everything |
| `pattern` | structure | The names every file in scope must match one of |
| `required` | structure | The entries every chosen directory must hold; a trailing `/` means a directory |
| `dirs` | structure, with `required` | Which directories below each target: `*` for children, `**` for all |
| `partner` | structure | Partner templates, any one of which must exist: `[name].test.[ext]` |
| `types` | import assertions, layers, cycles | `include` (default) or `ignore` for `import type` |
| `allow-empty` | all but present | Tolerate a scope that holds no files, a layer that matches none, or no chosen directories. Off by default - see below |
| `baseline` | absence, import-absence, layers, structure | Known violations that do not count: `path` or `path:count` |
| `ratchet` | absence, import-absence, layers, structure | `two-sided` (default) or `one-way` - see below |
| `reason` | all | Human-readable justification, printed on failure |

Unknown attributes are an error, not a shrug: `expct="1"` fails the run instead
of silently asserting nothing.

### `allow-empty` - an assertion that covers nothing is a failure

```md
<!-- @assert-absence target="services" symbol="Legacy" glob="*.ts" -->
```

If `services/` holds no `.ts` file, that rule passes every time, forever,
without inspecting anything - and in the report it is indistinguishable from a
rule that inspected a thousand files and found nothing. So it fails instead:

```text
✖ docs/adr.md:3  @assert-absence
    "Legacy" must not appear in services
    no files were inspected, so this assertion verified nothing
    (add allow-empty="true" if that is expected)
```

The usual causes are a `glob` matching no extension in the tree, an `exclude`
that swallowed the target, or a directory somebody emptied. Where covering
nothing yet is the honest state of the world - a rule written before the code
it guards - `allow-empty="true"` says so, and `--allow-empty-scope` says it for
a whole run.

### `baseline` - adopting a rule the codebase already breaks

A strict rule introduced into a mature codebase lands on violations that already
exist. `exclude` turns those into a permanent blind spot, and `expected="5"`
cannot tell "one fixed, one added" from "nothing happened". A baseline names
them:

```md
<!-- @assert-absence target="src" symbol="LegacyGateway"
     baseline="src/legacy/gateway.ts:2
               src/legacy/adapter.ts" -->
```

The rule now holds when no file outside the list matches and no file inside it
matches more than it declares. A bare path means one match.

**It ratchets in both directions.** New debt fails, obviously. So does debt that
has been *paid* and left on the list, because an entry the code no longer
supports is a spec asserting something untrue:

```text
    expected no matches, found 0; the baseline is out of date and must be
    pruned: src/legacy/adapter.ts (no longer matches)
```

The fix is deleting the line the message names. `ratchet="one-way"` relaxes that
half to a report-only note. Every run says how many matches the baseline
excluded, because a pass bought by an exemption is never silent.

To adopt a rule on a codebase that already violates it:

```bash
spec-guard docs/adr.md --print-baseline
```

prints the attribute that would exempt exactly today's violations, for you to
paste in. It prints; it does not edit. [ADR-0009](docs/adr/0009-debt-baselines.md)
explains why that distinction is the whole design, and why there is no `--fix`
for architecture rules.

## Document status - drafts and superseded ADRs

An ADR has a life. It is `Proposed` before anyone agrees to it, and `Superseded`
long before anyone deletes it - because deleting it deletes the reason a
decision was made.

spec-guard reads that status from the document and honours it. A document whose
status is `draft`, `proposed`, `rejected`, `deprecated` or `superseded` is
parsed, validated, reported - and not executed.

Three spellings are recognised, because three are in use:

<!-- Shown fenced on purpose: spec-guard masks code before reading a status. -->

```md
---
status: proposed
---
```

```md
## Status

Accepted (0.3.0).
```

```md
**Status:** accepted
```

Front-matter wins, then the `## Status` section, then the bold label (which is
only read above the first `##`). Anything else - `Provisional`, `In review`, a
misspelled `Supersedded`, or no status at all - keeps enforcing. That asymmetry
is deliberate: an unanticipated word that keeps enforcing is a visible failure
with an obvious fix, while one that stops enforcing is a green build over a rule
nobody is checking.

Withholding is never quiet:

```text
○ docs/adr/0011-queues.md is Proposed. - 2 assertions not executed

12 passed · 2 not in force · 48ms
```

By name, not by count - the same fact reaches `--format json` as `inactiveSpecs`
and `--format sarif` as a note-level execution notification. A withheld
directive is still checked for typos and bad attributes, so a draft's mistake is
found on the day it is written rather than on the day it is accepted.
`--ignore-status` runs everything, which is how you ask whether a draft would
pass if you accepted it today.

[ADR-0010](docs/adr/0010-spec-status.md) has the full reasoning, including why
there is no per-directive `if-status` attribute.

## Asking before writing - `query` and the MCP server

A run tells you, after the fact, that code broke a rule. `spec-guard query`
tells you which rules a file is under before you touch it:

```bash
spec-guard query src/domain/user.ts --spec "docs/**/*.md"
```

```text
src/domain/user.ts
  3 rules from 2 documents

  ADR-0004: No legacy client  (docs/adr/0004-legacy.md, accepted)
    :12 @assert-absence  "LegacyClient" must not appear in src

  ADR-0011: Layering constraints  (docs/adr/0011-layers.md, accepted)
    :40 @assert-layers  src must keep its layers in order, src/domain < src/application < src/infrastructure
      layer: src/domain (1 of 3)
      may import: src/domain
      must not import: src/application, src/infrastructure
      reason: the domain depends on nothing
    :41 @assert-import-absence  src/domain must not import "pg"

  1 more rule would govern this path if docs/adr/0014-clocks.md (proposed) were in force; --ignore-status lists it

14 spec files read in 6.1ms
```

It answers from the specs alone, without reading the codebase, so it works for
a file that does not exist yet. A directory lists every rule that could reach a
file under it. `--json` is the same answer for a script. Rules in documents that
are not in force are counted and named, never silently left out.

The arithmetic that decides whether a rule governs a path is tested against the
walk a real run makes, file for file, under both engines and on randomly
generated trees. [ADR-0012](docs/adr/0012-query-and-mcp.md) lists the three
things it cannot see: file content (binary, oversized, unreadable), symbolic
links, and letter case on case-insensitive filesystems.

### The MCP server

`spec-guard mcp` serves the same answer to an AI agent over the
[Model Context Protocol](https://modelcontextprotocol.io) on stdio, with no
dependency on the MCP SDK. Register it with your client as a stdio server; the
usual `mcpServers` entry is:

```json
{
  "mcpServers": {
    "spec-guard": {
      "command": "npx",
      "args": ["spec-guard", "mcp", "--spec", "docs/**/*.md"]
    }
  }
}
```

The root defaults to the directory the client starts the server in; pass
`--root` if yours starts servers somewhere else. On Windows, `npx` is a `.cmd`
script that a client spawning without a shell cannot launch; point `command` at
`node` and the first argument at
`node_modules/@descent-vtt/spec-guard/bin/spec-guard.js` instead. Run flags such
as `--engine`, `--strict`, `--ignore-status` and `--allow-missing-targets` apply
to its checks.

| Tool | What it does |
| --- | --- |
| `get_architectural_rules(path, include_inactive?)` | The query above, as text and as structured content |
| `check_architecture(paths?)` | A run. Given paths, only the rules that govern them, each over its whole scope, with every violation marked as in those paths or not |

| Resource | What it holds |
| --- | --- |
| `spec://rules` | Every rule in force, as JSON |
| `spec://doc/{+path}` | Any spec document, in force or not |

Both protocol eras are served: clients that open with `initialize` (revisions
2024-10-07 to 2025-11-25), and clients on 2026-07-28 that put the protocol
version on every request and probe with `server/discover`. Nothing is cached, so
an ADR edited mid-session is read as edited. ADR-0012 has the shapes, the
sources they follow, and what is deliberately not implemented.

## CLI

```bash
spec-guard [patterns...] [options]     # execute the directives
spec-guard --watch [patterns...]       # execute them again whenever the tree changes
spec-guard query <paths...> [options]  # the rules in force for files or directories
spec-guard mcp [options]               # serve the rules over MCP on stdio
```

| Option | Description |
| --- | --- |
| `-r, --root <path>` | Codebase root that assertions resolve against (default: cwd) |
| `--spec <pattern>` | A spec glob or path, repeatable. `query` and `mcp` take their specs only from here |
| `-v, --verbose` | Print passing assertions too |
| `--watch` | Report, then report again as the tree changes, until Ctrl+C |
| `--fail-fast` | Stop at the first failing assertion |
| `--json` | Machine-readable report on stdout (same as `--format json`) |
| `--format <human\|json\|sarif>` | Output format. `sarif` uploads to GitHub code scanning |
| `--engine <auto\|rg\|js>` | Search engine (default `auto`: scanner for small trees, ripgrep for big ones) |
| `--strict` / `--no-strict` | Treat analysis that could not be completed as a failure |
| `--allow-missing-targets` / `--no-allow-missing-targets` | Warn instead of failing when a `target` path does not exist |
| `--allow-empty-scope` / `--no-allow-empty-scope` | Warn instead of failing when an assertion inspects no files |
| `--print-baseline` | Print the `baseline="..."` that would exempt today's violations, and exit |
| `--no-default-skips` / `--default-skips` | Search `.git`, `.hg`, `.svn` and `node_modules` too |
| `--ignore-status` / `--no-ignore-status` | Execute directives in draft, proposed and superseded documents too |
| `--include-specs` / `--no-include-specs` | Also count matches inside the spec files themselves |
| `--max-snippets <n>` | Failure snippets per assertion (default 5) |
| `--concurrency <n>` | Search passes in flight at once (default 8) |
| `--allow-empty` | Exit 0 when no spec file matched the patterns (about the run, not an assertion) |
| `--color` / `--no-color` | Force colour on or off (`NO_COLOR` honoured) |

Patterns are expanded by spec-guard itself, so quoted globs behave identically
on Windows, macOS and Linux. A directory expands to the Markdown files in it.
The second form of each on/off option exists to override a configuration.

### Configuration

The options that are a project's policy can live in `package.json`, under
`"specGuard"`, so CI, a pre-commit hook and the MCP server an agent starts all
hold the same rules the same way:

```json
{
  "specGuard": {
    "specs": ["docs/**/*.md", "README.md"],
    "strict": true
  }
}
```

| Key | Command line | Value |
| --- | --- | --- |
| `specs` | patterns, `--spec` | a non-empty array of globs |
| `engine` | `--engine` | `"auto"`, `"rg"` or `"js"` |
| `strict`, `allowMissingTargets`, `allowEmptyScope`, `ignoreStatus`, `includeSpecs`, `defaultSkips` | the flag of that name | `true` or `false` |
| `maxSnippets` | `--max-snippets` | an integer, 0 or more |
| `concurrency` | `--concurrency` | an integer, 1 or more |

- **Only the root's `package.json`** is read: the `--root` directory, or the
  working directory. Nothing is inherited from a parent directory.
- **The command line wins, both ways.** Patterns replace `specs`, and
  `--no-strict` beats `"strict": true`.
- **A malformed configuration is exit 2, before anything runs**, naming the file
  and the key: an unknown key, `"true"` where `true` goes, or an option that
  belongs to one invocation, such as `format` or `verbose`.
- **Every report says what it took from the file**: a line above the summary
  such as `options from package.json: specs, strict`, and a `config` field in
  JSON. An
  option nobody can see should never decide a result.
- `query` applies what a query reads, and the MCP server reads the file again
  for every request.

### Watch mode

```bash
spec-guard --watch
```

Prints the report, then prints it again whenever something under the root
changes, until Ctrl+C. Saves are batched: a batch starts after 50 ms without a
new change, or 500 ms after its first. On a terminal the screen is redrawn;
otherwise each report is appended under the time. A change that no rule reads
updates the status line and nothing else:

```text
watching 15 specs · 1 change · 21 of 60 rules re-executed · 21 ms · Enter re-runs everything, Ctrl+C stops
```

A session re-executes only the rules whose directive or inputs changed. Every
filesystem read goes through one module, so the session can record which rule
read what. A watcher's event only evicts what it may have changed, and the
evicted facts are read again and compared, so noise costs one directory read,
and a renamed directory's contents need no events of their own. Work that is a
pure function of a file's bytes - tokenizing, comment masking, scanning - is
remembered by the bytes' hash. Each of those is a way to report a tree that no
longer exists, so a test changes trees at random and requires every report a
session gives to equal a fresh run's, with six deliberately broken sessions
that it has to catch. [ADR-0014](docs/adr/0014-configuration-and-watch.md) has
the design, the measurements and the limits.

On this repository, from a change to the report, in the quietest of four runs
(a plain warm run took 69 ms in it):

| Edit | Rules re-executed | Median |
| --- | --- | --- |
| a file in `src` | 21 of 60 | 21 ms |
| a test file | 1 of 60 | 3.3 ms |
| a file no rule reads | 0 | 2.0 ms |
| an ADR's prose | 0 | 2.4 ms |

The 15 ms this was built to is missed for a save in `src`, which re-executes the
two layer rules and every text rule over `src`; ADR-0014 says where the time
goes.

`--watch` scans in-process, where it can see what each rule reads, so it refuses
`--engine`, and `--json`, `--format json|sarif`, `--print-baseline`,
`--fail-fast` and `--allow-empty`, which each describe a single run. It exits
130 when stopped, since a session is neither a pass nor a failure. What it
cannot see: a change the operating system never reports, a change behind a
symbolic link, and anything outside the root. CI stays the authority.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every assertion held |
| `1` | An assertion failed, or a directive was malformed |
| `2` | spec-guard could not run: bad usage, a malformed configuration, no spec files matched, `--engine rg` with no ripgrep, a watch that could not start |
| `130` | A `--watch` session was stopped |

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

### Annotations on the pull request

`--format sarif` writes a SARIF 2.1.0 document, which GitHub turns into a
comment on the offending line:

```yaml
      - run: npx @descent-vtt/spec-guard "docs/**/*.md" --format sarif > spec-guard.sarif || true
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: spec-guard.sarif
          category: spec-guard
```

That job needs `permissions: security-events: write`. One alert per broken rule
rather than per match - the thing that broke is the rule - anchored on the first
offending line, with the directive as a related location because that is often
where the fix goes. Alerts carry a fingerprint derived from what the assertion
is about rather than where its matches landed, so inserting a line above a
violation does not close the alert and open a new one.

**There is no language server, and that is a decision rather than a gap.**
spec-guard's claims are about a whole repository - "this symbol appears nowhere
in `src`" - and a language server is handed one buffer at a time. Answering a
repository-wide question on every keystroke means rescanning the tree on every
keystroke; the alternative is answering a smaller question and calling it the
same one. `--watch` re-evaluates this repository in milliseconds after a save
by re-executing only what the save affected, and a pre-commit hook closes the
rest of the gap, without a daemon, an extension per editor, or a protocol
version matrix.

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

0.5.0 added four language analysers, a scope probe on every assertion and a
baseline pass, so the obvious question is what that cost. Both versions were run
against the same synthetic 1,000-file tree, alternating rounds inside one
process so that this machine's load - which varies by a factor of two over a
session - falls on both equally:

| | median | min |
| --- | --- | --- |
| 0.4.0 | 908.8 ms | 493.7 ms |
| 0.5.0 | 913.4 ms | 496.6 ms |

0.5% apart, against a run-to-run spread far wider than that. The two versions
also returned identical counts for all five assertions, which is the more
useful half of the result.

0.5.1 replaced three hand-maintained "are these the same question" field lists
with one, and the surviving version serialises the exclude set where the old one
compared it by identity - a hot path made slower on purpose, so it was measured
rather than assumed. Same tree, same alternating rounds:

| | median | min |
| --- | --- | --- |
| 0.5.0 | 925.1 ms | 432.1 ms |
| 0.5.1 | 830.6 ms | 428.5 ms |

The medians are 10% apart and the minima are level, which is this machine's
noise band doing most of the talking - the honest reading is "no regression",
not "10% faster". The plausible mechanism for any real gain is that the runner
now groups by the engine's own definition of a shared pass, so a group of five
where two requests disagree is run as three and two rather than being refused
whole and run as five. Counts identical across all five assertions, again.

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

**A document's lifecycle status is read; a directive's is not.** Status is
document-level and visible in every rendered Markdown view. A per-directive
`if-status` attribute would be a switch disabling one assertion inside an
accepted ADR, invisible to anyone who does not read the raw source - and the
one thing a mechanism for not running an assertion must never be is invisible.

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

**Assertions that share a target list share one pass over the tree.** This used
to need a proof: merging literals into a ripgrep alternation can lose matches
through containment (`Primary` / `PrimaryButton`) and dovetailing (`abc` / `cd`
in `abcd`), so spec-guard checked for both and fell back to separate passes.
Since 0.4.0 it does not need the proof, because ripgrep no longer counts
anything - it answers only *which files contain this text*, and the scanner
counts each pattern separately over the shared file contents. The batching
checks were deleted along with the risk they guarded.

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

**An assertion that inspected no files fails.** It is the same defect as a
missing `target` seen from a different angle: a rule whose scope is empty passes
forever and reads exactly like a rule that found nothing. Turning this on found
a vacuous assertion inside this repository's own test suite on the first run.
`allow-empty="true"` covers the honest case of a rule written before the code it
guards.

**Four more languages, and no parser.** Import assertions read Python, Go, Rust
and C# as well as JavaScript. Not by adding four tokenizers - by reusing the
comment and string lexer that already existed, masking the source with it, and
reading statements off what is left. Tree-sitter would have been the modern
answer and costs 94 MB unpacked against this package's 0.33 MB; the four things
a real parser would genuinely see that this cannot are listed in
[ADR-0008](docs/adr/0008-polyglot-imports.md) rather than glossed over.

**There is no `--fix`.** Every edit a machine can make to a failing boundary
assertion is an edit that records the rule no longer holding: widen the bound,
add an exclusion, append to the baseline, insert an ignore comment. A one-flag
path from red to green is a bad button for a person and a much worse one for an
agent whose loop terminates on a green build. `--print-baseline` prints what you
could paste; it does not paste it ([ADR-0009](docs/adr/0009-debt-baselines.md)).

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
npm run test:mutation  # stryker (four parallel jobs in CI; hours locally)
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
behaved differently. This repository measures the difference: line coverage is
**100%**, and **98.89%** of 7,781 mutants are killed in CI, with 83 survivors and
no file below 95%. The second number is the one worth reading, and what was done
about the survivors matters more than the score. At 0.5.1 every surviving mutant
was checked individually, and the 101 left then produced byte-identical output.
Each release since has replayed the survivors its own code added before it
shipped: they were killed, deleted as dead code, or shown equivalent and
recorded in [ADR-0003](docs/adr/0003-mutation-testing.md) with the evidence.

That gap is the point. The first run scored 77.23%, and the weakest file was the
reporter at 65.48% - not because it lacked tests, but because its tests were
almost all `toContain` against colourless output. A mutant could prepend a junk
line, drop a colour, or turn `remaining > 0` into `remaining >= 0` and every
test still passed. Exact whole-output comparison took it to 87.30%. The engine
and the walker were then rewritten for testability rather than papered over with
more tests, which is what moved them from 75%/78% to 83%/93%.

The most recent pass took every module to its ceiling, and its value was not the
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
[ADR-0003](docs/adr/0003-mutation-testing.md), including a Stryker limitation
found on the way: a mutant that stops a test file *loading* is reported as
survived even though the suite is in fact killing it.

CI runs it in **two tiers**, both gated at 97%. Branches and pull requests run
Stryker incrementally, reusing the verdict for any mutant whose source and
covering tests are both unchanged. Pushes to `main`, the weekly schedule and
manual runs do the full sweep, which is the authoritative number and the one
quoted above; a full sweep is also what publishes the cache the branches start
from, so an incremental verdict can never be built on another incremental
verdict.

The full sweep was 6m54s at 2,118 mutants, 15m51s at 3,493, and 42m39s at 7,763.
That growth is why the tiers exist: a check that gets quietly more expensive
every release is a check somebody eventually proposes lowering. It is also why
both tiers now run in four parallel shards. One runner
could no longer finish the full sweep reliably inside the job's limit, and the
answer was to split the sweep rather than raise the limit or drop mutants.
Each shard mutates its own files against every test, and a final job merges the
reports. The merge refuses anything that is not exactly one sweep, and applies
the 97% gate to the merged score with the same library Stryker's gate uses.

Run it locally with `npm run test:mutation` if you like, but do not calibrate
anything on the result: on the Windows machine this was developed on the same
suite takes hours against 43 minutes of hosted time, and it scores *higher*,
because far more mutants hang there and Stryker counts a hang as a kill. Linux
CI is the measurement.

Eight cautionary tales are in [ADR-0003](docs/adr/0003-mutation-testing.md): a
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

## Requirements

- Node.js 22 or newer (native ESM)
- ripgrep optional - used when present, replaced by a built-in scanner when not

## License

MIT
