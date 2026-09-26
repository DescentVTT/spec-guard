# ADR-0011: Layering constraints and import cycles

## Status

Accepted.

## Context

[ADR-0005](0005-import-assertions.md) stopped at one question - *does this
file depend on that module* - and named what it was leaving out: "is this a
cycle", "does this respect the layer order". Each of those, it said, needs a
graph rather than a per-file answer.

That sentence treats the two as one problem. They are not, and the difference
between them is the whole design.

**A layering rule needs no graph.** "Domain must not depend on
infrastructure" is a per-file question asked many times: for each file in the
domain layer, does any reference match the infrastructure layer's pattern?
Across *n* layers it is *n(n-1)/2* of the questions `@assert-import-absence`
already answers, and today writing them is hand-maintaining that many
directives - which drift, because adding a layer means remembering to add a
row to a triangle nobody wrote down.

**A cycle needs node identity.** To see `a.ts -> b.ts -> a.ts` you must know
that the `./b.js` written in `a.ts` *is* the file `b.ts`. ADR-0005 resolves
specifiers by path arithmetic alone - `./b.js` becomes `src/b.js`, which is not
a file on disk - and deliberately so, because every resolver is a guess about
someone else's build configuration. A cycle detector over edges resolved that
way would lose most of them, report "no cycles", and pass. That is the failure
this tool exists to prevent, and Tarjan's algorithm is forty lines: the
algorithm was never the hard part. The hard part is that the graph would be
wrong.

So the two directives are built on different foundations, and this document
is mostly about being exact regarding where each foundation holds.

## Decision

### `@assert-layers` - on the matching `module=` already does

```md
<!-- @assert-layers target="src" order="domain, application, infrastructure" -->
```

**Order runs from the layer everything may depend on to the layer that may
depend on everything.** A file may import from its own layer and from layers
listed before it; importing from a layer listed after it is a violation. Here
domain may import nothing layered, application may import domain, and
infrastructure may import both.

Written that way round because it is the order people draw: the stable core
first. The report does not rely on the reader remembering it - every violation
says which layer imported which, and that the imported one is listed after.

**A layer is a pattern, in exactly the language of `module=` and `exclude`.**
A pattern with a slash is anchored at the root and covers everything beneath
it; a bare name matches any path segment. Membership of a file is its path
matched against the patterns. A reference reaches every layer that any name it
can denote matches: the specifier as written and the module it resolves to, as
import assertions try - and, in JavaScript, TypeScript and Python, the files
that module can be, from the table below. Names only: nothing asks whether any
of them exists, so a layer outside the assertion's target is still reached.

That is what makes layers polyglot without a resolver: they work in every
language `module=` works in, with the same caveats. A bare
name is the portable form - `domain` matches `src/domain/user.ts`,
`app.domain.user` in Python, `crate::domain::user` in Rust and a Go import path
ending in `/domain/user` - while an anchored `src/domain` matches only paths
that start there, which a Go module path never does.

**The unit is files**, as in ADR-0005: a file that imports two forbidden
layers is one violating file, and its first offending reference is the one
shown. `expected`/`max` (default 0), `types`, `exclude`, `allow-empty` and a
[debt baseline](0009-debt-baselines.md) all mean what they mean on
`@assert-import-absence`.

Three things fail rather than pass:

- **A layer that matches no file in scope.** `order="domain, aplication"` is a
  rule about nothing, indistinguishable in a report from a rule that inspected
  a hundred files and found them clean. Same rule, same remedy
  (`allow-empty="true"`) as an empty target.
- **A file that belongs to two layers.** Overlapping patterns are a rule with
  two readings, and resolving the ambiguity silently would choose one reading
  for the author.
- **Fewer than two layers, or the same layer twice.** Rejected when the
  directive is resolved, before anything is read.

