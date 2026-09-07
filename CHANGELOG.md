# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org), with the 0.x caveat that behaviour
may change in a minor release — each such change is listed under **Changed**
with the flag that restores the previous behaviour.

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
