# Obsidian Intelligence Layer (OIL)

An [MCP](https://modelcontextprotocol.io/) server that turns an Obsidian vault into a token-efficient knowledge layer for AI agents. Instead of raw file reads and full-note dumps, OIL gives agents pre-indexed search, section-level reads, and atomic writes with concurrency safety — so the LLM spends tokens on reasoning, not data assembly.

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

| Thin REST Wrapper | OIL v2 |
|---|---|
| `GET /notes/Customers/Contoso.md` → raw file | `read_note_section(path, "Team")` → just the section you need |
| Full-vault scan for backlinks | `get_related_entities(path)` → deduped, capped traversal from pre-built graph |
| Regex search over files | `semantic_search(query)` → ranked snippets via fuzzy + semantic fallback |
| `PUT /notes/...` → blind overwrite | `atomic_append(path, heading, content, expected_mtime)` → mtime-checked safe write |
| No awareness of staleness | `query_frontmatter(key, value)` → fast cached index lookup |

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20**
- An **Obsidian vault** on disk (OIL reads/writes the vault folder directly — Obsidian doesn't need to be running)

### Install and Build

```bash
git clone <repo-url>
cd obsidian-intelligence-layer
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
      "cwd": "/absolute/path/to/obsidian-intelligence-layer",
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
      "args": ["/absolute/path/to/obsidian-intelligence-layer/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/obsidian/vault"
      }
    }
  }
}
```

> **Note:** Use absolute paths in `args` since there's no workspace-relative root. The top-level key is `mcpServers` (not `servers` like the workspace config).

Once configured, the agent can call any of OIL's 7 tools by name.

---

## Project Structure

```
src/
├── index.ts          # Entry point — startup sequence, tool registration, shutdown
├── cli.ts            # CLI wrapper — .env loading, subcommand routing
├── types.ts          # Shared TypeScript types (NoteRef, OilConfig, etc.)
├── config.ts         # Reads oil.config.yaml from vault root; merges with defaults
├── validation.ts     # Domain-level input validation — path safety, GUID format, ISO dates
├── vault.ts          # Filesystem read layer — note parsing, frontmatter, sections, wikilinks
├── graph.ts          # GraphIndex — bidirectional link graph, tag index, N-hop traversal
├── cache.ts          # SessionCache — LRU note cache (200 notes, 5min TTL)
├── embeddings.ts     # EmbeddingIndex — local 384-dim embeddings (lazy-loaded, persisted)
├── watcher.ts        # VaultWatcher — chokidar file watcher, invalidates caches on change
├── gate.ts           # Write helpers — appendToSection, executeWrite, diff generation
├── query.ts          # Frontmatter predicate query engine
├── search.ts         # Fuzzy search (fuse.js) + content search fallback
├── hygiene.ts        # Vault freshness scanning, staleness detection, health checks
├── correlate.ts      # Entity matching — cross-references external entities with vault notes
└── tools/
    ├── retrieve.ts   # 5 tools — search, query, metadata, section reads, related entities
    └── write.ts      # 2 tools — atomic_append, atomic_replace (mtime-checked)
```

> **Note:** `tools/orient.ts` and `tools/composite.ts` also exist in the codebase with tool definitions for context assembly (customer/person/vault context) and cross-MCP workflows (CRM prefetch, correlation, vault hygiene). These are not currently registered in the server — they're available for future phases when the tool surface expands.

### What Each Layer Does

| Layer | Role | Junior Dev Analogy |
|---|---|---|
| **vault.ts** | Reads markdown files from disk, parses frontmatter + sections | "The filesystem driver" |
| **graph.ts** | Builds a link graph from wikilinks across all notes | "The database index" |
| **cache.ts** | Avoids re-reading disk in the same conversation | "The L1 cache" |
| **search.ts** | Finds notes by content (not just filename) | "The search engine" |
| **gate.ts** | Section-level appends and full-file writes | "The write layer" |
| **validation.ts** | Rejects bad paths, names, and IDs before they hit disk | "The input bouncer" |
| **tools/*.ts** | Exposes everything above as named MCP tools | "The API controllers" |

---

## How It Works

### Startup Sequence

When `node dist/index.js` runs:

```
1. Read OBSIDIAN_VAULT_PATH env var
2. Load oil.config.yaml (or use defaults)
3. Load graph index from _oil-graph.json (or full-build if first run)
4. Start incremental graph rebuild in background (if persisted index found)
5. Initialize session cache (in-memory, 200-note LRU)
6. Create embedding index (lazy — won't download model until first semantic search)
7. Start chokidar file watcher (invalidates caches on vault changes)
8. Register 7 MCP tools (5 retrieve + 2 write)
9. Connect stdio transport → server ready
```

### Request Flow (Example: Agent needs the Team section from a customer note)

```
Agent calls: read_note_section({ path: "Customers/Contoso.md", heading: "Team" })
      │
      ▼
  retrieve.ts handler
      │
      ├─ validation.ts → validateVaultPath()   ← reject path traversal, invalid chars
      │
      ├─ vault.readNote("Customers/Contoso.md") ← parse file, extract sections map
      │
      ├─ sections.get("Team")                   ← O(1) lookup from parsed sections
      │
      └─ Return JSON: { path, heading, content }
```

The agent gets **just the section it needs** instead of the entire note — keeping token budgets tight.

### Write Safety

OIL v2 uses **mtime-based concurrency checks** instead of a gated approval queue. The pattern:

```
1. Agent calls get_note_metadata(path) → receives mtime_ms
2. Agent decides to write
3. Agent calls atomic_append(path, heading, content, expected_mtime=mtime_ms)
      │
      ├─ Read current file mtime from disk
      │
      ├─ expected_mtime matches? → Execute write, invalidate cache, return new mtime
      │
      └─ Mismatch? → Reject immediately with "Stale write rejected" error
               │
               Agent must re-read metadata and retry with fresh mtime
```

This eliminates the complexity of pending write queues and multi-step confirmation flows. If a workflow requires user approval, that's handled by the Copilot UI — the MCP server simply executes or rejects.

---

## Tools Reference

OIL v2 exposes **7 tools** in two categories: optimized reads and atomic writes.

### Retrieve (5 tools) — Token-efficient reads and search

All read-only. No confirmation needed.

| Tool | What It Does |
|---|---|
| `get_note_metadata` | Peek at a note before loading full content — returns frontmatter, creation/modification timestamps, word count, headings, and `mtime_ms` (needed for writes). |
| `read_note_section` | Read only a specific heading section from a note. The most token-efficient read operation — request `## Team` instead of loading a 5,000-word note. |
| `get_related_entities` | Deduped flat list of linked notes from the graph index — paths and titles only, capped at 50 results, max 3 hops. |
| `semantic_search` | Semantic-first search with context snippets. Falls back to fuzzy (fuse.js) then lexical content search when embeddings aren't available. Results capped at 20. |
| `query_frontmatter` | Fast cached frontmatter index lookup by key and value fragment. Returns up to 20 matching paths. No disk scan — built at startup. |

### Write (2 tools) — Atomic writes with mtime concurrency

Both tools require `expected_mtime` — the file's modification timestamp from `get_note_metadata`. If the mtime doesn't match the file's current state on disk, the write is rejected immediately.

| Tool | What It Does |
|---|---|
| `atomic_append` | Append content under a specific heading section. Fails if `expected_mtime` doesn't match — prevents stale overwrites. Returns new `mtime_ms` on success. |
| `atomic_replace` | Replace entire note content. Same mtime check. Use for full-file rewrites when section-level append isn't sufficient. |

### Design Rationale

The v2 tool surface is deliberately minimal:

- **No orchestration phases.** The LLM decides when to read, search, and write — OIL doesn't impose pipelines.
- **No pending write queue.** If user approval is needed, the Copilot UI handles it. The MCP server executes or rejects.
- **No CRM queries.** OIL surfaces vault-stored IDs (GUIDs, TPIDs). The copilot calls the CRM MCP separately.
- **Reads are optimized for tokens.** Section-level reads and snippet-only search keep context budgets tight.
- **Writes are optimized for safety.** mtime checks prevent race conditions without complex state machines.

---

## Configuration

Create `oil.config.yaml` in your vault root. If it doesn't exist, sensible defaults are used. Supports **snake_case YAML** that remaps to camelCase internally.

```yaml
# Folder mappings (where things live in your vault)
schema:
  customers_root: "Customers/"
  people_root: "People/"
  meetings_root: "Meetings/"
  projects_root: "Projects/"
  weekly_root: "Weekly/"
  templates_root: "Templates/"
  agent_log: "_agent-log/"
  connect_hooks_backup: ".connect/hooks/hooks.md"
  opportunities_subdir: "opportunities/"
  milestones_subdir: "milestones/"

# Frontmatter field names (match your vault conventions)
frontmatter_schema:
  customer_field: "customer"
  tags_field: "tags"
  date_field: "date"
  status_field: "status"
  project_field: "project"
  tpid_field: "tpid"
  accountid_field: "accountid"

# Search configuration
search:
  default_tier: "fuzzy"              # lexical | fuzzy | semantic
  semantic_model: "local"            # local embeddings (no API calls)
  semantic_index_file: "_oil-index.json"
  graph_index_file: "_oil-graph.json"
  background_index_threshold_ms: 3000

# Write safety
write_gate:
  diff_format: "markdown"
  log_all_writes: true
  batch_diff_max_notes: 50
  auto_confirmed_sections:           # Sections used by composite tools (future)
    - "Agent Insights"
    - "Connect Hooks"
  auto_confirmed_operations:
    - "log_agent_action"
    - "capture_connect_hook"
    - "patch_note_designated"
```

---

## Development

### Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (recompiles on change)
npm run lint         # Type-check without emitting
npm start            # Run the server (needs OBSIDIAN_VAULT_PATH)
npm run bench        # Run benchmark suite (vitest)
npm run bench:watch  # Benchmarks in watch mode
```

### Build Requirements

- Node.js ≥ 20
- TypeScript 5.7+
- ES2022 target, Node16 module resolution

### Adding a New Tool

1. Decide which category: `retrieve` (read-only search/query) or `write` (modifies vault).

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

4. If the tool writes to the vault, use the mtime concurrency pattern:
   - Accept `expected_mtime` as a required parameter
   - Read the file's current mtime before writing
   - Reject immediately if mtimes don't match
   - Invalidate the session cache after a successful write
   - Return the new `mtime_ms` so the agent can chain further writes

5. Rebuild: `npm run build`

### Key Conventions

- **Zod v4**: `z.record()` needs two args: `z.record(z.string(), z.unknown())`, not one.
- **ES modules**: All imports use `.js` extensions (`import { foo } from "./bar.js"`).
- **Logging**: Use `console.error()` (not `console.log`) — stdout is reserved for MCP protocol messages.
- **Tool descriptions**: Write them as routing instructions, not documentation. Answer "When should the agent call this?" not just "What does it do?"

---

## Architecture Deep Dive

### Index Stack

OIL maintains cached indices so that most tool calls resolve in milliseconds:

```
┌─────────────────────────────────────────────────────┐
│  Tier 0: Graph Index (persistent)                   │
│  _oil-graph.json — wikilinks, backlinks, tags       │
│  Rebuilt incrementally on startup (mtime-based)     │
│  Backlink lookup: O(1), frontmatter index at startup│
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
│  Lazy-loaded on first semantic_search call          │
│  Runs locally — no external API calls               │
└─────────────────────────────────────────────────────┘
```

### Frontmatter Index

Built once at startup from the graph index. Maps every frontmatter key → list of `{ path, value }` entries. `query_frontmatter` runs against this in-memory index — no disk scan needed.

### File Watcher

`chokidar` watches the vault for changes. When a file changes:

1. Graph index re-indexes that node (rebuild outlinks, recompute affected backlinks)
2. Session cache invalidates the note entry
3. Search index is marked dirty (rebuilt on next search call)
4. Embedding index queues the note for re-embedding

### Response Shaping

Every tool response is designed to minimize tokens while maximizing usability:

- **Sections, not full content**: `read_note_section` returns only the heading you ask for
- **Metadata before content**: `get_note_metadata` lets the agent peek (word count, headings) before committing to a full read
- **Snippets, not full notes**: `semantic_search` returns match snippets with scores, not entire files
- **Capped results**: Search returns max 20, graph traversals max 50 — prevents context blowout
- **mtime in every read**: Metadata includes `mtime_ms` so the agent can chain reads → writes without an extra call

---

## FAQ

### Why MCP instead of a REST API?

MCP is the protocol that AI agents (Copilot, Claude, etc.) use to discover and call tools. A REST API would require the agent to know your endpoint URL, handle auth, and parse responses — MCP handles all of that via the client integration.

### Does Obsidian need to be running?

No. OIL reads/writes the vault folder directly on disk. Obsidian will pick up changes when it's next opened (or immediately if it's running, since it watches the folder too).

### What's the embedding model? Does it need an API key?

OIL uses `Xenova/all-MiniLM-L6-v2` locally via `@xenova/transformers`. No API key needed. The model is downloaded on first semantic search (~80MB) and cached. If embeddings aren't available, `semantic_search` falls back to fuzzy (fuse.js) + lexical content search.

### What happened to the 22 tools from v1?

The v2 redesign ([spec 11](./_specs/11-optimized-mcp-design.md)) reduced the tool surface to 7. The core insight: the LLM is already good at orchestration — OIL shouldn't replicate that. Instead, v2 focuses on token-efficient reads and safe atomic writes. The orient and composite tool code still exists in `src/tools/` for potential future use.

### What about CRM integration?

OIL no longer queries CRM directly. It surfaces vault-stored IDs (opportunity GUIDs, TPIDs, account IDs) through its read tools. The copilot takes those IDs and calls a separate CRM MCP (like MSX) itself.

### What happened to the write gate / pending writes?

Replaced by mtime-based concurrency checks. Every write requires `expected_mtime` — if the file changed since you last read it, the write is rejected. This is simpler, stateless, and prevents race conditions without a pending queue.

### What happens if I don't create `oil.config.yaml`?

All defaults are used. Customers in `Customers/`, people in `People/`, meetings in `Meetings/`, etc. See the [Configuration](#configuration) section for defaults.

### How do I see what the agent did to my vault?

Use `get_note_metadata` to check file timestamps, or use git / Obsidian's file recovery to track changes. The `writeGate.logAllWrites` config option and `_agent-log/` directory are available for audit logging when composite tools are enabled.

### Can I undo agent writes?

Writes require a valid mtime check, so accidental overwrites from stale state are prevented. For rollback, use Obsidian's file recovery or git.
