# CLAUDE.md

Working agreements for this repository. Short on purpose: the ADRs in
`docs/adr/` carry the reasoning, `CONTRIBUTING.md` carries the map, and
spec-core's [ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)
is the contract every spec-* tool keeps.

spec-guard makes the claims Markdown specs and ADRs make about a codebase
executable. Directives written as HTML comments (`@assert-absence`,
`@assert-count`, the import, layer, cycle and structure rules, `@assert-present`)
are checked against the tree in CI, by ripgrep or a built-in scanner that give
one answer. Around them: `query` and an MCP server (which rules govern a
path), `prove` (can each rule fail), `cites` (do code comments cite decisions in
force) and `impact` (what depends on a path). It is published as
`@descent-vtt/spec-guard`, and it checks its own ADRs and README.

## Invariants

These are not preferences. Breaking one is a decision that needs an ADR.

- **Zero runtime dependencies.** `package.json` has no `dependencies`. ripgrep
  is optional and found on `PATH`; `@vscode/ripgrep` is a devDependency so CI
  exercises that path everywhere.
- **`src/vendor/` is spec-core's.** The Markdown scanner, the glob automata and
  the rest are copied byte for byte and held to their hashes by
  `tests/vendor.test.ts`. Never edited here: change spec-core and run its
  `scripts/vendor.mjs --into` ([ADR-0015](docs/adr/0015-globs-from-spec-core.md)).
- **I/O stays at the edges**, and this repository's own specs hold it
  ([ADR-0001](docs/adr/0001-invariants.md)): the CLI writes through the
  injected `CliIO`, only `src/engine.ts` spawns a process, and the parser and
  the reporter never touch the filesystem. Every read a run makes goes through
  one `Io`, which is what `prove`, a watch session and a caller's in-memory
  tree stand on.
- **Nothing goes quiet.** A skip is requested or reported
  ([ADR-0007](docs/adr/0007-search-scope.md)); a missing target and a scope
  that holds no files fail; a match in a file of unknown syntax counts as code
  ([ADR-0006](docs/adr/0006-comment-classification.md)); a status word
  spec-guard does not know keeps its document in force, so a document never
  goes dark by accident ([ADR-0010](docs/adr/0010-spec-status.md)). A false red
  is visible and has a fix; a false green is a lie.
- **No glob becomes a `RegExp`.** Every pattern is read by spec-core's
  automata, which cannot backtrack ([ADR-0015](docs/adr/0015-globs-from-spec-core.md)).
- **A run that cannot be trusted exits 2**: bad usage, a malformed
  configuration, no spec matched. Never fall back to defaults and report clean.
- **Native ESM, TypeScript 7, Node >= 22.** `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, no `any`
  and no `@ts-ignore` in `src/` (ADR-0001 holds both).
- **LF line endings** (`.gitattributes`): a CRLF after the shebang makes
  `bin/spec-guard.js` unrunnable on Linux.

## Verification

All of these pass before anything is called done.

```bash
npm run lint       # tsc --noEmit
npm test           # vitest
npm run build      # tsc -> dist/, which the selfcheck runs
npm run selfcheck  # spec-guard executes this repository's own specs
node ./bin/spec-guard.js prove  # CI: every rule is seen to fail
node ./bin/spec-guard.js cites  # CI: every ADR the code's comments cite is in force
```

The selfcheck reads the specs `package.json` names, `docs/**/*.md` and
`README.md`, so a directive added, moved or deleted there changes what it
executes: say so in the pull request.

**Mutation testing runs only in GitHub Actions**, in `mutation.yml`: an
incremental sweep on every pull request, the full sweep on main,
both gated by the `break` in `stryker.config.mjs`. Do not run Stryker locally.
For new or changed code, replay its likely mutants by hand: write the mutation
into the source, run the test files that cover it, watch one fail, restore the
source. A test file that fails to load counts as a survivor
([ADR-0003](docs/adr/0003-mutation-testing.md)).

Vitest is pinned to 4 by that ADR, and stays there while Stryker's runner
runs no test against a mutant on 5: a sweep then reads a few percent, and a
pull request's incremental sweep does not notice. Dependabot proposes no
major of it, the ADR's assertion fails one made by hand, and its amendment
of 2026-10-07 says what lifts the pin.

The mutation `break` and the coverage floors in `vitest.config.ts` sit below
the last measurement. They move up with the measurement and never down to make
a change pass.

Run a tool through `npm run <script>` or `npx --no-install <tool>`, never a
bare `npx <name>`: before `npm ci` that fetches whatever the registry has
under the name. `.npmrc` has npm stop there instead, and `tests/npm.test.ts`
holds both. One of the family's own tools takes its package's full name
(spec-core's
[ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md#names),
Names).

## Testing

- **New behaviour needs a test that fails without it**, and a new heuristic a
  test for the case that must **not** match - those are the ones that matter.
- **Assert decisions, not shapes.** A test states behaviour a caller can
  observe, taken from the README, an ADR or a documented message. Padding the
  mutation score with assertions that restate the implementation is worse than
  a lower number.
- **A genuinely equivalent mutant gets no test** and a comment beside the code
  saying why.
- **A test that writes to disk uses `makeTempRepo`** from `tests/helpers.ts`,
  which makes its tree under `tests/fixtures/.tmp` in a directory named for
  the process, and never changes a shared fixture: Stryker runs one test file
  in several workers at once. A test that need not touch the disk reads an
  in-memory tree through `memoryIo`.
- **Some tests read the README.** `tests/package.test.ts` requires every link
  to a file the package does not ship to be an absolute GitHub URL, and
  `tests/spec-status.test.ts` reads the `--ignore-status` row of the options
  table. Fix the README, not the test.

## Versions and releases

Versions follow spec-core's
[ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md):
before 1.0, a minor for anything that can turn a passing run red or change what
a script reads, a patch for what reports less, crashes, performance and
documentation. A change a user can see gets a `CHANGELOG.md` entry under
`## Unreleased`, a sentence or two with an `Upgrading:` line under **Changed**,
and an ADR amendment where the ADR records the behaviour.

A release ([ADR-0019](docs/adr/0019-releases-are-staged-by-ci.md)):

1. Merge the pull requests, each with its changelog entries.
2. Wait for main's full mutation sweep, and replay every survivor it has that
   the last release did not: killed, deleted, or shown equivalent with a
   comment at the code and a record in ADR-0003.
3. Commit `release: <x.y.z>` on main: the version, `## Unreleased` renamed, and
   the sweep's figures in the README and in a new section of ADR-0003.
4. Tag it `v<x.y.z>` and push. CI stages the version on npm with provenance.
5. The maintainer approves it with a second factor.

Merging, tagging and approving are the maintainer's calls. Never run
`npm publish`: `prepublishOnly` refuses outside GitHub Actions.

## Prose

Comments explain *why*, never *what*. If a comment restates the line below it,
delete one of them. No exclamation marks, no hedging, no apologising for the
code. The same goes for diagnostics, hints and commit bodies. Commit subjects
follow the history: `fix: ...`, `feat: ...`, `docs: ...`, `test: ...`,
`ci: ...`, `release: <x.y.z>`.
