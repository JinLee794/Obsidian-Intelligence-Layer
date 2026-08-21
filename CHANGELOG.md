# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] - 2026-08-20

Semantic search, incremental indexing, and reliable startup — plus a measurable
definition of "good results". The tool surface grows by one to 15 tools. With no
Ollama running everything behaves as it did in 0.5.5 except `semantic_search`,
which now returns an explained zero instead of lexical hits.

### Added

- **A semantic tier in `search_vault`, backed by local Ollama embeddings.** It
  runs last in the cascade, only when the lexical tiers fail to cover the query,
  so entity lookups keep their millisecond path. Zero new npm dependencies, no
  native module, no vector database — normalised `Float32Array`s ranked by
  brute-force cosine, which stays well ahead of ANN territory below ~100k notes.
  The model is pulled on first run, vectors embed in the background, only changed
  notes are re-embedded, and the index persists to `_oil-vectors.json`. Without
  Ollama the tier reports itself unavailable and search continues.
- **BM25 lexical ranking** — an in-tree Okapi implementation (IDF, term-frequency
  saturation, length normalisation, field boosts) replacing hand-tuned constants.
- **Frontmatter is indexed.** Values flatten into dotted key paths
  (`opportunities.guid`) as their own weighted field; every TPID, account id and
  status was previously invisible to search. An exact-match tier ahead of BM25
  resolves identifier queries by whole-value equality and reports which field
  matched (`matched_by: ["frontmatter:tpid"]`).
- **`query_frontmatter` became a four-mode structured query** — no arguments to
  discover every key, `key` to list its values and counts, `key`+`value_fragment`
  to match a substring, or `where` to filter across fields. Adds `folder`,
  `order_by`, `limit`, and dotted paths in predicates.
- **`atomic_replace_section`** — overwrite one heading's body under the same
  `expected_mtime` check. Editing part of a note previously required
  `atomic_replace` with the whole file, which no read tool could produce. A
  missing heading is a `NOT_FOUND` listing `available_headings`, never a silently
  created section.
- **`obsidian-intelligence-layer doctor`** — reports whether the vault resolves,
  whether Ollama is reachable, whether the model is present, and the *effective*
  settings after all configuration layers merge. Exits non-zero when something
  needs attention.
- **Configuration from the MCP client**, which wires up a server through
  `command`/`args`/`env` and never through files inside the vault. Every semantic
  setting is reachable by CLI flag (`--no-semantic`, `--semantic-model`,
  `--semantic-endpoint`, `--semantic-min-score`, `--vault`) or environment
  variable. Resolution order is flags → environment → `oil.config.yaml` →
  defaults.
- **`get_health` reports startup and semantic state** — a `startup` block
  (`phase`, `attempts`, `duration_ms`, and a `reason` when not ready) plus the
  tier's `status`, `model`, `note_count`, `dimensions` and `reason`. It is
  deliberately ungated, so it is how a caller learns *why* other tools are
  waiting rather than guessing at a hang.
- **`get_related_entities` reports `hops` and `via` per entry, nearest first.**
  The traversal previously collapsed every hop into one flat set, leaving callers
  no way to rank or safely truncate.
- **Incremental index maintenance.** `GraphIndex` keeps a bounded log of changed
  notes, and derived indexes patch just those. Previously a one-character edit
  discarded every BM25 posting list and the whole fuzzy index: on a 10,000-note
  vault the next query stalled ~1.05 s (BM25) plus ~0.2 s (fuzzy). BM25 update
  overhead is now flat at ~0–5 ms regardless of vault size. The fuzzy index
  rebuilds outright once a delta exceeds 5% of the vault, because fuse.js
  renumbers its whole record array per removed document.
- **Startup and warm-start regression coverage.** `startup-contract.test.ts`
  asserts the ordering contract over an in-memory transport;
  `scripts/startup-contract.mjs` spawns the built artifact over real stdio and
  fails a handshake budget, run from outside the repo to prove cwd-independence.
  `warm-start.test.ts` asserts the work behind the handshake happens once.
  `scripts/verify-observed.mjs` checks these claims against the built artifact
  rather than in-process — it exists because the shutdown fix below was first
  written from the code and turned out to be false in the runtime a client
  drives. The startup gate was itself proven by injecting a warm-only delay
  proportional to persisted-index size: exactly one assertion fails, the scale
  one, so it detects the regression class it exists to prevent.