0.10.2 added two more, a layer no C# using can reach and a scope in which no
import crosses between layers - see [C# layers are
namespaces](#c-layers-are-namespaces-0102) below.

A file in scope that matches no layer is unconstrained, and said to be: the
result carries a note giving how many. Shared utilities are often meant to sit
outside the order; a directory someone forgot to assign is not, and only the
author can tell which a count describes.

### `@assert-import-cycle` - on a declared resolution table

```md
<!-- @assert-import-cycle target="src" -->
```

**The unit is a strongly connected component**: a set of files each reachable
from every other, or a single file that imports itself. Not simple cycles. A
knot of ten mutually dependent files can contain hundreds of distinct simple
cycles, one import added inside it can multiply that count, and none of that
changes what someone has to untangle. Counting components is stable under
edits that do not change the architecture, which is the property a count in a
spec needs. Johnson's algorithm, which enumerates simple cycles, is rejected
for exactly that reason, and for being exponential in the worst case.

Components are found with Tarjan's algorithm, written **iteratively**. The
recursive form is the textbook one, and run on a single chain of imports it
throws `Maximum call stack size exceeded` at 10,000 files under Node's default
stack - measured, and fine at 1,000. That is a large monorepo rather than a
pathological input, so the call stack here is an explicit array of frames.

Each component is reported with one concrete cycle through it - the shortest
one through its first file in path order, found by breadth-first search inside
the component - and the file, line and statement of every import on that
cycle. A component is a set; what someone fixes is an import, and they need to
be shown which ones close the loop.

**Nodes are the JavaScript and TypeScript files in scope, and nothing else.**
An edge exists when a reference resolves to one of them under this table, and
the table is the entire resolver:

| specifier | tried, in order |
| --- | --- |
| relative, e.g. `./b.js` | for an emitted extension, its TypeScript source first (`.js` -> `.ts`, `.tsx`; `.jsx` -> `.tsx`; `.mjs` -> `.mts`; `.cjs` -> `.cts`); then the path as written; then the path with each of `.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` appended; then the same list under `/index` |
| anything else | not resolved |

Every lookup is a membership test against the set of files the walk already
produced. There is still no filesystem access and no reading of `tsconfig.json`
or `package.json`; what changed from ADR-0005 is only that path arithmetic may
now be compared with a list the run already holds. The order is TypeScript's,
so where `b.ts` and `b.js` both exist the edge goes where the compiler would
send it.

A reference that does not produce an edge is sorted, and the sorting is where
honesty lives:

| outcome | when | effect |
| --- | --- | --- |
| **outside the scope** | resolves under no target, or any name in the table above is excluded | ignored: a cycle through a file the author left out is the author's scope |
| **not code** | names a file the walk found that is not JS or TS, e.g. `./app.css` - decided by membership, so a missing `./gone.css` is unresolved, not ignored | ignored |
| **external** | a bare specifier that can name a package: `react`, `@scope/pkg`, `node:fs` | ignored |
| **unresolved** | relative, inside the scope, and nothing in the table matched; or a specifier that *cannot* name a package - `#internal/db`, `@/db`, `~/db` - and so must be an alias for something inside the project | **reported**; a failure under `--strict` |

The last row is the only inference in the table, and it is made from npm's
naming rules rather than from guessing at configuration: `#` is Node's prefix
for package-internal imports, and `@/` and `~/` are not valid package names.
A specifier shaped like one cannot be a dependency on someone else's code.

**What this cannot see**, stated because a report cannot state it: an alias
written as a valid package name. `@app/db`, configured through `tsconfig` paths,
is indistinguishable from the published package `@app/db`, and is treated as
external. A cycle that passes through one is invisible. Resolving it would mean
reading `tsconfig.json` - `extends` chains, `baseUrl`, wildcard `paths`, project
references - which is the resolver ADR-0005 declined to become, for the reason
it gave.

**Why JavaScript and TypeScript only.** Layering works in every language
because it matches names. A cycle needs files, and in the other four languages
spec-guard reads, a reference does not name one:

- **Python.** `from app import users` reaches the extractor as the specifier
  `app`, and whether `users` is a submodule - a real edge to `app/users.py` - or
  an attribute defined in `app/__init__.py` is not in the statement. Absolute
  imports also resolve against `sys.path`, which a `src/` layout changes. The
  graph would either miss the edges that make most Python cycles or invent ones
  that are not there.
- **Go.** The unit is the package, which is a directory, and an import names a
  module path whose prefix is declared in `go.mod`. Cycles between packages are
  a compile error already.
- **Rust.** `use` paths name items through a module tree built by `mod`
  declarations, not files; cycles between modules inside a crate are legal and
  between crates impossible.
- **C#.** A `using` names a namespace, and namespaces are not files.

Files in those languages inside the scope are counted and reported as outside
the graph. A scope in which *no* file can be placed in the graph fails, as an
import assertion over a directory of YAML already does. Python is the one worth
returning to: it needs the extractor to emit the names a `from` statement
imports, which changes `ModuleReference` and so belongs in its own decision.

`expected`/`max` (default 0), `types`, `exclude` and `allow-empty` behave as on
the other import directives. There is **no baseline**. A baseline lists files,
and a cycle is not a file: exempting the files of today's cycle would also
exempt a second, new cycle among the same files. `max="2"` is the honest way to
adopt the rule on a codebase that already has two, and it fails the day there
are three.

**`types` defaults to `include`**, for ADR-0005's reason: a type-only import is
coupling, and a default that ignored it would pass silently on a rule the author
wrote. `types="ignore"` asks the runtime question - erased imports create no
load-order cycle - and this repository needs exactly that distinction. Its own
`src/` has one cycle, `imports.ts -> polyglot.ts -> imports.ts`, and it is
type-only: ADR-0008 lets the polyglot readers share the reference types without
the analyser depending on them at runtime. So this document asserts both halves:

<!-- @assert-import-cycle target="src" types="ignore" reason="no runtime import cycle anywhere in the package" -->
<!-- @assert-import-cycle target="src" max="1" reason="the one type-only cycle ADR-0008 keeps between imports.ts and polyglot.ts; a second is new" -->

**`dynamic="ignore"`, added in 0.10.0, asks the runtime question of `import()`.**
A run of 0.9.2 over a real monorepo met a loop that is intended:
`configuration.ts -> lazy-tier.ts -> import('./tier-boot.ts') -> configuration.ts`.
No module waits on another to load, because the last edge is taken when the
plugin is asked for, after all three have loaded. The rule reported it, with
nothing to write but `max="1"`, which would also have admitted the first real
cycle to come along.

So a cycle rule takes `dynamic="ignore"`, which leaves `import('x')` references
out of the graph before resolution. An import it drops also cannot be reported
as unresolved. A static import between the same two files still makes the edge.
The default stays `include`, for the same reason as `types`: an `import()` is
coupling, and a rule that ignored it by default would pass without saying so.
The description says what was left out, as `types="ignore"` does: `(dynamic
imports ignored)`, or `(type-only and dynamic imports ignored)`.

Two things it does not distinguish, stated here and in the README:
- **A top-level `await import('x')`** runs while its module loads, so a cycle
  through it can deadlock. Telling it from an `await import()` inside a function
  needs function scope, which a tokenizer does not track; brace depth is not a
  substitute, since `try { await import() }` at the top level is depth 1. The
  attribute ignores both, and the author who writes it is taking that on.
- **`require()`** is not dynamic here. Whether it runs at load time depends on
  where it is called, and the default for anything unknown is to keep the edge.

Layers take no `dynamic`: an `import()` that points a layer the wrong way is
still a violation. Neither do the per-module rules, which count dependencies.

<!-- @assert-count target="src/parser.ts" symbol="'dynamic'" expected="1" reason="dynamic= belongs to the cycle rule alone; an import() still breaks a layer" -->

And the layering the source actually has, which nothing asserted until now:

<!-- @assert-layers target="src" order="src/text.ts, src/parser.ts, src/runner.ts, src/cli.ts" reason="the grammar knows nothing of execution, and execution nothing of the command line" -->

### C# layers are namespaces (0.10.2)

A run of 0.10.1 over a .NET solution put `using Shop.Application.Catalog;` into
a file of `src/Shop.Domain` on purpose, and two rules passed it:

```md
<!-- @assert-layers target="src" order="src/Shop.Domain, src/Shop.Application" -->
<!-- @assert-layers target="src" order="Shop.Domain, Shop.Application" -->
```

**The second was a matching gap, and is fixed where `module=` is.** A bare
`Shop.Application` held the files of `src/Shop.Application` - it matches that
path segment - but a pattern without a slash matches one whole name, and the
names of that reference were `Shop.Application.Catalog` and
`Shop/Application/Catalog`. The slashed form of the pattern would have caught
it, and nothing said so. A reference in a language whose modules are dotted now
also goes by every module it sits under (ADR-0008), so the pattern that holds a
project's files reaches its usings too, and stops at a segment:
`Shop.ApplicationServices` is not beneath it.

**The first cannot be fixed by matching.** `src/Shop.Application` is a path, and
a using names a namespace. No name of any C# reference begins with `src/`, so
the layer held the right files and no reference could ever arrive in it. That
rule checked nothing, and read like one that checked everything.

Making it work would mean deciding which folder a namespace lives in. Three ways
were considered, and each is wrong for a convention in wide use - wrong in the
direction that reports a violation that is not there, which a team answers with
a baseline, and the baseline then hides the real one when it comes:

| mapping | where it breaks |
| --- | --- |
| a folder's name is its root namespace | `dotnet new` does this, but a widely used Clean Architecture template keeps `src/Domain` with `<RootNamespace>CleanArchitecture.Domain</RootNamespace>`, and solutions that prefix a company name do the same |
| a project's `RootNamespace`, read from its project file | it is often set in `Directory.Build.props`, as `$(MSBuildProjectName)` or with a prefix: reading it is evaluating MSBuild, the resolver ADR-0005 declined for `tsconfig` |
| the namespaces a layer's files declare | Microsoft's guidance for library authors puts `IServiceCollection` extensions in `Microsoft.Extensions.DependencyInjection`, and a solution may declare it in more than one layer; every `using Microsoft.Extensions.DependencyInjection;` in an earlier layer would become a violation |

So a C# layer is named by its namespace - which is also its folder, under the
naming `dotnet new` uses - and where folders and namespaces differ, by the
segment they share: `Domain` holds `src/Domain` and reaches
`CleanArchitecture.Domain.Entities`. That is the unit .NET's own architecture
tests use, too: NetArchTest and ArchUnitNET select types by namespace.

**What declarations are right for is telling that a layer cannot be reached.**
The namespace a file declares is exactly the name a using of that file writes.
If a layer's pattern matches none of the namespaces its own files declare, no
using can reach it - that is not a guess about where a namespace lives, it is
the pattern tried against names the layer's files give themselves. One that
matches is enough, so a layer that also holds an extension class in a framework
namespace is still reachable. So the C# reader records what each file declares
(a nested block in full: `namespace A { namespace B {` declares `A.B`), and a
layer rule **fails** when a layer after the first is unreachable that way:

```text
no C# using can reach layer "src/Shop.Application": it matches none of the namespaces its files declare, such as Shop.Application.Catalog, so a dependency on it is never seen (a layer reaches C# when it matches the namespace as well as the folder; add allow-empty="true" if that is expected)
```

The first layer is exempt because every layer may depend on it: a reference
that cannot reach it hides nothing. A layer whose files declare no namespace -
top-level statements in `Program.cs` - cannot be judged, and is not.

**And a scope in which no import crosses between layers fails**, in every
language. When no reference reaches any layer other than its own file's, the
rule would pass with its layers listed in any order, which is the symptom of
every layer-matching gap: the first defect recorded below, file-sized layers
that no JavaScript import matched, is exactly this, and so is the C# one.

```text
no import in scope reaches a layer other than its own file's, so these layers would pass in any order (add allow-empty="true" if that is expected)
```

Both take `allow-empty="true"` and `--allow-empty-scope`, and become warnings
under either, for the reason a layer that matches no file does: each is a rule
that could not have failed. A real codebase whose layers do not yet depend on
each other is the case the attribute exists for.

It costs matching time, since a C# reference now goes by the namespaces above it
and each layer's declarations are tried as well. On 4,000 synthetic C# files in
four projects, six usings each, `checkLayers` took 26-74 ms under 0.10.1 and
67-152 ms under 0.10.2 across three runs on the development machine: about
twice, and a fifth of a second at worst. Reading the files, and the same
measurement over 4,000 TypeScript files, moved within that machine's
run-to-run noise.

Two gaps stay, and the README gives each a text rule, since a text rule reads a
name wherever it is written: a fully qualified name with no using at all, and
the dependencies .NET keeps outside C# files - a `<ProjectReference>` or
`<Using Include>` in a project file, and `@using` in Razor. Project files are
now read as XML, so a reference commented out of one is not counted.

## Consequences

### Performance

Measured on the built package, phase by phase, median of repeated rounds on the
Windows machine this was developed on. Walking and tokenizing are what every
import assertion already pays, shared across a run by the per-run index; the
last four rows are what this document adds.

| phase | this repository's `src/` (15 files) | `node_modules` (6,977 JS/TS files) |
| --- | --- | --- |
| walk | 2.8 ms | 1,925 ms |
| tokenize | 16.4 ms | 5,321 ms |
| build the graph | 0.4 ms | 104 ms |
| Tarjan | < 0.1 ms | 17 ms |
| shortest loops | < 0.1 ms | 1.3 ms |
| layering, three layers | 2.4 ms | 481 ms |

The `node_modules` corpus is the one ADR-0005 measured - 17,491 references,
the same count to the reference - and the graph over it holds 12,353 edges, 651
imports it reports as unresolved, and 44 cycles, the largest spanning 78 files.

So the algorithm is not where the time goes, and neither is the resolver: on a
project the size of this one, a cycle or layer assertion costs about what an
import assertion over the same files already cost, and all three of this
document's directives run in 38 ms together. On a tree of seven thousand files
the budget that matters is tokenizing, which this does not change.

Layering is the one new cost worth naming. Each reference is matched under
every name it can denote - about twenty for a JavaScript import, which is what
lets a layer name a file - and on the large corpus that is 360,944 names, 97,862
of them distinct. Matching each distinct name once took layering from 712 ms to
481 ms. The rest is generating the names; reducing it means matching fewer of
them, which changes which layers a reference can reach, and that is not a trade
to make for a tree nobody writes rules about.

### A cost ADR-0010 imposed on writing this

A proposed ADR is withheld but still validated, and validation rejects a
directive kind the tool does not know. This document was first written with
its three directives live and its status `Proposed`, against the 0.6.0 build,
and failed:

```text
⚠ docs/adr/0011-layers-and-cycles.md:196  invalid directive
    Unknown directive "@assert-import-cycle". Expected one of: ...
○ docs/adr/0011-layers-and-cycles.md is Proposed. - no directives to execute

0 passed · 3 invalid · 4ms
```

That is the behaviour ADR-0010 chose, and it is right: a typo in a draft should
fail on the day it is written. It does mean that proposing a *new directive
kind* is the one case where a proposal cannot be committed executable before
the kind exists, so this one landed together with its implementation. Rare
enough to record rather than design around.

## What the tests found

Two defects, both of the same shape, and both found by a control that was meant
to pass rather than by one that was meant to fail.

**A layer that names a file could never be reached.** Membership reads a file's
path, `src/runner.ts`; a reference resolves to what the import says,
`src/runner.js`. The rule this document asserts about its own source -
`order="src/text.ts, src/parser.ts, src/runner.ts, src/cli.ts"` - passed. So did
`order="src/cli.ts, src/runner.ts, src/parser.ts"`, which the code breaks twice,
and that pass is the only thing that revealed it: no reference matched any
layer, so no order could be broken. References are now matched under every name
they can denote in the importing file's language, and that order fails on
`cli.ts` importing the runner and the runner importing the parser.

**An excluded file looked like a broken import.** `exclude="src/b.ts"` names the
file, `./b.js` imports it, and the scope test compared the exclusion with the
specifier alone. A graph with the file correctly left out reported one import
it could not resolve, and failed under `--strict`. It surfaced as a negative
control that survived: removing the exclusion from the scope altogether changed
nothing any test looked at, because the tests only looked at `ok`.

## Alternatives rejected

**A real resolver** - `tsconfig` paths, `package.json` `exports` and `imports`,
Node's full algorithm. Correct where it is correct, a dependency or a
re-implementation the size of the tool, and confidently wrong the first time
the configuration is more elaborate than it anticipated. The table above is
small enough to read, and everything it does not resolve it says so.

**A graph library.** The runtime has no dependencies, and the algorithm is not
where the difficulty is.

**Cycles in every language through `module=`-style matching.** Matching a
pattern answers "is this reference about that area"; a cycle needs "is this
reference *that file*". Using the first to answer the second invents edges.

**Strict layering**, where a layer may import only the one immediately before
it. Rarer than the relaxed rule, and expressible today with an
`@assert-import-absence` per skipped pair. Worth a flag if anyone asks for it.

**`@assert-import-acyclic`.** Reads better as a sentence. But the grammar is
`@assert-<subject>-<claim>`, the claim here carries a count, and "at most two
acyclic" is not a sentence at all.

## Amended 2026-09-26: the graph read backwards

`spec-guard impact` reads this graph the other way, from a file to the files
that import it, over the whole tree rather than one rule's targets. It adds one
row to the resolution table - a relative Python import names `db.py` or
`db/__init__.py` beside the importing file, by the same arithmetic and
membership - and keeps every other rule above: what cannot be followed is
listed or counted, never guessed. [ADR-0018](0018-impact.md) has the table
and why the other three languages stay out of it. Cycles are unchanged:
`@assert-import-cycle` still places JavaScript and TypeScript alone.
