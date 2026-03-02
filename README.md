# Obsidian Intelligence Layer (OIL)

An [MCP](https://modelcontextprotocol.io/) server that turns an Obsidian vault into a semantic knowledge graph for AI agents. Instead of raw file reads and writes, OIL gives agents pre-indexed search, context-aware composites, and gated writes — so the LLM spends tokens on reasoning, not data assembly.

**Node 20+** · **TypeScript** · **ES modules** · **MIT**

---

## Table of Contents

- [What This Is (and Isn't)](#what-this-is-and-isnt)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Tools Reference](#tools-reference)
- [Configuration](#configuration)
- [Development](#development)
- [Architecture Deep Dive](#architecture-deep-dive)
- [FAQ](#faq)

---

## What This Is (and Isn't)

**OIL is not a REST API wrapper around Obsidian.** It's an MCP server — meaning it speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio, designed for AI agents (like GitHub Copilot, Claude, etc.) to call as a tool provider.

| Thin REST Wrapper | OIL |
|---|---|
| `GET /notes/Customers/Contoso.md` → raw file | `get_customer_context("Contoso")` → assembled context with opportunities, team, action items, meetings |
| Full-vault scan for backlinks | O(1) graph lookup via pre-built index |
| Regex search over files | 3-tier search: lexical → fuzzy → semantic embeddings |
| `PUT /notes/...` — blind overwrite | Two-tier write gate with diffs, confirmation, and audit trail |
| No awareness of other tools | Cross-MCP bridge: shapes output for CRM/M365 tool consumption |

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20**
- An **Obsidian vault** on disk (OIL reads/writes the vault folder directly — Obsidian doesn't need to be running)

### Install and Build

```bash
git clone <repo-url>
cd obsidian-mcp-v2
npm install
npm run build
```

### Run

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault node dist/index.js
```

The server communicates over **stdio** (stdin/stdout). You don't hit it with curl — an MCP client connects to it.

### Connect to VS Code (Copilot / Claude)

**Option A: Per-workspace** — add to `.vscode/mcp.json` in any workspace:

```json
{
  "servers": {
    "oil": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/obsidian-mcp-v2",
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/obsidian/vault"
      }
    }
  }
}
```

**Option B: Global (all workspaces)** — add to `~/.copilot/mcp-config.json` so OIL is available across all Copilot CLI sessions and workspaces:

```json
{
  "mcpServers": {
    "oil": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp-v2/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/obsidian/vault"
      }
    }
  }
}
```

> **Note:** Use absolute paths in `args` since there's no workspace-relative root. The top-level key is `mcpServers` (not `servers` like the workspace config).

Once configured, the agent can call any of OIL's 22 tools by name.

---

## Project Structure

```
src/
├── index.ts          # Entry point — startup sequence, tool registration, shutdown
├── types.ts          # Shared TypeScript types (NoteRef, CustomerContext, GraphNode, etc.)
├── config.ts         # Reads oil.config.yaml from vault root; merges with defaults
├── vault.ts          # Filesystem read layer — note parsing, frontmatter, sections, wikilinks
├── graph.ts          # GraphIndex — bidirectional link graph, tag index, N-hop traversal
├── cache.ts          # SessionCache — LRU note cache (200 notes, 5min TTL), pending writes queue
├── embeddings.ts     # EmbeddingIndex — local 384-dim embeddings (lazy-loaded, persisted)
├── watcher.ts        # VaultWatcher — chokidar file watcher, invalidates caches on change
├── gate.ts           # Write gate engine — tiered confirmation, diff generation, audit logging
├── query.ts          # Frontmatter predicate query engine (where/and/or, ordering, limits)
├── search.ts         # 3-tier search: lexical → fuzzy (fuse.js) → semantic (embeddings)
├── hygiene.ts        # Vault freshness scanning, staleness detection, health checks
├── correlate.ts      # Entity matching — cross-references external entities with vault notes
└── tools/
    ├── orient.ts     # 5 tools — "Where am I?" (vault map, customer context, person lookup)
    ├── retrieve.ts   # 3 tools — Search, query, similarity
    ├── write.ts      # 9 tools — Gated writes (patch, create, tag, meeting notes, etc.)
    └── composite.ts  # 5 tools — Cross-MCP workflows (CRM prefetch, correlation, drift, hygiene)
```

### What Each Layer Does

| Layer | Role | Junior Dev Analogy |
|---|---|---|
| **vault.ts** | Reads markdown files from disk, parses frontmatter + sections | "The filesystem driver" |
| **graph.ts** | Builds a link graph from wikilinks across all notes | "The database index" |
| **cache.ts** | Avoids re-reading disk in the same conversation | "The L1 cache" |
| **search.ts** | Finds notes by content (not just filename) | "The search engine" |
| **gate.ts** | Prevents the agent from blindly overwriting files | "The code review step" |
| **tools/*.ts** | Exposes everything above as named MCP tools | "The API controllers" |

---

## How It Works

### Startup Sequence

When `node dist/index.js` runs:

```
1. Read OBSIDIAN_VAULT_PATH env var
2. Load oil.config.yaml (or use defaults)
3. Load graph index from _oil-graph.json (or full-build if first run)
4. Start incremental graph rebuild in background
5. Initialize session cache (in-memory)
6. Create embedding index (lazy — won't download model until first semantic search)
7. Start chokidar file watcher (invalidates caches on vault changes)
8. Register all 22 MCP tools
9. Connect stdio transport → server ready
```

### Request Flow (Example: Agent asks "What's the context for Contoso?")

```
Agent calls: get_customer_context({ customer: "Contoso" })
      │
      ▼
  orient.ts handler
      │
      ├─ cache.getNote("Customers/Contoso.md")     ← cache hit? return immediately
      │   └─ cache miss → vault.readNote()          ← parse file from disk, cache result
      │
      ├─ vault.parseOpportunities(content)          ← extract ## Opportunities section → [{name, guid}]
      ├─ vault.parseTeam(content)                   ← extract ## Team section → [{name, role}]
      ├─ vault.parseActionItems(content)            ← extract checkbox items → [{text, assignee, done}]
      │
      ├─ graph.getBacklinks("Customers/Contoso.md") ← O(1) from pre-built index
      │   └─ filter by People/ folder → linkedPeople
      │   └─ filter by Meetings/ folder → recentMeetings
      │
      └─ Return JSON: { frontmatter, opportunities, team, agentInsights, meetings, ... }
```

The agent gets **one structured response** instead of making 6 separate calls and stitching the data itself.

### Write Safety

When the agent wants to modify a note:

```
Agent calls: update_customer_file({ customer: "Contoso", section: "Notes", content: "New insight" })
      │
      ▼
  gate.ts checks: Is "Notes" in autoConfirmedSections?
      │
      ├─ YES (e.g., "Agent Insights") → Execute immediately, log to _agent-log/
      │
      └─ NO → Generate diff → Queue as pending write → Return diff to agent
               │
               Agent shows diff to user → User confirms
               │
               Agent calls: manage_pending_writes({ action: "confirm", write_id: "abc-123" })
               │
               └─ Execute write, log to _agent-log/
```

---

## Tools Reference

### Orient (5 tools) — "Where am I?"

All read-only. No confirmation needed.

| Tool | What It Does |
|---|---|
| `get_vault_context` | High-level vault map — folder tree, note count, top tags, most-linked notes. **Call this first in any new session.** |
| `get_customer_context` | Full assembled context for a customer — opportunities, team, meetings, action items, insights. The workhorse tool. |
| `get_person_context` | Person profile — customer associations, org type, company, linked notes. |
| `query_graph` | Graph traversal — backlinks, forward links, or N-hop neighborhood with tag/folder filters. |
| `resolve_people_to_customers` | Batch-resolves person names to customer associations. Used for WorkIQ entity resolution. |

### Retrieve (3 tools) — "Find me something"

Read-only. Supports filtering and ranking.

| Tool | What It Does |
|---|---|
| `search_vault` | Unified search across lexical, fuzzy (fuse.js), and semantic tiers. Ranked results with scores. |
| `query_notes` | SQL-like frontmatter query — `where`, `and`, `or`, `order_by`, `limit`. |
| `find_similar_notes` | Similarity by tags or semantic embeddings — finds comparable customers, patterns, risks. |

### Write (9 tools) — "Change something"

All writes go through the gate engine. Some are auto-confirmed (safe operations), others require human review.

| Tool | Gate | What It Does |
|---|---|---|
| `patch_note` | Auto / Gated | Append/prepend to a heading section. Auto-confirmed for "Agent Insights" and "Connect Hooks"; gated for others. |
| `capture_connect_hook` | Auto | Appends a Connect evidence entry to customer file + backup. |
| `log_agent_action` | Auto | Writes to `_agent-log/YYYY-MM-DD.md`. Audit trail only. |
| `draft_meeting_note` | Gated | Generates a meeting note from template. Returns diff before creation. |
| `update_customer_file` | Gated | Proposes frontmatter or section changes to a customer file. |
| `create_customer_file` | Gated | Scaffolds a new customer file for onboarding. |
| `write_note` | Gated | Low-level note write. Always gated. |
| `apply_tags` | Gated | Batch tag add/remove across multiple notes. Shows batch diff. |
| `manage_pending_writes` | — | List, confirm, or reject queued writes. |

### Composite (5 tools) — "Do a multi-step workflow"

These bundle sequences that would otherwise require multiple tool calls:

| Tool | What It Does |
|---|---|
| `prepare_crm_prefetch` | Extracts opportunity GUIDs, TPIDs, account IDs from vault and returns them with pre-built OData filter strings — ready to paste into `crm_query`. |
| `correlate_with_vault` | Takes external entities (people, meetings from M365) and batch-resolves them against vault notes with confidence scoring. |
| `promote_findings` | Batch-promotes validated findings to customer files. Auto-confirms for designated sections; gated for others. |
| `check_vault_health` | Surfaces stale insights, missing IDs, incomplete sections, orphaned notes. Returns both structured report and English issue list. |
| `get_drift_report` | Compares vault snapshots against expected CRM state to detect stale data. |

---

## Configuration

Create `oil.config.yaml` in your vault root. If it doesn't exist, sensible defaults are used.

```yaml
# Folder mappings (where things live in your vault)
schema:
  customersRoot: "Customers/"
  peopleRoot: "People/"
  meetingsRoot: "Meetings/"
  projectsRoot: "Projects/"
  agentLog: "_agent-log/"

# Frontmatter field names (match your vault conventions)
frontmatterSchema:
  customerField: "customer"
  tagsField: "tags"
  tpidField: "tpid"
  accountidField: "accountid"

# Search configuration
search:
  defaultTier: "fuzzy"              # lexical | fuzzy | semantic
  semanticModel: "local"            # local embeddings (no API calls)
  semanticIndexFile: "_oil-index.json"
  graphIndexFile: "_oil-graph.json"
  backgroundIndexThresholdMs: 3000

# Write safety
writeGate:
  diffFormat: "markdown"
  logAllWrites: true
  batchDiffMaxNotes: 50
  autoConfirmedSections:             # Sections that skip confirmation
    - "Agent Insights"
    - "Connect Hooks"
  autoConfirmedOperations:           # Operations that skip confirmation
    - "log_agent_action"
    - "capture_connect_hook"
    - "patch_note_designated"
```

See [_specs/06-configuration.md](./_specs/06-configuration.md) for the full schema reference.

---

## Development

### Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (recompiles on change)
npm run lint         # Type-check without emitting
npm start            # Run the server (needs OBSIDIAN_VAULT_PATH)
```

### Build Requirements

- Node.js ≥ 20
- TypeScript 5.7+
- ES2022 target, Node16 module resolution

### Adding a New Tool

1. Decide which category it belongs to: `orient` (read-only context), `retrieve` (search/query), `write` (modifies vault), or `composite` (multi-step workflow).

2. Open the corresponding file in `src/tools/`.

3. Add a `server.registerTool()` call:

```typescript
server.registerTool(
  "my_tool_name",
  {
    // Description is a ROUTING SIGNAL for the LLM — tell it WHEN to call this,
    // not just what it does.
    description: "Does X when the agent needs Y. Primary tool for [workflow phase].",
    inputSchema: {
      param_name: z.string().describe("What this param means"),
    },
  },
  async ({ param_name }) => {
    // Implementation
    const result = { /* ... */ };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);
```

4. If the tool writes to the vault, use the gate engine from `gate.ts`:
   - Call `generateDiff()` to create a reviewable diff
   - Call `queueGatedWrite()` to queue it for confirmation
   - Return the diff — don't execute the write directly

5. Rebuild: `npm run build`

### Key Conventions

- **Zod v4**: `z.record()` needs two args: `z.record(z.string(), z.unknown())`, not one.
- **ES modules**: All imports use `.js` extensions (`import { foo } from "./bar.js"`).
- **Logging**: Use `console.error()` (not `console.log`) — stdout is reserved for MCP protocol messages.
- **Tool descriptions**: Write them as routing instructions, not documentation. Answer "When should the agent call this?" not just "What does it do?"

---

## Architecture Deep Dive

### Index Stack

OIL maintains three persistent/cached indices so that most tool calls resolve in milliseconds:

```
┌─────────────────────────────────────────────────────┐
│  Tier 0: Graph Index (persistent)                   │
│  _oil-graph.json — wikilinks, backlinks, tags       │
│  Rebuilt incrementally on startup (mtime-based)     │
│  Backlink lookup: O(1)                              │
├─────────────────────────────────────────────────────┤
│  Tier 1: Fuzzy Search Index (in-memory, lazy)       │
│  fuse.js — built on first search, invalidated on    │
│  file change. Second search: ~10ms                  │
├─────────────────────────────────────────────────────┤
│  Tier 2: Session Cache (in-memory, per-connection)  │
│  LRU, 200 notes, 5min TTL — avoids re-reading      │
│  disk across multi-turn conversations               │
├─────────────────────────────────────────────────────┤
│  Tier 3: Embedding Index (optional, persistent)     │
│  _oil-index.json — 384-dim MiniLM-L6-v2            │
│  Lazy-loaded on first semantic search               │
│  Runs locally — no external API calls               │
└─────────────────────────────────────────────────────┘
```

### File Watcher

`chokidar` watches the vault for changes. When a file changes:

1. Graph index re-indexes that node (rebuild outlinks, recompute affected backlinks)
2. Session cache invalidates the note entry
3. Search index is marked dirty (rebuilt on next search call)
4. Embedding index queues the note for re-embedding

### Response Shaping

Every tool response is designed to minimize tokens while maximizing usability:

- **Excerpts, not full content**: `NoteRef` includes title + tags + first ~200 chars, not the full note
- **Pre-built filters**: `prepare_crm_prefetch` returns OData filter strings ready to paste into `crm_query`
- **Scored rankings**: Search results include match scores and tier labels
- **Issue lists**: `check_vault_health` returns both structured data and a plain English issue list for reasoning
- **Compact batch diffs**: Operations on >5 notes show folder-grouped summaries instead of per-file diffs

---

## FAQ

### Why MCP instead of a REST API?

MCP is the protocol that AI agents (Copilot, Claude, etc.) use to discover and call tools. A REST API would require the agent to know your endpoint URL, handle auth, and parse responses — MCP handles all of that via the client integration.

### Does Obsidian need to be running?

No. OIL reads/writes the vault folder directly on disk. Obsidian will pick up changes when it's next opened (or immediately if it's running, since it watches the folder too).

### What's the embedding model? Does it need an API key?

OIL uses `Xenova/all-MiniLM-L6-v2` locally via `@xenova/transformers`. No API key needed. The model is downloaded on first semantic search (~80MB) and cached.

### What happens if I don't create `oil.config.yaml`?

All defaults are used. Customers in `Customers/`, people in `People/`, meetings in `Meetings/`, etc. See the [Configuration](#configuration) section for defaults.

### How do I see what the agent did to my vault?

Check `_agent-log/` in your vault root. Every write (auto-confirmed or gated) is logged with timestamp, tool name, path, and detail.

### Why not use a generic Obsidian MCP server?

There are solid general-purpose Obsidian MCP servers out there — they expose clean CRUD operations (read, write, search, list) and work well for basic vault interaction. OIL takes a different approach: it's a **domain-specific** server built for account-team workflows, and the trade-offs are measurable.

We ran a benchmark suite (`npm run bench`) comparing OIL against a generic CRUD-style MCP interface operating on the same vault:

| Dimension | Generic CRUD | OIL (Domain-Specific) | Why It Matters |
|---|---|---|---|
| **Schema overhead** | ~612 tokens/turn | ~1,036 tokens/turn (1.7×) | OIL's richer tool surface costs more context per turn |
| **MCP round-trips** (4 workflows) | 20+ calls | 6 calls (3.3× fewer) | Composite tools collapse multi-step sequences into single calls |
| **Search latency** (warm) | ~1.3 ms | ~0.01 ms (lexical), ~0.3 ms (fuzzy) | Pre-built graph index vs. per-call file walks |
| **Cold start** | ~1.5 ms | ~14 ms | OIL builds its graph on startup — amortizes after 1 query |
| **Search precision** | 0.60 | 1.00 (lexical) | Structured index avoids false positives |
| **Search recall** | 0.77 | 0.43 (lexical) → 0.80 (graph-augmented) | Graph traversal recovers recall that pure search misses |
| **Write safety** | Direct writes | Diff → confirm → execute → audit log | ~3 extra calls and ~100–200 tokens per gated write |

The takeaway isn't that generic servers are bad — they're simpler, lighter on startup, and perfectly fine for personal vaults. The domain-specific approach pays off when workflows are repetitive and multi-step (customer context assembly, CRM prefetch, cross-entity resolution), because those extra schema tokens are recouped many times over in saved round-trips and more precise retrieval.

The full benchmark suite lives in `bench/` — run `npm run bench` to reproduce.

### Can I undo agent writes?

Gated writes require explicit confirmation before execution. For auto-confirmed writes (Agent Insights, Connect Hooks), check `_agent-log/` and use Obsidian's file recovery or git to roll back.
