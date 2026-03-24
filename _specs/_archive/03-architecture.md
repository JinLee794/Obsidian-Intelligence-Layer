# 3. Architecture Overview

## 3.1 System Layers

The architecture consists of four layers stacked on top of the existing vault filesystem:

```
┌─────────────────────────────────────────────────────────┐
│  4. Agent Skills Layer                                   │
│     Composite operations + user-defined workflow tools   │
├─────────────────────────────────────────────────────────┤
│  3. Intelligence Layer                                   │
│     Graph index · Semantic search · Session context      │
│     Correlation engine                                   │
├─────────────────────────────────────────────────────────┤
│  2. OIL MCP Server                                       │
│     Enhanced tool surface exposed via MCP protocol       │
├─────────────────────────────────────────────────────────┤
│  1. Vault Filesystem                                     │
│     Raw .md files — unchanged, Obsidian-compatible       │
│     bitbonsai low-level tools remain available           │
└─────────────────────────────────────────────────────────┘
```

**The key principle:** the filesystem is never bypassed. All writes go through the confirmation gate, and the vault remains human-readable and Obsidian-compatible at all times.

---

## 3.2 Integration Map

| System | Direction | Role in the flow |
|--------|-----------|-----------------|
| **Obsidian Vault** | Read / Write (tiered gate) | Durable memory — customer context, meeting notes, people, agent insights, Connect hooks, MSX identifier bridge |
| **WorkIQ (M365)** | Read | Email threads, calendar events, Teams messages — correlated to vault customers via People notes |
| **Dynamics/MSX MCP** | Read / Write (role-gated) | Live deal data, milestones, tasks, pipeline stage — scoped by vault-provided identifiers |
| **Copilot Orchestration** | Controller | Skills (`.github/skills/`) and instructions (`.github/instructions/`) compose cross-MCP workflows at the copilot level |
| **OIL MCP Server** | Knowledge layer | Smart vault access — graph-aware reads, semantic search, structured writes, entity resolution |

**Key architectural decision:** OIL is a **knowledge layer**, not an orchestration hub. It does not call CRM or M365 MCPs internally. The copilot orchestrates across MCPs, using OIL to resolve identifiers (VAULT-PREFETCH), enrich context (VAULT-CORRELATE), and persist findings (VAULT-PROMOTE). This keeps each MCP focused on its domain and avoids coupling OIL to external system schemas.

---

## 3.3 Vault Schema Convention

The system assumes — and learns from config — a canonical folder structure. Users override this via `oil.config.yaml` in the vault root (see [Configuration](./06-configuration.md)).

### Default schema

```
Customers/
  {CustomerName}.md        ← one file per actively-tracked customer
                              frontmatter-rich, sections for Opportunities, Milestones,
                              Team, Agent Insights, Connect Hooks, Notes

People/
  {Full Name}.md           ← contact/stakeholder notes (internal, customer, partner)
                              frontmatter: company, org, customers[], tags

Meetings/
  YYYY-MM-DD - {Topic}.md  ← meeting notes, linked to customers and people
                              frontmatter: date, customer, project, status, action_owners

Projects/
  {ProjectName}.md         ← cross-customer or internal project tracking

Daily/
  YYYY-MM-DD.md            ← daily log notes

Weekly/
  YYYY-W{XX}.md            ← weekly digest summaries

Templates/
  ...                      ← note templates

_agent-log/
  YYYY-MM-DD.md            ← agent decision trail, auto-written, human-reviewable
```

### Customer file (`Customers/{Name}.md`) — expected structure

Each customer file is the single source of local truth for that customer. Sections are additive — create them as content arrives, don't pre-populate empty headings.

```yaml
---
tags: [customer]
tpid: "12345"           # MS Top Parent ID (optional, for CRM scoping)
accountid: "ACC-00123"  # Dynamics account ID (optional)
---
```

