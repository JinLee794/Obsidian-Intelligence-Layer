# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- **Configure OIL from the MCP client.** An MCP client wires up a server through `command`, `args` and `env` — never through files inside the user's vault — so every semantic setting is now reachable from CLI flags (`--no-semantic`, `--semantic-model`, `--semantic-endpoint`, `--semantic-min-score`, `--vault`) and environment variables (`OIL_SEMANTIC`, `OIL_SEMANTIC_MODEL`, `OIL_SEMANTIC_ENDPOINT`, `OIL_SEMANTIC_MIN_SCORE`). Resolution order is flags → environment → `oil.config.yaml` → defaults. Turning the tier off is now one line in a client config rather than an edit to the vault
- **Add `obsidian-intelligence-layer doctor`.** Reports whether the vault resolves, whether Ollama is reachable, whether the model is present, and the *effective* settings after all three configuration layers are merged — so "why is the semantic tier off?" is answerable without reading server logs through an MCP client. Exits non-zero when something needs attention- **Verify the optional tier against the packed artifact.** `npm run test:package` now packs, installs into a scratch consumer project, and connects a real MCP client twice: once with `OIL_SEMANTIC=off`, and once with the tier enabled but Ollama unreachable. Both must initialize and answer a `search_vault` call, which pins the backwards-compatibility guarantee that an absent Ollama can never break an existing install- **Incremental index maintenance.** `GraphIndex` now keeps a bounded log of which notes changed, and derived indexes patch just those instead of discarding everything on any edit. Previously a one-character change to one note threw away every BM25 posting list and the whole fuzzy index: measured on a 10,000-note vault, the first query after a single edit stalled for ~1.05 s (BM25) plus ~0.2 s (fuzzy). BM25's update overhead is now flat at ~0-5 ms regardless of vault size. Callers whose delta has rolled out of the log, or who predate a wholesale rebuild, still fall back to a full build
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

- **Removed the `semantic_search` tool**, folding it into `search_vault`; the tool surface is now 13 tools. Despite its name, `semantic_search` never did meaning-based retrieval — it ran fuzzy title matching plus a substring scan over the first 10 KB of each note, which `search_vault` now covers with better ranking. Meaning-based retrieval now exists for the first time, as a tier of `search_vault` rather than a separate tool
- **Removed `searchVault()`**, a second cascade implementation that duplicated `cascadeSearch()` but was unreachable from the tool layer. It survived only in tests and benchmarks, which now exercise the production path
- **The fuzzy tier no longer indexes note bodies.** BM25 already indexes them with term statistics and prefix expansion, so fuse.js was making a slower second pass over the same text — and it was the dominant cost of the tier. The three tiers now have disjoint jobs: BM25 owns exact terms and identifiers, fuzzy owns misspelled names, semantic owns meaning
- Give fuzzy and semantic hits a leading excerpt from the note body instead of a bare tag list, so a result explains why it was returned
- Type-check `bench/`, `scripts/`, and `src/__tests__/` in `npm run lint` via `tsconfig.check.json`. They were excluded, which is how a benchmark kept calling a deleted API unnoticed
- Add `bench/semantic-live-check.mjs`, which validates the semantic tier through the real stdio MCP server against a live Ollama: it waits for the background embed, then asks `search_vault` questions phrased to share no vocabulary with the notes that answer them, asserting each hit is credited to the semantic tier — and that an exact entity query is still answered without it
- Add `bench/index-liveness.mjs`, an end-to-end validation harness that drives the real MCP tool layer and file watcher: it edits, creates and deletes notes on disk, writes through `create_note`/`atomic_append`, and asserts every derived index reflects the change and retains no stale trace — including a full-rebuild equivalence check at scale
- Add `bench/rebuild-cost.mjs`, which separates BM25 and fuzzy index update overhead from query cost
- Add `bench/semantic-eval.mjs`, a scale harness for the semantic tier. It runs against a real Ollama when one is reachable and a deterministic 768-dimension stub otherwise, measuring embed throughput, restart cost, incremental re-embedding, query latency, and the escalation gate. Verified linear scaling to 10,000 notes
- Add `bench/tier-breakdown.mjs`, which measures per-tier query cost by query length — the evidence behind the fuzzy tier's query-shape gate
- Remove the unregistered `orient` and `composite` tool modules and the superseded write-approval gate

### Migration

- Callers of `semantic_search(query, limit)` should call `search_vault(query, limit)`. Ranking improves, and the response adds `tiers_used`, `escalated`, and per-result `matched_by`

### Fixes

- **`npm run test:package` could not run under pnpm or on modern Node for Windows.** It drove the package manager named by `npm_execpath` — which is pnpm when a developer uses pnpm, and pnpm does not implement `pack --pack-destination` — and a `npm.cmd` fallback fails with `EINVAL` on current Node. It now resolves npm's own `npm-cli.js` and runs it under the active Node. The release gate was silently unrunnable for pnpm users
- **Include Ollama's error body in the failure reason.** A bare `HTTP 400` is undiagnosable; the tier now reports what Ollama actually said, in `get_health` and in the startup log
- **Report file-watcher readiness.** chokidar observes nothing until its initial scan completes — seconds on a large vault — and edits made in that window were silently lost with no way to tell. `VaultWatcher` now exposes `whenReady()` and reports `ready` in `get_health`, and startup logs a line when the vault is genuinely being watched. Found by an end-to-end liveness harness on a 2,000-note vault, where an edit made just after startup never reached the index
- **Retry the vector sidecar rename once on Windows.** A scanner or search indexer can hold the destination open briefly after it is written, surfacing as `EPERM`/`EBUSY` and losing the save
- **The semantic tier fired on almost every query.** Escalation required *both* full term coverage and a full page of results, but a specific query rarely returns ten notes — so a query BM25 had completely understood still escalated and paid for an embedding round trip. The semantic tier is now gated on term coverage alone: if every query term matched, there simply are not more notes about it and an embedding cannot conjure any. Measured on a 5,000-note vault, an exact-title query went from 2 embedding calls to 0
- **Restrict the fuzzy tier to name-shaped queries (≤ 3 terms).** Measured at 5,000 notes, fuse.js costs 360x BM25 for a one-word query and 3,000x for four words — roughly a second for a seven-word question — because bitap runs per token per document. A natural-language question is never a misspelled note title, so it was paying the most for the tier least able to answer it. End-to-end cascade latency on a 5,000-note vault dropped from 438 ms to 10 ms (p50)
- **Break BM25 score ties by path.** Ranking previously fell out of posting-list insertion order, so two equal-scoring notes could be ordered differently by an incrementally updated index than by a freshly built one — and differently again after an unrelated edit
- **Fix a vector sidecar write collision.** The temp file was named after the process id, so two indexes over one vault in the same process raced for the same path and the loser's rename failed with `ENOENT`. The suffix is now random per save
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
