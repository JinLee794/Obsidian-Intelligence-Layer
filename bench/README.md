# Reproducing the ranking numbers

Every figure this project publishes about retrieval quality should be
re-derivable by someone who has only this repository. That was not true before:
the numbers in the 0.6.0 notes were measured on a 360-note private vault against
a 15-case golden set that is gitignored and has never existed here.

## What is committed

| Set                             | Vault                       | Cases | What it is for                                     |
| ------------------------------- | --------------------------- | ----: | -------------------------------------------------- |
| `datasets/fixture.golden.json`  | `fixtures/vault` (12 notes) |    12 | Fast retrieval gate. Saturated — see the caveat.     |
| `datasets/eval.golden.json`     | `fixtures/eval-vault` (54)  |    30 | Ranking gate. Can distinguish two ranking policies. |

Both run under `npm test` with the semantic tier off. Cases marked
`requiresSemantic` need Ollama and are measured by `eval-golden.mjs` instead.

**The 12-note set is saturated and cannot fail for a ranking regression.** The
harness returns the top 10 of 12 notes, so a relevant note is found almost
however the ranker orders it, and its hit rate is pinned at 100%. Measured
directly: rank-fusion damping `k=10` versus `k=60` moves 0 of 12 cases there.
That reads as "the constant does not matter" but actually means "this vault
cannot tell". The 54-note vault exists because of that.

## Regenerating the eval vault

```
npm run eval:vault:regen
git diff --exit-code bench/fixtures/eval-vault
git status --porcelain bench/fixtures/eval-vault    # must also print nothing
```

The generator holds no PRNG, no UUID generation and no clock, so the second
command is the reproducibility check rather than a formality. If it prints a
diff, the vault and the committed numbers no longer describe the same thing.

Run the third command too, and do not treat the second as sufficient on its
own. `git diff` normalises line endings before comparing, so on a checkout with
`core.autocrlf=true` it exits 0 while `git status` reports every fixture file as
modified — the generator writes LF, the checkout holds CRLF, and the check that
exists to catch drift is the one thing that cannot see it. This is not
hypothetical: it reported success against a 55-file dirty tree during this
release. `.gitattributes` now pins these fixtures to `text eol=lf`, which is
what makes the pair agree; the second command is sound only because of it.

## Running the eval

```
npm run eval:vault              # 30 cases, semantic tier live, needs Ollama
npm run eval:vault:strategies   # compares fusion policies against a tier oracle
```

Both refuse to print a number if the embedder failed while answering any case.

## Why the harness refuses instead of scoring

`embedQuery` catches a failed embedding call and returns nothing, so the search
cascade cannot tell "the semantic tier found nothing" from "the semantic tier
never ran". That is correct at runtime — an unreachable Ollama must not break a
user's search — but in an eval it silently converts an infrastructure failure
into a lower quality score.

This was not theoretical. Putting a proxy in front of Ollama that serves
`/api/tags` normally but returns HTTP 503 for embeddings made the pre-fix
harness print `hit rate 75%, MRR 0.688, recall 71%` and exit 0. No warning. That
MRR and hit rate pair matches a figure previously recorded as a quality
measurement.

The harness now counts the failures the tier swallows, per query, and refuses to
aggregate a run in which any case was answered by a degraded tier: it names the
affected cases and exits 2. The tier's status is not sufficient on its own,
because a per-call failure leaves the overall status at `ready`.

Reproduce the setup-time half of the refusal without a proxy:

```
OIL_SEMANTIC_TIMEOUT_MS=1 npm run eval:vault   # exits 2, scores nothing
```

That one trips the up-front check, because a timeout that short also fails the
health probe. The per-case half needs a fault that lets `/api/tags` succeed and
fails only embeddings, which is what the proxy above was for: measured warm,
`/api/tags` answers in 3-12 ms and `/api/embed` in 27-47 ms, so no timeout value
separates them.

## Comparing strategies is what degradation destroys

`ranking-strategies.mjs` is more fragile than the absolute metric, not less. With
the semantic arm empty every fusion variant reads the same two lists and scores
identically, so the table still sorts and still reads like a verdict.

Measured through the same 503 proxy: all 14 index batches succeeded, the tier
reported `ready`, then all 30 query embeddings failed, and the pre-fix harness
printed a full table and exited 0. In it `rrf equal`, `rrf coverage` and both
score blends all scored **0.879 MRR**, where a healthy run separates them across
**0.850-0.931**. `semantic only` printed 0%.

The apparent margin is inflated, not shrunk. Healthy, fusion leads `semantic
only` by 0.228 MRR; degraded, it leads by 0.879 — the comparator collapses to
zero while fusion keeps its lexical tiers. Any published "fusion beats a single
tier by N" measured on a harness without this gate should be treated as
unconfirmed in magnitude *and* in ordering between fusion variants.

## Quote denominators
At N=30 one case is worth 3.3 points of hit rate; at N=15 it is 6.7, and at N=12
it is 8.3. The 0.6.0 notes reported `87% -> 93%` on an N=15 set, which is
13/15 -> 14/15 — one case. The harness now prints the denominator beside every
percentage so that cannot be read as a trend.
