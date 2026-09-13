# ADR-0012: Shift-left guardrails: a query interface and a zero-dependency MCP server

## Status

Accepted.

## Context

spec-guard answers one question: *does the codebase still honour the specs?*
It answers it after the code is written. For a person that is how CI works. For
an agent generating code it is an expensive loop: write, wait for a run, read a
failure it could have been told about beforehand, write again.

The request was for two things.

1. **`spec-guard query <path>`**: the rules in force for a file or directory,
   answered from the specs without a scan of the codebase, fast enough to call
   before every edit.
2. **`spec-guard mcp`**: the same answer, and a check, served over the Model
   Context Protocol, so an agent can ask directly. No `@modelcontextprotocol/sdk`:
   spec-guard has no runtime dependencies, and a stdio server is JSON-RPC.

Three things turned out to matter more than the wording of either.

**"Without scanning" is a claim that can be false.** Whether a rule governs a
path is decided by the rule's scope, and the scope is decided by a walk: targets,
`exclude`, `glob`, skipped directories, the spec files themselves, and which
languages an import rule reads. A query that approximates the walk is a second
opinion about scope, and a second opinion is the thing this project has spent
eleven ADRs removing.

**MCP changed six weeks before this ADR.** Revision `2026-07-28` removed the
`initialize` handshake. Every request now carries its protocol version in
`_meta`, `server/discover` is mandatory, `ping` is gone, and results carry a
`resultType` and caching hints. Clients of both eras are in use. A server that
spoke only the revision everyone knew a year ago would be wrong for new clients,
and one that spoke only the new one would be unreachable from most existing ones.

**What counts as "in force" was already decided.** ADR-0010 withholds documents
by status, and ADR-0011 gave layers and cycles a meaning. A query that disagreed
with a run about either would be worse than no query.

## Decision

### A query is arithmetic, and is held to the walk

`governs(assertion, path)` in `src/rules.ts` decides, without reading anything,
whether an assertion's scope reaches a path.

For a **file**, it asks what the walk would do:

- the file is under one of the assertion's targets;
- no directory between that target and the file is one the run skips (`.git`,
  `.hg`, `.svn`, `node_modules`, unless `--no-default-skips`);
- `exclude` does not match it;
- `glob` does;
- it is not one of the spec files (unless `--include-specs`);
- the assertion can read its language: any file for a text rule, the analysable
  extensions for import rules and layers, JavaScript and TypeScript for cycles.

For a **directory**, it asks whether that could be true of a file under it. A
directory inside a target is governed unless it is skipped or excluded; an
excluded directory excludes everything under it, because `exclude` tests every
ancestor. A directory that holds a target is governed unless the target is
excluded. `glob` and language filters cannot be decided for files nobody has
named, so a directory is shown the rule, with the filter.

`@assert-present` governs the files it names, and any directory holding one.

A path that does not exist is a valid question - "what will govern the file I
am about to create" is the question this command exists for. It is a file unless
it exists as a directory or is written with a trailing slash. An absolute path
is accepted inside the root, because that is what agents' file tools pass around;
anything outside the root is refused.

<!-- @assert-import-absence target="src/rules.ts" module="node:fs, node:fs/promises" reason="whether a rule governs a path is arithmetic; the moment it reads the disk it is a scan" -->

**The arithmetic is tested against the walk, not against a model of it.** In
`tests/query-equivalence.test.ts`, every file in a tree carries a marker each
kind of rule reports: the text `MARK`, an import of `mark` in its own language,
and an import of itself. A real run then names exactly the files it looked at:
- every searched file matches the text rule;
- every read file matches the import rule;
- every file in the graph closes a cycle on itself.

The governed set must equal that file for file, under the JavaScript engine and
under ripgrep. It must also equal it on randomly generated trees and rules.
Directories are held to the direction that matters: a directory may be shown a
rule whose filters leave nothing in it, but never denied one while the run reads
a file inside it.

<!-- @assert-present file="tests/query-equivalence.test.ts" reason="the query's claim to match the walk is exactly as good as the test that holds it to the walk" -->

Three things arithmetic cannot see, and a query does not claim to:

- **Content.** A file over 20 MB, a binary one, or an unreadable one is skipped
  by the run and governed by the query. A run reports those skips anyway.
- **Symbolic links.** The walk does not follow them, and a path through one looks
  like any other path.
- **Case.** On a case-insensitive filesystem, `SRC/a.ts` names `src/a.ts`; to
  the arithmetic they are different paths.

