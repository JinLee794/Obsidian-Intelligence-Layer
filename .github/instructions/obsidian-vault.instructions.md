---
description: "Obsidian vault integration — local knowledge layer, customer roster, durable storage, CRM prefetch context, Connect hook routing. Use when reasoning about vault reads, customer defaults, durable memory, Obsidian notes, mcp-obsidian tools, customer roster filtering, vault-first storage, or cross-medium context assembly."
---

# Obsidian Vault — Local Knowledge Layer

The Obsidian vault is the agent's **primary local knowledge store** — personal notes, customer context, durable memory, and known defaults. It is NOT optional scaffolding; it is the lens through which CRM data is scoped and interpreted.

MSX/CRM is the **authoritative system of record** for live state (milestones, opportunities, pipeline). The vault provides the *context* that makes CRM data meaningful: which customers matter, what was discussed, what decisions were made, what the agent should focus on.

## Core Principles

1. **Vault defines scope; CRM provides fresh state.** The vault tells the agent *who* and *what* to care about. CRM tells the agent *where things stand right now*.
2. **Vault-listed customers are the active roster.** If a customer does not have a `Customers/<Name>.md` file in the vault, treat it as out-of-scope for proactive workflows. Past/completed/limbo opportunities for un-tracked customers should be ignored unless the user explicitly asks.
3. **CRM data is always retrieved fresh for complex operations.** Even if the vault has cached findings, milestone/opportunity status must be validated from CRM when the workflow involves writes, risk assessment, governance reporting, or cross-customer analysis.
4. **Vault is the durable storage layer.** Validated findings, decisions, Connect hooks, and agent insights are persisted to the vault. Without the vault, the agent operates statelessly — durable memory requires Obsidian or a user-configured persistence layer.

## Vault Structure Conventions

```
Customers/
  <CustomerName>.md       # One file per actively-tracked customer
People/
  <Full Name>.md          # Contact/stakeholder notes (internal, customer, partner)
Projects/
  <ProjectName>.md        # Cross-customer or internal projects
Meetings/
  <YYYY-MM-DD> - <Title>.md  # Meeting notes, organized by date
Daily/
  <YYYY-MM-DD>.md         # Daily notes (optional)
Weekly/
  <YYYY>-W<XX>.md         # Weekly digest summaries
Templates/
  ...                     # Note templates
```

### Nested vs Flat Customer Layout

The vault supports two customer layouts, but **nested is strongly preferred**:

| Layout | Path | Sub-entities | Status |
|---|---|---|---|
| **Nested** (preferred) | `Customers/X/X.md` | `opportunities/`, `milestones/` subdirs available | Default for new customers |
| **Flat** (legacy) | `Customers/X.md` | Cannot store sub-entity notes | Migration recommended |

**Why nested matters**: Operations like `create_opportunity`, `create_milestone`, and entity-level notes require the nested structure (`Customers/X/opportunities/`, `Customers/X/milestones/`). Flat-layout customers cannot use these features.

**Migration protocol**: When the agent encounters a flat-layout customer file during any workflow:
1. **Detect**: `check_vault_health()` reports flat-layout customers in `structuralIssues`.
2. **Propose**: Call `migrate_customer_structure({ customer: "X" })` — this generates a gated diff showing the move.
3. **Confirm**: The user reviews and confirms the migration. Content is preserved as-is.
4. **Post-migration**: Sub-entity directories become available for `create_opportunity` / `create_milestone`.

**When to trigger migration automatically**:
- Before `create_opportunity` or `create_milestone` — if the target customer uses flat layout, propose migration first.
- During `check_vault_health()` — flat-layout customers are surfaced as structural issues.
- During VAULT-HYGIENE phase — include structural migration in the recommended actions.

**Do NOT migrate** without user confirmation — file moves are gated writes.

### Frontmatter Conventions

All note types use YAML frontmatter for structured retrieval via `search_notes`. Consistent keys enable cross-note queries.

| Key | Used In | Type | Purpose |
|---|---|---|---|
| `tags` | All | `string[]` | Note type classification (`meeting`, `people`, `project`, `customer`, `weekly-digest`) |
| `date` | Meetings, Weekly, Daily | `string` | ISO date (`YYYY-MM-DD`) |
| `customer` | Meetings, Projects | `string` | Customer name — must match a `Customers/` filename |
| `project` | Meetings | `string` | Project name — must match a `Projects/` filename |
| `status` | Meetings, Projects | `string` | `open` / `closed` / `active` / `completed` |
| `action_owners` | Meetings | `string[]` | People with outstanding action items |
| `company` | People | `string` | Organization the person belongs to |
| `org` | People | `string` | `internal` / `customer` / `partner` |
| `customers` | People | `string[]` | Customer accounts they're associated with |

