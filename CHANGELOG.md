# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org), with the 0.x caveat that behaviour
may change in a minor release — each such change is listed under **Changed**
with the flag that restores the previous behaviour.

## Unreleased

Writing down what the code already claimed. Every module was driven to its
honest mutation-testing ceiling, and the exercise turned up four wrong answers
rather than four missing tests — which is the argument for doing it at all.

### Fixed

- **Two assertions on the same symbol answered each other's comment handling.**
  The result cache keyed on the symbol, the targets and the search flags, but
  not on `comments`. A spec with `<!-- @assert-count symbol="X" ... -->` above
  `<!-- @assert-count symbol="X" ... comments="include" -->` returned whichever
  count ran first for both. The grouping test had the same omission, so the two
  were also merged into a single pass and the second was scanned with the
  first's mask. There is now one definition of "the same question", in three
  nested scopes, and the scope policy is part of it too.
- **An unreadable directory went unreported on a small repository.** The
  adaptive engine had the walk's skip ledger in hand and returned without it on
  any tree small enough to scan in process, so the same directory was a reported
  gap on a large repository and silence on a small one. Same tree, two answers,
  decided by its size.
- **Snippets from CRLF files carried a carriage return into the report**, which
  returns the terminal cursor to column 0 and overwrites the line just printed.
  The trim looked for `\r?\n` at the end of a line the caller had already cut at
  the newline, so it could never match.
- **A bad `regex="true"` pattern was reported as `Invalid regular expression:
  Invalid regular expression: /(/: ...`** — V8's message already says it once.

### Changed

- **Two requests differing only in `scope` are no longer merged into one
  search pass.** Reachable today only through the programmatic API, where a
  caller may build more than one `ScopePolicy` per run.
- `enumerateCandidates` takes a `WalkRequest` — a `SearchRequest` without the
  `symbol`, because a walk does not depend on one. Existing callers are
  unaffected; the symbol is now optional rather than required.
- `CachedEngine` declares `searchBatch` as present rather than optional, which
  `createCachedEngine` has always guaranteed.
- `KINDS` and `ALLOWED_ATTRIBUTES` are exported from the parser, so the
  directive grammar can be asserted rather than restated.
- **The mutation gate moves from 89 to 95**, against a CI measurement of 96.80%
  over 4,310 mutants. Every module is above 94%, where the spread ran from 83%
  to 95%. See [ADR-0003](docs/adr/0003-mutation-testing.md), which also records
  a Stryker limitation found on the way: a mutant that stops a test file
  *loading* is reported as survived even though the suite is killing it.

## 0.5.0

Import assertions covered one language, so a dependency rule pointed at a
directory of Go files did not fail - it passed, having analysed nothing. That is
the same defect 0.4.0 was written to remove, and this release closes the two
remaining shapes of it: a rule that cannot read the language, and a rule whose
scope holds no files at all.

### Added

- **Import assertions read Python, Go, Rust and C#**, alongside JavaScript and
  TypeScript. `import a.b` / `from .rel import x`, `import ( ... )` groups,
  `use a::{b, c}` with nested expansion, `using static` and `global using`, and
  the dynamic forms (`importlib.import_module`) that can only be reported.
  Not four new tokenizers: the comment and string lexer from ADR-0006 masks the
  source and the readers work on what is left. Tree-sitter measured 94 MB
  unpacked against this package's 0.33 MB. See
  [ADR-0008](docs/adr/0008-polyglot-imports.md).
- **`baseline` and `ratchet`** on the absence assertions, for adopting a strict
  rule on a codebase that already breaks it. `baseline="src/legacy/a.ts:2"`
  names the debt by file and count. The ratchet is two-sided: new violations
  fail, and so does an entry the code no longer supports, because a baseline
  that only grows is an `exclude` with extra steps. `ratchet="one-way"` relaxes
  the second half. See [ADR-0009](docs/adr/0009-debt-baselines.md).
- **`--print-baseline`** prints the attribute that would exempt today's
  violations, for a human to paste. It prints; it does not edit. That is the
  whole answer to `--fix`, and ADR-0009 argues it.
