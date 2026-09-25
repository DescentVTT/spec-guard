# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org), with the 0.x caveat that behaviour
may change in a minor release — each such change is listed under **Changed**
with the flag that restores the previous behaviour.

## Unreleased

### Added

- **`spec-guard prove`: can each rule actually fail?** A passing rule cannot
  say whether the code holds or the rule cannot see the code. `prove` shows
  each rule in force a violation of itself - a file holding the forbidden text,
  a file importing the forbidden module, a cycle, an import across layers, a
  misnamed file, a required entry or a partner taken away, a required file
  removed - and runs the rule over it, in memory, through the door every read
  goes through: nothing is written to disk and nothing touches git. Each rule
  is `killed`, `survived` (the finding, with the violation shown) or
  `unprovable` (with the reason). Exit 1 when a rule survived, and under
  `--strict` when one is unprovable; `--json` is versioned by `formatVersion`,
  and `--format sarif` puts a survivor on its directive.
  `proveSpecGuard` is the same for a caller of the API. Run over this
  repository's own 71 rules, it found one that could not fail as written.
  [ADR-0016](docs/adr/0016-rules-seen-to-fail.md).
- **`RunOptions.io`: a run over a tree that is not on disk.** `runSpecGuard`
  reads through the `Io` it is given - finding and reading the specs, checking
  targets exist, walking them, scanning files, reading imports and listing
  directories - and through `nodeIo` when it is given none, as before. The run
  had the door all along and handed the filesystem to every reader itself.
  ripgrep reads the disk in a process of its own, where no door reaches, so
  `engine: 'ripgrep'` with an `io` is refused with a message that says so, and
  `auto` with one searches with the built-in scanner. A search that fails
  outright through the door fails the run, rather than falling back to the
  scanner that reads the disk. [ADR-0014](docs/adr/0014-configuration-and-watch.md).
- **`io` on `loadRuleSet` and `queryRules`, too.** A query found and read the
  specs, and asked whether each path exists, through the filesystem whatever
  the caller had; it now goes through the door it is given, as a run does, so
  a query over a tree in memory sees that tree.

### Fixed

- **A glob could take a minute to fail one file name.** Every pattern was
  compiled to a `RegExp`, and `*-*-*-*-*-*x` against a name of 121 dashes made
  V8 try every way of dividing the name between six `[^/]*` groups: 55 seconds,
  measured. Patterns are now read by the glob engine the spec-* tools share,
  spec-core's, whose automaton keeps a set of live states and cannot backtrack:
  the same match takes under a millisecond. spec-core is copied into
  `src/vendor/spec-core` and verified by hash, so `dependencies` stays empty.
  [ADR-0015](docs/adr/0015-globs-from-spec-core.md).
- **ripgrep and the scanner still read some patterns differently**, so the same
  rule could count differently on either side of the tree size at which `auto`
  changes engine. ripgrep anchored every alternative of `{src/*.ts,*.md}`
  because one held a `/`, dropped the empty one in `{,src/}a.ts`, matched
  nothing for `src/./a.ts`, and failed on a `}` that closes nothing. It is now
  handed each alternative as a glob of its own, spelled as the scanner reads
  it. And ripgrep applies no glob to a path named on its command line, so a
  rule whose target is a file its `glob` does not match, or a directory its
  `exclude` does, counted under ripgrep what the scanner left out; its list of
  files is now held to the same filters. ADR-0015.
- **Three fence shapes were read the wrong way round.** Directives inside code
  never execute, and what counts as code is decided by `maskCode`. It now
  follows CommonMark in two places it did not, and departs from it in one on
  purpose:
  - **A backtick fence's info string may not hold a backtick.** A line that
    reads ```` ```js`x ```` is prose that opens with a code span. Read as a
    fence, it hid every line under it, a real directive included, until
    something closed it - and nothing said a rule had gone quiet.
  - **A closing fence has no info string.** Inside a block opened by three
    backticks, a line of three backticks followed by `js` is a line of the
    block. It used to close it, and a directive shown after it executed.
  - **A fence may be indented any amount.** CommonMark counts its three spaces
    from the list item a fence sits in, so a fence in a `1.` item nested in a
    `-` item is five or more spaces from the margin. It was not recognised, and
    a directive shown inside it executed: always behind `~~~`, and behind
    backticks whenever the prose above mentioned one, since the two fence lines
    otherwise paired as a code span by accident. The price is paid by an
    indented code block - four spaces, outside any list - whose text is a fence
    line: it now opens a block. The sibling tools that read these documents
    make the same trade.

  Every Markdown file in this repository is masked exactly as before, and a
  test holds that, along with random documents built from the lines both rules
  read alike. This repository's own specs execute the same 66 assertions.

### Changed

- **A pattern that cannot be read is refused.** An unclosed `[` or `{`, an
  extended glob such as `+(a|b)`, a `..`, or a range that runs backwards, in
  `glob`, `exclude`, `module`, `order`, `pattern`, `dirs` or `required`, makes
  the directive invalid; in `exclude` in the configuration or `--exclude`, or in
  a spec pattern, it is exit 2. Each used to be read as a literal or as whatever
  its `RegExp` happened to mean, which is a filter that matches nothing and
  passes. So is an alternative that names no path, as in `{dist/**,}`, whose
  empty alternative matched the empty string. A brace group with a comma in it
  in a directive is one more case: a list attribute splits on commas, so
  `glob="*.{ts,tsx}"` was always the two patterns `*.{ts` and `tsx}`, and the
  message now says so. A configuration's `exclude` is a JSON array, where braces
  keep their commas. Nothing restores the old readings.
  [ADR-0015](docs/adr/0015-globs-from-spec-core.md).
- **`**` inside a segment is `*`**, as `.gitignore`, bash and ripgrep read it:
  `src/**.ts` matches `src/a.ts` and no longer `src/deep/a.ts`. ripgrep never
  crossed directories there, so a rule that did counted differently by engine.
- **A `.` or empty segment is no segment** (`src/./a.ts` is `src/a.ts`), and
  **a leading `/` anchors a `glob`** at the root, as it anchors an `exclude`.
  Both matched nothing in the scanner before; ripgrep already anchored.
- **`archived` withholds a document**, a sixth word beside `draft`,
  `proposed`, `rejected`, `deprecated` and `superseded`. `spec-brief` closes a
  task brief's round by setting `status: archived` and moving the brief to an
  archive directory. Its directives stated the round's premises and goals,
  which are history once the round is closed, and executed anyway they failed.
  An archived document is still parsed, validated and named in every output
  format. `--ignore-status` executes it as before. The list stays closed:
  `done`, `closed`, `archive` and every other near word stay in force, and
  [ADR-0010](docs/adr/0010-spec-status.md)'s amendment says why this word and
  no other.
