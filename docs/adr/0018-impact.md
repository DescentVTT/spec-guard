# ADR-0018: Who depends on this, read off the graph ADR-0011 built

## Status

Accepted (2026-09-26).

## Context

`query` answers the question an agent asks before touching a file: which rules
govern it ([ADR-0012](0012-query-and-mcp.md)). The next question is the one a
reviewer asks of a change: what else does it reach. Renaming an export in
`src/db/client.ts` breaks every file that imports it, and every file that
imports one of those may behave differently; the rules that govern those files
are in play too, though the edit never touched them.

spec-core's ADR-0006 folded the planned `spec-code-graph` into spec-guard as
`cites` ([ADR-0017](0017-citations-in-comments.md)) and `impact`, on the
condition the family holds every tool to: module level only, since symbol level
needs a parser nobody ships. spec-guard already reads imports in five languages
([ADR-0005](0005-import-assertions.md), [ADR-0008](0008-polyglot-imports.md))
and has a graph with node identity ([ADR-0011](0011-layers-and-cycles.md)).

## Decision

**`spec-guard impact <paths...>` lists, for each path, the files that import
it, transitively, each with its distance and the import that takes it one step
closer; and the rules that govern the path or any of those files.**

<!-- @assert-present file="src/impact.ts, tests/impact.test.ts" reason="the graph read backwards, and the tests that hold it to the resolution table" -->

```text
src/db/client.ts
  4 files depend on it, 2 directly, up to 3 imports away
    1  src/app/service.ts  imports src/db/client.ts (line 2)
    1  src/db/index.ts     imports src/db/client.ts (line 1)
    2  src/app/cache.ts    imports src/app/service.ts (line 1)
    3  src/ui/view.tsx     imports src/app/cache.ts (line 1)

3 rules govern these files, from 1 document
  ...
not followed: 2 Rust uses name modules rather than files, so a file that depends on these paths through one is not shown (ADR-0018)
2 imports could not be resolved, and may depend on these paths:
  src/ui/view.tsx:3  ./gone.js (names no file)
  src/ui/view.tsx:7  import(name)
```

### The graph, and what it will not guess

It is ADR-0011's graph read backwards, over the whole tree in scope - the root,
less the default skips and the project's `exclude` - rather than one rule's
targets. An edge is a reference that path arithmetic, plus membership in the
files the walk found, turns into a file:

| language | followed | not followed |
| --- | --- | --- |
| JavaScript, TypeScript | a relative specifier, by ADR-0011's table: the TypeScript source of an emitted extension, the path, the path with an extension, its `index` | a bare package, external; an alias that cannot be a package (`#x`, `@/x`, `~/x`) or a relative specifier naming no file, **listed as unresolved** |
| Python | a relative import: `from .db import x` names `db.py` or `db/__init__.py` beside the importing file; `from . import x` names `x.py`, or else the package's `__init__.py`, where the name then comes from | an absolute import, **counted**: which file `app.db` is depends on `sys.path` |
| Go | nothing | every import, **counted**: a path's prefix is declared in `go.mod`, and the unit is a package directory |
| Rust | nothing | every `use`, **counted**: a path names an item through the module tree `mod` declarations build |
| C# | nothing | every `using`, **counted**: a namespace is not a file |

The table is ADR-0011's reasoning for why cycles are JavaScript and TypeScript
only, applied to one more language where it does not hold: a relative Python
import names a file by arithmetic, as a relative JavaScript one does, so the
graph can hold it. An absolute one cannot be placed without `sys.path`, which a
`src/` layout changes, and guessing wrong in this direction invents a
dependency - or, worse, the absence of one.

**A dependent that cannot be shown is said to be missing, never assumed
absent.** Every reference the graph could not follow is in the report:

- **unresolved**, listed with file and line: a relative import naming no file,
  an alias, a dynamic `import(name)`, a relative Python import naming neither
  a module nor a package. Any of them may name the path.
- **not followed**, counted by kind: the Go, Rust, C# and absolute Python
  references. A path in Go, Rust or C# is answered with a note saying its
  dependents are not computed, rather than with an empty list, which would read
  as "nothing depends on this".
- **a file whose imports could not all be read** - a scan that lost its place,
  a file that could not be read - is named.

A path that does not exist is exit 2: nothing can depend on it yet, and a query
about a file one is about to create is `query`'s.

