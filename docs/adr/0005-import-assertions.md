# ADR-0005: Import assertions

## Status

Accepted (0.3.0).

## Context

The string assertions spec-guard has today answer one question: how often does
this text appear. That catches retired symbols and stray secrets, and it is
honest about being a text search.

It cannot express the rule most architecture documents are actually about:

> The UI layer must not depend on the database layer.

You can approximate it - `@assert-absence target="src/ui" symbol="db/client"` -
and the approximation fails in both directions. It matches a mention in a
comment, and it misses `export * from '../db'`.

An external review put it as: roughly four fifths of architecture rules are
import rules, and import syntax is cheap enough to extract without a parser.
The first half is right. The second half is the part that needs care, because
the failure mode of "cheap enough" is a rule that passes while being violated,
and this project's stated position is that a silently passing assertion is worse
than none.

## What a naive version gets wrong

A regular expression over raw source misreads all of these:

```js
// import { Client } from '../db';        <- a comment
const doc = "import { Client } from '../db'";   // <- a string
import type { Client } from '../db';     // <- erased at compile time
export * from '../db';                   // <- a dependency, but not an "import"
const { Client } = await import(path);   // <- unknowable statically
```

The first two produce false positives, the last three false negatives. A rule
that is right most of the time is precisely the thing that stops people
checking by hand.

## Feasibility: measured, and then re-measured

The first version of this ADR quoted numbers from a throwaway prototype. Those
numbers were wrong, and the corrections are worth keeping because they changed
one of the arguments.

The real analyser - a state machine over code, comments, strings, templates with
`${}` nesting and regular expressions, emitting a token stream that the extractor
reads - was run over `node_modules`: 6,975 files, 49.3 MB of real third-party
JavaScript and TypeScript, including bundled and minified output.
`scripts/scan-corpus.mjs` reproduces it.

| | prototype | real analyser |
| --- | --- | --- |
| references found | 7,823 | **17,492** |
| dynamic sites | 1,900 | **198** |
| unanalysable | 5 (0.072%) | **6 (0.086%)** |
| throughput | 6.2 MB/s | **16.9 MB/s** |

The prototype was wrong in both directions: it missed more than half the
references, and over-counted dynamic sites by a factor of ten. It masked string
contents before extracting, which destroyed the very specifiers it was looking
for.

References break down as 10,474 `import`, 3,890 `require`, 2,790 `export ...
from`, 338 static `import(...)`, of which 1,265 are type-only.

### What the corpus found that reasoning did not

**An infinite loop.** `@` and `#` were treated as identifier starts but not as
identifier parts, so a decorator (`@Injectable()`) produced a zero-length token
and the scanner never advanced. The corpus run died of heap exhaustion; on a
user's machine it would have been a hang. No amount of unit testing against
hand-written samples was going to surface that - it needed real code with
decorators in it.

**JSX.** Every JSX closing tag is `</`, and `<` was in the set of tokens after
which `/` starts a regular expression. The scanner therefore read `</div>...` as
a regex and lost the rest of the file. Removing `<` from that set cut
unanalysable files from 8 to 6 and nearly doubled throughput, because the
scanner had been consuming enormous phantom regular expressions. The trade is
that `a < /re/.test(b)` is now misread instead, which is a shape that does not
occur in practice.

The six files that remain unanalysable are five JSX files and one TypeScript
file in rxjs. They are **detected**, which is the property that matters: the
analyser declines to answer for them rather than reporting them as clean.

### What this does to the design

The 0.086% residue is acceptable only because it is self-reported.

The dynamic-import argument changes, though. At 1,900 sites the case was
"a fifth of module references cannot be resolved, so this is central". The real
figure is 198 against 17,492 - about **1.1%**. That is not common. It is still
load-bearing: a layering rule can be defeated by a single `await import(path)`,
and a rule that silently ignores it gives false confidence about exactly the
kind of dependency someone took the trouble to hide. Rare and consequential
argues for reporting it, not for ignoring it - but the honest reason is
consequence, not frequency.

## Proposal

Two directives, mirroring the existing pair:

```md
<!-- @assert-import-absence target="src/ui" module="src/db" reason="ADR-0004: the UI talks to services, not storage" -->
<!-- @assert-import-count target="src" module="axios" max="1" -->
```

| Attribute | Meaning |
| --- | --- |
| `target` | which files to analyse (as today) |
| `module` | which dependency, matched with `exclude`'s gitignore-style rules |
| `exclude` | files to leave out (as today) |
| `types` | `include` (default) or `ignore` - see Q1 |
| `reason` | as today |
| `expected` / `min` / `max` | on `@assert-import-count` only |

### Q1. Does `import type` count?

**Yes by default; `types="ignore"` opts out.**

These are two different questions and both are legitimate:

- *Coupling*: `import type { User } from '../db'` means the UI knows the
  database's shape, and a change there breaks it. That is a dependency.
- *Runtime*: the import is erased. For a rule about bundles or load-time cycles
  it genuinely does not exist.

The default goes to counting because of which mistake is recoverable. If the
default ignored type imports, `@assert-import-absence target="src/ui" module="src/db"`
would pass while every file in `src/ui` imported `src/db`'s types - a silent
pass on the exact rule the user wrote. The opposite mistake is a visible
failure with an obvious remedy.