- **The MCP server speaks the protocol through spec-core.** Classifying each
  request, the two eras, dispatch, result shapes and the stdio framing are
  spec-core's `jsonrpc` module, copied from `f085f29` and verified by hash;
  `src/mcp.ts` keeps the instructions, the tools and the resources. What a
  client sees is unchanged, and every test of the server passes as it was
  written. One edge moved: a last line cut inside a UTF-8 character when stdin
  closes is read as far as it goes rather than dropped. The protocol's names
  are still exported from the package. [ADR-0015](docs/adr/0015-globs-from-spec-core.md).

## 0.11.0

The literal this lexer never read. A JavaScript or TypeScript regular
expression can hold a quote — `/'/`, `/["']/`, `replace(/\/\//g, '')` — and
without a rule for `/`, that quote opened a string that closed somewhere else
entirely. Every text rule over a TypeScript project reads through this
classifier, and this repository's own `src/parser.ts` was one of the files it
lost its place in. [ADR-0006](docs/adr/0006-comment-classification.md).

### Fixed

- **A regular expression holding a quote desynchronised the scan.** The quote
  opened a string that ran to the next quote in the file, so the comments it
  covered were counted as code — and, once it closed, the scan was half a
  literal out of step, where a `//` inside a real string opened a comment that
  **hid real code**. `/` now opens a literal in `.js`, `.mjs`, `.cjs`, `.jsx`,
  `.ts`, `.mts`, `.cts` and `.tsx`, decided by the token before it with the
  same two tables the import tokenizer has used since 0.2.0 — which now live in
  one place and are read by both, so the two scanners cannot disagree. A
  character class holds an unescaped `/`, `\/` does not close, and a `/` that
  closes nothing before the end of its line was a division.
- **`/*` in JSX text opened a comment**, so `<div>/*</div>` hid every line up
  to the next `*/` in the file. After a tag's `>` it is text.
- **An apostrophe in a YAML value opened a string.** Most YAML scalars are
  unquoted and may hold one — `- name: Build the decoder's artefact` — and read
  with the shell's quoting that apostrophe closed on the next one, lines away,
  with every `#` between them no longer a comment. `.yaml` and `.yml` have a
  profile of their own, `yaml`, which keeps the shell's `#` rule and takes a
  quote as opening a scalar only where a word could start. `'it''s'` is one
  scalar, YAML's own escape. A shell's quotes still open mid-word, because
  `dir='C:\'` needs them to.

### Changed

- **A JavaScript string ends at its line.** Only a template may hold a line
  break, so a quoted string that reaches one was never a string and is read as
  code from there. It used to run to the end of the file. This is what JSX text
  costs as well: `<p>Don't click</p>` opens a literal nothing closes, and it
  now costs that line rather than everything after it.
- **The `shell-like` profile split in two.** `.sh`, `.bash` and `.zsh` are
  read as `shell`, `.yaml` and `.yml` as `yaml`, because their quoting
  differs: a shell's quotes open mid-word and YAML's open only where a value
  starts. The names themselves are internal — no output reports them — so what
  changed for a caller is the reading, described above.

Counts may move on a project that has any of these. A text rule over `.ts`,
`.tsx`, `.yaml` or `.yml` can now see code it could not see before, and can
stop counting comment text it was counting: on 7,953 files here, 119 phantom
comments in 63 files disappeared and 1,948 real comments in 53 files came back.
44 JavaScript files reported a lost scan before; 4 do now, every one of them a
template nested inside a `${…}` substitution, which ADR-0006 records as the
open item this release does not close.

The scan is also **faster than it has ever been** — 5.1× for TypeScript, 5.2×
for C#, 3.4× for C, 2.8× for shell scripts and 1.3× for Rust, whose raw strings
open with the letter `r` and so reach the slow path often. A character that
opens nothing in a language now costs one array lookup rather than four
searches that were always going to fail. That was not a bonus: adding the
regular-expression branch made C, which never enters it, 16% slower, and a
question asked per character has to be paid for per character.

## 0.10.3

Fixes from running 0.10.2 over a Rust and .NET monorepo, where an import rule
missed five `use` declarations in one crate and said nothing, and from probing
every other language profile for the same mistake.
[ADR-0006](docs/adr/0006-comment-classification.md),
[ADR-0008](docs/adr/0008-polyglot-imports.md).

### Fixed

- **A Rust lifetime hid the code after it.** Every `'` opened a character
  literal, and a lifetime - `&'static str`, `<'_>`, `'a`, `where 'a: 'b` - has
  no closing quote, so the literal ran on to the next quote in the file: often
  an apostrophe in a comment (`// don't`). Every `use` in between went unread
  without a note, because the literal did close; with no second quote, every
  `use` after it went unread with one. For a text rule the rest of that comment
  became code, and a `/*` in it hid code as a comment. Quotes are now read as
  `rustc_lexer` reads them: a quote and an identifier with no closing quote is a
  lifetime or a label, and `'a'`, `'\''` and `'"'` are character literals.
- **A Rust raw string with two or more hashes lost the scan.** `r##"…"##` read
  as an ordinary string that closed at its first inner quote. Any number of
  hashes is read now, in byte and C strings too (`br##"…"##`, `cr#"…"#`), and
  `r#type` stays a raw identifier. `literalValue` strips any number of them.
- **A `#` inside a word in a shell script or YAML file hid the rest of the
  line**, as in `${path##*/}`, `${#items[@]}`, `$#` and
  `url: https://example.com/#top`. `.sh`, `.bash`, `.zsh`, `.yaml` and `.yml`
  have a profile of their own, `shell-like`, in which `#` opens a comment only
  at the start of a line or after a space or a tab, as both languages define
  it. Their quotes follow their specifications as well: `'C:\'` is a complete
  string, and `$'it\'s'` is one string.
- **A C++ digit separator opened a string.** `100'000` read its quote as the
  start of a character literal, which paired with the next quote in the file.
  In `.c`, `.cpp` and the rest of the C profile, a quote after a word that
  begins with a digit is now part of the number; `u8'a'` is still a
  character.

### Changed

- **A Rust character literal ends at the end of its line.** None can hold a
  line break, and rustc stops reading an unclosed one there, so a quote misread
  in future costs at most the rest of its line. Such a file is still reported
  as unreadable, and the note now reads `a string or comment was never closed,
  so its imports are not trustworthy` - it used to say the literal ran to the
  end of the file.

JavaScript and TypeScript are read exactly as before: across 7,954 files, the
new lexer's ranges match 0.10.2's on every one. What it still misreads there - a
regular expression literal holding a quote, `/["']/` - is recorded in ADR-0006.

## 0.10.2

Fixes from running 0.10.1 over a .NET solution, where a layer rule passed while
the domain imported the application, and from reading C# as it is written in
2026 while fixing that.
[ADR-0011](docs/adr/0011-layers-and-cycles.md),
[ADR-0008](docs/adr/0008-polyglot-imports.md).

### Fixed