- **A CI workflow for pull requests** (`.github/workflows/ci.yml`) — lint, tests,
  startup contract and package smoke on Linux and Windows. Previously nothing ran
  until a push to `main`: the only workflow was `Publish`, and its run history
  contains no verification runs at all. The workflow ships *with* this release, so
  it has not yet executed on a pull request — the first PR against this branch is
  what will prove it.
- **Evaluation harnesses.** `bench/eval-golden.mjs` scores `search_vault` against
  scenarios with known answers, grouped so a change that helps one query kind
  while breaking another is visible instead of averaged away; baselines record to
  disk and `--compare` exits non-zero on a drop. `bench/ranking-strategies.mjs`
  isolates ranking policy from retrieval — it is what established that fusing
  beats any single tier (93% hit rate versus 60%). Also `index-liveness`,
  `semantic-probe`, `semantic-live-check`, `semantic-eval`, `rebuild-cost`,
  `tier-breakdown`, `floor-analysis` and `tool-surface-cost`.
- **Consistency and soak suites** — a multi-turn suite over a generated
  1,500-note vault (identical repeat results, smaller `limit` a prefix of a
  larger one, every ref valid input to the next tool, facet counts agreeing with
  predicate counts) and a 5,000-note 25-turn interleaved session asserting no
  drift between first and last turn.

### Changed

- **`semantic_search` is now actually semantic.** The tool is not new, but its
  meaning is: in 0.5.5 it combined fuzzy matching with full-content search, so
  the name promised something the implementation never did. It now queries the
  embedding tier directly, takes `filter_folder` and `filter_tags`, and reports
  *why* a result set is empty. `search_vault` remains the default for ordinary
  lookups and consults the same tier as part of its cascade.
- **Rank fusion is weighted by how much of the query each tier understood.**
  Equal weights let a tier that matched one word of a seven-word question outvote
  one that matched its meaning. Golden set: hit rate 87% → 93%, recall 72% → 78%.
  The damping constant also drops from 60 to 10 — the classic value assumes many
  systems of similar quality, whereas these tiers differ by design and are now
  weighted by evidence, so damping their internal ordering discards signal twice.
  MRR 0.664 → 0.707, four of fifteen cases improved and none regressed.
- **Responses are compact JSON.** Indentation was 25% of every payload
  (17,377 → 13,055 chars across ten representative calls) and nothing on the
  receiving end renders it.
- **`path` is the reference; `ref` appears only when it adds information.** Every
  list item and envelope carried the same string twice — about a quarter of a
  `get_related_entities` payload (measured 26.7–27.2%). `ref` is now emitted only for section-scoped
  results, as `path#heading`. Removed `customer_ref`, `orphaned_meeting_refs`,
  and `query_frontmatter`'s duplicate `matches` array.
- **The fuzzy tier no longer indexes note bodies.** BM25 already indexes them with
  term statistics, so fuse.js was making a slower second pass over the same text —
  the dominant cost of the tier. The three tiers now have disjoint jobs: BM25 owns
  exact terms and identifiers, fuzzy owns misspelled names, semantic owns meaning.
- **`score` is comparable across code paths.** Escalated queries returned raw
  reciprocal-rank sums (~0.016–0.033) while direct answers returned a 0–1 value.
  Both now normalise to the top hit. Rank order is unaffected; it remains a
  relative ranking signal, not an absolute confidence.
- **`search.exclude_folders` / `OIL_EXCLUDE_FOLDERS`.** Vaults keeping tooling,
  templates or agent logs alongside notes had them competing for rank — on one
  vault, 4 of 10 results for a customer question were skill and prompt documents.
  Excluded folders drop out of every tier while graph traversal, frontmatter
  queries and the audit log still see them. An explicit `filter_folder` overrides.
- `GraphIndex` exposes `dirty` and `flush()`, and reads split into a parallel
  `readNote` and a synchronous `applyNote` applied in vault order, so concurrency
  cannot make an ambiguous wikilink resolve differently run to run.
- `get_health` no longer reports `tool_surface` — a hand-maintained literal
  restating a list the client already holds from `tools/list`.
