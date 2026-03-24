# 6. User Configuration (`oil.config.yaml`)

The central design principle for adoptability: **all behaviour is driven by a config file in the vault root, not by code.** Users can fork the config to match their existing vault structure and workflow without touching the server.

The config file lives at `{vault-root}/oil.config.yaml`. OIL reads it on startup and on every full index rebuild.

---

## Full schema with defaults

```yaml
# oil.config.yaml
# OIL reads this from the vault root on startup.
# All fields have defaults — only override what you need.

# ─── Vault structure ──────────────────────────────────────────────────────────
schema:
  customers_root: Customers/        # Flat folder: one .md per customer
  people_root: People/              # Contact / relationship notes
  meetings_root: Meetings/          # Meeting notes (YYYY-MM-DD - Topic.md)
  projects_root: Projects/          # Project-level notes
  weekly_root: Weekly/              # Weekly summaries / pipeline reviews
  templates_root: Templates/        # Shared templates and playbooks
  agent_log: _agent-log/            # Agent decision trail (auto-written)
  connect_hooks_backup: .connect/hooks/hooks.md  # Connect evidence backup

# ─── Frontmatter field mapping ────────────────────────────────────────────────
# Tell OIL which frontmatter fields map to which concepts.
# This lets OIL work with your existing note structure without reformatting it.
frontmatter_schema:
  customer_field: customer          # Field linking a note to a customer name
  tags_field: tags                  # Multi-value tag field
  date_field: date                  # Primary date field
  status_field: status              # Note status (active, completed, etc.)
  project_field: project            # Project association
  tpid_field: tpid                  # MS Sales TPID (on customer files)
  accountid_field: accountid        # CRM account GUID (on customer files)

# ─── Search configuration ─────────────────────────────────────────────────────
search:
  default_tier: fuzzy               # lexical | fuzzy | semantic
  semantic_model: local             # local | openai | azure-openai
  # Only required if semantic_model is not 'local':
  # semantic_api_key: ${OPENAI_API_KEY}
  # semantic_endpoint: https://your-instance.openai.azure.com/
  semantic_index_file: _oil-index.json  # Where to cache the vector index

# ─── Write gate ───────────────────────────────────────────────────────────────
write_gate:
  diff_format: markdown             # markdown | json
  log_all_writes: true              # Append every confirmed write to _agent-log/
  batch_diff_max_notes: 50          # Max notes shown in a batch diff before summarising

  # Tier 1 — auto-confirmed (append-only, low-risk)
  auto_confirmed_sections:
    - "Agent Insights"
    - "Connect Hooks"
  auto_confirmed_operations:
    - log_agent_action
    - capture_connect_hook
    - patch_note_designated          # patch_note targeting auto_confirmed_sections

  # Tier 2 — gated (human confirmation required)
  # Everything not in auto_confirmed is gated by default.
```

---

## Skills — copilot-level, not server-level

> **Design decision:** User-defined multi-step workflows are defined at the copilot orchestration layer (`.github/skills/*.md`), not inside OIL's config. OIL provides the atomic tools; the copilot sequences them.

The `skills` block has been **removed** from `oil.config.yaml`. The rationale:

1. **OIL is a knowledge layer**, not an orchestrator. Multi-step flows that span OIL + CRM + M365 belong in the copilot layer, which already has the routing logic.
2. The copilot instruction system (`.github/skills/` + `.github/instructions/`) already supports role-specific skill definitions (SE, CSA, CSAM, Specialist) with richer context than a YAML step list can express.
3. Keeping skills at the copilot level means they can reference any MCP — not just OIL tools — in a single flow.

If a future version of OIL needs server-side macros (e.g., for scheduled background jobs without a copilot in the loop), the `skills` block can be reintroduced with a narrower scope: vault-only operations that don't depend on external MCPs.

---

*Previous: [Tool Surface ←](./05-tool-surface.md) · Next: [Integration Flows →](./07-integration-flows.md)*
