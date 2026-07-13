# OIL Context Optimization Spec (v2)

> **Implementation note (2026-07-11):** The read/write boundary remains authoritative. The search, graph, discovery, freshness, and response contracts in this document are superseded by [13-knowledge-node-catalog.md](./13-knowledge-node-catalog.md).

## 1. Problem Statement
The current OIL design attempts to handle complex state, multi-step writes, and deep correlation on the MCP server side. This creates severe race conditions, scaling bottlenecks, and replicates orchestration logic that the LLM (Copilot) already handles naturally.

However, moving *everything* to the LLM side results in excessive token burn and limits the vault size. 

The goal of this redesign is to strike a balance: **The MCP server provides highly optimized, token-efficient *Read* and *Search* mechanisms, while leaving all *Write* and *Orchestration* decisions to the LLM.**

## 2. Refined Principles
1. **Reads are optimized; Writes are atomic.** The MCP should aggregate data efficiently, but write operations should do one thing at a time with strict concurrency checks.
2. **Context Budgets Matter.** Graph traversals and searches must be paginated and capped.
3. **No Stateful "Phases."** We remove predefined pipelines (`VAULT-PREFETCH`, `VAULT-PROMOTE`).

## 3. The Optimized Tool Surface

Instead of the sprawling, open-ended tools proposed in v1, OIL v2 will expose specific, context-optimized queries.

### A. Context-Optimized Read Tools
These tools are designed to return dense, token-efficient summaries rather than dumping raw Markdown files into the LLM context.

1. **`get_note_metadata(path)`**
   * **Purpose:** Allows the LLM to "peek" at a note before committing to reading its full contents.
   * **Returns:** Frontmatter, creation/modification dates, word count, and a list of heading strings.

2. **`read_note_section(path, heading)`**
   * **Purpose:** The most token-efficient read operation. Instead of retrieving a 5,000-word daily note, the LLM requests just the `## CRM Updates` section.
   * **Returns:** Only the text under the specified heading.

### B. Scalable Search Tools

1. **`search_vault(query, limit=5)`**
   * **Optimization:** Uses the generation-aware in-memory catalog across paths, titles, aliases, arbitrary frontmatter, tags, descriptions, headings, full-body chunks, links, and fuzzy candidates.
   * **Returns:** Ranked snippets, match explanations, freshness metadata, and bounded continuation — never full files.

2. **`query_frontmatter(key, value_fragment|operator/value)`**
   * **Optimization:** Uses the catalog's persistent observed schema and typed inverted index. Existing fragment calls remain compatible.
   * **Returns:** Max 50 refs per page with explicit unknown-field, type-mismatch, truncation, and cursor outcomes.

3. **`inspect_catalog(view)`**
   * **Optimization:** Provides bounded virtual folder, field, type, tag, recency, readiness, and warning indexes for broad orientation.
   * **Returns:** Max 50 compact entries per page.

### C. Safe Write Tools

1. **`atomic_append(path, heading, content, expected_mtime)`**
   * **Purpose:** Safely appends data to a specific section.
   * **Locking:** Fails immediately if `expected_mtime` does not match the file's current state on disk, preventing the "Stale Diff" race condition.

2. **`atomic_replace(path, content, expected_mtime)`**
   * **Purpose:** Safely overwrites an entire file.

## 4. Eliminating the "Gated Write" Concept
The original OIL spec suggested generating a diff, waiting for user approval, and then applying it.
**The Fix:**
OIL will no longer manage human-in-the-loop approvals. If a workflow requires user approval, that is handled by the Copilot UI (e.g., asking the user "Should I write this?"). The MCP server simply receives the command and executes the atomic write.

## 5. Handling External IDs (CRM Bridge)
Instead of silent failures when CRM IDs rot:
* OIL will no longer perform CRM queries directly. 
* It simply surfaces the IDs (e.g., `dynamics_id: 12345`) to Copilot. 
* Copilot takes that ID and calls a separate CRM MCP itself. If the CRM returns a 404, Copilot handles the error and asks the user for clarification.

## 6. Summary of Architectural Shifts
* **Knowledge Catalog:** A compatibility-first in-memory catalog owns frontmatter, full-content chunks, links, warnings, and generation-aware persistence. It is not a graph database or external service.
* **Unified Search:** Returns explainable context snippets without claiming embedding-backed semantics.
* **Frontmatter Queries:** Use an observed schema and typed inverted index; no SQLite or external vector service is required at current scale.
* **Writes:** Require an `mtime` check to prevent race conditions.
* **Orchestration:** Completely removed. No more phases or pipelines.