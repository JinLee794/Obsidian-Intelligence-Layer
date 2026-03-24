# 10. Success Criteria

The system is working when these are all true.

---

## Agent intelligence

**The agent can orient itself without instructions.**
Given a vault it hasn't seen before, the agent can call `get_vault_context`, understand the customer structure, and begin retrieving relevant context — without the user having to specify which notes to read.

**Vault-first ID resolution eliminates discovery queries.**
When the copilot needs an opportunity GUID for a CRM query, `get_customer_context` returns it from the vault directly. The copilot does not need to chain `list_opportunities` → `crm_query` → filter. VAULT-PREFETCH cuts CRM round-trips by ≥50% for known customers.

**People→Customer resolution works across mediums.**
Given a person name from an M365 email or meeting (via WorkIQ), `resolve_people_to_customers` maps them to the correct customer file with high confidence. This bridges the M365↔vault gap that the current workflow cannot resolve automatically.

**Cross-system context in a single response.**
"What's the status of our Contoso relationship?" triggers the copilot to call OIL for vault context, CRM MCP for live state, and WorkIQ for recent activity — and synthesise a coherent answer. OIL provides the knowledge layer; the copilot orchestrates.

---

## Workflow speed

**Post-call capture under 60 seconds.**
From "log my call" + transcript to confirmed, structured meeting note written to `Meetings/` — under 60 seconds elapsed. Agent Insights auto-appended to customer file without additional confirmation.

**Pipeline review in one command.**
"Run my weekly pipeline review" triggers the copilot to call OIL for customer data, CRM for live milestones, and synthesise a health report with actionable recommendations — without the user issuing multiple commands.

---

## Vault protocol phases compose correctly

**VAULT-PREFETCH shapes external queries.**
Customer context retrieved from vault (GUIDs, TPIDs, team) is directly usable as filter parameters in CRM MCP calls. No data transformation required between OIL output and CRM input.

**VAULT-PROMOTE persists without friction.**
After a CRM workflow discovers new information (milestone IDs, status changes), `patch_note` appends findings to the customer file's Agent Insights section without requiring human confirmation. The vault stays current.

**VAULT-HYGIENE detects staleness.**
OIL can surface customer files whose data hasn't been validated against CRM within a configurable window. Periodic cleanup is automated, per-file remediation is gated.

---

## Connect evidence capture

**Connect hooks flow to the right place.**
`capture_connect_hook` writes evidence to the customer file's Connect Hooks section and the backup location — auto-confirmed, no friction, formatted per the Connect schema.

---

## Vault integrity

**The vault stays native.**
Every file in the vault is valid, human-readable Obsidian markdown. No proprietary schemas, no binary files, no files that can't be opened and edited manually.

**Every agent write has an audit trail.**
Every vault mutation initiated by an agent has a corresponding entry in `_agent-log/` showing: what was proposed, what was confirmed, when, and by whom.

**Tiered gate is enforced.**
Tier 1 auto-confirmed writes only touch designated sections (Agent Insights, Connect Hooks) and the agent log. There is no code path by which an auto-confirmed operation creates a new file or overwrites user content. Tier 2 gated writes always surface a diff. This is verified by test.

---

## Adoption

**Zero vault disruption.**
A user with an existing Obsidian vault can point OIL at it, fill in `oil.config.yaml` with their folder names, and have the orient/retrieve tools working — without reorganising a single file.

**Degrades gracefully.**
If CRM or M365 MCPs are unavailable, OIL still provides full value from the vault alone. The copilot adjusts synthesis depth to match available mediums. Features requiring external data surface appropriate fallbacks rather than errors.

---

*Previous: [Open Questions ←](./09-open-questions.md) · Back to [README →](./README.md)*
