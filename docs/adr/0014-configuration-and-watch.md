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

**Amended 2026-09-26.** One normalised pattern was not yet one reading. ripgrep
still read braces, `.` segments and a lone `}` differently, and applied no
filter at all to a target named on its command line. Since then both engines
read every pattern as spec-core's glob engine does: the scanner through it, and
ripgrep through globs spelled from its reading, with its list held to the
scanner's filters. ADR-0015 has the shapes and the measurements.

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

The MCP server keeps parsed specs in the same memo, swept after every read of
the specs rather than after a run, so it holds the documents of the spec set
read last ([ADR-0012](0012-query-and-mcp.md)'s amendment of 2026-09-27).

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

## Amended 2026-10-07: the spec files a rule leaves out, named by a number

A rule is re-executed unless its resolved form is identical to last time, and
its resolved form holds the spec files the rule leaves out. A session told two
resolved forms apart by writing each out, spec files and all: every spec's
path, once for each rule, on every run, whether or not anything had changed.
0.18.1 took the same cost out of the search keys of a plain run, and left this
one to be measured.

It was measured over a synthetic repository of 1,500 specs with 422 rules in
force and 20,000 source files, and over the same doubled. The session read
through an `Io` that held each edit in memory, so nothing on disk changed
between runs. A CPU profile of the 25 runs after the first put a third of
their time in `identity`: 200 ms of each run, 57% of a run that found nothing
changed. The figures below are medians of seven, the two builds taken in turn,
on a Windows workstation busy with other work. The ratios are what they are
evidence of.

| A session's run after | 1,500 specs, before | after | 3,000 specs, before | after |
| --- | ---: | ---: | ---: | ---: |
| nothing changed | 384 ms | **91 ms** | 1,381 ms | **218 ms** |
| a save in `src` | 805 ms | **531 ms** | 2,036 ms | **1,001 ms** |
| an edit to an ADR's prose | 602 ms | **310 ms** | 1,809 ms | **807 ms** |

Twice the specs and rules took 3.6 times as long to find nothing changed
before, and 2.4 times after.

The spec files a run leaves out were already 0.18.1's sealed set (`sealPaths`
in `src/engine.ts`), and `identity` now names that set by its number, as a
search's key does. A number says what the paths said only while one set stands
for one list of paths from run to run, so the session keeps the set. Each run
still finds and reads the specs, and makes the set its rules would leave out;
where that holds the same paths as the last run's, the last run's set is the
one its rules are resolved with. The paths are compared once a run, not once
a rule.

- **Nothing is reused that was not reused before.** A spec added, removed or
  renamed makes a set of other paths, with a number of its own, and every rule
  that leaves the specs out executes again, as the Decision has it. So does
  `includeSpecs` turned on or off. A spec whose text changed and whose path did
  not changes no set, and never did: its directives are in the resolved forms,
  and its bytes among the facts.
- **The reports are the same.** Over the synthetic repository the first run, a
  run with nothing changed, one after a save and one after an edited ADR gave
  the JSON they gave before, byte for byte with durations taken out, 842 KB of
  it, and re-executed as many rules.
- **Tests.** `tests/watch-equivalence.test.ts` holds a run over 3,200 specs,
  one rule to each, to twice sixteen runs over 200, and 200 ms: a ratio, the
  two taken in turn, as spec-core's ADR-0007 states cost, and not timed when
  the code is instrumented. It holds a session to a fresh run after a spec is
  renamed, when as many are left out as before and not the same ones, and
  after the configuration starts searching the specs and stops again.

What the profile shows next is another cost, and it is left as it is: a batch
of events asks every fact the session holds whether an event names a
directory above it, 235 ms a batch over the 45,404 facts held here. It grows
with the facts, not with their square.




## Amended 2026-10-09: an option that is set and names nothing is refused