Classification is at the statement level: `import type ... from` is type-only;
`import { type A, value } from` is a value import. Inline type specifiers are
not tracked individually - that distinction needs a real parser, and pretending
otherwise would be the same error this ADR exists to avoid.

### Q2. Do re-exports count?

**Yes, always, at the same weight as an import.**

```js
export * from '../db';
export { Client } from '../db';
```

Both make the re-exporting module depend on `../db` at runtime. They also
deserve *more* attention than a plain import, not less: a barrel file
re-exporting across a boundary is the usual way a layering rule gets violated
without anyone noticing. `export type { ... } from` is type-only and follows
the `types` setting.

### Q3. Does `require()` count?

**Yes, when the argument is a single string literal.**

`require('../db')` is a dependency; which module system expressed it is not
architecturally interesting. The syntax is unambiguous with a literal argument,
so there is nothing to guess.

Boundaries: only a call in expression position, not a property access
(`foo.require(x)` is ignored), and only a literal argument. `require(name)`
falls into Q4.

### Q4. What happens when static analysis cannot answer?

This is the part that decides whether the feature is trustworthy.

Three things can leave an answer incomplete:

| Situation | Example |
| --- | --- |
| dynamic specifier | `await import(path)`, `require(name)` |
| lost sync | the 0.072% - unterminated template or regex |
| unreadable | permissions, or a file that is not JavaScript or TypeScript |

Each analysed file therefore produces **notes** alongside its specifiers, and
notes are scoped: only those inside the assertion's own target scope are
reported, because only those could change its answer. A dynamic import in an
unrelated directory is not this assertion's problem.

Default behaviour is to report, not to hide and not to fail:

```text
✔ docs/adr/0004.md:12  @assert-import-absence "src/db" (0 imports) in src/ui
  ⚠ 2 sites could not be resolved statically
      src/ui/lazy.ts:8   await import(componentPath)
      src/ui/plugin.ts:3 require(pluginName)
```

The count is still reported, because it is still true of everything that could
be seen. The warning is what stops it being mistaken for a complete answer.

`--strict` promotes those warnings to failures. That is the same meaning the
flag already has for missing target paths, generalised to its natural form:
*anything spec-guard could not fully verify is a failure*.

A file in scope that is not JavaScript or TypeScript is skipped, and the result
reports how many files were analysed out of how many were in scope - so a rule
pointed at a Python tree says "analysed 0 of 240 files" rather than "0 imports,
passed".

### How specifiers are matched

Relative specifiers are resolved by **path arithmetic only** - no filesystem
access, no extension guessing, no index resolution:

```
src/ui/panel.ts  +  ../db/client.js   ->  src/db/client.js
src/ui/panel.ts  +  ./widget          ->  src/ui/widget
anything         +  react             ->  react        (bare, unchanged)
anything         +  node:fs           ->  node:fs      (unchanged)
```

Matching then uses the same matcher `exclude` uses, so `module="src/db"` covers
`src/db`, `src/db/client` and `src/db/client.js` without the author thinking
about extensions.

**Explicitly not supported**, and documented as such: tsconfig `paths` aliases,
package `exports` maps, and `index` file resolution. An alias like `@app/db`
stays literal, so the rule is written `module="@app/db"`. Guessing at a
resolution algorithm is how a tool starts being confidently wrong.

## What this is not

- Not a resolver, not a type checker, not a linter.
- Not multi-language. JavaScript and TypeScript only, and files with other
  extensions are reported as skipped rather than treated as clean.
- Not a replacement for the string assertions; a different question.

## Risks

**The scanner is the whole thing.** If it desynchronises without noticing, every
assertion built on it is quietly wrong. Mitigation: the end-state check that
produced the 0.072% figure, plus a corpus test that scans a fixture set
including the shapes that broke the prototype - nested template literals,
regex-versus-division, JSX.

**Cost.** The prototype ran at 6.2 MB/s, so a 5 MB tree costs around 800ms. That
is slower than any search spec-guard does today, and unlike a search it cannot
be handed to ripgrep. Per-run caching of each file's analysis is required, and
the figure needs measuring properly before this ships as a per-push check.

**Scope creep.** "Which module does this import" is one question. "Is this a
cycle", "does this respect the layer order", "is this dependency unused" are
adjacent and tempting, and each one needs a graph rather than a per-file answer.
This proposal deliberately stops at the per-file question.

## Alternatives rejected

**A real parser.** Correct, and it means a dependency the size of the tool
itself, per language. The whole premise here is a binary with no runtime
dependencies.

**Regular expressions over raw source.** Cheap, roughly 90% right, and wrong in
the direction that produces false confidence.

**Only counting `import` statements.** Would have missed re-exports, which is
where the interesting violations hide.

## Naming

`@assert-import-absence` and `@assert-import-count`, not `@assert-no-import`.

The shorter form reads better in isolation, but the grammar of this syntax is
`@assert-<subject>-<claim>`, and keeping it means a future positive assertion is
already named: `@assert-import-present`. A syntax this small pays for
consistency more than it pays for a nicer verb.
