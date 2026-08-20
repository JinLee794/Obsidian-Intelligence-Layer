# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **A burst of file changes no longer costs O(vault) per file.** Two separate
  amplifiers compounded here. The watcher gave every changed path its own
  debounce timer, so a sync landing, a `git pull`, or a bulk rename produced one
  independent re-index and one search-index invalidation *per file* rather than
  one per burst. And each of those re-indexes cleared and rebuilt every backlink
  in the vault — measured at 85% of the cost of an edit on a 6,000-note vault.
  Changes are now collected into a single window (still 300ms, but shared across
  paths, and capped at 2s so a continuous stream cannot defer indexing
  indefinitely) and applied as one batch. Within that batch, an ordinary body
  edit only re-resolves the edited notes' own links; the whole-vault pass is
  reserved for changes that alter what a wikilink can resolve to — a renamed
  title, a note appearing, a note deleted. Measured cost of a 200-note burst:
  **2,278ms → 133ms on a 6,000-note vault**, and **427ms → 97ms on a 379-note
  one**. Burst cost is now roughly independent of vault size rather than
  proportional to it.
- **A link whose target arrived later never resolved.** Re-resolution read from
  each note's already-resolved links, which by then held paths with anything
  unresolvable silently dropped — so the raw name was gone and no later pass
  could recover it. Creating `[[Later]]` before `Later.md` existed left a link
  that stayed broken for the life of the index, and the running index diverged
  permanently from what a rebuild produced. Resolution now reads the raw link
  names, which were being retained for persistence all along, making it
  idempotent.
- **A repeat connect no longer re-reads the whole vault.** The persisted index
  was working — the cold *build* ran once — but everything behind it repeated on
  every session, and could repeat forever. Three compounding causes:
  - `buildIncremental` stat'd every note one at a time, and chokidar's own
    recursive scan ran concurrently with it, so each connect traversed the vault
    twice at once. Stats are now issued with bounded parallelism (measured 8x
    faster locally, and far more on latency-bound synced or network storage) and
    the two walks are serialised — revalidation first, then the watcher.
  - **Indexing was never persisted unless it finished before the client
    disconnected.** `shutdown()` closed the watcher and the server but never
    saved. A session that ended mid-rebuild discarded the work and the next one
    started over, so any vault slow enough that re-indexing outlasts a session
    *never converged*. The index now tracks whether it is dirty and persists
    during the rebuild — every 500 notes, and at least every two seconds.
  - A mass mtime change — sync, restore, `git pull`, switching machines —
    invalidates every entry at once. That is now a one-time cost that persists,
    rather than a cost repaid on every connect.
- **The server now notices, and survives, the end of a session.** A stdio client
  does not ask the server to stop, it kills it: the MCP SDK's client sends
  `SIGTERM` then `SIGKILL` two seconds later, and on Windows the first is a
  `TerminateProcess` that runs no handler. `StdioServerTransport` subscribes
  only to stdin's `data` and `error`, so its `onclose` never fires for a
  disconnect either. The upshot was a server that hung on stdin EOF until the
  client escalated to `SIGKILL`, holding a watcher over the whole vault the
  entire time — observed leaking across sessions. stdin's hangup is now watched
  directly, so a graceful disconnect is both noticed and terminal, and the flush
  on the way out actually runs. Durability does not depend on it: checkpointing
  is the guarantee, because no shutdown path can be relied on.
- **Revalidation no longer waits for the file watcher.** Serialising the two
  vault walks was right; the order was not. Revalidation is what lets a stale
  index converge, and gating it behind the watcher's recursive scan meant any
  session shorter than that scan did no index work whatsoever — such a client
  never converged, however often it reconnected. Measured on a 6,000-note vault
  after a mass invalidation: outstanding work now falls monotonically to zero
  across short sessions (4592 → 4080 → 3056 → 2032 → 1008 → 0) where before it
  did not move at all.
- **Cold builds read notes in parallel.** `build()` awaited each note in turn,
  and `indexNote` did its `readFile` and `stat` sequentially. Time to a
  hydrated 2,000-note index dropped from **4,989ms to 1,004ms**.

