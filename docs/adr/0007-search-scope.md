# ADR-0007: One scope, and no silent skips

## Status

Accepted (0.4.0).

## Context

An audit of 0.3.0 found that spec-guard would report a clean pass on a
repository that contained the forbidden symbol. Not by miscounting - the counts
were correct for the files it read - but by not reading the files.

The reproduction is worth writing down exactly, because the shape of it is the
whole argument. A tree with eight copies of one token:

| file | 0.3.0 scanner | 0.3.0 ripgrep |
| --- | --- | --- |
| `src/a.ts` | found | found |
| `ignored/c.ts` (in `.gitignore`) | found | **skipped** |
| `dist/d.ts` | **skipped** | found |
| `node_modules/pkg/e.ts` | **skipped** | found |
| `.github/workflows/ci.yml` | **skipped** | **skipped** |
| `.husky/pre-commit` | **skipped** | **skipped** |
| `.hidden.ts` | **skipped** | **skipped** |
| `blob.dat` (binary) | **skipped** | **skipped** |
| **total** | **2** | **4** |

Two engines, one tree, two different answers, and both of them wrong. Nothing
in the output said so.

Four independent mechanisms produced that, and they had nothing in common
except the habit of skipping quietly:

1. **Hidden paths.** The walker skipped any name starting with `.`, and
   ripgrep skips hidden files unless told otherwise. `.github`, `.husky`,
   `.claude-rules` and `.agents` are where a modern repository keeps its CI,
   its hooks and its rules for coding agents. That is code, and it was
   invisible to both engines.
2. **A hardcoded name list.** The walker skipped seventeen directory names
   (`dist`, `build`, `coverage`, `.next`, ...). ripgrep skipped none of them.
3. **`.gitignore`.** ripgrep honoured it; the walker did not. Worse, ripgrep
   honours it *only inside a git repository*, so the same directory answered
   differently depending on whether a `.git` existed above it. The fixture for
   this ADR found four matches in one location and one in another, with
   identical contents.
4. **Binary files.** The scanner skipped anything with a NUL in its first 8KB.
   ripgrep reported matches in binaries. And because 0.3.0 routed ripgrep
   through the scanner whenever comments were classified, `comments="include"`
   - an attribute about *comments* - decided whether *binary files* were
   searched.

## Decision

### Scope is one policy, and both engines are driven by it

`src/scope.ts` owns the question "what may be looked at". The walker consults
it; the ripgrep argument list is generated from it. There is no second place
where a file can be dropped.

The default policy skips four names:

```
.git  .hg  .svn  node_modules
```

That is the whole list, and each entry earns its place by being somewhere a
match would mislead rather than inform. A version-control object store holds
compressed copies of code that was deleted on purpose - finding `LegacyThing`
there means the deletion worked. A dependency tree holds code written by
somebody else, against which your architecture rules do not apply.

Everything else is searched, including `dist`, `build`, `out`, `coverage` and
every dot-directory. The reasoning is asymmetric on purpose:

- scanning something you did not want costs a **visible** false failure, which
  a reader can diagnose in seconds and silence with `exclude`;
- skipping something you did want costs an **invisible** false pass, which is
  the defect this document exists to remove.

Between a false red and a false green, a guard dog takes the false red. The
tool cannot tell a `build/` of compiled output from a `build/` of build
scripts, and the honest response to not knowing is to look.

`--no-default-skips` removes even those four, for a run that must be certain.

### ripgrep stops having opinions

ripgrep's defaults are excellent for a developer grepping a checkout and wrong
for a rule about a repository. So they are switched off: `--hidden`,
`--no-ignore`, `--text`. The scope policy is then re-applied as explicit
`--glob '!name/'` exclusions, placed after the user's own globs because ripgrep
lets a later glob override an earlier one, and a policy skip must not be undone
by someone writing `glob="*.ts"`.

`--no-messages` was removed as well. It suppressed ripgrep's per-file errors,
which meant a file that could not be opened produced no match, no error, and no
way to tell it apart from a file that was read and found clean.

### ripgrep is a pre-filter, not a second implementation

The deeper problem was that the two engines were two implementations of the
same semantics, and the way to stop implementations diverging is to have one.

ripgrep now answers exactly one question - *which files under these targets
contain this text at all* - via `--files-with-matches`. Counting, comment
classification, binary detection, positions and the ledger all happen in the
scanner, for both engines. Parity stopped being something to test for and
became something the architecture makes true; the tests assert it anyway,
because a claim like that is worth checking.

This deleted more code than it added. The JSON event stream, its parser, the
byte-to-character column conversion, and the entire safe-batching apparatus
(`canBatchLiterals`, `shouldBatchPatterns`, `UnattributableBatch`) all existed
to make ripgrep's own counting trustworthy. As a pre-filter it does not count,
so overlapping patterns stop being delicate: a file included that turns out not
to match is free, because the scanner checks it again.

The cost is re-reading matching files. ADR-0006 measured that at roughly a
tenth over a single pass in the worst case a tree can produce - every file
matching - and nothing at all in the case this tool is for, where an absence
assertion matches nothing.

### Every skip is either requested or reported

Each file ends in one of three states:

- **inspected** - read and searched;
- **excluded** - the assertion's own `glob`/`exclude` said so, so the user
  already knows;
- **skipped** - spec-guard decided, and then says so.

Skips split by what they mean:

- **policy** (`.git`, `node_modules`): the same on every run, documented here
  and in `--help`. Not reported per-run, because a line that appears every time
  is a line nobody reads, and it would bury the ones that matter.
- **uncertainty** (`unreadable`, `binary`): a gap in the answer. Always
  reported, and `--strict` fails on them.

A binary file only reaches the ledger if it *contained* the symbol. One that
did not is not a gap - it was read and searched and found clean - and leaving
it out is also what keeps the two engines' ledgers identical, since ripgrep
only ever hands the scanner files that matched.

## Consequences

- **This is a breaking change to what "in scope" means.** A repository whose
  `dist/`, `coverage/` or `.github/` contains a symbol under an absence rule
  will start failing. That failure is the feature; the fix is `exclude`, and
  the CHANGELOG shows it.
- Runs are slower on repositories with large build output, because those files
  are now read. `exclude="dist coverage"` restores the old cost.
- `.gitignore` no longer affects results at all. A rule now means the same
  thing inside and outside a git repository.
- One traversal implementation, one binary rule, one counter. A divergence
  between the engines is now a bug in one place rather than a difference of
  opinion between two.

<!-- @assert-present file="src/scope.ts, tests/blind-spots.test.ts" reason="the policy and the regression tests for the defect it fixes" -->
<!-- @assert-count target="src/scope.ts" symbol="DEFAULT_SKIPPED_DIRECTORIES" min="1" reason="the policy list is named, not scattered" -->
<!-- @assert-absence target="src/engine.ts" symbol="--no-messages" reason="it hid the per-file errors that prove a file was unreadable" -->