- Removed `searchVault()` — live production code that `cascadeSearch()`
  superseded, not a dead test-only duplicate — along with the unregistered
  `orient` and `composite` modules and the superseded write-approval gate.
- `bench/`, `scripts/` and `src/__tests__/` are type-checked by `npm run lint`
  via `tsconfig.check.json`. They were excluded, which is how a benchmark kept
  calling a deleted API unnoticed.
- Wall-clock performance ceilings moved behind `OIL_PERF=1` (`npm run
  test:perf`). They assert absolute latency, which is only meaningful on an idle
  machine — under load they failed on unmodified `main` too, and a gate that
  cries wolf is one people learn to ignore. That was the dominant source of
  `check:release` flakiness and it is fixed; the suite has run green repeatedly
  since. A handful of watcher tests remain timing-sensitive and are declared with
  `{ retry: 2 }`, so "deterministic" is the goal rather than a measured
  guarantee.

### Fixed

- **The server no longer fails to start on a cold or slow vault.** The stdio
  transport was connected *last*, after the graph build, semantic load, watcher
  and tool registration — so a client's `initialize` sat behind a full vault
  index, measured at 6,441 ms cold for 2,000 notes on a local SSD and unbounded
  on synced or network storage. The SDK gives up at 60 s, so a large or slow
  enough vault could never connect at all. A small vault stays far under that
  ceiling — the intermittent failures there came from the leaked watcher, the
  watcher crash and the unguarded rejection paths below, not from this — but the
  handshake had no business scaling with vault size either way. The transport now
  connects first and vault work runs behind a hydration gate.
- **A burst of file changes no longer costs O(vault) per file.** The watcher gave
  every changed path its own debounce timer, so a sync, a `git pull` or a bulk
  rename produced one re-index and one search invalidation per filesystem
  *event* — in practice more than one per file, since a newly synced note arrives
  as both an `add` and a `change`: a 12-file burst produced 18 of each, against 3
  now. Each of those rebuilt every backlink in the vault, 85% of the cost of an
  edit at 6,000 notes. Changes now collect into one window (300 ms trailing,
  shared across paths, capped at 2 s — measured from the first change of a
  window, not from the previous flush — so a continuous stream cannot defer
  indexing indefinitely) and apply as a batch that re-resolves only the edited
  notes' own links. The whole-vault pass is reserved for changes that alter what
  a wikilink can point at: a renamed title, a note appearing, a note deleted; a
  bulk delete costs one pass, not one per note. The durable result is the shape:
  a 200-note burst used to resolve 200 × vault-size notes (75,800 at 379 notes,
  1,200,000 at 6,000) and now resolves exactly 200 at every vault size. Wall
  clock on one machine, where the absolutes are I/O-bound: **2,278 ms → 133 ms at
  6,000 notes**, **427 ms → 97 ms at 379**.
- **A link whose target arrived later never resolved.** Re-resolution read from
  each note's already-resolved links, which by then held paths with anything
  unresolvable silently dropped — so the raw name was gone and no later pass could
  recover it. `[[Later]]` written before `Later.md` existed stayed broken for the
  life of the index, and the running index diverged permanently from what a
  rebuild produced. Resolution now reads the raw names that were being retained
  for persistence all along, making it idempotent. One divergence from a rebuild
  remains and predates this release: where several notes answer to the same name,
  which one an ambiguous link resolves to can still depend on the order the
  changes arrived in. Every link resolves, and always to a note that legitimately
  holds the name. See `KNOWN_ISSUES.md`.
- **A repeat connect no longer re-reads the whole vault.** The persisted index was
  working, but everything behind it repeated every session and could repeat
  forever. `buildIncremental` stat'd notes one at a time while chokidar's
  recursive scan ran concurrently, so each connect traversed the vault twice at
  once — stats now issue with bounded parallelism and the two walks are
  serialised. Worse, indexing was never persisted unless it finished before the
  client disconnected, so any vault slow enough that re-indexing outlasts a
  session *never converged*; the index now checkpoints during the rebuild, at the
  128-note batch boundary that follows every 500 notes indexed or two seconds
  elapsed — so a logged checkpoint lands at 512, not 500. Time to a hydrated
  2,000-note index fell about **5x** (measured 4,989 ms → 1,004 ms on one
  machine; the ratio is the durable result, the absolutes are I/O-bound and vary
  with the storage under the vault).