| Section | Purpose |
|---------|--------|
| `# {CustomerName}` | Header |
| `## Team` | Account team members, roles, stakeholder contacts |
| `## Opportunities` | Active opportunity names AND GUIDs (`opportunityid: <GUID>`). Primary bridge from customer name → MSX identifiers. |
| `## Milestones` | Milestone-level notes, commitments, context not in CRM. Include milestone IDs/numbers when known. |
| `## Agent Insights` | Validated findings promoted from working memory (auto-confirmed append) |
| `## Connect Hooks` | Evidence capture entries per Connect schema (auto-confirmed append) |
| `## Notes` | Free-form meeting notes, decisions, observations |

### People file (`People/{Name}.md`) — expected frontmatter

```yaml
---
tags: [people]
company: "Contoso Ltd"
org: customer             # internal | customer | partner
customers: [Contoso]      # customer accounts this person is associated with
---
```

People notes are the **critical bridge** between M365 activity and customer attribution. When WorkIQ returns meeting attendees or email participants, the agent resolves them to customer accounts via People note frontmatter.

### Meeting file (`Meetings/YYYY-MM-DD - {Topic}.md`) — expected frontmatter

```yaml
---
tags: [meeting]
date: 2026-03-01
customer: Contoso
project: Platform Migration
status: open
action_owners: [Alex Chen, Sarah Okafor]
---
```

> **Convention, not constraint.** OIL reads `oil.config.yaml` to learn the user's actual folder structure and frontmatter field names. Existing vaults can be adopted incrementally — OIL degrades gracefully when schema is partial.

---

## 3.4 Vault Protocol Phases

OIL formalises four named phases that skills and workflows reference by name instead of reimplementing vault logic inline. Each phase has an availability guard — if the vault is unreachable, the phase is skipped gracefully.

### VAULT-PREFETCH
**When:** Before any CRM query or multi-customer workflow.
**Purpose:** Resolve customer→MSX identifiers from vault notes so CRM queries use precise IDs instead of broad discovery.

- Read `Customers/` directory to identify the active roster.
- Read `Customers/{Name}.md` and extract opportunity GUIDs, account IDs, team composition, milestone IDs.
- Inject vault-provided IDs directly into CRM `$filter` expressions.
- **Critical rule:** If the vault has the opportunity GUID, use it directly. Do not run CRM discovery queries for identifiers the vault already provides.

### VAULT-CORRELATE
**When:** After retrieving M365/WorkIQ evidence or CRM data.
**Purpose:** Cross-reference retrieved activities with vault notes for richer context; resolve people to customer associations.

- Resolve People → Customer via `People/` notes (frontmatter `customers`, `company`, `org`).
- Search vault by customer and date range for related meeting notes, decisions, action items.
- Surface connections that enrich the retrieved data.

### VAULT-PROMOTE
**When:** After completing a CRM/M365 workflow with validated findings.
**Purpose:** Persist validated findings to the vault for future context.

- Append to `Customers/{Name}.md` under `## Agent Insights` (auto-confirmed).
- Write back newly discovered MSX identifiers (opportunity GUIDs, milestone IDs) to customer file.
- Append Connect hooks to `## Connect Hooks` (auto-confirmed).

### VAULT-HYGIENE
**When:** Periodic review, governance cadence, or on-demand.
**Purpose:** Keep vault data current and aligned with CRM reality.

- Flag stale Agent Insights (>30 days).
- Cross-reference vault customer roster with active CRM opportunities.
- Recommend additions/removals — never auto-delete vault content.

---

## 3.5 Data Flow — Read vs Write

```
READ PATH (autonomous)
  Agent → OIL tool call
        → Graph index / file read / entity resolution
        → Structured response returned to agent
        → No human involvement

WRITE PATH (tiered gate)
  Auto-confirmed writes (low-ceremony):
    Agent → OIL append tool (Agent Insights, Connect Hooks, ID writeback)
          → OIL executes append, logs to _agent-log/
          → No human confirmation required

  Gated writes (high-impact):
    Agent → OIL write tool call
          → OIL generates structured diff (no mutation yet)
          → Diff returned to agent → surfaced to human in chat
          → Human reviews and confirms (or cancels)
          → On confirmation: OIL executes write, logs to _agent-log/
```

---

*Previous: [Problem Statement ←](./02-problem-statement.md) · Next: [Core Capabilities →](./04-core-capabilities.md)*
