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
literals *and* whether the scan ran off the end of the file. Then:

```
source ──▶ lexRanges ──▶ mask comments + string interiors ──▶ statement reader
```

Everything the four readers see is code. Nothing in a comment, a docstring, a
verbatim string or a raw string can reach them. And because these languages put
imports in statements rather than expressions, what is left is small: the Go
reader is 25 lines, C# is 30, Python is 45, Rust is 40 including brace
expansion.

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

### Two decisions worth naming

**One notation, plus the language's own.** Module patterns are matched against
the resolved `/`-separated form (`app/db/client`) *and* against the specifier
as written (`app.db.client`, `crate::db::client`). A C# author should not have
to know that spec-guard rewrote their namespace before deciding to write
`System/Text/Json`. Matching both can only add matches, which for an absence
rule is the direction that fails loudly.

**Matching is case-sensitive, and polyglot rules feel it.** C# capitalises
namespaces where Go and Python do not, so a rule spanning both writes
`module="app/db/** App/Db/**"`. Case-insensitive matching was rejected: it would
make `module="app"` match a directory called `App` in a case-sensitive
repository, which is a different silent wrong answer.

### The cap

Rust brace groups nest, and nesting multiplies: expansion is exponential in
depth. A `use` statement that would expand past `MAX_EXPANSION` (64) paths
produces a `truncated` note and **no** references, rather than a partial list.
A half-read import statement is a rule that quietly covers less than it claims;
an error message is a rule that says so.