- **The server no longer fails to start on a cold or slow vault.** The stdio
  transport was connected *last*, after the graph build, semantic load, watcher
  and tool registration had all completed. A client's `initialize` therefore sat
  behind a full vault index — measured at 6,441ms cold for 2,000 notes on a
  local SSD, and unbounded on a synced or network vault. Past the SDK's 60s
  request timeout, the client gives up and the server appears dead. That is the
  mechanism behind "OIL just fails sometimes": warm sessions were fine, cold
  ones (index deleted or corrupt, config change, post-sync, several sessions
  starting at once) were a race against the clock. The transport now connects
  first and vault work runs behind a hydration gate: cold handshake is **695ms**
  and no longer scales with vault size.
- **A file-watcher error no longer kills the process.** `VaultWatcher` attached
  `add`/`change`/`unlink` handlers but no `error` handler, and a chokidar
  instance with zero `error` listeners *throws* on `emit("error")`. EMFILE,
  ENOSPC and EPERM are routine on Windows with OneDrive or antivirus in the
  path. The watcher now records the error in `get_health.watcher.last_error`
  and keeps serving.
- **A missing or unreachable vault is diagnosed, not fatal.** A nonexistent
  vault path exited 1 with a raw `ENOENT ... scandir` stack. Startup now
  preflights the vault, completes the handshake regardless, and retries with
  backoff — so a vault on a drive that mounts late heals itself instead of
  requiring a restart.
- **Unhandled rejections and uncaught exceptions no longer end the session.**
  There were no process-level guards anywhere, and a background
  `void semantic.refresh(graph)` rejection terminates the process on Node 20+.
  A degraded server that reports its own state beats a dead one.

### Changed

- `GraphIndex` exposes `dirty` and `flush()`, and reads are split into a
  parallel `readNote` and a synchronous `applyNote` applied in vault order, so
  concurrency cannot make an ambiguous wikilink resolve differently run to run.

### Added

- **`src/__tests__/warm-start.test.ts`** — asserts the complementary half of the
  startup contract: that the work behind the handshake happens once. Covers
  re-reading nothing on an unchanged second connect, converging in one pass
  after a mass mtime change, persisting mid-rebuild so an abandoned session
  still leaves progress, convergence across repeated rebuilds, and deterministic
  output under parallel reads.
- **`scripts/verify-observed.mjs`** — an end-to-end diagnostic that checks these
  claims against the built artifact over real stdio, rather than in-process:
  how a session actually ends, whether checkpoints actually fire, whether the
  walks are ordered as intended, and whether repeated short sessions actually
  converge. It exists because the shutdown claim above was written from the code
  and turned out to be false in the runtime a client drives.
- **`get_health` reports a `startup` block** — `phase` (`warming` / `ready` /
  `failed`), `attempts`, `duration_ms`, and a `reason` when it isn't ready.
  `get_health` is deliberately ungated, so it is how a caller learns *why* other
  tools are waiting rather than guessing at a hang.
- **Startup-contract regression coverage.** `src/__tests__/startup-contract.test.ts`
  asserts the ordering contract over an in-memory transport;
  `scripts/startup-contract.mjs` (`npm run test:startup:e2e`) spawns the built
  artifact over real stdio and fails the handshake budget, run from a working
  directory outside the repo to prove cwd-independence. Both are wired into
  `check:release`.
- **CI on pull requests** (`.github/workflows/ci.yml`) — lint, tests, startup
  contract and package smoke on Linux and Windows. Previously nothing ran until
  a push to `main`.

## [0.7.0-beta.1] - 2026-08-19

Pre-release for cross-machine testing. Tool-surface audit: responses got 31%
cheaper, and partial note edits became possible for the first time.

### Changed

- **Responses are compact JSON.** `jsonResponse` no longer pretty-prints. Measured
  across ten representative calls, indentation was 25% of every payload
  (17,377 → 13,055 chars) and nothing on the receiving end renders it.
- **`path` is the reference; `ref` only appears when it adds information.**
  `noteRef(path)` returned `path` unchanged, so every list item and envelope
  carried the same string twice — about a third of a `get_related_entities`
  payload. `ref` is now emitted only for section-scoped results, as
  `path#heading`, alongside `heading`. Removed `customer_ref` (duplicated
  `customer_path`), `orphaned_meeting_refs` (duplicated
  `report.orphanedMeetings`), and the `matches` array from `query_frontmatter`
  match mode (duplicated `paths`).
- **`semantic_search` description tightened.** Trimmed from 396 to 322 chars — it
  spent most of its budget arguing against its own use. It remains a distinct
  tool: `search_vault` fuses the semantic tier with the keyword tiers, which is
  a different operation from querying that tier alone.
- **`get_related_entities` reports `hops` and `via` per entry, nearest first.**
  The traversal collapsed every hop into one flat set, so a caller had no way to
  rank or safely truncate the result.