### Customer File Anatomy (`Customers/<Name>.md`)

Each customer file is the single source of local truth for that customer. Sections are additive — create them as content arrives, don't pre-populate empty headings.

| Section | Purpose |
|---|---|
| `# <CustomerName>` | Header — customer name |
| `## Team` | Account team members, roles, stakeholder contacts |
| `## Opportunities` | **Active opportunity names AND GUIDs** (`opportunityid: <GUID>`). This is the primary bridge from customer name → MSX identifiers. Always include the GUID so VAULT-PREFETCH can inject it directly into CRM queries. |
| `## Milestones` | Milestone-level notes, commitments, context not in CRM. Include milestone IDs/numbers when known for direct lookup. |
| `## Agent Insights` | Validated findings promoted from working memory |
| `## Connect Hooks` | Evidence capture entries (see Connect Hooks schema) |
| `## Notes` | Free-form meeting notes, decisions, observations |

**ID Storage Rule**: When the agent discovers MSX identifiers during a CRM workflow (opportunity GUIDs, account IDs, TPIDs, milestone numbers), it MUST write them back to the customer file so future VAULT-PREFETCH steps can use them directly. An opportunity entry without a GUID is incomplete.

### MCP Obsidian Tool Reference

When reading or writing vault notes, use these `mcp-obsidian` tools:

| Operation | Tool | Key Parameters |
|---|---|---|
| List folder contents | `list_directory` | `path` (e.g., `Customers/`) |
| Read a note | `read_note` | `path` (e.g., `Customers/Contoso.md`) |
| Read multiple notes | `read_multiple_notes` | `paths` array |
| Search by content | `search_notes` | `query`, optional frontmatter search |
| Create a new note | `write_note` | `path`, `content` |
| Append to a section | `patch_note` | `path`, `operation: "append"`, `heading` |
| Get frontmatter | `get_frontmatter` | `path` |
| Update frontmatter | `update_frontmatter` | `path`, `properties` |
| List/add tags | `manage_tags` | `path`, `action`, `tags` |

## Vault Protocol Phases

Skills reference these phases by name (e.g., "run VAULT-PREFETCH") instead of duplicating vault logic. Each phase includes an **availability guard** — if `mcp-obsidian` is unreachable, the phase is skipped gracefully and the workflow continues with fallback behavior.

### Availability Guard (all phases)

Before executing any vault phase:
1. Attempt `list_directory` at the vault root (e.g., path `Customers/`).
2. If reachable → proceed with the phase.
3. If unreachable → skip the phase, apply the phase-specific fallback, and continue the workflow without breaking.

Cache the availability result for the duration of the current workflow — do not re-check on every phase invocation within the same turn.

### VAULT-PREFETCH

**When**: Before any CRM query or multi-customer workflow. **This is mandatory when `mcp-obsidian` is available** — do not skip it in favor of going directly to CRM tools.
**Purpose**: Resolve customer→MSX identifiers from vault notes so CRM queries use precise IDs instead of broad discovery.

Steps:
1. Run availability guard.
2. Read `Customers/` directory to identify the active roster.
3. If targeting a specific customer, call `read_note("Customers/<Name>.md")` and extract:
   - **Opportunity GUIDs** from the `## Opportunities` section (e.g., `opportunityid: 00000000-0000-0000-0000-000000000000`). These go directly into CRM `$filter` expressions (`_msp_opportunityid_value eq '<GUID>'`).
   - **Account TPID / Account ID** from frontmatter fields (`tpid`, `accountid`) — use for account-scoped CRM filters.
   - **Milestone IDs or numbers** if previously recorded under `## Milestones`.
   - **Team composition** — identifies relevant owners for `_ownerid_value` filters.
   - **Prior Agent Insights** — avoid re-running queries for already-validated findings.
4. Use vault-provided IDs to scope the CRM query precisely — pass opportunity GUIDs to `crm_query` filters, `get_milestones({ opportunityId })`, or composite tools like `find_milestones_needing_tasks`.
5. For multi-customer workflows, read multiple customer files (`read_multiple_notes`) to collect all relevant IDs in one pass.

