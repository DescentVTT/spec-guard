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
imports, and `jsonrpc`, copied by spec-core's `scripts/vendor.mjs`: first from
commit `124b028`, then again from `f085f29`, which changed `jsonrpc` alone, for
the server (below). A third copy, from `4f2826a`, added `markdown` and the
`text` module it imports, for the parser, and left the other three byte for
byte as they were ([ADR-0002](0002-directive-format.md)'s amendment). A fourth,
from `cbe2223`, changed `pattern` and `markdown`: two stars inside a name and
an extended glob are refused as below, and the scanner reads a list item's
columns. A fifth, from `8840d36`, changed `markdown` alone: an image inside a
link's text is listed after the link, and links, list items and the directives
mask are made the first time each is read. A sixth, from `119345e`, changed
`pattern` and `markdown`: the refusal of two stars inside a name writes its
advice from the pattern, as below; a link inside a link's text is read as the
link, as CommonMark reads it; and the scan says which element an HTML block
opens with, and when front matter opens and never closes. A seventh, from
`65ef842`, changed `markdown` alone, and only in how it reads links: a link
reference definition no longer interrupts a paragraph, a definition's label
holds no unescaped bracket and at most 999 characters, and a second bracket
that is no label leaves the first read as a shortcut, each as CommonMark has
it. Nothing here reads a scan's links, so nothing spec-guard reports changed
with it. An eighth, from `f9ce375`, changed `pattern`, and `markdown` and
`text` in comments only: a trailing `/` on a brace alternative is read as it
is on the alternative written alone, and a pattern past the automaton's state
ceiling is refused with a reason rather than thrown. Both reach what a user
sees, and the two amendments of 2026-09-28 below say how. `VENDOR.json`
records the commit and the SHA-256 of every file. Nothing in this repository
edits them.

spec-core's `LICENSE` lies beside the copies, and `package.json` names it in
`files`: the package carries spec-core's compiled code under
`dist/vendor/spec-core`, and MIT asks that the notice travel with it.

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

### `jsonrpc`: copied first, used once it agreed

spec-core's `jsonrpc` module was extracted from `src/mcp.ts` and generalised:
`createMcpServer({ name, version, instructions, tools, resources, prompts })`
and `serveLines`. Moving the server onto it was the plan, on one condition:
that `tests/mcp.test.ts` and `tests/mcp-stdio.test.ts` pass with every
assertion unchanged. At `124b028` they would not:

- `prompts/list` would answer an empty list. This server answers `Method not
  found`, and a test asserts it for both eras: the server has no prompts, and a
  client that asks is told so rather than handed an empty list.
- The message for an unknown tool argument lists what a tool takes with commas
  (`path, include_inactive`), where this server says `path and
  include_inactive`, and two tests assert the words.

The first is a decision about the protocol rather than a detail of the port,
so it was made in spec-core rather than here, and `f085f29` made both: a
method for a capability the server did not declare is answered as any unknown
method is, and a list of arguments ends in "and". With that copy `src/mcp.ts`
keeps what is spec-guard's - its instructions, its two tools, the rules and
documents it serves - and hands the protocol to `createMcpServer` and
`serveLines`: classifying each request, the two eras, dispatch, the shape of
each result, and the stdio framing. Every test of the server passes as it was
written. The protocol's names the module exported are re-exported from the
copy, so a caller of the API finds them where it did.

<!-- @assert-import-count target="src/mcp.ts" module="src/vendor/spec-core/jsonrpc" min="1" reason="the server speaks the protocol through spec-core's copy" -->
<!-- @assert-absence target="src" symbol="'2026-07-28'" exclude="src/vendor" reason="the revisions served are named once, in the copy; a second list is a second protocol" -->

Two behaviours came with the copy. A tool that throws is reported to the model
as `spec-guard failed: ...` by the copy, as it was by the server, and a path
outside the root - the model's to fix - is still caught first and reported
alone. And the line reader flushes its decoder when the input ends, so a last
line cut inside a UTF-8 character is read as far as it goes rather than
dropped.

### Every pattern is read by spec-core, in a named dialect

`src/glob.ts` is still where spec-guard reads a pattern, and it hands every one
to spec-core's `parseGlob`, case-sensitively on every host. Directory walking
and the scope policy stay in spec-guard, as spec-core's ADR-0001 says they
should: they are what makes each tool's scope its own.

| Pattern | Dialect | What that means |
| --- | --- | --- |
| `glob=`, a structure rule's `pattern=`, a spec pattern | `ripgrep` | no `/`: a file name at any depth; a `/`: the whole path |
| `glob=` with a leading `/` | `path`, the slash dropped | anchored at the root, as ripgrep reads `-g /src/*.ts` |
| `exclude=`, `module=`, a layer in `order=` | `gitignore` | a path or any directory above it; anchored when it holds a `/` anywhere but at its end |
| `dirs=`, a required entry's name | `path`, a literal naming one path | the whole path below a target, or a name in a directory |

A spec pattern is walked from its literal base and matched below it, so a base
outside the root, `../shared/docs/*.md`, or on a drive, `C:/repo/docs/*.md`,
is never read as a glob. spec-core refuses `..` in a glob, as it should, and
spec-guard has always found specs outside the root.

<!-- @assert-import-absence target="src" module="src/vendor/spec-core/pattern" exclude="src/glob.ts, src/vendor" reason="one module reads patterns, so every attribute has one reading and one place to change it" -->
<!-- @assert-absence target="src" symbol="globToRegExp(" exclude="src/glob.ts" reason="no pattern a spec supplies is compiled to a RegExp, which can backtrack" -->

`globToRegExp` stays exported, marked deprecated, because callers of the API
may use it. Nothing in `src` calls it. `tests/glob-core.test.ts` rebuilds the
two matchers it used to drive and holds spec-core to them on every path of a
generated universe, for every pattern the two read alike, and to the
differences below, so the adoption changed exactly what this ADR says it did.

### What a user sees change

- **A malformed pattern is refused.** An unclosed `[` or `{`, an extended glob
  such as `+(a|b)` - a group holding a `|`, since `C++(notes).md` and
  `*(2017).md` are names with parentheses in them, as ripgrep and `.gitignore`
  read them - a `..`, a range that runs backwards: a directive holding one
  is an invalid directive, and one given in the configuration or to `--exclude`
  is exit 2, as a spec pattern on the command line is. Each used to be read as a
  literal, or as whatever the regular expression it compiled to happened to
  mean, and a typo read as a literal is a filter that matches nothing and passes.
  `module=`, `order=`, `pattern=`, `dirs=` and `required=` were not validated at
  all, and are now.
- **`**` inside a name is refused.** `docs/**.md`, `src/**.ts`, `**.ts` and
  `a**b` are each told that `**` means any number of directories only as a
  whole segment, with the two ways to say what was meant, written from the
  pattern - the first for any depth, the second for one level: `docs/**/*.md`
  or `docs/*.md`, `src/**/*.ts` or `src/*.ts`, `**/*.ts` or `*.ts`,
  `a*/**/*b` or `a*b`. The RegExp crossed directories there and
  ripgrep did not, so the same rule counted differently on either side of the
  size where `auto` changes engine. The first copy of spec-core read it as
  `*`, which is how `.gitignore` and bash read it, and that was the worst of
  the three: `"specs": ["docs/**.md"]` stopped finding every nested ADR, and a
  run that had failed on one of them passed, one spec fewer, with nothing said.
  A reading every tool shares is not available, so none is guessed at.

  A refusal is only loud where it is asked for, so every door asks. A spec
  pattern in the configuration's `specs` is refused where the file is read,
  naming the file and the key, and one on the command line - positional or
  `--spec` - before any command starts, so `query`, `impact`, `cites`,
  `prove`, `mcp` and a watch session refuse it as a run does rather than each
  answering from fewer documents. Both are exit 2, as `exclude` in the
  configuration and `--exclude` are. In a directive, `glob=`, `exclude=`,
  `module=`, `order=`, `pattern=`, `dirs=` and `required=` make it invalid,
  exit 1, in a document not in force as in one that is. `specPatternError` is
  the check, in the words `expandSpecPatterns` throws.

  **Amended 2026-09-27.** Until the copy from `119345e` every such pattern was
  told `docs/**/*.md` or `*.md`, whatever it was, so `src/**.ts` was told to
  write two patterns for Markdown. spec-core now writes the two from the
  pattern it is given. A spec pattern is walked from its literal base,
  and spec-core is given only what is below it, so `specPatternError` puts the
  base back in front of each pattern the advice names: `docs/**.md` in `specs`
  is told `docs/**/*.md`, where the part below `docs` alone would be told
  `**/*.md`, every Markdown file in the repository; and `../shared/docs/**.md`
  is told `../shared/docs/**/*.md`, which spec-core, refusing the `..`, could
  not have written.
- **No pattern takes long.** spec-core's automaton keeps a set of live states,
  so a match costs the pattern's size times the path's length. `*-*-*-*-*-*x`
  against a name of 121 dashes took **55 seconds** under the RegExp, measured on
  this repository's Windows machine with Node 24.18.1 (28 seconds in spec-core's
  measurement). It now takes under a millisecond, and a test bounds it at a
  second, in the matcher and in a run.
