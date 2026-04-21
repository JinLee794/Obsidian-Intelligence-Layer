---
name: memory
description: 'Use OIL as a deterministic memory substrate while keeping workload policy in the skill. Trigger when the task is about remembering decisions, retrieving customer context, repairing notes safely, or choosing between summary visibility and detailed audit reads.'
argument-hint: 'Describe the memory workload: capture, retrieve, repair, summarize, or diagnose'
allowed-tools: mcp_oil_*
---

# OIL Memory Policy

Use this skill when the task is fundamentally about memory workflows rather than raw file I/O.

## Goal

Keep deterministic structure in OIL, and keep preference-heavy judgment in the skill.

- OIL decides paths, entity resolution, freshness anchors, and conflict boundaries.
- The skill decides retrieval depth, summarization style, escalation, and whether the workload is capture, retrieve, repair, or diagnose.

## Workflow

### 1. Choose the cheapest visibility surface first

- Call `get_health` when you need runtime status, index freshness, or audit availability.
- Call `get_agent_log` only when you need the detailed write trail for a specific day.

### 2. Choose the right retrieval shape

- Use `get_customer_context(view="brief")` for compact recall.
- Use `get_customer_context(view="full")` when the agent needs the full assembled customer state.
- Use `get_customer_context(view="write")` when the next step is likely to update the customer note and you need deterministic write targets.
- Use `get_note_metadata` before any write flow that depends on `mtime_ms`.
- Use `read_note_section` when a single heading is enough.
- Use `get_related_entities` to widen context without loading full note bodies.

### 3. Apply write discipline

- Prefer `atomic_append` when updating an existing heading.
- Use `atomic_replace` only when a full-note rewrite is necessary.
- Use `create_note` only for absent files.
- If a write returns `error_code: "CONFLICT"`, re-read fresh state before retrying.

### 4. Match policy to workload

- Capture: prefer deterministic targets, short summaries, and append-only updates.
- Retrieve: prefer the smallest response profile that answers the question.
- Repair: inspect metadata first, then perform one atomic write with fresh `mtime_ms`.
- Diagnose: start with `get_health`, then move to `check_vault_health` or `get_agent_log` only if needed.

## Guardrails

1. Do not guess write targets when OIL can resolve them.
2. Do not skip `get_note_metadata` before mtime-guarded writes.
3. Do not use detailed audit reads as the first visibility step.
4. Prefer existing parameterized tools over inventing new near-duplicate workflows.