**Critical rule**: If the vault has the opportunity GUID for a customer, use it directly. Do NOT call `list_opportunities({ customerKeyword })` or `crm_query` on `accounts` to rediscover an ID the vault already provides.

**Skip when**: User provides an explicit opportunity/milestone ID, or asks to search beyond tracked customers.
**Fallback (no vault)**: Ask user for customer names, or use `crm_whoami` + `get_my_active_opportunities()` for scope.

### VAULT-CORRELATE

**When**: After retrieving M365/WorkIQ evidence or CRM data that may relate to existing vault notes (meetings, decisions, action items).
**Purpose**: Cross-reference retrieved activities with vault notes for richer context, and resolve people/entities to customer associations.

Steps:
1. Run availability guard.
2. **People→Customer resolution**: Search vault `People/` notes (`search_notes` with tag `people` or list `People/` directory) to build a lookup of person → customer associations using frontmatter fields `customers`, `company`, and `org`. This enables attributing M365 activity (meetings, chats, emails) to specific customer accounts based on who participated.
3. Search vault by customer name and date range using `search_notes` (frontmatter `customer` + `date` fields). Use resolved customer names from step 2 to target searches when the originating query didn't specify a customer.
4. Read matched notes (`read_note` or `read_multiple_notes`) for relevant context.
5. Surface connections: prior meeting notes, decisions, and action items that relate to the retrieved evidence.
6. Return the people→customer lookup to the calling workflow for downstream attribution (e.g., WorkIQ entity resolution, output grouping by customer).

