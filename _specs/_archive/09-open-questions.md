# 9. Open Questions & Decisions Needed

Status of questions from v0.1 — some resolved by the current workflow implementation, others still open.

---

## Resolved

### Tiered write gate — ✅ Decided

The v0.1 spec proposed "all writes gated." The current workflow proves a tiered model works better:

- **Tier 1 (auto-confirmed):** Append-only to designated sections (Agent Insights, Connect Hooks), agent log, ID writeback. No human friction for low-risk, high-frequency operations.
- **Tier 2 (gated):** New file creation, content overwrites, major frontmatter changes, batch tag operations. Full diff + confirm.

This is now the spec baseline (§4.4, §5.3).

---

### Vault schema convention — ✅ Decided

Flat `Customers/{Name}.md` model, not nested `Accounts/{Name}/` subfolders. Matches the current production vault structure. Each customer is a single rich markdown file with structured sections (Opportunities, Team, Agent Insights, Connect Hooks), not a folder tree.

Other entity types are also flat folders: `People/`, `Meetings/`, `Projects/`, `Weekly/`.

---

### Single-user vs multi-user — ✅ Decided (single-user for v1)

The current deployment is single-user. OIL v1 targets single-user vaults. Multi-user considerations deferred.

---

### Skills at MCP vs copilot level — ✅ Decided (copilot level)

Multi-step workflows that span OIL + CRM + M365 live at the copilot instruction layer (`.github/skills/`), not as OIL server-side skills. OIL provides atomic tools; the copilot sequences them. See §6 rationale.

---

## Still Open

### Semantic search model hosting

| Option | Latency | Cost | Privacy | Setup |
|--------|---------|------|---------|-------|
| Local (`@xenova/transformers`) | ~200ms | Free | Data never leaves machine | Node.js, ~50MB model download |
| Azure OpenAI Embeddings | ~50ms | Per-token | Data sent to Azure | API key per user |
| OpenAI Embeddings | ~50ms | Per-token | Data sent to OpenAI | API key per user |

> **Recommendation:** Local for v1 — consistent with the "vault stays yours" principle. Azure OpenAI as config option for teams where latency matters more than cost.

---

### Diff review UX for bulk writes

When a batch write affects 10+ notes, markdown diffs can overwhelm chat.

**Options:**
- **Compact summary mode:** "Will update 8 customer files. [Show details]"
- **Batch approve with exceptions:** "Confirm all except Fabrikam"

> **Recommendation:** Compact summary for batches > 5 notes. Implement in Phase 4.

---

### People resolution confidence thresholds

`resolve_people_to_customers` returns confidence levels (exact/fuzzy/unresolved). What thresholds should the copilot use for automated decisions vs asking the user?

**Options:**
- Exact match → auto-use; fuzzy → ask user; unresolved → skip
- Configurable thresholds in `oil.config.yaml`

> **Recommendation:** Start with exact=auto, fuzzy=ask, unresolved=skip. Revisit after observing real-world resolution rates.

---

### Graph index performance at scale

The current spec assumes the graph index is rebuilt at startup. For vaults with 1000+ notes, this could add noticeable startup latency.

**Options:**
- Incremental index (persist to disk, rebuild only changed files)
- Background index (serve requests immediately, index in background)

> **Recommendation:** Persist index to `_oil-index.json`, rebuild incrementally. Background indexing if startup exceeds 3 seconds.

---

### Vault freshness metadata

How should OIL track when vault data was last validated against CRM? Options:
- Frontmatter field (`last_validated: 2026-03-01`) on customer files
- Separate metadata file (`_oil-freshness.json`)
- In-memory only (session-scoped)

> **Decision needed** before VAULT-HYGIENE implementation in Phase 3.

---

*Previous: [Roadmap ←](./08-roadmap.md) · Next: [Success Criteria →](./10-success-criteria.md)*
