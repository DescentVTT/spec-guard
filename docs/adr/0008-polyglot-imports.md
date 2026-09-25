# ADR-0008: Polyglot module extraction — mask, then read

**Status:** accepted
**Date:** 2026-09-10
**Supersedes nothing.** Extends [ADR-0005](0005-import-assertions.md) to Python,
Go, Rust and C#.

## Context

`@assert-import-absence` and `@assert-import-count` answer a question no text
search can: *does this part of the codebase depend on that one*. Until 0.5.0
they answered it only for JavaScript and TypeScript, which in a polyglot
monorepo is worse than it sounds. A rule reading

```md
<!-- @assert-import-absence target="services" module="ui/**" -->
```

over a directory of Go files did not fail. It passed, having analysed nothing,
and reported the skipped files in a warning most people do not read. That is the
same silent false green [ADR-0007](0007-search-scope.md) was written to kill,
wearing a different hat.

## The options

### 1. Tree-sitter (WASM or native bindings)

The obvious 2026 answer, and genuinely good technology: real grammars, real
parse trees, incremental reparsing.

Measured from the npm registry on 2026-09-10, unpacked size:

| package | version | unpacked |
| --- | --- | --- |
| `web-tree-sitter` (runtime) | 0.27.0 | 4.47 MB |
| `tree-sitter-python` | 0.25.0 | 7.17 MB |
| `tree-sitter-go` | 0.25.0 | 3.66 MB |
| `tree-sitter-rust` | 0.24.0 | 14.35 MB |
| `tree-sitter-c-sharp` | 0.23.5 | 64.87 MB |
| **total** | | **94.5 MB** |
| `@vscode/tree-sitter-wasm` (prebuilt bundle) | 0.3.1 | 21.06 MB |
| **`@descent-vtt/spec-guard` today** | 0.4.0 | **0.33 MB** |

So the runtime alone is 13× this package, and the four grammars together are
280×. Even the pre-bundled WASM route is 60×. A linter that installs 94 MB to
read four kinds of import statement has stopped being a lint tool and become a
build dependency, with a WASM loader, a per-platform binary story, and a
grammar-version matrix to keep current.

*Latest is not newest.* Tree-sitter is the right tool for an editor that must
re-parse a buffer on every keystroke and needs a tree afterwards. spec-guard
needs neither: it reads each file once, extracts a flat list of module paths,
and throws the file away.

### 2. One tokenizer per language

The shape `imports.ts` already uses for JavaScript. Correct, dependency-free —
and four times the code, four times the mutation surface, and four independent
opportunities to disagree about what a string literal is. spec-guard spent all
of 0.4.0 removing a second implementation of one idea; adding four was not
going to be the lesson learned.

### 3. A regular expression per language

`/^\s*use\s+([\w:]+)/m` and friends. Rejected on the project's founding
example: the entire reason `imports.ts` is a tokenizer is that a regular
expression cannot tell an import from a comment about an import, or from a
string containing one. Python makes it worse — a module name inside a docstring
is inside a *string*, not a comment, and no line-oriented pattern sees that.

### 4. Mask with the existing lexer, then read statements (chosen)

The observation that decided it: **spec-guard already owns a comment and string
lexer for nine language families**, written for
[ADR-0006](0006-comment-classification.md), and it is the most adversarially
tested code in the project. What it lacked was an exit: it discarded string
ranges after using them to avoid false comments.

So `commentRanges` became `lexRanges`, which reports comments *and* string
literals *and* whether a literal or comment was left open. Then:

```
source ──▶ lexRanges ──▶ mask comments + string interiors ──▶ statement reader
```

Everything the four readers see is code. Nothing in a comment, a docstring, a
verbatim string or a raw string can reach them. And because these languages put
imports in statements rather than expressions, what is left is small - counting
lines that are not blank or comment:

| reader | lines |
| --- | --- |
| Go | 23 |
| C# | 22 |
| Rust | 31, plus 36 for brace expansion |
| Python | 40 |

against 282 for the JavaScript tokenizer and its extractor, which is the
comparison that matters: one language needed a tokenizer, four did not.

### The one structural rule this design depends on

`polyglot.ts` must import `imports.ts` for **types only**. The dispatcher lives
in `imports.ts` and calls into `polyglot.ts`, so a value import back the other
way is a runtime cycle; `import type` is erased at compile time, so it is not.
That is exactly the kind of invariant that holds until somebody deletes the word
`type` while fixing something else, so it is asserted here rather than left in a
comment:

<!-- @assert-import-absence target="src/polyglot.ts" module="src/imports.js" types="ignore" reason="a value import back into the dispatcher would be a runtime cycle; import type is erased" -->
<!-- @assert-import-count target="src/polyglot.ts" module="src/imports.js" min="1" reason="the type-only import is expected to exist; this fails if it is removed, and the rule above if it becomes a value import" -->

Two assertions, not one. The first fails if the import becomes a value import.
The second fails if it disappears altogether — because an assertion that
something is absent from a file that no longer imports anything is a rule
covering nothing, which is the failure mode this release exists to remove.

The second said `expected="1"` until 2026-09-26, and its reason said it failed
when the import became a value import too. `spec-guard prove` found both wrong
(ADR-0016): the unit is files, and a target of one file holds one at most, so
no change can take the count past one; and a value import counts as one here,
since this rule counts type-only imports as well. It passed with the import
made twice. `min="1"` is what it held all along, and the reason now says which
rule catches which change.

## Consequences

### What it costs

Collecting string ranges alongside comments was measured at no cost: 31.6 ms
against 33.6 ms for the previous implementation over the same 0.51 MB corpus,
which is inside this machine's noise. The masking step was originally
`split('') / blank / join('')` — one string object per character — and was
rewritten to build from slices after the first benchmark showed it dominating
the Rust corpus.

Analyser throughput on synthetic corpora, one import per 12 lines (denser than
real code, so pessimistic): roughly 9–15 MB/s per language on the development
machine, against 14–17 MB/s for the JavaScript tokenizer. Run-to-run variance on
that machine is ±40%, so the honest statement is that all five analysers are in
the same order of magnitude and none of them is the bottleneck in a real run.

### What happens when it meets code nobody wrote for it

There is no Python, Go, Rust or C# on the development machine, so accuracy on
real code in those languages is untested and this ADR does not claim otherwise.
What *was* tested is the property that does not depend on the language being
right: a file somebody commits must not be able to take a CI job down.

- **53.6 MB of real JavaScript** (`node_modules`, 6,977 files) through the
  shared lexer and the JS analyser: 0 crashes, 17,491 references found, 6 files
  (0.086%) where the scan ended inside a literal and was reported as unreadable
  rather than as having no imports, and 150 dynamic references (0.86%) reported
  rather than counted. Those last two independently reproduce the ~0.09% and
  ~1% figures ADR-0005 measured on a different corpus.
