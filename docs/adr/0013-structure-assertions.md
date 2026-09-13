# ADR-0013: Structural and naming assertions

## Status

Proposed.

The directives below are shown in fences, not written live. ADR-0010 validates
the directives of a document that is not in force, so a live `@assert-structure`
in this document would be an unknown-directive error until the kind exists. On
acceptance the examples that describe this repository become live rules.

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
  satisfies it;
- a trailing `/` means the entry must be a directory.

A violation is the directory, reported with every entry it lacks:
`packages/billing  missing README.md`.

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
expressions, no conditionals and no escaping. A template naming any other
`[...]` is a directive error, as is a template that would leave the root.

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
- a `required` entry of `.` or `..`;
- `dirs` given without `required`.

### Scope, counting and the rest

- **Names only.** A structure rule never reads a file's contents. It walks with
  the run's scope policy: `.git`, `.hg`, `.svn` and `node_modules` are skipped
  unless `--no-default-skips`, and symbolic links are not followed. A directory
  it cannot list is a gap in the scope ledger, and fails under `--strict`.
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
  line to point at. In SARIF, a naming or partner violation is annotated at the
  top of the offending file. A missing entry has no file to annotate, so it sits
  at the directive, with the directory in the message.
- **The query and the MCP server know the kind.** `get_architectural_rules` on
  `src/domain/new.ts` says what the file must be called and what partner it
  needs. That is exactly what an agent wants to know before creating a file. The
  arithmetic behind it joins ADR-0012's equivalence test: a pattern nothing
  matches turns every file in scope into a reported violation.

### What this repository will assert

On acceptance, at least these become live, and both have already been checked
against the tree by hand:

```md
<!-- @assert-structure target="docs/adr" pattern="[0-9][0-9][0-9][0-9]-*.md" reason="ADRs are numbered, so a reference to ADR-0011 names one file" -->
<!-- @assert-structure target="src" exclude="index.ts, types.ts" partner="tests/[name].test.ts" reason="every module has a test file of its own name" -->
```

The first holds today. The second does not. `src/specs.ts` has no
`tests/specs.test.ts`, because its tests live in `tests/query.test.ts`, and it
would be the rule's first finding. Accepting the rule means deciding whether to
move those tests or record `baseline="src/specs.ts"`, and that is a decision the
rule forces into the open.

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
