# Agentic Memory Architecture Spec

**Working title:** Stateful Substrate + Policy Skill (SSPS)
**Version:** 0.1 (draft)
**Status:** Interface-level spec, pre-implementation
**Reference implementation:** [Obsidian-Intelligence-Layer (OIL)](https://github.com/JinLee794/Obsidian-Intelligence-Layer)

---

## 1. Motivation

Current agent memory systems force a choice between two imperfect layers:

- **MCP servers** are good at holding state (indices, caches, file watchers, locks) and providing typed, composable primitives. Their cost is that every tool schema lives permanently in the system prompt, and discovery is all-or-nothing.
- **Skills** are good at expressing *policy* ("when should I remember this?", "when should I summarize vs. retrieve?") and have near-zero idle context cost via progressive disclosure. Their cost is that they are stateless by default — every invocation pays cold-start and re-indexing tax.

For agentic memory specifically, neither layer is sufficient alone:

| Memory concern             | MCP alone            | Skill alone             | Needed |
|----------------------------|----------------------|-------------------------|--------|
| Persistent indices         | Natural              | Awkward (disk serde)    | MCP    |
| File watching / reactivity | Natural (daemon)     | Impossible              | MCP    |
| Optimistic concurrency     | Natural              | Clunky                  | MCP    |
| Cross-session caching      | Natural              | Must serialize          | MCP    |
| When-to-remember policy    | Wrong layer          | Natural                 | Skill  |
| Task-shaped composition    | Hard-coded           | Easy to iterate         | Skill  |
| Low idle context cost      | Poor (eager schemas) | Excellent (lazy)        | Skill  |
| Task-tuned prompts         | N/A                  | Natural                 | Skill  |

This spec defines a layered architecture where the **MCP is the storage engine** and the **Skill is the memory-management policy**, with an explicit contract between them.

---

## 2. Design principles

1. **Stateful concerns belong in the MCP.** Any behavior that requires memory across tool calls — indices, caches, watchers, locks — lives in the server. Skills must not attempt to simulate state via disk files.
2. **Policy belongs in the Skill.** When to remember, when to summarize, when to retrieve, how to compress, how to name notes — all live in a skill that a human can edit without redeploying the server.
3. **Deterministic reuse belongs in the MCP.** If a workflow depends on substrate-owned state, has a stable output shape, and is worth testing once for repeated reuse, it is a good MCP candidate.
4. **Preference-heavy judgment belongs in the Skill.** Summarization style, note naming, "should I remember this?", retry thresholds, and escalation behavior should remain editable in `SKILL.md`.
5. **Tools should be task-shaped only when the task is stable.** Prefer `get_customer_context` over `search_vault` + `read_note_section` × 5 when the composition is durable and reusable. Do not push one-off orchestration into the server just to save a call.
6. **Idle context cost is a system property.** A manifest plus `describe_tool` only reduces prompt cost if the MCP client supports lazy schema loading or dynamic activation. Without client support, the manifest still improves portability and planning, but not prompt footprint by itself.
7. **Policy is hot-swappable.** The substrate has no opinion about *how* an agent should use it. Swapping the skill must not require touching the server.
8. **Concurrency is explicit, not implicit.** Mutating updates require a freshness token (mtime, ETag, or version). Create-only writes require an explicit non-existence check. Blind overwrites are a protocol error.
9. **Memory is addressable, not just searchable.** The substrate supports both content queries (search) and stable references (note IDs / paths / anchors) so that the policy layer can hold pointers in its own working state.

---

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│                       Agent (LLM loop)                       │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  natural-language intent
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                  Policy Skill (e.g. "memory")                │
│  ─ SKILL.md: when-to-remember, retrieval heuristics,         │
│    summarization policy, naming conventions                  │
│  ─ scripts/: optional helpers (summarize, dedupe, diff)      │
│  ─ manifest.yaml: declares required substrate capabilities   │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  task-shaped tool calls
                             │  (freshness tokens attached)
                             ▼
┌──────────────────────────────────────────────────────────────┐
│            Stateful Substrate (MCP server, e.g. OIL)         │
│  ─ Indices (graph, fuzzy, frontmatter)                       │
│  ─ Caches (LRU session, hot paths)                           │
│  ─ Watchers (filesystem, external sources)                   │
│  ─ Lock manager (mtime / ETag / version)                     │
│  ─ Capability manifest (lazy schema disclosure)              │
└──────────────────────────────────────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Storage (vault / DB / docs) │
              └──────────────────────────────┘
```

Three things change relative to a "pure MCP" design:

- The substrate ships a **capability manifest** (§5) so agents can discover tools without eagerly loading every schema.
- The policy layer is **externalized into a skill** with a declared dependency on substrate capabilities.
- Tools expose **task-shaped aggregators** alongside primitives, so the skill can pick the right level of abstraction per situation.

---

## 4. Substrate contract (MCP side)

### 4.1 State ownership

The substrate is the sole owner of:

- Persistent indices (graph, inverted, embedding, frontmatter)
- In-memory caches (LRU, hot-path, negative caches)
- File watchers or external change feeds
- Freshness tokens (mtime, ETag, or monotonic version)
- Write-audit log

Skills MUST NOT persist their own shadow indices or caches of substrate data. If a skill needs a derived view, it requests it from the substrate, which may memoize internally.

### 4.2 Capability tiers

Every substrate tool is tagged with exactly one tier:

- **Tier 0 — Core.** Always present in the manifest. Examples: `list_capabilities`, `describe_tool`, `get_health`. These are the only tools a lazy-loading client SHOULD need to eagerly load.
- **Tier 1 — Primitives.** CRUD-shaped operations: `search`, `read_section`, `atomic_append`, `get_metadata`, `graph_neighbors`. Their schemas SHOULD be available on demand.
- **Tier 2 — Task aggregators.** Purpose-built composites: `get_customer_context`, `prepare_crm_prefetch`. Their schemas SHOULD be available on demand.

Rationale: Tier 0 keeps discovery cheap. Tier 2 keeps agent reasoning cheap. Tier 1 is the escape hatch when no aggregator fits.

### 4.2B Visibility tools

Observability tools need a stricter rule because they are useful, but usually not part of the hot path.

- **Tier 0 visibility SHOULD be summary-level only.** Good candidates: health status, audit enabled/disabled, last write timestamp, index freshness, runtime profile.
- **Tier 1 visibility SHOULD hold detail.** Full logs, per-date audit records, large diagnostics, and historical traces belong here.

Tradeoff for `get_agent_log`:

- **If it is Tier 0:** always discoverable and easy to use for self-correction, but every current eager-loading client pays its schema cost even when no audit inspection is needed.
- **If it is Tier 1:** keeps the idle surface smaller and matches normal usage, but makes audit inspection a second-step action rather than something every agent sees immediately.

Recommended balance for OIL:

- Add a tiny Tier 0 visibility tool such as `get_health` that reports audit availability, last write time, index freshness, and server profile.
- Keep `get_agent_log(date)` as Tier 1 for detailed audit inspection.

This gives agents enough deterministic visibility to know when deeper inspection is warranted without turning raw audit data into permanent prompt tax.

### 4.2A Aggregator admission test

A Tier 2 aggregator SHOULD exist only when most of the following are true:

- It uses substrate-owned state or indices.
- It is deterministic enough to regression-test.
- It materially reduces round trips, latency, or token load.
- It is reused across many turns or many users.
- Its output contract is stable enough to version.

A workflow SHOULD stay in the skill when any of the following are true:

- The main value is prompt policy, summarization, or writing style.
- The steps are likely to change with user preference or team process.
- The tool would mostly select among existing primitives rather than compute new substrate-backed structure.
- The workflow needs multi-step fallback, retry, or user-escalation policy.

OIL examples:

- Good Tier 2: `get_customer_context`, `prepare_crm_prefetch`, `check_vault_health`.
- Keep in the skill: what merits a note, meeting-note title/path conventions, summarization format, retry-after-conflict behavior, and when to ask the user.

### 4.3 Tool shape conventions

Every tool response SHOULD be token-optimized:

- Return the smallest useful unit (section, snippet, metadata) by default.
- Cap result counts with configurable limits (search ≤20, graph ≤50).
- Include stable references (path + anchor, or ID + version) on results the skill may round-trip without re-searching.
- Include a freshness token on objects that are likely write targets or conflict boundaries.

Every write tool MUST:

- For updates, require an `expected_version` (mtime, ETag, or opaque token). Create-only tools MAY instead enforce a must-not-exist precondition.
- Reject on mismatch with a structured error code that includes the current token when applicable.
- Emit an audit log entry retrievable via a declared audit tool.

### 4.4 Capability manifest

The manifest is the substrate's self-description. It is returned by `list_capabilities` (Tier 0) and is the only substrate contract a skill can rely on without a schema fetch.

```yaml
substrate: oil
version: 1.2.0
tiers:
  core:
    - list_capabilities
    - describe_tool
    - get_health
  primitives:
    - name: search_vault
      tags: [read, query]
      summary: Ranked fuzzy + content search with snippets.
    - name: atomic_append
      tags: [write, mtime-guarded]
      summary: Append under a heading with concurrency check.
    # ...
  aggregators:
    - name: get_customer_context
      tags: [read, composite]
      summary: Snapshot of opportunities, meetings, action items for a customer.
      composes: [search_vault, read_note_section, get_related_entities]
capabilities:
  freshness_model: mtime_ms
  write_audit: true
  semantic_search: true
  watcher: chokidar
addressing:
  note_ref: "path#anchor"
  stable_id_field: frontmatter.id
```

The skill reads this manifest once per session and decides which tool schemas to fetch.

### 4.5 Current-client optimization profile

Current MCP clients often eagerly expose every registered tool schema. For those clients, the first optimization lever is not discovery metadata; it is the **live registered tool surface**.

For current clients, the substrate SHOULD optimize in this order:

1. Keep the runtime tool surface intentionally small.
2. Collapse overlapping or legacy tools before adding discovery helpers.
3. Prefer parameterized existing tools over adding new near-duplicate tools.
4. Keep Tier 0 tiny and summary-oriented.
5. Treat `list_capabilities` and `describe_tool` primarily as portability and planning features unless the client supports lazy activation.

`list_capabilities` and `describe_tool` are still useful, but they do not reduce prompt cost by themselves in eager-loading clients. SSPS therefore separates two benefits:

- **Portability and planning benefit** — available with a manifest and `describe_tool` alone.
- **Prompt-footprint benefit** — requires client lazy loading, dynamic tool activation, or a dispatcher pattern that keeps the eagerly exposed surface small.

---

## 5. Policy Skill contract

### 5.1 File layout

```
skills/memory/
├── SKILL.md            # Policy: when/why to call substrate
├── manifest.yaml       # Declared substrate dependencies
├── scripts/            # Optional local helpers (pure transforms)
│   ├── summarize.py    # e.g. conversation → note body
│   ├── dedupe.py       # e.g. merge near-duplicate notes
│   └── diff.py
└── prompts/            # Reusable prompt fragments (optional)
    ├── extract_entities.md
    └── compress_thread.md
```

### 5.2 SKILL.md structure

SKILL.md is a progressive-disclosure document loaded only when the skill triggers. Recommended sections:

1. **Trigger** — user intents and agent situations that invoke the skill.
2. **Preconditions** — what substrate capabilities must be present (cross-check with `manifest.yaml`).
3. **Retrieval policy** — when to `search` vs. when to hit an aggregator vs. when to follow graph edges.
4. **Write policy** — when a conversation or observation deserves a note, what to name it, how to structure it, how to attach it to existing notes.
5. **Compression policy** — when to summarize long threads into shorter notes, when to keep verbatim.
6. **Freshness policy** — staleness thresholds, re-read cadence, conflict resolution.
7. **Escalation** — what to do when the substrate returns errors or ambiguous results.

Each policy section SHOULD be <300 tokens and reference primitives by name (verified against the manifest), not by schema.

### 5.3 Skill manifest

```yaml
skill: memory
version: 0.3.0
requires:
  substrate: oil
  substrate_version: ">=1.0.0"
  capabilities:
    - freshness_model: mtime_ms
    - write_audit: true
  tools:
    required:
      - search_vault
      - atomic_append
      - get_note_metadata
    preferred:
      - get_customer_context   # aggregator; falls back to primitives if absent
provides:
  policies:
    - when_to_remember
    - retrieval_strategy
    - compression
```

This manifest is what lets the skill be hot-swapped. A different `memory` skill with the same `requires` block can replace it without touching the substrate.

### 5.4 Scripts are stateless transforms

Any helper script in `scripts/` MUST:

- Be invokable as a subprocess with stdin/stdout I/O.
- Hold no state between invocations.
- Never read substrate storage directly (go through the MCP).
- Be safe to run in parallel.

This preserves the rule that all stateful memory lives in the substrate.

### 5.5 Deterministic scaffolding + policy overlays

The balance between MCP determinism and skill nuance should not be "server does everything" or "skill does everything". The recommended split is:

- **MCP provides deterministic scaffolding.** Canonical entity resolution, vault-specific paths, stable section targets, structured context assembly, conflict boundaries, and compact summaries.
- **Skills provide policy overlays.** Which scaffold to use, when to write, how to summarize, how much detail to request, how to recover from ambiguity, and how workload types differ.

In practice, this means preferring a few stable tools with constrained knobs over a new tool for every workload. Example patterns:

- `get_customer_context(view="brief|full|write")` where OIL controls the deterministic shapes and the skill chooses the mode.
- A small deterministic targeting helper such as `resolve_write_target(kind, entity)` or equivalent server-side logic, while the skill still decides whether the write should happen and what the content should say.
- `get_health` for summary visibility, with `get_agent_log` as the detailed follow-up.

This pattern keeps OIL opinionated about vault mechanics and domain structure, while leaving workload-specific nuance in the skill.

---

## 6. Inter-layer interface

### 6.1 Session bootstrap

1. Agent invokes skill (trigger hits).
2. Skill calls `list_capabilities` on the substrate (Tier 0, cheap).
3. Skill validates its `requires:` block against the manifest.
4. Skill fetches schemas for the specific tools it intends to use this turn via `describe_tool`, if the client or agent runtime supports this pattern. Otherwise the manifest still drives tool choice and fallback logic.
5. Skill proceeds with policy-driven tool calls.

### 6.2 Freshness protocol

All writes follow a read-check-write pattern:

```
read_metadata(ref)            → returns {version: T0, ...}
... agent reasoning, maybe other tool calls ...
atomic_append(ref, expected_version=T0, body)
  → OK { new_version: T1 }
  OR
  → CONFLICT { current_version: T2, diff_hint: "..." }
```

On `CONFLICT`, the skill's **freshness policy** decides: re-read and retry, escalate to the user, or merge.

### 6.3 Addressing

Every object returned by the substrate carries a stable ref:

- `path#anchor` for filesystem-backed stores (OIL, any markdown vault)
- `id:version` for DB-backed stores
- `uri` for external sources

Skills MUST round-trip refs verbatim. They MUST NOT reconstruct refs from displayed titles.

### 6.4 Error taxonomy

Structured errors the skill can branch on:

- `NOT_FOUND` — ref no longer exists
- `CONFLICT` — freshness mismatch on write
- `LIMIT_EXCEEDED` — result cap hit; caller should narrow query
- `CAPABILITY_MISSING` — requested tool not in manifest
- `STALE_INDEX` — index lagging live data; retry recommended
- `PERMISSION_DENIED` — auth/scope issue

Unstructured text-only errors are non-conforming for expected control-flow cases.

---

## 7. Example end-to-end flows

### 7.1 Flow: remember a customer conversation

1. User: "Save the gist of the call I just had with Acme."
2. Agent invokes `memory` skill → SKILL.md loaded.
3. Skill reads its **write policy**: calls it a "meeting note", places it in the vault's configured meetings location (OIL default: `Meetings/`), uses an ISO-date title, and links it back to the resolved customer note.
4. Skill calls `list_capabilities`, confirms `atomic_append`, `create_note`, and `get_note_metadata` are present, fetches their schemas.
5. Skill runs `scripts/summarize.py` locally to compress the transcript into a structured note body (stateless transform).
6. Skill calls `get_note_metadata` on the resolved customer note → gets `mtime_ms = T0`.
7. Skill calls `create_note(path="Meetings/2026-04-19-Acme-Call.md", content=...)`.
8. Skill calls `atomic_append(path="<resolved customer note>", expected_mtime=T0, heading="Meetings", content="[[Meetings/2026-04-19-Acme-Call.md]]")`.
9. On CONFLICT, skill re-reads and retries once; on persistent conflict, surfaces to user.

Context cost: skill body (~2k tokens) + two tool schemas (~600 tokens) in a client that supports lazy schema injection.

### 7.2 Flow: answer a question using prior memory

1. User: "What did we decide about Acme's pricing last quarter?"
2. Agent invokes `memory` skill.
3. Skill reads **retrieval policy**: prefers aggregator `get_customer_context` if present, else fuzzy + graph.
4. Manifest check confirms aggregator exists. Skill fetches only `get_customer_context` schema.
5. One tool call returns a token-capped snapshot (opportunities, recent meetings, action items).
6. Skill composes answer, citing note refs for follow-up.

Context cost: one schema in a client that supports lazy schema injection. No full-document reads. The substrate's internal LRU cache absorbs the repeat-read tax if the user follows up.

### 7.3 Flow: reconciling external edits

1. Agent attempts `atomic_append`; gets `CONFLICT{current_version: T2}`.
2. Skill's **freshness policy** says: if diff is in an unrelated section, retry with new version; if in the target section, summarize both and ask the user.
3. Skill calls `get_note_metadata` and `read_note_section(ref)` to inspect the current content, then branches.

This flow is impossible in a pure-skill design (no persistent watcher / version tracking) and awkward in a pure-MCP design (no externalized merge policy).

---

## 8. Gaps this spec closes

| Gap identified earlier            | How SSPS addresses it                                                |
|-----------------------------------|----------------------------------------------------------------------|
| MCP schemas eagerly loaded        | Capability manifest + tiering define a lazy-loading contract; real token savings still require client support |
| Discovery tax on lazy loading     | Manifest with summaries gives semantic hints without full schemas    |
| Skills can't hold state           | State stays in substrate; skill only holds policy                    |
| Skills duplicate MCP logic        | Scripts are stateless transforms only; no shadow indices             |
| Tool sprawl on MCP side           | Aggregators (Tier 2) collapse common multi-call patterns             |
| Policy baked into server code     | Policy lives in editable SKILL.md, hot-swappable                     |
| Concurrency handled ad hoc        | Freshness tokens required on all writes, error taxonomy is explicit  |
| No fallback between abstractions  | Skill manifest declares `required` vs. `preferred` tools             |

---

## 9. Non-goals

- **Not a new protocol.** SSPS rides on top of MCP and the existing skill convention. The contract additions (manifest, tiers, error taxonomy) are conventions, not wire-format changes.
- **Not a replacement for RAG.** The substrate may internally use embeddings, but SSPS does not prescribe a retrieval algorithm.
- **Not multi-agent coordination.** Single-agent memory only. Multi-agent sharing is future work.
- **Not a UI spec.** How humans edit notes, skills, or manifests is out of scope.

---

## 10. Success criteria

A conforming implementation should demonstrate:

1. **Idle context cost** under 500 tokens for the substrate side (manifest + Tier 0 schemas only) in clients that support lazy schema activation; for current eager-loading clients, the implementation reports the full live-surface cost and optimizes by reducing the registered runtime surface.
2. **Per-task context cost** that scales with tools used or activated, not the superset of tools present in the repository.
3. **Policy edits** (changing retrieval heuristics, naming conventions, compression thresholds) require editing only SKILL.md, not server code.
4. **Substrate swap**: the same skill runs against a different backend (e.g. Notion MCP) if the manifest matches.
5. **Concurrency**: a scripted test with concurrent external edits produces zero lost writes.
6. **Latency**: task-aggregator calls complete in <200ms p50 on a 10k-note vault.
7. **Recovery**: `CAPABILITY_MISSING` errors cause graceful fallback to primitives, not hard failure.
8. **Accounting clarity**: benchmarks distinguish the live runtime tool surface from dormant or legacy modules and from hand-maintained schema fixtures.
9. **Version identity**: the version advertised by the substrate matches the packaged or deployed implementation used by the client.

---

## 11. Open questions

1. **Dynamic activation vs. small-surface discipline.** For current clients, is it better to pursue dynamic tool activation/dispatch later, or simply keep OIL's always-registered runtime surface small and explicit?
2. **Manifest discovery across servers.** If an agent has multiple substrates connected (e.g. OIL + a code-memory MCP), how does the skill disambiguate? Proposal: namespaced capabilities (`oil:search_vault` vs. `code:search_symbols`).
3. **Schema cache lifetime.** Per-session is safe but wasteful across sessions. Is there a versioned cache on the skill side keyed by `substrate:version`?
4. **Streaming aggregators.** Should Tier 2 tools support streaming for large snapshots, or always return token-capped summaries?
5. **Embedding ownership.** If semantic search is a Tier 1 capability, who owns the embedding model — substrate, skill, or a separate service?
6. **Deterministic helper scope.** Which workload helpers deserve server-owned determinism versus staying as skill-only policy?
7. **Skill-to-skill dependency.** Can a `journal` skill depend on a `memory` skill, or must all skills talk to substrates directly?
8. **Policy testability.** What does unit-testing a SKILL.md look like? Fixture-based substrate mock?

---

## 12. Mapping to OIL (reference implementation)

OIL already satisfies much of the substrate side; the main work is clarifying boundaries and making the contract explicit:

| SSPS concern                      | OIL today                                                                 | Refinement needed                                                             |
|-----------------------------------|---------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| Stateful substrate core           | ✅ `GraphIndex`, `SessionCache`, `VaultWatcher`, persisted graph index     | Good fit for MCP                                                              |
| Update concurrency                | ✅ `expected_mtime` on `atomic_append` / `atomic_replace`; `create_note` is create-only | Formalize the update-vs-create contract in the spec                     |
| Freshness on read results         | ⚠️ `get_note_metadata` returns `mtime_ms`, but most read payloads do not carry version/ref metadata consistently | Propagate refs and freshness more consistently                    |
| Auditability                      | ✅ `get_agent_log` exists                                                   | Add a tiny Tier 0 summary view; keep detailed log access in Tier 1            |
| Deterministic aggregators         | ✅ `get_customer_context`, `prepare_crm_prefetch`, `check_vault_health`     | Mark and document them as Tier 2                                              |
| Runtime tool surface              | ✅ `index.ts` wires only retrieve + write + domain modules (13 live tools)  | Use this as the canonical runtime surface                                     |
| Repo / benchmark surface          | ⚠️ benches and legacy modules still describe 22 tools, including inactive `orient` / `composite` flows and hand-maintained schema fixtures | Separate runtime accounting from repo-level accounting |
| Capability manifest               | ❌ implicit via tool list and docs                                          | Add `list_capabilities` if portability/skill gating justifies it              |
| Lazy schema disclosure            | ⚠️ possible as a contract, but not sufficient for prompt savings in current eager clients | Do not count on this as the primary optimization path today                  |
| Structured error taxonomy         | ⚠️ JSON error payloads exist, but codes are ad hoc strings                  | Standardize `CONFLICT`, `NOT_FOUND`, `LIMIT_EXCEEDED`, etc.                   |
| Version identity                  | ⚠️ `package.json` is `0.5.1` while `src/index.ts` reports `0.3.1`           | Make substrate version authoritative before skill version gating              |
| Companion skill                   | ❌ not present                                                              | Build a `memory` skill per §5                                                 |

Suggested tiering for OIL's current runtime surface:

- **Tier 0 (current-client optimized):** `get_health`.
- **Tier 0 (future-compatible, optional):** `list_capabilities`, `describe_tool` once client behavior makes them net-positive.
- **Tier 1:** `search_vault`, `semantic_search`, `query_frontmatter`, `get_note_metadata`, `read_note_section`, `get_related_entities`, `atomic_append`, `atomic_replace`, `create_note`, `get_agent_log`.
- **Tier 2:** `get_customer_context`, `prepare_crm_prefetch`, `check_vault_health`.

This is the balance point for this repository: keep deterministic, state-backed assembly in MCP; keep remember/retrieve policy, summarization, note naming, retry rules, and escalation in the skill.

Concrete examples of the balance:

- OIL should deterministically resolve customer identity, canonical write targets, and domain snapshots.
- Skills should decide whether the workload is "answer a question", "capture a meeting", "prepare CRM context", or "repair a stale note", and choose the right tool/mode accordingly.
- Where possible, extend existing tools with constrained modes or views instead of introducing a separate tool for each workload type.

Minimum viable SSPS on OIL:

1. Canonicalize the live runtime surface and exclude legacy modules from idle-cost accounting.
2. Add a tiny `get_health` core visibility tool and keep `get_agent_log` as detailed Tier 1 observability.
3. Standardize error codes and ref/version fields on read results.
4. Align the advertised server version with the packaged version.
5. Ship a `memory` skill that owns remember/retrieve/compress policy.
6. Add `list_capabilities` and `describe_tool` only if the portability/skill-contract benefit outweighs their current eager-client cost.
7. Prefer workload modes and deterministic helpers on existing tools over proliferating new MCP tools for each nuanced workflow.

---

## 13. Glossary

- **Substrate** — the stateful MCP server that owns indices, caches, and storage access.
- **Policy skill** — the editable, progressively-disclosed skill that encodes *how* to use the substrate.
- **Freshness token** — an opaque version (mtime, ETag, monotonic counter) that guards writes against concurrent edits.
- **Tier 0/1/2** — core / primitive / aggregator classification of substrate tools.
- **Aggregator** — a task-shaped tool that composes primitives server-side to reduce agent reasoning cost.
- **Manifest** — machine-readable declaration of what a substrate provides or a skill requires.

---

*End of spec v0.1. Intended next step: prototype §12's minimum viable SSPS on OIL and a `memory` skill, measure idle/per-task context cost, and iterate.*