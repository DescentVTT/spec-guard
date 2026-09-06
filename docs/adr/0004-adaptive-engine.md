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
