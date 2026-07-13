# Obsidian Intelligence Layer (OIL)

**OIL is an [MCP](https://modelcontextprotocol.io/) server that gives AI agents efficient, safe access to an Obsidian vault.** Instead of flooding context with raw file dumps, it provides targeted reads, ranked search, and mtime-safe writes — so the LLM spends its context on reasoning, not data wrangling.

**Node 20+** · **TypeScript** · **ES modules** · **MIT**

<p align="center">
  <img src="docs/assets/oil-overview.gif" alt="OIL overview — your AI agent's second brain" width="800" />
</p>

---

## Why OIL?

**The problem:** Your Obsidian vault is your second brain — customer notes, meeting summaries, project docs, action items. When you ask your AI assistant to help ("what are the open action items for Contoso?"), it needs to read your vault.

Without a smart interface, the agent does the dumb thing:
- Dumps 50 full notes into context → burns thousands of tokens
- Searches by grep → misses structure, relationships, and frontmatter
- Writes blindly → risks overwriting your edits mid-session

**The solution:** OIL is a structured interface between your AI and your vault. It speaks [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol AI agents use to discover and call tools. When Copilot or Claude needs something from your vault, it calls OIL's tools instead:

- **Search** returns ranked snippets, not whole files
- **Catalog discovery** exposes the vault's actual folders, fields, types, tags, and warnings before an agent guesses
- **Reads** are section-level — ask for `## Team` and get just that heading
- **Writes** are mtime-checked — the agent can't clobber your edits by accident
- **Domain tools** assemble full customer snapshots, extract CRM identifiers, and surface vault hygiene issues — encoding business logic the LLM would otherwise have to reconstruct from scratch

> **For customer-facing teams:** OIL includes purpose-built tools for account management workflows. If you track customers, opportunities, and meetings in Obsidian, the domain tools (`get_customer_context`, `prepare_crm_prefetch`, `check_vault_health`) are the highest-value part of the set.

---

## What This Is (and Isn't)

**OIL is not a REST API wrapper around Obsidian.** It's an MCP server — it speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio. AI agents connect to it as a tool provider; you don't hit it with curl.

| Without OIL | With OIL |
|---|---|
| Dump full note to context | `read_note_section(path, "Team")` → just the section you need |
| Full-vault file scan for backlinks | `get_related_entities(path)` → graph-traversed refs, max 2 hops / 25 refs per page |
| Guess folders or YAML fields | `inspect_catalog(view)` → bounded virtual folders, fields, types, tags, and warnings |
| Free-text grep across files | `search_vault(query)` → ranked frontmatter + full-body results with match explanations |
| Blind file overwrite | `atomic_append(path, heading, content, expected_mtime)` → rejected if file changed since last read |
| Manual review for stale notes | `check_vault_health()` → surfaces stale insights, missing IDs, orphaned meetings |
| Manual context assembly per customer | `get_customer_context(customer)` → assembled snapshot: team, meetings, opportunities, action items |

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20**
- An **Obsidian vault** on disk (Obsidian doesn't need to be running — OIL works directly on the files)

### Install and Build

```bash
git clone <repo-url>
cd obsidian-intelligence-layer
npm install
npm run build
npm link
```

`npm link` installs the local `oil` executable. A published global package installation exposes the same command. The previous `obsidian-intelligence-layer` executable remains available as a compatibility alias.

### Choose Your Vault

```bash
oil setup
```

Setup discovers vaults already registered with Obsidian. If there is more than one, it lets you choose; if none match, it opens the native macOS/Windows folder chooser and falls back to a terminal path prompt when desktop UI is unavailable. The canonical path is saved in a per-user OIL profile.

Useful setup commands:

```bash
oil list-vaults                         # Show saved and Obsidian-registered vaults
oil doctor                              # Validate the selected vault and count notes
oil setup --vault /absolute/path        # Non-interactive or scripted setup
oil setup --profile work                # Save/select a named profile
oil init /path/to/new-vault             # Explicitly scaffold an OIL-ready directory
```

`init` never updates Obsidian's global registry. Open the resulting folder in Obsidian once so Obsidian can create its own `.obsidian` settings.

### Run

```bash
oil mcp
```

The server communicates over **stdio**. You don't hit it with curl — an MCP client connects to it. MCP startup is deliberately non-interactive: folder dialogs only appear during the explicit `setup` command, avoiding client initialization timeouts and remote-host UI mismatches.

### Connect to VS Code (Copilot / Claude)

**Option A: Per-workspace** — add to `.vscode/mcp.json` in any workspace:

```json
{
  "servers": {
    "oil": {
      "type": "stdio",
      "command": "oil",
      "args": ["mcp"]
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
      "command": "oil",
      "args": ["mcp"]
    }
  }
}
```

> **Note:** The top-level key is `mcpServers` (not `servers` like the workspace config). The `oil` executable must be available on the environment's `PATH`.

**Option C: Let VS Code prompt on first start** — useful for a shared workspace configuration where each user has a different local path:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "obsidian-vault",
      "description": "Absolute path to your Obsidian vault"
    }
  ],
  "servers": {
    "oil": {
      "type": "stdio",
      "command": "oil",
      "args": ["mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "${input:obsidian-vault}"
      }
    }
  }
}
```

VS Code securely caches the input after the first prompt. This is a client feature; OIL's cross-client `setup` command is the option that can open a native folder chooser.

Once configured, the agent can call any of OIL's 14 live tools by name.

---

## Tools Reference

OIL exposes **14 live tools** across five categories.

### Core Visibility (1 tool) — Tiny runtime summary

Use this first when a client needs fast runtime state without paying the cost of a detailed audit read.

| Tool | What It Does |
|---|---|
| `get_health` | Returns server identity, live tool-surface counts, index freshness, cache stats, watcher state, and whether audit logs are available. This is the summary visibility tool; use `get_agent_log` only when you need detailed write history. |

### Search & Inspect (6 tools) — Token-efficient reads

All read-only. No confirmation needed.

<p align="center">
  <img src="docs/assets/oil-search-inspect.gif" alt="Search & Inspect tools — ranked snippets, section reads, graph traversal" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `search_vault` | Unified search across paths, titles, aliases, arbitrary frontmatter, tags, descriptions, headings, complete note bodies, links, and fuzzy candidates. Returns match explanations and generation-bound pagination; max 20 results per page. |
| `inspect_catalog` | Bounded orientation over folders, one folder, observed frontmatter fields, types, tags, recent notes, readiness, or warnings. Replaces the misleading former `semantic_search` tool. |
| `query_frontmatter` | Persistent typed lookup with `eq`, `contains`, `prefix`, `exists`, `in`, `all`, and numeric/date range operators. Distinguishes `UNKNOWN_FIELD` from a known field with zero matches; max 50 results per page. Existing `key` + `value_fragment` calls remain supported. |
| `get_note_metadata` | Inspect canonical identity, presentation provenance, bounded frontmatter, timestamps, word count, headings, readiness, warnings, relationships, and `mtime_ms`. Supports `frontmatter_view=keys\|summary\|full`. |
| `read_note_section` | Read one heading section with `max_chars` (default 4,000; max 8,000) and cursor continuation. |
| `get_related_entities` | Traverse resolved Obsidian and standard Markdown links with provenance and ambiguity evidence; max 2 hops and 25 results per page. |

### Safe Writes (3 tools) — Atomic writes with mtime concurrency

All write tools require `expected_mtime` (from `get_note_metadata`) or check for file existence. If the file has changed since you last read it, the write is rejected immediately.

<p align="center">
  <img src="docs/assets/oil-safe-writes.gif" alt="Safe Writes — mtime concurrency check flow" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `atomic_append` | Append content under a specific heading. Requires `expected_mtime`. Rejected if the file changed since you read it. Returns new `mtime_ms`. |
| `atomic_replace` | Replace entire note content. Same `expected_mtime` check. Use for full-file rewrites when section-level append isn't enough. Returns new `mtime_ms`. |
| `create_note` | Create a new note at a given path. Fails cleanly if the note already exists — use `atomic_replace` to update existing notes. |

### Customer Workflows (3 tools) — Domain-specific assembly

High-level tools that encode business logic the LLM would otherwise need to reconstruct from scratch on every request.

<p align="center">
  <img src="docs/assets/oil-customer-workflows.gif" alt="Customer Workflows — single call assembles full customer snapshot" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `get_customer_context` | Assembles a full customer snapshot: frontmatter, opportunities with GUIDs, milestones, team composition, recent meetings, linked people, and open action items. Accepts a customer name or TPID, plus `view=brief\|full\|write` for compact reads or deterministic write scaffolding. |
| `prepare_crm_prefetch` | Extracts vault-stored CRM identifiers (opportunity GUIDs, TPIDs, account IDs) for one or more customers. Returns structured data with OData filter hints ready for CRM query construction. |
| `check_vault_health` | Scans the vault for stale Agent Insights (>30 days), opportunities or milestones missing IDs, notes without a `## Team` section, and orphaned meeting notes. Returns a prioritized issue list. |