- **Revalidation no longer waits for the file watcher.** Serialising the two vault
  walks was right; the order was not. Gating revalidation behind the watcher's
  recursive scan meant any session shorter than that scan did no index work at
  all. Measured on 6,000 notes after a mass invalidation, outstanding work now
  falls monotonically to zero across short sessions (4592 → 4080 → 3056 → 2032 →
  1008 → 0) where before it did not move.
- **The server now notices, and survives, the end of a session.** A stdio client
  does not ask a server to stop, it kills it: `SIGTERM`, then `SIGKILL` two
  seconds later, and on Windows the first is a `TerminateProcess` that runs no
  handler. `StdioServerTransport` subscribes only to stdin's `data` and `error`,
  so its `onclose` never fires for a disconnect either. The server hung on stdin
  EOF until the client escalated, holding a watcher over the whole vault the
  entire time — observed leaking across sessions. stdin's hangup is now watched
  directly, and the exit is prompt: measured across adversarial closes at every
  point in the startup lifecycle, the process exits code 0 having run its
  shutdown path, typically within 60–230 ms and at worst around half a second
  mid-build. The one thing to know is that the clock starts when the transport
  connects, not when stdin closes: a client that closes stdin before the
  handshake completes waits for startup to reach the connect, then exits.
  Durability does not depend on any of this: checkpointing is the guarantee,
  because no shutdown path can be relied on.
- **A file-watcher error no longer kills the process.** `VaultWatcher` attached
  `add`/`change`/`unlink` handlers but no `error` handler, and a chokidar instance
  with zero `error` listeners *throws* on `emit("error")` — EMFILE, ENOSPC and
  EPERM are routine on Windows with OneDrive or antivirus in the path. The error
  is recorded in `get_health.watcher.last_error` and the watcher keeps serving.
- **A corrupt persisted index is rebuilt rather than fatal.** A truncated or
  malformed `_oil-graph.json` is discarded and the vault re-indexed; the server
  reaches `ready` and answers normally. Note that a *truncated* file is discarded
  silently — the "index corrupt, will rebuild" diagnostic covers version
  mismatches and bad node shapes, so do not rely on a log line to tell you a
  rebuild happened.
- **A missing or unreachable vault is diagnosed, not fatal.** A nonexistent path
  exited 1 with a raw `ENOENT ... scandir` stack. Startup now preflights the
  vault, completes the handshake regardless, and retries with backoff, so a drive
  that mounts late heals itself instead of requiring a restart.
- **Unhandled rejections and uncaught exceptions no longer end the session.**
  There were no process-level guards anywhere, and a background
  `void semantic.refresh(graph)` rejection terminates the process on Node 20+. A
  degraded server that reports its own state beats a dead one.
- **File-watcher readiness is reported.** chokidar observes nothing until its
  initial scan completes — seconds on a large vault — and edits made in that
  window were silently lost with no way to tell. `whenReady()` is exposed and
  `ready` appears in `get_health`. Found by an end-to-end liveness harness on a
  2,000-note vault, where an edit just after startup never reached the index.
- **The vector index only refreshed on queries that reached the semantic tier.**
  `ensureFresh` hung off the tier itself, which the cascade runs only when the
  lexical tiers fail to cover a query — rare in an entity-keyed vault. A vault
  could be edited all day and stay stale, and the query that finally needed
  meaning then ranked against stale vectors. Reconciliation now happens on every
  search, at the cost of a version comparison when nothing changed.
- **The semantic tier reported `ready` without ever reaching Ollama**, and a
  once-reachable Ollama was trusted forever. A complete vector sidecar lets the
  tier rank notes, but every *query* still has to be embedded — so `get_health`
  claimed health while searches silently returned nothing. Readiness now requires
  the endpoint to answer at least once, and a failed call clears the verification
  so the next refresh re-probes. Caught by the packaged smoke test.
- **Ollama failures are diagnosable.** Node's fetch describes every transport
  failure as a bare "fetch failed" and puts the useful part on `cause`; that
  string, and Ollama's own error body behind an `HTTP 400`, now reach users
  through `get_health`, `doctor` and search responses.
