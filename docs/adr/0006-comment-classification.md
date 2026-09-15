# ADR-0006: Comment classification

## Status

Accepted (0.3.0).

## Context

An external review found a defect that is worth stating carefully, because it
is not a bug in the search — the search was correct — and it defeats the tool
anyway.

You delete a symbol and record the deletion where the next person will look:

```ts
// LegacyThing was removed in ADR-398; do not reintroduce it.
```

Then you write the assertion that keeps it deleted:

```html
<!-- @assert-absence target="src" symbol="LegacyThing" -->
```

And it fails. The comment recording the fact is itself a match for the fact. The
assertion is true, the code is clean, and the tool says otherwise.

The failure is worse than an ordinary false positive, because the two obvious
fixes both make things worse. Deleting the comment throws away the explanation
that made the rule survivable. Deleting the assertion throws away the rule. A
tool that punishes documentation is not a documentation tool.

The same problem appears in every direction spec-guard is used:

| Written as | Assertion | What went wrong |
| --- | --- | --- |
| `// TODO: remove the old adapter` | `@assert-absence symbol="old adapter"` | the plan to remove it counts as having it |
| `# api_key was rotated out of source` | `@assert-absence symbol="api_key"` | the audit note trips the audit |
| `/* Widget replaced by Gadget */` | `@assert-count symbol="Widget" max="0"` | the migration note blocks the migration |

## Decision

Matches are classified, and by default matches inside comments do not count.

Three things follow, and each one was a choice with a real alternative.

### The default is to ignore comments

The alternative — off by default, opt in per assertion — is safer in the narrow
sense that nothing changes without being asked. It was rejected because it puts
the burden in the wrong place. The paradox above is not an edge case; it is what
happens when someone does the thing this tool is meant to encourage. Making the
correct behaviour opt-in means the tool is wrong by default and right only for
people who already know about the trap.

`comments="include"` restores counting for one assertion, and is the right
choice for assertions that are genuinely about text rather than code — a
licence header check, or a rule that a slur or a customer name appears nowhere
in the repository at all.

The attribute is per-assertion rather than a global config file. spec-guard has
no config file and this is not the feature to introduce one for: the directive
is the specification, and a rule whose meaning depends on a file somewhere else
is a rule you cannot read.

### When in doubt, it is code

Comment scanning is only safe if it also tracks strings, and this is the part
that decides whether the feature is trustworthy:

```ts
const url = "http://example.com"; const x = LegacyThing;
```

Read `//` inside that URL as a comment and everything after it disappears,
including a real use of `LegacyThing`. A violation becomes a silent pass — the
one outcome this project treats as unacceptable, because a green run that
verified nothing is worse than no run at all.

So every ambiguity resolves toward "this is code":

- an unterminated string runs to the end of the file, and its contents count;
- a language we do not recognise gets no comment ranges at all, so all of its
  matches count;
- dialects that permit comments where the base format does not (`//` in a
  `tsconfig.json`) are read as the base format, so those comments count.

A match wrongly kept is a visible failure someone can argue with. A match
wrongly dropped is a lie.