### Lifecycle: in force by default, withheld rules counted and named

Rules come from the same `readSpecs` the run uses. That function is the first
half of `runSpecGuard`, moved out rather than copied, because a copy of the
status rule is a second opinion on which documents are in force.

A query lists the rules of documents in force. The rules of a draft, proposed,
rejected, deprecated or superseded document that would govern the path are
**counted and their documents named**, and listed only with `--ignore-status`
(`include_inactive` over MCP). An agent told "nothing governs this file" while a
proposal about to govern it sits in `docs/adr/` has been told something false by
omission, which is the report ADR-0010 exists to prevent.

A listed rule from such a document carries `inForce: false`, and its document's
status. A query does not pretend `--ignore-status` changed what the document says.

### Topology: a path's position in each layer order

For `@assert-layers`, a query reports where the path sits:

- the layer it belongs to and its position in the order;
- `mayImport`, its own layer and every one before it;
- `mustNotImport`, every layer after it.

A path two layers match is reported as ambiguous with both, since the rule fails
until one is removed. A path no layer matches is reported as belonging to none.
For a directory, the layer that matches the directory itself is reported, and it
then matches every file under it.

A cycle rule governs the JavaScript and TypeScript files in its scope, the same
set it places in the graph.

### The MCP server: no SDK, both eras

`spec-guard mcp` is a stdio server in `src/mcp.ts`, about 600 lines with
comments. The official server package is `@modelcontextprotocol/server` 2.0.0 at
6.3 MB unpacked, which needs `@modelcontextprotocol/core` at 1.3 MB and `zod` 4
at 6.1 MB. The 1.x `@modelcontextprotocol/sdk` has 17 direct dependencies,
Express and Hono among them. spec-guard is 0.7 MB unpacked with none, and the
server adds 103 KB to `dist` (44 KB of JavaScript; the rest are type
declarations and source maps).

<!-- @assert-absence target="package.json" symbol='"dependencies"' comments="include" reason="no runtime dependencies, and an MCP server is not a reason to take one" -->
<!-- @assert-import-absence target="src" module="@modelcontextprotocol/**" reason="the protocol is implemented here, not imported" -->

