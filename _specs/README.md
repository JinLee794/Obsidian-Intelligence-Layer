# Obsidian Intelligence Layer (OIL) — Specifications

> Knowledge Layer for AI Agent Workflows · Drafts for Review

OIL transforms a personal Obsidian vault from passive file storage into an active, queryable knowledge layer — the persistent memory substrate that bridges AI agent workflows across CRM, M365, and other MCP-connected systems. OIL owns the vault; the copilot orchestrates across MCPs.

---

## Active Documents

| # | Section | Summary |
| --- | --- | --- |
| 11 | [Optimized MCP Design](./11-optimized-mcp-design.md) | Read-optimized, atomic-write MCP design and reduced tool surface |
| 12 | [Agentic Memory Architecture](./12-context-optimization.md) | Stateful substrate + policy skill contract, capability tiers, and context budgets |
| 13 | [Knowledge Node Catalog](./13-knowledge-node-catalog.md) | OKF-inspired, compatibility-first catalog, frontmatter retrieval, discovery, freshness, and eval contract |

The superseded v0.1 design documents are retained in [`_archive/`](./_archive/) for history.

---

## Key Principles

- **Knowledge layer, not orchestrator** — OIL owns the vault; the copilot decides when and how to use it alongside CRM and M365 MCPs
- **Reads are autonomous** — the agent can orient, retrieve, and resolve IDs without human approval
- **Writes are tiered** — auto-confirmed for low-risk appends (agent insights, Connect hooks); gated with diff review for creates and overwrites
- **The vault stays native** — all files remain valid Obsidian markdown; no proprietary schemas, no lock-in
- **Vault-first ID resolution** — customer files store CRM GUIDs and TPIDs, eliminating discovery queries against external systems
- **People are first-class** — person→customer resolution bridges the gap between M365 identities and vault knowledge
