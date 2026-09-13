# ADR-0013: Structural and naming assertions

## Status

Accepted.

Proposed first, with every example in a fence: ADR-0010 validates the directives
of a document that is not in force, so a live `@assert-structure` would have
been an unknown-directive error until the kind existed. The examples about other
codebases stay in fences. The rules about this one are live, under
[What this repository asserts](#what-this-repository-asserts).

## Context

`@assert-present` names files one by one. Architecture documents rarely do. They
state conventions over sets of files:

1. *All domain entity files in `src/domain/` match `*.entity.ts`.*
2. *Every package under `packages/*` contains a `README.md` and a `package.json`.*
3. *No handler in `src/handlers/` exists without a matching `*.test.ts`.*

These look like one feature and are three different questions. Each one counts
a different thing:

| Claim | The rule is about | A violation is |
| --- | --- | --- |
| naming | files in scope | a file whose name matches no allowed pattern |
| required entries | directories in scope | a directory missing an entry it must have |
| partners | files in scope | a file whose partner does not exist |

Two traps decide the design more than the grammar does.

**The partner grammar can balloon.** "The partner of `src/user.handler.ts`" is a
transformation of a name. The obvious generalisation is a regular expression with
a substitution. Once a directive holds a substitution engine, reviewing it means
running it in your head, and a rule nobody can read is a rule nobody will notice
has gone wrong.

**A structural rule passes vacuously in more ways than a text rule does.**
- An empty directory has no misnamed files.
- A glob that selects no packages has no package missing a README.
- A partner template that expands to the file itself is satisfied by every file.

Each of those is a green result that checked nothing. ADR-0012's fix for missing
targets was the same lesson: nothing inspected is a failure, not a pass.

## Decision

### One directive, and exactly one claim per directive

`@assert-structure` takes exactly one of `pattern`, `required` or `partner`.
Naming two of them in one directive is an error.

One directive rather than three, because the three share everything but the
question: `target`, `exclude`, `glob`, the empty-scope rule, bounds, baselines
and the report. Exactly one claim per directive, because each claim counts a
different unit. A directive counting misnamed files and directories missing a
README in one number would report a count that means neither.

`@assert-present` is not extended with globs. "These paths exist" and "every
path of this shape has something" are different claims. Folding the second into
the first would change what an existing `file="..."` means.

### Naming: `pattern`

```md
<!-- @assert-structure target="src/domain" glob="*.ts" exclude="*.test.ts" pattern="*.entity.ts, index.ts" -->
```

Every file in scope must match at least one pattern. The patterns speak the
language `glob=` already speaks: without a `/` a pattern matches the base name,
with one it matches the path from the root. `glob` narrows which files the rule
applies to; `pattern` says what they must be called. Rules that forbid names
have no attribute of their own: an allow-list forbids everything it does not
list.

A violation is the file, reported as `src/domain/user.ts  matches none of
*.entity.ts, index.ts`.

### Required entries: `required`, and `dirs` to choose the directories

```md
<!-- @assert-structure target="packages" dirs="*" required="package.json, README.md" -->
<!-- @assert-structure target="services" dirs="**" exclude="shared" required="Dockerfile, src/" -->
<!-- @assert-structure target="." required="LICENSE, SECURITY.md" -->
```

Without `dirs`, the rule is about the target directories themselves. With it,
`dirs` is a glob matched against the paths of directories below the target:
`*` means the immediate children and `**` means every directory at any depth.
The target itself is never selected by `dirs`; leave `dirs` out for that.
`exclude` removes directories as it removes files.

Each entry in `required` is a path relative to the directory:
- its last segment may be a glob (`*.csproj`), in which case at least one match
  satisfies it, and no other segment may be;
- a trailing `/` means the entry must be a directory, and without one it must be
  a file. `required="README.md"` is not satisfied by a directory of that name.

A violation is the directory, reported with every entry it lacks:
`packages/billing  missing README.md`.

A `required` target that is a file fails, whatever `--allow-missing-targets`
says. A file holds nothing, and a rule that quietly skipped it would be a rule
about one directory fewer than it names.

**Directories are enumerated, not inferred from files.** Deriving directories
from the files a walk finds is cheaper, and it cannot see an empty directory. An
empty package is the purest case of a package missing its `package.json`.

**Names are compared as listed, on every platform.** Existence is decided by
reading the directory and comparing names exactly, never by `stat`. A `stat` for
`README.md` succeeds on Windows and macOS when the file is `Readme.md`, and fails
on Linux. The same rule would then pass on a developer's laptop and fail in CI,
and a structural rule exists to be the same everywhere.

### Partners: `partner`, with three placeholders and nothing else

```md
<!-- @assert-structure target="src/handlers" glob="*.ts" exclude="*.test.ts" partner="[name].test.ts" -->
<!-- @assert-structure target="src" glob="*.ts, *.tsx" exclude="*.test.*, *.spec.*, index.ts" partner="[name].test.[ext], [name].spec.[ext]" -->
<!-- @assert-structure target="app" glob="*.py" exclude="__init__.py" partner="tests/[dir]/test_[name].py" -->
```

A template is the partner's name with three placeholders, taken from the file
whose partner it is:

| Placeholder | For `src/api/user.handler.ts`, target `src` |
| --- | --- |
| `[name]` | `user.handler` - the base name up to its last dot |
| `[ext]` | `ts` - what follows that dot |
| `[dir]` | `api` - the file's directory relative to the target, empty at the top |

A template without a `/` names a sibling in the same directory. A template with
a `/` is a path from the root, which is how a mirrored test tree is written. An
empty `[dir]` leaves no stray separator: `tests/[dir]/x` at the top is
`tests/x`. Several templates separated by commas are alternatives, and any one
of them existing satisfies the rule.

That is the whole grammar. There are no other placeholders, no regular
expressions, no conditionals and no escaping. These are directive errors:
- a template naming any other `[...]`;
- a template holding `*`, `?`, `{` or `}` - a partner is one name, and a glob is
  many;
- a template with an empty, `.` or `..` segment, which is how one would leave the
  root.

When two targets overlap, a file is held to the rule once, from the first target
listed that reaches it, and `[dir]` is measured from that target. The query
measures it the same way.

**Not `from=".ts" to=".test.ts"`.** Suffix replacement is the smallest possible
grammar, and it cannot say two things real projects say:
- Python's `test_[name].py` is a prefix, not a suffix;
- a mirrored test tree moves the file to another directory.

Three fixed placeholders cover both. A reader can still expand them by eye,
which is the property a regular expression would give up.

**The partner files are not exempted by magic.** `glob="*.ts"` puts
`user.test.ts` in scope, so it needs `user.test.test.ts`. One tempting fix is to
exempt every file that is some other file's partner. It is rejected: it makes a
rule's scope depend on which other files exist, and it still asks an orphaned
test for a partner of its own. The scope is what the directive says, and
`exclude="*.test.ts"` says it.

Forgetting that exclude is loud, not silent: every test file is reported. Such
a violation says so when the missing file's own name is another file's expected
partner:
`src/user.test.ts  has no partner src/user.test.test.ts (it is the partner of
src/user.ts - exclude it?)`.

**A template that names the file itself is an error.** `partner="[name].[ext]"`
expands to the file's own path, so every file would have its partner. That is
reported at the first file where it happens, not passed.

A violation is the file, reported with every name that was tried.

### Empty scopes fail

- A naming or partner rule whose scope holds no files fails.
- A required-entries rule that selects no directories fails.

Both fail with the message every other rule gives, and `allow-empty="true"` or
`--allow-empty-scope` lets them pass. A missing target fails as it does
everywhere else, and ADR-0012's rule for `--allow-missing-targets` applies
unchanged: with every target gone, nothing is left and the scope is empty.

These are directive errors, because each makes the rule meaningless before a
file is read:
- an empty `pattern`, `required` or `partner`;
- a `required` entry with an empty, `.` or `..` segment;
- `dirs` given without `required`, or given empty;
- `glob` given with `required`, which is about directories. It would otherwise
  be read and ignored, and a rule that says more than it checks is the thing
  this whole ADR is about.

### Scope, counting and the rest

- **Names only.** A structure rule never reads a file's contents. It walks with
  the run's scope policy: `.git`, `.hg`, `.svn` and `node_modules` are skipped
  unless `--no-default-skips`. A directory it cannot list is a gap in the scope
  ledger, and fails under `--strict`.
- **Names all the way down.** Targets are found the way entries are, by name in
  their parent's listing, so `target="Src"` does not find `src/` on Windows
  either. A path is looked up one directory at a time from the root, and every
  directory on the way has to be listed as one.
- **No symbolic link is followed**, in either direction. A link is not a file or
  directory in scope, it does not satisfy a required entry or a partner, and a
  target that is a link is not found. Each of those fails loudly; the other
  choice, following links for existence but not for the walk, would make a rule
  answer differently depending on which question reached the link first.
- **Spec files are in scope.** Every other rule leaves out the spec files so a
  text rule does not find its own directive. A structure rule reads no text,
  and the specs are exactly the files a naming rule about `docs/adr` is about.
- **The engine does not matter.** ripgrep searches contents and is not asked;
  `--engine` has no effect on these rules.
- **Bounds** are `max` (or `expected`), default 0, counting violations in the
  claim's unit.
- **Baselines** list violating files or directories, and `ratchet` works as it
  does for every other rule. This is how a convention is adopted on a codebase
  that does not follow it yet.
- **Reports** show a file or directory rather than a line; a violation has no
  line to point at. A match carries `line: 0` and `column: 0` to say so, and the
  JSON result carries `claim`, because the claim decides whether a match is a
  file or a directory. In SARIF, a naming or partner violation is annotated at
  the top of the offending file. A missing entry has no file to annotate, so it
  sits at the directive, with each directory and what it lacks in the message.
- **The query and the MCP server know the kind.** `get_architectural_rules` on
  `src/domain/new.ts` says what the file must be called and what partner it
  needs. That is exactly what an agent wants to know before creating a file:
  - a naming rule reports `named`, whether the path's name is allowed;
  - a partner rule reports `partners`, the paths that would satisfy it;
  - a `required` rule governs a file when the directory it sits in is one the
    rule holds, since creating `packages/new/index.ts` creates a package that
    needs its `package.json`. A directory is governed when it is held, holds a
    target, or could hold a selected directory.

  The arithmetic behind it joins ADR-0012's equivalence test. A structure rule
  reads nothing a marker could reveal, so its claim is the marker: a pattern no
  name matches, a partner no file has and an entry no directory holds make every
  subject in scope a reported violation. For `required`, the query is asked about
  a file that does not exist in every directory of the tree, which is asking
  whether the rule holds that directory.

### What this repository asserts

<!-- @assert-structure target="docs/adr" pattern="[0-9][0-9][0-9][0-9]-*.md" reason="ADRs are numbered, so a reference to ADR-0011 names one file" -->
<!-- @assert-structure target="src" exclude="index.ts, types.ts" partner="tests/[name].test.ts" reason="every module has a test file of its own name" -->

The second rule did not hold when this ADR was proposed. `src/specs.ts` had no
`tests/specs.test.ts`, because its tests lived in `tests/query.test.ts`, and a
rule that is adopted has to decide between moving them and a baseline. They were
moved, with no baseline. The rule then found one more file before any test did:
`src/structure.ts` itself, written before its test file existed.

Two rules hold the implementation to the promise that existence is decided by
name. The listings go through the walk's own directory reader, which is also
what lets a run read each directory once:

<!-- @assert-import-absence target="src/structure.ts" module="node:fs, node:fs/promises" reason="names come from the walk's directory reader, never from asking the filesystem about a path" -->
<!-- @assert-absence target="src/structure.ts" symbol="statOrNull" reason="a lookup by path finds Readme.md for README.md on Windows and macOS" -->

And the structure rules stay in the test that holds the query to the run, one
claim at a time:

<!-- @assert-count target="tests/query-equivalence.test.ts" symbol='pattern="NONE"' min="1" reason="naming rules are held to the walk" -->
<!-- @assert-count target="tests/query-equivalence.test.ts" symbol='partner="' min="1" reason="partner rules are held to the walk" -->
<!-- @assert-count target="tests/query-equivalence.test.ts" symbol='required="NONE"' min="1" reason="required-entry rules are held to the directories a run selects" -->

## Consequences

### Cost, measured before it was designed

Each claim was prototyped with the real walker and glob compiler, on Windows at
about half CPU load:

| Tree | Files / directories | Walk, names only | Naming | Partners, listing per directory | Partners, `stat` per file | Required |
| --- | --- | --- | --- | --- | --- | --- |
| `src` | 19 / 0 | 0.3 ms | 0.3 ms | 0.6 ms | 1.7 ms | 0.1 ms |
| `tests` | 716 / 494 | 72 ms | 62 ms | 107 ms | 142 ms | 156 ms |
| `node_modules` | 10,073 / 925 | 238 ms | 237 ms | 490 ms | 1,610 ms | 331 ms |

The `tests` figures include leftover scratch repositories under
`tests/fixtures/.tmp`, which is why that tree has 494 directories.

- **The 50 ms budget holds at project scale.** A rule over a source tree of a
  few hundred files costs a walk and nothing else.
- **It does not hold at ten thousand files**, where the walk alone is 238 ms. The
  walk is the floor, and nothing a structure rule adds changes that.
- **Partners are checked by listing each directory once**, not by a `stat` per
  file: 3.3× faster on the large tree, and the only way to compare names the same
  on every platform.
- **Structure rules over the same scope share one walk per run.** The listings
  are cached for the run as well, as the import index and the scope probe
  already are.

### Cost, measured again once it was built

The same trees through `runSpecGuard` on the built package, a whole run each, in
a fresh process per claim, median of seven runs after one to warm up, on
Windows at about 20% CPU load. `tests` has 62 files now that the scratch
repositories are gone.

| Tree | Naming | Partners | Required, `dirs="**"` | All three in one run |
| --- | --- | --- | --- | --- |
| `src`, 20 files | 1.7 ms | 1.7 ms | 1.5 ms | 1.9 ms |
| `tests`, 62 files | 3.7 ms | 4.3 ms | 4.2 ms | 4.4 ms |
| `node_modules`, 10,073 files | 179 ms | 283 ms | 195 ms | 283 ms |

- **All three claims cost the most expensive one.** Over `node_modules`, three
  rules in one run take what the partner rule takes alone, because they share the
  walk and every listing.
- **Partners came in at 283 ms against the prototype's 490 ms.** Not at first:
  the first build measured 460 to 530 ms, and a CPU profile put most of it in
  joining an absolute Windows path for every directory on the way to every
  partner, just to use as a cache key. The listings are keyed by the path from
  the root instead.
- **An earlier measurement said 364 ms for naming, and it was wrong.** It ran
  every configuration in one long-lived process, which drifts. The profile of a
  fresh process disagreed, so every number above comes from a fresh one.

### Held to the mutation bar before it was pushed

A local sweep scoped to `structure.ts` and the changed lines elsewhere scored
98.07% over 1,089 mutants, with 21 survivors:
- fourteen were tests that were missing;
- five were code no test could observe, which was changed rather than tested;
- two were in older code the line ranges happened to cover.

After those fixes a second sweep scored 99.72%. A third, after the listing cache
was re-keyed, reported 100%. CI's full sweep then found four survivors in the
re-keyed cache that the third sweep had scored as killed. They survived again
when replayed by hand, and are now tested. CI's sweep with those tests in scored
98.63% over 6,939 mutants, with `structure.ts` at 100% and 92 survivors in the
project, one fewer than before. [ADR-0003](0003-mutation-testing.md) has each
survivor.

### What is deliberately not in it

- **Orphaned partners.** "Every test has a source file" is the reverse
  direction, and a template is not invertible: `test_[name].py` does not tell
  you which directory the source was in. It can be a later claim if asked for.
- **Directory naming.** `pattern` is about file names.
- **Case-insensitive matching.** Names compare exactly. An `ignore-case`
  attribute is cheap, since the glob compiler supports it, and it is left out
  until a project needs it.
- **Contents of required files.** `@assert-count` and `@assert-absence` already
  answer what a file says.

## Alternatives considered

**A regular expression with a substitution for partners.** It would be the most
powerful option and the least auditable. Three placeholders cover prefixes,
suffixes and mirrored trees, and anything they cannot express is rare enough to
write a second directive for.

**`from`/`to` suffix replacement.** It is simpler than placeholders, and too
simple for prefixes and mirrored trees.

**Three directives: `@assert-naming`, `@assert-contains`, `@assert-partner`.**
Three kinds would carry three copies of the same scope, bounds and baseline
attributes. One kind that names its claim keeps the attribute table readable.

**Globs in `@assert-present`.** It would change the meaning of an existing
attribute.

**Inferring directories from walked files.** It cannot see an empty directory.

**Existence by `stat`.** It is slower, and it disagrees with itself across
platforms.
