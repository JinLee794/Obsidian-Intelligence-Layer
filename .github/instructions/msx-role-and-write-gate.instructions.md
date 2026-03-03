---
description: "Use for MSX/MCEM CRM operations, milestone/task updates, role-based workflow routing, and any create/update/close action via MCP tools. Enforces role mapping from CRM user profile and human-in-the-loop confirmation before write operations."
applyTo: "mcp-server/**"
---
# MSX Role Mapping + Write Confirmation Gate

## Scope
- Applies when working with MSX/MCEM CRM workflows, especially when using:
  - `crm_auth_status`, `crm_whoami`, `crm_get_record`, `crm_query`, `get_milestones`, `get_milestone_activities`
  - `create_task`, `update_task`, `close_task`, `update_milestone`

## 0) CRM Read Scoping (Required before bulk reads)
Before calling any CRM read tool that may return large result sets (especially `get_milestones` with `mine: true`):
1. **VAULT-PREFETCH first**: If `mcp-obsidian` is available, read `Customers/<Name>.md` for the target customer to extract known opportunity GUIDs, account IDs, and team context. Use these IDs directly in CRM queries — do not run CRM discovery queries for identifiers the vault already has. (See `obsidian-vault.instructions.md` § VAULT-PREFETCH.)
2. **Confirm the user's role** (see §1 below).
3. **Ask scoping questions only if the vault didn't resolve scope**: which opportunity/customer, which status, what time range, or what specific data is needed.
4. **Prefer `crm_query`** with `$filter`, `$select`, `$top` for targeted lookups over bulk `get_milestones(mine: true)`.
5. **Use `get_milestones` with a specific `opportunityId` or `milestoneId`/`milestoneNumber`** when you have the identifier (from vault or user).
6. Only use `get_milestones(mine: true)` (unfiltered) if the user explicitly requests all milestones and you have warned about volume.

## 1) Role Resolution (Required before workflow guidance)
1. Identify current user via `crm_auth_status` (or `crm_whoami`).
2. Fetch profile data using `crm_get_record` for `systemusers(<userId>)` with available identity fields (for example: name/title/email/business unit).
3. Map the user to one of these role workflows:
   - `Specialist` → `.github/instructions/role-card-specialist.instructions.md`
   - `Solution Engineer` → `.github/instructions/role-card-se.instructions.md`
   - `Cloud Solution Architect` → `.github/instructions/role-card-csa.instructions.md`
   - `Customer Success Account Manager` → `.github/instructions/role-card-csam.instructions.md`
4. If mapping is ambiguous or multiple roles match:
   - Present top 1–2 likely role mappings with reasons.
   - Ask the user to confirm role before proceeding.
5. If mapping is unknown:
   - Do not invent a role.
   - Ask the user which role workflow to apply.

## 2) Role-Bound Execution Rules
- Use the selected role skill as the primary workflow contract for:
  - boundary decisions,
  - stage/ownership checks,
  - handoff format,
  - escalation triggers.
- If a requested action conflicts with the selected role boundary, call out the conflict and propose the correct owner/route.

## 3) Mandatory Plan Mode for Write-Intent Actions
Before calling any write-intent tool (`create_task`, `update_task`, `close_task`, `update_milestone`), always run a confirmation step.

### Required confirmation packet (must be shown to user)
- Role being applied (SE/CSA/CSAM/Specialist)
- Customer/account name
- Opportunity name + ID
- Milestone/task name + ID
- Current values relevant to the change
- Proposed new values
- Why the change is needed (business intent)
- Expected impact and any risk

### Confirmation language
Ask for explicit approval in a separate step, for example:
- "Please confirm this update is correct. Reply: `approve` to proceed or `revise` to change details."

Rules:
- Do not perform write-intent calls in the same response that first proposes changes.
- If any identity field (customer/opportunity/milestone/task) is missing, stop and ask for it.
- For multi-record changes, list each record and require clear approval for the full set.

## 4) Safety and Auditability
- Re-state identifiers before executing write-intent operations.
- Prefer smallest possible change set.
- After each write-intent operation, return a concise result summary and any follow-up verification read.
- If write tools are currently dry-run/mock, still require the same confirmation flow.

## 5) Output Style for MSX Operations
When producing action recommendations or preflight checks, use this order:
1. Role selected + confidence
2. Workflow checks (pass/fail)
3. Proposed action plan
4. Confirmation packet
5. Await approval
