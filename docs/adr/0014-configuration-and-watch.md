# ADR-0014: Native configuration and incremental watch mode

## Status

Proposed.

The directives in this document are live and withheld. Every kind they use
already exists, so ADR-0010 can validate them today. Accepting the ADR turns
them on, and until then they name files that do not exist yet without failing
anything.

## Context

The request was for two things.

1. **Options in `package.json`**, under `"specGuard"`, with command-line flags
   taking precedence and a clear error for a malformed option.
2. **`spec-guard --watch`**, on `fs.watch` with no dependency, re-evaluating
   only what a change affects: under 15 ms from a change to a report, batched
   saves, a cleared terminal, and a clean exit on Ctrl+C.

The first is smaller than it looks and matters more. Today a project's policy is
spelled on every command line that runs spec-guard: the CI job, the `selfcheck`
script, and the MCP server an agent launches. Nothing keeps the three the same.
An agent whose server was started without `--ignore-status` is told a different
set of rules from the one CI enforces, which is the drift ADR-0012 exists to
prevent, arriving through a launch configuration instead of a spec.

The second is a cache. A watch mode that reuses anything between runs can serve
an old answer, and an old green is the failure this tool exists to prevent. So
most of this ADR is about what may be reused, and how that is proved rather than
assumed. Five findings shaped it. Each was measured or read before the design
was written.

### `governs` decides scope, not what a result depends on

The request suggested using the dependency and scope graph to choose what to
re-run. `governs(assertion, path)` from ADR-0012 is that graph, and it answers a
different question: whether a path is in a rule's scope. A result can also change
because of a path outside its scope. Both of these were reproduced on a fixture,
with the built package:

| Change | Rule | Result | `governs` |
| --- | --- | --- | --- |
| create `src/notes.txt` | `@assert-import-absence target="src"` | new warning: "analysed 2 of 3 files" | false |
| delete `tests/b.test.ts` | `@assert-structure target="src" partner="tests/[name].test.ts"` | fails: 2 files without a partner | false |

The second rule is the shape of the one ADR-0013 applies to this repository.
Spec edits are a third case, since they change the rules themselves. A new spec
file under a target is a fourth: it changes what every text rule leaves out.

### Events are hints, not facts

`fs.watch` with `recursive: true`, on Windows 11 and Node 24.18.1, reported the
following. Each operation was run alone, with 300 ms of quiet after it:

| Operation | Events |
| --- | --- |
| modify `src/a.ts` in place | `change src/a.ts` twice, `change src` |
| create `src/c.ts` | `rename src/c.ts`, `change src/c.ts`, `change src` |
| atomic save (write a temporary file, rename it over `src/a.ts`) | seven events over `src/a.ts`, `src/a.ts.tmp` and `src` |
| rename directory `src/x` to `src/w`, which holds `y/z.ts` | `rename src/x`, `rename src/w`, `change src`, `change src/w`, and nothing for `z.ts` |
| replace file `src/a.ts` with a directory of that name | `rename src/a.ts` twice, `change src` |
| rename top-level `src` to `lib` | `rename src`, `rename lib`, `change lib` |

Three things follow:

- **A save also reports its directory.** Selecting rules by the paths in events
  would re-run every rule over anything in `src` on every save.
- **A renamed directory reports none of its contents.**
- **Event types and counts carry no reliable information.**

### A directory watcher locks the directory's parents on Windows

With a separate watcher on `a`, `a/b` and the root, renaming `a` failed with
`EPERM`. With one recursive watcher on the root, the rename succeeded, and so did
removing the directory. A watch mode built from per-directory watchers would make
`git checkout` and an editor's folder rename fail while it runs.

### Where the time goes

Measured in this repository (14 specs, 53 rules) on the same machine. Load was
not controlled, so ratios are the finding and absolute figures will be taken
again with a committed benchmark:

| Run | Time |
| --- | --- |
| `npm run selfcheck`, as reported by the run | 329 ms |
| full run, warm process | 97 ms median, 64 ms best |
| only the 15 rules `governs` gives for `src/cli.ts` | 44-55 ms |
| only the one rule for `tests/glob.test.ts` | 17-23 ms |
| reading and parsing the specs alone | 6 ms |
| full run with every filesystem read answered from memory | 31-34 ms |

Selecting fewer rules alone does not approach 15 ms. The 15 rules for one file
in `src` share a scan of all of `src`, which costs this much:

| Step | Cost |
| --- | --- |
| walk and `stat` 20 files | 9.0 ms |
| read 338 KB | 13.6 ms |
| ten text patterns | 2.0 ms |
| tokenize imports | 18.9 ms |

The same steps for the largest single file, `src/runner.ts` (61 KB), take 4.1 ms.

With the filesystem taken out, a profile of the remaining 31 ms put about half in
two functions: comment lexing and import tokenizing. Each is a pure function of
one file's contents.

### An assertion cannot be executed twice

Executing one resolved assertion a second time appends its missing targets
again. A text or import rule then warns `target paths not found: src/gone,
src/gone`. Nothing hits this today, because every run and every MCP call
resolves the assertion afresh. A watch mode that keeps assertions between runs
would hit it on its second run.

## Decision

### Configuration: `"specGuard"` in the root's `package.json`

```json
{
  "specGuard": {
    "specs": ["docs/**/*.md", "README.md"],
    "strict": true,
    "ignoreStatus": false
  }
}
```

**It is read from `package.json` in the root**: the `--root` directory, or the
working directory without one. Nothing is looked up in parent directories. Every
other path spec-guard reads is resolved against the root. A configuration found
above it would belong to a different package, and in a monorepo it would apply
its policy there without anyone asking for it.

**The keys are the options that are a project's policy.** Each takes its
command-line name in camel case:

| Key | Command line | Value |
| --- | --- | --- |
| `specs` | patterns, `--spec` | a non-empty array of strings |
| `engine` | `--engine` | `"auto"`, `"rg"`, `"js"`, or an alias the flag accepts |
| `strict` | `--strict`, `--no-strict` | `true` or `false` |
| `allowMissingTargets` | `--allow-missing-targets`, `--no-allow-missing-targets` | `true` or `false` |
| `allowEmptyScope` | `--allow-empty-scope`, `--no-allow-empty-scope` | `true` or `false` |
| `ignoreStatus` | `--ignore-status`, `--no-ignore-status` | `true` or `false` |
| `includeSpecs` | `--include-specs`, `--no-include-specs` | `true` or `false` |
| `defaultSkips` | `--default-skips`, `--no-default-skips` | `true` or `false` |
| `maxSnippets` | `--max-snippets` | an integer, 0 or more |
| `concurrency` | `--concurrency` | an integer, 1 or more |

Some options are not keys:
- `root`, since it is where the configuration is found.
- `format`, `json`, `verbose`, `color`, `failFast`, `printBaseline`, `allowEmpty`
  and `watch`. Each describes one invocation. `"format": "sarif"` in
  `package.json` would make every developer's local run print SARIF.

**The command line wins, in both directions.** Patterns or `--spec` replace
`specs` rather than adding to it. A boolean the configuration can set must be
settable either way from the command line, so each one gains the flag it lacks:
`--no-strict`, `--default-skips`, and the rest in the table. Without them,
`"strict": true` could not be overridden, and "flags take precedence" would be
true of only half the flags.

**A malformed configuration is exit 2, before anything runs.** The message names
the file and the key:

```text
package.json: unknown option "stict" in "specGuard". Options are specs, engine, strict, allowMissingTargets, allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips, maxSnippets, concurrency.
package.json: "specGuard.format" is chosen on the command line, not in package.json.
package.json: "specGuard.strict" must be true or false, got "yes".
package.json: "specGuard" must be an object, got an array.
package.json is not valid JSON (Unexpected token } at position 212), so its "specGuard" options cannot be read.
```

- A string is not a boolean, and a number in a string is not a number. JSON has
  both types, and accepting `"true"` would be a second grammar for the same file.
- A `package.json` that does not exist, or has no `"specGuard"`, means no
  configuration and prints no message.
- Values are checked by the functions that check the flags, so `"engine": "rgg"`
  and `--engine rgg` fail with the same words.

**A run says what it took from the configuration.** A human report under a
configuration ends with a line such as `options from package.json: specs,
strict`. A JSON report carries
`"config": { "file": "package.json", "applied": [...], "overridden": [...] }`.
`allowEmptyScope` in a configuration weakens every rule in the project, so it
must never do so where nobody can see it. ADR-0010 argued the same about
withholding.

**Every command reads it.**
- `query` applies what a query uses: `specs`, `ignoreStatus`, `includeSpecs` and
  `defaultSkips`.