- **A dotted module pattern did not cover what sits beneath it.**
  `module="Shop.Application"` missed `using Shop.Application.Catalog;`, while
  `module="Shop/Application"` caught it. A layer named `Shop.Application` had
  the same gap, so `order="Shop.Domain, Shop.Application"` passed over a domain
  that imported the application. Each reference in C#, Python and Rust now also
  goes by every module it sits under, in its own notation, so `Shop.Application`
  covers `Shop.Application.Catalog` and not `Shop.ApplicationServices`,
  `app.db` covers `app.db.client`, and `crate::db` covers `crate::db::pool`.
  An `@assert-import-count` over those languages can count more files than
  before, and each is a file that depends on the module.
- **Three kinds of C# using were read under a name no pattern matched.**
  - `using global::Shop.Application;` read as `global.Shop.Application`, and
    `using Legacy::Shop.Application;` (an extern alias) as
    `Legacy.Shop.Application`. The qualifier is now left off.
  - A using inside a namespace may be relative to it: in `namespace
    Shop.Domain`, `using Application.Catalog;` can be
    `Shop.Application.Catalog`. It now counts under each name it can resolve to
    there.
- **Two kinds of C# string lost the scan.** A raw string literal (C# 11) that
  held a quote, or that opened with four quotes to hold three, and an
  interpolated verbatim string written `@$"C:\"`, were misread. Every using after
  one could go unread, and a text rule could count a comment as code. Both are
  now read as strings.
- **A backslash in a directive attribute was dropped.** Every backslash escaped
  the character after it, so `symbol="Shop\.(Application|Web)\b" regex="true"`
  searched for `Shop.(Application|Web)b`, matched nothing and passed, and
  `exclude="src\gen"` excluded `srcgen`. Only `\"`, `\'` and `\\` are escapes
  now; any other backslash is kept. Found by running this release's README
  example against a project file. A pattern written with doubled backslashes to
  get past the old behaviour, `\\b`, still reads as `\b`.
- **`.csproj`, `.fsproj`, `.vbproj`, `.props`, `.targets`, `.slnx`, `.nuspec`,
  `.resx` and `.xaml` were unclassified,** so a text rule over a project file
  counted a `<ProjectReference>` inside `<!-- -->`. They are now read as XML.

### Changed

- **A layer rule that could not have failed now fails** (`allow-empty="true"`,
  or `--allow-empty-scope`, makes each a warning again):
  - **A layer no C# using can reach.** A layer named by its folder,
    `src/Shop.Application`, holds the right files, but a using names a
    namespace, never a path. When a layer after the first matches none of the
    namespaces its own files declare, the rule fails:
    `no C# using can reach layer "src/Shop.Application": it matches none of the
    namespaces its files declare, such as Shop.Application.Catalog, so a
    dependency on it is never seen`. Name a C# layer by its namespace,
    `Shop.Application`, which matches the folder as well.
  - **A scope in which no import reaches another layer.** Such a rule would
    pass with its layers in any order: `no import in scope reaches a layer other
    than its own file's, so these layers would pass in any order`. This is how
    a layer named in a way no reference can match shows up in every language.
- **The files an import rule could not read are named by kind**, as in
  `analysed 5 of 7 files; 2 are in a language whose imports spec-guard cannot
  read (.csproj, .razor)`. In a .NET project, the count alone hid the Razor
  page among project files, and a Razor page can hold an `@using`.
- **README:** a section on C# and .NET solutions - layers by namespace, what an
  import rule cannot see and the text rule for each, and the `exclude` list for
  build output (`bin`, `obj`, `artifacts`, `TestResults`, `.vs`).
- **API:**
  - `ModuleReference` has an optional `namespace`, the namespace a C# using sits
    in.
  - `FileImports` and `LayerInput` have an optional `namespaces`, those a C#
    file declares.
  - `LayerReport` has `crossed` and `unreachable`.
  - New: `moduleNames` and `enclosingModules`.

## 0.10.1

Fixes from running 0.10.0 over a large monorepo, and from testing each exclude
shape under both engines while making them.
[ADR-0014](docs/adr/0014-configuration-and-watch.md).

### Fixed

- **The two engines disagreed about five shapes of exclude pattern.** Before
  this release, ripgrep was given each pattern as written, while the scanner
  normalised it first. Because `auto` picks ripgrep only for a large tree, the
  same rule could give a different count once the tree grew past that size.
  - `/target` excluded the root's `target` under ripgrep, and nothing under the
    scanner.
  - `/**/tests` excluded every `tests` under ripgrep, and nothing under the
    scanner.
  - `./build` excluded nothing under ripgrep, and every `build` under the
    scanner.
  - `src\gen` excluded nothing under ripgrep, and `src/gen` under the scanner.
  - `tests/` excluded only directories under ripgrep, and a file named `tests`
    too under the scanner.

  Both engines are now given one normalised pattern, and a leading `/` anchors
  to the root under both, as in `.gitignore`. Include globs had the same gap:
  `glob="./src/*.ts"` and `glob="src/"` matched nothing under ripgrep, and now
  match under both. Every one of these shapes is in the parity matrix. Layer
  `order` and import `module` patterns are read by the same matcher, so a
  leading `/` anchors there too, where it used to match nothing.
- **An exclude pattern that could never exclude anything was accepted
  silently.** Such patterns are now refused: exit 2 in the configuration or
  `--exclude`, and an invalid directive in `exclude="..."`.
  - `!`, which `.gitignore` uses to re-include a path. In
    `["build", "!build/generated/needed.ts"]`, `build` excluded the whole
    directory and the `!` line was ignored, so the exclusion was wider than it
    read.
  - `..`, which leads out of the root, where nothing is searched.
  - A drive path, such as `C:/repo/dist`.
  - `.` or `/`, which name the root itself.

  The message is `invalid exclude pattern "!build/generated/needed.ts":
  negation patterns are not supported in exclude`, after the file and key, the
  option or the attribute. A caller of the API gets the same message thrown.

### Changed

- **Reports name the exclusions in force.** The options line lists `exclude`
  with its patterns, as `options from .spec-guard.json: exclude (target, bin,
  obj, dist)`, applied or overridden. `--exclude=` shows as `exclude (none)`.
  Exclusions given only on the command line used to leave no trace, and now get
  a line of their own: `exclude from the command line: dist`.
- **JSON reports carry `exclude`**, the patterns in force, always present and
  empty when there are none, beside `config`, which says whether they came from
  a file.
