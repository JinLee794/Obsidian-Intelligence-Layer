# Known issues

Pre-existing defects that are understood, reproduced, and deliberately **not** fixed in the
release they were found in. Each entry records the evidence and why the fix was deferred, so
the next person does not have to rediscover it.

---

## Ambiguous wikilink tie-break depends on change arrival order

**Status:** open · **Severity:** low · **Found:** v0.6.0 validation · **Predates:** `f1a6012`

Where several notes answer to the same name, *which one* an ambiguous wikilink resolves to can
differ between the incrementally maintained index and a from-scratch rebuild. Every link still
resolves, and always to a note that legitimately answers to the name — this is a
correctness-of-*choice* issue, not a stranded-link issue.

### Root cause

`titleIndex` maps `name -> claimant`, one entry per name, and the tie-break rule is effectively
**"last applied wins"**. A full build applies notes in disk traversal order; the incremental path
applies them in the order changes arrived. Those two orders drift, so the two indexes can
disagree about which duplicate holds the name.

### Evidence

Churn harness — 60 notes over a pool of 5 shared names, 60 rounds of delete /
retitle-onto-or-off-a-shared-name / body edit, applied through the watcher's real flush
sequence, compared against a full rebuild every round:

```
CHURN2 rounds=60 deletes=16 retitles=18 stranded=0 tiebreak=1761
```

`stranded=0` is the bug fixed in `f1a6012`; `tiebreak=1761` is this issue. Representative case:

```
TIEBREAK round=8 N1.md  incremental {"out":["N13.md","N56.md"]}
                        rebuild     {"out":["N13.md","N57.md"]}
```

`N56` and `N57` are titled identically.

### Attribution — it predates the stranded-link fix

The probe below uses a scenario with **no removal anywhere**, so it exercises only code paths
`f1a6012` does not touch: `B.md` titled `Shared`, then `A.md` retitled to `Shared`.

```
TIEBREAK_AB[pre-collision-fix]   atBuild=["B.md"] incremental=["A.md"] rebuild=["B.md"] match=false
TIEBREAK_AB[post-collision-fix]  atBuild=["B.md"] incremental=["A.md"] rebuild=["B.md"] match=false
```

Identical on both sides of the fix.

### Why it was deferred

The fix is a **semantics decision, not a patch**. To converge, the full build and the incremental
path must share a tie-break rule that does not depend on application order — "lowest path wins"
is the obvious candidate — which inverts today's "last wins" and would silently repoint existing
users' ambiguous links at a different note. That does not belong in a release whose purpose is
that its claims are true.

### Suggested resolution

Adopt an order-independent tie-break rule, apply it in both the full build and the incremental
path, and call the behaviour change out in release notes, since it can move existing ambiguous
links.

---

## A `v0.7.0-beta.1` tag is published for a version this project never released

**Status:** open · **Severity:** low, but needs one manual action · **Found:** v0.6.0 validation

The tag `v0.7.0-beta.1` is pushed to `origin`, at commit `48bda599`. That commit really does carry
`"version": "0.7.0-beta.1"` in `package.json`, so the tag is internally consistent — but the
version was later walked **backwards**:

```
0.5.5 -> 0.6.0 (5ca738f) -> 0.7.0-beta.1 (c43a800) -> 0.6.0 (c00b261)
```

Under semver, `0.6.0` sorts *older* than `0.7.0-beta.1`, so at first glance this release looks
like a downgrade from something already tagged.

### Why 0.6.0 is nevertheless the correct number

The prerelease was **never published**. Observed:

```
npm view @jinlee794/obsidian-intelligence-layer versions
  0.2.0 0.3.1 0.5.0 0.5.1 0.5.2 0.5.3 0.5.4 0.5.5
npm view @jinlee794/obsidian-intelligence-layer dist-tags
  { "latest": "0.5.5" }
```

The registry stops at `0.5.5`. The reason is visible in the workflow: `Publish` triggers only on
a push to `main`, and `48bda599` sits on the `feat/semantic-tier` branch, so publication never
fired. `gh run list` confirms it — every recorded run is a `Publish` run on `main`.

So **no installed consumer can be on `0.7.0-beta.1`**, and the next version after the published
`0.5.5` is `0.6.0`. Renumbering this release to `0.7.0` would inflate the version to accommodate
an artifact nobody received.

### Required manual action

Delete the stray tag, so the repository does not advertise a release that does not exist:

```
git push origin :refs/tags/v0.7.0-beta.1
git tag -d v0.7.0-beta.1
```

This was not done during the v0.6.0 work because the account doing it lacks push access to the
repository — both `git push` and issue creation return `403` under the enterprise policy in force.
Anyone with write access can complete it in one command.


---

## The ready marker reads as a completion marker

`[OIL] MCP server ready — indexing vault in background` is literally accurate: the server does
accept MCP requests at that point. But it reads as "startup finished", and **every index
diagnostic is emitted after it** — the four `_oil-graph.json` rejection paths, the build timing,
and the warm-start reconciliation lines all come from background indexing.

This is not theoretical. During v0.6.0 validation it produced **two separate false findings**,
both from stopping at the ready line and concluding the absent diagnostic did not exist:

- "a truncated `_oil-graph.json` is silently discarded" — it is logged, after the marker
- an earlier startup-ordering misreading with the same shape

It is the same defect class as the three fixed in this release (`tiers_used`, the hardcoded
semantic-disabled reason, `doctor` exiting 0 on an unconfirmable model): **the software says
something true that a reasonable reader takes to mean something false.**

The countermeasure belongs in the marker's wording, not in the log ordering — the ordering is
correct and is the whole point of the startup fix. Something like:

```
[OIL] MCP server ready — vault indexing has not started yet; diagnostics follow
```

Deliberately not changed in v0.6.0: it is a behaviour-adjacent wording change with no failing
test behind it, and this release is scoped to making its own claims true.

**Anyone reading OIL's stderr to determine what happened during startup must read past the ready
line.** Harnesses that stop at it, or that kill the process once it appears, will observe none of
the index diagnostics and may conclude they are absent.