### Audit & Observability (1 tool)

<p align="center">
  <img src="docs/assets/oil-audit-log.gif" alt="Audit & Observability — every write logged with timestamp and detail" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `get_agent_log` | Read the agent write audit log for a given date (default: today). Every `atomic_append`, `atomic_replace`, and `create_note` call is logged here with timestamp, path, and operation detail. |

### Companion Retrieval Skill

The repository includes [.github/skills/oil-retrieval/SKILL.md](.github/skills/oil-retrieval/SKILL.md). It teaches compatible agents to route direct identifiers to `query_frontmatter`, names and topics to `search_vault`, broad requests to `inspect_catalog`, and then progress metadata → section → relationships without flooding context. It also defines unknown-field, cursor, ambiguity, freshness, and mtime-conflict recovery.

### Write Safety Pattern

The write tools use **mtime-based concurrency checks** — no write queues, no approval flows:

```
1. Agent calls get_note_metadata(path) → receives mtime_ms
2. Agent decides to write
3. Agent calls atomic_append(path, heading, content, expected_mtime=mtime_ms)
      │
      ├─ Read current mtime from disk
      │
      ├─ Matches? → Execute write, invalidate cache, return new mtime_ms
      │
      └─ Mismatch? → "Stale write rejected" — agent must re-read and retry
```

