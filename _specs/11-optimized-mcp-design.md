# OIL Context Optimization Spec (v2)

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

1. **`semantic_search(query, limit=5)`**
   * **Optimization:** Leverages a standard external embedding API (e.g., OpenAI) or simple native OS search (ripgrep) rather than requiring a complex local daemon or a heavy 50MB runtime download. 
   * **Returns:** Only the semantic match snippets (Context strings), not the entire file, keeping token counts strictly bounded.

2. **`query_frontmatter(key, value_fragment)`**
   * **Optimization:** Runs a straightforward fast native regex/grep scan across the vault rather than attempting to maintain an over-engineered SQLite DB or secondary flat-file cache. Modern Node can handle thousands of text files in milliseconds.
   * **Returns:** Max 20 file paths matching the query.

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
* **Graph Index:** Removed entirely. The system uses basic file search rather than pretending to be a complex graph-database. Hops are confusing for LLMs.
* **Semantic Search:** Returns context snippets, powered by an external API or simple OS text search, avoiding local daemons.
* **Frontmatter Queries:** Performed natively with fast regex/grep; no caching DB or sqlite needed.
* **Writes:** Require an `mtime` check to prevent race conditions.
* **Orchestration:** Completely removed. No more phases or pipelines.