- **The semantic relevance floor never rejected anything.** Measured against
  `nomic-embed-text` on a 360-note vault, real queries score 0.554–0.749 against
  their best note, gibberish tops out at 0.531 and off-topic English at 0.454 — so
  the 0.45 default sat below every noise score and "no match" was unreachable. The
  default is now 0.5; `zzxqq wibblewobble` returns nothing where it previously
  returned five results.
- **The semantic tier fired on almost every query.** Escalation required *both*
  full term coverage and a full page of results, but a specific query rarely
  returns ten notes — so a query BM25 had completely understood still paid for an
  embedding round trip. It is now gated on term coverage alone: if every term
  matched, there simply are not more notes about it. On 5,000 notes an exact-title
  query went from 2 embedding calls to 0.
- **The fuzzy tier is restricted to name-shaped queries (≤ 3 terms).** At 5,000
  notes fuse.js costs 360x BM25 for a one-word query and 3,000x for four — roughly
  a second for a seven-word question — because bitap runs per token per document.
  A natural-language question is never a misspelled note title, so it was paying
  most for the tier least able to answer it. Cascade latency dropped from 438 ms
  to 10 ms (p50).
- **Ranking is deterministic.** BM25 ties now break by path, so an incrementally
  updated index cannot order two equal-scoring notes differently from a freshly
  built one. Exact frontmatter matches return in a deterministic order rather than
  index insertion order — a category query like `at-risk` previously returned a
  different window after unrelated writes — and report `total_matched` and
  `truncated`.
- **`appendToSection` writes to the section `read_note_section` reports.** It
  ended a section at the next same-or-higher heading while `parseSections` ended
  it at the next heading of any level, so a write to a heading with sub-headings
  landed outside that section, and a write to a note's H1 went to end-of-file. It
  reported `executed` either way, so an agent verifying its own write could not
  find it.
- **`npm run test:package` could not run under pnpm or on modern Node for
  Windows.** It drove the package manager named by `npm_execpath` — pnpm, for a
  pnpm developer, which does not implement `pack --pack-destination` — and the
  `npm.cmd` fallback fails with `EINVAL` on current Node. It now resolves npm's
  own `npm-cli.js` and runs it under the active Node. The release gate was
  silently unrunnable for pnpm users.
- **The idle-schema guard measured the wrong string.** `totalSchemaChars()`
  stringified raw zod internals and silently dropped every `.describe()`, so it
  could not catch description bloat. It now sizes the JSON Schema the client
  actually receives — real surface is 15 tools, 9,723 chars.
- Stop reporting a name-fragment match as an identifier match:
  `ACC-NORTHWIND-001` ranked a note because the token `northwind` appeared in its
  title, returning the same results as the meaningless `NORTHWIND-001` with no way
  to tell them apart.
- Retry the vector sidecar rename once on Windows, where a scanner can hold the
  destination open briefly (`EPERM`/`EBUSY`) and lose the save. The temp file is
  also suffixed randomly rather than by process id, which made two indexes over
  one vault race for the same path.
- Assert the server version matches `package.json`. It was duplicated in
  `src/version.ts` behind a comment asking people to keep them in sync, so a
  published server could report the wrong version through `get_health`.
- `query_frontmatter` reports `total_matched` before truncation; it previously
  returned the post-truncation length as `count`, so a capped result was
  indistinguishable from a complete one.
- Fix two latent type errors surfaced by the widened lint scope: a `ParsedNote`
  test fixture missing `title`, `wikilinks` and `tags`, and a benchmark calling a
  `graph.getAllNodes()` method that does not exist. Also drop a `tier` field that
  `logWrite` no longer accepts, which broke `tsc --noEmit`.

### Migration

One tool is added (`atomic_replace_section`, 14 → 15) and none are removed or
renamed. Calls keep working, but **responses changed shape, and for four tools
the change removes a container a 0.5.5 caller indexes into** — that is a crash,
not a silent `undefined`, so read this list before upgrading:

| Tool | Change | A naive 0.5.5 caller |
| --- | --- | --- |
| `search_vault` | bare array → `{count, tiers_used, escalated, results}` | **breaks** — array methods on an object |
| `query_frontmatter` | `matches[]` removed | **breaks** — iterating `matches` |
| `check_vault_health` | `orphaned_meeting_refs[]` removed | **breaks** — iterating the array |
| `get_health` | `tool_surface{}` removed | **breaks** — property access on the object |
| nine others | `ref` / `customer_ref` narrowed or dropped | degrades to `undefined` |
| `atomic_append` | unchanged | unaffected |