If a workflow requires user approval, that's handled by the Copilot UI — the MCP server simply executes or rejects.

---

## Configuration

### Vault Selection

OIL resolves the runtime vault in this order:

1. An explicit CLI selection (`oil mcp --vault /absolute/path` or `oil mcp --profile work`)
2. `OBSIDIAN_VAULT_PATH`
3. A named profile requested through `OIL_VAULT_PROFILE`
4. The saved default profile created by `setup`
5. One unambiguous valid vault from Obsidian's local registry

An invalid explicit, environment, or saved path is an error; OIL never silently switches to another vault. When multiple registry vaults exist, run `setup` to make the choice explicit. The per-user profile file is stored under the platform's normal application configuration directory and can be relocated with `OIL_CONFIG_PATH` or `OIL_CONFIG_HOME`.

### Vault Schema

Create `oil.config.yaml` in your vault root to customize folder layout and field names. Omit it entirely to use sensible defaults. Supports **snake_case YAML** that remaps to camelCase internally.

```yaml
# Folder layout (where things live in your vault)
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
  insights_subdir: "insights/"

# Frontmatter field names (match your vault conventions)
frontmatter_schema:
  customer_field: "customer"
  tags_field: "tags"
  date_field: "date"
  status_field: "status"
  project_field: "project"
  tpid_field: "tpid"
  accountid_field: "accountid"
  title_field: "title"
  description_field: "description"
  type_field: "type"
  timestamp_field: "timestamp"
  id_field: "id"

# Search and indexing
search:
  graph_index_file: "_oil-graph.json"         # Versioned, atomically replaced catalog snapshot
  background_index_threshold_ms: 3000         # Retained for configuration compatibility

# Write configuration
write_gate:
  diff_format: "markdown"
  log_all_writes: true                        # Log every write to _agent-log/
  batch_diff_max_notes: 50
  auto_confirmed_sections:
    - "Agent Insights"
    - "Connect Hooks"
  auto_confirmed_operations:
    - "log_agent_action"
    - "capture_connect_hook"
    - "patch_note_designated"
```

