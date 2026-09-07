# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org), with the 0.x caveat that behaviour
may change in a minor release — each such change is listed under **Changed**
with the flag that restores the previous behaviour.

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
