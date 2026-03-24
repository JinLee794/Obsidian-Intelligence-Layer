# 2. Problem Statement

## 2.1 What the existing MCP gets wrong

The `bitbonsai/mcp-obsidian` server is a well-built filesystem adapter, but it is optimised for human-directed note management, not agentic orchestration. Specific gaps:

**No graph awareness**
Obsidian's value is in `[[wikilinks]]` and backlinks. The MCP has zero tools to traverse or query this graph, so the agent cannot understand which accounts are related, which deals share context, or which meeting note references a given contact.

**Lexical search only**
`search_notes` does substring matching — effectively `grep`. Semantic retrieval, fuzzy matching, and frontmatter predicate queries are all absent. For a sales vault, this means searching for "renewal risk" won't surface a note that says "customer signalled they may not extend."

**No session context**
Every tool call is stateless. In a multi-turn sales agent flow, the agent must re-read the same notes repeatedly because there is no concept of a working set or session memory. This burns context window and adds latency on every turn.

**No vault topology**
The agent has no way to understand the vault's shape — what folders exist, what the canonical note structure is, which notes are most central to the graph. An agent operating blind on a large, fast-growing vault will thrash.

**Atomic CRUD only**
There are no composite tools. Assembling a deal brief, finding all open items for an account, or correlating Dynamics data with vault notes requires 10+ sequential tool calls. This is slow, fragile, and burns context.

**No section-level operations**
The most common write pattern in practice is appending to a specific heading section (e.g. *"append this insight to ## Agent Insights"*). The MCP only offers full-note writes — there is no way to target a specific section without reading the entire note, modifying it, and writing it back.

**No People entity awareness**
People (contacts, stakeholders, internal team members) are central to the vault’s value — they bridge M365 activity to customer accounts. The MCP has no understanding of People as an entity type, no way to resolve a person to their customer associations, and no tools for people→customer graph traversal.

**Frontmatter is a sidecar, not first-class**
`update_frontmatter` and `get_frontmatter` exist, but there is no way to query across frontmatter fields — e.g. "all deals where `stage: Negotiation` and `owner: me`." This is the whole point of structured frontmatter in a sales vault.

---

## 2.2 What we actually need

A layer that operates at the level of **knowledge, not files**. One that understands accounts, deals, contacts, and meetings as first-class entities — and that can correlate vault content with live data from Dynamics and M365 without requiring the agent to do all the joining manually.

The agent should be able to answer *"what's the status of our Contoso relationship?"* with a single autonomous call — not by issuing 12 read operations and synthesising the result itself every time.
Critically, the layer must also serve as a **knowledge bridge** that makes cross-MCP orchestration effective. When the copilot needs to query CRM, it should be able to ask the vault *“what’s the opportunity GUID for Contoso?”* and get a precise ID for injection into CRM filters — instead of running broad CRM discovery queries. When M365 activity arrives, the vault should resolve *“who is Sarah Okafor and which customer is she associated with?”* via People notes — without requiring the copilot to search CRM user tables.
---

## 2.3 Why Obsidian specifically

Despite the gaps above, Obsidian is the right substrate:

- **Human-readable** — reps can open any file and understand it without the agent
- **Graph-native** — `[[wikilinks]]` give us a relationship model for free, if we build the traversal layer
- **Durable** — flat files, no database, no service dependency; the vault survives any agent failure
- **Owned** — not locked to any cloud provider or vendor; the data stays where you put it

The bet is that fixing the MCP layer unlocks the graph — and the graph is what makes Obsidian genuinely better than a CRM notes field as an agent memory store.

---

*Previous: [Executive Summary ←](./01-executive-summary.md) · Next: [Architecture →](./03-architecture.md)*