---

## Project Structure

```
src/
├── index.ts          # Entry point — startup sequence, tool registration, shutdown
├── cli.ts            # CLI wrapper — .env loading, subcommand routing
├── vault-path.ts     # Cross-platform vault discovery, validation, profiles, and setup picker
├── types.ts          # Shared TypeScript types (NoteRef, OilConfig, etc.)
├── config.ts         # Reads oil.config.yaml from vault root; merges with defaults
├── validation.ts     # Input validation — path safety, GUID format, ISO dates
├── vault.ts          # Filesystem read layer — note parsing, frontmatter, sections, wikilinks
├── catalog.ts        # Canonical node parser, schema normalization, chunks, links, fingerprints
├── graph.ts          # GraphIndex — atomic catalog generations and derived indices
├── pagination.ts     # Generation-bound cursor encoding and validation
├── cache.ts          # SessionCache — LRU note cache (200 notes, 5min TTL)
├── watcher.ts        # VaultWatcher — chokidar file watcher, invalidates caches on change
├── gate.ts           # Write helpers — appendToSection, executeWrite, audit logging
├── query.ts          # Compatibility predicate helpers
├── search.ts         # Unified candidate fusion over catalog fields and complete bodies
├── hygiene.ts        # Vault freshness scanning, staleness detection, health scoring
├── correlate.ts      # Entity matching — cross-references external IDs with vault notes
├── tool-responses.ts # Shared MCP JSON response helpers — structured errors, refs, version hints
├── version.ts        # Server identity — name/version shared by runtime and tools
└── tools/
    ├── core.ts       # 1 tool — get_health
    ├── retrieve.ts   # 6 tools — search, catalog inspection, typed query, metadata, sections, related
    ├── write.ts      # 4 tools — atomic_append, atomic_replace, create_note, get_agent_log
    ├── domain.ts     # 3 tools — get_customer_context, prepare_crm_prefetch, check_vault_health
    ├── orient.ts     # (unregistered) Context assembly primitives from earlier design
    └── composite.ts  # (unregistered) Cross-MCP workflow tools from earlier design
.github/skills/
└── oil-retrieval/    # Companion staged-discovery and safe-write policy
```

### What Each Layer Does

