# ADR-0002: HTML comments as the directive format

## Status

Accepted.

## Context

An executable assertion has to live inside a Markdown document without changing
how that document reads. The candidates were:

1. **YAML front-matter** - one block per file, far away from the prose it
   guards, and invisible to anyone reading the middle of a long ADR.
2. **A custom fenced block** (` ```spec-guard `) - visible in every renderer as
   a code block, cluttering the document with machinery.
3. **HTML comments** - invisible in every Markdown renderer, valid CommonMark,
   supported by GitHub, and legal anywhere in a document.

## Decision

Directives are HTML comments beginning with `@`:

```md
Payments no longer touch the retired gateway.

<!-- @assert-absence target="src/" symbol="LegacyGateway" -->
```

The format is `<!-- @assert-<kind> attribute="value" ... -->`, may span multiple
lines, and sits directly under the sentence it makes executable.

Two consequences fall out of choosing comments, and both are deliberate:

- **Fenced code and inline code are masked before parsing.** Documentation that
  shows the syntax - like this README and this ADR - must not execute it. The
  masking preserves byte offsets so reported line numbers stay exact.
- **Spec files are excluded from their own searches by default.** An ADR that
  says "`LegacyGateway` must not appear" contains the string `LegacyGateway`;
  without this rule every absence assertion would fail on itself. `--include-specs`
  turns the exclusion off.

**A backslash escapes only a quote or another backslash** (since 0.10.2).
Values need `\"` inside double quotes, and nothing more: the values people
write backslashes in are regular expressions and Windows paths, where the
backslash is the value's own. Until 0.10.2 every backslash escaped the next
character, so `symbol="\bTODO\b" regex="true"` searched for `bTODOb` and passed
for finding nothing, while the report quoted the rewritten pattern.

<!-- @assert-count target="src/parser.ts" symbol="ALLOWED_ATTRIBUTES" min="2" reason="unknown attributes must stay a hard error" -->
<!-- @assert-count target="src" symbol="excludeFiles" min="4" reason="self-exclusion is threaded through both engines" -->

## Consequences

A spec-guard directive is invisible in rendered Markdown, so an ADR keeps
reading like an ADR. The cost is that directives are also invisible to authors
who never look at the source - which is why `--verbose` prints every assertion
it executed, including the ones that passed.

## Amended 2026-09-26: Markdown is read by spec-core's scanner

What is code, what is a comment, where front matter ends and which lines are
headings is decided by spec-core's `markdown` module - its ADR-0004, exact
about code and comments by CommonMark's rules - copied into
`src/vendor/spec-core` from `4f2826a`, and again from `cbe2223`, and verified by hash
([ADR-0015](0015-globs-from-spec-core.md)). `src/parser.ts` keeps what is
spec-guard's: the directive grammar, the attribute table, and what a status
line means ([ADR-0010](0010-spec-status.md)).

Directives are still found in a masked copy of the document: the scanner's
`directives` mask, which blanks code and front matter and keeps comments. Its
offsets are the source's, a byte-order mark included, and lines are still
counted by line feeds, so every line and column a report gives is where it was.
`maskCode` is still exported, and is that mask.

<!-- @assert-import-absence target="src" module="src/vendor/spec-core/markdown" exclude="src/parser.ts, src/vendor" reason="one module reads Markdown, so every document is read one way" -->

The masking here was one of three scanners in the family, and each read some
shape wrong that another read right. This one had just been fixed for three
fence shapes. The scanner fixes those and the ones below by one rule for every
tool, and a fix made there once reaches all of them.

### What a document now reads as

The three fence shapes fixed in this release stay fixed. Beyond them, where
0.11.0 and the scanner part:

- **Comments and code spans are resolved left to right**, and whichever opens
  first wins. A backtick inside a comment is a character, so
  ``symbol="`eval`"`` is searched for as written, where the two backticks paired
  and the rule searched for six spaces.
- **A code span ends with its paragraph.** A backtick that closes nothing there
  is a character. Paired with the next one anywhere in the document, it hid
  every directive between the two. An escaped backtick opens nothing.
- **A fence shown inside a comment opens nothing.** A template that shows one
  hid every directive after it.
- **Indented code, raw-text HTML and front matter are not read for
  directives.** Four columns past the margin, or past the text of the list
  item a line sits in, after a blank line, are code in every renderer, and a
  directive shown there executed. So did one inside
  `<script>`, `<pre>`, `<style>` or `<textarea>`, whose content is not Markdown.
  `<details>` and `<div>` hold Markdown, and are read.
- **A fence's indentation is CommonMark's, but for an opener's limit.** An
  opener may sit at any indentation outside indented code, so a fence in a
  nested list item is one; a closer may sit at most three columns deeper than
  its opener. The fence rule first written in this release opened a fence at
  any indentation, indented code included, and closed one at any depth; its
  price - an indented code block whose text is a fence line, hiding the rest of
  the document - is not paid. `4f2826a` still paid it inside a list, where it
  read no indented code at all: a fence line shown as code under an item, six
  spaces in, opened a block nothing closed, and every directive after it went
  quiet. From `cbe2223` the scanner knows each item's text column, so a line
  four columns past it is code, and a fence line that deep is code or
  paragraph text, never an opener.
- **Every line terminator stays where it was.** `maskCode` keeps a carriage
  return inside code, where it blanked one.
- **A block never closed is a warning.** A code fence, or a `<pre>`,
  `<script>`, `<style>` or `<textarea>` block, that runs unclosed to the end
  of the document makes every line after it code, as every renderer shows it,
  and every directive there goes quiet. It is read that way still - the
  document is what the reader sees - and the report says so on the opening
  line, as a warning that fails nothing, in every format. A block that ends
  with its block quote, or holds nothing after its opener, hides nothing and
  is not one.
- **A directive masked is still counted.** A comment shaped like a directive -
  `<!--`, an `@`, a kind beginning `assert` - that sits in code, raw HTML or
  front matter is not run, as before, and the report counts them and names
  where: one dim line in the human report (the first five places, every one
  under `--verbose`), and `maskedDirectives` in JSON, each with what hid it -
  `fenced code`, `indented code`, `code span`, `raw HTML` or `front
  matter`. Most are examples shown on purpose, which is why it is a count and
  not a warning. But every shape above that moved a directive into code - an
  indented line, a `---` thematic break read as front matter, TOML front
  matter, a `<pre>` never closed - was a rule 0.11.0 ran and this one does
  not, and before this line nothing in a report showed the difference. The
  directives are found in the source as written, and kept when their `<!--`
  is blanked in the masked copy; a document with no `@assert` in it costs one
  substring search. That search decides what the work costs and never what it
  finds, so a mutation sweep that deletes it survives by construction. Over this repository's ADRs, README and changelog, 486 KB,
  `parseDocument` took a median of 23.1 ms against 22.7 ms without it,
  interleaved in one process.

A document's title is its first level-one heading as the scanner reads it: an
underlined one is a title, one kept in a comment is not, a code span in it is
kept as written and a comment in it dropped, and a first level-one heading with
no text leaves the document untitled. Its status is ADR-0010's amendment.

`tests/mask-differential.test.ts` holds the scanner to 0.11.0's masking on
every Markdown document in this repository - the same comments read as
directives at the same offsets, and a line masked differently only where the
scanner reads front matter, indented code or raw-text HTML - and on 3,000
random documents built from lines both read alike, and shows it parting from
0.11.0 on each shape above. Across the 143 Markdown files of the five spec-*
repositories, every directive and every status is read as the parser this
replaced read it, and every title but one: ADR-0009's, which keeps its
`` `--fix` ``.

### What it costs

The scanner does more than the masking did: it finds headings, which the
status and the title now use, and list items, links and tables, which nothing
here reads. Over this repository's 18 ADRs, 319 KB, `parseDocument` took a
median of 17.2 ms against 4.1 ms for the parser it replaced, interleaved in one
process on this repository's Windows machine. A warm `queryRules` for
one path, which reads every spec, took 23.1 ms against 8.8 ms: past the 20 ms
ADR-0012 set out to meet, for a server that reads the specs on every request. A
profile puts a fifth of the scan in links and tables. The remedy is either
spec-core's - a scan that finds only what it is asked for - or the server's, a
memo of parsed documents keyed by their bytes, as a watch session keeps
([ADR-0014](0014-configuration-and-watch.md)); neither is made here.
