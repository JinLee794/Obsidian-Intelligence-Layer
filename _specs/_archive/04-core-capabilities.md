# 4. Core Capabilities

## 4.1 Graph Index

Built at server startup by parsing every `.md` file in the vault.

### What gets indexed

| Component | Detail |
|-----------|--------|
| **Node types** | Notes, folders, tags, frontmatter field values (account IDs, contact names, deal stages) |
| **Edge types** | `[[wikilinks]]` (forward links), backlinks (reverse), tag membership, frontmatter field co-occurrence |
| **Refresh strategy** | File watcher triggers incremental updates; full rebuild on config change or server restart |
| **Storage** | In-memory only — no sidecar files written unless semantic search is enabled |

### Why this matters

The graph index is what allows the agent to answer questions like:
- *"What else is linked to this deal note?"*
- *"Which accounts share the `renewal-risk` tag?"*
- *"What meeting notes reference this contact?"*

Without it, every contextual lookup requires the agent to read multiple files and do the joining itself — burning context and adding latency.

---

## 4.2 Semantic Search (optional, progressive)

OIL supports three search tiers. All three are available simultaneously; the agent (or config) selects the appropriate tier per query.

| Tier | Implementation | Latency | Requires |
|------|---------------|---------|---------|
| **1 — Lexical** | Substring + regex match (existing behaviour) | ~5ms | Nothing |
| **2 — Fuzzy** | `fuse.js` over note titles, headings, and tags | ~20ms | Nothing |
| **3 — Semantic** | Embeddings via `@xenova/transformers` (local) or configured API endpoint; vector index stored as `_oil-index.json` | ~200ms local / ~50ms API | Config opt-in |

**Tier 3 is opt-in.** Enabled via `oil.config.yaml`. The vector index is built lazily on first semantic query and cached. For a fast-growing vault, semantic search is the single highest-leverage improvement over the base MCP — it's what allows "find notes about renewal risk" to surface notes that never use that exact phrase.

---

## 4.3 Session Context (lightweight caching)

OIL maintains an optional, lightweight session cache scoped to the MCP connection lifetime. This is **not** a full working memory system — the copilot’s own context window and session memory (`/memories/session/`) are the primary session state. OIL’s session cache avoids redundant file reads within a single conversation.

### Cache fields

```typescript
interface SessionCache {
  recently_accessed: string[];       // ordered list of note paths read this session
  graph_traversal_cache: Map<string, NoteRef[]>;  // cached graph query results
  pending_writes: PendingWrite[];    // queue of gated write ops awaiting confirmation
}
```

### How the agent uses it

When the copilot reads a note via OIL, the result is cached for the session. Subsequent requests for the same note return the cached version (unless the file has been modified on disk). Graph traversals (backlinks, forward links, N-hop) are similarly cached. This reduces latency in multi-turn flows without requiring the copilot to manage vault-level caching itself.

> **Design note:** The original spec envisioned a richer `SessionContext` with `working_set`, `active_account`, and `correlation_cache`. In practice, the copilot already maintains this state at its own layer. OIL’s session scope is intentionally narrow — file and graph caching only.

---

## 4.4 Confirmation Gate (tiered write protocol)

Write operations follow a **tiered** protocol. The tier determines whether human confirmation is required.

### Tier 1 — Auto-confirmed (low-ceremony appends)

These writes execute immediately without surfacing a diff. They are **append-only** operations to designated sections and never overwrite existing content.

| Operation | Target | Rationale |
|-----------|--------|----------|
| Append Agent Insight | `Customers/{Name}.md` § `## Agent Insights` | Validated findings at end of workflow |
| Append Connect Hook | `Customers/{Name}.md` § `## Connect Hooks` | Evidence capture per schema |
| ID writeback | `Customers/{Name}.md` § `## Opportunities` / frontmatter | Writing back MSX identifiers discovered during CRM workflow |
| Agent log | `_agent-log/YYYY-MM-DD.md` | Audit trail — never touches user notes |

All auto-confirmed writes are logged to `_agent-log/` for auditability.

### Tier 2 — Gated (human confirmation required)

These writes surface a structured diff and require explicit `confirm` before execution.

| Operation | Why gated |
|-----------|----------|
| Create new note | New file in the vault |
| Overwrite/replace content | Destructive to existing content |
| Major frontmatter changes | Could affect queries and workflows |
| Batch tag operations | Affects multiple notes at once |
| Section content edits (non-append) | Modifies existing human-written content |

### Phase 1 — PLAN (gated writes only)

Agent calls any gated write tool. OIL generates a structured diff showing exactly what will change. No mutation occurs.

```markdown
## Proposed Write — draft_meeting_note

**Action:** Create new note
**Path:** `Meetings/2026-03-01 - Contoso Renewal Discussion.md`
**Frontmatter to be written:**
  - date: 2026-03-01
  - customer: Contoso
  - tags: [meeting, renewal]
  - action_owners: [Alex Chen, Sarah Okafor]

**Content preview:**
> # Renewal Discussion — Contoso
> Sarah confirmed budget is approved for renewal but flagged concerns about...

**Side effects:**
  - `Customers/Contoso.md` § `## Agent Insights` ← append: meeting summary (auto-confirmed)

Reply **confirm** to execute, or describe changes you want made.
```

### Phase 2 — CONFIRM

Human reviews the diff in chat. Explicit `confirm` triggers execution. Any other response cancels or prompts revision.

### Audit trail

Every write (both auto-confirmed and gated) is logged to `_agent-log/YYYY-MM-DD.md` with:
- Timestamp
- Write tier (auto / gated)
- The operation performed
- For gated writes: the full diff that was approved and the human's confirmation message

### Tier configuration

The tier assignment is configurable in `oil.config.yaml`. Users who want stricter control can promote auto-confirmed operations to gated. See [Configuration](./06-configuration.md).

---

*Previous: [Architecture ←](./03-architecture.md) · Next: [Tool Surface →](./05-tool-surface.md)*