- **`query` says why no rule governs a path** when an exclusion is the reason,
  rather than only `no rules in force govern this path`.
  - The project's exclude: `no rules in force govern this path: the project's
    exclude leaves it out (target)`.
  - A rule's own exclude, where the project's does not already leave the path
    out: `exclude="..." leaves it out of 2 rules`, followed by those rules.
  - A path an `@assert-present` still governs gets a note that the project's
    exclude leaves it out of every other rule.
  - In JSON, each path has `excluded: { project, rules }`, and the report has
    `exclude`.
- **The MCP server's answers carry the options line**, and both tools'
  structured content carries `exclude` and `config`. Its startup line names the
  patterns too.
- **API:**
  - `RunReport`, `RunPlan`, `RuleSet` and `QueryReport` have a required
    `exclude`, and `PathRules` a required `excluded`.
  - `formatConfigUse` takes the patterns as an optional second argument.
  - New: `formatOptionLines`, `normalizeExclude`, `normalizeGlob`,
    `excludePatternError`, `excludeListError`, `checkProjectExcludes` and
    `leftOutByOwnExclude`.
  - `McpServerOptions.settings` may return `config`.

## 0.10.0

Improvements from running 0.9.2 over a large polyglot monorepo: a
configuration a Rust, Go or .NET root can hold, exclusions a whole project
shares, and a cycle rule that can leave lazy loading out.
[ADR-0014](docs/adr/0014-configuration-and-watch.md),
[ADR-0011](docs/adr/0011-layers-and-cycles.md).

### Added

- **`.spec-guard.json`**, for a root with no `package.json`. It holds the same
  options, at the top level, with the same validation and exit 2 on any mistake.
  Options in both it and `package.json` are exit 2 too, rather than one file
  being silently ignored. A `package.json` with no `"specGuard"` beside it is
  fine.
- **`exclude` in the configuration, and `--exclude <globs>`**: paths no
  assertion looks at, such as build output (`target`, `bin`, `obj`, `dist`).
  - They are added to each directive's own `exclude`, under both engines, for
    text, import, layer, cycle and structure rules alike. `query`, the MCP
    server and watch mode apply them too.
  - `@assert-present`, which names its files, is unaffected.
  - A rule's description names only its own exclusions; the report's options
    line names the project's.
  - `--exclude` is repeatable, replaces the configuration's list, and
    `--exclude=` clears it.
- **`@assert-import-cycle dynamic="ignore"`** leaves `import('x')` out of the
  graph, so a loop closed only by lazy loading is not reported. A static import
  between the same files keeps the loop. It cannot tell a top-level
  `await import()`, which runs at load and can deadlock, from one inside a
  function, and ignores both. The default is `include`, and the description says
  `(dynamic imports ignored)`.
- `findConfig`, `parseStandaloneConfig` and `CONFIG_FILE` in the programmatic
  API.

### Changed

- **`spec-guard query` accepts `--no-color`.** Its output never has colour, and
  scripts pass the flag to every command they run. `--color` is still refused.
- **A blank line now separates a passing assertion's warnings** from the summary
  or a failure that follows them.
- **API:** `ImportQuery` has a required `includeDynamic`. `buildGraph` takes an
  optional fourth argument, `includeDynamic`, which defaults to `true`.
  `RunOptions`, `RuleSetOptions` and `ResolveContext` take `exclude`.
  `loadConfig` reads `.spec-guard.json` as well as `package.json`.

## 0.9.2

### Fixed

- **A passing assertion's warnings were printed only with `--verbose`.** Without
  it, the report printed the note about matches inside comments but hid the
  rest:
  - module references that could not be resolved;
  - imports missing from the graph;
  - files that belong to no layer;
  - target paths that were not found.

  They now print on a passing run either way, one line per warning with the
  assertion's location, as `--verbose` prints them. The MCP server's text and
  watch mode, which render without `--verbose`, show them too.
- **An apostrophe in JSX text lost the rest of the file's imports.** In
  `<span>Don't click</span>`, the `'` opened a string that never closed, and the
  file was reported as unanalysable.
  - A quote straight after a letter or digit whose string does not close on its
    line is now read as text. That covers contractions, possessives such as
    `users'`, and `5"`.
  - A quote after a space or punctuation that never closes still marks the file
    unanalysable, as does `/*` inside JSX text.
  - Tracking JSX text in general was turned down: a TypeScript cast or a
    generic arrow read as markup would skip real code without a word.
    [ADR-0005](docs/adr/0005-import-assertions.md).

## 0.9.1

### Fixed

- **A self-closing JSX element after an expression attribute lost the rest of the
  file's imports.** In `<App x={y} />`, `<App {...props} />` and the like, the
  tokenizer read the `/` after `}` as the start of a regular expression.
  - The scan ended at that line, and the file was reported as unanalysable.
  - Its imports after that line went uncounted by import, layer and cycle
    assertions.
  - `/>` after `}` is now read as the end of the element.
  - `/>` anywhere else still starts a regular expression, so
    `replace(/>/g, '&gt;')` reads as before.

  [ADR-0005](docs/adr/0005-import-assertions.md).

## 0.9.0

A project's policy can live in its `package.json`, and `spec-guard --watch`
reports again as the tree changes, re-executing only the rules a change
affected. [ADR-0014](docs/adr/0014-configuration-and-watch.md).

### Added

- **Options in `package.json`, under `"specGuard"`:** `specs`, `engine`,
  `strict`, `allowMissingTargets`, `allowEmptyScope`, `ignoreStatus`,
  `includeSpecs`, `defaultSkips`, `maxSnippets` and `concurrency`.
  - Read from the root's `package.json` only, never a parent directory's.
  - Validated before anything runs. An unknown key, an option that belongs to one
    invocation (`format`, `verbose`, `watch`, ...), a string where a boolean goes
    or a count out of range is exit 2, naming the file and the key. `--help` and
    `--version` still work under a broken `package.json`.
  - The command line wins: patterns replace `specs`, and every on/off option the
    file can set gained its opposite - `--no-strict`,
    `--no-allow-missing-targets`, `--no-allow-empty-scope`, `--no-ignore-status`,
    `--no-include-specs` and `--default-skips`.
  - A report that took anything from the file names it in a line above its
    summary, with what the command line overrode; the JSON report carries
    `config`.
  - `query` applies the keys a query reads. The MCP server reads the file again
    for every request, as it reads the specs.
- **`spec-guard --watch`.** Reports, then reports again whenever something under
  the root changes, until Ctrl+C, which exits 130.
  - Saves are batched: 50 ms of quiet, or 500 ms after the first change. Enter
    re-runs everything. A change no rule reads updates the status line only.
  - Only the rules whose directive or inputs changed are re-executed. On this
    repository a save in `src` re-executes 21 of 60 rules in a median of 21 ms -
    over the 15 ms it was built to, as ADR-0014 reports - and a save elsewhere
    takes 2-3 ms.
  - One recursive `fs.watch` on the root, and no dependency.
  - Refuses `--engine` - it scans in-process, where it sees what each rule reads -
    and `--json`, `--format json|sarif`, `--print-baseline`, `--fail-fast` and
    `--allow-empty`.
  - A test changes trees at random and requires every report a session gives to
    equal a fresh run's, however the change is reported, and six deliberately
    broken sessions have to fail it.
- **One door for every read** (`Io`, `nodeIo`, `readText`, `watchTree`), and the
  session behind watch mode (`createSession`, `runWatch`, `createFactCache`,
  `createMemo`) in the programmatic API. `runSpecGuard` is `planRun`, an
  execution and `reportRun`, and those two are exported.
  `createJavaScriptEngine(io, memo)` builds a scanner over a door, and
  `createCachedEngine(engine, fallback)` names what it falls back to.