- **`--format sarif`** writes SARIF 2.1.0, which GitHub turns into an annotation
  on the offending line. One alert per broken rule, anchored on the code, with
  the directive as a related location and a fingerprint that survives the code
  moving. `--json` is unchanged and is now also `--format json`.
- **`allow-empty` and `--allow-empty-scope`**, for the rules where covering
  nothing is the honest state of the world.
- **`baselinedMatches`, `staleBaseline` and `fileMatches`** on each result in
  `--json`.

### Changed

- **An assertion that inspected no files now fails.** A rule whose scope holds
  nothing passes every time and reads in the report exactly like a rule that
  inspected a thousand files and found nothing. The usual causes are a `glob`
  matching no extension in the tree, an `exclude` that swallowed the target, or
  an emptied directory. **If a run starts failing this way, the rule was
  covering nothing before it started failing;** `allow-empty="true"` on the
  directive, or `--allow-empty-scope` for the run, restores the old behaviour.
- **An import assertion fails when nothing in scope is in a language it can
  read**, rather than reporting "analysed 0 of 12 files" in a warning and
  passing.
- **`.py`, `.pyi`, `.go`, `.rs`, `.cs` and `.csx` files are now analysed** by import
  assertions rather than counted as skipped, so a rule over a polyglot tree
  starts finding dependencies it previously reported as unanalysable.
- **Mutation testing in CI runs in two tiers**: incremental on branches,
  a full authoritative sweep on `main` and nightly. The gate stays at 85 in
  both. See [ADR-0003](docs/adr/0003-mutation-testing.md).

### Fixed

- `excludeFiles` was applied after enumeration rather than during it, so an
  excluded spec file counted towards a budgeted walk. Only reachable through the
  adaptive engine's probe, where it could make a tree look larger than the file
  set actually being searched.
- The README described the safe-batching apparatus - containment and
  dovetailing checks before merging literals into a ripgrep alternation - as
  current behaviour. It was deleted in 0.4.0 when ripgrep became a pre-filter.

## 0.4.0

An audit found spec-guard reporting a clean pass on a repository that contained
the forbidden symbol. On a tree with eight copies of one token, the scanner
found two and ripgrep found four, and neither said anything about the rest.

### Changed

- **Hidden directories are searched.** `.github`, `.husky`, `.claude-rules` and
  `.agents` hold CI, hooks and agent rules, and both engines skipped them
  entirely - so an absence assertion passed while the forbidden thing sat in a
  workflow file.
- **The skip list is now four names**: `.git`, `.hg`, `.svn`, `node_modules`.
  `dist`, `build`, `out`, `coverage`, `.next` and eight others are searched,
  because spec-guard cannot tell build output from a directory of build scripts,
  and guessing wrong means a rule silently covers nothing. **If a run starts
  failing on your build output, that is this change, and the fix is to say so:**

  ```md
  <!-- @assert-absence target="." symbol="TODO" exclude="dist coverage" -->
  ```

- **`.gitignore` is no longer consulted.** It describes what git should carry,
  not what a rule covers - and ripgrep applies it only inside a git repository,
  so the same tree gave different answers depending on whether a `.git`
  directory existed above it.
- **Binary files are searched, and a match in one is reported** rather than
  dropped. It is not counted as a violation, but it is no longer invisible.
  "Binary" now means "contains a NUL byte" for both engines; the scanner used to
  look only at the first 8KB, which disagreed with ripgrep on files whose first
  NUL came later.
- **`--strict` fails when a file could not be inspected**, which now has a
  precise meaning: unreadable, or binary and containing the symbol.
- **The engines are one implementation.** ripgrep now answers only *which files
  contain this text*; the scanner does all counting, comment classification,
  binary handling and reporting for both. `--engine` changes how long a run
  takes, not what it concludes. See [ADR-0007](docs/adr/0007-search-scope.md).

### Added

- **`--no-default-skips`** to search even those four directories.
- **`skipped`** on each result in `--json`: what was not inspected, and why.

### Removed

- `DEFAULT_IGNORED_DIRECTORIES`, `canBatchLiterals`, `shouldBatchPatterns`,
  `createRipgrepSink` and `byteColumnToCharacter` from the public API. All of
  them existed to make ripgrep's own counting trustworthy; as a pre-filter it
  does not count, so pattern batching no longer has to be proved safe and
  ripgrep's byte columns no longer need converting.

