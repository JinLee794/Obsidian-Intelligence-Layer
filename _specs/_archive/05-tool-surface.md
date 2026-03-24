# 5. OIL Tool Surface

Tools are organised into three categories. **Orient** and **Retrieve** tools are fully autonomous. **Write** tools follow the tiered gate protocol (see §4.4) — auto-confirmed for low-ceremony appends, gated for high-impact mutations.

---

## 5.1 Orient Tools — autonomous reads

These are the "where am I?" tools. The agent should call these at the start of any session or when context is unclear.

### `get_vault_context`
Returns a high-level map of the vault — its shape, scale, and most important nodes. The agent's first call in any new session.

```typescript
// No parameters required
get_vault_context() → {
  folder_structure: FolderTree,
  note_count: number,
  top_tags: TagCount[],
  most_linked_notes: NoteRef[],   // highest in-degree in the graph
  schema_version: string,         // from oil.config.yaml
  last_indexed: Date
}
```

---

### `get_customer_context`
Full assembled context for a named customer — customer file content, opportunities with GUIDs, team composition, recent meetings, linked people, open action items. This is the primary tool for VAULT-PREFETCH.

```typescript
get_customer_context(
  customer: string,               // customer name or folder name under Customers/
  lookback_days?: number          // how far back to pull meetings/activity, default 90
) → {
  frontmatter: NoteFrontmatter,   // tags, tpid, accountid
  opportunities: OpportunityRef[], // names + GUIDs from ## Opportunities
  milestones: MilestoneRef[],     // IDs/numbers from ## Milestones
  team: TeamMember[],             // from ## Team
  agent_insights: string[],       // from ## Agent Insights
  linked_people: NoteRef[],       // People notes associated with this customer
  recent_meetings: NoteRef[],     // Meeting notes with customer frontmatter match
  open_items: ActionItem[],       // Unchecked task items across customer-linked notes
}
```

> **Design note:** This replaces the original `get_account_context`. It does not call external MCPs (Dynamics, M365) — it returns vault-only data shaped for the copilot to use in VAULT-PREFETCH. The copilot orchestrates any CRM/M365 correlation using the IDs this tool provides.

---

### `get_backlinks`
All notes that link to a given note via `[[wikilinks]]`.

```typescript
get_backlinks(path: string) → NoteRef[]
```

---

### `get_forward_links`
All notes linked from a given note.

```typescript
get_forward_links(path: string) → NoteRef[]
```

---

### `get_related_notes`
Graph neighbours up to N hops from a given note, optionally filtered by note type or tag.

```typescript
get_related_notes(
  path: string,
  hops?: number,                  // default: 2
  filter?: {
    tags?: string[],
    folder?: string,
    frontmatter?: Record<string, unknown>
  }
) → NoteRef[]
```

---

### `get_person_context`
Returns a person's vault profile — their customer associations, org type, company, and linked notes. Used for M365 entity resolution.

```typescript
get_person_context(
  name: string                    // person name (matches People/{name}.md)
) → {
  frontmatter: PersonFrontmatter, // company, org, customers[], tags
  linked_customers: string[],     // resolved customer names
  recent_meetings: NoteRef[],     // meetings where this person appears
  backlinks: NoteRef[]            // all notes linking to this person
}
```

---

### `resolve_people_to_customers`
Batch resolution of person names to customer associations. Primary tool for WorkIQ Entity Resolution (between Pass 1 and Pass 2).

```typescript
resolve_people_to_customers(
  names: string[]                 // list of person names to resolve
) → {
  resolved: Record<string, {      // name → resolution
    customers: string[],
    company: string,
    org: 'internal' | 'customer' | 'partner',
    confidence: 'exact' | 'fuzzy' | 'unresolved'
  }>,
  unresolved: string[]            // names not found in vault
}
```

> **Usage:** After WorkIQ Pass 1 returns meeting attendees or email participants, call this tool to map people → customers. Unresolved names are surfaced to the user or resolved via CRM as a fallback.

---

## 5.2 Retrieve Tools — autonomous reads

Higher-level retrieval operations. These do more work than orient tools — joining data, running queries, assembling composites.

### `search_vault`
Unified search across all three tiers (lexical → fuzzy → semantic). Tier is selected automatically based on config default, or explicitly specified.

```typescript
search_vault(
  query: string,
  tier?: 'lexical' | 'fuzzy' | 'semantic',  // default: from config
  limit?: number,                             // default: 10
  filters?: {
    folder?: string,
    tags?: string[],
    frontmatter?: Record<string, unknown>,
    modified_after?: Date
  }
) → SearchResult[]
```

---

### `query_notes`
Frontmatter predicate query — relational-style filtering across all notes. The SQL-like layer for the vault.

```typescript
query_notes(
  where: Record<string, unknown>,   // e.g. { stage: 'Negotiation', owner: 'alex.chen' }
  and?: Record<string, unknown>[],
  or?: Record<string, unknown>[],
  order_by?: string,
  limit?: number
) → NoteRef[]
```

