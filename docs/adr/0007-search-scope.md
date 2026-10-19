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

### A fourth one, found later

One divergence outlived this ADR by a release. The adaptive engine's small-tree
branch collected the walk's ledger and returned without it, so an unreadable
directory was reported on a large repository and not on a small one. It is fixed
and covered; ADR-0004 records how, and why no test had caught it.

The lesson is the one this document already argues, arriving from a new
direction: a ledger that is *produced* correctly is not the same as a ledger
that is *reported*, and only the second one is what a reader sees. Every path
that returns a `SearchResult` has to carry it, and "every path" now includes the
ones added for speed.

<!-- @assert-present file="src/scope.ts, tests/blind-spots.test.ts" reason="the policy and the regression tests for the defect it fixes" -->
<!-- @assert-count target="src/scope.ts" symbol="DEFAULT_SKIPPED_DIRECTORIES" min="1" reason="the policy list is named, not scattered" -->
<!-- @assert-absence target="src/engine.ts" symbol="--no-messages" reason="it hid the per-file errors that prove a file was unreadable" -->

## Amended 2026-09-30: what the batching guarded, and two more silent passes

The README's design notes, an index of these records since, held three things
this record did not.

**What the batching apparatus guarded.** Merging literals into one ripgrep
alternation can lose matches through containment (`Primary` and
`PrimaryButton`) and through dovetailing (`abc` and `cd` in `abcd`), so
spec-guard checked for both and fell back to separate passes. Since ripgrep
answers only which files contain the text, the scanner counts each pattern
separately over the shared file contents, and the checks went with the risk
they guarded. Assertions that share a target list still share one pass over the
tree.

**A missing `target` fails the run.** It used to warn and search what was left,
so an assertion pointed at a renamed directory searched nothing, found nothing
and reported success - the exact shape of a green check that verified nothing.
`--allow-missing-targets` restores the warning, for a repository where a path is
legitimately optional.

**An assertion that inspected no files fails.** It is the same defect as a
missing `target`, seen from a different angle: a rule whose scope is empty
passes forever and reads exactly like a rule that found nothing. Turning this
on found a vacuous assertion inside this repository's own test suite on the
first run. `allow-empty="true"` covers the honest case of a rule written before
the code it guards.

## Amended 2026-10-11: a spec pattern that matches no file

One silent pass was a level above the ones this record closes. A `target`
that is not there fails, and a scope that holds no file fails; a spec pattern
that matched no file, beside others that did, was dropped, and the rules of
its documents stopped running with the run still green. A renamed directory
of specs is how it is reached, the same rename that leaves a `target` behind.

It is refused now, by the command line, in a line that names the pattern;
`--allow-empty` is the request that makes it a skip somebody asked for, and a
watch session and the MCP server, which wait for files, say which pattern
they are waiting on. Each file ends in one of three states, and so does each
pattern: matched, allowed to match nothing, or refused by name.
[ADR-0014](0014-configuration-and-watch.md), amended the same day, has what
each command does and what is left.

## Amended 2026-10-19: `^` and `$` read a line, and ripgrep's list is never the shorter

A regex rule was matched against a file's whole text with `g` and `i` and
no `m`, so `^` and `$` met only the file's two ends. ripgrep, which only says
which files the scanner reads, could not change that: it named the file and
the scanner counted nothing in it. Measured through the launcher on 0.27.0,
`--engine js` and `--engine rg` alike, with ripgrep 15.0.0 from
`@vscode/ripgrep` given by `SPEC_GUARD_RG`: a workflow of four lines whose
fourth is `      - uses: actions/checkout@v4` passed
`symbol="^\s*-?\s*uses:"`, exit 0, and failed it with that line first.

The regex now has `m`, and `^` and `$` read a line. JavaScript's `m` reads
three lines that ripgrep does not, and each was a count the two engines did
not agree on, so the line is the one ripgrep reads with `--crlf`:

- **A line ends at LF, at CRLF and at a lone CR.** `m` alone put a line
  between the CR and the LF of each CRLF: `^` met each line of a CRLF file
  twice, `\s+$` matched on every line of one, and `^\s*uses:` after an empty
  line was placed a line early.
- **No line follows the last line end**, so an empty file holds none. `m`
  alone met one more at the end of every file that ends with a line end: `^`
  counted four lines in a file of three, and `^$` and `\s+$` matched there.
- **U+2028 and U+2029 end no line**, as they end none for ripgrep. With `m`
  alone `^uses:` after either was counted by `--engine js` in a file
  ripgrep never named, so `--engine rg` passed the rule: a false green.