| Layer | Role |
|---|---|
| **vault.ts** | Reads markdown files from disk, parses frontmatter + section maps |
| **catalog.ts / graph.ts** | Build canonical records, observed schema, frontmatter/full-content indices, and deterministic Obsidian + Markdown relationships |
| **cache.ts** | LRU cache — avoids re-reading disk across multi-turn conversations |
| **search.ts** | Fuses exact and fuzzy candidates across identity, frontmatter, descriptions, headings, complete bodies, and links |
| **gate.ts** | Section-level appends and full-file writes with audit logging |
| **hygiene.ts** | Domain-aware staleness checks (insights age, missing IDs, orphaned meetings) |
| **validation.ts** | Rejects bad paths, names, and IDs before they hit disk |
| **tools/*.ts** | Exposes everything above as named MCP tools |

---

## How It Works

### Startup Sequence

When `oil mcp` runs:

```
1. Resolve and validate the vault from explicit config, environment, saved profile, or one registry candidate
2. Load oil.config.yaml (or use defaults)
3. Load a compatible catalog snapshot from _oil-graph.json when available
4. Reconcile paths and source fingerprints before registering retrieval tools
5. Initialize session cache (in-memory, 200-note LRU)
6. Start chokidar file watcher (invalidates caches on vault changes)
7. Register 14 MCP tools (core + retrieve + write + domain)
8. Connect stdio transport → server ready
```

### Request Flow (Example: read the Team section from a customer note)

```
Agent calls: read_note_section({ path: "Customers/Contoso.md", heading: "Team" })
      │
      ▼
  retrieve.ts handler
      │
      ├─ validation.ts → validateVaultPath()    ← reject traversal attacks, bad chars
      │
      ├─ GraphIndex.getNode()                    ← one coherent catalog generation
      ├─ vault.parseSections(node.bodyText)      ← section map from indexed complete body
      │
      ├─ sections.get("Team")                   ← O(1) lookup
      │
      └─ Return JSON: { path, heading, content }
```

The agent gets **just the section it needs** — not the entire note.

---

## Architecture Deep Dive

### Index Stack

OIL maintains in-memory indices so most tool calls resolve in milliseconds:

```
┌──────────────────────────────────────────────────────┐
│  Tier 0: Knowledge Catalog (_oil-graph.json)         │
│  Canonical nodes, observed schema, typed fields,     │
│  full-body chunks, links, warnings, generations      │
│  Atomic persistence + startup reconciliation         │
├──────────────────────────────────────────────────────┤
│  Tier 1: Fuzzy Search Index (in-memory, lazy)        │
│  fuse.js — built on first search, invalidated on     │
│  file change. Subsequent searches: ~10ms             │
├──────────────────────────────────────────────────────┤
│  Tier 2: Session Cache (in-memory, per-connection)   │
│  LRU, 200 notes, 5min TTL — avoids re-reading disk   │
│  across multi-turn conversations                     │
└──────────────────────────────────────────────────────┘
```

### Observed Schema and Frontmatter Index

Every catalog generation maintains an observed schema and typed frontmatter inverted index. Source key spelling and unknown values remain intact, while lookups normalize case and separators and honor configured aliases. Arrays and nested dotted paths are queryable. An unknown key returns `UNKNOWN_FIELD` with nearby observed fields instead of an unexplained empty result.

### File Watcher

`chokidar` watches the vault for changes. When a file changes:

1. Catalog publishes a coherent generation containing the changed node, derived indices, and relationships
2. Session cache invalidates the note entry
3. Fuzzy search index marked dirty (rebuilt on next search call)

### Response Shaping

Every tool response minimizes tokens while maximizing usability:

- **Sections, not full files:** `read_note_section` returns only the heading you asked for
- **Metadata before content:** `get_note_metadata` lets the agent peek (word count, headings) before committing to a full read
- **Snippets, not documents:** search tools return match snippets, not entire notes
- **Capped results:** Search 20, frontmatter 50, graph 25 / 2 hops, sections 8,000 chars, logs 100 entries
- **Explicit completeness:** Bounded reads return counts, `truncated`, and generation-bound cursors where continuation is meaningful
- **mtime in every metadata read:** Included so the agent can chain read → write without an extra round-trip

---

## Development

### Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (recompiles on change)
npm run lint         # Type-check without emitting
npm start            # Run the server (uses setup profile or OBSIDIAN_VAULT_PATH)
npm run test:setup   # Vault discovery, validation, profiles, and picker command tests
npm run test:catalog # Catalog/spec contracts and permanent retrieval regressions
npm run test:vault:live # Read-only audit (requires OBSIDIAN_VAULT_PATH)
OIL_ALLOW_LIVE_VAULT_WRITES=1 npm run test:vault:crud # Isolated temporary CRUD validation
npm run bench        # Run benchmark suite (vitest)
npm run bench:watch  # Benchmarks in watch mode
```

`test:catalog` protects unknown-field recovery, typed frontmatter predicates, full-body recall, pagination, hard limits, malformed-note recovery, ambiguity, and immediate write visibility. `test:vault:live` is explicit opt-in, never starts the watcher, and never invokes write tools against the configured vault.

`test:vault:crud` is a separate explicit write test. It creates only under `_oil-validation/<uuid>/`, redirects audit logs into that temporary directory, exercises create/read/append/replace/search/query/relationships, deletes the directory externally to validate watcher removal, and cleans up in `afterAll`. It refuses to run unless `OIL_ALLOW_LIVE_VAULT_WRITES=1` is set.

### Build Requirements

- Node.js ≥ 20
- TypeScript 5.7+
- ES2022 target, Node16 module resolution

### Adding a New Tool

1. Decide which category: `retrieve` (read-only), `write` (modifies vault), or `domain` (business logic assembly).

2. Open the corresponding file in `src/tools/`.

3. Add a `server.registerTool()` call:

```typescript
server.registerTool(
  "my_tool_name",
  {
    // Write the description as a routing signal — tell the LLM WHEN to call this.
    description: "Does X when the agent needs Y. Primary tool for [workflow step].",
    inputSchema: {
      param_name: z.string().describe("What this param means"),
    },
  },
  async ({ param_name }) => {
    const result = { /* ... */ };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);