- **A list attribute splits on commas**, as it always did, so a brace group with
  a comma in it cannot be written in a directive: `glob="*.{ts,tsx}"` was
  always `*.{ts` and `tsx}`, two literals to the scanner and an error to
  ripgrep. It is now refused, and the message says why and to list the patterns
  instead. A configuration's `exclude` is a JSON array, where a brace group
  keeps its commas.
- **A `.` or empty segment is no segment**, so `src/./a.ts` means `src/a.ts`.
  It used to match nothing under either engine.
- **A leading `/` anchors a `glob=`** at the root, as it anchors an `exclude=`.
  ripgrep always read it so; the scanner matched nothing.
- **An alternative that names no path is refused.** `{dist/**,}` is an ordinary
  typo whose empty alternative matched the empty string. Only the loop that
  tested a path's ancestors stopping short of the empty one kept it from
  excluding the whole tree.
- **Amended 2026-09-28: a trailing `/` on a brace alternative means what it
  means on the alternative written alone.** Until the copy from `f9ce375`
  spec-core read the slash only at the end of the whole pattern, so inside
  braces it was dropped and the alternative named the directory itself.
  spec-core now reads each alternative as it reads it written alone (its
  ADR-0003's amendment of this date): `src/` is the directory's contents to
  `glob=`, a spec pattern and `dirs=`, and, as before, the directory with
  everything in it to `exclude=`, `module=` and a layer. A directive's list
  attribute splits on the comma, so only a spec pattern - on the command line
  or in `specs` - `dirs=`, which is one pattern, and a caller of the API can
  write such a group with two alternatives.

  | Pattern | Until `f9ce375` | Now |
  | --- | --- | --- |
  | spec pattern or `glob` `{src/,*.md}` | a `.md`, and a file named `src` at any depth | a `.md`, and everything under `src`; not `lib/src` |
  | spec pattern `docs/{adr/,a.md}` | `docs/a.md`, and a file named `docs/adr` | `docs/a.md`, and everything under `docs/adr` |
  | `dirs="{a/,d}"` | `a` and `d` | every directory below `a`, and `d` |
  | `exclude` `{build/,dist}` | `build` and `dist` at any depth, with what they hold | the same |

  A slash that ends the whole of `dirs=` is still dropped, as the attribute
  always dropped it, so `dirs="a/"` chooses `a`. spec-guard's own readings had
  to follow spec-core's. `patternShape` counted `{src/,*.md}` as one segment in
  every alternative and answered `src/a.ts` by its last segment, `a.ts`: no,
  where spec-core says yes. And `ripgrepGlobs` handed ripgrep `src`, which it
  matches against a file of that name at any depth and never against what the
  directory holds. Both now read such an alternative as `src/**`, so the
  shortcut, the globs ripgrep is handed and spec-core agree on the universe
  below for eight more patterns, and `tests/glob-parity.test.ts` states the
  files five more shapes find under each engine, and that an exclusion is
  unchanged.
- **Amended 2026-09-28: a pattern too large to compile is refused as a
  malformed one is.** spec-core refuses braces that expand to more than 256
  patterns, and a pattern whose automaton would pass 65,536 states: a literal of
  65,536 characters is one. Until the copy from `f9ce375` it threw the second.
  A spec pattern on the command line or `--spec` ended the process with a stack
  trace and exit 1, `--exclude` printed `AutomatonTooLarge:` above the usage,
  and a directive, the configuration and a `cites` files template gave the
  reason alone, naming neither the pattern nor where it was written. Every door
  now refuses it as it refuses a pattern it cannot read, with spec-core's
  reason: `invalid glob pattern "<pattern>": the pattern compiles to more
  than 65536 states`. A directive holding one is invalid, exit 1, and one on
  the command line, in `specs`, `exclude` or `cites` in the configuration, or
  given to `--exclude` is exit 2.

### Both engines, one reading

ADR-0014 gave ripgrep the pattern as the scanner normalised it, and a parity
matrix held the two to each other. Normalised is not read. ripgrep's globset
parses the same syntax as spec-core, and with `@vscode/ripgrep` 1.18.0
(ripgrep 15.0.0) it still read these differently from the scanner:

| Pattern | Scanner | ripgrep, given the pattern as normalised |
| --- | --- | --- |
| `glob="{src/*.ts,*.md}"` | `src/*.ts`, and a `.md` at any depth | the root's `.md` only: globset anchors a glob holding a `/` anywhere |
| `glob="{,src/}a.ts"` | `a.ts` at any depth, and `src/a.ts` | `src/a.ts` only |
| `glob="src/./a.ts"`, `glob="src//a.ts"` | `src/a.ts` | nothing |
| `glob="}a.ts"` | the file `}a.ts` | an error: an unopened alternate group |
| `exclude="{src/tests,*.log}"` | `src/tests`, and a `.log` at any depth | `src/tests`, and the root's `.log` |
| a target that is a file, `glob="*.md"` | nothing | the file, whatever its name |
| a target inside `exclude="tests"` | nothing | everything under it |

The last two are not about syntax. ripgrep applies no glob to a path it is
handed on its command line, only to what it walks into.

Two decisions close them, and `tests/glob-parity.test.ts` states the files each
shape must find, under each engine:

- **ripgrep is handed spec-core's reading, spelled for globset.**
  `ripgrepGlobs` expands a pattern's braces into one glob per alternative, as
  spec-core expands them; reads a trailing `/` on each as the kind of pattern
  reads it (amended 2026-09-28, above); drops `.` and empty segments; writes a
  lone `}` as the class `[}]`; and anchors each alternative, or not, by its own
  shape - a leading `/` where it must be anchored and `**/` where an
  alternative starting with `!` must not become a negation.
  `tests/glob-core.test.ts` holds that spelling, and the matchers' segment
  shortcut, to spec-core's own answer for the whole path on every path of a
  universe of 3,615, for 36 patterns chosen for each piece of syntax, and the
  parity tests hold ripgrep to the same reading on a real tree. Removing the
  spelling fails six of them.
- **ripgrep's list is held to the scanner's filters.** A file ripgrep names is
  kept only if `glob` admits it and no `exclude` does, which is the question the
  walk asks of every file it finds. ripgrep still prunes what it can, which is
  where its speed is; it no longer decides what is in scope. Removing the
  filter fails the three cases about targets.

Where the two could still differ, the filter makes ripgrep's reading only ever
the wider one, and a wider pre-filter costs a file read, never a count.

### What it costs

A Thompson automaton pays for a set of live states on every character, where
V8 compiles a RegExp to machine code. Asked of every path, the matching was 26
times slower: 261 ms against 10, over the 10,446 paths in this repository's
`node_modules`, for three globs and four exclusions. `globPredicate` asks the
automaton less often, and never answers for it:

- a pattern that is one segment in every alternative - `*.ts`, `tests`,
  `node:fs`, the shapes most rules use - is decided by a path's last segment
  (a glob) or by any one of its segments (an exclusion), and a tree repeats its
  names: those paths hold 6,714 distinct segments. Each is asked once;
- any other pattern can only match below the directories spec-core names as its
  `bases`, and a path outside all of them is answered without asking.

The same seven patterns then took 83 to 95 ms, nearly all of it for
`**/dist/**`, which is neither. A whole run over `node_modules` with three
rules, scanner only, in five alternating rounds against the previous commit:
a median of 2,250 ms against 2,116, and a best of 1,297 against 1,507, which is
this machine's noise. The counts were identical.

Building a reading costs too, and a query paid it over and over, which this
measurement of matching did not see. Each rule's patterns were read when its
directive was resolved and again each time a query asked whether the rule
governs a path, and the configuration's exclusions once for every rule, on
every request: at 1,300 specs that was two fifths of what the MCP server spent
on a warm query. Since 2026-09-27 each pattern is read once and its reading
kept, up to 4,096 of each kind, which about halves a query at every size;
[ADR-0012](0012-query-and-mcp.md)'s amendment of that date has the
measurement.

### Held to the mutation bar

Stryker over `glob.ts` and the lines of `engine.ts` this changed: every mutant of
the new reading is killed, or times out in the loop that finds a brace's
close, but two. Both are equivalent by spec-core's own reading of its options:
`dialect: ''` and `literal: ''` fall through to exactly what `path` with
`literal: 'file'` means, a literal naming one path. The brace expander was
first written over characters, as spec-core's is, and the module scored 94%,
with 25 survivors in the expander alone. Its loops read one past the end with
`charAt`, which answers the empty string, so `<=` for `<` decided nothing, and
its class scanner had branches only a malformed pattern reaches, which never
gets that far. Rewritten over tokens, with a class as one token, it has
neither.