- Lines are numbered at LF, here as in every report, so a file of lone CRs
  is one numbered line; `.` matches no line end and no separator, as
  JavaScript's does.

What ripgrep is asked changes with it, since a file its list leaves out is
one the scanner never reads, and a count it would have made is a pass:

- **`--crlf`.** Without it `$` met no line end before a CRLF and `^` none
  after a lone CR, and ripgrep left out the files the scanner counted in.
- **`--multiline`.** The scanner reads a file's whole text, so its match may
  cross a line end. `foo\s+bar` over two lines, which ripgrep line by line
  never matched, was counted by `--engine js` on 0.27.0 and passed under
  `--engine rg`. ripgrep's `--help` (15.0.0, read 2026-10-19) says it reads
  a file into memory only for a pattern that can match a line end; `\n`,
  which it refused, leaving the search to the scanner with a warning, it
  now reads.

Measured through the launcher, each rule over a file of its own, the count
and its lines. "`m` alone" is `m`, with ripgrep asked as now, and no line
taken out:

| Rule, file | 0.27.0, `--engine js` | 0.27.0, `--engine rg` | `m` alone | Now, both |
| --- | --- | --- | --- | --- |
| `^\s*-?\s*uses:`, `uses:` on line 4 of 4 | 0, exit 0 | 0, exit 0 | 1, both | 1, line 4 |
| `^uses:` on line 2, LF or CRLF | 0 | 0 | 1, both | 1, line 2 |
| `uses: a$` on line 2, CRLF | 0 | 0 | 1, both | 1, line 2 |
| `^uses:` after a lone CR | 0 | 0 | 1, both | 1 |
| `^uses:` after U+2028 or U+2029 | 0 | 0 | `js` 1, `rg` 0 | 0 |
| `^` over three lines, LF / CRLF | 1 / 1 | 1 / 1 | 4 / 7, both | 3 / 3 |
| `\s+$` over three lines with no blank, LF / CRLF | 1 / 1 | 0 / 1 | 1 / 3, both | 0 / 0 |
| `^$` over three lines, CRLF | 0 | 0 | `js` 4, `rg` 0 | 0 |
| `^$` over an empty file | 1 | 0 | `js` 1, `rg` 0 | 0 |
| `foo\s+bar` over two lines | 1 | 0 | 1, both | 1, line 1 |

The pull request has the 51 rows this is from; on each the two engines
now give one count on the same lines, and ripgrep's list held every file
the scanner counted in. Where the two still read a line differently,
ripgrep names more, never fewer: with `--multiline` its `$` also meets the
end of a file after its last line end, with `--crlf` it reads a line after
a last lone CR, and its `.` matches U+2028 and U+2029. Over 2,000 files of
12 KB, ripgrep took the same time with the two flags as without them,
within a busy machine's noise, but for `^\s*-?\s*uses:`: 85 ms against 78,
medians of ten taken in turn, while `node -e 0` took 753 ms.

`tests/line-anchors.test.ts` holds each line end in the scanner, and runs
one set of anchored rules over one tree through both engines, holding the
counts and the lines to those a reader sees. `prove` shows a regular
expression's maximum its text below a line of its own as well
([ADR-0016](0016-rules-seen-to-fail.md), amended the same day), so a
pattern whose `^` met only a file's start survives it.

What this leaves as it was:

- **A match may cross a line end**, as it always could. `\s` matches LF, so
  `\s+$` also meets a line followed by an empty one, and `^\s*uses:` after
  an empty line is placed on the empty line; `[ \t]+$` reads only the
  blanks a line ends with. ripgrep with `--multiline` places it the same.
- **The two regular expression dialects differ beyond line ends.**
  JavaScript's `\b`, `\w`, `\W` and `\d` are ASCII and its `\s` holds
  U+FEFF; ripgrep's are Unicode. Measured: `foo\b` over `fooé`, `\Wbar`
  over `ébar`, `a\sb` over `a`, U+FEFF, `b`, and `baz` with `regex="true"`
  and `word="true"` over `ébaz` are each counted by `--engine js` and
  passed by `--engine rg`, on 0.27.0 and now. A literal with `word="true"`
  agrees. This amendment decides nothing about it.

<!-- @assert-present file="tests/line-anchors.test.ts" reason="the line ends each engine reads, and one set of anchored rules run through both" -->
<!-- @assert-count target="src/engine.ts" symbol="'--multiline'," expected="1" reason="the scanner's match may cross a line end, so ripgrep's list must hold a file where one does" -->
