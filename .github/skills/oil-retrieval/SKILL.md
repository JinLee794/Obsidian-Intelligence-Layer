---
name: oil-retrieval
description: "Use when: discovering, searching, reading, traversing, or safely updating knowledge in an Obsidian vault through the Obsidian Intelligence Layer (OIL) MCP tools. Covers catalog orientation, structured identifiers, unknown-field recovery, bounded section reads, pagination, ambiguity, freshness, and mtime-safe writes."
---

# OIL Retrieval Policy

Use OIL as the stateful catalog substrate. Do not reconstruct its frontmatter index, link graph, freshness checks, or pagination with filesystem scans.

## Route the Request

1. **Direct path or unique note name:** call `get_note_metadata`.
2. **Structured identifier or predicate** (TPID, account ID, owner, status, date, code): call `query_frontmatter`.
3. **Named entity, alias, topic, or natural-language phrase:** call `search_vault`.
4. **Broad request with unknown vault layout or field names:** call `inspect_catalog`, then search or query using the returned evidence.

Orientation is conditional. Do not call `inspect_catalog` before a direct path, unique title, or known structured identifier.

## Progressive Read

1. Generate no more than five search candidates by default.
2. Inspect metadata for only the best one to three refs.
3. Read the relevant heading with `read_note_section`; do not load an entire note when a section answers the task.
4. Follow `get_related_entities` only when relationships add needed context; default to one hop.
5. Stop as soon as the available evidence answers the request.

## Recovery Rules

- On `UNKNOWN_FIELD`, use returned suggestions or `inspect_catalog(view="fields")`, then retry once. Never interpret it as proof that the knowledge is absent.
- On a known field with zero matches, broaden once using `search_vault` or a catalog-supported field variant.
- On `AMBIGUOUS_REF` or ambiguous-link evidence, present or inspect candidate refs; never choose by title alone.
- On a missing heading, select from `available_headings` and retry exactly.
- When `truncated` is true, use `next_cursor` only if more evidence is needed.
- On `INVALID_CURSOR`, restart the same operation without a cursor against the current generation.
- Surface `stale`, `reconciling`, parse-error, or truncation warnings when they may affect the answer.

## Safe Writes

1. Read `get_note_metadata` immediately before updating.
2. Preserve unknown frontmatter and existing links.
3. Use `atomic_append` when a section-level addition is sufficient; use `atomic_replace` only for intentional full-note replacement.
4. Pass the current `mtime_ms` as `expected_mtime`.
5. On `CONFLICT`, re-read, merge the user's current content, and retry only with fresh confirmation when required by the host workflow.
6. Treat `catalog_state="current"` as immediately searchable. If `catalog_state="pending"`, re-check health or metadata before claiming catalog visibility.

## Output Discipline

- Cite returned refs rather than reconstructing paths from titles.
- Distinguish authored metadata from derived title, description, or type provenance.
- Summarize only the sections retrieved; do not imply that uninspected notes were reviewed.
