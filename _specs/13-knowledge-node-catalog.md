# OIL Knowledge Node Catalog and Retrieval Reliability Specification

**Working title:** Knowledge Node Catalog (KNC)
**Version:** 0.2
**Status:** Implemented in OIL 0.6.0
**Compatibility model:** Compatibility-first; no required migration of existing Obsidian notes
**Last investigated:** 2026-07-11
**Implemented:** 2026-07-11
**Reference:** [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

**Normative interpretation:** Sections 2–14 define the implemented contract. Section 15 preserves pre-implementation evidence and post-implementation measurements. Sections 17–20 define the acceptance and regression contract.

---

## 1. Motivation

Before OIL 0.6.0, users reported two recurring failures despite OIL's fast vault access:

1. Agents cannot reliably discover which notes or frontmatter fields exist before searching.
2. Frontmatter-backed retrieval can return an unexplained empty result even when relevant notes exist.

The underlying issue is larger than one query function. OIL has useful indices, but it does not yet expose a coherent **knowledge catalog contract** to consumption agents. Search, frontmatter lookup, graph traversal, and persisted-index freshness each expose a different partial view of a note. The agent is therefore expected to guess the right field names, folders, search terms, and retrieval path.

OKF addresses a related problem by making a bundle self-describing through a small document model, path-derived concept IDs, frontmatter, links, and progressive directory indexes. OIL should adopt those principles without requiring users to rewrite an existing Obsidian vault into a strict new format.

This specification defines a compatibility-first catalog layer that:

- indexes every readable note, including notes with no frontmatter;
- observes and exposes the vault's actual frontmatter schema instead of assuming one;
- gives agents a progressive discovery path before deep retrieval;
- makes frontmatter and body content first-class search signals;
- reports ambiguity, unknown fields, truncation, parse failures, and stale indices explicitly;
- preserves OIL's token-efficient reads and small MCP tool surface.

The intended result is not merely better search ranking. It is a reliable protocol for how agents discover, retrieve, traverse, and safely manage knowledge nodes.

### 1.1 Goals

1. Define a canonical logical representation for every indexed Obsidian note.
2. Make the vault self-describing to agents without requiring note migration.
3. Provide deterministic, type-aware frontmatter lookup across arbitrary user fields.
4. Improve retrieval recall across titles, aliases, frontmatter, headings, links, and the full body.
5. Support progressive disclosure so agents can orient before loading note content.
6. Make index freshness and incomplete results visible in every relevant response.
7. Define measurable retrieval-quality, freshness, compatibility, and token-budget criteria.
8. Preserve unknown frontmatter and tolerate heterogeneous note structures.

### 1.2 Non-goals

- Defining a universal taxonomy of note types.
- Requiring `type`, `title`, `description`, or any other new field on existing notes.
- Replacing Obsidian's UI, plugins, Bases, Dataview, or native wikilinks.
- Requiring embeddings, an external vector database, or a hosted model.
- Converting the user's vault into a generated OKF bundle.
- Making paths permanently stable across arbitrary file moves.
- Moving retrieval policy, summarization style, or user-specific judgment into the MCP server.

---

## 2. Design Decision: Compatibility First

OIL SHALL consume existing vaults permissively.

A readable Markdown note is a knowledge node even when it has:

- no YAML frontmatter;
- unknown frontmatter keys;
- nonstandard tags;
- no H1 heading;
- no links;
- a layout that does not match OIL's default customer folders.

Missing metadata MUST reduce enrichment quality, not basic indexability. Malformed metadata MUST produce a visible catalog warning; it MUST NOT cause the note to disappear silently from all retrieval paths.

OIL MAY recognize an optional richer profile when conventional fields are present, but the baseline catalog cannot depend on that profile. Existing folder and field mappings in `oil.config.yaml` remain useful domain hints, not a universal schema requirement.

This differs intentionally from strict OKF conformance. OKF requires parseable frontmatter and a non-empty `type` on concept documents. OIL's default vault profile does not. OIL is therefore **OKF-inspired**, not automatically OKF-conformant. A future export operation MAY generate a conformant OKF bundle by synthesizing missing metadata without modifying source notes.

### 2.1 MCP and skill boundary

The knowledge nodes are data, not tools. OIL MUST expose a small MCP interface over a large internal catalog; it MUST NOT register one tool or eagerly enumerated resource per note.

The architecture is deliberately split:

| Concern | MCP substrate | Companion skill |
| --- | --- | --- |
| Persistent index, watcher, cache, freshness | Owns | Must not duplicate |
| Typed frontmatter and full-text queries | Owns | Chooses when to call |
| Result caps, cursors, stable refs, concurrency | Owns | Honors returned controls |
| Retrieval strategy and fallback policy | Provides evidence | Owns |
| Summarization, writing style, naming | Provides source sections | Owns |
| User-specific relevance judgment | Exposes ranking controls | Owns |

A `SKILL.md` alone is insufficient at scale because it is an instruction and policy artifact, not a persistent query engine. A skill can invoke scripts that rebuild indices or scan files, but doing so recreates a stateful substrate with repeated startup cost, weaker freshness guarantees, and no shared typed contract. Conversely, an MCP alone should not hard-code every workflow or summarization preference.

### 2.2 Alternatives considered

| Approach | Strength | Failure at vault scale | Decision |
| --- | --- | --- | --- |
| Skill-only file reads/scripts | Lowest idle MCP schema cost | Repeated scans, no watcher-owned state, weak pagination and concurrency | Reject as primary architecture |
| Generic filesystem MCP | Simple and portable | Agent must reconstruct frontmatter, ranking, graph, and safety on every turn | Insufficient alone |
| Catalog MCP + policy skill | Stateful, bounded, testable retrieval with editable behavior | Requires careful tool and response design | **Selected** |
| Vector-first external service | Paraphrase retrieval | Credentials, latency, index lag, privacy and exact-field weakness | Optional future accelerator only |

The selected row describes the target architecture. The current implementation is a graph/search MCP evolving toward that catalog contract. The selected architecture solves context flooding only if the MCP returns bounded candidates and the skill follows staged disclosure. MCP by itself is not a guarantee of efficient context use.

---

## 3. Terminology

- **Vault** — The validated Obsidian directory tree selected explicitly, through `OBSIDIAN_VAULT_PATH`, from a saved OIL profile, or from one unambiguous local Obsidian registry entry.
- **Knowledge node** — One readable supported note file represented in the OIL catalog (`.md`, `.markdown`, or compatibility text formats configured by OIL).
- **Node ID** — The normalized vault-relative path without its recognized note suffix, following OKF's concept-ID convention. Example: `Customers/Contoso`.
- **Node ref** — The round-trippable locator returned to an agent. Baseline form: `path` or `path#heading`, plus a freshness version.
- **Catalog record** — OIL's normalized, indexed representation of a knowledge node.
- **Observed schema** — Aggregated evidence about frontmatter keys, value types, key variants, folders, counts, and examples found in the live vault.
- **Field alias** — A configured or observed mapping from a user-facing field name to one or more actual frontmatter keys.
- **Virtual index** — A generated, token-bounded directory/type/tag overview returned by OIL. It is not written into the vault.
- **Index generation** — An opaque identifier for one internally consistent catalog snapshot.
- **Extraction profile** — The parser/indexer version and configuration fingerprint used to build a snapshot.
- **Catalog warning** — A nonfatal issue such as malformed frontmatter, duplicate explicit IDs, ambiguous links, or inconsistent field types.
- **Consumption agent** — An agent that discovers and reads knowledge.
- **Enrichment agent** — An agent that creates or updates knowledge.

---

## 4. Target Mapping from OKF to OIL

This table describes the contract implemented by OIL 0.6.0. Historical gaps are preserved in §15 and the delivery sequence in §18.

| OKF construct | OIL adoption | Compatibility-first adaptation |
| --- | --- | --- |
| Knowledge bundle | Obsidian vault | The vault can contain non-note files and plugin folders; OIL indexes supported note files only. |
| Concept | Knowledge node | Every readable note is a node, even without frontmatter. |
| Concept ID | Vault-relative path without suffix | Adopted as the baseline node ID. It is deterministic but changes when a file moves. |
| Frontmatter | Parsed YAML metadata | Optional. Unknown keys are preserved and indexed. Parse problems are warnings, not silent exclusions. |
| Body | Markdown content | Adopted. Full content is chunk-indexed; responses remain snippet/section bounded. |
| Standard Markdown links | Relationship edges | Adopted in addition to Obsidian wikilinks. |
| `index.md` | Progressive directory listing | Implemented primarily as a virtual index. Existing `index.md` files remain ordinary user files unless explicitly recognized. |
| `log.md` | Update history | Not reserved. OIL's `_agent-log/` remains the write-audit mechanism. |
| `type` | Routing/filter signal | Recognized when present and otherwise inferred as `note`; never required. |
| `title` | Display name | Resolution order: frontmatter title, first H1, filename. |
| `description` | Search/index preview | Resolution order: configured description aliases, then first meaningful paragraph. |
| `resource` | Canonical external URI | Preserved and indexed when present; optional. |
| `tags` | Cross-cutting categorization | Frontmatter tags and inline Obsidian tags are merged while preserving provenance. |
| `timestamp` | Meaningful update time | Frontmatter timestamp aliases are used when valid; filesystem mtime is always retained separately. |
| Conformance | Required metadata validation | Replaced by nonblocking readiness facets and catalog warnings. |
| Version declaration | Bundle compatibility | Replaced by catalog/extractor versions internal to OIL; no source-note change required. |

### 4.1 What OIL should copy from OKF

OIL SHOULD adopt:

- a minimal, explicit node model;
- deterministic path-derived IDs;
- arbitrary frontmatter extensions;
- graceful handling of unknown types;
- Markdown links as graph edges;
- progressive disclosure through directory indexes;
- producer and consumer contracts documented separately;
- permissive consumption of incomplete knowledge.

### 4.2 What OIL should not copy literally

OIL SHOULD NOT:

- require every existing note to have `type`;
- reserve common filenames globally;
- require users to maintain generated `index.md` files;
- treat broken links as fatal;
- assume standard Markdown links are the only relationship syntax;
- conflate a path-derived ID with a move-stable identity.

### 4.3 Lesson from the OKF reference implementation

The OKF repository operationalizes its format with more than a document specification. It includes:

- a document parser and validator;
- path-to-concept-ID conversion;
- an index generator grouped by type;
- a reference agent that lists concepts before writing links;
- tests for document round-tripping, generated indexes, link graphs, and malformed documents;
- augmentation guards that prevent a later enrichment pass from shrinking previously collected schema or citations.

OIL likewise needs producer/consumer behavior, index generation, and regression tests. A format description alone will not fix discovery reliability.

---

## 5. Canonical Knowledge Node Model

Every successfully cataloged note MUST produce one logical record with the following shape. This is an internal index contract; it does not require these fields in source frontmatter and MUST NOT be returned wholesale by default. Each tool projects only the fields needed for its task, preserving the compact `NoteRef`, snippet, metadata, and section response patterns described in §8 and §13.

```yaml
node_id: Customers/Contoso
path: Customers/Contoso.md
ref: Customers/Contoso.md
identity:
  explicit_id: null
  aliases: [Contoso]
  identity_source: path
presentation:
  title: Contoso
  description: Strategic account for...
  type: note
  type_source: inferred_folder
metadata:
  raw: { ... }
  normalized_fields: { ... }
  tags: [customer, active]
  tags_source: [frontmatter, inline]
content:
  headings: [Team, Opportunities, Recent Meetings]
  word_count: 1532
  chunk_count: 8
relationships:
  outgoing: [People/Alice Smith]
  incoming_count: 4
  unresolved: []
freshness:
  source_mtime_ms: 1780000000000
  content_hash: sha256:...
  index_generation: gen_...
quality:
  readiness: [indexed, structured, described, connected]
  warnings: []
```

### 5.1 Identity

1. `node_id` MUST be the normalized vault-relative path with its recognized note suffix removed.
2. `path` MUST preserve the actual vault-relative file path.
3. Path separators MUST be normalized to `/` on every operating system.
4. A source `id`, `uid`, or configured stable-ID field MAY be recorded as `explicit_id`.
5. Duplicate explicit IDs MUST NOT be resolved arbitrarily. All affected records MUST receive a `DUPLICATE_ID` warning.
6. The node ref returned to agents MUST remain path-based unless an explicit ID is unique and the server supports deterministic ID resolution.
7. File moves MAY be recognized best-effort by watcher rename events or content hash, but OIL MUST NOT promise move-stable identity without an explicit unique ID.

### 5.2 Presentation fields

OIL MUST derive presentation values in this order:

- **Title:** configured title field aliases → first H1 → filename stem.
- **Description:** configured description/summary aliases → first meaningful prose paragraph → empty string.
- **Type:** configured type aliases → folder/profile inference → `note`.
- **Timestamp:** configured timestamp aliases → absent; filesystem times remain in `freshness` and MUST NOT be written into user metadata.

Every derived value MUST include provenance internally so query explanations can distinguish authored metadata from inference.

### 5.3 Frontmatter preservation

- Original key spelling and raw values MUST be preserved in `metadata.raw`.
- Unknown keys MUST be preserved.
- Round-trip writes MUST NOT delete unknown keys.
- Normalization MUST create an index view; it MUST NOT rewrite source values.
- Keys differing only by case or separator style MUST be reported as variants, not silently merged in source data.

### 5.4 Readiness facets

Readiness is a set of independent descriptive facets, not an ordinal level or pass/fail gate:

1. **Indexed** — readable path and body; title can be derived.
2. **Structured** — frontmatter parsed successfully.
3. **Described** — authored or derived description is available.
4. **Connected** — at least one resolved relationship exists.
5. **Profiled** — the note matches an optional configured domain profile.

A node can carry any applicable combination and can be retrieved regardless of its facets. For example, an unstructured note with a valid link may be both `indexed` and `connected` without being `structured`.

---

## 6. Observed Frontmatter Schema

OIL MUST maintain an observed schema derived from the current catalog snapshot.

For each normalized key, the schema MUST expose:

- original key variants;
- total node count and percentage of catalog coverage;
- value-kind distribution: string, number, boolean, date-like string, array, object, null;
- folder distribution;
- bounded representative examples;
- configured aliases, if any;
- conflicting type evidence;
- last index generation.

Example:

```json
{
  "key": "status",
  "variants": ["status", "Status", "deal_status"],
  "aliases": ["status"],
  "node_count": 418,
  "types": { "string": 416, "array": 2 },
  "folders": { "Customers/": 120, "Projects/": 298 },
  "examples": ["active", "blocked", "complete"],
  "warnings": ["MIXED_VALUE_TYPES"]
}
```

### 6.1 Key normalization

Lookup normalization MUST be case-insensitive and SHOULD normalize `_`, `-`, and whitespace for suggestion purposes. Exact source keys remain distinct in raw metadata.

Configured aliases MUST take precedence over heuristic aliases. For example, if `status_field: lifecycle_state` is configured, a query for logical key `status` MUST target `lifecycle_state` and MAY also report other observed variants.

### 6.2 Value normalization

The index MUST support:

- strings, numbers, and booleans as scalar values;
- arrays as independently queryable members plus a retained array value;
- null as an existence-only value;
- nested objects through dotted paths such as `owner.email`, with a bounded serialized fallback;
- date-like strings without discarding their original representation.

Normalization MUST be deterministic across full and incremental rebuilds.

### 6.3 Unknown keys

A query against an unobserved and unconfigured key MUST return `UNKNOWN_FIELD`, not a successful empty match. The response SHOULD include up to five nearest observed keys and their coverage.

A known key with no matching values MUST return a successful zero-result response and identify the field as known. This distinction is essential for agent self-correction.

---

## 7. Catalog and Index Architecture

OIL SHOULD replace the current collection of partial indices with one generation-aware catalog snapshot from which specialized indices are derived.

```text
Source notes
   │
   ├─ parser + normalizer
   │     ├─ canonical records
   │     ├─ catalog warnings
   │     └─ content chunks
   │
   └─ one atomic index generation
         ├─ path / node-ID index
         ├─ title + alias index
         ├─ observed frontmatter schema
         ├─ frontmatter inverted index
         ├─ lexical/fuzzy search index
         ├─ link graph
         └─ virtual directory/type/tag indexes
```

### 7.1 Atomic generations

- A full or incremental update MUST construct a coherent next generation before making it current.
- Readers MUST see either the previous complete generation or the next complete generation, never a partially updated mixture.
- Every retrieval response MUST include `index_generation` directly or in shared response metadata.
- An update to a note MUST invalidate every derived representation of that note in the same generation.

### 7.2 Persisted snapshot validity

A persisted index MUST record:

- index format version;
- extractor/parser version;
- relevant configuration fingerprint;
- build completion timestamp;
- source path, mtime, size, and content hash or equivalent fingerprint per note.

OIL MUST rebuild or reconcile when the index format, extraction behavior, or relevant configuration changes. File mtime alone is insufficient when parser logic or field mappings change.

### 7.3 Startup freshness barrier

Loading a persisted index MAY make startup fast, but retrieval MUST NOT silently present an unreconciled snapshot as current.

Before the first retrieval response, OIL MUST do one of:

1. complete an initial source reconciliation; or
2. return `index_state: reconciling` with a structured `STALE_INDEX` warning and current generation timestamp.

`get_health` MUST distinguish at least `current`, `reconciling`, `stale`, and `failed` states. A boolean `building` flag is not sufficient.

Initial reconciliation means: enumerate current supported files; compare paths and persisted fingerprints; remove deleted records; parse new or changed records; and publish one resulting current generation. Unchanged files SHOULD avoid reparsing. On the 10,000-note reference benchmark, persisted-snapshot reconciliation SHOULD complete within 5 seconds p95; otherwise OIL may serve the prior generation only with an explicit reconciling/stale state.

### 7.4 Parse failures

The cataloger MUST NOT silently swallow note parsing errors.

For a note with malformed frontmatter, OIL SHOULD:

1. retain the path and derive a title from filename or recoverable body;
2. index recoverable body text when safe;
3. attach a `FRONTMATTER_PARSE_ERROR` warning;
4. expose the warning through catalog inspection and health summaries.

Unreadable files MAY be excluded, but MUST appear in a bounded error summary with path and reason.

### 7.5 Storage backend decision

The first implementation MUST use enhanced in-memory indices with versioned, atomically replaced JSON persistence. SQLite or a vector service is not justified by current measurements.

Reasons:

- the controlled 10,000-note investigation in §15.13 indexed 9,514 actual files in under one second after fixture generation;
- the persisted graph was approximately 5 MB;
- the measured heap increase was approximately 29–34 MB;
- exact frontmatter lookup, despite rebuilding its temporary map per call, remained below 10 ms p95;
- in-memory maps preserve OIL's no-native-dependency portability across macOS, Windows, and Linux.

The catalog implementation SHOULD hide storage behind an internal interface so a future backend does not change MCP contracts. SQLite with FTS5 becomes a candidate only when a representative benchmark crosses one or more of these gates:

- 50,000 or more actual indexed notes;
- initial reconciliation p95 exceeds 5 seconds;
- warm query p95 exceeds the §17.4 ceiling;
- catalog heap exceeds 256 MB or persisted state exceeds 100 MB;
- range/predicate workloads cannot meet latency targets without scanning;
- concurrent readers require transactional behavior that the in-memory generation model cannot provide safely.

An embedding/vector layer MUST remain optional and read-only relative to the primary catalog. It may be considered only after lexical, frontmatter, alias, heading, and chunk retrieval fail an explicit paraphrase-recall evaluation. It MUST NOT become the source of truth or a dependency for exact identifiers and predicates.

### 7.6 Read-after-write visibility

A successful OIL write MUST have a defined catalog visibility outcome. Returning filesystem success while the searchable catalog still contains the previous note is not sufficient.

Before a write tool returns success, it MUST either:

1. publish a catalog generation containing the written state; or
2. return `catalog_state: pending` and a generation/freshness token that allows the consumer to wait or re-check deterministically.

The preferred implementation is synchronous single-note re-indexing plus watcher-event deduplication. The watcher remains responsible for external edits, while OIL-originated writes update the catalog directly. Tests MUST cover immediate write → search, write → frontmatter query, and write → related-entity lookup.

---

## 8. Full-Content Retrieval Index

Searchability MUST NOT stop after the first 10,000 characters of a note.

### 8.1 Chunking

- The full frontmatter-stripped body MUST be represented in the search index.
- OIL SHOULD chunk by Markdown heading boundaries first and by bounded text windows second.
- Default chunks SHOULD be approximately 800–1,500 characters with modest overlap.
- Code fences and tables SHOULD remain intact when practical.
- Only bounded snippets are returned to the agent; full indexing does not imply full-content responses.

### 8.2 Indexed signals

Unified search MUST consider:

1. title and aliases;
2. exact path and filename;
3. frontmatter keys and values;
4. tags;
5. description;
6. headings;
7. body chunks;
8. link labels and nearby relationship context.

Authored title/path matches SHOULD outrank inferred metadata matches, which SHOULD outrank body-only fuzzy matches. Exact frontmatter filters are predicates, not ranking hints.

### 8.3 Explainability

Every search result MUST state why it matched. A result SHOULD include:

```json
{
  "path": "Customers/Contoso.md",
  "ref": "Customers/Contoso.md",
  "title": "Contoso",
  "score": 0.93,
  "matched_on": ["frontmatter.tpid", "title"],
  "snippet": "...",
  "index_generation": "gen_..."
}
```

Agents should not have to infer whether a result came from a title, a tag, frontmatter, or body prose.

### 8.4 Candidate fusion and ranking

Unified search MUST generate candidates from all applicable indices and rank the union once. It MUST NOT simply append fuzzy results after lexical results or compare independently normalized scores as though they share a scale.

The baseline pipeline SHOULD be:

1. normalize the query into exact phrase, tokens, and identifier-like terms;
2. generate candidates from exact path/title/alias, frontmatter, tags, headings, body chunks, and links;
3. compute deterministic field-specific features;
4. combine features into one calibrated score;
5. apply optional recency, folder, type, relationship, or diversity preferences;
6. return compact explanations for the final candidates only.

Exact identifier and exact path/title matches MUST not be displaced by diversity rules. For broad topic queries, the default result set SHOULD avoid redundant near-duplicates, for example by limiting repeated results from the same parent entity or folder when equally relevant alternatives exist.

Ranking controls belong on `search_vault` as constrained parameters such as `sort`, `boost`, or `diversity`; they do not justify a separate `rerank_results` MCP tool. Preference-heavy reranking over an already returned candidate list may remain in the skill.

### 8.5 Search completeness metadata

Search responses MUST report:

- the indices consulted;
- returned and total candidate counts when available;
- whether hard caps or time budgets stopped candidate generation;
- the minimum returned score;
- whether diversity changed the raw rank order;
- a cursor bound to the query and catalog generation when more results exist.

This metadata MUST remain compact and SHOULD be emitted once per response rather than repeated on every result.

---

## 9. Frontmatter Query Semantics

`query_frontmatter` MUST become a type-aware catalog query rather than a fragment scan over a temporary per-call map.

### 9.1 Required operators

The query contract SHOULD support:

- `eq` — typed equality; string comparison case-insensitive by default;
- `contains` — substring containment for strings and serialized object fallback;
- `prefix` — string prefix;
- `exists` — key presence regardless of value;
- `in` — equality against any supplied value;
- `all` — arrays contain all supplied values;
- `gt`, `gte`, `lt`, `lte` — numbers and validated date-like values.

The existing `value_fragment` input MAY remain as a backward-compatible alias for `operator=contains`.

### 9.2 Filters and ordering

Queries SHOULD support:

- folder prefix;
- tags;
- logical or raw key selection;
- deterministic ordering by path, title, source mtime, or queried value;
- bounded limit and cursor-based continuation.

### 9.3 Result completeness

Every query response MUST include:

- `count` for returned items;
- `total` when cheaply available;
- `truncated`;
- `next_cursor` when truncated;
- resolved logical key and actual source-key variants searched;
- index generation/state;
- warnings.

A hard slice to 20 paths without a truncation signal is non-conforming.

### 9.4 No silent schema mismatch

The query layer MUST distinguish:

- unknown field;
- known field with zero matching values;
- known field but incompatible operator/type;
- valid matches truncated by limit;
- index unavailable or stale.

These are different control-flow outcomes and require stable error codes.

---

## 10. Agent Discovery Protocol

The catalog must tell consumption agents how to traverse it. Tool descriptions and the companion policy skill SHOULD encode the following routing sequence.

### 10.1 Direct lookup

Use frontmatter query when the user supplies or implies a structured identifier or field predicate, such as TPID, status, owner, date, account ID, or project code.

If the key is unknown, inspect the observed schema or use suggested keys. Do not reinterpret `UNKNOWN_FIELD` as "the knowledge does not exist."

### 10.2 Named-entity or topic lookup

Use unified search for names, aliases, titles, topics, and natural-language phrases. Search MUST already include frontmatter values; the agent should not need to guess whether a value lives in YAML or prose.

### 10.3 Broad or underspecified requests

When the user asks a broad question without a known entity, field, or folder, inspect the catalog first. The agent SHOULD request a bounded overview by folder, type, tag, field, or recent activity before selecting notes.

Examples:

- "What customer information do I have?"
- "What kinds of project notes are in here?"
- "Find anything related to renewal risk."

### 10.4 Progressive read

After locating candidate nodes:

1. inspect metadata and headings;
2. read only relevant sections;
3. follow related entities when links are likely to add context;
4. request another search page or a narrower query when results are truncated;
5. load a complete note only when section-level reads cannot answer the task.

### 10.5 Recovery from weak results

When a search returns no result or low-confidence results, the response SHOULD provide bounded recovery hints such as:

- suggested fields;
- nearby title/alias candidates;
- searched folders;
- whether frontmatter/body/link indices participated;
- whether results were truncated or the index was stale.

The agent SHOULD broaden once using catalog evidence before asking the user to restate the request.

### 10.6 Staged retrieval and context budgets

Orientation is conditional, not a mandatory tax on every turn. A direct path, unique title, or structured identifier can skip directly to lookup. Broad or schema-ambiguous requests use the full staged protocol.

| Stage | Purpose | Default output budget | Existing/new interface |
| --- | --- | --- | --- |
| 0 — Orient | Discover folders, fields, types, tags, warnings | ≤2,000 chars | `inspect_catalog` |
| 1 — Generate | Return best candidate refs and short evidence | ≤6,000 chars; default 5 results | `search_vault` or `query_frontmatter` |
| 2 — Refine | Continue, narrow, or change sort/diversity | ≤4,000 chars | Same tool with cursor/filters; no new pagination tool |
| 3 — Inspect | Compare headings and selected metadata for 1–3 nodes | ≤4,000 chars per call | `get_note_metadata` with field projection |
| 4 — Read | Retrieve one relevant section/chunk | ≤6,000 chars per call | `read_note_section` with cursor/max chars |
| 5 — Assemble | Use a stable domain aggregator only when it saves calls | brief ≤3,200; full ≤4,800 chars | Existing Tier 2 tools |

The normal answer path SHOULD stop as soon as sufficient evidence is available. A default search → metadata → section workflow SHOULD remain within 25% of an 8,000-token turn budget. Expanded pages and full aggregator views are opt-in costs, not defaults.

### 10.7 Hard bounds

Context safety MUST be enforced server-side. Descriptions and skill instructions alone are insufficient because an agent can request an extreme `limit`, hop count, or very large section.

Target defaults and hard maxima:

| Operation | Default | Hard maximum |
| --- | --- | --- |
| Search results | 5 | 20 |
| Frontmatter-query results | 10 | 50 |
| Catalog overview entries | 10 | 50 |
| Related-entity results | 10 | 25 |
| Graph hops | 1 | 2 |
| Section body per page | 4,000 chars | 8,000 chars |
| Metadata frontmatter projection | selected/high-value fields | 8,000 serialized chars |
| Audit-log page | 20 entries | 100 entries |

Inputs above a maximum MUST be clamped with a warning or rejected with `LIMIT_EXCEEDED`; they MUST never expand unboundedly. Every bounded response MUST state `truncated` and provide a continuation cursor where continuation is meaningful.

Item counts are not sufficient protection because one item may contain very large metadata or content. A shared response shaper MUST enforce the stage's serialized-character budget after projection. If a response would exceed that budget, it MUST remove optional fields, truncate pageable content at a stable boundary, and emit continuation metadata rather than serializing the oversized payload.

`read_note_section` MUST support `max_chars` and `cursor` or an equivalent chunk contract. It MUST return available headings when a heading is unknown and SHOULD permit query-ranked heading previews without introducing a separate section-list tool.

`get_note_metadata` SHOULD support a field projection such as `frontmatter_fields` or `frontmatter_view=keys|summary|full`. Compatibility requires preserving current fields during a deprecation period, but arbitrary frontmatter cannot be allowed to make metadata responses unbounded permanently.

---

## 11. Virtual Indexes and Progressive Disclosure

OIL SHOULD adopt OKF's directory-index principle without writing generated files into a user's vault.

A catalog inspection primitive MUST support bounded views such as:

- root folders with note counts and short descriptions;
- one folder's child notes and subfolders;
- observed note types;
- top tags;
- frontmatter fields;
- recently modified nodes;
- warnings/readiness summary.

Entries SHOULD include title, path/ref, derived description, type, and high-value metadata while respecting token limits.

Example virtual folder index:

```markdown
# Customers

* [Contoso](Customers/Contoso.md) — Active healthcare account; updated 2026-07-09.
* [Fabrikam](Customers/Fabrikam.md) — AI pilot and migration workstreams.

# Subdirectories

* [Northwind](Customers/Northwind/) — 12 notes.
```

This output is a presentation shape over the catalog, not a source-of-truth file.

Existing user-authored `index.md` or MOC notes MAY be indexed as normal notes and MAY influence folder descriptions. OIL MUST NOT reserve or overwrite them by default.

---

## 12. Link and Relationship Semantics

OIL's relationship graph MUST support both Obsidian and standard Markdown conventions.

### 12.1 Supported internal links

- `[[Note]]`
- `[[Folder/Note]]`
- `[[Note#Heading]]`
- `[[Note|Alias]]`
- `[Label](Note.md)`
- `[Label](../Folder/Note.md#heading)`
- bundle-root-relative Markdown paths

External URLs MUST be retained as external references but excluded from internal graph traversal.

### 12.2 Deterministic resolution

Link resolution SHOULD proceed in this order:

1. exact normalized path;
2. source-note-relative path;
3. exact path without suffix;
4. folder-local unique filename/title/alias;
5. globally unique filename/title/alias.

If multiple candidates remain, the edge MUST be marked `AMBIGUOUS_LINK` with candidate refs. OIL MUST NOT let the last indexed duplicate title win silently.

Broken links remain nonfatal and MUST be retained as unresolved relationship evidence.

### 12.3 Relationship provenance

Graph edges SHOULD record:

- source and target refs;
- link syntax;
- label/alias;
- heading anchor;
- resolution status;
- bounded surrounding context.

This permits better agent explanations and future typed-relationship inference without forcing a relationship taxonomy today.

---

## 13. Catalog Inspection and Tool Surface

The runtime tool surface should remain small. This spec recommends consolidation rather than unbounded tool growth.

### 13.1 Recommended surface change

Add one Tier 1 primitive:

- **`inspect_catalog`** — Returns bounded folder, field, type, tag, recency, readiness, or warning views from the current catalog generation.

To preserve the current 14-tool target, `inspect_catalog` SHOULD replace `semantic_search`: fold the current `semantic_search` behavior into `search_vault`, then retire `semantic_search` after a deprecation window. The current implementation is fuzzy/lexical hybrid retrieval rather than embedding-backed semantic search, so consolidation also makes the public contract more accurate.

### 13.2 Existing tools to extend

- **`get_health`** — Add catalog generation, state, reconciliation lag, parse-error count, warning counts, extraction profile, and persisted-snapshot validity.
- **`search_vault`** — Search frontmatter and full content; accept structured predicates; return explanations, freshness, and pagination metadata.
- **`query_frontmatter`** — Add observed-schema resolution, typed operators, folder/tag filters, pagination, and explicit unknown-field errors.
- **`get_note_metadata`** — Return canonical node ID, identity provenance, description/type provenance, readiness, warnings, relationship counts, and catalog generation.
- **`get_related_entities`** — Return edge provenance and unresolved/ambiguous link summaries; support bounded filters already present internally.
- **`check_vault_health`** — Consume generic catalog warnings in addition to domain-specific customer checks.

Pagination, alternate ranking, section previews, and field projection MUST be modes or parameters on these tools, not separate tools such as `get_more_results`, `rerank_results`, or `list_note_sections`. Generic multi-note summarization remains skill/LLM policy unless a stable deterministic aggregator passes the admission test in spec 12.

### 13.3 MCP resources decision

Search, schema inspection, graph traversal, and paginated reads SHOULD remain MCP tools because they require typed parameters, bounded execution, structured diagnostics, and freshness metadata.

OIL MAY later expose an MCP resource template such as `oil://note/{path}` for direct addressing after a ref has already been resolved. It MUST NOT enumerate every vault note eagerly as an MCP resource list: a large resource listing recreates the same discovery and context-flooding problem this catalog is designed to solve, and client support for resource discovery is not consistent enough to replace the tool contract.

The source of truth remains the catalog record and vault file, regardless of whether a direct ref is accessed through a tool or resource template.

### 13.4 Response envelope

Retrieval responses SHOULD share metadata:

```json
{
  "data": {},
  "catalog": {
    "generation": "gen_...",
    "state": "current",
    "built_at": "2026-07-11T12:00:00Z"
  },
  "page": {
    "returned": 10,
    "total": 42,
    "truncated": true,
    "next_cursor": "..."
  },
  "warnings": []
}
```

Small single-note responses MAY flatten this envelope, but generation/state and warnings must remain available.

---

## 14. Error and Warning Taxonomy

Expected control-flow failures MUST use stable codes.

### 14.1 Errors

- `UNKNOWN_FIELD` — Requested frontmatter key is not observed or configured.
- `TYPE_MISMATCH` — Operator is incompatible with observed value types.
- `NOT_FOUND` — Requested node/ref does not exist.
- `AMBIGUOUS_REF` — A title, alias, ID, or path resolves to multiple nodes.
- `STALE_INDEX` — Current catalog cannot satisfy the freshness contract.
- `INDEX_UNAVAILABLE` — No usable catalog generation exists.
- `INVALID_CURSOR` — Pagination cursor is invalid or belongs to another generation.
- `LIMIT_EXCEEDED` — Query cannot be safely completed within configured bounds.
- `CONFLICT` — Existing write freshness error.

### 14.2 Warnings

- `FRONTMATTER_PARSE_ERROR`
- `MIXED_VALUE_TYPES`
- `KEY_VARIANTS`
- `DUPLICATE_ID`
- `AMBIGUOUS_LINK`
- `BROKEN_LINK`
- `DERIVED_DESCRIPTION`
- `DERIVED_TYPE`
- `RESULTS_TRUNCATED`
- `INDEX_RECONCILING`

Warnings are evidence for agent recovery and user hygiene; they do not make a node unreadable.

---

## 15. Pre-implementation Findings

The following gaps were directly visible before OIL 0.6.0 and motivated this spec.

### 15.1 Frontmatter query is not actually a persistent O(1) index

[`buildFrontmatterIndex`](../src/tools/retrieve.ts) scans all graph nodes and rebuilds a map on every `query_frontmatter` call. The tool description calls this an O(1) lookup, but only the final key lookup is O(1); index construction is O(nodes × fields) per request.

It also:

- accepts only key + substring fragment;
- returns at most 20 paths without `total`, `truncated`, or continuation;
- returns an empty success for unknown keys;
- does not apply configured logical field aliases;
- does not expose observed keys or types.

### 15.2 Search omits frontmatter

[`lexicalSearch`](../src/search.ts) and the Fuse index search titles, tags, headings, and `bodySnippet`, but not arbitrary frontmatter keys or values. A note can therefore be found by `status` only if that value is duplicated into a tag, heading, or body.

The internal `SearchFilters` type already supports exact frontmatter filters, but `search_vault` does not expose them in its MCP input schema.

### 15.3 Full-content recall is capped

[`GraphIndex.indexNote`](../src/graph.ts) stores only `content.slice(0, 10_000)` as `bodySnippet`. Both unified and so-called semantic search operate on this truncated representation. Relevant content after that boundary is invisible.

### 15.4 A stronger query engine exists but is not exposed

[`queryNotes`](../src/query.ts) supports predicates, ordering, and folder filtering, but no registered runtime tool calls it. Its field resolution also silently passes unknown names through to raw frontmatter, making schema mismatch indistinguishable from a legitimate zero-result query.

### 15.5 Parse and indexing failures can be silent

[`GraphIndex.indexNote`](../src/graph.ts) catches every error and skips the file without recording a warning. Users and agents cannot distinguish an absent note from a note that failed indexing.

### 15.6 Link resolution can be nondeterministic

The current graph resolves only wikilinks. Its global lowercase title/filename map stores one path per key, so duplicate names overwrite earlier entries according to indexing order. Standard Markdown links are not graph edges.

### 15.7 Persisted freshness is under-specified

The persisted graph includes a format version and file mtimes, but not the extraction-profile/config fingerprint needed to detect changes in parser behavior or field mapping. Startup can serve a loaded snapshot while incremental reconciliation runs in the background; responses do not disclose that state.

### 15.8 Discovery tests are too small and title-oriented

Current retrieval-quality tests are useful rank guards for a small fixture, but they do not cover:

- arbitrary frontmatter-only retrieval;
- unknown-key recovery;
- mixed scalar/array/object values;
- configured field aliases;
- content beyond 10,000 characters;
- duplicate titles and aliases;
- standard Markdown links;
- malformed frontmatter;
- startup reconciliation state;
- result truncation and pagination;
- broad catalog-orientation requests.

### 15.9 Retrieval bounds are not enforced

The current `search_vault` and `semantic_search` schemas accept an arbitrary numeric `limit`; the implementation uses the supplied value without a hard maximum. `get_related_entities` similarly accepts an arbitrary hop count, and [`GraphIndex.getRelatedNotes`](../src/graph.ts) returns the complete visited neighborhood without a result cap. `read_note_section`, `get_note_metadata`, and `get_agent_log` can return an arbitrarily large section, frontmatter object, or daily log.

These are direct context-flooding paths even when normal defaults are small. Hard maxima and continuation metadata are therefore Phase 1 safety work, not optional polish.

### 15.10 OIL writes are not immediately searchable by contract

The live write registration receives a graph instance as `_graph` but does not update it. Successful writes invalidate the session cache and rely on the filesystem watcher to update graph/search state later. An immediate write → search or write → frontmatter-query sequence can therefore observe old catalog state.

The target read-after-write requirement is defined in §7.6.

### 15.11 Ranking combines incomparable stages

The current default search returns lexical matches first and appends unseen fuzzy matches without globally re-ranking the union. Fuse scores are normalized relative to each result set, while content-search scores use occurrence counts; `semantic_search` sorts these different scales together. This makes scores unstable as explanations and can place weak fuzzy false positives above the intended frontmatter-only node.

The current `semantic_search` name is also misleading: it performs fuzzy and lexical content matching with no embedding or semantic model.

### 15.12 Cache usage does not match the primitive-read story

`SessionCache` is used by domain, hygiene, and correlation paths, but the registered retrieve primitives accept it as `_cache` and do not use it. This is not currently a major latency problem—direct metadata reads are fast—but the documentation and future design should not claim cache-backed primitive reads unless they are actually implemented and freshness-tested.

The catalog snapshot itself should be the primary retrieval cache. A second parsed-note cache is useful only when it has clear hit-rate, invalidation, and memory evidence.

### 15.13 Empirical 10,000-note investigation

A controlled local investigation on 2026-07-11 used the repository's synthetic generator and current production registrations. The temporary test was removed after measurement.

| Measure | Observed |
| --- | ---: |
| Requested synthetic notes | 10,000 |
| Actual indexable files | 9,514 |
| Fixture generation | ~1.18 s |
| Graph build + tool registration | ~0.78–0.83 s |
| Approximate heap increase | ~29–34 MB |
| Frontmatter query median | ~2.5–2.7 ms |
| Frontmatter query p95 | ~8–9 ms |
| Persisted graph size | ~5.0 MB |

Correctness probes were more important than latency:

- `query_frontmatter(tpid, 100999)` returned the intended note;
- an unknown key returned an indistinguishable successful empty response;
- unified search for that frontmatter-only TPID returned ten fuzzy customer candidates but not the intended note;
- an exact marker placed after character 10,000 in a long note returned zero unified-search results.

The generator reported 10,000 creations but produced 9,514 distinct files because some generated paths collided and were overwritten. Scale tests MUST count actual indexed files and fail when fixture cardinality differs materially from the requested size.

These measurements support enhanced in-memory indices for the initial implementation. At 10K scale, frontmatter correctness and agent guidance are urgent; replacing the per-call map with SQLite is not.

### 15.14 Read-only fixture audit baseline

The new live-vault audit was executed end to end against the repository's 12-note fixture using the same `OBSIDIAN_VAULT_PATH` path accepted for a real vault.

| Check | Observed |
| --- | ---: |
| Listed and indexed files | 12 / 12 |
| Parse failures | 0 |
| Unique frontmatter samples | 32 |
| Structured-query sample failures | 0 |
| Frontmatter-only unified-search samples | 8 |
| Unified-search misses | 6 |
| Frontmatter-only unified-search recall | 25% |
| Unknown field returned `UNKNOWN_FIELD` | No |

The six misses were exact account IDs and TPIDs present only in frontmatter. This independently reproduces the reported behavior on the maintained fixture: structured lookup can find known values, but unified discovery and unknown-field recovery remain unreliable.

### 15.15 Post-implementation scale validation

A collision-free rerun on 2026-07-11 validated both requested fixture sizes. Counts include the generator's one audit-log note in addition to the requested synthetic notes.

| Measure | 10K request | 50K request |
| --- | ---: | ---: |
| Actual indexed nodes | 10,001 | 50,001 |
| Fixture generation | ~1.03 s | ~8.67 s |
| Full catalog build | ~1.16 s | ~5.34 s |
| Persisted snapshot reconciliation | ~0.29 s | ~1.50 s |
| Persisted snapshot size | ~17.0 MB | ~85.3 MB |
| Exact frontmatter p50 / p95 | ~0.02 / 0.12 ms | ~0.04 / 0.30 ms |
| Warm broad search p50 / p95 after optimization | ~6.7 / 11.0 ms | ~40.8 / 45.4 ms |

Forced-GC heap measurements varied by run and crossed the 256 MB evaluation gate at 50K after the lazy search index was materialized. That makes SQLite/FTS5 a justified prototype candidate for vaults above 50K; it does not require changing the 0.6.0 backend because the 10K reference target and the 50K query/reconciliation SLAs pass comfortably, persisted state remains below 100 MB, and the no-native-dependency portability benefit remains material. Backend migration should be decided with a representative real-vault workload rather than synthetic cardinality alone.

The maintained 12-note fixture audit also passed after implementation: 12/12 notes indexed, 0 structured-query failures, 8/8 frontmatter-only values found through unified search (100% recall), and unknown fields returned `UNKNOWN_FIELD`.

An isolated validation against an existing 131-note vault on 2026-07-12 indexed 131/131 readable notes with no parse failures, passed 50 sampled structured frontmatter lookups, found 20/20 frontmatter-only values through unified search, and returned 20/20 unique exact titles at rank one. A UUID-scoped CRUD run then passed create, metadata/section reads, typed queries, relationship traversal, append, stale-write rejection, full replacement, immediate search visibility, recursive filesystem deletion, watcher-driven catalog removal, and cleanup with no validation directory or audit-log residue. The first run exposed and led to fixes for YAML timestamp coercion in the audit harness and whole-directory watcher deletion/readiness.

---

## 16. Producer and Consumer Contracts

### 16.1 Consumption contract

Consumers MUST:

- treat refs as opaque round-trippable values;
- inspect catalog evidence when the schema or vault layout is unknown;
- distinguish unknown fields from known zero-match fields;
- honor truncation and continuation metadata;
- prefer metadata → section → related-node progression over full-note loading;
- tolerate unknown note types and fields;
- surface stale-index warnings when they can affect the answer.

Consumers MUST NOT:

- reconstruct paths from titles when a ref is available;
- assume all vaults use OIL's default folders;
- interpret an empty query against an unknown field as proof of absence;
- assume `semantic_search` implies embeddings or semantic-vector recall;
- write generated index files unless the user explicitly requests materialization.

### 16.2 Enrichment contract

Enrichment agents SHOULD:

- read current metadata and relevant sections before editing;
- preserve unknown frontmatter keys;
- reuse existing field variants rather than creating near-duplicates;
- use existing links/refs instead of guessing paths;
- include a concise authored description when creating a durable managed note;
- update links without removing unresolved user-authored links;
- use mtime/version-guarded writes.

These are recommendations. Compatibility-first consumption cannot depend on every producer following them.

### 16.3 Monotonic enrichment

When an agent enriches an existing note, it SHOULD add or refine knowledge without accidentally shrinking structured evidence collected by another process. For high-value sections or configured fields, a write planner SHOULD warn when a proposed replacement removes previously populated values, links, citations, schema rows, or identifiers.

The server need not decide whether the change is semantically correct; it should make destructive shrinkage visible before execution.

---

## 17. Test and Evaluation Requirements

### 17.1 Unit tests

Tests MUST cover:

- canonical node derivation with and without frontmatter;
- raw frontmatter preservation;
- key/value normalization for every supported value kind;
- logical-field aliases and key suggestions;
- unknown field versus known zero match;
- duplicate explicit IDs;
- Markdown and wikilink resolution;
- duplicate-title ambiguity;
- malformed frontmatter warnings;
- content matches after 10,000 characters;
- full and incremental generation equivalence;
- extraction-profile/config invalidation;
- cursor invalidation across generations;
- hard maximum enforcement for result limits, graph hops, sections, metadata, and logs;
- immediate write → search/query/graph visibility;
- candidate-fusion score calibration and deterministic tie-breaking;
- section pagination without duplicated or missing text.

### 17.2 Retrieval eval corpus

The fixture vault SHOULD expand beyond title-oriented notes. It MUST include:

- notes whose only relevant evidence is in frontmatter;
- multiple synonymous key variants;
- arrays, numbers, booleans, dates, and nested objects;
- long notes with relevant content near the end;
- duplicate filenames in different folders;
- aliases and headings;
- broken and ambiguous links;
- notes without frontmatter;
- malformed notes that remain partially discoverable;
- at least one broad orientation task;
- frontmatter-only identifiers surrounded by plausible fuzzy distractors;
- enough unique paths to validate the requested scale without overwrite collisions.

### 17.3 Quality targets

On the maintained retrieval eval corpus:

1. Exact frontmatter equality recall MUST be 100% for supported scalar and array values.
2. Known-field/unknown-field classification MUST be 100%.
3. Frontmatter-only target notes MUST appear in top 5 for at least 95% of natural-language discovery queries.
4. Unique exact title, alias, path, and explicit-ID queries MUST return the intended note at rank 1.
5. Full-body exact-term recall MUST be 100%, regardless of term location.
6. Ambiguous references MUST be reported as ambiguous in 100% of duplicate-name fixtures.
7. Full-build and incremental-build query results MUST be equivalent for unchanged vault state.
8. No parser failure may remove a path without a corresponding warning.
9. Exact structured identifiers MUST outrank fuzzy distractors in 100% of identifier fixtures.
10. Broad-query result sets MUST satisfy a declared diversity metric without displacing exact matches.

### 17.4 Freshness and performance targets

For a 10,000-note benchmark vault on reference hardware:

- warm exact frontmatter query: p50 < 20 ms, p95 < 75 ms;
- warm unified search: p50 < 50 ms, p95 < 200 ms;
- catalog overview: p50 < 50 ms;
- watcher change visible in a current generation: p95 < 1 second after stable write;
- initial persisted-snapshot reconciliation: p95 < 5 seconds and reported separately from full parse;
- full catalog memory and persisted-index size: tracked as regression metrics.

Scale reports MUST state both requested fixture size and actual indexed-node count. End-to-end build measurements MUST be separated from warm filesystem-cache microbenchmarks.

These targets may be revised after a baseline run, but correctness targets cannot be traded away silently for speed.

### 17.5 Token-budget targets

- Search and query defaults SHOULD return at most 10 records.
- Candidate search SHOULD default to 5 records; callers explicitly opt into 10–20.
- Catalog overviews SHOULD fit within 10% of an 8,000-token turn budget by default.
- Each result SHOULD use one short snippet and compact match explanations.
- Truncation MUST be explicit instead of returning oversized payloads.
- A default search → metadata → section workflow SHOULD fit within 25% of the turn budget.
- Every tool with caller-controlled cardinality MUST have a tested hard response ceiling.
- The live MCP schema surface MUST remain within the existing serialized-size guard unless intentionally revised.

### 17.6 Agent workflow evaluations

Model-free contract tests MUST verify that the tool outputs make the intended recovery path possible. Model-backed evaluations SHOULD additionally measure whether supported agents choose that path from natural-language requests.

Required scenarios:

1. broad request → catalog inspection → bounded search → selected section;
2. exact identifier → direct frontmatter query without unnecessary orientation;
3. unknown field → suggested field → successful retry;
4. five-of-many results → cursor continuation with no duplicates;
5. missing heading → available/ranked headings → successful section read;
6. write → immediate search/query confirmation;
7. ambiguous title → candidate refs rather than arbitrary resolution;
8. context-pressure scenario where the agent stops after sufficient evidence instead of loading all candidates.

Each trace MUST record called tools, serialized response characters, target-note rank, final evidence refs, and whether any response was truncated or stale.

### 17.7 Executable evaluation suites

The repository MUST maintain three complementary suites:

1. **Specification contract** — verifies that accepted architectural decisions, compatibility guarantees, hard ceilings, and implementation phases remain present in this specification and its index.
2. **Synthetic catalog contract** — uses an isolated deterministic vault to verify working frontmatter/write behavior and reproduce known gaps in search, pagination, malformed notes, ambiguity, limits, and read-after-write visibility.
3. **Live vault audit** — optionally evaluates a real vault read-only when explicitly invoked through `npm run test:vault:live` with `OBSIDIAN_VAULT_PATH` set. Merely having the path in the environment MUST NOT make an ordinary full-suite run inspect the vault. The audit MUST NOT start a watcher or call write tools. It reports file/index accounting, parse failures, sampled structured-query fidelity, and unified-search recall for frontmatter-only values.

Known gaps MAY initially use Vitest's `it.fails` as executable reproductions. The lifecycle is strict:

- the test body asserts the target behavior, never the broken behavior;
- the test name identifies the user-visible contract;
- when a fix makes the target pass, Vitest intentionally reports the `it.fails` case as a failure;
- the same change that implements the fix MUST remove `.fails`, turning it into a permanent regression guard;
- known-gap tests MUST NOT remain inverted after their implementation phase closes.

Commands:

```text
npm run test:catalog
OBSIDIAN_VAULT_PATH=/absolute/path npm run test:vault:live
```

The live audit is read-only and writes no artifact unless explicitly requested, but its local diagnostic output contains vault paths and bounded sample values. Users and CI systems MUST treat that output as potentially sensitive and MUST opt in explicitly. The audit never modifies the source vault.

---

## 18. Implementation Plan

**Implementation status:** Phases 0–6 shipped in OIL 0.6.0. The phase detail is retained as the delivery and regression contract.

### Phase 0 — Characterize failures

1. Add fixtures and workflow evals for the reported frontmatter/discovery failures.
2. Record current recall, rank, false-empty rate, latency, index size, and schema-size baselines.
3. Add tests that reproduce unknown-field silence, fuzzy identifier distraction, content truncation, and unbounded responses.
4. Fix the synthetic generator so requested and actual unique-note counts agree, then preserve the §15.13 result as an explicit pre-fix baseline.
5. Establish the specification, synthetic catalog, and optional live-vault suites from §17.7.

**Exit criterion:** Every reported failure class has a failing automated test.

### Phase 1 — Context safety and consistency

1. Enforce hard maxima for search/query results, graph hops/results, section pages, metadata, and logs.
2. Add `truncated`, counts, and generation-bound cursors to bounded responses.
3. Add `max_chars`/cursor support to `read_note_section` and frontmatter projection to `get_note_metadata`.
4. Make OIL-originated writes visible in the catalog before success is returned, or return an explicit pending state.
5. Correct misleading tool descriptions, especially O(1) frontmatter and semantic-search claims.

**Exit criterion:** No registered read can exceed its response ceiling, and immediate write → read/search/query workflows are deterministic.

### Phase 2 — Canonical records and observed schema

1. Introduce a catalog-record type and parser/normalizer module.
2. Preserve raw metadata and derive presentation fields with provenance.
3. Record parse warnings instead of silently skipping notes.
4. Add extraction-profile and config fingerprints.
5. Build an incrementally maintained observed schema and frontmatter inverted index.
6. Add `inspect_catalog` field/folder/type/tag/warning views.
7. Upgrade `query_frontmatter` with typed operators, aliases, and explicit unknown-field/type errors.

**Exit criterion:** Every readable fixture note produces a record or visible error entry, and exact/existence queries satisfy the frontmatter correctness targets.

### Phase 3 — Unified search and full-content chunks

1. Add frontmatter keys/values and descriptions to search documents.
2. Replace body-prefix indexing with full heading-aware chunks.
3. Replace append-style tier merging with calibrated candidate fusion.
4. Add match provenance, result explanations, and broad-query diversity.
5. Expose structured predicates and continuation through `search_vault`.
6. Consolidate/deprecate overlapping `semantic_search` behavior.

**Exit criterion:** Frontmatter-only, distractor, and long-note eval targets pass within performance and context budgets.

### Phase 4 — Relationship and progressive-discovery reliability

1. Add standard Markdown link parsing.
2. Replace single-value title resolution with candidate sets and deterministic ambiguity handling.
3. Add virtual folder/type/tag/recent views to `inspect_catalog`.
4. Extend graph responses with edge provenance and unresolved candidates.

**Exit criterion:** Broad orientation and duplicate-link fixtures pass without arbitrary resolution.

### Phase 5 — Freshness and operations

1. Make catalog updates generation-atomic.
2. Add startup freshness barrier and explicit index states.
3. Extend health and hygiene outputs with generic catalog warnings.
4. Add persisted-snapshot corruption/recovery tests and benchmark reporting.
5. Re-run 10K and 50K controlled measurements; evaluate SQLite only if §7.5 gates are crossed.

**Exit criterion:** Full and incremental results are equivalent, no stale state is served as current, and the selected backend is justified by recorded measurements.

### Phase 6 — Agent policy and documentation

1. Update tool descriptions with the discovery protocol.
2. Update the companion vault/memory skill with direct lookup, orientation, progressive read, and recovery rules.
3. Document compatibility-first behavior and optional richer metadata conventions.
4. Add end-to-end workflow evaluations with an agent selecting tools from natural-language prompts.

**Exit criterion:** Agent workflow evals consistently discover target notes without pre-supplied paths or exact frontmatter keys.

---

## 19. Release and Compatibility Strategy

1. Existing notes require no migration.
2. Existing `oil.config.yaml` values remain valid.
3. Existing `query_frontmatter(key, value_fragment)` calls remain supported during at least one minor-version deprecation window.
4. New response fields are additive where possible.
5. Any response-envelope change must be versioned and called out in the changelog.
6. `semantic_search` was retired in OIL 0.6.0 to preserve the 14-tool surface; migration guidance directs callers to `search_vault` or `inspect_catalog`.
7. Persisted graph/catalog format changes require an automatic rebuild, not a user repair step.
8. No generated index or metadata field may be written into source notes by default.

---

## 20. Success Criteria

This specification is successfully implemented when:

1. An agent can inspect the vault's folders, note types, tags, and frontmatter fields without guessing.
2. A frontmatter query never returns a false-looking empty success because the key was unknown or aliased differently.
3. Arbitrary frontmatter values participate in unified discovery.
4. Relevant body content is searchable regardless of its position in a note.
5. Duplicate titles and ambiguous links are reported rather than resolved by index order.
6. Parse failures, stale snapshots, and truncated results are visible and actionable.
7. Broad questions trigger progressive catalog inspection instead of blind grep or full-vault loading.
8. Existing unstructured Obsidian notes remain discoverable with no migration.
9. Retrieval quality is protected by evals representing real user language, not only exact fixture titles.
10. The implementation stays within explicit latency, memory, token, and MCP-schema budgets.
11. No caller-controlled limit, hop count, section, metadata object, or log can bypass server-side context ceilings.
12. A successful OIL write is immediately visible through the returned or subsequent catalog generation.

---

## 21. Open Questions

1. **Resolved:** `inspect_catalog` replaced `semantic_search` in OIL 0.6.0; both did not coexist because the misleading name and idle schema cost outweighed a second search alias.
2. Which configured frontmatter aliases belong in the generic catalog versus domain tools only?
3. Should nested objects be flattened to a configurable depth or to a fixed safe depth?
4. Which measured §7.5 threshold, if any, should trigger migration from versioned JSON to SQLite?
5. How should OIL detect a move when an editor emits unlink + add and the content changes simultaneously?
6. Which result counts are cheap enough to return exactly, and where should OIL return an estimate?
7. Should virtual folder descriptions be deterministic extracts only, or may a policy skill synthesize them?
8. Which destructive-shrinkage checks belong in generic write tooling versus the companion policy skill?
9. Should explicit-ID aliases be configurable globally (`id`, `uid`, `uuid`) or only through `oil.config.yaml`?
10. What real-vault, privacy-safe query set should become the long-term retrieval evaluation corpus?

---

## Appendix A — Minimal Compatibility Example

Source note with no frontmatter:

```markdown
# Contoso renewal

The customer wants a revised proposal before September.
```

OIL still catalogs it:

```yaml
node_id: Projects/Contoso renewal
path: Projects/Contoso renewal.md
presentation:
  title: Contoso renewal
  description: The customer wants a revised proposal before September.
  type: note
metadata:
  raw: {}
quality:
  readiness: [indexed, described]
  warnings: [DERIVED_DESCRIPTION, DERIVED_TYPE]
```

No migration is required.

## Appendix B — Structured Example

```markdown
---
kind: customer
account_name: Contoso
TPID: "12345"
Status: Active
aliases: [Contoso Ltd]
tags: [customer, healthcare]
---

# Contoso

## Priorities

Modernize the data estate and launch the AI assistant pilot.
```

The observed schema retains `TPID` and `Status`, while normalized lookup allows configured or suggested logical keys. Searches for `12345`, `Active`, `Contoso Ltd`, `healthcare`, or the body priorities can all discover the same node and explain which field matched.

## Appendix C — Example Unknown-Field Recovery

Request:

```json
{ "key": "lifecycle", "operator": "eq", "value": "active" }
```

Response:

```json
{
  "error_code": "UNKNOWN_FIELD",
  "message": "No observed or configured frontmatter field named lifecycle.",
  "suggestions": [
    { "key": "lifecycle_state", "node_count": 203 },
    { "key": "status", "node_count": 418 }
  ],
  "catalog": {
    "generation": "gen_01J...",
    "state": "current"
  }
}
```

The agent can self-correct without concluding that no active notes exist.