**Framing** is the stdio binding exactly: one JSON-RPC message per line, split on
`\n` (a CRLF line's `\r` is whitespace to JSON), blank lines skipped, and a `JSON.stringify` per
response, which never emits a raw newline. Not `Content-Length`: that is LSP's
framing, and MCP has never used it. A UTF-8 character split across two reads is
reassembled; a line that is not JSON is answered with -32700; a request the client
cancels gets no response; when stdin closes, running requests finish and the
process exits 0. Nothing but protocol goes to stdout. The one line a person needs
goes to stderr.

<!-- @assert-absence target="src" symbol="process.stdout" exclude="src/cli.ts" reason="on an MCP connection stdout is the protocol, and one stray write corrupts it; only the command line's IO object touches it" -->
<!-- @assert-absence target="src" symbol="console." reason="console.log, console.info and console.debug all write to stdout" -->

**Each request is classified on its own**, by the rule the TypeScript SDK's
server applies (`classifyOpeningMessage` in `packages/server/src/server/serveStdio.ts`):

- A request whose `_meta` holds `io.modelcontextprotocol/protocolVersion` claims
  the modern era, whatever the value. The claim is validated, never ignored:
  - a missing `clientCapabilities` or a malformed field is -32602;
  - a version it does not serve is -32022, whose `data.supported` names **only**
    modern revisions.
- `initialize` without a valid modern claim is the legacy handshake. It settles
  on the version asked for if that is a legacy one, and otherwise counters with
  the newest legacy one. It never counter-offers a modern revision.
- A request with no claim is legacy.

The SDK pins a connection to the era it opened with; this server does not.
2026-07-28 permits a dual-era server to serve both on one process, and it is
stateless: nothing a legacy client did can change how a modern request is
answered.

| Era | Versions | Methods |
| --- | --- | --- |
| modern | `2026-07-28` | `server/discover`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read` |
| legacy | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` (the SDK's own list) | `initialize`, `ping`, and the same five |

**Result shapes follow the era.**
- A modern result carries:
  - `resultType: "complete"`;
  - `io.modelcontextprotocol/serverInfo` in `_meta`;
  - on the results 2026-07-28 requires it (discover, the lists, reads), `ttlMs: 0` and
    `cacheScope: "private"`.
  
  Zero, because rules are read fresh on every request, and a client serving an
  ADR edited a minute ago from its cache would be the drift this tool exists to
  catch.
- A legacy result is exactly what the SDK's golden test
  (`legacyDefaultServing.test.ts`) pins. `initialize` answers with
  `protocolVersion`, `capabilities`, `serverInfo` and `instructions` and nothing
  else, and no 2026 vocabulary reaches the wire.
- A missing resource is -32602 in the modern era, which forbids -32002, and
  -32002 in the legacy one.

**Two tools**, both annotated read-only, idempotent and closed-world:

- `get_architectural_rules(path, include_inactive?)` is the query.
- `check_architecture(paths?)` is a run. Without paths, every rule in force.
  With them, only the rules that govern them, each over its **whole** scope. A
  count, a cycle and a layer violation are all judged as CI judges them, which a
  run narrowed to the named files could not do. Each violation is marked with
  whether it lies in the paths given, so an agent can tell what it broke from
  what it found.

  The runner gained a `select` option for this. An unselected assertion is not
  executed, and is still resolved, so a malformed directive is an error whatever
  is selected.

A bad argument is a tool error the model can read, with `isError: true`. An
unknown tool or a malformed request is a protocol error. Each result carries the
data as `structuredContent` and a human rendering as its text. The specification
says the text SHOULD be the serialised JSON, "for backwards compatibility". It is
not, deliberately. The text is what a model reads, and the rendering is the same
data in a form that costs fewer tokens and misreads less often.

**Resources.** `spec://rules` is every rule in force as JSON, with the documents
not in force named. `spec://doc/{+path}` is any spec document. The list names the
documents in force and leaves the rest to the template, since some clients put a
resource list in front of a model wholesale. A URI is resolved by **membership**
in the spec set, never by joining it onto a path, so no URI can read anything the
spec patterns did not match.

<!-- @assert-import-absence target="src/mcp.ts" module="node:path" reason="a resource URI is never turned into a filesystem path; documents are found by membership in the spec set" -->

**Deliberately not implemented:**

- **Prompts.** The server's `instructions` say when to call each tool, which is
  what a prompt would have said.
- **`spec://adr/{id}`.** spec-guard does not know what an ADR is, only which
  Markdown the patterns match, and inventing an id scheme would be a guess about
  a naming convention.
- **Batches.** Only 2025-03-26 allowed them. The SDK does not accept them either.
- **Subscriptions and `listChanged`.** Nothing is cached, so there is nothing to
  invalidate.
- **Pagination.** Every list is complete; a cursor is refused with -32602.
- **Roots.** The root is `--root`, defaulting to the directory the client starts
  the server in.
- **Logging and completions.**

Cancellation suppresses the response. It does not stop a run already in progress.

### The command line

`query` and `mcp` are commands when, and only when, they are the first argument,
so `spec-guard -- query` still means a spec file called `query`. Both take specs
from `--spec`, which is repeatable. A plain run accepts `--spec` too, alongside its
positional patterns. An option that means nothing to a command is refused rather
than ignored, because `spec-guard query --strict` accepting the flag would tell
someone their query was strict.

<!-- @assert-layers target="src" order="src/rules.ts, src/specs.ts, src/runner.ts, src/query.ts, src/mcp.ts, src/cli.ts" reason="governance reads nothing, the query knows nothing of the protocol, and the protocol nothing of the command line" -->

## Consequences

### The budget: measured, and where it holds

The request set sub-20ms for a query. Every figure below was measured on one
Windows machine with 16 logical processors. Before and after were run
**interleaved** in one process, so that whatever else the machine was doing fell
on both alike. The final measurements were taken with the machine at 14-27% CPU.
Earlier runs of the same benchmarks, with other work holding it at 99-100%, came
out three to five times slower on both sides. The ratios held.

| Spec corpus | First cut of the query | This change |
| --- | --- | --- |
| this repository: 13 specs, 0.2 MB, 46 rules | 24.6 ms | **5.1 ms** (min 3.5) |
| 130 specs, 2.0 MB, 460 rules | 323 ms | **46.3 ms** |
| 1,300 specs, 19.7 MB, 4,600 rules | 3,104 ms | **498 ms** |

Once the rules are loaded, answering takes a fraction of a millisecond for this
repository and 6 ms for 3,800 rules, the second measured under load. The cost is reading the specs, and it grows
linearly with their size in bytes.

- **At project scale the budget holds**, in a server that is already running.
  `get_architectural_rules` took a median of 5.0 ms warm. `check_architecture` on
  one file ran the 17 of 46 rules that govern it in 31 ms. A full check took 185 ms.
- **A first call is closer to the line:** 16 ms quiet, and up to 47 ms under load.
- **A process never makes it.** Starting Node took a median of 153 ms here before
  spec-guard loaded a single module, and `spec-guard query` as a process took
  266 ms, 14.6 ms of it answering. No Node CLI answers in 20 ms, which is why the
  budget is really for the server.
- **The budget does not hold at 1,300 specs.** A repository with that many ADRs
  pays half a second per query.

Three changes produced the second column, each measured before it was made:

- **`maskCode` builds ranges instead of blanking a character array.** The array
  was `source.split('')`, one string per UTF-16 unit. Over this repository's
  202 KB of specs it took 7.8 ms, against 1.1 ms for the ranges. The output was
  identical on 72 real Markdown files and on 100,000 random inputs, compared
  against the previous build. `parseDocument` also reads directives, status and
  title with one mask, not two.
- **The spec glob no longer stats every file.** `walkFiles` is now `walkPaths`
  plus a stat, and spec expansion uses `walkPaths`. On 1,200 files in 100
  directories, expansion went from 102 ms to 18 ms: the stat took 105 ms of a
  walk whose directory reads took 21 ms. The engine still stats, because it needs
  file sizes.
- **Specs are read 16 at a time, in batches**, the engine's own read limit. One
  at a time took 0.9 s over 1,200 specs. Unbounded, the reads would risk `EMFILE`
  under the usual limit of 1,024 open descriptors.

An ordinary run benefits less than a query, because its time goes to searching
code: this repository's selfcheck went from 344 ms to 318 ms.

### What the tests found

**A rule whose every target is missing searched the whole repository.** With
`--allow-missing-targets` and no target left, the runner handed the engine an
empty target list. The engine reads an empty list, by contract, as the root, and
has done so since 0.1.0. So `@assert-count target="src/auth" symbol="verifyToken"
min="1"` kept passing after `src/auth` was deleted, as long as a test file still
said `verifyToken`. Import rules did the same, and a rule that forbids something
failed on matches from anywhere.

The 0.3.0 changelog described that behaviour as "search nothing, find nothing,
and report success". It was a search of everything. The equivalence test found it
on its first run over random trees, because a query's arithmetic, correctly,
governs nothing under a missing directory.

Such a rule now has an empty scope. It fails as one unless `allow-empty` or
`--allow-empty-scope` is set, and when allowed it finds nothing. When missing
targets are not allowed, an import rule says the target is missing, as a text rule
already did, instead of that its scope is empty.

That is a change in behaviour for anyone relying on `--allow-missing-targets`
alone with a rule whose only target is gone: it now fails, where it used to pass
by searching somewhere else.

### What is claimed, and how far

The server's messages are derived from the 2026-07-28 specification and schema.
The legacy results follow the TypeScript SDK's own golden tests, and the
classification follows its server's code. Both were read for this ADR and are
cited above.

The suite drives the handler message by message, the stdio binding byte by byte,
and the built binary over real pipes in both eras. It has **not** been run
against a shipping client. Doing that means launching one, and that was left to
the people who will configure one. If a client disagrees with what is here, this
ADR names the documents the disagreement should be checked against.

### Security

The server writes nothing to disk and opens no network connection. It reads
only:
- the spec files the patterns match, and a spec document only by membership;
- the tree under the root, when a check runs.

Paths are confined to the root. It trusts whoever launched it, as every stdio
server does.

## Alternatives considered

**A query that scans.** It would be exact about content, symlinks and case, and
it would cost what a run costs. `check_architecture` is that scan, offered
separately to an agent that wants it.

**Taking the SDK as a runtime dependency.** It would bring more than 13 MB and a
schema library, for a protocol whose server side here is eight methods and a
line reader.

**Content-Length framing.** Never MCP's.

**Pinning an era per connection, as the SDK does.** It needs state the stateless
revision does not ask for, and it would refuse a legacy `initialize` after a
modern request, which the specification permits a server to answer.

**Caching the rules in the server.** It would save milliseconds and serve a
stale answer. Reading the specs costs less than the model's time to read the
answer.

**Serialising JSON into the text content,** as the specification suggests. It
doubles what the model reads, and the text is the part it reads.
