# ADR-0004: Choosing an engine per search, not per run

## Status

Accepted (0.2.0).

## Context

Until 0.2.0, `--engine auto` meant "ripgrep if it is installed". That reads as
obviously right and is measurably wrong on small trees, because the two engines
have different shapes of cost:

- **ripgrep** is dominated by process startup. Its cost barely moves with tree
  size; it is essentially a fixed toll.
- **the built-in scanner** has no startup cost at all and grows linearly with
  the bytes it reads.

So there is a crossover, and `auto` should sit on the right side of it.
`scripts/bench-engines.mjs` finds it rather than guessing (median of 5, one
literal search over `src/`):

| files | size | scanner | ripgrep | winner |
| --- | --- | --- | --- | --- |
| 5 | 6 KB | 2.0 ms | 201.7 ms | scanner, 102x |
| 50 | 59 KB | 14.1 ms | 152.6 ms | scanner, 11x |
| 250 | 300 KB | 68.8 ms | 139.2 ms | scanner, 2.0x |
| 500 | 605 KB | 110.7 ms | 144.6 ms | scanner, 1.3x |
| 1000 | 1.2 MB | 231.0 ms | 126.4 ms | **ripgrep, 1.8x** |
| 2000 | 2.5 MB | 433.2 ms | 134.5 ms | **ripgrep, 3.2x** |

*Windows 11, Node 24, ripgrep 15.*