- **`get_health` no longer reports `tool_surface`.** It was a hand-maintained
  literal restating a tool list the client already holds from `tools/list`.

### Added

- **`atomic_replace_section`** — overwrite one heading's body under the same
  `expected_mtime` check. Editing part of a note previously required
  `atomic_replace` with the full file, which no read tool could produce: nothing
  in the surface returns whole-note content. A missing heading is a `NOT_FOUND`
  listing `available_headings`, never a silently created section.

### Fixed

- **The idle-schema guard measured the wrong string.** `totalSchemaChars()`
  stringified raw zod internals and silently dropped every `.describe()`, so it
  could not catch description bloat. It now sizes the JSON Schema the client
  actually receives. Real measured surface: 15 tools, 9,708 chars
  (`node bench/tool-surface-cost.mjs`).

### Known limitations

Carried into 0.7.0-beta.1 deliberately, with the evidence that justified each call.

- **The semantic relevance floor is corpus- and model-specific.** The 0.5 default
  was measured against `nomic-embed-text` on a 360-note vault. On the 12-note
  fixture it costs one rank position on a typo query, and on a very different
  corpus it may sit in the wrong place entirely. `bench/floor-analysis.mjs`
  measures the real-versus-noise separation for a given vault; `OIL_SEMANTIC_MIN_SCORE`
  applies the answer.
- **The floor governs embeddings, not BM25.** A query that is off-topic but
  real English can still match the lexical tier on a stray word, so "no match"
  is reachable for gibberish but not guaranteed for everything irrelevant.
- **Semantic hits can still rank mid-page on some queries.** Coverage weighting
  and the smaller `k` between them moved the worst cases up sharply — the worst
  observed first-relevant rank fell from 9 to 7 — but a correct answer can still
  land around rank 6-7 when many notes share query vocabulary. The remaining
  lever is the coverage floor, which the golden set can score.
- **A second "identity" vector per note does not help.** Tested on a 360-note
  vault: embedding title, tags and headings separately and scoring
  `max(full, identity)` left targets reachable in the top ten at 6 of 8, exactly
  matching the single full-text vector, while regressing two cases. It is cheap
  (41s versus ~6 minutes for a full pass), so it is worth retrying if the
  embedding recipe changes — but on current evidence it buys nothing.
- **Some notes are genuinely not retrievable by meaning.** One golden case
  (`disaster recovery`) is absent from the semantic tier's results under every
  representation tried, because its body is CRM metadata and its concept appears
  only as an abbreviation in the title. Expanding known abbreviations before
  embedding is the untested idea.
- **The tier recovers from an Ollama outage on the next vault change, not
  immediately.** A failed call marks it unavailable and forces re-verification,
  but nothing re-probes on a fixed interval, so a restarted Ollama with an
  otherwise idle vault stays unused until something is edited or the server
  restarts.
- **Shutdown does not drain an in-flight refresh.** A background embed can
  complete after the server stops accepting requests. The sidecar write is
  replace-by-rename, so the risk is a wasted write rather than a corrupt file.
- **`_oil-vectors.json` lives in the vault** and grows with it — roughly 4 MB per
  1,000 notes. Vaults under git or Obsidian Sync should ignore it; it is a cache
  and is rebuilt from the notes.
- **fuse.js is the most expensive component on every axis** — query cost, build
  cost and update cost — for the narrow job of catching a misspelled name.
  Measured at 5,000 notes it costs 360x BM25 for one word and 3,000x for four.
  The query-shape gate bounds the damage; replacing it with an in-tree bounded
  edit-distance match over the title vocabulary would be faster and one
  dependency lighter.
- **`graph.updateNote` still re-resolves every backlink** on a single edit,
  which is now the largest per-edit cost. Fixing it needs a reverse target-to-
  source map, and interacts with known `titleIndex` and `aliases` defects that
  should be corrected first.

## [0.6.0] - 2026-08-16

Semantic search, incremental indexing, and a measurable definition of "good
results". The tool surface is 14 tools; an existing install that
never touches Ollama behaves as it did before.

### Features