- **Every one of the four new readers pointed at 34.5 MB of the wrong
  language** (4,000 JavaScript files read as Python, Go, Rust and C# in turn):
  0 crashes. The answers are meaningless; the point is that no answer is a
  stack trace.
- **Twelve hostile inputs** × four readers: unterminated strings, block comments
  and raw strings; 200-deep brace nesting; 20,000 `use` statements; a
  500,000-character line; NUL bytes; a lone surrogate; CRLF; nothing but
  separators; nothing but bare keywords. 0 crashes, no hangs, slowest run
  138 ms.

### Where a parser would genuinely be better

These are not imports spec-guard misreads. They are imports it cannot see, and
each one is reported rather than assumed absent:

- **Rust `self::` and `super::`.** Resolving a module-relative path needs the
  module tree; the module tree needs to know where inline `mod` blocks are;
  that needs a parser. They are matched literally, so a rule written about
  `crate/**` does not see them. Write layer rules against `crate::` paths —
  which is how layered Rust refers across layers anyway.
- **Macro-generated imports.** `include!`, a `macro_rules!` that expands to
  `use`, a C# source generator. Nothing textual can see these.
- **Conditional compilation.** A `using` inside `#if DEBUG` is counted. That is
  arguably right — it *is* a dependency in some configuration — but it is a
  choice, not an analysis.
- **`__init__.py` re-exports.** `from app import Thing` where `Thing` is
  re-exported from `app.db` is recorded as a dependency on `app`, not on
  `app.db`. Following it would need to read another file and resolve names,
  which is the line ADR-0005 drew and this does not cross.
- **A C# using relative to its namespace.** Inside `namespace Shop.Domain`,
  `using Application.Catalog;` is `Shop.Domain.Application.Catalog`,
  `Shop.Application.Catalog` or `Application.Catalog`, whichever exists first,
  and only the compiler's symbol table knows which. Since 0.10.2 it goes by all
  three, which can only add matches; before, it went only by what was written,
  and a rule about `Shop.Application` did not see it.
- **A C# name no using introduces.** `new Shop.Infrastructure.Db()` depends on a
  namespace no directive names. Reading every qualified name in every
  expression is parsing. A text rule on the namespace sees it, and the README
  says so beside the layer rule.

### Two decisions worth naming

**One notation, plus the language's own.** Module patterns are matched against
the resolved `/`-separated form (`app/db/client`) *and* against the specifier
as written (`app.db.client`, `crate::db::client`). A C# author should not have
to know that spec-guard rewrote their namespace before deciding to write
`System/Text/Json`. Matching both can only add matches, which for an absence
rule is the direction that fails loudly.

Until 0.10.2 the two notations were not equal, and nothing said so. A pattern
with a slash is anchored and covers what lies beneath it, so `App/Db` matched
`App/Db/Client`; a dotted pattern has no slash, matches one whole name, and
`App.Db` did not match `App.Db.Client` - which is what a C# or Python author
writes. So a reference now also goes by every module it sits under, in its
language's separator: `App.Db.Client` is also `App.Db` and `App`, and
`crate::db::pool` is also `crate::db` and `crate`. The boundary is a whole
segment, so `App.Db` does not cover `App.Dbx`. Go needs none of this, since its
import paths are slashed already, and neither does a Python relative import,
which goes by the path it resolves to.

### C# as it is written now (0.10.2)

Checking the first of those against real .NET code turned up three ways the C#
reader lost a dependency, all of them quiet:

- **An alias qualifier became part of the name.** The reader treated `::` as a
  separator, so `global using global::Shop.Application;` - the form the SDK's
  own generated files use - was `global.Shop.Application`, and an extern alias
  gave `Legacy.Shop.Application`. What precedes `::` says where to look a name
  up, not what it is, so it is left off.
- **Two string forms lost the scan.** The lexer knew `"..."` and `@"..."`. A raw
  string literal (C# 11) read as `""` and then a string of its own, so a quote
  inside it closed that early, and one opened with four quotes to hold three
  ran to the end of the file. `@$"C:\"`, the interpolated verbatim string,
  read as `@`, `$` and an ordinary string whose backslash escaped its closing
  quote. A C# raw string now opens with a run of three or more quotes and
  closes only at a run as long, and `@$"` is verbatim beside `@"`.
- **A relative using**, above.

The reader also records the namespaces each file declares - `namespace A.B;`,
or a block, a nested one named in full - and the namespace each using sits in.
It does that in the same single pass, by brace depth: a namespace is open until
the depth falls below its body's. That is what a layer rule reads to tell a
layer no using can reach ([ADR-0011](0011-layers-and-cycles.md)).

**Matching is case-sensitive, and polyglot rules feel it.** C# capitalises
namespaces where Go and Python do not, so a rule spanning both writes
`module="app/db/** App/Db/**"`. Case-insensitive matching was rejected: it would
make `module="app"` match a directory called `App` in a case-sensitive
repository, which is a different silent wrong answer.

### Rust as it is written now (0.10.3)

"Not imports spec-guard misreads", above, held only as long as the mask was
right about every delimiter, and in Rust it was not. The profile it borrowed
read every `'` as opening a character literal. A lifetime - `&'static str`,
`<'_>`, `'a` - has no closing quote, so the scan closed the literal on the
next quote in the file, often an apostrophe in a comment, and masked
everything between as its interior. A trial found five `use` declarations in
one plugin crate hidden that way. And no note: the literal *did* close, so the
file was not reported as unreadable.

That is the gap in "a reference this module cannot resolve becomes a note". It
covers what a reader sees and cannot resolve, not what the mask removed before
the reader looked, and a mask that closes a literal in the wrong place is
silent by construction. So the fix is two things
([ADR-0006](0006-comment-classification.md) has both). Quotes are read as
`rustc_lexer` reads them, lifetimes and labels as code. And a character literal
may not cross a line: rustc stops an unclosed one there too, so a quote misread
in future costs at most the rest of its line, and a literal left open there
has the file reported. The note's wording changed with it, from "ran to the
end of the file" to "was never closed". Raw strings now take any number of
hashes; `r##"…"##` used to lose the scan, loudly.

### The cap

Rust brace groups nest, and nesting multiplies: expansion is exponential in
depth. A `use` statement that would expand past `MAX_EXPANSION` (64) paths
produces a `truncated` note and **no** references, rather than a partial list.
A half-read import statement is a rule that quietly covers less than it claims;
an error message is a rule that says so.