The same script on Linux (Node 22, ripgrep 13, in a container, tree on the
container's own filesystem) tells a very different story:

| files | scanner | ripgrep | winner |
| --- | --- | --- | --- |
| 5 | 3.3 ms | 15.2 ms | scanner, 4.7x |
| 50 | 17.6 ms | 12.0 ms | **ripgrep, 1.5x** |
| 500 | 211.7 ms | 16.7 ms | **ripgrep, 12.7x** |
| 5000 | 1801.5 ms | 66.2 ms | **ripgrep, 27x** |

The crossover is roughly **575 files on Windows and 25 on Linux** - an order of
magnitude apart, because the thing being measured is process spawn cost, and
that is what differs between the platforms.

A first attempt at the Linux numbers was thrown away: it ran in a container with
the tree on a Windows bind mount and reported 56 ms to search five files. That
measured Docker's filesystem layer, not the engines. The numbers above come from
a tree created inside the container.

## Decision

`auto` decides per search group, using a bounded enumeration as the probe.

Enumeration is stat-only work. The adaptive engine walks the target set with a
budget and stops the moment the tree proves bigger than the budget allows:

- **Under budget** - the file list is already in hand, so the scanner runs
  against it directly. No process, and no second walk.
- **Over budget** - the walk abandons after a bounded number of stats, and
  ripgrep takes over. If ripgrep turns out to be missing, the scanner runs as
  before.

The probe is the work, which is what keeps the heuristic honest: on a small tree
the "probe" produces the answer, and on a big one it is a rounding error against
the search that follows.

The budget is set just under each platform's measured crossover:

```ts
process.platform === 'win32'
  ? { maxFiles: 512, maxBytes: 1024 * 1024 }
  : { maxFiles: 32, maxBytes: 64 * 1024 }
```

*Amended 2026-10-07:* the budgets are 32 files and 2 MB on Linux, 64 files and
4 MB on macOS and 256 files and 8 MB on Windows, from
[measurements on machines doing nothing else](#amended-2026-10-07-measured-on-hosted-runners-a-budget-for-each-platform-and-bytes).

Deciding **per group** rather than per run matters because one document can
assert against `src/` and against a single file in the same run; those deserve
different answers.

<!-- @assert-count target="src/engine.ts" symbol="SMALL_TREE_BUDGET" min="2" reason="the budget must stay wired into the adaptive engine" -->
<!-- @assert-present file="scripts/bench-engines.mjs" reason="the numbers in this ADR must stay reproducible" -->

## Consequences

Measured end to end, on this repository's own specs (16 assertions, a handful of
files) and on a 2,000 file tree:

| | small tree | 2,000 files |
| --- | --- | --- |
| `--engine rg` | 793.7 ms | 195.8 ms |
| `--engine js` | 19.5 ms | 330.6 ms |
| `--engine auto` | **19.1 ms** | **171.9 ms** |

`auto` now tracks the better engine at both ends instead of losing badly at one.

Two costs are worth stating plainly. The reported engine for a run is now
whichever engine actually ran - `javascript` on a small repository even when
ripgrep is installed, which surprises anyone who expects the label to describe
what is available rather than what was used. And on Linux the budget is
deliberately small, so the adaptive path mostly hands over to ripgrep; the
benefit there is confined to genuinely tiny trees. The gain is largest exactly
where the old behaviour was worst: a small repository on Windows, where a spawn
cost forty times the entire search.

`--engine rg` and `--engine js` still force the matter, and both remain
covered by the parity tests that assert the two engines agree.

### The branch that made the choice visible after all

The whole point of deciding per group is that the choice must not change the
answer, and for a year one of them did. The small-tree branch had the walk's
skip ledger in hand - the probe produces it - and returned without it, so a
directory that could not be read was a reported gap on any repository large
enough to reach ripgrep and silence on any repository small enough to be scanned
in process. Same tree, two answers, decided by its size: exactly the divergence
ADR-0007 exists to remove, reintroduced by the optimisation that was supposed to
be invisible.

It survived because every test of this branch asserted a count, and a count is
the one thing the two paths did agree on. The regression test drives the
adaptive engine with its directory reader intercepted, which is the only
portable way to produce a directory that cannot be read - Windows has no chmod,
and a permission bit a failed test leaves behind is worse than no test at all.

## Amended 2026-09-30: ripgrep is found by using it

The README's design notes, an index of these records since, held one decision
about the engine that this record did not.

Under `auto`, whether ripgrep is installed is not asked up front. Probing with
`rg --version` costs a process spawn - about 27 ms on Windows - on the critical
path of every run, including the runs where ripgrep is missing. A group over
the budget runs ripgrep, and a binary that cannot be started leaves that group
and every later one to the scanner: its absence is discovered from the first
real search, for free. `--engine rg` does probe, since a run that asked for
ripgrep and has none stops with exit 2 before it searches anything.

## Amended 2026-10-07: measured on hosted runners, a budget for each platform, and bytes

The tables above were each measured on one machine, a developer's and a
container. Round 9's benchmark then saw ripgrep two to three times slower than
the scanner over 40,000 files, on a Windows workstation busy with other work,
and a busy machine says little about either engine. So the crossover was
measured again on machines doing nothing else. The budgets follow what they
showed: a number of files for each platform, and a byte budget that files of
ordinary length no longer reach.

### How it was measured

`scripts/bench-engines.mjs` times the two engines and `auto` beside them, the
three taken in turn so that a busy stretch slows them all, gives each as the
median of five or seven, and compares their answers before it prints a row. It
measures:

- **one search** over a tree, a rare literal asked of each engine directly, as
  the table this record opens with was;
- **a run** through the runner, of several targets of a given size with one
  rule on each. A run searches eight targets at a time, and under ripgrep each
  is a process of its own;
- files of 40, 400, 4,000 and 40,000 lines: 1.2 KB, 12 KB, 127 KB and 1.3 MB.

It ran on GitHub's hosted runners, from a workflow that lived on the branch
and was never merged, on three machines for each system each time: twice
with the budgets as they were (Actions runs 37513127759 and 37515544065),
which the tables below are from; three times while the budgets were being
set (37520236439, 37523451361 and 37526551857); and once with the budgets
decided here (37528219097), which is the table under Consequences. Each
figure is the median of the three machines' medians.

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| image | `ubuntu-24.04` | `macos-26-arm64` | `windows-2025-vs2026` |
| processors | 4, x64: EPYC 7763, 9V45 or 9V74, Xeon 8370C | 3, Apple M1, virtual | 4, x64: EPYC 7763, 9V45 or 9V74, Xeon 8370C or 8573C |
| Node | 24.21.0 | 24.20.0 | 24.21.0 |
| ripgrep on `PATH` | 14.1.0, from apt | 15.2.0, from Homebrew | 15.2.0, from Chocolatey |
| `rg --version`, median of 20 | 1.2-2.2 ms | 3-15 ms | 32-61 ms |
| the same, of the 15.0.0 binary `@vscode/ripgrep` carries | 1.2-2.2 ms | 2.5-6 ms | 11-19 ms |
| ripgrep's search of 16 files | 6 ms | 18 ms | 57 ms |

Two things about Windows. Chocolatey installs a shim that starts ripgrep, so
`rg` on `PATH` there is two processes, and costs some 35 ms more than the
binary started directly. And the hosted image turns Defender's real-time
protection off and excludes both drives, which no workstation does: every
Windows measurement was repeated with it on and the exclusions removed.

### One search

The scanner's time and ripgrep's, in milliseconds, the faster in bold:

| files | Linux: scanner | ripgrep | macOS: scanner | ripgrep | Windows: scanner | ripgrep |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | **2.0** | 6.2 | **2.3** | 18 | **2.9** | 57 |
| 32 | **3.2** | 5.6 | **5.0** | 14 | **5.5** | 57 |
| 64 | **4.4** | 6.0 | **7.4** | 14 | **8.7** | 57 |
| 96 | 6.6 | **5.1** | **12** | 16 | **13** | 58 |
| 128 | 9.7 | **6.8** | **13** | 14 | **18** | 62 |
| 192 | 13 | **6.7** | 23 | **18** | **26** | 63 |
| 256 | 17 | **5.8** | 29 | **19** | **33** | 64 |
| 384 | 24 | **6.5** | 40 | **24** | **50** | 65 |
| 512 | 30 | **7.2** | 45 | **24** | 73 | **68** |
| 1,024 | 65 | **8.7** | 74 | **30** | 131 | **74** |
| 5,000 | 313 | **19** | 437 | **61** | 683 | **146** |
| 40,000 | 3,674 | **106** | 3,494 | **464** | 5,963 | **840** |

One search crosses between 64 and 96 files on Linux, 128 and 192 on macOS
and 384 and 512 on Windows. Windows is where this record put it, at 575.
Linux is not: the 25 files measured in a container are 50 to 80 on these
machines.

### A run of several targets

ripgrep's time as a multiple of the scanner's, by the files in each target:
above 1 the scanner is the faster, and ripgrep in bold where it is.

| files a target | Linux: one search | 8 targets | 32 targets | macOS: one search | 8 targets | 32 targets | Windows: one search | 8 targets | 32 targets |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 3.10 | 2.03 | 3.03 | 7.79 | 3.35 | 2.82 | 19.93 | 10.61 | 11.83 |
| 32 | 1.54 | 1.21 | 1.52 | 4.15 | 1.74 | 1.55 | 10.40 | 6.33 | 6.30 |
| 48 | 1.47 | **0.76** | 1.00 | 3.80 | 1.23 | 1.19 | 8.36 | 4.35 | 4.09 |
| 64 | 1.18 | **0.61** | **0.75** | 3.15 | **0.88** | **0.88** | 6.22 | 3.56 | 3.38 |
| 96 | **0.76** | **0.48** | **0.54** | 1.63 | **0.59** | **0.73** | 4.46 | 2.31 | 2.32 |
| 128 | **0.70** | **0.39** | **0.40** | 1.11 | **0.80** | **0.51** | 3.48 | 1.75 | 1.88 |
| 192 | **0.49** | **0.30** | **0.29** | **0.82** | **0.49** | **0.45** | 2.38 | 1.19 | 1.27 |
| 256 | **0.35** | **0.24** | **0.23** | **0.82** | **0.47** | **0.33** | 1.97 | **0.99** | **0.92** |
| 384 | **0.27** | **0.18** | **0.17** | **0.61** | **0.34** | **0.35** | 1.32 | **0.74** | **0.66** |
| 512 | **0.22** | **0.15** | **0.14** | **0.46** | **0.32** | **0.33** | **0.93** | **0.59** | **0.59** |

- **Several targets cross at about half the files one search does:** between
  32 and 48 on Linux, 48 and 64 on macOS, 192 and 256 on Windows. Processes
  started side by side cost less each than one started alone: eight searches
  of 16 files took ripgrep 184 ms on Windows, 23 ms each, where one took
  57 ms.
- **Sixteen rules on one target cross where one rule does.** They share a
  pass, and a pass costs either engine little more for sixteen patterns than
  for one.
- **Round 9's shape is ripgrep's on a quiet machine.** Eighty targets of 500
  files, three rules on each, 40,000 files: ripgrep took 317 ms against the
  scanner's 2,713 on Linux, 1,545 against 3,066 on macOS and 2,645 against
  4,285 on Windows, 1.6 times as fast there and 1.5 with Defender on. What
  round 9 saw was the load. But `auto` chose the scanner for that tree on
  Windows, 500 files being under 512, and took 4,686 ms.
- **A word every file holds** leaves ripgrep nothing to leave out, and costs
  it little: over 1,000 files it took 0.72 of the scanner's time on Linux,
  1.35 on macOS and 1.07 on Windows, and less than the scanner's on all three
  over 10,000.

### Windows otherwise

The same multiples with Defender's real-time protection on, with the binary
`@vscode/ripgrep` carries started directly, and with both:

| files a target | Defender on: one search | 8 targets | 32 targets | started directly: one search | 8 targets | 32 targets | both: one search | 8 targets | 32 targets |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 5.28 | 2.79 | 2.78 | 2.87 | 1.24 | 1.17 | 2.27 | 1.12 | 1.21 |
| 128 | 2.78 | 1.58 | 1.56 | 1.54 | **0.78** | **0.69** | 1.26 | **0.82** | **0.71** |
| 192 | 1.88 | 1.11 | 1.13 | 1.04 | | | **0.91** | | |
| 256 | 1.55 | **0.89** | **0.90** | **0.85** | **0.46** | **0.42** | **0.72** | **0.46** | **0.47** |
| 384 | 1.06 | **0.66** | **0.68** | **0.59** | | | **0.52** | | |
| 512 | **0.82** | **0.55** | **0.57** | **0.49** | **0.32** | **0.36** | **0.45** | **0.34** | **0.34** |

Real-time protection slows both engines, the scanner by half again a file and
ripgrep by 10 ms a start, and leaves the crossover where it was. A ripgrep
started directly crosses at 192 files alone and under 128 beside others: what
the shim costs is most of what a small search costs.

### Bytes

Files ten times as long moved no crossover. At 400 lines a file, 12 KB, one
search crossed between 32 and 64 files on Linux, 128 and 256 on macOS and 256
and 512 on Windows, about where it did at 1.2 KB. What the scanner pays for
is opening a file; reading one costs it half a millisecond to a millisecond a
megabyte. Bytes alone decide only in megabytes. ripgrep's time as a multiple
of the scanner's again, for one search:

| files | size | Linux | macOS | Windows | Windows, Defender on |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 of 127 KB | 634 KB | 4.10 | 7.47 | 25.52 | 28.52 |
| 10 | 1.2 MB | 3.46 | 5.48 | 16.57 | 19.27 |
| 25 | 3.2 MB | 1.37 | 3.21 | 7.59 | 8.78 |
| 50 | 6.3 MB | **0.84** | 1.38 | 4.01 | 4.52 |
| 100 | 12.7 MB | **0.53** | **0.88** | 2.09 | 2.27 |
| 5 of 1.3 MB | 6.6 MB | 2.17 | 2.53 | 8.97 | 10.68 |
| 10 | 13.1 MB | 1.40 | 2.13 | 5.66 | 6.63 |
| 20 | 26.7 MB | **0.72** | 1.22 | 2.91 | 2.79 |
| 40 | 53.7 MB | **0.46** | **0.78** | 1.47 | 1.66 |

A run of eight targets of 127 KB files, in milliseconds, from the last run:

| files a target | size a target | Linux: scanner | ripgrep | macOS: scanner | ripgrep | Windows: scanner | ripgrep |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1.2 MB | **12** | 27 | **12** | 40 | **19** | 193 |
| 20 | 2.5 MB | **25** | 42 | **23** | 69 | **37** | 196 |
| 30 | 3.8 MB | 51 | **43** | **32** | 71 | **61** | 201 |
| 40 | 5.1 MB | 65 | **44** | 51 | **44** | **91** | 200 |
| 80 | 10.2 MB | 128 | **49** | 97 | **63** | **161** | 215 |

The byte budgets, 64 KB and 1 MB, are 2 KB a file. Source files are longer,
so for them it was the byte budget that decided, and it handed over searches
the scanner answered several times faster:

| | scanner | ripgrep | `auto` |
| --- | ---: | ---: | --- |
| Linux, 16 files of 12 KB | 1.4 ms | 4.0 ms | 4.7 ms, by ripgrep |
| macOS, 16 files of 12 KB | 2.4 ms | 16 ms | 17 ms, by ripgrep |
| Windows, 128 files of 12 KB | 18 ms | 63 ms | 69 ms, by ripgrep |
| Windows, 10 files of 127 KB | 3.1 ms | 56 ms | 58 ms, by ripgrep |
| Windows, one file of 1.3 MB | 3.4 ms | 58 ms | 59 ms, by ripgrep |

### The walk `auto` abandons

Under "Decision" the probe is "a rounding error against the search that
follows". It is not one on Windows. A target over the budget is walked until
the budget is passed, and then handed over: 513 files statted first. Over
eight targets of 1,024 files `auto` took 457 ms where ripgrep alone took
320 ms, 17 ms a target for the walk it threw away; over thirty-two, 16 ms a
target. On Linux the 33 files cost about a millisecond a target. So what the
scanner has to beat is not ripgrep but that walk and then ripgrep, and a
smaller budget on Windows is also a shorter walk to abandon.

### Decision

| | files, before | now | bytes, before | now |
| --- | ---: | ---: | ---: | ---: |
| Linux, and any platform not named | 32 | 32 | 64 KB | 2 MB |
| macOS | 32 | 64 | 64 KB | 4 MB |
| Windows | 512 | 256 | 1 MB | 8 MB |

- **A file budget is the largest size measured at which the scanner was at
  least as fast as what `auto` does otherwise - the abandoned walk, then
  ripgrep - in runs of eight and of thirty-two targets, every time it was
  measured.** A run of more than a handful of rules searches several targets,
  and what the budget gets wrong there it gets wrong once for each. Linux's
  budget was that already. macOS had Linux's, and starts a process three
  times as slowly. Windows had the crossover of one search.
- **A byte budget is under the largest size at which the scanner was ahead of
  that walk and ripgrep in a run of eight targets of 127 KB files**, in both
  of the last two runs: 2.5 MB a target on Linux, 5 MB on macOS, where the
  walk and ripgrep took 63 ms to the scanner's 51, and 10 MB on Windows. The
  search measured is a rare literal, which is what most rules are and the
  cheapest thing to scan for; nothing here measured a costlier pattern.
- **Windows is budgeted for a ripgrep behind a shim**, as Chocolatey installs
  one. One started directly would want about 150 files.
- **A platform nothing was measured on takes Linux's**, the smallest: a
  budget too small costs a process that was not needed, and no more.
- `--engine rg` and `--engine js`, the `engine` key of the configuration and
  `SPEC_GUARD_RG` are as they were, and the two engines are held to one answer
  by the same parity tests. The budget decides which engine answers, never
  what the answer is.

### Consequences

`auto` beside the two engines with these budgets, at each platform's budget and
at the two sizes measured above it, in milliseconds:

| files a target | | scanner | ripgrep | `auto` | by |
| --- | --- | ---: | ---: | ---: | --- |
| Linux, 32 | one search | **5.2** | 6.2 | 4.4 | scanner |
| Linux, 32 | 8 targets | 27 | **21** | 25 | scanner |
| Linux, 32 | 32 targets | **94** | 94 | 95 | scanner |
| Linux, 48 | one search | **6.1** | 6.5 | 8.4 | ripgrep |
| Linux, 48 | 8 targets | 37 | **22** | 29 | ripgrep |
| Linux, 48 | 32 targets | 136 | **97** | 124 | ripgrep |
| Linux, 64 | one search | 7.6 | **6.4** | 8.1 | ripgrep |
| Linux, 64 | 8 targets | 47 | **22** | 30 | ripgrep |
| Linux, 64 | 32 targets | 183 | **97** | 130 | ripgrep |
| macOS, 64 | one search | **7.7** | 19 | 8.5 | scanner |
| macOS, 64 | 8 targets | **23** | 53 | 31 | scanner |
| macOS, 64 | 32 targets | **94** | 114 | 112 | scanner |
| macOS, 96 | one search | **9.4** | 15 | 21 | ripgrep |
| macOS, 96 | 8 targets | **45** | 67 | 68 | ripgrep |
| macOS, 96 | 32 targets | 181 | **146** | 161 | ripgrep |
| macOS, 128 | one search | **13** | 17 | 21 | ripgrep |
| macOS, 128 | 8 targets | **43** | 48 | 54 | ripgrep |
| macOS, 128 | 32 targets | 306 | **143** | 195 | ripgrep |
| Windows, 256 | one search | **47** | 62 | 47 | scanner |
| Windows, 256 | 8 targets | 306 | **234** | 306 | scanner |
| Windows, 256 | 32 targets | 1,241 | **955** | 1,292 | scanner |
| Windows, 384 | one search | 70 | **65** | 85 | ripgrep |
| Windows, 384 | 8 targets | 464 | **260** | 352 | ripgrep |
| Windows, 384 | 32 targets | 1,842 | **1,065** | 1,373 | ripgrep |
| Windows, 512 | one search | 93 | **67** | 91 | ripgrep |
| Windows, 512 | 8 targets | 599 | **285** | 372 | ripgrep |
| Windows, 512 | 32 targets | 2,485 | **1,162** | 1,484 | ripgrep |

At a budget ripgrep's own figure can be under the scanner's, and `auto` still
does better to scan, since handing a target over costs the walk as well. On
Windows here the walk is 92 ms over eight targets and 308 over thirty-two,
which makes handing over 326 ms and 1,263 against the scanner's 306 and
1,241. With Defender's real-time protection on, on the one machine that ran
so, it is 386 ms against the scanner's 332 over eight targets of 256 files,
and at 384 files the scanner's 485 against 413.

What changed for a tree the old budgets got wrong, in milliseconds, each
row's three figures from one run, the old budgets' from the first two and the
new from the last:

| | before: scanner | ripgrep | `auto` | now: scanner | ripgrep | `auto` |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Windows, 80 targets of 500 files, 240 rules | 4,285 | 2,645 | 4,686, by the scanner | 6,118 | 2,923 | 3,755, by ripgrep |
| Windows, 32 targets of 512 files | 1,942 | 1,153 | 1,948, by the scanner | 2,485 | 1,162 | 1,484, by ripgrep |
| Windows, 128 files of 12 KB | 18 | 63 | 69, by ripgrep | 26 | 59 | 26, by the scanner |
| Windows, 10 files of 127 KB | 3.1 | 56 | 58, by ripgrep | 3.0 | 54 | 3.1, by the scanner |
| macOS, 64 files | 7.4 | 14 | 16, by ripgrep | 7.7 | 19 | 8.5, by the scanner |
| macOS, 8 targets of 64 files | 38 | 32 | 41, by ripgrep | 23 | 53 | 31, by the scanner |
| macOS, 16 files of 12 KB | 2.4 | 16 | 17, by ripgrep | 2.0 | 16 | 2.8, by the scanner |
| Linux, 16 files of 12 KB | 1.4 | 4.0 | 4.7, by ripgrep | 2.4 | 6.0 | 2.7, by the scanner |

What it still gets wrong, and by how much:

- **One search just past the budget.** A target between the budget and where
  one search crosses goes to ripgrep and would have been quicker scanned:
  8.4 ms against 6.1 at 48 files on Linux, 21 against 9.4 at 96 on macOS,
  85 against 70 at 384 on Windows, and 66 against 36 there on the faster
  machines of another run. It is lost once in a run, where a budget set for
  one search lost as much for every target of a run of several.
- **The walk it abandons.** Past the budget `auto` is ripgrep and the walk:
  352 ms against ripgrep's 260 over eight targets of 384 files on Windows,
  11 ms a target on those machines and 6 ms on faster ones, where the budget
  of 512 cost 17; 130 ms against 97 over thirty-two targets of 64 files on
  Linux, a millisecond a target. A probe that counted a directory's entries
  before it asked for their sizes would abandon sooner. It is not made here.
- **A ripgrep started directly on Windows.** Eight targets of 256 files took
  `auto` 302 ms with the scanner, and that ripgrep 116.
- **Long files, searched once.** Past the byte budget one search goes to
  ripgrep while the scanner is still ahead: 67 ms against 28 over 100 files
  of 127 KB on Windows, 19 against 9.0 over 50 on macOS, 7.3 against 5.6 over
  25 on Linux.
- **Machines differ by more than the budget's margin.** The scanner took
  0.09 ms a file on the Windows machines of one run and 0.16 on those of
  another, and several targets crossed at 400 files on the first and 300 on
  the second. At 256 the scanner was level with the walk and ripgrep on the
  slowest machines measured and a third faster on the rest.
- **A machine busy with other work was not measured, on purpose.** There a
  process costs more to start than a file does to read, and `--engine js`
  says so for a run.
- **The engine a report names** can be the other one than before for the same
  tree. Every count and finding is the same.

`tests/engine-contracts.test.ts` holds each platform's budget on every
platform the suite runs on, and `tests/adaptive-engine.test.ts` the choice at
both edges of the one in use: as many files as the budget scanned in process
and one more handed over, the same for bytes, and files of 12 KB that the old
byte budget handed over. The trees three test files use to reach ripgrep are
past every platform's budget by their number of files, from one helper.

Every table here is the output of `scripts/bench-engines.mjs`: the default
for one search, `--run 8x1,32x1` for runs of targets, `--lines 400` to
`--lines 40000` for longer files, `--common` for a word every file holds, and
`SPEC_GUARD_RG` for another ripgrep.