- **Weight rank fusion by how much of the query each tier understood.** Equal weights let a tier that matched one word of a seven-word question outvote one that matched its meaning — two tiers agreeing at rank 0 sum to ~0.033 and beat a single confident hit at ~0.016. Measured on a 360-note vault, a note the semantic tier ranked *first* fell out of the top ten entirely because a dozen notes merely mentioned a query word. The lexical tier's vote is now scaled by its term coverage, floored so a partial match still counts. Real-vault golden set: hit rate 87% → 93%, recall 72% → 78%; fixture MRR 0.875 → 0.917, with lexical-only scores, primary accuracy and tier routing unchanged
- **Lower the rank-fusion damping constant from 60 to 10.** The classic value assumes many systems of similar quality, where flattening each one's ordering stops any single system from dominating. These tiers differ in quality by design and are now weighted by evidence, so damping their internal ordering as well discards signal twice. Real-vault golden set MRR 0.664 → 0.707 with hit rate, recall, primary accuracy and tier routing unchanged; four of fifteen cases improved and none regressed, the clearest being a note the semantic tier ranked first that moved from rank 9 to rank 1. Fixture scores are identical in both modes
- **Add `bench/ranking-strategies.mjs`.** The golden set scores the shipped configuration but cannot compare alternatives, because swapping the combining rule mixes ranking changes with retrieval changes. This harness runs each tier once per query and then scores nine combining rules over that fixed candidate set, isolating ranking policy. It is what established that fusing beats standardising on any single tier — 93% hit rate versus 60% for the best tier alone — and that normalising scores onto a common scale performs identically to fusing ranks, so the weighting was doing the work rather than the fusion mechanism. `--detail` prints per-case ranks, so a small headline gap can be attributed before a constant is tuned on it
- **Tell the caller when meaning-based search would have helped but could not.** The semantic tier fails quietly by design, which is right for reliability and wrong for discovery: a user inside an MCP client cannot see stderr, so they never learned the capability existed or why it was off. `search_vault` now returns a `semantic_status` line — but only on a query the lexical tiers could not cover, and never when the tier is deliberately disabled, so a working search stays silent
- **Configure OIL from the MCP client.** An MCP client wires up a server through `command`, `args` and `env` — never through files inside the user's vault — so every semantic setting is now reachable from CLI flags (`--no-semantic`, `--semantic-model`, `--semantic-endpoint`, `--semantic-min-score`, `--vault`) and environment variables (`OIL_SEMANTIC`, `OIL_SEMANTIC_MODEL`, `OIL_SEMANTIC_ENDPOINT`, `OIL_SEMANTIC_MIN_SCORE`). Resolution order is flags → environment → `oil.config.yaml` → defaults. Turning the tier off is now one line in a client config rather than an edit to the vault
- **Add `obsidian-intelligence-layer doctor`.** Reports whether the vault resolves, whether Ollama is reachable, whether the model is present, and the *effective* settings after all three configuration layers are merged — so "why is the semantic tier off?" is answerable without reading server logs through an MCP client. Exits non-zero when something needs attention
- **Verify the optional tier against the packed artifact.** `npm run test:package` now packs, installs into a scratch consumer project, and connects a real MCP client twice: once with `OIL_SEMANTIC=off`, and once with the tier enabled but Ollama unreachable. Both must initialize and answer a `search_vault` call, which pins the backwards-compatibility guarantee that an absent Ollama can never break an existing install
- **Incremental index maintenance.** `GraphIndex` now keeps a bounded log of which notes changed, and derived indexes patch just those instead of discarding everything on any edit. Previously a one-character change to one note threw away every BM25 posting list and the whole fuzzy index: measured on a 10,000-note vault, the first query after a single edit stalled for ~1.05 s (BM25) plus ~0.2 s (fuzzy). BM25's update overhead is now flat at ~0-5 ms regardless of vault size. Callers whose delta has rolled out of the log, or who predate a wholesale rebuild, still fall back to a full build
- The fuzzy index patches in one pass and rebuilds outright once a delta exceeds 5% of the vault, because fuse.js splices and renumbers its entire record array per removed document
- **Add a semantic tier to `search_vault`, backed by local Ollama embeddings.** It runs last in the cascade, only when the lexical tiers fail to cover the query, so entity-name lookups keep their millisecond path and an embedding round trip is only paid when matching words already failed. Requires nothing but Ollama: zero new npm dependencies, no native module, no build step, and no vector database — vectors are normalised `Float32Array`s ranked by brute-force cosine, which stays well ahead of ANN territory below ~100k notes
- Self-contained by design: the embedding model is pulled automatically on first run, vectors are embedded in the background so startup never blocks, only notes whose text changed are re-embedded, and the index persists to `_oil-vectors.json`. If Ollama is not running the tier reports itself unavailable and search continues on the lexical tiers
- Report semantic tier state (`status`, `model`, `note_count`, `dimensions`, `reason`) in `get_health`
- Add a `semantic` config block (`enabled`, `endpoint`, `model`, `index_file`, `min_score`, `batch_size`, `timeout_ms`), all optional
- Rank lexical search with an in-tree Okapi BM25 implementation — IDF, term-frequency saturation, document-length normalisation, and field boosts replace hand-tuned score constants
- **Index frontmatter.** Frontmatter is stripped out of the body snippet, so every TPID, account id, status, date, and custom field was previously invisible to `search_vault`. Values are now flattened into dotted key paths (`opportunities.guid`) and indexed as their own weighted field, making nested and custom structures searchable
- Add an exact frontmatter tier ahead of BM25: an identifier query is resolved by whole-value equality, and results report which field matched (`matched_by: ["frontmatter:tpid"]`). The tier is skipped when the query names a note, so `Contoso` still resolves to the note titled Contoso rather than to meetings that reference it
- Cascade `search_vault` through BM25 then fuzzy matching, escalating on query-term coverage rather than result count, and fuse the tiers with reciprocal rank fusion
- Report `tiers_used`, `escalated`, and per-result `matched_by` so callers can see which tier answered
- Expand `query_frontmatter` into a four-mode structured query: call it with no arguments to discover every frontmatter key, with `key` to list that key's distinct values and counts, with `key`+`value_fragment` to match a substring, or with `where` to filter on several fields at once. Adds `folder`, `order_by`, and `limit`
- Accept dotted paths in `where` predicates, so nested custom fields are filterable
- Expose the previously unreachable frontmatter predicate engine (multi-field matching, all-of tag matching, folder scoping, ordering) through `query_frontmatter`'s `where` argument

