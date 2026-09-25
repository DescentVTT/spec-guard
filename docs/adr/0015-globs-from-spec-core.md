# ADR-0015: Globs from spec-core, copied rather than depended on

## Status

Accepted (2026-09-26).

## Context

spec-guard compiled every glob to a `RegExp` in `globToRegExp`: `glob=`,
`exclude=`, `module=`, a layer in `order=`, a structure rule's `pattern=`,
`dirs=` and `required=`, and the spec patterns on the command line. Two things
were wrong with that, and neither was spec-guard's alone.

- **A regular expression backtracks.** `*-*-*-*-*-*x` compiles to six
  `[^/]*` groups, and against a 121-character file name that does not end in
  `x` V8 tries every way of dividing the name between them. It took 28 seconds.
  A glob is written by whoever writes a spec, and a spec runs unattended in CI.
- **Three tools had three engines, and they disagreed.** spec-brief,
  spec-graph and spec-guard each read globs their own way. Some of the
  differences were dialects on purpose - `exclude=` reads like `.gitignore` -
  and others were accidents: `**` inside a segment crossed directories here and
  not elsewhere, an unclosed `[` was a literal here and an error elsewhere.
  spec-core's ADR-0001 has the table.

spec-core is the family's answer: one engine, pure and total, with the dialects
named. Its `ripgrep` dialect is what `glob=` means here, and its `gitignore`
dialect is what `exclude=` means. It is a library with no package: each tool
copies the modules it uses, and verifies the copy by hash.

## Decision

### The copy

`src/vendor/spec-core/` holds spec-core's `pattern` module, the `path` module it
imports, and `jsonrpc`, copied from commit `124b028` by spec-core's
`scripts/vendor.mjs`. `VENDOR.json` records the commit and the SHA-256 of every
file. Nothing in this repository edits them.

<!-- @assert-present file="src/vendor/spec-core/VENDOR.json, tests/vendor.test.ts" reason="a copy nobody verifies is a fork nobody meant" -->

- **`tests/vendor.test.ts` recomputes every hash**, refuses a file the record
  does not name, and checks that the copy imports nothing but itself. A copy
  edited in place fails the build; the fix is a change to spec-core and a new
  copy, which arrives here as a diff someone reviews.
- **The copy is not mutated or measured here.** `stryker.config.mjs` leaves
  `src/vendor/**` out of `mutate`, which every shard inherits, and
  `vitest.config.ts` leaves it out of coverage. spec-core's sweep is the
  measurement, under a higher gate than this one. Counted here, a module this
  repository does not own would pad the score or dilute it, and a survivor
  could only be fixed in spec-core anyway.
- **`dependencies` stays empty.** Nothing is installed, bundled or fetched.
  ADR-0012's rule on `package.json` holds as it did.
- **The invariants read the copy as they read everything else in `src`.** It
  imports no `node:` module, spawns nothing, writes to no console, so the rules
  in ADR-0001, ADR-0012 and ADR-0014 hold for it unchanged. Two rules needed a
  change, and both changes say so where they are made: ADR-0001's `: any`
  matched `: anyDirectories(b)` in a ternary, which was a false positive in
  the rule rather than a loose type in the copy, and ADR-0013's rule that every
  module has a test of its own name leaves `src/vendor` out, since its tests
  are spec-core's.

### `jsonrpc` is copied and not yet used

spec-core's `jsonrpc` module was extracted from `src/mcp.ts` and generalised:
`createMcpServer({ name, version, instructions, tools, resources, prompts })`
and `serveLines`. Moving the server onto it was the plan, on one condition:
that `tests/mcp.test.ts` and `tests/mcp-stdio.test.ts` pass with every
assertion unchanged. They would not:

- `prompts/list` would answer an empty list. This server answers `Method not
  found`, and a test asserts it for both eras: the server has no prompts, and a
  client that asks is told so rather than handed an empty list.
- The message for an unknown tool argument lists what a tool takes with commas
  (`path, include_inactive`), where this server says `path and
  include_inactive`, and two tests assert the words.

So `src/mcp.ts` is unchanged. The first difference is a decision about the
protocol, not a detail of the port, and it belongs to whoever next changes the
server. The copy stays so that it can be made without another vendoring round.
