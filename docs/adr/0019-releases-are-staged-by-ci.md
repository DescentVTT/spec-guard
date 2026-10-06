# ADR-0019: A release is a tag on main, staged by CI and approved by a person

## Status

Accepted (2026-09-30).

## Context

spec-guard runs inside other repositories' pipelines and decides whether their
build fails. A bad version of it is installed once and then not looked at, which
is what makes it useful and what makes a bad release expensive.

Up to 0.11.0 a release was `npm publish` from a workstation: the registry got
whatever that machine had built, authorised by a credential in a keychain.
0.12.0 was the first version staged from a tag by `release.yml`, through npm's
trusted publishing, and every version since has gone out that way. The flow
around the workflow was never written down as a decision. The README's
Releasing section described the workflow, and said to run `npm version minor`
and push with `--follow-tags`, which does not make the commit every release
since 0.12.0 has had: `release: <x.y.z>`, carrying the changelog's heading and
the mutation sweep's figures with the version. The README also promised that
each release replays the mutation survivors its own code added, without saying
where in the flow that happens. An outside
review of 2026-09-29 found no release ADR here, where each sibling has one:
spec-brief's ADR-0010, spec-graph's ADR-0021 and spec-harness's ADR-0011.

This records the flow the releases since 0.12.0 have followed, so that it is
written where the other decisions are, and moves the contributor's steps from
the README, which the package ships, to `CONTRIBUTING.md`, which it does not.

## Decision

**A release is a `v*` tag on a commit of main, and CI stages it.** Nothing is
published from a workstation, and there is no npm token in the repository or in
its secrets. `prepublishOnly` refuses `npm publish` anywhere but GitHub Actions.

### What a release carries, and its version

Releases are batched: one per round of work, carrying everything the round
merged. The version is decided by spec-core's
[ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md):
a minor for anything that can turn a passing run red or change what a script
reads, a patch for what reports less, crashes, performance and documentation.

### Before the tag: main's full sweep

A pull request's mutation run is incremental, and a verdict built on a cache is
not the measurement ([ADR-0003](0003-mutation-testing.md)). So a release waits
for the full sweep that the last merge started on main, and compares its
survivors with the last release's, recorded in ADR-0003's newest release
section. Each new survivor is killed by a test, deleted with the code that
decides nothing, or shown equivalent - a comment beside the code says why, and
ADR-0003 records the evidence. A change to `src/` beyond such a comment is a
pull request of its own, and the release waits for the sweep after it.

This is where the promise the README makes is kept: every survivor a release
adds is replayed before it ships.

### The release commit

On main, one commit, `release: <x.y.z>`:

- the version in `package.json` and `package-lock.json`
  (`npm version <x.y.z> --no-git-tag-version`);
- `## Unreleased` in `CHANGELOG.md` renamed `## <x.y.z>`;
- the sweep's figures in the README's line under "spec-guard checks itself",
  and a section `### <x.y.z>: ...` in ADR-0003, above the last release's;
- any comment an equivalent survivor needs, and nothing else under `src/`.

Its message gives the sweep - the commit it measured, the score, the mutants
and the survivors - and what was done about each new survivor.

### The tag, and what CI does with it

An annotated tag, `v<x.y.z>`, on the release commit, pushed with it. A
`Release tags` ruleset lets only repository administrators create, move or
delete a `v*` tag, because pushing one is the release.

`.github/workflows/release.yml` runs two jobs:

1. **`verify`**, with read access alone: the tagged commit must be on main,
   and the tag, `package.json` and a `## <version>` heading in `CHANGELOG.md`
   must agree; then type checking, the build, the suite and this repository's
   own specs, since a tag push does not run CI; then `npm pack`, with the
   tarball's file list and SHA-256 in the log. `npm ci`, the postinstall that
   downloads a ripgrep binary and the suite run here, where there is no token
   to take.
2. **`publish`**, the one job with `id-token: write`, in the `npm` environment,
   which accepts deployments only from main and `v*` tags. It checks nothing
   out and installs no dependencies: it installs an npm new enough to stage
   (11.15 or later, inside 11.x) and runs `npm stage publish --provenance` on
   the tarball `verify` packed, so what reaches the registry is the artifact
   the tests ran against. npmjs.com accepts the job's OIDC token only for this
   repository, this workflow and this environment.

### A person publishes

A staged version is visible to maintainers and installable by nobody. The
maintainer reads it and approves it with a second factor - `npm stage list
@descent-vtt/spec-guard`, `npm stage view <id>`, `npm stage approve <id>` - or
discards it with `npm stage reject <id>`, after which the tag can be deleted
and remade. CI can build a release; it cannot decide to publish one.

Run by hand from main with `dry_run` on, the workflow verifies, packs and hands
the tarball to npm without spending a version number. It stops at the
registry's version check, since main's version is already published, and it
cannot try the OIDC exchange, which happens only on a publish that intends to
write.

*Amended 2026-10-01.* Every action in the release, in CI and in the mutation
sweep is pinned to a commit with its tag beside it, as in the siblings: a tag
can be moved and a commit cannot, and a moved `setup-node` tag would have run
in the job that holds the OIDC token. No checkout keeps its token in
`.git/config`, so `npm ci` and the suite in `verify` have none to read, and
`verify` restores no dependency cache, because other runs write it and the
tarball comes from the lockfile and the registry alone. `publish` installs npm
at an exact version, 11.20.0, the one every staged release so far has used,
rather than the newest 11.x: a range would bring a version published an hour
earlier into the one job that can stage, past the cooldown Dependabot holds
every other dependency to. Moving it is an edit made on purpose.

*Amended 2026-10-07.* `verify` checks that the tagged commit is on main, as
spec-brief's, spec-graph's and spec-harness's release workflows do: it checks
out all of history and stops, before `npm ci`, unless `origin/main` has the
commit. This record said the workflow left that to the `Release tags` ruleset
and to the release commit being made on main. The ruleset says who may push a
`v*` tag, not which commit it names, and the `npm` environment takes any
`v*` tag, so a tag on a commit of a branch nobody reviewed would have been
verified, packed and staged. A dry run from a branch makes the same check and
goes on, since it stages nothing; a check that cannot be made, for want of
history or of `origin/main`, stops a rehearsal as it stops a release.

## Consequences

- The README says what spec-guard does and ships in the package; how it is
  built, measured and released is in `CONTRIBUTING.md`, which links here.
- A release takes as long as main's full sweep, about twenty minutes in eight
  shards, plus whatever its new survivors need.
- Every version from 0.12.0 carries a provenance attestation naming the
  repository, the commit and the run that built it; the versions before it do
  not, and never will.
- `release.yml` makes no GitHub release, where spec-graph's makes one. Until
  2026-10-07 it did not check that the tagged commit is on main either.

## Alternatives considered

**`npm version` and `git push --follow-tags`**, as the README said. It makes
the version commit and the tag in one step, and leaves out the two things the
release commit is for: the sweep's figures and the survivors' replay. It also
names the commit after the version alone, where every release since 0.5.1 is a
commit named `release: <x.y.z>`.

**A required reviewer on the `npm` environment.** Staging already waits for
the maintainer's second factor, and the people who could review a deployment
are the people who can push a `v*` tag. A second gate held by the same person
adds a click, not a check.

**The mutation sweep as a job in `release.yml`.** It would sweep again a
commit whose source differs from the one main swept by comments at most, and
put about twenty minutes and eight runners between a tag and the registry, to
measure what the release commit already records.

**Publishing when a version bump merges to main.** It removes the tag, and with
it the moment somebody says that this commit is the release. The workflow's
checks, the ruleset and every release so far are keyed on the tag.