### Changes

- **Reinstated `semantic_search` as a real tool.** The old tool of that name was removed earlier in this release because it was a misnomer — it ran fuzzy title matching and a substring scan, not meaning-based retrieval. Now that the capability genuinely exists, it gets its own entry point for the queries that need it deliberately: conceptual questions, and "what have we discussed like this". `search_vault` remains the default and still consults the tier itself. Measured on a 360-note vault, splitting the tiers cannot find *more* notes — an oracle allowed to pick the best tier per query scores the same 93% hit rate and 78% recall as fusing them, differing only in ordering — so the fused path stays primary and the specialist is for when the caller knows what it wants. Unlike `search_vault`, it reports why a result set is empty, since it has no second tier to fall back on
- **Removed `searchVault()`**, a second cascade implementation that duplicated `cascadeSearch()` but was unreachable from the tool layer. It survived only in tests and benchmarks, which now exercise the production path
- **The fuzzy tier no longer indexes note bodies.** BM25 already indexes them with term statistics and prefix expansion, so fuse.js was making a slower second pass over the same text — and it was the dominant cost of the tier. The three tiers now have disjoint jobs: BM25 owns exact terms and identifiers, fuzzy owns misspelled names, semantic owns meaning
- Give fuzzy and semantic hits a leading excerpt from the note body instead of a bare tag list, so a result explains why it was returned
- Type-check `bench/`, `scripts/`, and `src/__tests__/` in `npm run lint` via `tsconfig.check.json`. They were excluded, which is how a benchmark kept calling a deleted API unnoticed
- **Add a golden-set evaluation harness.** `bench/eval-golden.mjs` scores `search_vault` against a static set of scenarios with known answers — identifier lookup, exact entity, typo, paraphrase, attribute — reporting hit rate, MRR, recall, primary accuracy and tier routing, grouped by scenario so a change that helps one kind of query while breaking another is visible instead of averaged away. Cases can also assert which tiers may *not* run, so a cheap lookup that starts paying for an embedding round trip counts as a regression. Baselines are recorded to disk and `--compare` exits non-zero on a drop
- Ship `bench/datasets/fixture.golden.json` against the committed fixture vault; golden sets built from private vaults live in `*.local.json` and are gitignored
- Add `bench/semantic-probe.mjs`, which evaluates the semantic tier against a real vault without labelled ground truth: link agreement against a random baseline, query-to-note score distribution for tuning `minScore`, nearest neighbours for eyeballing, and a lexical-versus-semantic ablation
- Add `bench/semantic-live-check.mjs`, which validates the semantic tier through the real stdio MCP server against a live Ollama: it waits for the background embed, then asks `search_vault` questions phrased to share no vocabulary with the notes that answer them, asserting each hit is credited to the semantic tier — and that an exact entity query is still answered without it
- Add `bench/index-liveness.mjs`, an end-to-end validation harness that drives the real MCP tool layer and file watcher: it edits, creates and deletes notes on disk, writes through `create_note`/`atomic_append`, and asserts every derived index reflects the change and retains no stale trace — including a full-rebuild equivalence check at scale
- Add `bench/rebuild-cost.mjs`, which separates BM25 and fuzzy index update overhead from query cost
- Add `bench/semantic-eval.mjs`, a scale harness for the semantic tier. It runs against a real Ollama when one is reachable and a deterministic 768-dimension stub otherwise, measuring embed throughput, restart cost, incremental re-embedding, query latency, and the escalation gate. Verified linear scaling to 10,000 notes
- Add `bench/tier-breakdown.mjs`, which measures per-tier query cost by query length — the evidence behind the fuzzy tier's query-shape gate
- Remove the unregistered `orient` and `composite` tool modules and the superseded write-approval gate