- `mcp` applies all of it. Like the specs, it is read afresh on every request:
  ADR-0012 refused to cache rules in the server, and a cached configuration is a
  cached rule.
- A key that does not apply to a command is not an error for that command.
  `NOT_FOR` refuses `spec-guard query --strict` because the person typing it
  would think the query was strict. A key in `package.json` is written for every
  command at once.

`src/config.ts` validates a value it is handed, so every malformed option can be
tested on a plain object. The CLI reads the file, through the same door as every
other read (below).

<!-- @assert-import-absence target="src/config.ts" module="src/io.js" reason="configuration is validated from a value; reading the file is the command line's job" -->
<!-- @assert-present file="src/config.ts, tests/config.test.ts" reason="a configuration nobody can see being validated is a second grammar nobody reviews" -->

### Watch mode: `spec-guard --watch`

**It is a check.** `query --watch` and `mcp --watch` are refused.

With `--watch`, these are refused:
- `--json`, `--format json|sarif` and `--print-baseline`, which each produce one
  document for one run;
- `--fail-fast` and `--allow-empty`, which change only an exit code nobody reads
  in a session;
- `--engine` (below).

**The lifecycle:**

1. Read the configuration.
2. Attach one watcher to the root.
3. Run everything once and print the report. The watcher comes first, so nothing
   that changes during the first run is missed.
4. Queue events. Start a batch after 50 ms without a new event, or 500 ms after
   the first queued event, whichever comes first, so a `git checkout` still
   produces progress.
5. Never run two batches at once. Events during a batch queue for the next one.
6. Print a batch's report if any rule was re-executed. Otherwise update one
   status line, so a save no rule reads is acknowledged without redrawing the
   report.
7. **Enter** evicts every fact (below) and runs everything.
8. **Ctrl+C** or SIGTERM closes the watcher and exits 130, the shell's code for
   an interrupted command. A session is neither a pass nor a failure, and exit 0
   or 1 would claim one. A second Ctrl+C during shutdown exits at once.

A watcher error, including the root disappearing, is reported and exits 2. On a
terminal the screen is cleared before each report. Otherwise reports are appended,
each headed by the time, and no escape codes are written.

Signals, timers, stdin and the watcher reach `src/watch.ts` through `CliIO`, as
stdout already does. The scheduling can then be tested with a fake clock, and
the signal handlers are installed in `cli.ts`, beside the only code in `src`
allowed to write to `process.stdout`.

**One recursive watcher on the root.** Per-directory watchers lock renames on
Windows. How recursion behaves elsewhere was not measured here:
- On macOS, Node uses FSEvents.
- On Linux, Node implements recursion itself over inotify, one watch per
  directory. `fs.watch` has no option to leave a directory out, so
  `node_modules` is watched too, and `fs.inotify.max_user_watches` applies. An
  `ENOSPC` is reported with that setting's name.

The design below does not depend on either platform reporting a directory's
contents, event types, or one event per change. The macOS and Linux CI runners
are where this claim is tested.

<!-- @assert-absence target="src" symbol="watchFile" reason="fs.watchFile polls with stat; watch mode waits for events" -->
<!-- @assert-absence target="src" symbol="setInterval" reason="nothing in spec-guard polls" -->

### One door for every read

Every filesystem read a rule makes goes through one interface in `src/io.ts`:
- list a directory;
- `stat` a path;
- read a file.

`fs.watch` lives there too.

The walk, the scanner, the import index, the tree index, existence checks, spec
reading and the MCP server's resources take it as a parameter. The walk, the
enumeration and the tree index already accept an injected directory reader, and
the MCP server an injected file reader. The rest read `node:fs` directly today.
A plain run uses the Node implementation. A watch session uses a caching,
recording one.

<!-- @assert-import-absence target="src" module="node:fs, node:fs/promises" exclude="src/io.ts" reason="watch mode can only evict what it saw being read, and it sees reads at one door" -->

**Watch mode does not use ripgrep.** ripgrep reads files in another process,
where no door can see them. Its cost is also a process per pass: ADR-0004
measured 126 ms or more per search on Windows and 12 ms or more on Linux. So
`--engine` is refused with `--watch`, and a configuration's `engine` does not
apply to it. On a tree large enough for ripgrep to win, the first run of a
session is slower than `spec-guard` alone. How much slower is measured before
this is accepted.

### Facts, evicted by events and re-read with early cutoff

