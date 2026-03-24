# 8. Implementation Roadmap

## 8.1 Phase Plan

### Phase 1 — Orient & Read (Weeks 1–2)

**Goal:** Agent can orient itself and retrieve full customer context autonomously from vault data.

Deliverables:
- Graph index built at startup (wikilink parser, backlink index, tag index)
- `get_vault_context` — vault shape, top tags, most-linked notes
- `get_customer_context` — assembles from vault only (flat `Customers/` model)
- `get_person_context` — person file with customer associations
- `get_backlinks` / `get_forward_links`
- `get_related_notes` (N-hop graph traversal)
- Lightweight session cache (file cache + graph traversal cache)
- `oil.config.yaml` parsing — schema mapping, frontmatter field names
- File watcher for incremental index updates
- Vault protocol: VAULT-PREFETCH phase operational

**Done when:** Copilot can call `get_customer_context('Contoso')` and get back opportunity GUIDs, team, open items, and linked people — ready to pass to CRM MCP without discovery queries.

---

### Phase 2 — Query, Write Gate & People (Weeks 3–4)

**Goal:** Full read/write loop in production. Meeting note capture live. People→Customer resolution working.

Deliverables:
- `query_notes` — frontmatter predicate queries
- Fuzzy search tier (`fuse.js` over titles and headings)
- Tiered write gate framework:
  - Tier 1 auto-confirmed: `patch_note` (designated sections), `capture_connect_hook`, `log_agent_action`
  - Tier 2 gated: diff generation, pending write queue, confirm/reject
- `draft_meeting_note` — creates in `Meetings/`, template support
- `update_customer_file` — frontmatter and section updates
- `create_customer_file` — scaffold new customer from CRM data
- `patch_note` — section-level append (VAULT-PROMOTE workhorse)
- `capture_connect_hook` — auto-confirmed Connect evidence capture
- `resolve_people_to_customers` — batch person→customer resolution
- `log_agent_action` (auto-confirmed append to `_agent-log/`)
- `write_note` base tool wrapped in gate
- Audit log structure in `_agent-log/`

**Done when:** User can say "log my call" and have a structured meeting note created with a single confirm, plus auto-confirmed agent insights appended to the customer file.

---

### Phase 3 — Composite Tools & Cross-MCP Support (Weeks 5–6)

**Goal:** Vault shapes external MCP usage. Pre-call briefs fully supported.

Deliverables:
- `get_customer_brief` composite tool (vault context shaped for copilot synthesis)
- `get_open_items` (parses `- [ ]` task syntax across customer-linked notes)
- `find_similar_notes` (tag-based, semantic if available)
- Vault-vs-CRM drift detection helpers (copilot compares vault IDs with live CRM state)
- VAULT-CORRELATE phase: tools return data shaped for copilot to cross-reference
- VAULT-PROMOTE phase: validated findings flow back via `patch_note`
- VAULT-HYGIENE phase: stale data detection, freshness metadata

**Done when:** Pre-call brief flow (§7.1) works end-to-end — copilot calls OIL for vault context, CRM MCP for live state, WorkIQ for M365, and synthesises a coherent briefing.

---

### Phase 4 — Semantic Search & Polish (Weeks 7–8)

**Goal:** Full semantic search. Bulk operations. Production-ready.

Deliverables:
- Semantic search tier (`@xenova/transformers` local embeddings)
- Vector index build + incremental update
- Semantic index stored as `_oil-index.json`
- Batch diff UX for write gate (compact summary for N > 10 notes)
- `apply_tags` bulk operation
- Performance profiling and optimisation

**Done when:** Semantic search returns relevant results across the vault. Batch operations handle 50+ notes cleanly.

---

## 8.2 Fork Strategy — bitbonsai/mcp-obsidian

### Keep unchanged

These are solid and correct — wrap or extend, don't replace:

| What | Why |
|------|-----|
| Path security model | Path traversal protection, extension whitelist, `.obsidian` exclusion |
| Frontmatter parsing (`gray-matter`) | Reliable, battle-tested, handles edge cases correctly |
| Base write tools (`write_note`, `delete_note`, `move_note`, `update_frontmatter`) | Wrap in the confirmation gate rather than rewriting |
| Token-optimised response format | The minified field names (`p`, `t`, `ex`) are a good default |

### Replace

| What | With |
|------|------|
| `search_notes` | `search_vault` with lexical/fuzzy/semantic tiers; lexical as fallback |
| `server.ts` entrypoint | Extended version with startup graph indexing, config loading, session cache init |

### Add (new files)

| File | Responsibility |
|------|---------------|
| `src/graph.ts` | Link index, backlink computation, N-hop traversal, graph statistics |
| `src/cache.ts` | Lightweight session cache — file cache, graph traversal cache, pending writes |
| `src/people.ts` | People→Customer resolution, person context assembly |
| `src/gate.ts` | Tiered write protocol — auto-confirm routing, diff generation, pending queue |
| `src/query.ts` | Frontmatter predicate engine, query_notes implementation |
| `src/customer.ts` | Customer context assembly, customer file CRUD, Connect hook capture |
| `src/embeddings.ts` | Optional semantic search — model loading, vector index, similarity search |

### Startup sequence

```
1. Load oil.config.yaml (or use defaults)
2. Build graph index (parse all .md files for wikilinks, tags, frontmatter)
3. If semantic enabled: load/build vector index
4. Start file watcher for incremental updates
5. Initialise session cache
6. MCP server ready
```

---

*Previous: [Integration Flows ←](./07-integration-flows.md) · Next: [Open Questions →](./09-open-questions.md)*