### Migration

Nothing is required. The tool surface is unchanged, and a vault with no Ollama
running behaves exactly as it did in 0.5.5. Worth knowing:

- Callers of `semantic_search(query, limit)` should call `search_vault(query, limit)`. Ranking improves, and the response adds `tiers_used`, `escalated`, and per-result `matched_by`
- **`score` is now comparable across code paths.** It was already a relative ranking signal, but escalated queries previously returned raw reciprocal-rank sums (~0.016–0.033) while direct answers returned a 0–1 value. Both are now normalised to the top hit. Rank order is unaffected; anything thresholding on the raw number should switch to rank or `matched_by`
- **The semantic tier is on by default**, and will pull `nomic-embed-text` (~274 MB) the first time it runs if Ollama is reachable. Set `OIL_SEMANTIC=off` to opt out entirely
- **Search can now legitimately return zero results.** The relevance floor previously admitted everything, so a nonsense query still produced hits
- Vaults that keep tooling or archives alongside notes can set `search.exclude_folders` / `OIL_EXCLUDE_FOLDERS` to keep them out of rankings
- `npm test` no longer runs the wall-clock performance ceilings; use `npm run test:perf` on an idle machine

### Fixes

- **The vector index only refreshed on queries that reached the semantic tier.** `ensureFresh` hung off the semantic tier itself, which the cascade only runs when the lexical tiers fail to cover a query — rare in an entity-keyed vault. A vault could be edited all day and stay stale until some query happened to need meaning, and that query then ranked against stale vectors. Reconciliation now happens on every search, at the cost of a version comparison when nothing changed
- **A once-reachable Ollama was trusted forever.** The reachability check short-circuited after any success, so if Ollama stopped later and the index needed no new embeddings, `get_health` kept reporting `ready`. A failed call now clears the verification, so the next refresh re-probes
- **Report the underlying cause of a failed Ollama call.** Node's fetch describes every transport failure as a bare "fetch failed" and puts the useful part on `cause`; that string now reaches users through `get_health`, `doctor` and search responses, so `ECONNREFUSED` is worth keeping
- **The semantic tier reported `ready` from a cached index without ever reaching Ollama.** A complete vector sidecar lets the tier rank notes, but every *query* still has to be embedded — so `get_health` claimed health while searches silently returned nothing. Readiness now requires the endpoint to answer at least once. Caught by the packaged smoke test, which starts the server with the tier enabled and the endpoint unreachable
- **`score` meant different things on different code paths.** A query answered by the lexical tier returned a BM25 score normalised to 1.0, while an escalated query returned a raw reciprocal-rank-fusion sum — which is always about 0.016 for a single-tier top hit and 0.033 when two tiers agree. Reported from real use as "scores cluster in 0.016-0.033 with no meaningful spread". Fused scores are now normalised to the top hit, so the field is comparable within a result set on either path. It remains a relative ranking signal, not an absolute confidence
- **The semantic relevance floor never rejected anything.** Measured against `nomic-embed-text` on a 360-note vault, real queries score 0.554-0.749 against their best note, gibberish tops out at 0.531 and off-topic English at 0.454 — so the 0.45 default sat below every noise score and "no match" was unreachable. The default is now 0.5. Verified on the same vault: `zzxqq wibblewobble` returns nothing where it previously returned five results. The trade is one rank position on a typo query in the small fixture vault, with hit rate and recall unchanged
- **Add `search.exclude_folders` / `OIL_EXCLUDE_FOLDERS`.** Vaults that keep tooling, templates or agent logs alongside knowledge had them competing for rank: on one vault, 4 of 10 results for a customer question were skill and prompt documents. Excluded folders are filtered out of every tier, while graph traversal, frontmatter queries and the audit log still see them — the goal is to stop them competing, not to hide them. An explicit `filter_folder` overrides the exclusion, since naming a folder is a deliberate request for it
- **`npm run test:package` could not run under pnpm or on modern Node for Windows.** It drove the package manager named by `npm_execpath` — which is pnpm when a developer uses pnpm, and pnpm does not implement `pack --pack-destination` — and a `npm.cmd` fallback fails with `EINVAL` on current Node. It now resolves npm's own `npm-cli.js` and runs it under the active Node. The release gate was silently unrunnable for pnpm users
- **Include Ollama's error body in the failure reason.** A bare `HTTP 400` is undiagnosable; the tier now reports what Ollama actually said, in `get_health` and in the startup log
- **Report file-watcher readiness.** chokidar observes nothing until its initial scan completes — seconds on a large vault — and edits made in that window were silently lost with no way to tell. `VaultWatcher` now exposes `whenReady()` and reports `ready` in `get_health`, and startup logs a line when the vault is genuinely being watched. Found by an end-to-end liveness harness on a 2,000-note vault, where an edit made just after startup never reached the index
- **Retry the vector sidecar rename once on Windows.** A scanner or search indexer can hold the destination open briefly after it is written, surfacing as `EPERM`/`EBUSY` and losing the save
- **The semantic tier fired on almost every query.** Escalation required *both* full term coverage and a full page of results, but a specific query rarely returns ten notes — so a query BM25 had completely understood still escalated and paid for an embedding round trip. The semantic tier is now gated on term coverage alone: if every query term matched, there simply are not more notes about it and an embedding cannot conjure any. Measured on a 5,000-note vault, an exact-title query went from 2 embedding calls to 0
- **Restrict the fuzzy tier to name-shaped queries (≤ 3 terms).** Measured at 5,000 notes, fuse.js costs 360x BM25 for a one-word query and 3,000x for four words — roughly a second for a seven-word question — because bitap runs per token per document. A natural-language question is never a misspelled note title, so it was paying the most for the tier least able to answer it. End-to-end cascade latency on a 5,000-note vault dropped from 438 ms to 10 ms (p50)
- **Break BM25 score ties by path.** Ranking previously fell out of posting-list insertion order, so two equal-scoring notes could be ordered differently by an incrementally updated index than by a freshly built one — and differently again after an unrelated edit
- **Fix a vector sidecar write collision.** The temp file was named after the process id, so two indexes over one vault in the same process raced for the same path and the loser's rename failed with `ENOENT`. The suffix is now random per save
- **Move the wall-clock performance ceilings behind `OIL_PERF=1`** (`npm run test:perf`). They assert absolute latency, which is only meaningful on an idle machine — under load they failed on unmodified `main` too, and a gate that cries wolf is one people learn to ignore. `check:release` is now deterministic
- **Assert the server version matches `package.json`.** It was duplicated in `src/version.ts` with only a comment asking people to keep them in sync, so a published server could report the wrong version through `get_health`
- Fix two latent type errors surfaced by the widened lint scope: a `ParsedNote` test fixture missing `title`, `wikilinks`, and `tags`, and a benchmark calling a `graph.getAllNodes()` method that does not exist
- Return exact frontmatter matches in a deterministic order. They were returned in index insertion order, which shifts whenever a note is re-indexed after an edit, so a category query like `at-risk` silently returned a different window of results after unrelated writes. `search_vault` now also reports `total_matched` and a `truncated` flag for that tier
- Append to the section `read_note_section` actually reports. `appendToSection` ended a section at the next same-or-higher heading while `parseSections` ended it at the next heading of any level, so a write to a heading that has sub-headings landed outside that section — and a write to a note's H1 title, whose siblings are all deeper, went to end-of-file. The write reported `executed` either way, so an agent verifying its own write could not find it
- Stop reporting a name-fragment match as an identifier match. `ACC-NORTHWIND-001` previously ranked a note because the token `northwind` appeared in its title, returning the same results as the meaningless `NORTHWIND-001` with no way to tell them apart
- Report `total_matched` from `query_frontmatter` before truncation. It previously returned the post-truncation length as `count`, so a capped result was indistinguishable from a complete one
- Drop a `tier` field that `logWrite` no longer accepts, which broke `tsc --noEmit`

