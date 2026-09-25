# ADR-0014: Native configuration and incremental watch mode

## Status

Accepted.

Proposed first, with its directives live and withheld: every kind they use
already existed, so ADR-0010 could validate them before the files they name did.
Building it changed four decisions, each marked where it falls and gathered
under [What building it changed](#what-building-it-changed). The budget it set
itself was measured before acceptance, as it said it would be. It is missed for
a save in `src`, at 21 ms, and the numbers and the reasons are under
[The budget, measured](#the-budget-measured).

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
- **Counts carry no information, and types describe little.** A save arrives as
  changes and renames alike, and a creation as a rename and a change.

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
package.json: unknown option "stict" in "specGuard". Options are specs, exclude, engine, strict, allowMissingTargets, allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips, maxSnippets, concurrency.
package.json: "specGuard.format" is chosen on the command line, not in package.json.
package.json: "specGuard.strict" must be true or false, got "yes".
package.json: "specGuard" must be an object, got an array.
package.json is not valid JSON (Unexpected token } at position 212), so its "specGuard" options cannot be read.
```

- A string is not a boolean, and a number in a string is not a number. JSON has
  both types, and accepting `"true"` would be a second grammar for the same file.
- A `package.json` that does not exist, or has no `"specGuard"`, means no
  configuration and prints no message.
- An engine is named by the function that reads the flag, so `"engine": "rgg"`
  and `--engine rgg` fail with the same words.

**A run says what it took from the configuration.** A human report under a
configuration carries a line, just above its summary, such as
`options from package.json: specs, strict`. A JSON report carries
`"config": { "file": "package.json", "applied": [...], "overridden": [...] }`.
`allowEmptyScope` in a configuration weakens every rule in the project, so it
must never do so where nobody can see it. ADR-0010 argued the same about
withholding.

**Every command reads it.**
- `query` applies what a query uses: `specs`, `exclude`, `ignoreStatus`,
  `includeSpecs` and `defaultSkips`.
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

### 0.10.0: `.spec-guard.json`, and a project's exclusions

Two findings from running 0.9.2 over a polyglot monorepo.

**A root with no `package.json` could hold no configuration.** A Rust, Go or .NET
repository with a web frontend in a subdirectory has nowhere at its root to put
`"specGuard"`. The same options can now sit, at the top level, in
`.spec-guard.json` in the root. They are validated by the same checks, and the
messages name that file and the bare key: `.spec-guard.json: "strict" must be
true or false, got "yes".`

**Both files holding options is exit 2**, including a `"specGuard": {}` that is
empty:

```text
Options are set in both package.json ("specGuard") and .spec-guard.json. Keep them in one of the two, so that no option is written somewhere nothing reads.
```

The proposal was to read `.spec-guard.json` when `package.json` held no options,
and otherwise to ignore it. That leaves a file of options that nothing reads,
changing nothing, with nothing saying so. The report's options line names the
file that was used. A `package.json` with no `"specGuard"` beside a
`.spec-guard.json` is not a conflict: a frontend's manifest is not a place
someone put spec-guard's options.

**Build output had to be excluded by every rule.** `target`, `bin`, `obj` and
`dist` took a whole-repository scan from 3,000 files to 37,000, and 8 seconds to
60. The only remedy was repeating `exclude="target bin obj dist"` on each
directive. `exclude` is now a key, a list in the directive's gitignore form. It
is added to the `exclude` of every directive that takes one, when the directive
is resolved. That is the one place every engine, walk, import graph, structure
walk and `query` already take exclusions from, so none of them needed a second
path. A watch session re-runs what an edit to the list affects, since the list
is part of each rule it resolves.

- **`@assert-present` is untouched.** It names its files, and a project that
  excludes `dist` can still require `dist/index.js`.
- **A rule's description names only its own exclusions.** The project's are
  named once, in `options from .spec-guard.json: specs, exclude`, rather than
  appended to every rule in the report.
- **The command line wins here too.** `--exclude <globs>` is repeatable and
  replaces the configuration's list, and `--exclude=` with nothing clears it. Every
  key can be overridden from the command line, and a list has no `--no-` form.
- **It is not applied to finding specs.** `specs` are globs chosen for that job,
  and a project that keeps docs under an excluded name should not lose them
  without being told.

### 0.10.1: exclusions a report can show, and one pattern for both engines

Running 0.10.0 over a large monorepo found four things.

1. **A passing run hid which paths were excluded.** The report said
   `options from .spec-guard.json: exclude` and never what `exclude` held.
2. **`--exclude` on the command line left no trace.** Without a configuration
   the report had no options line at all, so a run under `--exclude dist`
   looked exactly like one without it.
3. **A list pasted from `.gitignore` was wider than it read.** In
   `["build", "!build/generated/needed.ts"]`, `build` excluded the directory,
   and the `!` line, which `.gitignore` reads as a re-inclusion, matched no
   path and changed nothing.
4. **`query` said "no rules in force govern this path"** for a path the project
   had set aside, in the same words as for a path nobody had written a rule
   about.

Before refusing patterns, each shape was run under both engines, over the same
tree, with the rule's target at the root and then at `src`. Five exclude shapes
and two include globs disagreed:

| Pattern | Scanner excluded | ripgrep excluded |
| --- | --- | --- |
| `exclude="/build"` | nothing | the root's `build` |
| `exclude="/**/build"` | nothing | every `build` |
| `exclude="./build"` | every `build` | nothing |
| `exclude="src\build"` | `src/build` | nothing |
| `exclude="build/"` | a directory or a file named `build` | only a directory |
| `glob="./src/*.ts"` | matched `src/*.ts` | matched nothing |
| `glob="src/"` | matched everything under `src` | matched nothing |

`!x`, `../x`, a drive path, `.` and `/` matched nothing under either. `auto`
picks ripgrep only past a size, so a rule excluding `/target` - the form Cargo
writes into `.gitignore` - counted differently once the tree grew. It had been
so since `exclude` was added, for directives as well as for the configuration.
The parity matrix had covered only the shapes people had thought to write.

**Both engines are now given one pattern.** `normalizeGlob` and
`normalizeExclude` turn backslashes into separators and drop a leading `./`.
`normalizeGlob` reads a trailing `/` as everything under the directory, and
`normalizeExclude` drops it. ripgrep is handed that form instead of what was
written. A leading `/` is kept, and the scanner now reads it as ripgrep and
`.gitignore` do, as anchoring the pattern to the root. Each change moved the
engine that disagreed to the other engine's non-empty meaning, so neither lost
an exclusion it already applied. The one choice that was not forced is
`./build`. It keeps the scanner's meaning, any `build`, rather than becoming
`/build`: that would have narrowed what the scanner had always excluded, and
`/build` already says "the one at the root". Every shape in the table is now a
case in the parity matrix. Layer orders and import modules use the same matcher,
so a leading `/` anchors there too, where it matched nothing.

<!-- @assert-absence target="src/engine.ts" symbol="push('--glob', glob)" reason="ripgrep is given the pattern the scanner reads, never the pattern as written" -->

**Patterns that can never exclude anything are refused**, by `excludePatternError`,
in four places:
- the configuration, exit 2, naming the file and key;
- `--exclude`, exit 2, as a usage error;
- a directive's `exclude="..."`, as an invalid directive;
- `runSpecGuard` and `loadRuleSet`, which throw for a caller of the API.

```text
.spec-guard.json: "exclude" has an invalid exclude pattern "!build/generated/needed.ts": negation patterns are not supported in exclude.
Option --exclude has an invalid exclude pattern "../vendor": ".." leads out of the root, and only paths inside it are searched.
Attribute "exclude" has an invalid exclude pattern "C:/repo/bin": exclusions are relative to the root, and a drive path is not.
```

The refused shapes are `!`, a `..` segment, a drive path, and `.` or `/`.
- **A directive is refused too, in a patch release.** A directive that was
  accepted in 0.10.0 can now be invalid and fail a run. Every such pattern
  excluded nothing, so the only runs this fails are ones whose rule said
  something it did not do.
- **Negation is refused rather than supported.** `.gitignore` gives `!` ordered,
  last-match-wins semantics. ripgrep's override globs read a glob without `!` as
  "search only this", which is a different thing. The query arithmetic would
  need the ordering as well. Refusing it is small, and says what is wrong.
- **A POSIX absolute path is not refused.** `/home/me/repo/dist` reads as a
  pattern anchored to the root, like `/dist`, and cannot be told apart from one.

**Reports name the patterns.**
- The options line lists them beside the key, applied or overridden:
  `options from .spec-guard.json: specs, exclude (target, bin, obj, dist)`, and
  `exclude (none)` after `--exclude=`.
- Exclusions no configuration accounts for get their own line:
  `exclude from the command line: dist`. The reporter cannot tell a command
  line from a caller of the API, but every command spec-guard ships takes them
  from the command line.
- The MCP server used to discard what it took from the configuration. It now
  passes it to both tools, so their text carries the same lines and their
  structured content carries `exclude` and `config`.
- `RunReport` and `QueryReport` carry `exclude` always, an empty list when there
  is none, as `warnings` and `inactiveSpecs` are always present. An audit
  records "no exclusions" as surely as it records which.

**`query` says why.** Each path carries `excluded`:
- `project`, the project's patterns that match the path itself;
- `rules`, the rules that the project's exclusions alone would let reach the
  path, and that their own `exclude="..."` keeps off it.

The headline names the reason when no rule governs the path: `the project's
exclude leaves it out (target)`, or `exclude="..." leaves it out of 2 rules`,
followed by those rules. A path an `@assert-present` still governs gets a note
that the project's exclude leaves it out of every other rule.

Where the project's exclude is the reason, a rule's own is not named as a second
one. That also settles a pattern that both the directive and the project list,
which resolution merges into one entry: it counts as the project's.
`leftOutByOwnExclude` first asked whether a rule would govern the path with no
exclusions at all. CI's sweep left that question's empty list of patterns
standing, because a list of one pattern no path has behaves the same in every
test. So it now asks `governs` with only the project's patterns, and with all of
them.

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
6. Print a batch's report if it says anything the last report did not.
   Otherwise rewrite one status line, so a save no rule reads is acknowledged
   without redrawing the report.
7. **Enter** evicts every fact (below) and runs everything.
8. **Ctrl+C** or SIGTERM closes the watcher and exits 130, the shell's code for
   an interrupted command. A session is neither a pass nor a failure, and exit 0
   or 1 would claim one. A second Ctrl+C during shutdown exits at once.

A watcher error, including the root disappearing, is reported and exits 2, and so
is a first run that cannot be made, such as one whose specs lie outside the root.
A later run that cannot be made - a `package.json` saved half-written, or edited
to name specs outside the root - is shown in place of the report, and the session
waits for the next change. So does a session whose patterns match no spec yet,
since creating one is the obvious next thing to do. On a terminal the screen is
cleared before each report. Otherwise reports are appended, each headed by the
time, and no escape codes are written.

Signals, stdin and the watcher reach `src/watch.ts` through `CliIO`, as stdout
already does, and its timers through a clock it can be handed. The scheduling
can then be tested with a fake clock, and the signal handlers are installed in
`cli.ts`, beside the only code in `src` allowed to write to `process.stdout`.

**One recursive watcher on the root.** Per-directory watchers lock renames on
Windows. How recursion behaves elsewhere was not measured here:
- On macOS, Node uses FSEvents.
- On Linux, Node implements recursion itself over inotify, one watch per
  directory. `fs.watch` has no option to leave a directory out, so
  `node_modules` is watched too, and `fs.inotify.max_user_watches` applies. An
  `ENOSPC` is reported with that setting's name.

The design below does not depend on a platform reporting a directory's contents,
or one event per change. It depends on one thing about event types, which is
stated where it is used. The process test with a real watcher, and SIGINT's exit
130, passed on the macOS and Linux CI runners on both Node versions, as well as
on Windows.

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
enumeration and the tree index already accepted an injected directory reader,
and the MCP server an injected file reader; the rest read `node:fs` directly.
A plain run uses the Node implementation. A watch session uses a caching,
recording one.

<!-- @assert-import-absence target="src" module="node:fs, node:fs/promises, fs, fs/promises" exclude="src/io.ts" reason="watch mode can only evict what it saw being read, and it sees reads at one door" -->

Since 2026-09-26 a caller of the API can hand a run a door of its own, as
`RunOptions.io`, and every read `runSpecGuard` makes goes through it. The run
had the door all along and passed the Node one to every reader by name. With a
caller's door, `engine: 'ripgrep'` is refused, for the reason watch mode does
not use it, and `auto` is the scanner. The scanner is its own fallback, as it
is in a session: the shared one reads the filesystem.

<!-- @assert-absence target="src/runner.ts" symbol="io: nodeIo" reason="a run reads through the door it was given, and through the filesystem only when it was given none" -->

**Watch mode does not use ripgrep.** ripgrep reads files in another process,
where no door can see them. Its cost is also a process per pass: ADR-0004
measured 126 ms or more per search on Windows and 12 ms or more on Linux. So
`--engine` is refused with `--watch`, and a configuration's `engine` does not
apply to it. On a tree large enough for ripgrep to win, the first run of a
session is slower than `spec-guard` alone: 2.5 times over 10,446 files, measured
under [The budget, measured](#the-budget-measured).

### Facts, evicted by events and re-read with early cutoff

A watch session caches three kinds of fact. For each, only the fields the code
reads count as a change:

| Fact | Read by | Counts as a change |
| --- | --- | --- |
| a directory's listing | walks, the tree index | the set of names, each with its kind: file, directory, link or other |
| a path's `stat` | existence checks, file sizes | present or missing, kind, size |
| a file's contents | the scanner, the import index, specs, `package.json` | its SHA-256 |

**Events only evict.** An event naming a path evicts every fact about that path
and the listing of its parent. It also evicts every fact about a path beneath
it - unless it is a `change` naming a directory whose listing the session holds.

That exception is the one thing about an event this relies on, and it changed
from the proposal, which evicted beneath every path. Windows reports a `change`
for a directory on every save inside it. Evicting beneath it means reading every
file under it again on every save, only to find them unchanged. Node documents
`rename` as the event for a name that appears or disappears, and a directory
replaced or renamed into place is a name that disappears and appears. So a
`change` is taken to be about the directory itself, and the files beneath it
have events of their own. In one benchmark run each way on this repository, with
53 rules, not trusting it cost about 1 ms more on a save in `src` (15.1 ms
against 13.8) and 3 ms more on one in `tests` (5.8 against 2.4). On a directory of a few thousand
files it would cost a read of every one of them on every save.

An event without a filename evicts everything, and so does Enter. Paths are
compared case-folded and Unicode-normalised. On a case-sensitive filesystem that
evicts too much only when two names differ by case alone, and too much is the
safe direction.

**Evicted facts that a rule used are read again at once**, and one whose value
did not change keeps its readers clean. A renamed directory's contents need no
events of their own: its old path loses everything beneath it, and the new path
is a listing nobody has read yet.

Timestamps are never compared, so their granularity does not matter, and
neither does `touch`.

### Pure work is memoised by what it is a function of

In a session, a result is cached under the SHA-256 of the contents it came from,
plus every other input:

| Result | Also keyed by |
| --- | --- |
| an import analysis | the file's relative path, which decides its language |
| a file's scan: every pattern's tally, whether it is binary, and whether its comments could be told from its code | the relative path, the patterns, and `regex`, `word`, `ignoreCase` and `comments` |
| a parsed spec | its absolute and relative paths, which its directives' locations carry |

The proposal memoised the comment mask and each pattern's scan separately. What
got built memoises a file's whole scan, because the mask is only built when a
pattern matches, and what a scan reports depends on whether it was. A memo needs
no invalidation, because it cannot be wrong about the contents it is keyed by.
An entry no run consulted is dropped after the next run. A plain run passes a
memo that remembers nothing and hashes nothing.

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

It is the report a run prints, followed by one line:

```text
watching 15 specs · 1 change · 21 of 60 rules re-executed · 21 ms · Enter re-runs everything, Ctrl+C stops
```

A batch that leaves the report as it was rewrites only that line.

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
field, except durations. The suite runs three seeds of thirty changes each.

Each negative control is a deliberate defect, and each must make that test fail:

- sharing a walk between assertions without recording its listings;
- eviction that forgets the parent's listing;
- eviction that forgets what lies beneath a path;
- a listing cutoff that compares names and not kinds;
- a memo keyed without the relative path;
- reusing a result whose resolved form changed.

In the suite each control meets a scripted change chosen to expose it, beside a
correct session that must agree throughout, so a scenario that broke everything
cannot pass for a caught defect. Before that, the random changes were run against
all six, and against the real session and one that never cuts off, over ten
seeds and all four forms: forty sessions each, 1,200 changes.

| Session | Runs in which random changes caught it |
| --- | --- |
| the real one | 0 of 40 |
| one that treats every fact read again as changed | 0 of 40 |
| sharing caches between rules | 40 of 40 |
| a memo keyed without the path | 40 of 40 |
| eviction that forgets the parent's listing | 38 of 40 |
| reusing a result whose directive changed | 36 of 40 |
| a listing compared by names alone | 19 of 40 |
| eviction that forgets what lies beneath | 5 of 40 |

The last is why the controls are scripted: it takes a directory replaced by one
with the same names in it, reported only by its own name, and random changes
rarely make that. The first two rows are the ones that matter. They read 0 only
after two defects in plain runs were fixed, which the same survey found first
(see [What the tests found](#what-the-tests-found)).

`tests/watch.test.ts` covers scheduling with an injected clock and watcher:
- the quiet window and its cap;
- no overlapping batches;
- Enter, signals and exit codes;
- a watcher error, and output with and without a terminal;
- refusals and failures on the first run and on later ones.

One process test runs the built binary on all six CI jobs, with a real watcher on
a temporary tree. It makes real changes, waits for output to settle, and requires
the last report to equal `spec-guard --engine js` on the same tree. It sends
SIGINT and expects 130 on macOS and Linux. Windows has no signal to send another
process, so there the exit code is tested in-process only.

<!-- @assert-layers target="src" order="src/io.ts, src/runner.ts, src/query.ts, src/mcp.ts, src/watch.ts, src/cli.ts" reason="reads know nothing of rules, and neither the query nor the protocol knows a session exists" -->

## Consequences

### The budget, measured

`scripts/bench-watch.mjs` copies this repository's docs, sources and tests into a
scratch directory and times four edits through a session, from the report of the
edit to the session's answer. Each edit is reported as Windows reports a save,
with a `change` for each directory above the file. Windows 11, Node 24.18.1, 16
logical processors. Other work on the machine was not controlled, and a plain
warm run of the same tree is printed beside each result, to show how loaded the
machine was.

**Before this ADR's own rules went live**, with 53 rules, two runs:

| Edit | Rules re-executed | Median | Worst |
| --- | --- | --- | --- |
| a file in `src` | 17 of 53 | 13.8 / 12.9 ms | 28.2 / 29.1 ms |
| a test file | 1 of 53 | 2.4 / 2.2 ms | 7.1 / 5.5 ms |
| a file no rule reads | 0 | 1.3 / 1.2 ms | 2.3 / 2.6 ms |
| an ADR's prose | 0 | 1.7 / 1.7 ms | 2.7 / 2.1 ms |

A plain warm run took 53-79 ms in those runs.

**With them live**, 60 rules, the quietest of four runs, with the range of the
four medians:

| Edit | Rules re-executed | Median, quietest run | Medians, four runs |
| --- | --- | --- | --- |
| a file in `src` | 21 of 60 | 21.1 ms | 21-46 ms |
| a test file | 1 of 60 | 3.3 ms | 3.3-7.3 ms |
| a file no rule reads | 0 | 2.0 ms | 2.0-4.2 ms |
| an ADR's prose | 0 | 2.4 ms | 2.4-6.5 ms |

A plain warm run took 69 ms in the quietest run and 135-157 ms in the others.

**The budget is missed where it matters most.** A save in `src` took a median of
21 ms in the quietest run. It met the budget, at 13 ms, until this ADR's seven
rules went live and four of them joined the rules a save in `src` re-executes.
Every other edit stays well inside it. A session with nothing changed answers in
2-7 ms, and its first run costs about what a plain run does.

A profile of sixty such saves says where the 21 ms go: 2 ms to observe the
change, and the rest to re-execute the rules that read the file. Their largest
costs are matching every import against the order of each of the two layer
rules, lexing the changed file's comments again for each of the ten text rules
over `src`, and the fact cache normalising paths. A comment mask shared between
rules that read the same bytes, and paths normalised once, would take a few
milliseconds off. The rest is the rules themselves, and grows with them. This is
reported as measured; the budget is not reworded to fit.

What a person experiences is the quiet window plus that figure: 70 ms or so from
a save in `src`, in the quietest run. Process startup does not count, since a
session pays it once.

**Scale, over 10,446 files** (this repository's `node_modules`, three rules):

| Run | Time |
| --- | --- |
| plain, `--engine auto`, which chose ripgrep | 1,316 ms |
| plain, `--engine js` | 2,597 ms |
| a session's first run | 3,289 ms |
| a session's next run, nothing changed | 3.2 ms |

A session holds 21,075 facts and 121 MB of heap and buffers over that tree,
against 235 facts and 2.7 MB over this repository. The memory is the contents of
every file its rules read, kept so that a change costs a read of the changed file
and not of its neighbours. That is the price of the design, and it grows with
what the rules read, not with the tree.

### What the tests found

**An assertion could not be executed twice.** Found in reading, before any code
was written, and fixed first with a test that executes one rule twice.

**Two runs of one tree listed skipped files in different orders.** The scanner's
readers added a file they could not inspect to the ledger as each read finished.
Holding a session to a fresh run found it: the two disagreed about nothing but
the order of two binary files. Past the ledger's cap of a hundred, the two could
also name different files. The ledger is now filled in walk order.

**A rule was blamed for another rule's binary file.** A plain run scans every
rule over one scope in a single pass, and the pass kept one ledger and one count
of unclassified files for all of them. A binary file holding one rule's symbol
was reported against every rule in the pass, with their matches added up.
`--strict` failed a rule over a file that did not hold its symbol, and a rule was
told its comments counted as code in files it never matched. The session
executes each rule alone and got it right; the plain run did not. Each pattern
now has its own ledger and its own count.

Both defects were in plain runs, and neither was visible to a test that runs a
tree once.

**A duration test that failed one run in 53.** It compared `check * 1000` with
its own rounding, which floating point misses for 4.057. CI hit it on one job
during this work.

### What building it changed

- **A `change` on a known directory evicts only the directory.** The proposal
  evicted beneath every path. See
  [Facts, evicted by events](#facts-evicted-by-events-and-re-read-with-early-cutoff).
- **A file's whole scan is memoised**, not its mask and its scans separately.
- **A later run that cannot be made is shown, not fatal.** The proposal named
  only the first run's refusal of specs outside the root.
- **A session with no spec yet keeps watching** rather than exiting.

### What watch mode cannot see

- **An event the operating system never delivers.** A lost event for a created,
  deleted or renamed entry is recovered by any later event naming its directory,
  or anything else in it, since either evicts the directory's listing. A lost
  event for a file whose contents changed is not recovered until that file is
  named again, or Enter is pressed. Neither is a directory replaced by one with
  the same names in it and reported only as a `change`, which Node's own contract
  for `rename` rules out. CI remains the authority; a session writes nothing and
  gates nothing.
- **Changes behind a symbolic link.** A path read through a link is evicted by
  events on the link, not on what it points to. The walk does not follow links
  already, so this touches only targets, `@assert-present` files and spec
  patterns that are links themselves.
- **Anything outside the root.** A spec pattern that matches a file outside the
  root makes `--watch` exit 2 and name the file on its first run, and shows the
  refusal on a later one, rather than watch everything but the rules.

### What it costs

- **Six modules stopped importing `node:fs`:** glob, engine, imports, runner,
  specs and mcp. `defaultDirectoryReader` and `statOrNull` left the API for
  `nodeIo`, `WalkOptions.readDirectory` became `WalkOptions.io`, and the tree
  index takes a whole door. That was churn through the most mutation-tested code
  in the repository. Each commit held the bar on the lines it changed before it
  was pushed: 100% for the door once two survivors were killed, and 100% for the
  configuration once five were killed by new tests and four constructs no input
  could tell apart from their mutants were removed. Watch mode's own lines came
  to 84% on their first sweep, with 83 mutants left: marker characters in the
  fingerprint that any other characters would do for, guards the scheduler
  checked twice, and plumbing nothing drove. The fingerprint became a serialised
  observation, the duplicate guards went, and tests were written for the rest.
  A second sweep left four, and they were killed too.
- **The whole package, on CI's full sweep of the watch commit: 98.83%** over
  7,538 mutants, against 98.74% for the commit before it and 0.8.0's 98.63%.
  `config.ts`, `facts.ts`, `io.ts` and `memo.ts` are at 100%. The full sweep
  found one survivor the scoped ones had not: the real clock's `clearTimeout`,
  which every scheduler test replaced with a fake. It has a test of its own now.
  The one survivor in `cli.ts` is `main`'s default `argv`, older than this ADR.
- **A session holds the contents of what its rules read**, measured above.
- **Rules run unbatched in a session.** A plain run's shared pass was, by the
  runner's own account, where most of its speed came from. In a session, facts
  and memos share that work instead, and the first run measured above is what
  it costs.
- **Injectable internals.** The session takes its fact policy, memo, identity and
  per-rule caches as options, and the fact cache its policy, so the equivalence
  test can build a session with one defect. Each defaults to the only
  implementation spec-guard uses.

### This repository

`package.json` gained `"specGuard": { "specs": ["docs/**/*.md", "README.md"] }`.
`selfcheck`, CI's own run and its SARIF upload now run `spec-guard` without
patterns, so all three read the same specs, and so does the MCP server an agent
starts here. The rule against runtime dependencies in ADR-0012 already reads
`package.json`, and is what keeps Chokidar out.

## Alternatives considered

**Chokidar.** It is a runtime dependency. Most of what it does is normalise event
noise, and eviction with early cutoff does not care about noise.

**Selecting rules with `governs`.** It is simple, and it misses the two
counterexamples in the Context and the spec edits. It also over-selects on every
Windows save, because each save reports its directory.

**Re-evaluating every rule, with facts and memos but no selection.** This is the
simplest design that is correct without recording dependencies. The run answered
from memory took 31 ms, and about half of that is work the memos remove. That
put it at the edge of the budget in this repository and past it in a bigger one.
It was the fallback had selection failed the equivalence test, which it did not.

**Trusting event types for more than `rename`, or timestamps.** The Windows table
shows duplicate events and `change` events on parent directories. Timestamps have
a granularity (two seconds on FAT, one on HFS+), and anything can set them.

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
