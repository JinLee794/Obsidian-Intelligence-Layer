# 7. Key Integration Flows

Four worked examples of how OIL operates as the knowledge layer within a copilot-orchestrated multi-MCP stack. In each flow, the **copilot** is the orchestrator — it decides which MCPs to call and in what order. OIL provides vault reads and writes; CRM and M365 data comes from their respective MCPs.

The flows reference the vault protocol phases defined in §3.4:
- **VAULT-PREFETCH** — resolve IDs and context from vault before calling external MCPs
- **VAULT-CORRELATE** — cross-reference vault data with external MCP results
- **VAULT-PROMOTE** — persist validated findings back to vault
- **VAULT-HYGIENE** — cleanup stale data (periodic, not per-request)

---

## 7.1 Pre-call Brief

**Trigger:** *"Prepare me for my Contoso call at 2pm"*
**Mode:** Fully autonomous reads — no writes, no confirmation required

```
── VAULT-PREFETCH ──────────────────────────────────────────────
1. Copilot calls OIL: get_customer_context('Contoso')
   → Vault returns: customer file frontmatter (TPID, account ID),
     opportunity GUIDs, team composition, open items,
     recent meeting notes, agent insights, linked people

── External MCPs (copilot-orchestrated) ────────────────────────
2. Copilot calls CRM MCP: crm_query with vault-provided opportunity GUIDs
   → Live pipeline stage, milestone status, opportunity value

3. Copilot calls WorkIQ MCP: ask_work_iq for recent Contoso activity
   → Recent email threads, upcoming meetings, SharePoint docs

── VAULT-CORRELATE (copilot-side) ──────────────────────────────
4. Copilot correlates:
   → Vault stage vs CRM stage — flag drift
   → Vault last-activity vs M365 last-activity — flag communication gaps

5. Copilot calls OIL: find_similar_notes('Customers/Contoso.md', top_n: 3)
   → Similar customer patterns, relevant playbook references

── Synthesis ───────────────────────────────────────────────────
6. Copilot synthesises briefing in chat
   → Account status, deal stage delta, recent activity summary,
     open items, recommended talking points, similar patterns
   → No vault writes (pure read flow)
```

**What the user sees:** A structured briefing assembled from 3 systems in a single response, with no manual note-hunting.

---

## 7.2 Post-call Note Capture

**Trigger:** *"Log notes from my Contoso call"* + transcript or bullet summary
**Mode:** VAULT-PREFETCH → gated write → VAULT-PROMOTE

```
── VAULT-PREFETCH ──────────────────────────────────────────────
1. Copilot calls OIL: get_customer_context('Contoso')
   → Retrieves customer context for note enrichment

── Gated write ─────────────────────────────────────────────────
2. Copilot calls OIL: draft_meeting_note(customer: 'Contoso', content: <transcript>)
   → OIL parses content: extracts attendees, action items, key decisions
   → Structures note using template (if configured)
   → Generates diff — NO write yet

3. Diff surfaced to user in chat:
   ┌─────────────────────────────────────────────────────────┐
   │ Will create: Meetings/2026-03-01 - Contoso Platform.md  │
   │                                                         │
   │ [Preview of meeting note content]                       │
   │                                                         │
   │ Reply confirm to execute, or describe changes.          │
   └─────────────────────────────────────────────────────────┘

4. User reviews, types "confirm" (or requests edits)

── VAULT-PROMOTE (auto-confirmed) ──────────────────────────────
5. On confirm:
   → Meeting note created (gated write executed)
   → patch_note: appends summary to Customers/Contoso.md § Agent Insights (auto-confirmed)
   → Action items flagged in meeting note
   → Write logged to _agent-log/
```

---

## 7.3 Weekly Pipeline Review

**Trigger:** *"Run my weekly pipeline review"*
**Mode:** VAULT-PREFETCH → external correlation → gated batch write

```
── VAULT-PREFETCH ──────────────────────────────────────────────
1. Copilot calls OIL: query_notes({ where: { tags: ['customer'] }, order_by: 'date' })
   → All customer files, ordered by last activity

── External MCPs (copilot-orchestrated) ────────────────────────
2. Copilot calls CRM MCP: batch milestone/opportunity queries using vault-provided GUIDs
   → Live pipeline stages, milestone statuses

3. Copilot calls WorkIQ MCP: recent activity per customer
   → Email/meeting recency for communication gap detection

── VAULT-CORRELATE (copilot-side) ──────────────────────────────
4. Copilot correlates per customer:
   → Vault data vs CRM live state — flag stage drift
   → Communication recency — flag silent accounts

5. Copilot calls OIL: get_open_items(overdue_only: true)
   → Surface overdue action items across vault

── Synthesis ───────────────────────────────────────────────────
6. Copilot synthesises in chat:
   → Pipeline health summary (N customers by status)
   → Stale accounts (no activity in 14+ days)
   → Milestone drift or risk flags
   → Overdue action items by customer
   → Recommended next actions

── VAULT-PROMOTE (gated batch) ─────────────────────────────────
7. Copilot proposes batch write via OIL:
   → update_customer_file diffs for status corrections
   → Batch diff: "3 customer files need updates. Review:"
      Contoso: added new milestone IDs
      Fabrikam: status → at-risk
      Woodgrove: closed-won, archive candidate
   → User confirms batch or selects individually

8. Confirmed writes executed, logged to _agent-log/
```

---

## 7.4 New Customer Onboarding

**Trigger:** *"There's a new opportunity with Northwind — set up the customer file"*
**Mode:** CRM read → gated write

```
── External MCP ────────────────────────────────────────────────
1. Copilot calls CRM MCP: search for Northwind opportunity
   → Returns opportunity GUID, account TPID, contacts, value, stage

── Gated write ─────────────────────────────────────────────────
2. Copilot calls OIL: create_customer_file(
     customer: 'Northwind',
     initial_data: { tpid, accountid, opportunities: [...], team: [...] }
   )
   → Scaffolds Customers/Northwind.md with frontmatter and sections
   → Diff surfaced for confirmation

3. User confirms → file created → indexed into graph

── VAULT-PROMOTE (auto-confirmed) ──────────────────────────────
4. patch_note: appends onboarding context to § Agent Insights
   → "Customer file created from CRM opportunity OPP-00456"
```

---

*Previous: [Configuration ←](./06-configuration.md) · Next: [Roadmap →](./08-roadmap.md)*