### Tests

- Add a multi-turn consistency suite over a generated 1,500-note vault: repeated queries return byte-identical results, a smaller `limit` is a prefix of a larger one, every returned ref is a valid input to the next tool, facet counts agree with predicate counts, and reads stay stable across a write
- Add a 5,000-note soak test running a 25-turn interleaved session (search → read → traverse → write) with queries sampled from vault content rather than hand-written, asserting no result drift between the first and last turn

## [0.5.5] - 2026-08-07

### Fixes

- Build `dist` during Git dependency installation so the declared `obsidian-intelligence-layer` executable is present and runnable
- Document an explicit `npx --package` MCP configuration that resolves the packaged executable consistently

### Tests

- Pack and install the release artifact in a clean temporary project, verify the CLI entrypoint and platform shim, complete a real MCP initialization handshake, and list the server tools
- Require lint, unit tests, and the package startup smoke test in the publish workflow and before manual publication

## [0.5.4] - 2026-08-07

### Fixes

- Write the persisted graph index atomically (temp file + rename) so a concurrent reader can no longer observe a partially written file and discard the index, which forced repeated full rebuilds
- Await index persistence during cold start so an early shutdown cannot leave the vault without an index and trigger another full rebuild on the next start
- Retry the index rename on transient Windows `EPERM`/`EACCES` while another instance holds the file open
- Skip the redundant second index read during warm start, which re-parsed the whole file and discarded live watcher and write updates
- Reset the `building` flag when index persistence fails
- Sweep temp files orphaned by an interrupted save instead of leaving them in the vault