- `scripts/bench-watch.mjs`, which measures a session on a copy of this
  repository.

### Changed

- **API:** `defaultDirectoryReader` and `statOrNull` are gone for `nodeIo`.
  `WalkOptions.readDirectory` is `WalkOptions.io`, `enumerateCandidates` takes an
  `Io` as its third argument, and `createTreeIndex(root, io)` takes a whole door.
  `Assertion.missingTargets` is gone: only execution ever wrote to it.
- This repository keeps its specs in `package.json`, and its selfcheck, CI run
  and SARIF upload run `spec-guard` without patterns.
- **Mutation testing in CI runs in four parallel shards.** The full sweep took
  42m39s against a 45-minute job limit, and a slower runner was cancelled on the
  same source. Hosted runners vary by a fifth or more on identical work.
  - Each shard mutates its own files, balanced on per-file minutes read from
    sweep logs (`scripts/mutation-timeline.mjs`).
  - A final job merges the reports (`scripts/mutation-shards.mjs`). It refuses a
    missing shard, a file mutated twice or by the wrong shard, and shards that ran
    different tests, then applies the 97% gate to the merged score.
  - Every shard runs every test: Stryker's vitest runner now has `related: false`.
  - A full sweep starts from no incremental file, and a branch's shard from only
    its own part of main's. Stryker reports the verdicts an incremental file holds
    for files a run does not mutate, and on the first sharded sweep every shard
    reported every other shard's files with the previous sweep's verdicts. The
    merge refused that sweep.
  - No mutants were left out, the per-mutant timeout is unchanged, and the gate
    is unchanged. [ADR-0003](docs/adr/0003-mutation-testing.md).

### Fixed

- **A binary file was a gap for every rule sharing its pass.** A plain run scans
  every rule over one scope together, and kept one ledger for them: a binary file
  holding one rule's symbol was reported against all of them with their matches
  summed, so `--strict` failed rules over files that did not hold their symbol.
  The count of files whose comments could not be classified leaked the same way.
  Each rule now has its own.
- **Two runs of one tree could list skipped files in different orders**, and past
  the ledger's cap of 100, name different ones: files entered the ledger as their
  reads finished. They now enter in walk order.
- Executing one resolved assertion twice named each missing target twice. Nothing
  did so before watch mode.
- A test of the MCP server's durations that failed about one run in 53, on
  floating-point error in the test.

## 0.8.0

An architecture document can now state conventions about names and layout: what
the files in a directory are called, what every package holds, and which files
come in pairs. [ADR-0013](docs/adr/0013-structure-assertions.md).

### Added

- **`@assert-structure`**, with exactly one of three claims per directive:
  - `pattern="*.entity.ts, index.ts"` - every file in scope is named by one of
    the patterns;
  - `required="package.json, README.md"` - every directory holds each entry.
    The directories are the targets, or with `dirs="*"` their children and with
    `dirs="**"` every directory below them, empty ones included. An entry may be
    a path, may end in a glob, and must be a directory when it ends in `/`;
  - `partner="[name].test.[ext], tests/[dir]/test_[name].py"` - every file has
    one of its partners. Three placeholders and no other grammar: `[name]` and
    `[ext]` split the file name at its last dot, and `[dir]` is the file's
    directory below its target.

  Names are compared exactly from directory listings, never by looking a path
  up, so `Readme.md` does not satisfy `README.md` on Windows or macOS any more
  than it does on Linux. A scope with no files or no directories fails, as does
  a partner template naming the file itself and a `required` target that is a
  file. When a file has no partner because it *is* one, the report says so and
  suggests the `exclude`. Takes `glob`, `exclude`, `max`, `allow-empty`,
  `baseline` and `ratchet`. Spec files are in scope, and symbolic links are not
  followed. All structure rules in a run share one walk per target and read
  each directory once.
- `spec-guard query` and the MCP server show what a structure rule asks of a
  path: whether a file's name is allowed, the partners it needs, and - for a
  file in a directory a `required` rule holds - that rule.
- The JSON report carries `claim` on structure results. A match with `line: 0`
  is a path rather than a place in one, and SARIF annotates a misnamed or
  partnerless file at its first line, and a directory missing an entry at the
  directive, with the directory in the message.
- `checkStructure`, `createTreeIndex`, `expandPartner`, `partnerTemplateIssue`
  and `requiredEntryIssue` are exported, with their types. `walkPaths` takes an
  `onDirectory` callback.

### Changed

- **`executeAssertion` needs a `tree`** in its options: `createTreeIndex(root)`,
  the run's directory listings, beside the `imports` and `hasFiles` caches it
  already takes. Only code calling `executeAssertion` directly is affected;
  `runSpecGuard` and the command line create it themselves.
- The MCP server's instructions and the `get_architectural_rules` description
  tell an agent that the rules for a path now include what it must be named and
  the partner files it needs.
- **Mutation score 98.63%** over 6,939 mutants, up from 0.7.0's 98.47%, with 92
  survivors - one fewer than before the 676 mutants this release adds.
  `structure.ts` is at 100%, and every other module has exactly the survivors it
  had, less one in `glob.ts` that the new tests turned into a genuine hang. A
  local sweep had reported four survivors in the new listing cache as killed; CI
  found them, and they are tested. See
  [ADR-0003](docs/adr/0003-mutation-testing.md).

## 0.7.0

Two things an architecture document could not do before. It can state the shape
of a codebase: which layers depend on which, and that nothing imports itself
round a loop. And it can be asked, before any code is written, which of its
rules govern the file about to change - from the command line, or by an AI agent
over the Model Context Protocol. Building the second found a false green older
than every release, and it is fixed below.

### Added

- **`@assert-layers`** - one directive for a layered architecture.
  `order="src/domain, src/application, src/infrastructure"` runs from the layer
  everything may depend on to the layer that may depend on everything; a file
  importing from a layer listed after its own is a violation, reported with both
  layers and the import. Layers are patterns in the `module=` language, so a bare
  `domain` holds Python, Go, Rust and C# code to the same order as TypeScript.
  A layer that matches no file, a file two layers both claim, and a missing
  target all fail rather than pass; files no layer claims are counted in a
  warning. Takes `max`, `types`, `exclude`, `allow-empty` and a debt `baseline`.
- **`@assert-import-cycle`** - import cycles, counted as strongly connected
  components rather than simple cycles, so a second route around an existing
  knot does not move the count. Each is shown as its shortest loop with the line
  of every import on it. Found with an iterative Tarjan's algorithm: the
  recursive form overflows Node's default stack at 10,000 files.
  `types="ignore"` asks the runtime question. JavaScript and TypeScript only,
  because a cycle needs to know which file an import *is*; imports that should
  have become an edge and did not are reported, and fail under `--strict`.
  See [ADR-0011](docs/adr/0011-layers-and-cycles.md) for the resolution table,
  and for why the other four languages are not in the graph.
- `buildGraph`, `resolveReference`, `stronglyConnected`, `cyclicComponents`,
  `witness`, `checkLayers` and `referenceForms` are exported, with their types.