A watch session caches three kinds of fact. For each, only the fields the code
reads count as a change:

| Fact | Read by | Counts as a change |
| --- | --- | --- |
| a directory's listing | walks, the tree index | the set of names, each with its kind: file, directory, link or other |
| a path's `stat` | existence checks, file sizes | present or missing, kind, size |
| a file's contents | the scanner, the import index, specs, `package.json` | its SHA-256 |

**Events only evict.** An event naming a path evicts:
- every fact about that path;
- the listing of its parent;
- every fact about a path beneath it.

An event without a filename evicts everything, and so does Enter. Paths are
compared case-folded and Unicode-normalised. On a case-sensitive filesystem that
evicts too much only when two names differ by case alone, and too much is the
safe direction.

**Evicted facts that a rule used are read again at once**, and one whose value
did not change keeps its readers clean. That turns the Windows `change src` on
every save into one directory read. A renamed directory's contents need no events
of their own: its old path loses everything beneath it, and the new path is a
listing nobody has read yet.

Timestamps are never compared, so their granularity does not matter, and
neither does `touch`.

### Pure work is memoised by what it is a function of

In a session, a result is cached under the hash of the contents it came from,
plus every other input:

| Result | Also keyed by |
| --- | --- |
| an import analysis | the file's relative path, which decides its language |
| a comment mask | the relative path |
| a text scan | the relative path, the pattern, and `regex`, `word`, `ignoreCase` and `comments` |
| a parsed spec | the relative path |

A memo needs no invalidation, because it cannot be wrong about the contents it is
keyed by. An entry no run consulted is dropped after the next run.

### Selection: each rule records the facts it read

In a session, each assertion executes with its own per-run caches and its own
recording view of the fact cache. Between assertions, only two things are
shared:
- facts, recorded against every assertion that reads one, whether or not it came
  from the cache;
- memos, which need no record because they are pure.

The per-run caches of a plain run are keyed by path: the engine's result cache,
the import index, the tree index's walks and the scope probe. Those are facts
wearing a different name. Sharing one between assertions without recording it
would let the second reader skip the read, and so skip the record. The
equivalence test below includes that defect as a negative control.

**A rule is re-executed unless its resolved form is identical to last time and
every fact it read is unchanged.** That one condition covers every case:
- An edit to a spec changes resolved forms, or the facts spec reading used.
- A spec file added under a target changes every rule whose excluded files it
  joins.
- A change to the configuration changes every rule, since the run's options are
  part of the resolved form.

Execution stops mutating the assertion it is given. The first commit shows the
doubled warning with a test that executes one assertion twice, and then fixes it.

### What a watch report says

It is the report a run prints, followed by one line. The figures here only show
the shape:

```text
watching 14 specs · 2 changes · 15 of 53 rules re-executed · 6 ms · Enter re-runs everything, Ctrl+C stops
```

The time is from the start of the batch to the report. It does not include the
50 ms quiet window before the batch, and nothing in this design makes a save show
up sooner than that window.

### Held to a fresh run, not to a model of one

<!-- @assert-present file="tests/watch-equivalence.test.ts" reason="watch mode's claim to match a fresh run is exactly as good as the test that holds it to one" -->

`tests/watch-equivalence.test.ts` builds seeded random trees. Each holds:
- rules of every kind;
- spec files inside the tree;
- a `package.json` with a configuration.

It applies random mutations:
- writing, appending and deleting files;
- creating and removing directories;
- renaming files and directories;
- replacing a file with a directory of the same name;
- editing directives and the configuration.

After each mutation, the session is told about the change in each of four forms:
1. every changed path;
2. only the topmost;
3. with a `change` for every ancestor directory, as Windows does;
4. duplicated and shuffled.

Its report must then equal a fresh `runSpecGuard` of the same tree, field for
field, except durations. A failure prints its seed.

Each negative control is a deliberate defect, and each must make that test fail:

- sharing a walk between assertions without recording its listings;
- eviction that forgets the parent's listing;
- eviction that forgets what lies beneath a path;
- a listing cutoff that compares names and not kinds;
- a memo keyed without the relative path;
- reusing a result whose resolved form changed.

`tests/watch.test.ts` covers scheduling with an injected clock and watcher:
- the quiet window and its cap;
- no overlapping batches;
- Enter, signals and exit codes;
- a watcher error, and output with and without a terminal.