### Improvements

- Report why the graph index could not be read instead of silently falling back to a full rebuild

### Tests

- Add regression coverage for incremental startup: live-update preservation, insert and delete handling, temp-file cleanup, and building-flag reset

## [0.5.3] - 2026-08-04

### Fixes

- Normalize CRLF line endings across parser boundaries so section retrieval works for Windows-authored notes
- Prevent stale reads by normalizing Windows paths, fixing watcher exclusions for dotted vault roots, revalidating cached notes by modification time, and reindexing writes inline

### Tests

- Add regression coverage for CRLF parsing, retrieval, cache revalidation, watcher invalidation, write consistency, and response truncation

## [0.5.2] - 2026-04-21

### Fixes

- Adjust padding and dimensions in safe writes animation for improved layout

## [0.5.1] - 2026-04-13

### Docs

- Add animated HTML previews and GIFs for customer workflows, safe writes, search & inspect, and audit log
- Add GIF capture script (`capture-gifs.mjs`) for generating docs assets
- Update README with new showcase GIF references
- Migrate Showrunner skill to `showrunner-video`, add scene-types reference

## [0.5.0] - 2026-04-13

### Features

- Overhaul overview GIF and HTML preview with 10 animated scenes
- Add dedicated code-terminal scenes for install CLI and `.vscode/mcp.json` setup
- Add search capabilities showcase scene (`search_vault`, `semantic_search`, `query_frontmatter`)
- Add "How OIL Saves Tokens" pipeline funnel and updated KPI scorecard

### Docs

- Rewrite overview storyboard: title, problem statement, comparison, quick setup (section header + terminal + mcp.json config), search tools, token funnel, KPI stats, closing
- Highlight `OBSIDIAN_VAULT_PATH` as the only required configuration throughout setup scenes

## [0.4.0] - 2026-04-13

### Features

- Enhance frontmatter ID extraction and section parsing

### Fixes

- Add TPID auto-resolution to `get_customer_context`, fix test setup
- Skip real-vault bench when vault path missing (CI)

## [0.3.1] - 2026-04-07

### Performance

- Eliminate disk I/O from `contentSearch`, remove dead config

## [0.3.0] - 2026-04-04

### Features

- Add new retrieval tools for related entities and semantic search
- Enhance retrieval tools with search functionality and word count utility

### Refactors

- Simplify search functionality and remove semantic model support

## [0.2.0] - 2026-03-28

### Features

- Optimize MCP tool surface — consolidate tools, add domain routing
- Comprehensive account review workflows, delegation frameworks, and CSU commitment validation
- Add eval persistence and regression detection script
- Add Obsidian vault instructions for local knowledge management and CRM integration

### Fixes

- TPID auto-resolution for vault customer lookups + Windows path normalization
- Correct npm command in publish workflow and update subtree remote in sync script