- **`spec-guard query <paths...>`** - the rules in force for a file or directory,
  grouped by the document that states them, with each rule's reason, a path's
  position in every layer order (`may import`, `must not import`), and any
  baseline entry that exempts it. Answered from the specs alone, without reading
  the codebase, so it works for a file that does not exist yet; `--json` for
  scripts. Rules in documents that are not in force are counted and named, and
  listed with `--ignore-status`. The arithmetic behind it is tested against the
  files a real run searches, under both engines and on random trees; see
  [ADR-0012](docs/adr/0012-query-and-mcp.md) for the three things it cannot see.
- **`spec-guard mcp`** - a Model Context Protocol server on stdio, with no
  dependency on the MCP SDK. Tools `get_architectural_rules` (the query) and
  `check_architecture` (a run, narrowed to the rules governing given paths, each
  judged over its whole scope, with violations marked as in those paths or not);
  resources `spec://rules` and `spec://doc/{+path}`. Serves clients that open
  with `initialize` (2024-10-07 to 2025-11-25) and clients on 2026-07-28 that
  version every request and probe with `server/discover`, classifying each
  request the way the TypeScript SDK's own server does. Run end to end against
  the official clients: `@modelcontextprotocol/sdk` 1.30.0, and
  `@modelcontextprotocol/client` 2.0.0 pinned to 2026-07-28, probing, and on
  the legacy handshake.
- **`--spec <pattern>`**, repeatable: where `query` and `mcp` take their specs,
  and an alternative to positional patterns for a run.
- `select` on `runSpecGuard`, to execute only some of the resolved assertions.
  `readSpecs`, `parseDocument`, `parseTitle`, `walkPaths`, `governs`,
  `queryRules`, `createMcpHandler` and `serveStdio` are exported, with their types.

### Fixed

- **A rule whose every `target` was missing searched the whole repository**
  under `--allow-missing-targets`, because an empty target list means the root
  to the engine. So `@assert-count target="src/auth" symbol="verifyToken"
  min="1"` kept passing after `src/auth` was deleted, as long as a test still
  named `verifyToken`; import, layer and cycle rules did the same. This has been
  true since 0.1.0 - the 0.3.0 entry below that describes the old behaviour as
  "search nothing, find nothing" was wrong about what the code did. Such a rule
  now has an empty scope: it fails as one, and with `--allow-empty-scope` or
  `allow-empty="true"` it finds nothing. **If you rely on
  `--allow-missing-targets` for a rule whose only target is gone, add
  `--allow-empty-scope`.**
- An import rule whose only target is missing, without `--allow-missing-targets`,
  now says the target does not exist instead of that its scope is empty.

### Changed

- **`query` and `mcp` are commands when they are the first argument.** A spec
  file literally named `query` or `mcp`, passed as the first pattern, now starts
  a command instead; write `./query`, or put it after `--`.
- **A rule whose every `target` is missing has an empty scope under
  `--allow-missing-targets`**, where it used to search the whole repository -
  see Fixed. Add `--allow-empty-scope`, or `allow-empty="true"` on the rule, for
  it to pass. Searching the root in its place is not restorable: it was the bug.
- **Mutation score 98.47%** over 6,263 mutants, up from 0.6.0's 97.77%, with 93
  survivors - four fewer than before the 1,185 mutants this release adds. The
  layering and cycle modules are at 99.51% (`graph.ts`) and 96.43%
  (`layers.ts`); their three survivors were shown equivalent by running the
  mutated build against the real one on thousands of random inputs. The query
  and the server (`query.ts`, `rules.ts`, `mcp.ts`, `specs.ts`) are all at 100%;
  most of the survivors found on the way were code nothing could observe, and it
  was deleted. See [ADR-0003](docs/adr/0003-mutation-testing.md) for both
  accounts, and for why one sweep's count is good to about three.
- `version(manifest?)` takes the manifest to read, so its fallback for a broken
  install - `0.0.0` rather than a crash - is tested.
- **Reading specs is several times faster**, which a query's budget made worth
  measuring. `maskCode` builds ranges instead of blanking a character array
  (7.8 ms to 1.1 ms over this repository's specs, identical output on 72 real
  documents and 100,000 random inputs); spec globs no longer stat every file
  they list (102 ms to 18 ms over 1,200 specs on Windows); and specs are read
  16 at a time. A query over this repository went from 24.6 ms to 5.1 ms. A run
  spends most of its time searching code, so this repository's selfcheck gained
  about 8%.
- The SARIF fingerprint of an assertion that names neither a symbol nor a file
  now includes its description. Only the two new kinds are affected; every
  existing alert keeps its identity. Without it, two cycle rules on one target
  would have been merged into one alert.

## 0.6.0

ADRs have a life, and spec-guard now reads it. A proposed ADR can carry live
assertions without breaking the build, and a superseded one can stay on disk
without enforcing the rule it records being replaced. Most of the work is in
making sure a rule that stops running can never look like a rule that passed.

### Added