**Example:** All meeting notes for a specific customer, ordered by date:
```typescript
query_notes({
  where: { customer: 'Contoso', tags: ['meeting'] },
  order_by: 'date',
  limit: 20
})
```

**Example:** All people associated with a customer:
```typescript
query_notes({
  where: { customers: 'Contoso', tags: ['people'] }
})
```

---

### `get_customer_brief`
Composite tool — assembles everything the agent needs to brief on a customer in a single call: customer file, opportunities with GUIDs, team, recent meetings, open items, similar past patterns.

```typescript
get_customer_brief(
  customer: string,               // customer name
  include_similar?: boolean       // default: true — find similar customer patterns
) → CustomerBrief
```

---

### `get_open_items`
All unresolved action items across a customer, parsed from task syntax (`- [ ]`) in linked notes.

```typescript
get_open_items(
  customer: string,
  assignee?: string,              // filter to specific person
  overdue_only?: boolean
) → ActionItem[]
```

---

### `find_similar_notes`
Semantic or tag-based similarity to a given note — useful for surfacing relevant patterns, comparable customers, or risk signals.

```typescript
find_similar_notes(
  path: string,                   // any note path
  top_n?: number,                 // default: 5
  method?: 'semantic' | 'tags'   // default: semantic if enabled, else tags
) → NoteRef[]
```

---

## 5.3 Write Tools — tiered gate

Write tools follow the tiered gate protocol (§4.4). **Auto-confirmed** tools execute immediately (append-only, low-risk). **Gated** tools return a diff for human review.

### Auto-confirmed writes

### `patch_note`
Appends content to a specific heading section within a note. The workhorse operation for VAULT-PROMOTE and Connect hook capture. **Auto-confirmed when targeting designated sections** (Agent Insights, Connect Hooks). Gated for other sections.

```typescript
patch_note(
  path: string,                   // note path
  heading: string,                // target heading (e.g. "Agent Insights")
  content: string,                // content to append
  operation: 'append' | 'prepend' // default: append
) → void | WriteDiff              // auto-confirmed for designated sections, diff for others
```

---

### `capture_connect_hook`
Appends a formatted Connect hook entry to the customer file and backup location. Auto-confirmed.

```typescript
capture_connect_hook(
  customer: string,               // customer name
  hook: {
    date: string,                 // ISO date
    circles: ('Individual' | 'Team/Org' | 'Customer/Business')[],
    hook: string,                 // what happened
    evidence: string,             // measurable proof
    source: string,               // PR / Issue / Doc / Thread
    next_step: string
  }
) → void
```

> Writes to `Customers/{customer}.md` § `## Connect Hooks` (primary) and `.connect/hooks/hooks.md` (backup).

---

### `log_agent_action`
Records an agent decision, recommendation, or reasoning trace to `_agent-log/`. Always auto-confirmed — this is the audit trail, not user content.

```typescript
log_agent_action(
  action: string,
  context: Record<string, unknown>,
  session_id: string
) → void
```

---

### Gated writes

### `draft_meeting_note`
Generates a structured meeting note from a transcript or summary. Returns a diff showing the note that will be created. Side-effect appends to `## Agent Insights` on the customer file are auto-confirmed.

```typescript
draft_meeting_note(
  customer: string,               // customer name
  content: string,                // transcript or bullet summary
  attendees?: string[],
  date?: Date,                    // default: today
  template?: string               // template name from config
) → WriteDiff
```

---

### `update_customer_file`
Proposes updates to a customer file’s frontmatter or designated sections. Useful after discovering new opportunity GUIDs, team changes, or status updates.

```typescript
update_customer_file(
  customer: string,
  updates: {
    frontmatter?: Partial<CustomerFrontmatter>,
    sections?: Record<string, string>  // heading → content to set (not append)
  }
) → WriteDiff
```

---

### `create_customer_file`
Scaffolds a new customer file when onboarding a new account. Gated — creates a new file in the vault.

```typescript
create_customer_file(
  customer: string,               // customer name
  initial_data?: {
    tpid?: string,
    accountid?: string,
    opportunities?: OpportunityRef[],
    team?: TeamMember[]
  },
  template?: string               // default: 'default-customer'
) → WriteDiff
```

---

### `apply_tags`
Proposes tag additions across a set of notes based on a query result. Surfaces a batch diff showing all notes that will be updated.

```typescript
apply_tags(
  paths: string[],
  tags: string[],
  operation: 'add' | 'remove'
) → WriteDiff
```

---

### `write_note` (base)
Low-level write inherited from base mcp-obsidian, wrapped in the confirmation gate. Always gated regardless of mode (`overwrite`, `append`, `prepend`).

---

*Previous: [Core Capabilities ←](./04-core-capabilities.md) · Next: [Configuration →](./06-configuration.md)*
