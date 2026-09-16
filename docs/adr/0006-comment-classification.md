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
parser per language — 9 profiles over 59 extensions to begin with, 68
extensions since 0.10.2, which added .NET's XML, and 11 profiles since 0.11.0
split YAML off the shell. The rules that actually differ are few: Rust nests
block comments, has raw strings and lifetimes; C# has `@"…"`, and since 0.10.2
`@$"…"` and raw strings of three quotes or more; Go's backtick strings ignore
backslashes; Python checks triple quotes before single ones; JavaScript adds
template literals and, since 0.11.0, regular expressions. Zero dependencies,
and the whole classifier is about 460 lines of code, blank lines and comments
aside — 40 of them the two tables that moved here from the import tokenizer so
that one answer serves both readers.

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

### A slash that quotes (0.11.0)

The open item 0.10.3 left at the top of its list was the one with reach. Every
text rule over a TypeScript project reads through this lexer, and JavaScript
has a literal the table had no rule for: the regular expression. A quote inside
one is not a quote —

```ts
const quoted = /^\\(["'\\])(.*?)\\1/.exec(text);
```

— and this is `src/parser.ts`, in this repository. Read without a rule for `/`,
that `"` opened a string that ran 138 characters into the file's prose, and the
scan never recovered: `parser.ts` and `polyglot.ts` both reported a lost place,
one of them with a single phantom literal covering 8,541 characters and 242
lines. Both directions of damage follow from that, and the second is the one
that matters:

| What the phantom string covers | What a text rule then does |
| --- | --- |
| a real comment | counts its matches as code — a loud, arguable failure |
| nothing, until it closes on a later quote | leaves the scan half a literal out of step, where a `//` inside a real string opens a comment and **hides real code** |

The second row is a silent pass, which is the outcome this project treats as
unacceptable, and it is not hypothetical. In `node_modules` on this machine
**119 comments in 63 files across 26 packages were not comments at all** —
mostly the `//` inside `const re = /^\/\//;`, read as a line comment that
swallowed the rest of its line. In the other direction 1,948 real comments in
53 files were being counted as code, because a phantom string was sitting over
them.

**Telling a regular expression from a division** takes the token before the
`/`, which a character lexer does not have. `imports.ts` has had that
heuristic since 0.2.0 — two tables, one of the words a regular expression may
follow and one of the punctuation — so the tables moved into `comments.ts` and
the tokenizer now imports them back. One table, two readers: the alternative
was a second copy, and the only thing worse than a heuristic is two of them
disagreeing about the same file. Where the previous token is a comment, this
lexer steps over it and asks again, using the ranges it has already collected.

The bound is what makes it safe. **A regular expression is one line long**, so
a `/` read wrongly costs the rest of its line and never the rest of the file —
the same backstop Rust's character literal got in 0.10.3. A `/` that closes
nothing before the newline was a division after all, and is read as code.

Three sibling fixes came out of the same pass, each a case where a delimiter
belongs to text rather than to syntax:

- **JSX text.** `<div>/*</div>` opened a block comment that ran to the next
  `*/` in the file. After a tag's `>`, `/*` is now text. The cost is a comment
  written directly against a `>` with no space, `a>/* … */`, which is read as
  code — the loud direction, and a shape that occurs 28 times in the
  `node_modules` here, every one of them inside a comment already, and in
  `<pre>` and `<span>` text at that.
- **YAML plain scalars.** Most YAML values are unquoted, and an unquoted value
  may hold an apostrophe: `- name: Build the decoder's artefact`. Read with the
  shell's quoting, that apostrophe opened a literal that closed on the next one
  — often lines away, in another sentence — and every `#` between them stopped
  being a comment. So YAML has a profile of its own, keeping the shell's `#`
  rule and taking a quote as an opening only where a word could start. Its
  own escape came with it: `'it''s'` is one scalar, and ending at the first of
  the pair would leave the rest of the line as text with a `#` free to open a
  comment in it.
- **A JavaScript string ends at its line.** Only a template may hold a line
  break, so a quoted string that reaches one was never a string. This is the
  backstop again, and it is also what JSX text costs: `<p>Don't click</p>`
  opens a literal nothing closes, and bounded to its line it costs that line.

**What it changed.** On the only corpus this machine has — 7,953 files in
`node_modules` and this repository, JavaScript and TypeScript nearly all of it
— 666 of 7,126 JavaScript files now have different comment ranges, and 4 of 35
YAML files. The number that says which direction: **44 JavaScript files
reported a lost scan before and 4 do now**, and the one YAML file that did
reports none. Every comment that disappeared was inspected; each was a phantom
of the kind in the table above.

**What it costs.** Nothing, and that took a rewrite. Adding the
regular-expression branch made C — which has no regular expressions and never
enters the branch — **16% slower**. Not the branch's work: the same branch with
its body deleted cost the same, and so did an unrelated dead branch bolted onto
0.10.3's lexer. A question asked per character is paid for per character
whether or not it is answered, which 0.10.3 learned once and this learned
again with less room to move.

The answer was to stop asking. Every comment token and every literal opener in
this table starts with one of a handful of ASCII characters, and a source file
is mostly none of them, so the scan now begins with a 128-byte lookup and a
character that opens nothing costs one array read. The same 20 MB through each
profile, one process per lexer, median of five:

| Profile | 0.10.3 | 0.11.0 |
| --- | --- | --- |
| javascript | 553 ms | 108 ms |
| c# | 573 ms | 111 ms |
| c-like | 356 ms | 104 ms |
| shell | 248 ms | 90 ms |
| yaml | 239 ms | 112 ms |
| rust | 135 ms | 105 ms |

Rust gains least, and for a reason worth knowing: its raw strings open with
`r`, so every letter `r` in the file takes the slow path. A profile pays for
the ordinariness of its delimiters.

**What the table still does not read.** Each of these is a literal form a
profile has no rule for, so a quote inside one can pair with the wrong partner
and turn comment text into code or the reverse:

- **A template nested inside a substitution**, `` `a ${b ? `c` : d} e` ``. This
  is now the one with reach: the inner backtick closes the outer template, and
  from there the file's quoting is inverted. 111 of the 7,126 JavaScript files
  here contain one — 1.6% — and they are all four of the JavaScript files that
  still report a lost scan. Reading it needs the scan to re-enter itself at
  `${` and return at the matching `}`, which is a change to the loop rather
  than a row in the table, and the measurement above says what a change to that
  loop costs when it is made carelessly.
- C++ raw strings, `R"(…)"`; Kotlin, Scala and Swift triple-quoted strings;
  Swift's `#"…"#`; Dart's `r'…'`.
- A quote inside a Markdown or HTML code span: `markup` has no string rules at
  all, so a ``<!--`` written inside backticks opens a comment. One file here
  does it.

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
<!-- @assert-count target="src/comments.ts" symbol="CommentSyntax" min="11" reason="one profile per comment family, plus the interface" -->
<!-- @assert-count target="src" symbol="const REGEX_AFTER_WORD" expected="1" reason="one table, read by both scanners: two would be two answers to the same question" -->
<!-- @assert-absence target="src/comments.ts" symbol="require(" reason="zero dependencies: the classifier parses, it does not delegate" -->