The family contract has a tool never fall back to defaults and report clean
(spec-core's
[ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
The command line did, for an option given a value that names nothing: it read
the option as left out, or as its opposite. Measured through the launcher on
0.20.1 (Windows 11, Node 24.18.1), in a tree of three specs, one of them
failing:

| Given | 0.20.1 | Now |
| --- | --- | --- |
| `--spec ""`, or `""` for a pattern, alone or beside a pattern, to any command | the root, so every Markdown file under it: three specs ran where one was named, exit 1, and `mcp` served them all | exit 2, `invalid spec pattern "": it is empty; write a file, a directory or a glob, or "." for every Markdown file under the root` |
| `--spec " "` beside a pattern that matched | dropped, exit 0 | the same refusal |
| `--root ""`, `--root=` | the working directory | exit 2, `Option --root expects a directory, got "". Name one, or leave the option out to run in the working directory.` |
| `--root` a file, or a path that is not there | "no spec files matched": exit 2, and exit 0 under `--allow-empty`; `cites` exit 0, nothing to look for; `mcp` started and served | exit 2, `the root <path> is not a directory. Give --root one that exists, or leave it out to run in the working directory.` |
| `--concurrency 0` | ran as 1 | exit 2, `Option --concurrency expects 1 or more: a concurrency of 0 would run no search.` |
| `--exclude ","` | cleared the configuration's list, as `--exclude=` does | exit 2, `Option --exclude names no path in ",". Give it paths or globs, or --exclude= with nothing to clear the list.` |
| `--strict=false`, `--default-skips=false`, `--allow-empty=false`, `--json=false`, `--color=never` | each on, what followed the `=` never read: strict, the default skips kept, an empty run let through, JSON written, colour | exit 2, `Option --strict takes no value, got "false". Give it alone or leave it out; an option a configuration can set has an opposite that turns it off, as --no-strict is to --strict.` |

`--root "$DIR"` and `--spec "$DOCS"` with the variable unset are how the first
rows are reached, and each answered a question nobody had put: a run in
another tree, or over every document. The table under Decision has had
`concurrency` as "an integer, 1 or more" for the key while the flag made 0
into 1.

- **Where each is refused.** What the parser can tell is a wrong invocation,
  answered as every one is: the line, a blank line, the help. An empty
  pattern is refused by `specPatternError`, which the command line asks
  before any command starts and the configuration asks of `specs`, in one
  line; `expandSpecPatterns` throws it, so `runSpecGuard`, `queryRules` and
  the rest of the package refuse it as well. The root is looked at once,
  after `--help` and `--version`, which answer wherever they are run, and
  before the configuration is read from it.
- **What nothing still means.** `--exclude=` clears the configuration's list,
  as this record has had it since 0.10.0, and whitespace alone is nothing.
  Separators with nothing between them are a list built from values that
  were not there, and that is what is refused.
- **A root is the command line's to refuse.** `runSpecGuard({ root })` from
  the package still reports no spec for a root that is not there, as it did:
  its caller chose the root, and reads the report.
- **Left as it is: a pattern that matches nothing beside one that matches.**
  `spec-guard "docs/**/*.md" README.md` in a tree with no `README.md` runs
  the specs under `docs` and says nothing of the other, on 0.20.1 and now.
  Refusing it would turn red every project that lists a place it has not
  written yet, which wants a decision of its own and a way to say a pattern
  may be empty.

**Colour.** The family reads the conventions one way (spec-core's ADR-0005),
and spec-guard is brought to it in two places. `FORCE_COLOR=0` turns colour
off on a terminal: it only declined to force colour, so a terminal kept it.
`TERM=dumb` turns colour off unless something forces it: it was not read for
colour, so a terminal that says it draws none was written escapes, as
measured on 0.20.1 through `main()` with a stream that says it is a terminal.
As before, `NO_COLOR` set to anything turns colour off and wins over
`FORCE_COLOR`, any other `FORCE_COLOR` forces it, either of the two set to
nothing is as unset, `CI` is not read, and `--color` and `--no-color` win
over all of them. Whether to draw glyphs on Windows is another question,
read from `WT_SESSION`, `TERM` and `TERM_PROGRAM`, and is as it was.
*Amended 2026-10-11*: it is read from `WT_SESSION` and `TERM_PROGRAM`, and
no longer from `TERM`, which the amendment of that date on what `TERM` says
has the reasons for.

<!-- @assert-absence target="src/cli.ts" symbol="Math.max(1, positiveInteger" reason="a concurrency of 0 is refused, as the configuration's key refuses it, and never made 1" -->
<!-- @assert-present file="tests/refused-inputs.test.ts" reason="each refusal is held beside the input that must still be read" -->

## Amended 2026-10-11: a spec pattern that matches no file is refused

The amendment of 2026-10-09 left one input that is set and names nothing as
it was: a pattern that matches no file beside one that does. It wanted "a
decision of its own and a way to say a pattern may be empty". This is the
decision, and the way is `--allow-empty`, which already said it of a whole
list.

A directory of specs that is renamed leaves its pattern behind. Every rule in
it stops running, and the run reports on the rest and exits 0: the green
check that verified nothing, which ADR-0007 refuses for a `target` that is
not there and for a scope that holds no file. ESLint and Prettier each make
a pattern that matches no file an error unless `--no-error-on-unmatched-pattern`
says otherwise; Biome's flag of the kind, `--no-errors-on-unmatched`, is for
a run in which no file was processed at all, by their documentation as read
on 2026-10-11. Measured
through the launcher on 0.21.0 (Windows 11, Node 24.18.1), in a tree with one
spec under `docs`. The pattern beside `docs/**/*.md` was a glob nothing fits,
a file that is not there, a directory that is not there or a directory that
holds no Markdown, written as an argument, as `--spec` or in `specs`, with
and without `--strict`, and each gave the one answer:

| Command | 0.21.0 | Now |
| --- | --- | --- |
| a run, `prove` | the report of the rest, exit 0, and no word of the pattern | exit 2 and one line; `--allow-empty` lets it through, and the line is said after the report |
| the same, as `--json`, `--format sarif` or `--format gitlab` | the document of the rest, exit 0 | the same document, the line on stderr, exit 2; the JSON ones name the patterns in `unmatchedSpecs` |
| `impact` | the dependents and the rules of the rest, exit 0 | the same written, then the line, exit 2; exit 0 under `--allow-empty` |
| `query` | the rules of the rest, exit 0 | exit 2 and the line; `--json` still writes its document, with `unmatchedSpecs` |
| `--watch` | the report of the rest | the same, and under it which pattern the session is waiting on |
| `mcp` | every answer from the rest | the same, each ending in a note that names the pattern, with `unmatchedSpecs` in the structured content and in `spec://rules` |

```text
spec-guard: the pattern "old-docs" matched no spec file. Remove it from "specs" in package.json, or give --allow-empty where a pattern is meant to match nothing.
```

- **Each pattern is held to what the list was held to.** Where no spec at all
  is exit 2, one pattern that matched none is exit 2. Where `--allow-empty`
  lets the first through, it lets the second through, and the pattern is
  still named on stderr. Where a command carries on because a file may yet
  appear, a watch session and the server, it carries on and says which
  pattern it is. `--strict` changes none of it, and `--allow-empty-scope` is
  about a rule's scope, not a run's specs.
- **Only a pattern somebody wrote is refused.** `docs/**/*.md`, read when
  none is given, is alone: it matches, or there is no spec at all, which
  every command answers as it did, `no spec files matched ...`. A pattern
  matched when it found a file, though another pattern found the same one:
  `docs` beside `docs/adr/0001.md` names nothing in vain.
- **A person is told in the line alone, and a script is still handed its
  document.** As with no spec at all, the report and GitHub's commands give
  way to the line, since "every spec assertion holds" over the rest is the
  claim being refused, and `--print-baseline` prints nothing for a run it
  refuses. JSON, SARIF and GitLab are written as the run made them, and the
  exit code is what says the answer is not to be trusted. `impact` writes its
  dependents first, as it does with no spec at all, since no spec decides
  them.
- **`unmatchedSpecs` is a field added**, to the JSON of a run, `prove`,
  `query` and `impact`, to the server's structured answers and to
  `spec://rules`: the patterns as written, in the order given, each once. It
  is there only when a pattern matched no file, no spec at all included, so
  the document of a run whose every pattern matched is what it was.
  `formatVersion` stays 1 in each: a field removed or renamed moves it, and a
  field added does not.
- **`query` has no way through.** It takes no `--allow-empty`, as it never
  did for no spec at all, so a configuration that keeps a pattern for a place
  nothing is written in yet makes every query exit 2 while the run beside it
  passes under `--allow-empty`. spec-harness asks
  `spec-guard query <paths> --json` for its context packet. Measured with
  spec-harness 0.12.0 and this build installed side by side, `specs` holding
  `docs/**/*.md` and a pattern that matches nothing: `context`, and
  `start_round` from its server, still exit 0 and write the packet, whose
  rules section reads "The rules spec-guard holds this code to could not be
  read: spec-guard exited 2: the pattern ... matched no spec file", where it
  listed the rules under `docs`. `guard`, `hook claude`, `hook git`, `audit`
  and `premises` answer as before: the first three ask spec-guard nothing,
  and the last two name a brief's own file as the pattern, which replaces
  `specs`. No hook holds a write over it.
- **Left as it is: `cites`.** With no spec at all it exits 0 and notes that
  there was nothing to look for, 1 under `--strict` (ADR-0017), so there is
  no refusal there for one pattern to be held to. It reads the patterns for
  the families it derives, and a pattern that matches nothing beside one that
  matches still drops its family without a word: citations of it are not
  looked for. What `cites` says of such a pattern wants a decision of its
  own.

  *Amended again 2026-10-11*: that decision is
  [ADR-0017](0017-citations-in-comments.md)'s amendment of this date, and
  `cites` is no longer as it was. It names such a pattern on stderr after
  its report, in the words above, and its `--json` carries the patterns as
  `unmatchedSpecs`, there only beside a spec that matched: with no spec at
  all its document is the one it was. Held to what the list is held to, it
  goes on, exit 0, and a strict check exits 1 where the families were read
  off the specs. Where `cites` names them, no spec at all passes a strict
  check, and so does one pattern that matched none.
- **Where it is decided.** `expandSpecs` in `src/glob.ts` returns the
  patterns that matched no file beside the files, `readSpecs` carries them on
  the spec set as `unmatched`, and each report carries them as
  `unmatchedSpecs`. `runSpecGuard`, `proveSpecGuard`, `queryRules` and
  `impactOf` from the package report them and refuse nothing: their caller
  reads the report. The command line refuses, in `src/cli.ts`.

**Colour.** `FORCE_COLOR=false` turns colour off, where it forced it on. The
amendment above had "any other `FORCE_COLOR` forces it", and Node and
`supports-color` read `false` as off, so a pipeline that set it to keep
escapes out of a log got them. The family reads it one way (spec-core's
ADR-0005): `FORCE_COLOR` is off when it is exactly `0` or exactly `false`, on
a terminal too; set to nothing it is as unset; and any other value forces
colour, `FALSE`, `no` and `true` among them. Nothing else about colour
changes.

<!-- @assert-present file="tests/unmatched-specs.test.ts" reason="each command's answer to a pattern that matches no file is held beside the run that must not be refused" -->

## Amended 2026-10-11: `TERM` is no sign of a terminal that draws the marks

On Windows a report's marks are drawn in ASCII - `+`, `x`, `!`, `o` and `...`
for `✔`, `✖`, `⚠`, `○` and `…` - unless the terminal says it draws them.
Any of `WT_SESSION`, `TERM` and `TERM_PROGRAM` was read as saying so. `TERM`
does not say it: the programs below set it for whatever they start, by the
version of Windows and not by what the output is drawn on. Each was read in
its source on 2026-10-11, on the branch named.

| Program | What it sets | Where it was read |
| --- | --- | --- |
| Git for Windows | in its own environment, which every process it starts is given: `TERM`, when it is not set, `cygwin` before Windows build 15063 and from it `xterm-256color` with `COLORTERM=truecolor` | `setup_windows_environment()` in `compat/mingw.c`, git-for-windows/git, `main` |
| The Cygwin runtime, and MSYS2's | for every program built on it: `TERM`, when Windows' environment holds none, `xterm-256color` where `wincap.has_con_24bit_colors()`, which the build number alone decides, 15063 and later, and `cygwin` before it | `win32env_to_cygenv()` in `winsup/cygwin/environ.cc` and `wincapc::init()` in `winsup/cygwin/wincap.cc`, cygwin/cygwin, `main`; the same lines of `environ.cc` in msys2/msys2-runtime at e0c179b |
| mintty | for the shell it starts: `TERM` from its configuration, and `TERM_PROGRAM=mintty` | `child_create()` in `src/child.c`, and `APPNAME` in `src/appinfo.h`, mintty/mintty, `master` |
| Windows Terminal | for the program in a tab: `WT_SESSION` and `WT_PROFILE_ID`, and in that function no `TERM` and no `TERM_PROGRAM` | `ConptyConnection::_LaunchAttachedClient()` in `src/cascadia/TerminalConnection/ConptyConnection.cpp`, microsoft/terminal, `main` |
| VS Code's terminal | for the shell it starts: `TERM_PROGRAM=vscode` and `COLORTERM=truecolor`, on every platform | `addTerminalEnvironmentKeys()` in `src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts`, microsoft/vscode, `main` |
| OpenSSH's server on Windows | for a session: `TERM`, as the client's request for a terminal named it | `session_pty_req()` and `do_setup_env()` in `session.c`, applied by `setup_session_env()` in `contrib/win32/win32compat/w32-doexec.c`, PowerShell/openssh-portable, `latestw_all` |

Measured on Windows 11 build 26300 with git 2.55.0.windows.5 and Node
24.18.1, none of the three variables set: a process PowerShell starts has
none of them; one that git starts with no shell between, an alias written
`!node`, has `TERM=xterm-256color`; and so has a pre-commit hook of a
`git commit` started from cmd.exe. Neither has `WT_SESSION` or
`TERM_PROGRAM`.

The marks are not in the fonts a console is set in. Read from each font's
character map on the same machine, Consolas 7.01, Lucida Console 5.01,
Courier New 6.95 and Cascadia Mono 2102.025 each hold `○` (U+25CB), `…`
(U+2026) and `·` (U+00B7), and none holds `✔` (U+2714), `✖` (U+2716) or `⚠`
(U+26A0), which Segoe UI Symbol holds. A terminal draws those three from
another font or not at all. The console host's GDI renderer drew text with
`PolyTextOutW`, which substitutes no glyph a font is missing, until
microsoft/terminal#10478 replaced the call (merged 2021-06-22); which builds
of Windows carry that was not established, so a console that is not known to
be one of the terminals above is taken not to draw them.

Through the launcher on that machine, over a tree with a rule that holds, one
that fails, a document not in force, a stale citation and a ghost. Between
them a run, `prove` and `cites` drew `✔`, `✖`, `⚠` and `○` where the table
says the marks, and `+`, `x`, `!` and `o` where it says ASCII, and the three
agreed in every row; the row with git in it was measured for a run:

| Environment | 0.22.0 | Now |
| --- | --- | --- |
| none of the three set | ASCII | ASCII |
| `TERM=xterm-256color`, `TERM=cygwin` or `TERM=dumb`, alone | the marks | ASCII |
| a run that git starts, and one in a pre-commit hook of a commit started from cmd.exe, none of the three set before git | the marks | ASCII |
| `WT_SESSION` set | the marks | the marks |
| `TERM_PROGRAM=vscode`; `TERM_PROGRAM=mintty` beside `TERM=xterm` | the marks | the marks |
| `WT_SESSION` and `TERM_PROGRAM` set to nothing | ASCII | ASCII |
| `WT_SESSION` set to nothing beside `TERM=xterm-256color` | the marks | ASCII |

- **`WT_SESSION` or `TERM_PROGRAM`, set to something, draws the marks; `TERM`
  decides nothing.** Either set to nothing is as unset, as it was. spec-graph
  reads the same two (`shouldUseAscii` in its `src/report.ts`).
- **What it costs is a terminal known by `TERM` alone**, which is now drawn
  ASCII: an ssh session into Windows is the one found, whose `TERM` is the
  client's and says what the client draws. ASCII where the marks could have
  been drawn is a plainer report; the marks where they cannot be drawn are
  boxes in place of what passed and what failed.
- **Nothing asks for either set outright.** spec-guard has no option and no
  variable of its own for it, where spec-graph has `--ascii` and
  `SPEC_GRAPH_ASCII` for ASCII and nothing for the marks. That is left as it
  is.
- **Anywhere but Windows the marks are always drawn**, with a `TERM` as
  without one, and colour reads `TERM=dumb` as it did.

<!-- @assert-count target="src/reporter.ts" symbol="env['TERM']" expected="1" reason="TERM is read once, for colour, where dumb turns it off, and never for whether the marks are drawn" -->

## Amended 2026-10-12: the marks can be asked for outright

The amendment of 2026-10-11 ends "Nothing asks for either set outright ...
That is left as it is." It is taken back here. Since that amendment the
marks on Windows follow `WT_SESSION` and `TERM_PROGRAM`, and a person whose
terminal is neither has no say: an ssh session into Windows, the case that
amendment names as its cost, is drawn `+ x ! o` whatever the terminal at the
other end draws. And nothing anywhere asked for ASCII, for a log a tool
reads or a font that holds none of the marks.

`--ascii` draws the ASCII marks and `--no-ascii` the others, on any
platform, and either wins over everything the environment says.
`SPEC_GUARD_ASCII` asks for ASCII, and an option wins over it.

Through the launcher on Windows 11 build 26300, Node 24.18.1, over a tree
with a rule that holds, one that fails, a stale citation and a ghost. A run
with `--verbose`, `prove` and `cites` agreed in every row but the refusals,
which are each command's own:

| Asked | 0.23.0 | Now |
| --- | --- | --- |
| nothing, in a console that names no terminal | ASCII | ASCII |
| nothing, `WT_SESSION` set | the marks | the marks |
| `--ascii`, `WT_SESSION` set | exit 2, `Unknown option "--ascii"` | ASCII |
| `--no-ascii`, in a console that names no terminal | exit 2, `Unknown option "--no-ascii"` | the marks |
| `SPEC_GUARD_ASCII=1` or `=no`, `WT_SESSION` set | the marks | ASCII |
| `SPEC_GUARD_ASCII` set to `0`, `false`, `FALSE`, nothing or a space, `WT_SESSION` set | the marks | the marks |
| `SPEC_GUARD_ASCII=0`, in a console that names no terminal | ASCII | ASCII |
| `--no-ascii`, `SPEC_GUARD_ASCII=1` | exit 2 | the marks |
| `--ascii`, `SPEC_GUARD_ASCII=0`, `WT_SESSION` set | exit 2 | ASCII |
| `--ascii --no-ascii`, in either order | exit 2, unknown option | exit 2: `Option --ascii is given beside --no-ascii, and the marks are drawn one way or the other. Give one of the two.` |
| `query` or `impact` with `--ascii` | exit 2, unknown option | the answer it gives without it |
| `query` or `impact` with `--no-ascii` | exit 2, unknown option | exit 2: `Option --no-ascii does not apply to spec-guard query.` |
| `mcp` with either | exit 2, unknown option | exit 2: `does not apply to spec-guard mcp` |
| a run as `--json`, `sarif`, `github` or `gitlab` with either | exit 2, unknown option | the document it writes without it |

- **The order is the option, then the variable, then the terminal.**
  `--ascii` or `--no-ascii` decides alone. Without either,
  `SPEC_GUARD_ASCII` asks for ASCII on any platform. Without that, Windows
  decides by `WT_SESSION` and `TERM_PROGRAM` as the amendment of 2026-10-11
  has it, and anywhere else the marks are drawn.
- **`SPEC_GUARD_ASCII` is read as spec-graph reads `SPEC_GRAPH_ASCII`**
  (`shouldUseAscii` in its `src/report.ts`, at 11e2895): set to anything but
  nothing, `0` or `false` it asks, and those three, with white space around
  them and in any case, do not, since each is how a script writes "off". So
  `no` and `off` ask. It asks for ASCII only: `SPEC_GUARD_ASCII=0` is not a
  request for the marks, and a console that names no terminal is still
  drawn ASCII under it. The marks are asked for with `--no-ascii`.
- **The two options together are refused**, exit 2, in either order, where
  the last of `--color` and `--no-color` wins and says nothing of the other.
  A line that asks for both ways was not meant, and one of the two would go
  unread; spec-brief refuses `--color` beside `--no-color` for that reason
  (`unread` in its `src/cli.ts`, at faa9cf6). The colour pair here is left
  as it is. *Amended again 2026-10-12*: it is not left. Every option
  beside its own opposite is refused, the colour pair among them, by the
  amendment below.
- **A command that draws marks takes both; one that draws none is treated
  as it is for colour.** A run, a watch session, `prove` and `cites` draw
  them and take both. A query and `impact` draw none: `--ascii` is true of
  what they write already and is what a script passes to every command it
  runs, so it is taken, as `--no-color` is; `--no-ascii` would promise marks
  neither draws, and is refused, as `--color` is. The server takes neither,
  as it takes neither of the colour pair. So `--ascii` stands to
  `--no-color`, and `--no-ascii` to `--color`.
- **A format that draws no mark takes both and changes nothing**: `--json`,
  `sarif`, `github` and `gitlab` write the document they wrote, as they do
  with `--color`.
- **Neither is a configuration key.** How a report is drawn is the
  terminal's and the person's, as colour is, and `specGuard` holds what a
  run checks.
- **What is drawn in ASCII is the five marks**, `+`, `x`, `!`, `o` and `...`
  for `✔`, `✖`, `⚠`, `○` and `…`. The `·` between a report's counts is no
  mark and is written either way, as it was on a Windows console before:
  the fonts the amendment of 2026-10-11 read each hold it. *Amended again
  2026-10-12*: a report asked for in ASCII holds neither that nor the `…`
  of a cut snippet, by the amendment below.
- **`shouldUseAscii(env, platform)` reads the variable and keeps its two
  parameters**, since it is exported and a caller passes it an environment.
  The command line reads its options first and asks the function only when
  neither was given.

`tests/reporter-contracts.test.ts` holds the variable's reading beside the
values that must not ask, `tests/cli.test.ts` each command's taking and
refusing, and `tests/refused-inputs.test.ts` and `tests/watch.test.ts` what
each command then draws, with a terminal or the variable named in every
case so that each is one answer on Windows and anywhere else.

## Amended 2026-10-12: an option beside its own opposite is refused, and a report asked for in ASCII is ASCII

The amendment above refused `--ascii` beside `--no-ascii` and left the
colour pair as it was. The family contract refuses two things of which one
would go unread (spec-core's
[ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
amended 2026-10-11), and the colour pair is two such things. So is each
on/off option this ADR gave an opposite, so that a configuration could be
overridden either way.

Measured through the launcher on 0.24.0 (Windows 11 build 26300, Node
24.18.1): each of the eight pairs the command line has, in a tree where the
option decides what the command answers, the two given together in each
order to a run, a watch session, `prove`, `cites`, `query`, `impact` and
the server. "As the later alone" is the exit code and the output of the
later option given alone, with no word of the earlier.

| Pair | Commands that take both | 0.24.0, in either order | Now, in either order |
| --- | --- | --- | --- |
| `--strict`, `--no-strict` | a run, `--watch`, `prove`, `cites`, `mcp` | as the later alone | exit 2 |
| `--allow-missing-targets`, `--no-allow-missing-targets` | a run, `--watch`, `prove`, `mcp` | as the later alone | exit 2 |
| `--allow-empty-scope`, `--no-allow-empty-scope` | a run, `--watch`, `prove`, `mcp` | as the later alone | exit 2 |
| `--default-skips`, `--no-default-skips` | a run, `--watch`, `prove`, `cites`, `query`, `impact`, `mcp` | as the later alone | exit 2 |
| `--ignore-status`, `--no-ignore-status` | a run, `--watch`, `prove`, `query`, `impact`, `mcp` | as the later alone | exit 2 |
| `--include-specs`, `--no-include-specs` | a run, `--watch`, `prove`, `query`, `impact`, `mcp` | as the later alone | exit 2 |
| `--color`, `--no-color` | a run, `--watch`, `prove`, `cites` | as the later alone | exit 2 |
| `--ascii`, `--no-ascii` | a run, `--watch`, `prove`, `cites` | exit 2, in a line of its own | exit 2, in the line every pair has |

```text
spec-guard: Option --strict is given beside --no-strict, and one of the two would go unread. Give one of the two.
```

- **One rule, and no list of pairs.** An option whose name is another's
  with `no-` after its dashes is that option's opposite, and the two on one
  command line are refused. The eight pairs above are the ones there are:
  `--no-verbose`, `--no-json`, `--no-allow-empty` and the like are unknown
  options, as they were. A pair added later is refused without being added
  anywhere else.
- **The option is named before its opposite, whichever came first.**
  `--ascii` beside `--no-ascii` said "and the marks are drawn one way or
  the other"; it now says what the others say, since the reason is the one
  they have.
- **A command that takes only one of a pair refuses the other for that, as
  it did**, before it looks at the pair. `query --no-color --color` is
  `Option --color does not apply to spec-guard query.`, and `mcp`, which
  takes neither of the colour pair, names whichever comes first. In the 16
  places where a command does not take both of a pair, each order was
  answered on this build in the line 0.24.0 wrote.
- **The same option given twice is read as once**, as it was, for each
  option of each pair on each command that takes it.
- **An opposite alone still overrides a configuration**, which is what it
  was added for. Measured for each of the six keys, set `true` and set
  `false`, on each command: where the command reads the key the answer is
  the option's and the report says `overridden on the command line:
  strict`, and each of those runs answers on this build as it did on
  0.24.0.
- **A refused pair is refused before `--help` and `--version` are
  answered**, as every wrong command line is here: `--bogus --help` is
  exit 2, and so was `--ascii --no-ascii --help`. `--color --no-color
  --help` printed the help on 0.24.0 and is refused now. spec-graph answers
  the two first (`parseArgs` in its `src/cli.ts`, at 70bdd90).
- **Left as they are**, each two things of which one goes unread, and
  neither the other's opposite: `--json` beside `--format sarif` writes
  whichever came later, `--format` given twice writes the later, and
  `--exclude=` beside `--exclude dist` clears nothing. Whether those are
  refused wants a decision of its own. *Amended 2026-10-14*: the first two
  are refused, and the third is taken, by the amendment of that date below.

**A report asked for in ASCII is ASCII.** The amendment above has "The `·`
between a report's counts is no mark and is written either way". Measured
on 0.24.0 through the launcher, over a tree that is ASCII throughout, so
that a character beyond ASCII in an output is the report's own: every such
character each command wrote when it was asked for ASCII.

| Written by | 0.24.0, under `--ascii` | Now |
| --- | --- | --- |
| a run, `--verbose` | `·` (U+00B7) between the counts of its first line and of its last; `…` (U+2026) where a line longer than 200 characters is cut for a snippet | none: ` - ` and `...` |
| `prove`, `--verbose` | `·` in the same two lines | none |
| `cites` | `·` between its counts | none |
| a watch session | `·` in each report, in each status line and under a run that could not be made; `…` in a cut snippet | none |
| `query`, `impact` | none | none |
| the text of the server's `check_architecture`, which asks for its report in ASCII | `·` and `…`, beside `+`, `x`, `!` and `o` | none |
| `--json`, `--format sarif`, and the server's structured content | `…` at the end of a cut snippet's `text` | the same: each document is what it was |
| `--format github`, `--format gitlab` | none | none |

A run asked by `SPEC_GUARD_ASCII=1`, and one in a console that names no
terminal, wrote what the run under `--ascii` wrote, on 0.24.0 and on this
build.

- **ASCII is one answer, whoever gave it**: the option, the variable, or a
  Windows console that names no terminal. So the report of such a console
  changes as well, `1 passed - 7ms` where it read `1 passed · 7ms`. The
  fonts the amendment of 2026-10-11 read each hold `·` and `…`, and what
  reads a report is not always a font: written to a pipe a report is
  UTF-8, and read back in code page 950, which `chcp` names on the
  workstation this was measured on, the two bytes of `·` are `繚`
  (U+7E5A) and the three of `…` are no character of that page.
- **What a project wrote is written as it wrote it**: a path, a line of
  source in a snippet, a `reason`, a status. ASCII is asked of the report,
  and a report that redrew a line of source would show a line the file
  does not hold.
- **A cut line is known by its length.** A snippet is a line cut to 200
  characters and ended with the mark, so only a cut line's is 201 long,
  and a line that fits and ends in an ellipsis of its own is left alone.
  The mark is asked for as well as the length, since the matches of an
  import rule, a layer rule, a cycle and a structure rule are written by
  the runner, at any length. `wasCut` in `src/text.ts` is that rule,
  beside the length and the mark the engine cuts with.
- **`ascii` means the same to a caller of the package**: `formatReport`,
  `formatProve` and `formatCites` given `ascii: true` write no character
  of their own beyond ASCII.
- **spec-graph writes `-` between its counts in ASCII too** (`glyphs` in
  its `src/report.ts`, at 70bdd90).

`tests/opposites.test.ts` holds each pair on each command that takes both,
beside either alone, either twice and each opposite over a configuration.
`tests/ascii-report.test.ts` holds each report to ASCII, beside the line
that must be left as it was written.

<!-- @assert-present file="tests/opposites.test.ts, tests/ascii-report.test.ts" reason="each refusal is held beside what must still be read, and each report in ASCII beside the line a project wrote" -->
<!-- @assert-count target="src" symbol="·" expected="1" exclude="src/vendor" reason="what separates a report's counts is written once, in the table that says what stands for it in ASCII" -->
<!-- @assert-count target="src" symbol="…" expected="1" exclude="src/vendor" reason="the mark of what a report leaves out is written once, and drawn through the same table" -->

## Amended 2026-10-14: an option given two values is refused, and so are two formats asked for at once

The amendment above left three things as they were, each two things of
which one goes unread, and said that refusing them wanted a decision of its
own. This is that decision, for those three and for every option like them.
The family contract refuses two things of which one would go unread
(spec-core's
[ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
amended 2026-10-11). An option that takes one value and is given two is
that: the later was read, and no word was said of the earlier.

Measured through the launcher on 0.25.0 (Windows 11 build 26300, Node
24.18.1), over a tree with a rule that holds and one that fails, beside a
tree whose one rule holds: each option of each command given twice with one
value, twice with two, and beside each option that asks for the same thing
another way, the two in each order. "As the later alone" is the exit code
and the output of the later given alone, with no word of the earlier.

| Given | To | 0.25.0, in either order | Now |
| --- | --- | --- | --- |
| `--format` twice, with two formats | a run, `prove` and `cites`; `query` and `impact`, which write two | as the later alone | exit 2 |
| `--json` beside `--format sarif`, `github`, `gitlab` or `human` | the same commands | as the later alone: `--json --format sarif` wrote SARIF, and `--format sarif --json` wrote JSON | exit 2 |
| `--root` twice, or `-r` beside it, with two directories | a run, a watch session, `prove`, `cites`, `query`, `impact` and the server | as the later alone: the rules of the later root, and nothing read of the earlier | exit 2 |
| `--engine` twice, with two engines | a run | as the later alone, by the `engine` of its JSON | exit 2 |
| `--max-snippets` twice, with two numbers | a run | as the later alone | exit 2 |
| `--depth` twice, with two numbers | `impact` | as the later alone | exit 2 |
| `--concurrency` twice, with two numbers | a run | the report of either alone, which shows no concurrency | exit 2 |
| the same value twice, however it is spelled: `--format JSON --format json`, `--root t --root t/`, `--max-snippets 3 --max-snippets 03` | each command that takes the option | as once | as once |
| `--json` beside `--format json`, and `--json` twice | a run, `prove`, `cites`, `query`, `impact` | JSON | JSON |
| `--spec` twice, and a pattern beside `--spec` | a run, `prove`, `query` | every pattern read | the same |
| `--exclude` twice | a run | both lists, and `exclude (src, src)` where one path is given twice | the same |
| `--exclude=` beside `--exclude src`, over `"exclude": ["gen"]` in the configuration | a run | as `--exclude src` alone, in either order | the same |
| an option that takes no value given twice, and `-v` beside `--verbose` | a run | as once | as once |

Where no output shows the value, `--concurrency` anywhere and `--engine` and
`--max-snippets` given to the server, what 0.25.0 read is what its
`parseArgs` returns: the later.

```text
spec-guard: Option --json is given beside --format "sarif", and one of the two would go unread. Give one of the two.
```

- **What is compared is what was read.** `--root .` and `--root ./` name
  one directory, `--format JSON` is `json`, `--engine js` and `--engine
  node` are one engine, and `03` is 3: each asks for one thing twice and is
  taken, as the same option given twice is. Nothing is asked of the disk
  before a line is refused, so two spellings that resolve to two paths are
  two values, `--root Docs` beside `--root docs` among them where the file
  system ignores case.
- **Each is named as it was written, in the order the two were given**, the
  value in quotes as JSON writes it, where a blank in it can be seen. An
  option beside its own opposite is named option first, whichever came
  first; of two values neither is the one that turns something on.
- **`--json` is `--format json`**, as the option table has had it since
  `--format` was added. Beside `--format json` it is one thing asked twice,
  and is taken. Beside another format it is two formats, of which a script
  was handed the later.
- **A list stays a list.** `--spec`, a pattern and `--exclude` each add to
  what was given before, and a pattern or a path given twice is in its list
  twice, which changes no answer. `--exclude=` beside `--exclude dist`,
  which the amendment above counted among the things that go unread, is
  taken, since neither does: the configuration's list is replaced, which is
  what `--exclude=` asks, and `dist` is left out, which is what the other
  asks.
- **A line is refused for what is wrong with one option before what is
  wrong between two.** A value refused by itself (`--format yaml`,
  `--concurrency 0`), an unknown option and an option the command does not
  take are refused where they stand, as they were; then an option beside
  its own opposite; then two values; then what a watch session does not
  take.
- **A line with two values is refused before `--help` and `--version` are
  answered, as a line with a pair is**, by the amendment above: the two
  refusals are one rule, since each is a wrong command line, and one tool
  does not answer the two first for some wrong lines and after others. So
  `--json --format sarif --help` printed the help on 0.25.0 and is exit 2,
  and a line that asks one thing twice, which is no wrong line, is still
  answered with the help.
- **`--print-baseline` beside `--json` or a `--format` is taken, as 0.22.0
  decided.** A script passes a run's format to every command it runs, and
  an option that asks a command for what it never does is taken (spec-core's
  ADR-0005); `tests/unmatched-specs.test.ts` has held since 0.22.0 that a
  baseline is text to paste whatever format the run was asked for. So the
  baselines are printed and no document, as on 0.25.0, and where no spec
  matched the document is written and no baseline.
- **Left as they are**, each measured on 0.25.0 and on this build, and each
  one thing that goes unread beside another that is no second value for it.
  `--help` beside `--version` prints the help, in either order, and no
  version. *Amended 2026-10-18*: it is refused, by the amendment below. `--verbose` beside `--json` or `--format github` writes the
  document either writes without it, and `--verbose` and `--max-snippets`
  change nothing `--print-baseline` prints.

`tests/two-values.test.ts` holds each refusal on each command that takes the
option, beside the same value given twice, one thing spelled two ways and
each list, and holds a line with two values, and one with a pair, to its
refusal with `--help` or `--version` on it.

<!-- @assert-present file="tests/two-values.test.ts" reason="each refusal is held beside the value given twice, the list and the help that must still be read" -->

## Amended 2026-10-18: `--help` beside `--version` is refused

The amendment above left `--help` beside `--version` as it was. The family
contract, amended on this date, decides it: the two ask for two answers of
which one would go unread, and the line is refused, exit 2, with a line that
names both (spec-core's
[ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
*Runs*, amended 2026-10-18).

Measured through the launcher on 0.26.0 (Windows 11 build 26300, Node
24.18.1), in a tree of one spec that holds:

| Given | 0.26.0 | Now |
| --- | --- | --- |
| `--help --version`, `--version --help`, `-h --version` or `--version -h`, to a run, a watch session, `prove`, `cites`, `query`, `impact` and the server | the help, exit 0 | exit 2 and one line, the two named as they were written, in the order given |
| the same beside `--json`, or beside a `--root` that is not there | the help, exit 0 | the same refusal |
| `--help` or `--version` alone, given twice, or `-h` beside `--help` | its answer, exit 0 | the same |
| beside an unknown option, or an option beside its own opposite | the line for that | the same |
| beside `--root a --root b` | the line for `--root` | the line for whichever of the two came first |

```text
spec-guard: Option --help is given beside --version, and one of the two would go unread. Give one of the two.
```

- **The two are one thing asked for, the line's answer**, and are read as the
  two values of an option that takes one, by the same code: given twice, or
  `-h` beside `--help`, the one answer is asked for once, and given. So the
  line is refused after what is wrong with one option and after a pair, in
  the place two values are, and before what a watch session does not take;
  and of two such things on one line, the first is named.
- **Either alone is answered as before**: before the root is looked at and
  before the configuration is read, wherever on the line it stands.
- spec-graph printed the help, and spec-brief and spec-harness the version,
  by the contract's measurement.

`tests/two-values.test.ts` holds each order on each command, beside each
alone, twice, and beside its other spelling.