**Date/time boundary rules**:
- Always scope vault searches to the **same date window** as the source query (e.g., if WorkIQ was scoped to today, search vault for today's date only).
- Never let vault correlation silently expand the time window — if a broader search is needed, state the expanded range explicitly to the user.
- Use ISO date format (`YYYY-MM-DD`) in all time-based vault queries.

**Skip when**: No M365/WorkIQ evidence was retrieved, or vault context wouldn't add value to the current output.
**Fallback (no vault)**: Skip correlation; present M365/CRM evidence as-is without vault enrichment.

### VAULT-PROMOTE

**When**: After completing a CRM query or write workflow with validated findings worth persisting.
**Purpose**: Persist validated findings to the vault for future context.

Steps:
1. Run availability guard.
2. Append findings to `Customers/<Name>.md` under `## Agent Insights` using `patch_note` with `operation: "append"` and `heading: "Agent Insights"`.
3. Include datestamp (`YYYY-MM-DD`) and brief summary of what was found or changed.
4. If no customer file exists and the customer is now actively tracked, create `Customers/<Name>.md` with the findings.
5. For Connect hooks: append to `## Connect Hooks` on the customer file (primary), and `.connect/hooks/hooks.md` (backup).

**Do NOT promote**: speculative, unvalidated, or redundant information.
**Fallback (no vault)**: Write to `.connect/hooks/hooks.md` only. Durable memory is not available without a configured persistence layer.

### VAULT-HYGIENE

**When**: Periodic review, governance cadence, or on-demand cleanup.
**Purpose**: Keep vault data current and aligned with CRM reality.

Steps:
1. Run availability guard.
2. Check `## Agent Insights` timestamps — flag entries older than 30 days as potentially stale.
3. **If structural issues exist** (flat-layout customers): present them to the user and offer `migrate_customer_structure()` to convert to nested layout. This is a prerequisite for sub-entity storage.
4. Cross-reference vault customer roster with `get_my_active_opportunities()` — flag gaps (CRM customers not in vault, vault customers with no active CRM opps).
5. Recommend additions/removals to the user — do not auto-delete vault content.

**Skip when**: Not explicitly requested or not part of a governance cadence.
**Fallback (no vault)**: Ask the user for customer names or use `crm_whoami` context. No automatic roster approximation without a configured persistence layer.

## Workflow Integration (Detailed Reference)

> Skills should invoke the named Vault Protocol Phases above. This section provides detailed reference for the patterns underlying each phase.

### 1. CRM Query Prefetch (Vault → CRM)

**Before any CRM query workflow**, check the vault for relevant customer context:

1. Read the user's vault `Customers/` directory to identify the active roster.
2. If the query targets a specific customer, read `Customers/<Name>.md` to extract:
   - Known opportunity names/IDs (avoids discovery queries).
   - Team composition (identifies relevant owners for filtering).
   - Prior findings and open items (avoids redundant queries).
3. Use vault context to **scope** the CRM query — filter by known opportunity IDs, target specific milestones, or skip customers the user doesn't track.

**When to skip vault prefetch:**
- The user provides an explicit opportunity ID or customer name not in the vault.
- The user explicitly asks to search broadly beyond their tracked customers.

### 2. Freshness Rules (When to Use CRM vs Vault)

| Scenario | Source |
|---|---|
| "Who are my active customers?" | **Vault** (customer roster) |
| "What milestones need attention for Contoso?" | **CRM** (fresh state), vault for context |
| "What did we discuss last time about Contoso?" | **Vault** (notes, agent insights) |
| "Create a task for milestone X" | **CRM** (fresh milestone state → write) |
| "Which customers have at-risk milestones?" | **Vault** (roster) → **CRM** (filtered query) |
| "Summarize my account health" | **Vault** (roster + context) → **CRM** (fresh state per customer) |
| "What's the status of opportunity Y?" | **CRM** (always fresh for status) |

**Rule of thumb:** Use vault for *who/what/why* context. Use CRM for *current state* data. When both are needed, vault scopes first, CRM validates second.

### 3. Post-Workflow Promotion (CRM → Vault)

After completing a CRM query or write workflow, promote **validated findings** back to the vault:

1. Append findings to the relevant `Customers/<Name>.md` under `## Agent Insights`.
2. Include a datestamp and brief summary of what was found/changed.
3. If no customer file exists and the customer is now being actively tracked, create `Customers/<Name>.md` with the findings.
4. Do NOT promote speculative or unvalidated information.

### 4. Connect Hook Storage

When capturing Connect-relevant evidence:

1. **Primary**: Append to `Customers/<Name>.md` under `## Connect Hooks` (use `patch_note` with `operation: "append"` and `heading: "Connect Hooks"`).
2. **Create section** if `## Connect Hooks` doesn't exist in the file.
3. **Create file** if no customer file exists — minimal header + hook entry.
4. **Local backup**: Always also write to `.connect/hooks/hooks.md` for repo-tracked persistence.

See `.github/instructions/connect-hooks.instructions.md` for the hook schema and formatting rules.

### 5. Customer Roster as Scope Filter

The vault customer roster acts as a **default filter** for multi-customer operations:

- **Proactive workflows** (e.g., "check my milestones", "what needs attention"): Scope to vault-listed customers only. Past/completed customers without vault files are excluded.
- **Reactive queries** (e.g., "what about Fabrikam?"): If the user explicitly asks about a customer not in the vault, query CRM directly — but note that the customer isn't in their active tracking set.
- **Composite tools**: When using `find_milestones_needing_tasks` or similar batch tools, derive the `customerKeywords` list from the vault roster — don't guess or use a hardcoded list.

## Fallback Behavior (No Vault)

> The Vault Protocol Phases above include per-phase fallback instructions. This section provides the consolidated fallback reference.

When `mcp-obsidian` is unreachable (availability guard fails):
- The agent operates **statelessly** — no persistent memory across sessions. CRM remains the source of truth for live state.
- CRM query scoping reverts to asking the user for customer names or using `crm_whoami` context.
- Connect hooks go to `.connect/hooks/hooks.md` only.
- Vault correlation (VAULT-CORRELATE) is skipped — present M365/CRM evidence without vault enrichment.
- Users who want cross-session persistence without Obsidian can configure their own memory layer (local files, another MCP server, etc.). The agent does not assume any specific fallback directory structure.

## Anti-Patterns

- **Treating vault as optional** — when configured, it IS the local knowledge layer. Don't ignore it and query CRM blind.
- **Stale vault over fresh CRM** — vault context is for scoping and narrative. Never use cached vault data as a substitute for live CRM status when accuracy matters.
- **Querying all CRM data without vault scoping** — if the vault has a customer roster, use it. Don't `get_milestones(mine: true)` to retrieve everything when the vault tells you which 5 customers matter.
- **Promoting unvalidated data to vault** — only write confirmed findings, decisions, and evidence to vault files. Working hypotheses should be discarded at session end, not persisted.
- **Creating vault files for transient customers** — only create `Customers/<Name>.md` for customers the user intends to actively track. One-off CRM lookups don't warrant a vault file unless the user says so.