One process test runs the built binary on all six CI jobs, with a real watcher on
a temporary tree. It makes real changes, waits for output to settle, and requires
the last report to equal `spec-guard --engine js` on the same tree.

<!-- @assert-layers target="src" order="src/io.ts, src/runner.ts, src/query.ts, src/mcp.ts, src/watch.ts, src/cli.ts" reason="reads know nothing of rules, and neither the query nor the protocol knows a session exists" -->

## Consequences

### The budget: what was measured and what is estimated

The measured figures are in [Where the time goes](#where-the-time-goes). The rest
is an estimate. With facts, memos and selection, an edit to one file in `src`
re-executes the 15 or so rules that read it. Their only uncached work is that
file, which costs 4.1 ms read, scanned and tokenized, plus aggregation over
cached results.

Before this ADR is accepted, the budget is measured with a committed benchmark
for four edits:
- a file in `src`;
- a test file;
- a file no rule reads;
- an ADR.

A figure that misses 15 ms is reported as it is. The budget is not reworded to
fit.

What a person experiences is the quiet window plus that figure: 65 ms or so from
a save, if the budget holds. Process startup does not count, since a session pays
it once.

### What watch mode cannot see

- **An event the operating system never delivers.** A lost event for a created,
  deleted or renamed entry is recovered by any later event naming its directory
  or anything else in it, since either evicts the directory's listing.
  A lost event for a file whose contents changed is not recovered until that file
  is named again, or Enter is pressed. CI remains the authority; a session writes
  nothing and gates nothing.
- **Changes behind a symbolic link.** A path read through a link is evicted by
  events on the link, not on what it points to. The walk does not follow links
  already, so this touches only targets, `@assert-present` files and spec
  patterns that are links themselves.
- **Anything outside the root.** A spec pattern that matches a file outside the
  root makes `--watch` exit 2 and name the file, rather than watch everything but
  the rules.

### What it costs

- **Six modules stop importing `node:fs`:** glob, engine, imports, runner, specs
  and mcp. The tree index already takes its reader. That is churn through the
  most mutation-tested code in the repository. The 97% bar holds for every
  commit, as it did for ADR-0013.
- **A session holds a hash and memoised results** for every file its rules read.
  How much memory that is will be measured on this repository and on the
  10,000-file tree from ADR-0013.
- **Assertions run unbatched in a session.** In a plain run, one pass shared by
  every rule over the same scope is, by the runner's own account, where most of
  the speed comes from. In a session, facts and memos share that work instead.
  Whether the first run of a session is slower than a plain run is measured, not
  assumed.

### This repository

`package.json` gains `"specGuard": { "specs": ["docs/**/*.md", "README.md"] }`,
and `selfcheck` becomes `spec-guard --verbose`. The MCP server an agent starts in
this repository then reads the same specs as CI without being told. The rule
against runtime dependencies in ADR-0012 already reads `package.json`, and is
what keeps Chokidar out.

## Alternatives considered

**Chokidar.** It is a runtime dependency. Most of what it does is normalise event
noise, and eviction with early cutoff does not care about noise.

**Selecting rules with `governs`.** It is simple, and it misses the two
counterexamples in the Context and the spec edits. It also over-selects on every
Windows save, because each save reports its directory.

**Re-evaluating every rule, with facts and memos but no selection.** This is the
simplest design that is correct without recording dependencies. The run answered
from memory took 31 ms, and about half of that is work the memos remove. That
puts it at the edge of the budget in this repository and past it in a bigger
one. It stays the fallback if selection cannot pass the equivalence test.

**Trusting event types, or timestamps.** The Windows table shows duplicate events
and `change` events on parent directories. Timestamps have a granularity (two
seconds on FAT, one on HFS+), and anything can set them.

**A watcher per directory.** It lets a directory be left out, and it makes
renames fail on Windows.

**Polling.** Its cost is proportional to the tree, on every tick, whether or not
anything changed.

**A `spec-guard.config.json`, or a JavaScript configuration.** The request was
`package.json`. A JavaScript file would execute code to learn a policy, which is
more trust than a linter's configuration should ask for. A separate JSON file
would serve repositories that have no `package.json`, which spec-guard's polyglot
import rules (ADR-0008) make a real audience. It can be added later without
changing any key.

**Looking up `package.json` in parent directories.** In a monorepo, a package
would silently take the policy of the directory above it.

**`--config <path>`.** Nothing needs it yet. The root decides where the
configuration is, as it decides where everything else is.
