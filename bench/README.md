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
```

The generator holds no PRNG, no UUID generation and no clock, so the second
command is the reproducibility check rather than a formality. If it prints a
diff, the vault and the committed numbers no longer describe the same thing.

## Running the eval

```
npm run eval:vault              # 30 cases, semantic tier live, needs Ollama
npm run eval:vault:strategies   # compares fusion policies against a tier oracle
```

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

## Quote denominators

At N=30 one case is worth 3.3 points of hit rate; at N=15 it is 6.7, and at N=12
it is 8.3. The 0.6.0 notes reported `87% -> 93%` on an N=15 set, which is
13/15 -> 14/15 — one case. The harness now prints the denominator beside every
percentage so that cannot be read as a trend.