```

4. If the tool writes to the vault, use the mtime concurrency pattern:
   - Accept `expected_mtime` as a required parameter
   - Check the current mtime before writing; reject immediately if mismatched
   - Invalidate the session cache after a successful write
   - Return the new `mtime_ms` so the agent can chain further writes
   - Call `logWrite()` for the audit trail

5. Rebuild: `npm run build`

### Key Conventions

- **Zod v4**: `z.record()` needs two args: `z.record(z.string(), z.unknown())`, not one.
- **ES modules**: All imports use `.js` extensions (`import { foo } from "./bar.js"`).
- **Logging**: Use `console.error()` (not `console.log`) — stdout is reserved for MCP protocol messages.
- **Tool descriptions**: Write them as routing instructions. Answer "When should the agent call this?" not just "What does it do?"

---

## FAQ

### Why MCP instead of a REST API?

MCP is the protocol that AI agents (Copilot, Claude, etc.) use to discover and call tools. A REST API would require the agent to know your endpoint URL, handle auth, and parse responses — MCP handles all of that via the client integration.

### Does Obsidian need to be running?

No. OIL reads/writes the vault folder directly on disk. Obsidian will pick up changes when it's next opened (or immediately if it's running, since it also watches the folder).

### Why doesn't the MCP server open a folder chooser when it starts?

An MCP stdio client expects initialization to complete promptly, and the server might be running over SSH, in a container, in CI, or on a remote VS Code host with a different filesystem. Automatically opening desktop UI can time out startup, appear behind other windows, or select a path unavailable to the server. OIL therefore opens native UI only during explicit `setup`; normal MCP startup is deterministic and non-interactive.

### What if I use more than one vault?

Create named profiles with `oil setup --profile personal` and `oil setup --profile work`, inspect them with `oil list-vaults`, and launch with `oil mcp --profile work`. Running `oil setup` makes the most recently configured profile the default.

### What replaced `semantic_search`?

`search_vault` now owns all named-entity and natural-language retrieval across frontmatter and complete note bodies. `inspect_catalog` owns broad orientation when the vault layout or schema is unknown. The former `semantic_search` name implied embeddings even though it only performed fuzzy/lexical matching, so it was retired when these capabilities were consolidated. Neither replacement requires an external API or model download.

### What about CRM integration?

OIL doesn't query CRM directly. It surfaces vault-stored identifiers (opportunity GUIDs, TPIDs, account IDs) through `prepare_crm_prefetch`. The agent takes those IDs and calls a separate CRM MCP (e.g., MSX) itself.

### What happens if I don't create `oil.config.yaml`?

All defaults are used. Customers in `Customers/`, people in `People/`, meetings in `Meetings/`, etc. See the [Configuration](#configuration) section for the full default set.

### How do I see what the agent wrote to my vault?

Use `get_health` first if you only need a quick status check. Use `get_agent_log` when you need the detailed write audit for today (or any specified date in `YYYY-MM-DD` format). Every `atomic_append`, `atomic_replace`, and `create_note` call is logged with timestamp, path, and operation detail.

### Can I undo agent writes?

Writes require a valid mtime check, so accidental stale overwrites are prevented. For rollback, use Obsidian's built-in file recovery or git.