Also worth knowing:

- **`matched_by` is always an array**, never a bare string — treat it as
  `string[]`. It carries two entries when tiers co-match (`lexical+fuzzy`,
  `lexical+semantic`).
- **`search_vault`'s envelope fields are not all unconditional** — `escalated` is
  present only when the cascade escalated. Read defensively.

- **`semantic_search` answers differently.** It was fuzzy-plus-full-text under a
  semantic name; it is now embedding-backed. Callers that wanted the old broad
  lexical recall want `search_vault(query, limit)`, whose response adds
  `tiers_used`, `escalated` and per-result `matched_by`. With no Ollama reachable
  `semantic_search` returns zero results and says why, where 0.5.5 returned
  lexical hits — this is the one behaviour that changes without Ollama present.
- Anything thresholding on the raw `score` number should switch to rank or
  `matched_by`.
- **The semantic tier is on by default** and will pull `nomic-embed-text`
  (~274 MB) the first time it runs if Ollama is reachable. `OIL_SEMANTIC=off`
  opts out entirely.
- **Search can now legitimately return zero results.** The relevance floor
  previously admitted everything, so a nonsense query still produced hits.
- `_oil-vectors.json` lives in the vault and grows with it — roughly 4 MB per
  1,000 notes. Vaults under git or Obsidian Sync should ignore it; it is a cache
  and is rebuilt from the notes.
- Vaults that keep tooling or archives alongside notes can set
  `search.exclude_folders` / `OIL_EXCLUDE_FOLDERS` to keep them out of rankings.
- `npm test` no longer runs the wall-clock performance ceilings; use
  `npm run test:perf` on an idle machine.

### Known limitations

Shipped deliberately, with the evidence that justified each call.

- **The semantic relevance floor is corpus- and model-specific.** The 0.5 default
  was measured against `nomic-embed-text` on a 360-note vault; on the 12-note
  fixture it costs one rank position on a typo query, and on a very different
  corpus it may sit in the wrong place entirely. `bench/floor-analysis.mjs`
  measures the real-versus-noise separation for a given vault, and
  `OIL_SEMANTIC_MIN_SCORE` applies the answer. The floor governs embeddings, not
  BM25, so "no match" is reachable for gibberish but not guaranteed for
  everything irrelevant.
- **Semantic hits can still rank mid-page on some queries.** Coverage weighting
  and a smaller `k` moved the worst cases up sharply — worst observed
  first-relevant rank fell from 9 to 7 — but a correct answer can still land
  around rank 6–7 when many notes share query vocabulary. The remaining lever is
  the coverage floor, which the golden set can score.
- **Some notes are genuinely not retrievable by meaning.** One golden case
  (`disaster recovery`) is absent from the tier's results under every
  representation tried, because its body is CRM metadata and its concept appears
  only as an abbreviation in the title. Expanding known abbreviations before
  embedding is the untested idea.
- **A second "identity" vector per note does not help.** On a 360-note vault,
  embedding title, tags and headings separately and scoring `max(full, identity)`
  left targets reachable in the top ten at 6 of 8 — exactly matching the single
  full-text vector — while regressing two cases. It is cheap (41 s versus ~6
  minutes for a full pass), so it is worth retrying if the embedding recipe
  changes, but on current evidence it buys nothing.
- **The tier recovers from an Ollama outage on the next vault change, not
  immediately.** A failed call marks it unavailable and forces re-verification,
  but nothing re-probes on a fixed interval, so a restarted Ollama with an
  otherwise idle vault stays unused until something is edited.
- **Shutdown does not drain an in-flight refresh.** A background embed can
  complete after the server stops accepting requests. The sidecar write is
  replace-by-rename, so the risk is a wasted write rather than a corrupt file.
- **fuse.js is the most expensive component on every axis** — query, build and
  update cost — for the narrow job of catching a misspelled name. At 5,000 notes
  it costs 360x BM25 for one word and 3,000x for four. The query-shape gate bounds
  the damage; replacing it with an in-tree bounded edit-distance match over the
  title vocabulary would be faster and one dependency lighter.

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
