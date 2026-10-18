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
  .NET SDK 10.0.401 compiles, are each read as nothing.

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