No spec matching is exit 2 too, as it is for `query`, and the report is still
written: who depends on a path is measured without specs, but the rules in
play are not, and "no rules govern these files" over no specs is the reading
the family contract (spec-core's ADR-0005) forbids - nothing measured is not
clean. The first release of this command exited 0 there, which a script
reading only the exit code could not tell from a path no rule governs.
`--allow-empty` asks for the dependents alone and exits 0, as it lets a run
over no specs pass.

### The walk

Breadth-first from the path's files: a file's depth is its shortest distance,
and each file appears once, so a cycle is walked safely. `--depth <n>` stops
after `n` imports. A directory asks about every graph file under it, and its
dependents are the files outside it. Neighbours are taken in path order and
then line order, so the same tree gives the same answer. A type-only import is
an edge, for ADR-0005's reason: a type the importer names is a type that can
break it.

### The rules in play

Every rule in force is tried against the paths as asked and each dependent as
a file, by `governs` from ADR-0012 - the arithmetic `query` uses, which a test
holds to the walk - and listed with the files it governs. Rules in documents
not in force are counted and their documents named, and listed with
`--ignore-status`, as a query does.

`--json` is versioned by `formatVersion`. There is no SARIF, GitHub or GitLab
form: the answer is a list of files and rules, not findings with places.

## Out of scope

- **Symbol level.** Which of a module's exports a dependent uses needs a
  parser; a file that imports `client.ts` for one constant is listed as surely
  as one that uses all of it.
- **Resolvers.** `tsconfig` paths, `package.json` `exports`, `go.mod`, a
  crate's module tree, C# namespaces: ADR-0005 declined to become one, and the
  counts above are what that costs here. `go.mod`'s `module` line is the
  nearest of them to arithmetic, and the first worth an ADR of its own.
- **A Python package's `__init__.py` as a dependency of its whole package.**
  Every import of `pkg.sub.mod` runs `pkg/__init__.py`, but read that way every
  module of a package depends on the package's `__init__`, which says nothing a
  reader can act on.
- **An MCP tool**, when this was written. The server's tools are pinned by its
  tests, which the move onto spec-core's protocol layer kept unchanged, and
  adding `impact` there was a decision about what an agent is offered. The
  amendment below makes it.

## Consequences

On this repository, `spec-guard impact src/graph.ts` reads 149 files and
answers in about 280 ms, 49 of them dependents. Over `node_modules` as well,
7,626 files with the default skips off, it takes about 2 s, which is the
tokenizing ADR-0011 measured, not the walk back.

### Held to the mutation bar

One local sweep of `impact.ts`, before its last round of tests, scored 91.0%,
and most of what survived was the human report's singular and plural lines and
the lines it leaves out when it has nothing to say, which now have a report
pinned in full each way. The rest - a file whose imports nothing reads, a
relative Go import, the reads held to the engine's limit, the order a walk
starts in - have tests. One survivor is equivalent: `normalizeModule` is
handed `'python'` for a relative Python import, and Python is its general
case, so any other language name gives the same path. The sweep that measures
this file is CI's.

## Amended 2026-09-26: `get_dependents` on the MCP server

The agent the question is for is the one editing the file, and it asks through
the server rather than a terminal. `spec-guard mcp` offers a third tool,
`get_dependents(paths, depth?, include_inactive?)`, beside
[ADR-0012](0012-query-and-mcp.md)'s two.

- **It is `impact`, answered as `impact --json` answers.** Its structured
  content is the document the command writes - `formatVersion`, each path's
  dependents with their depth and the import that leads there, the unresolved
  imports, the references counted rather than followed, and the rules in play
  with the files each governs - built by the one function both call,
  `impactDocument`, and a test holds the two answers equal field for field. Its
  text is the command's human report.
- **It is read-only**, idempotent and closed-world, as the other two are: it
  reads the specs and the tree, and writes nothing.
- **Its description says when to call it**: before changing a file that other
  files import - renaming or removing an export, changing a signature - to see
  everything the change can reach. The server's instructions say the same,
  between the rules to read before an edit and the check to run after one.
- **Its arguments are the command's**: paths, which must exist, a depth of 1
  or more, and `include_inactive`, which defaults to the server's
  `--ignore-status` as `get_architectural_rules`'s does. A path that does not
  exist or lies outside the root is a tool error the model can read, as a path
  outside the root is for the other tools.
- **It answers without specs**, where the other two refuse: who imports a file
  does not depend on them, and the answer says that no rules are shown. A tool
  call has no exit code; the command's is 2 there, unless `--allow-empty`.

The tests that pin the tool list pin three names now, in `tests/mcp.test.ts`
and over the built binary in `tests/e2e.test.ts`, with the new descriptor, its
schema and the instructions pinned whole.

<!-- @assert-count target="src/mcp.ts" symbol="impactDocument" min="2" reason="get_dependents answers with the document impact --json writes, built by the same function" -->
