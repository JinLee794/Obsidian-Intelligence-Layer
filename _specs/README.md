# Obsidian Intelligence Layer (OIL) — Spec v0.2

> Knowledge Layer for AI Agent Workflows · Draft for Review · March 2026

> [!IMPORTANT]
> **Historical design record — not a description of shipped behaviour.** Documents 1–10
> live in [`_archive/`](./_archive/) and predate implementation; several proposals were
> revised or dropped during the build. Most notably, **meaning-based retrieval was never
> shipped.** A tool *named* `semantic_search` did exist from v0.5.2 through v0.5.5, but it
> ran fuzzy title matching plus a substring scan — the name was a misnomer, never
> embeddings. A real embedding tier was prototyped in 2026-08, measured, and removed in
> favour of an in-tree BM25 ranker plus graph traversal; the tool itself was folded into
> `search_vault`. Treat the root [`README.md`](../README.md) as the only authoritative
> description of the current tool surface and capabilities.

OIL transforms a personal Obsidian vault from passive file storage into an active, queryable knowledge layer — the persistent memory substrate that bridges AI agent workflows across CRM, M365, and other MCP-connected systems. OIL owns the vault; the copilot orchestrates across MCPs.

---

## Documents

| # | Section | Summary |
|---|---------|---------|
| 1 | [Executive Summary](./_archive/01-executive-summary.md) | What OIL is, why it exists, core design philosophy |
| 2 | [Problem Statement](./_archive/02-problem-statement.md) | What the existing MCP gets wrong, what we actually need |
| 3 | [Architecture](./_archive/03-architecture.md) | System layers, integration map, vault schema, vault protocol phases |
| 4 | [Core Capabilities](./_archive/04-core-capabilities.md) | Graph index, semantic search *(never shipped)*, session cache, tiered write gate |
| 5 | [Tool Surface](./_archive/05-tool-surface.md) | Full tool reference: orient, retrieve, and write tools (tiered) |
| 6 | [Configuration](./_archive/06-configuration.md) | `oil.config.yaml` schema + skills architecture decision |
| 7 | [Integration Flows](./_archive/07-integration-flows.md) | Pre-call brief, post-call notes, pipeline review, onboarding — worked examples |
| 8 | [Implementation Roadmap](./_archive/08-roadmap.md) | 4-phase build plan + fork strategy for bitbonsai/mcp-obsidian |
| 9 | [Open Questions](./_archive/09-open-questions.md) | Resolved decisions + remaining open questions |
| 10 | [Success Criteria](./_archive/10-success-criteria.md) | How we know it's working |

---

## Key Principles

- **Knowledge layer, not orchestrator** — OIL owns the vault; the copilot decides when and how to use it alongside CRM and M365 MCPs
- **Reads are autonomous** — the agent can orient, retrieve, and resolve IDs without human approval
- **Writes are tiered** — auto-confirmed for low-risk appends (agent insights, Connect hooks); gated with diff review for creates and overwrites
- **The vault stays native** — all files remain valid Obsidian markdown; no proprietary schemas, no lock-in
- **Vault-first ID resolution** — customer files store CRM GUIDs and TPIDs, eliminating discovery queries against external systems
- **People are first-class** — person→customer resolution bridges the gap between M365 identities and vault knowledge
