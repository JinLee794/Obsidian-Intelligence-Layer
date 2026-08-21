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