- **Document lifecycle status.** A Markdown document whose status is `draft`,
  `proposed`, `rejected`, `deprecated` or `superseded` is parsed, validated,
  reported by name - and not executed. A proposed ADR can now be written with
  its assertions live and the build green, and a superseded ADR can stay on
  disk, intact, enforcing nothing. Three spellings are read, because three are
  in use: MADR front-matter (quoted, as MADR's template writes it, or not), a
  Nygard `## Status` section, and a bold `**Status:**` label in the preamble.
  CRLF documents read the same as LF ones. Anything else - an unrecognised
  word, a misspelling, no status at all - keeps enforcing, which is the
  direction that cannot turn a typo into a silently disabled rule.

  Withholding is never quiet. Every withheld document is named in the human
  report (`○ docs/adr/0011.md is Proposed. - 2 assertions not executed`), in
  `--format json` as `inactiveSpecs`, and in `--format sarif` as a note-level
  execution notification - because a rule that has gone quiet is otherwise
  indistinguishable from a rule that passed. Directives in a withheld document
  are still checked for typos, bad attributes and unresolvable values, so a
  draft's mistake is found on the day it is written rather than on the day
  everyone agrees the rule is right and stops looking at it.
  See [ADR-0010](docs/adr/0010-spec-status.md), which also records why there is
  no per-directive `if-status` attribute.
- `--ignore-status` executes every directive whatever its document declares -
  how to ask whether a draft would pass if you accepted it today.
- `parseStatus`, `INACTIVE_STATUSES`, and the `SpecStatus` / `InactiveSpec`
  types are exported from the programmatic API.

### Changed

- **A run that executed no assertions no longer reports that every assertion
  holds.** It says `no assertion was executed, so nothing was verified`. True
  and useless was the old sentence's problem: it is the exact line someone
  reads as proof their specification is being enforced. Reachable before this
  release through a spec file with no directives in it; withholding made it
  easy to reach.
- `RunSummary` gains `inactive` and `RunReport` gains `inactiveSpecs`. Both are
  always present; consumers deep-comparing a summary object will see the new
  field.
- **Mutation score 97.77%** over 4,482 mutants, against the gate of 97 - up
  from the 97.65% 0.5.1 shipped with, and no survivor in the new code. Getting there turned up a way a local sweep overstates a score
  that the timeout warning could not see: a regex constant at module scope runs
  the whole suite per mutant, so on a loaded machine an unrelated test timing
  out is scored as a kill. Those patterns are now verified by applying every
  mutant by hand, `scripts/mutation-regex.mjs`, and the account is in
  [ADR-0003](docs/adr/0003-mutation-testing.md).

## 0.5.1

Writing down what the code already claimed. Every module was driven to its
honest mutation-testing ceiling, and the exercise turned up six wrong answers
rather than six missing tests — which is the argument for doing it at all. No
new features, and nothing a user has to change.

### Fixed

- **Two assertions on the same symbol answered each other's comment handling.**
  The result cache keyed on the symbol, the targets and the search flags, but
  not on `comments`. A spec with `<!-- @assert-count symbol="X" ... -->` above
  `<!-- @assert-count symbol="X" ... comments="include" -->` returned whichever
  count ran first for both. The grouping test had the same omission, so the two
  were also merged into a single pass and the second was scanned with the
  first's mask. There is now one definition of "the same question", in three
  nested scopes, and the scope policy is part of it too.
- **An unreadable directory went unreported on a small repository.** The
  adaptive engine had the walk's skip ledger in hand and returned without it on
  any tree small enough to scan in process, so the same directory was a reported
  gap on a large repository and silence on a small one. Same tree, two answers,
  decided by its size.
- **Snippets from CRLF files carried a carriage return into the report**, which
  returns the terminal cursor to column 0 and overwrites the line just printed.
  The trim looked for `\r?\n` at the end of a line the caller had already cut at
  the newline, so it could never match.
- **A bad `regex="true"` pattern was reported as `Invalid regular expression:
  Invalid regular expression: /(/: ...`** — V8's message already says it once.

### Changed

- **Two requests differing only in `scope` are no longer merged into one
  search pass.** Reachable today only through the programmatic API, where a
  caller may build more than one `ScopePolicy` per run.
- `enumerateCandidates` takes a `WalkRequest` — a `SearchRequest` without the
  `symbol`, because a walk does not depend on one. Existing callers are
  unaffected; the symbol is now optional rather than required.
- `CachedEngine` declares `searchBatch` as present rather than optional, which
  `createCachedEngine` has always guaranteed.
- `KINDS` and `ALLOWED_ATTRIBUTES` are exported from the parser, so the
  directive grammar can be asserted rather than restated.
- **The mutation gate moves from 85 to 97**, against a CI measurement of 97.65%
  over 4,299 mutants. Every module is above 95% and three are at 100%, where
  0.5.0 ran from 73% to 96%. The 101 mutants still alive have each been applied
  individually and produce byte-identical output, so that figure is the ceiling
  rather than a way-point — and 29 that were assumed equivalent turned out not
  to be, and are now tested. See
  [ADR-0003](docs/adr/0003-mutation-testing.md), which also records a Stryker
  limitation found on the way: a mutant that stops a test file *loading* is
  reported as survived even though the suite is killing it.
- **`src/imports.ts` went from 73.74% to 95.89%.** The tokenizer was tested as a
  step towards a list of module references rather than as a thing with an
  output, so a template resumption that lost its place, a regex escape that
  skipped a character, and three lookup tables were all unpinned. One
  behaviour-preserving change came with it: the word branch starts its scan one
  character in, so progress is unconditional by construction rather than a
  consequence of a relation nothing enforced. Verified identical on 53.6 MB of
  real JavaScript.

### Internal

Not user-visible, but this is where the release's weight is: nine new test
files, 1,770 tests against 1,206 at 0.5.0, 100% line coverage, and the analyser
verified byte-identical to the published 0.5.0 across 6,976 files of real code.
Thirty-five negative controls confirm the suite goes red for each defect above,
and `scripts/mutation-equivalence.mjs` is in the repository so the equivalence
measurement stays reproducible.

## 0.5.0

Import assertions covered one language, so a dependency rule pointed at a
directory of Go files did not fail - it passed, having analysed nothing. That is
the same defect 0.4.0 was written to remove, and this release closes the two
remaining shapes of it: a rule that cannot read the language, and a rule whose
scope holds no files at all.

### Added

- **Import assertions read Python, Go, Rust and C#**, alongside JavaScript and
  TypeScript. `import a.b` / `from .rel import x`, `import ( ... )` groups,
  `use a::{b, c}` with nested expansion, `using static` and `global using`, and
  the dynamic forms (`importlib.import_module`) that can only be reported.
  Not four new tokenizers: the comment and string lexer from ADR-0006 masks the
  source and the readers work on what is left. Tree-sitter measured 94 MB
  unpacked against this package's 0.33 MB. See
  [ADR-0008](docs/adr/0008-polyglot-imports.md).
- **`baseline` and `ratchet`** on the absence assertions, for adopting a strict
  rule on a codebase that already breaks it. `baseline="src/legacy/a.ts:2"`
  names the debt by file and count. The ratchet is two-sided: new violations
  fail, and so does an entry the code no longer supports, because a baseline
  that only grows is an `exclude` with extra steps. `ratchet="one-way"` relaxes
  the second half. See [ADR-0009](docs/adr/0009-debt-baselines.md).
- **`--print-baseline`** prints the attribute that would exempt today's
  violations, for a human to paste. It prints; it does not edit. That is the
  whole answer to `--fix`, and ADR-0009 argues it.
- **`--format sarif`** writes SARIF 2.1.0, which GitHub turns into an annotation
  on the offending line. One alert per broken rule, anchored on the code, with
  the directive as a related location and a fingerprint that survives the code
  moving. `--json` is unchanged and is now also `--format json`.
- **`allow-empty` and `--allow-empty-scope`**, for the rules where covering
  nothing is the honest state of the world.
- **`baselinedMatches`, `staleBaseline` and `fileMatches`** on each result in
  `--json`.

### Changed

- **An assertion that inspected no files now fails.** A rule whose scope holds
  nothing passes every time and reads in the report exactly like a rule that
  inspected a thousand files and found nothing. The usual causes are a `glob`
  matching no extension in the tree, an `exclude` that swallowed the target, or
  an emptied directory. **If a run starts failing this way, the rule was
  covering nothing before it started failing;** `allow-empty="true"` on the
  directive, or `--allow-empty-scope` for the run, restores the old behaviour.
- **An import assertion fails when nothing in scope is in a language it can
  read**, rather than reporting "analysed 0 of 12 files" in a warning and
  passing.
- **`.py`, `.pyi`, `.go`, `.rs`, `.cs` and `.csx` files are now analysed** by import
  assertions rather than counted as skipped, so a rule over a polyglot tree
  starts finding dependencies it previously reported as unanalysable.
- **Mutation testing in CI runs in two tiers**: incremental on branches,
  a full authoritative sweep on `main` and nightly. The gate stays at 85 in
  both. See [ADR-0003](docs/adr/0003-mutation-testing.md).

### Fixed

- `excludeFiles` was applied after enumeration rather than during it, so an
  excluded spec file counted towards a budgeted walk. Only reachable through the
  adaptive engine's probe, where it could make a tree look larger than the file
  set actually being searched.
- The README described the safe-batching apparatus - containment and
  dovetailing checks before merging literals into a ripgrep alternation - as
  current behaviour. It was deleted in 0.4.0 when ripgrep became a pre-filter.

## 0.4.0

An audit found spec-guard reporting a clean pass on a repository that contained
the forbidden symbol. On a tree with eight copies of one token, the scanner
found two and ripgrep found four, and neither said anything about the rest.

### Changed

- **Hidden directories are searched.** `.github`, `.husky`, `.claude-rules` and
  `.agents` hold CI, hooks and agent rules, and both engines skipped them
  entirely - so an absence assertion passed while the forbidden thing sat in a
  workflow file.
- **The skip list is now four names**: `.git`, `.hg`, `.svn`, `node_modules`.
  `dist`, `build`, `out`, `coverage`, `.next` and eight others are searched,
  because spec-guard cannot tell build output from a directory of build scripts,
  and guessing wrong means a rule silently covers nothing. **If a run starts
  failing on your build output, that is this change, and the fix is to say so:**

  ```md
  <!-- @assert-absence target="." symbol="TODO" exclude="dist coverage" -->
  ```

- **`.gitignore` is no longer consulted.** It describes what git should carry,
  not what a rule covers - and ripgrep applies it only inside a git repository,
  so the same tree gave different answers depending on whether a `.git`
  directory existed above it.
- **Binary files are searched, and a match in one is reported** rather than
  dropped. It is not counted as a violation, but it is no longer invisible.
  "Binary" now means "contains a NUL byte" for both engines; the scanner used to
  look only at the first 8KB, which disagreed with ripgrep on files whose first
  NUL came later.
- **`--strict` fails when a file could not be inspected**, which now has a
  precise meaning: unreadable, or binary and containing the symbol.
- **The engines are one implementation.** ripgrep now answers only *which files
  contain this text*; the scanner does all counting, comment classification,
  binary handling and reporting for both. `--engine` changes how long a run
  takes, not what it concludes. See [ADR-0007](docs/adr/0007-search-scope.md).

### Added

- **`--no-default-skips`** to search even those four directories.
- **`skipped`** on each result in `--json`: what was not inspected, and why.

### Removed

- `DEFAULT_IGNORED_DIRECTORIES`, `canBatchLiterals`, `shouldBatchPatterns`,
  `createRipgrepSink` and `byteColumnToCharacter` from the public API. All of
  them existed to make ripgrep's own counting trustworthy; as a pre-filter it
  does not count, so pattern batching no longer has to be proved safe and
  ripgrep's byte columns no longer need converting.

### Fixed

- ripgrep's per-file errors are no longer discarded. `--no-messages` meant a
  file that could not be opened produced no match, no error, and no way to tell
  it apart from one that was read and found clean.
- `comments="include"` no longer changes whether binary files are searched. An
  attribute about comments decided that, because it selected a different code
  path through the engine.

## 0.3.0

### Added

- **`exclude` attribute.** Most real rules are "nowhere except one place", not
  "not here": `exclude="src/config/**"` expresses that in one assertion instead
  of a hand-maintained list of every directory that is not `src/config`. Follows
  gitignore semantics — deliberately different from `glob`'s basename matching —
  and a parity matrix asserts both engines agree.
- **Import assertions:** `@assert-import-absence` and `@assert-import-count`.
  "The UI layer must not depend on the database layer" is a dependency claim,
  not a text claim, and approximating it with a string search fails in both
  directions. A zero-dependency tokenizer resolves `import`, `export … from`,
  `import type`, dynamic `import()` with a literal, and `require()`. Module
  references it cannot resolve statically are reported, never counted as clean.
  See [ADR-0005](docs/adr/0005-import-assertions.md).
- **`comments` attribute.** See Changed, below.
- **`--allow-missing-targets`** to restore the previous handling of a `target`
  path that does not exist.
- **`commentMatches` and `unclassifiedFiles`** on every result in `--json`.

### Changed

- **Matches inside comments no longer count**, so the note recording that a
  symbol was deleted is no longer read as an occurrence of that symbol. This is
  the defect where documenting a decision defeated the assertion enforcing it.
  Comment syntax is known for 59 extensions across 9 families; strings are
  tracked too, since `//` inside a URL is not a comment. Where classification is
  uncertain the text counts as code, and every run reports how many matches it
  excluded — a pass caused by comment exclusion is never silent.
  `comments="include"` restores counting per assertion.
  See [ADR-0006](docs/adr/0006-comment-classification.md).
- **A `target` path that does not exist now fails the run** instead of warning
  and searching what remained. An assertion pointed at a renamed directory used
  to search nothing, find nothing, and report success. `--allow-missing-targets`
  restores the old behaviour.
- **`--strict`** now means "treat analysis that could not be completed as a
  failure" — it no longer carries the missing-target meaning, which is now the
  default.

### Fixed

- `search()` on the ripgrep engine was not comment-aware while `searchBatch()`
  was, so a spec containing exactly one assertion kept its comment matches.
- The two engines reported different columns for the same match on a line
  containing non-ASCII text: ripgrep counts bytes, the scanner counts
  characters, and editors count characters. ripgrep's column is now converted,
  so a reported location points at the match in both engines.
- Leftover `*.test.ts` files in scratch fixture directories were collected by
  Vitest, breaking a run with "no test suite found" because of debris from a
  previous one.

### Notes

The version in `package.json` was bumped to 0.3.0 during development but never
published; npm went 0.1.0 -> 0.2.0. Everything above ships together as the
first published 0.3.0.

## 0.2.0

### Added

- **Adaptive engine selection.** `--engine auto` now measures rather than
  guesses: a budgeted, stat-only enumeration decides whether a tree is small
  enough for the JavaScript scanner to beat a ripgrep process spawn. The probe
  is the work — the enumeration it performs is reused by the scanner, so
  choosing costs nothing when the scanner wins.
  See [ADR-0004](docs/adr/0004-adaptive-engine.md).
- **Mutation testing** with Stryker, wired into CI on every push, plus the tests
  that closed the gaps it exposed. See [ADR-0003](docs/adr/0003-mutation-testing.md).

### Changed

- Published as `@descent-vtt/spec-guard`. The binary is still plain
  `spec-guard`.

## 0.1.0

Initial release: `@assert-absence`, `@assert-count` and `@assert-present`,
written as HTML comments that are invisible in every Markdown renderer. ripgrep
primary with a pure-JavaScript fallback of identical semantics, safe assertion
batching, `--json`, and exit code 2 for "spec-guard could not run" as distinct
from "your specs failed".