The languages are covered by a table of comment and string rules rather than a
parser per language — 9 profiles over 59 extensions (68 since 0.10.2, which
added .NET's XML, and a tenth profile since 0.10.3, below), and the rules that
actually differ are few: Rust nests block comments, has raw strings and
lifetimes; C# has `@"…"`, and since 0.10.2 `@$"…"` and raw strings of three
quotes or more; Go's backtick strings ignore backslashes; Python checks triple
quotes before single ones; JavaScript adds template literals. Zero
dependencies, and the whole classifier is about 280 lines of code, blank lines
and comments aside.

### A quote or a hash that opens nothing (0.10.3)

A trial of 0.10.2 on a Rust and .NET monorepo found five `use` declarations in
one plugin crate that an import rule never saw, and no note saying so. The
profile read every `'` as a character literal, the way C does. A Rust lifetime
is a quote with no partner - `&'static str`, `<'_>`, `where 'a: 'b` - so the
scan closed that literal on the next quote in the file, which in that file was
the apostrophe in a comment's `don't`. Everything between was the literal's
interior, so the import reader never saw it; and because the literal did
close, nothing reported a lost scan. For a text rule the same misreading turns
the rest of that comment into code, where a `/*` in it hides real code until
its `*/`.

Every rule this table had was about where a literal or a comment *ends*. This
one is about a character that opens nothing at all, so the other profiles were
probed for the same mistake. Four more were found, each hiding code as a
comment on 0.10.2:

| Source | Profile | What was hidden |
| --- | --- | --- |
| `&'static str { … } // it's /* …` | Rust | everything to the next `*/` |
| `base=${path##*/}; LegacyClient` | `#`, for `.sh` | the rest of the line |
| `if [ $# -eq 0 ]; then LegacyClient; fi` | `#`, for `.sh` | the rest of the line |
| `url: https://example.com/#top` | `#`, for `.yaml` | the rest of the line |
| `int n = 100'000; // it's /* …` | C | everything to the next `*/` |

What each now follows is the language's own lexical grammar, not a guess:

- **Rust**, as `rustc_lexer` reads it. A quote followed by an identifier is a
  lifetime or a label unless a quote follows the identifier: `'a'` and `'_'`
  are characters, `'a` and `'_` are code. The identifier is read whole, as the
  compiler reads it, so a lifetime's last letter never opens `r"…"`. A
  character literal cannot hold a line break, and rustc stops reading an
  unclosed one at the end of its line - so does this, and reports it. That
  bound is the backstop: whatever quote is misread in future costs at most the
  rest of its line, not the rest of the file.
- **Rust raw strings** take any number of hashes, `r"…"` to `r###"…"###`; only
  `r"` and `r#"` were known. `r#` with no quote after its hashes is a raw
  identifier, `r#type`.
- **Shell scripts and YAML** have a profile of their own. POSIX ignores a word
  that *begins* with `#`, and YAML requires whitespace before a comment, so
  `#` opens one only at the start of a line or after a space or a tab. A
  comment written against code, `x;# note`, is read as code: the direction that
  fails loudly. Their quotes follow their specifications too - nothing escapes
  inside `'…'`, and `$'…'` is the form that allows it.
- **C and C++**: a quote after a word that begins with a digit is a digit
  separator, as in C++14 and C23. `u8'a'` is still a character.

Two things were measured rather than assumed, on the only corpus this machine
has - 7,756 files in `node_modules` plus this repository, JavaScript and
TypeScript nearly all of it. The digit-separator rule was first written for the
whole C family, JavaScript included, on the argument that no valid JavaScript
puts a quote after a number. The argument was right and the rule still changed
9 files: every one a regular expression literal holding a quote, which this
lexer already misreads (below), where the new rule only picked a different
wrong answer. A rule no valid file can reach has nothing to offer a language,
so it is C's alone. With that, the new lexer's ranges are identical to 0.10.2's
on all 7,954 files. There is no Rust, C++ or shell corpus here, which is why
each rule above is a grammar's and why each case in the tests is one those
grammars name.

**What it costs.** The same 55 MB of JavaScript read as each profile, one
process per lexer, median of five alternating runs: through the JavaScript
profile alone the scan is 11% *faster* than 0.10.2's, and with all four
profiles through one process, JavaScript and C are 5% slower, Rust 2% faster
and shell scripts 10% faster. It was not that on the first try. Asking every
character whether it was a quote that is code cost a tenth of the scan -
JavaScript read as C came out 1.29 times slower - and two changes took it back:
the question is now asked only where a literal would open, and every profile
has the same keys in the same order, so the lexer's reads of them stay
monomorphic.

What the `#` rule does not cover is as deliberate. Python, Ruby, TOML and R
accept `x=1# note` as a comment and keep reading it as one. Perl's `$#items`
still hides the rest of its line: a shell's quotes are not Perl's, and Perl did
not seem worth a profile.

**What the table still does not read.** Each of these is a literal form a
profile has no rule for, so a quote inside one can pair with the wrong partner
and turn comment text into code or the reverse:

- **A JavaScript or TypeScript regular expression holding a quote** - `/'/g`,
  `/["']/`. This is the one with reach: every text rule over a TypeScript
  project reads through this lexer, and this repository's own `src/parser.ts`
  loses its place on `/\\(["'\\])/g`. Telling a regular expression from a
  division takes the previous token, which `imports.ts` tracks and this lexer
  does not; it needs its own measurement against that tokenizer, not a rule
  added in passing.
- C++ raw strings, `R"(…)"`; Kotlin, Scala and Swift triple-quoted strings;
  Swift's `#"…"#`; Dart's `r'…'`.
- A quote inside a YAML plain scalar, `title: Don't`, which YAML does not read
  as a quote at all.

### Excluding a match is reported, never silent

This is the mitigation that makes the default defensible. Comment exclusion is
the only mechanism in spec-guard that can turn a red run green without anyone
touching code, so a run that passed because of it says so:

```
⚠ 1 match inside comments was not counted; add comments="include" to count it

1 passed · 7ms
✔ every spec assertion holds
```

The note is in the default output, not behind `--verbose`. Nobody passes
`--verbose` to a green run, which is exactly when this needs to be visible. The
counts are also on every result in `--json` as `commentMatches` and
`unclassifiedFiles`, so a stricter project can fail its own build on them.

The second number is the other direction: files whose language we could not
read, whose comments were therefore counted as code. That one can only cause a
surprising failure, never a false pass, but it explains failures that would
otherwise look absurd.

## How ripgrep stays fast

Classification needs the file's text. ripgrep's match stream does not carry it,
and re-reading every matched file to classify it would be a second pass.

The suggestion under review was to classify after the fact from the matched
line, which is cheap but wrong at the boundaries: a match inside a block comment
whose `/*` is on an earlier line looks like code when you only have the line,
and so does one inside a multi-line template literal.

Instead, ripgrep is used for the thing it is unmatched at — telling us which
handful of files out of thousands contain the symbol at all — with
`--files-with-matches` rather than `--json`. Those files, and only those, go
through the same scanner the JavaScript engine uses.

The cost is proportional to matching files rather than to tree size, and for an
absence assertion — the case this feature exists for — that number is zero.

The benefit is that both engines produce comment-aware counts through one code
path, so there is exactly one classifier to be right about and no possibility of
the two engines disagreeing. The JavaScript engine gets the same treatment from
the other direction: it builds a file's comment mask lazily, on the first match,
so files that do not match are never classified.

Measured on a 2,000 file / 3.3 MB tree (Windows, warm cache, median of three;
the spread across runs on this machine is wide enough that only the shape of
the result is meaningful):

| Case | ripgrep | scanner |
| --- | --- | --- |
| absence assertion, no matches | 899ms two-phase | 1005ms |
| every one of the 2,000 files matches | 1318ms two-phase, 1209ms single-pass | 1138ms |

The first row is the case this feature exists for, and it is free: nothing
matched, so nothing was classified. The second is the worst case that can be
constructed — a symbol in every file — and it costs about a tenth more than a
single ripgrep pass, not a second traversal.

(That ripgrep does not beat the scanner on either row is a property of this
machine, not of the two-phase design: ADR-0004 measured the same inversion on
Windows and sets the engine budgets accordingly.)

## Consequences

- The paradox is fixed: documenting a removal no longer breaks the assertion
  that enforces it.
- Default behaviour changed. An assertion that was counting comment matches now
  counts fewer, and a project relying on that gets a lower number — reported,
  not silent, and reversible with `comments="include"`.
- A file spec-guard cannot classify is stricter than one it can, which is the
  right way round but can surprise: `.unknownext` files report their comments as
  code, and say so.
- Two engines, one classifier. A ripgrep-vs-scanner disagreement is now a test
  failure rather than a possibility, and the suite asserts parity through both
  the single-search and batched paths — a real bug lived in that gap, where
  `searchBatch` was comment-aware and `search` was not, so a spec with exactly
  one assertion silently kept its comment matches.

<!-- @assert-present file="src/comments.ts, tests/comments.test.ts" reason="the classifier and its language table are the whole feature" -->
<!-- @assert-count target="src/comments.ts" symbol="CommentSyntax" min="9" reason="one profile per comment family, plus the interface" -->
<!-- @assert-absence target="src/comments.ts" symbol="require(" reason="zero dependencies: the classifier parses, it does not delegate" -->
