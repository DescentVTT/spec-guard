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

## Amended 2026-10-12: a Python file is read the same whatever ends its lines

"What happens when it meets code nobody wrote for it" ran the four readers
over CRLF and counted crashes. Nothing counted answers. A Python statement
ends with its line, and `logicalLines` ended a line at LF alone, so every
line of a file with CRLF endings kept its carriage return:

- the pattern that reads a `from` statement takes the rest of the line and
  then wants the end of the text, and `.` stops at a carriage return, so it
  matched no `from` statement in the file;
- a backslash before the carriage return was no longer the last character
  of its line, and continued nothing.

Found on 2026-10-12 by replaying the static survivors of main's sweep by
hand (ADR-0003, amended that day): the `$` taken off that pattern read such
files right, and no test read Python with CRLF. Measured through the
analyser on 0.24.0, each source with LF and then with every LF made CRLF:

| Source | LF | CRLF, 0.24.0 | CRLF, now |
| --- | --- | --- | --- |
| `from a import b` | `a` | nothing | `a` |
| `from . import a, b` | `.a`, `.b` | nothing | `.a`, `.b` |
| `from . import (`, `a,`, `b,`, `)` on four lines | `.a`, `.b` | nothing | `.a`, `.b` |
| `import a, \` and `b` on the next line | `a`, `b` | `a`, and a module named `\` | `a`, `b` |
| `from a \` and `import b` on the next line | `a` | `b` | `a` |
| `import a`, `import b.c as d` | `a`, `b.c` | `a`, `b.c` | `a`, `b.c` |

And through the launcher, with
`@assert-import-absence target="src" module="forbidden"` over a file holding
`from forbidden import thing`: exit 1 with LF endings, and exit 0 with CRLF,
the rule reported as holding. `core.autocrlf` is `true` in the system
configuration of Git for Windows 2.55.0 on the workstation this was measured
on, and a checkout under it has every Python file that way unless a
`.gitattributes` says otherwise: a rule that fails over an LF checkout
passes over that one.

- **A line ends where Python ends one**: at LF, at CRLF and at a lone
  carriage return, the three its language reference gives for a physical
  line (Lexical analysis, as read on 2026-10-12 for 3.15). The two
  characters of a CRLF end one line; read as two, the empty second would
  end a statement the first had continued.
- **Where a reference is reported does not change.** A line number counts
  LF, here as in every report, so an import in a CRLF file is on the line it
  was on with LF. A file whose lines end in a lone carriage return is read
  statement by statement and is one line to a report, as it was.
- **Only Python was wrong.** Go, Rust, C#, and JavaScript and TypeScript
  read tokens and not lines: the same sources with LF and with CRLF gave the
  same references on the same lines, on 0.24.0 and now.
- **It can turn a passing run red**, which is the point: an import rule
  over Python in a CRLF checkout now sees what it saw nowhere but in an LF
  one.

`tests/python-line-endings.test.ts` holds each shape to its LF reading, on
the same lines, and a rule to its LF answer.

<!-- @assert-present file="tests/python-line-endings.test.ts" reason="a reader that was only ever shown LF read no from-import in a CRLF checkout, and nothing said so" -->

## Amended 2026-10-14: a Python import statement is read as Python reads it

Up to 0.25.0, that release among them, a Python statement was read by two
patterns. One found `import`
or `from` where a statement may start and wanted a blank or a tab after it;
the other read a `from` statement, wanted a blank or a tab after its
`import`, and took whatever followed. `from a import(b)`, with no blank
before the parenthesis, is an import to Python and was none here
(DescentVTT/spec-guard#59 found it and left it). It was not the only one.

Measured on 2026-10-14 against Python itself: 322 sources, every spelling of
the statement around parentheses, a star, white space, comments, line
continuations and a trailing comma, where a statement may stand, and names
beyond ASCII, each parsed and compiled by Python 3.11.9 (`ast.parse` and
`compile`, Windows 11) and read by the analyser of 0.25.0 and of this build.
Python reads 197 of them and refuses 125.

| | 0.25.0 | Now |
| --- | --- | --- |
| of the 197 Python reads: an import not read, or read under another name | 52 | 0 |
| of the 197: every import read, one of them on another line than Python's | 7 | 0 |
| of the 125 Python refuses: read as holding an import | 78 | 25 |

Some of each, with what Python 3.11.9 reads:

| Source | Python | 0.25.0 | Now |
| --- | --- | --- | --- |
| `from a import(b)`, and the same with two names, over several lines, with comments or with a trailing comma | `a` | nothing | `a` |
| `from . import(a, b)` | `.a`, `.b` | nothing | `.a`, `.b` |
| `from a import*` | `a` | nothing | `a` |
| `from.a import b`, `from . a import b` | `.a` | nothing | `.a` |
| `from . . import a`, `from .. . import a` | `..a`, `...a` | nothing | `..a`, `...a` |
| `from a . b import c` | `a.b` | nothing | `a.b` |
| `import a . b`, and `import a\` with `.b` on the next line | `a.b` | `a` | `a.b` |
| a form feed where a blank may stand: `import`, a form feed, `a` | `a` | nothing | `a` |
| `from módulo import x` | `módulo` | nothing | `módulo` |
| `import ﬁle`, written with the ligature U+FB01 | `file` | `ﬁle` | `file` |
| `x = (1,` and on the next line `2); import a` | `a`, on line 2 | `a`, on line 1 | `a`, on line 2 |
| `from a import b,`, `from a import ()`, `from a import (b`, `from a import b c`, `import a,`, `import a b` | refused | `a` | nothing |
| `import (a, b)` | refused | two modules, `(a` and `b)` | nothing |
| `import os, , sys` | refused | `os`, `sys` | nothing |
| `from a importb`, `importa`, `froma import b` | refused | nothing | nothing |

And over real code: the `Lib` directory of that Python 3.11.9, the standard
library and what is installed beside it, 4,341 files that parse, in which
`ast` finds 32,777 imports. 0.25.0 read every one of them, on Python's line,
and nothing else; so does this build. The spellings above are ones the
grammar takes and that code does not use, which is why no trial had met
them.

- **A statement is read by Python's grammar, token by token.** The language
  reference gives the import statement as a keyword and then names: for
  `import`, modules written as dotted names, each with an `as` or without,
  between commas; for `from`, dots, a dotted name or both, then `import`,
  then a star, or names each with an `as` or without, bare or in
  parentheses, where only the parentheses take a comma after the last name
  (The Python Language Reference for 3.15, section 7.11, "The import
  statement", and the rules `import_name` to `dotted_name` of its section
  10, "Full Grammar specification", both as read on 2026-10-14). The
  statement is cut into names and the marks `.`, `,`, `(`, `)` and `*`, and
  read by that grammar and no other: an import Python reads is read, and a
  statement Python refuses is read as nothing.
- **What separates two tokens is a blank, a tab or a form feed**, and
  nothing need separate two that cannot be read as one, so `from.a
  import(b)` is five tokens (the same reference, section 2.1.9, "Whitespace
  between tokens", read on 2026-10-14). A form feed may also stand at the
  head of a line (section 2.1.8, "Indentation").
- **A name is what Python takes for one**: a letter, an underscore or a
  character beyond ASCII that Unicode lets start an identifier, and then
  those and digits (section 2.3, "Names", and 2.3.4, "Non-ASCII characters in
  names", read on 2026-10-14). The page has Python read a name in its NFKC
  form, so `import ﬁle` is `file` to a rule, as Python 3.11.9 gives it.
  What follows from the page and is not on it: the two sets are Unicode's
  `XID_Start` and `XID_Continue` as the Node that runs spec-guard has them,
  which is a later Unicode than an older Python's.
- **`lazy import` and `lazy from ... import` are read as the imports they
  are.** They are Python 3.15's (section 7.11.1, "Lazy imports", of the page
  for 3.15.0, read on 2026-10-14): `lazy` is a keyword only where it stands
  straight before `import` or `from`, and before a star import the page has
  it a syntax error, so that one is read as nothing. Python 3.11.9 refuses
  every one of them, and no Python on the workstation takes them, so these
  are held to the page and to no measurement. It follows from the page, and
  is not on it, that reading one costs a tree written for an older Python
  nothing: the statement is one that Python refuses, in a file it would not
  run. Anywhere else `lazy` is a name, and `lazy = 1`, `lazy(x)` and `lazy;
  import a` are read as 3.11.9 reads them. The `__lazy_modules__` list of
  the same page changes when a module is loaded and not what is imported,
  and nothing reads it.
- **A statement Python refuses stays unread, by its own grammar and no
  further.** 78 of the 125 refused sources were read on 0.25.0, by the
  pattern that took whatever followed `import`. 25 still are, each measured
  on both builds, and none is asked more of:
  - what scope a statement stands in, where Python refuses a star import
    inside a function and an indent at the head of a file, and where 3.15,
    by the page above, refuses a lazy import inside a function;
  - the rest of its line and of its file: `import a;;`, a backslash on the
    last line of a file, and `f = lambda: import a`, where the colon is
    read as one that a statement may follow;
  - whether a name is one of Python's keywords, in eleven: `import if`,
    `from a import in`, and `import pkg.async`. `async` and `await` were
    names until Python 3.7 made them keywords (What's New In Python 3.7,
    "Summary - Release Highlights", read on 2026-10-14), a tree written for
    an older Python has modules so called, and reading a keyword as a name
    costs nothing where Python refuses the file;
  - and the eight `lazy` forms above, which 3.11.9 refuses and 3.15 reads.
- **A statement is reported on the line its first word stands on**, which
  is the line Python's `ast` gives it. It was the line its logical line
  began on, which is another where a statement follows a `;` or a `:` after
  one that ran over several lines, or after a backslash. A statement that
  runs over several lines is on its first, as it was, and each is reported
  at the head of its line, as it was. `logicalLines`, which the package
  exports, says where each physical line of a logical one begins, as
  `starts`.
- **It can turn a passing run red**, which is the point: an import rule over
  a file that writes an import one of those ways now sees it. And it can
  turn a failing one green, only over a statement Python refuses:
  `import os, , sys` was an import of two modules and is none.
- **Left as they are.** A statement that is refused is passed over with no
  note, as one the old patterns could not read was. *Amended 2026-10-18*: it
  is noted, by the amendment below. `from . import *` names
  no module, here as before. And the same question was asked of the other
  four languages only to record the answers, through the analyser on this
  build: JavaScript and TypeScript (twelve spellings with no blank or with
  line breaks, `import{a}from'x'` among them) and Go (eight, `import"fmt"`
  among them) were each read; in Rust `use a :: b;`, which rustc 1.97.1
  compiles, is read as a module named `a :: b`, blanks and all, and `use
  r#mod::d;` as `r#mod::d`; and in C# `using System . Text;`, `using T =
  System . Text . Json;` and `using @System.IO;`, which the compiler of the
  .NET SDK 10.0.401 compiles, are each read as nothing. *Amended
  2026-10-18*: Rust and C# are not left, and each of these is read, by the
  amendment below.

`tests/python-statements.test.ts` holds each source Python reads to
Python's answer, with LF and with CRLF line endings, each source Python
refuses to nothing, the lazy forms to the page, and an import rule to both.

<!-- @assert-present file="tests/python-statements.test.ts" reason="the reader is held to what Python itself reads of each spelling, and to nothing for what Python refuses" -->

## Amended 2026-10-18: a Python statement read as no import is said

The amendment above has a statement Python refuses read as nothing, and
passed over with no note: `from a import b,` names no module, and an import
rule over it passed, under `--strict` too. Measured through the launcher on
0.26.0 (Windows 11 build 26300, Node 24.18.1), with
`@assert-import-absence target="src" module="forbidden"` over a file that
holds `import os` and `from forbidden import thing,`:

| Run | 0.26.0 | Now |
| --- | --- | --- |
| a run | exit 0, and no word of the statement | exit 0, and the note under the rule |
| `--strict` | exit 0 | exit 1: `expected no matches, found 0; 1 reference could not be resolved` |
| `--json --strict` | `ok`, and no warning | not `ok`, the note among the result's `warnings` |

```text
! docs/a.md:3  1 module reference could not be resolved statically
!   src/a.py:2 a statement that starts as an import is one Python refuses, and no module is read from it
```

- **Each statement that starts as an import and that Python refuses is a
  note**, of the kind `refused`, on the line its first word stands on, as an
  import would be reported. A statement starts as an import where the
  reader looks for one: `import`, `from` or `lazy` before either, as a
  whole word, at the head of a logical line or after a `;` or a `:`. Of the
  95 sources Python refuses that the test of the amendment above holds to
  nothing, 85 are each one note;
  the other 10 start no statement so, `froma import b`, `Import a` and
  `x = import a` among them, and are said nowhere, as they were read as
  nothing.
- **It is treated as every note of what could not be read is**, which is
  what `--strict` already read: the rule says it under its count, a passing
  rule as well as a failing one, and under `--strict` the rule fails for it
  (ADR-0005, Q4). `impact` lists the file among those whose imports could
  not all be read, as it lists one whose scan was lost.
- **No import Python reads is among the notes.** Over the 4,341 files of the
  `Lib` of Python 3.11.9 that the amendment above measured, every one of
  which Python parses, this build reads the same 32,777 imports, on the same
  lines, and makes no note of the kind; nor does any of the 192 sources
  that test holds to what Python reads.
- **It can turn a passing run red**, under `--strict`, over a file that
  Python would refuse. `NoteKind`, from the package, has `refused` beside
  `dynamic`, `unreadable` and `truncated`.

`tests/python-statements.test.ts` holds each source Python refuses to its
note, or to none where no statement starts as an import, each source Python
reads to no note, and a rule to both, under `--strict` and not.

## Amended 2026-10-18: a Rust use declaration and a C# using directive are read as their compilers read them

The amendment of 2026-10-14 left the other languages as they were and
recorded what
it found of them: in Rust `use a :: b;` was read as a module named `a :: b`,
and `use r#mod::d;` as `r#mod::d`; in C# `using System . Text;`, `using T =
System . Text . Json;` and `using @System.IO;` were each read as nothing.
A Rust declaration was the text between `use` and its `;`, cut at braces,
commas and ` as `, and a C# directive was read by a cursor that took no
blank and no comment inside a name, no `@` and no escape.

Measured on 2026-10-18 against the compilers on the workstation: 144 Rust
sources, every spelling of a use declaration and of an extern crate around
white space, comments, raw identifiers, aliases, globs, `self`, `crate` and
nested groups, each compiled by rustc 1.97.1 (edition 2021); and 132 C#
sources, every spelling of a using directive around white space, comments,
`@`, escapes, names beyond ASCII, `static`, `unsafe`, `global`, `::` and
aliases, and of the namespace one stands in, each compiled by the compiler
of the .NET SDK 10.0.401 (`-langversion:latest`). Each was compiled beside
the modules and namespaces its names resolve to, with code that compiles
only if each import binds what it is said to, so a source refused is refused
for how it is written. And each was read by the analyser of 0.26.0 and of
this build. rustc compiles 90 and refuses 54; the C# compiler compiles 97 and
refuses 35.

| | 0.26.0 | Now |
| --- | --- | --- |
| Rust, of the 78 rustc compiles that import something: an import not read, or read under another name | 29 | 0 |
| Rust, of the 9 it compiles that import nothing: read as holding an import | 5 | 0 |
| Rust, of the 54 it refuses: read as holding an import | 51 | 10 |
| C#, of the 83 the compiler compiles that hold a using directive: one not read, or read under another name | 52 | 0 |
| C#, of the 12 it compiles that hold none: read as holding one | 3 | 0 |
| C#, of the 35 it refuses: read as holding one | 7 | 2 |

The other three Rust sources rustc compiles are macro definitions, and the
other two C# sources alias `int` and a tuple; each is read as 0.26.0 read
it. Some of each, with what the compiler reads:

| Source | Compiler | 0.26.0 | Now |
| --- | --- | --- | --- |
| `use a :: b;`, and `use a::b;` with a tab, a newline, a form feed, a next line, a line separator or a comment between two tokens | `a::b` | a module named `a :: b`, the blanks in it | `a::b` |
| `use r#mod::d;`, `use a::r#b;` | `mod::d`, `a::b` | `r#mod::d`, `a::r#b` | `mod::d`, `a::b` |
| `use ::serde::{Deserialize};` | `serde::Deserialize` | `::serde::Deserialize`, which no rule on `serde` matched | `serde::Deserialize` |
| `use a::b::self;` | `a::b` | `a::b::self` | `a::b` |
| `use a::café;`, the `é` an `e` and a combining accent | `a::café`, in its NFC form | as written | `a::café` |
| `use a::{};` | an import of `a`, which its lint for unused imports names | nothing | `a` |
| `mod r#use { pub const LIMIT: u8 = 1; }`, `let r#use = 1;`, `struct K { r#use: u8 }` | no import | modules named `pub const LIMIT: u8 = 1`, `= 1` and `: u8` | nothing |
| `use a::b c;`, `use a::{b, , c};`, `use a: :b;`, `use r#crate::a;`, and `use a::b` at the end of a file with no `;` | refused | `a::b c`; `a::b` and `a::c`; `a: :b`; `r#crate::a`; `a::b` | nothing |
| `using System . Text;`, a newline or a comment between two tokens, `using T = System . Text . Json;` | `System.Text`, `System.Text.Json` | nothing | `System.Text`, `System.Text.Json` |
| `using @System.IO;`, `using System.@IO;`, a letter written as an escape, `using Café;` | `System.IO`, the name the escape spells, `Café` | nothing | the same names |
| `using static unsafe A.B.S;`, `using static G.L<int>;` | `A.B.S`, `G.L` | nothing | `A.B.S`, `G.L` |
| `using T = A.B.V[];`, `using T = A.B.V?;`, `using unsafe T = A.B.V*;` | `A.B.V` | nothing | `A.B.V` |
| `namespace A . B { using C; }` | `C`, looked up in `A.B` first | `C` in no namespace, and no namespace declared | `C` in `A.B` |
| `#region using A.B;`, `static object @using = A.B.C;`, `@using field;` beside `class @using { }` | no directive | `A.B`, `A.B.C`, `field` | nothing |
| `using A.;`, `using A.B::C;`, `using A.B = C;` | refused | `A`, `C`, `C` | nothing |

And over real code. The 31,343 Rust files of the crates in the
workstation's cargo registry, 282,412 references on 0.26.0: on 177 lines a
reference is read under its canonical name, 155 of them a path under a
leading `::` in a group, 20 a raw identifier and 2 a path written with
blanks about its `::`, in a formatter's test input; on 4 lines an import is
read that 0.26.0 lost, each after an `impl Trait + use<'a>` bound, which
says what a return type captures, whose read had run on through it; and
on 294 lines nothing is read where 0.26.0 read a module, none of them an
import rustc reads there: 117 such bounds, 129 interpolations of `quote!`
in a procedural macro, `use #name::...`, 14 repetitions of a macro, and 34
arms of a macro that matches the word `use`. The 4,067 C# files of a .NET
repository on the workstation: the same 15,648 references on both builds,
on the same lines, and the same namespaces. The spellings in the tables are
ones that code does not use, as Python's were.

What 0.26.0 could not come back from: a use group nested 20,000 deep, and
500,000 characters of groups that never close, each ran it out of stack, the
second after 86 seconds; 500,000 characters of C# alias type arguments that
never close took it 50 seconds, on this workstation. Each comes back in
under a fifth of a second now.

- **A declaration is read by its language's grammar, token by token.** A
  Rust use declaration as the Rust Reference has it: `use`, a use tree, `;`,
  the tree a path and an `as` or none, a path and a glob, or a path and a
  group of trees, nested (Items, "Use declarations", and Paths, "Simple
  paths"); an extern crate as `extern crate`, a name or `self`, an `as` or
  none, `;` (Items, "Extern crate declarations"). A C# using directive as the
  C# specification has it: `using static`, `unsafe` or not, and a type;
  `using`, `unsafe` or not, an alias, `=` and a namespace or a type; or
  `using` and a namespace; `global` before any of them (14.5, "Global using
  directives", and 14.6, "Using directives"); and a namespace declaration as
  `namespace` and names between dots (14.3). Each was read on 2026-10-18,
  the Reference at doc.rust-lang.org and the specification's chapters
  "Namespaces" and "Lexical structure" on Microsoft Learn, dated 2026-09-22.
  An import the compiler reads is read; what it refuses is read as nothing.
- **What separates two tokens is the language's white space, and a
  comment.** Rust's is Unicode's Pattern_White_Space (Lexical structure,
  "Whitespace"); C#'s is a character of the class Zs, a tab, a vertical tab
  or a form feed, and what ends a line (6.3.4 and 6.3.2). Nothing need
  separate two tokens that cannot be read as one.
- **A name is read as the compiler compares two.** In Rust, `r#` is no part
  of an identifier, `r#_`, `r#crate`, `r#self`, `r#Self` and `r#super` are
  refused, and two names are one where their NFC forms are (Lexical
  structure, "Identifiers"). In C#, two identifiers are one after the `@` is
  taken off, each escape is made the character it writes and each
  formatting character is taken out (6.4.3). The C# page has a conforming
  program write its names in NFC and leaves another form to the compiler;
  the compiler of the SDK refused `using` of a name in NFD beside a
  namespace in NFC, so a C# name is read as written, and not normalised.
- **A path's own end is read.** `self` at the end of a path names what is
  before it, as the Reference has `P::self` equivalent to `P::{self}`; a
  leading `::` is no part of the name, in a group as outside one; a group
  with nothing in it names the path before it, which rustc reads as an
  import; and a glob of nothing names no module. In C#, a type argument
  list is passed over after a name in `using static` and in an alias, where
  a type may stand, and an alias's type may end in the marks of an array, a
  nullable and a pointer; a namespace takes neither. No type argument is a
  pointer, which the compiler refuses there, and none is read as one.
- **What is no declaration is read as none.** A keyword is a whole word, so
  neither the identifier `r#use` nor `@using` and `@namespace` starts one. A
  C# pre-processing directive takes its whole line (6.5.1), and nothing on
  it is code, its braces included. A byte order mark at the head of a C#
  file is no character of its text, as the compiler reads it.
- **A declaration left open is never read on into the next.** No segment of
  a Rust path is `use` or `extern` unless written raw, and no C# identifier
  is `using` or `namespace`: each is a keyword in every edition and version,
  so reading stops where the next declaration starts, and it is read.
- **Left as they are, each measured: what the compiler refuses beyond its
  grammar.** 10 of the 54 Rust sources rustc refuses and 2 of the 35 C# ones
  are still read, and nothing more is asked of them:
  - whether a name is a keyword, `use mod::d;`, `use a::fn;` and `using
    class.N;`, as of a Python statement in the amendment above. Rust's
    `async`, `await` and `dyn` are keywords from the 2018 edition on and
    `gen` from 2024, and the edition is in `Cargo.toml`, which the reader
    does not open;
  - where `self`, `super` and `crate` stand in a path, which rustc refuses
    in the middle of one, and the restrictions the Reference adds to the
    grammar: `use crate;`, `use self;` and `extern crate self;`, each with no
    `as`;
  - whether a comment between two tokens is a doc comment, which rustc reads
    as an attribute and refuses there: the mask makes every comment blanks;
  - whether `$crate`, or another name that starts with `$`, stands in a
    macro, where rustc reads it as the macro is expanded: 0.26.0 read both,
    and `use crate::utils::$name::Thing;` is a dependency on `crate::utils`
    in every expansion;
  - and a C# name in another normal form than the namespace it means, which
    names another namespace, read as written.
- **Where a reference is reported does not change**: on the line of its
  `use`, its `extern` or its `using`, and a declaration that runs over
  several lines on its first, as a Python statement is. rustc's own
  diagnostics point at each path of a group.
- **The cap holds depth too.** A group nested deeper than `MAX_EXPANSION`
  (64) is reported with the same note as one that expands past it, and no
  reference, where 0.26.0 ran out of stack; the note says both.
- **For a caller of the package**, `expandUsePath` reads a use tree as a
  declaration's is read, with its `;` or without, and names nothing of text
  that is no tree; `Reader` keeps what the Go reader and Python's dynamic
  imports read with, and its `eat`, `keyword`, `dotted` and
  `skipGenerics`, which only the C# reader called, are gone.
- **It can turn a passing run red**, which is the point: a rule over Rust or
  C# now sees an import written one of those ways. It turns a failing one
  green only over text the compiler refuses, or that is no import.

`tests/rust-and-csharp-statements.test.ts` holds each source rustc and the
C# compiler read to what they read, each one they refuse to nothing, what is
left as it is to what is read of it, and an import rule to both.

<!-- @assert-present file="tests/rust-and-csharp-statements.test.ts" reason="the readers are held to what rustc and the C# compiler read of each spelling, and to nothing for what they refuse" -->

## Amended 2026-10-19: names and aliases read whole

A Go package name was read as ASCII: `import 名 "fmt"` and `import café
"fmt"` were read as no import, and so was `import _x "fmt"`, whose `_` was
taken for the blank identifier and the rest left over. And a C# alias or
`using static` was read by the name its type starts with: `using T =
G.L<N1.X>;` named `G.L` and not `N1.X`, `using T = (N1.X, N2.Y);` named
nothing, and `using T = int;` a namespace called `int`. Measured through the
launcher on 0.27.0 and on this build (Windows 11 build 26300, Node 24.18.1),
one `@assert-import-absence` over one file:

| Source | Rule's `module` | 0.27.0 | Now |
| --- | --- | --- | --- |
| `import 名 "forbidden/db"`, `import café "forbidden/db"`, `import _x "forbidden/db"` | `forbidden/**` | exit 0, nothing found | exit 1, the import found |
| `import db` and `"forbidden/db"` on the next line, which Go refuses | `forbidden/**` | exit 1 | exit 0 |
| `using Pool = System.Collections.Generic.Dictionary<Shop.Db.Key, int>;`, `using Pair = (Shop.Db.Key, int);`, `using static Shop.Ui.Views<Shop.Db.Key>;` | `Shop.Db` | exit 0, nothing found | exit 1, the using found |
| `using T = int;` | `int` | exit 1 | exit 0 |

No Go compiler is on the workstation, so the measure for Go is The Go
Programming Language Specification, go1.27, as read on 2026-10-19
("Characters", "Letters and digits", "Identifiers", "Keywords",
"Semicolons", "Comments" and "Import declarations"): 29 sources, each a
single import or a group with a package name, held to the import the page
has it make or to none. 0.27.0 read 16 of them as the page does, and lost
8 imports: names of the categories Lo, Ll, Lt and Lm, a name that starts
with `_`, one with a digit beyond ASCII, a name with no blank before the
path, and a raw string after a name. It read 5 the page refuses: a keyword
for the name, and a name at the end of its line. This build reads all 29 as
the page does. For C#, 23 sources were compiled by the compiler of the .NET
SDK 10.0.401 beside every type they may name, and then once without each
type they are said to name, which each failed to compile without: 0.27.0
read 4 of them as naming what the compiler has them depend on, and this
build all 23. Over 1,985 C# files on the workstation, those of a .NET
repository, of its NuGet cache and of its Visual Studio installation, both
builds read the same references: none of them writes a type argument or a
tuple in an alias.

- **A Go package name is an identifier as the specification has one**: a
  letter, `_` or a character of the categories Lu, Ll, Lt, Lm or Lo, then
  letters and decimal digits, Nd. A mark is no letter, so `cafe` followed
  by a combining accent is no name, and nor is a letter number such as `Ⅰ`
  or a formatting character; and the text is not normalised. The page has
  the categories of Unicode 8.0; it follows from the page, and is not on it,
  that a later Unicode's letters, which the Node that runs spec-guard has,
  are read as letters.
- **No keyword is a package name**, so `import func "fmt"` is read as no
  import, and an `import` written where a name stands starts no second one.
- **A name at the end of its line ends the import**: Go puts a semicolon
  after an identifier there, and a line comment or a general comment that
  holds a line break ends the line too, so `import db` with its path on the
  next line is refused and read as nothing. `import .` and `import` itself
  put none, and are read across the line, as before. The paths of a group
  are read as before, every literal between its parentheses.
- **A C# type is read whole**, as the specification writes one (Types,
  8; Unsafe code, 24.3; Namespaces, 14.6.2 and 14.6.4, on Microsoft Learn,
  dated 2026-09-22): its name, then each type its arguments name, each
  element of a tuple, and each parameter and the return of a function
  pointer, each a reference on the line of its `using`, in the namespace the
  directive stands in, the type's own name first. A type named twice,
  `G.L<G.L<int>>`, is one reference.
- **What names no type is read as nothing**: a keyword that names one,
  `int`, `string`, `object`, `void*`; a tuple element's own name; the
  alias; a calling convention, `unmanaged[Cdecl]`; and a type the compiler
  refuses, `void`, a pointer outside `unsafe`, a tuple of fewer than two, an
  unbound `G.L<>` and a pointer for a type argument.
- **A contextual keyword where a type stands is read as the name it may
  be**: `nint` and `nuint` name a type the program declares where type
  resolution finds one so named, and the native integers otherwise (Types,
  8.3.1), which the reader cannot tell; `dynamic`, a contextual keyword as
  well (6.4.4), is read as a name as it always was. So `using T =
  G.L<dynamic>;` names `G.L` and `dynamic`, as `using T = dynamic;` named
  `dynamic`.
- **A type is held to a depth, as a Rust group is**: a using directive
  whose types nest deeper than `MAX_EXPANSION` (64) is reported with the
  note `truncated`, and no reference, where a reader of a type by its
  grammar would run out of stack.
- **For a caller of the package**, `Reader.identifier` reads a name as Go
  has one.
- **It can turn a passing run red**, which is the point: a rule over a Go
  file whose package name is beyond ASCII, or over a C# alias that holds a
  type as an argument or an element, now sees it. It turns a failing one
  green over a Go import the specification refuses, and over `using T =
  int;` and its kind, which name no namespace.

`tests/names-read-whole.test.ts` holds each Go source to the
specification's import or to none, and each C# source to the types the
compiler has it depend on, and an import rule to both.

<!-- @assert-present file="tests/names-read-whole.test.ts" reason="a Go package name and a C# alias's type are held to what the specification and the compiler read of each" -->