### Fixed

- ripgrep's per-file errors are no longer discarded. `--no-messages` meant a
  file that could not be opened produced no match, no error, and no way to tell
  it apart from one that was read and found clean.
- `comments="include"` no longer changes whether binary files are searched. An
  attribute about comments decided that, because it selected a different code
  path through the engine.

## 0.3.0

### Added

- **`exclude` attribute.** Most real rules are "nowhere except one place", not
  "not here": `exclude="src/config/**"` expresses that in one assertion instead
  of a hand-maintained list of every directory that is not `src/config`. Follows
  gitignore semantics — deliberately different from `glob`'s basename matching —
  and a parity matrix asserts both engines agree.
- **Import assertions:** `@assert-import-absence` and `@assert-import-count`.
  "The UI layer must not depend on the database layer" is a dependency claim,
  not a text claim, and approximating it with a string search fails in both
  directions. A zero-dependency tokenizer resolves `import`, `export … from`,
  `import type`, dynamic `import()` with a literal, and `require()`. Module
  references it cannot resolve statically are reported, never counted as clean.
  See [ADR-0005](docs/adr/0005-import-assertions.md).
- **`comments` attribute.** See Changed, below.
- **`--allow-missing-targets`** to restore the previous handling of a `target`
  path that does not exist.
- **`commentMatches` and `unclassifiedFiles`** on every result in `--json`.

### Changed

- **Matches inside comments no longer count**, so the note recording that a
  symbol was deleted is no longer read as an occurrence of that symbol. This is
  the defect where documenting a decision defeated the assertion enforcing it.
  Comment syntax is known for 59 extensions across 9 families; strings are
  tracked too, since `//` inside a URL is not a comment. Where classification is
  uncertain the text counts as code, and every run reports how many matches it
  excluded — a pass caused by comment exclusion is never silent.
  `comments="include"` restores counting per assertion.
  See [ADR-0006](docs/adr/0006-comment-classification.md).
- **A `target` path that does not exist now fails the run** instead of warning
  and searching what remained. An assertion pointed at a renamed directory used
  to search nothing, find nothing, and report success. `--allow-missing-targets`
  restores the old behaviour.
- **`--strict`** now means "treat analysis that could not be completed as a
  failure" — it no longer carries the missing-target meaning, which is now the
  default.

### Fixed

- `search()` on the ripgrep engine was not comment-aware while `searchBatch()`
  was, so a spec containing exactly one assertion kept its comment matches.
- The two engines reported different columns for the same match on a line
  containing non-ASCII text: ripgrep counts bytes, the scanner counts
  characters, and editors count characters. ripgrep's column is now converted,
  so a reported location points at the match in both engines.
- Leftover `*.test.ts` files in scratch fixture directories were collected by
  Vitest, breaking a run with "no test suite found" because of debris from a
  previous one.

### Notes

The version in `package.json` was bumped to 0.3.0 during development but never
published; npm went 0.1.0 -> 0.2.0. Everything above ships together as the
first published 0.3.0.

## 0.2.0

### Added

- **Adaptive engine selection.** `--engine auto` now measures rather than
  guesses: a budgeted, stat-only enumeration decides whether a tree is small
  enough for the JavaScript scanner to beat a ripgrep process spawn. The probe
  is the work — the enumeration it performs is reused by the scanner, so
  choosing costs nothing when the scanner wins.
  See [ADR-0004](docs/adr/0004-adaptive-engine.md).
- **Mutation testing** with Stryker, wired into CI on every push, plus the tests
  that closed the gaps it exposed. See [ADR-0003](docs/adr/0003-mutation-testing.md).

### Changed

- Published as `@descent-vtt/spec-guard`. The binary is still plain
  `spec-guard`.

## 0.1.0

Initial release: `@assert-absence`, `@assert-count` and `@assert-present`,
written as HTML comments that are invisible in every Markdown renderer. ripgrep
primary with a pure-JavaScript fallback of identical semantics, safe assertion
batching, `--json`, and exit code 2 for "spec-guard could not run" as distinct
from "your specs failed".
