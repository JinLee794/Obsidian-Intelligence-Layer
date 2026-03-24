# 1. Executive Summary

This specification defines an enhanced Obsidian MCP server — the **Obsidian Intelligence Layer (OIL)** — that transforms a personal Obsidian vault from passive file storage into an active, queryable memory substrate for AI sales agents.

The system serves as a **smart knowledge layer** within your existing MCP stack (WorkIQ for M365, Dynamics/MSX for sales data, and copilot-level orchestration via skills and instructions). OIL does not orchestrate cross-MCP calls itself — it provides graph-aware reads, semantic search, structured writes, and entity resolution that make copilot-level orchestration across MCPs effective. The vault is the durable, human-readable record of every agent interaction, account context, and decision thread — the connective tissue between tools.

---

## Design Philosophy

> **Reads are autonomous. Writes are gated. The vault is not a dump.**

| Principle | Detail |
|-----------|--------|
| **Autonomous reads** | The agent can orient itself, retrieve context, and correlate data without human approval |
| **Tiered write gate** | High-impact writes (new notes, content overwrites) require human confirmation via structured diff. Low-ceremony writes (agent insights, Connect hooks, ID writeback) are auto-confirmed as append-only operations |
| **Vault as graph** | The vault is a living graph of account knowledge — the agent must treat it as such, not as a flat file store |
| **Knowledge layer, not orchestrator** | OIL provides smart vault access; the copilot orchestrates across MCPs (CRM, M365, vault) |
| **Moldable** | Users define their own vault conventions, folder schemas, and agent skills via config, not code |

---

## What this is not

- Not a replacement for your CRM — Dynamics/MSX remains the system of record for deal data
- Not a replacement for Obsidian — the vault stays fully usable by humans in Obsidian at all times
- Not a locked-in proprietary system — every file is standard markdown with YAML frontmatter
- Not an orchestration hub — OIL does not call CRM or M365 MCPs internally; it provides the knowledge substrate that makes copilot-level cross-MCP orchestration effective

---

*Next: [Problem Statement →](./02-problem-statement.md)*
