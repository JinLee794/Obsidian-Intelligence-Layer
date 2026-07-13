# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### User Experience

- Add the short `oil` executable as the primary CLI, while retaining `obsidian-intelligence-layer` as a compatibility alias
- Build `dist/` during Git dependency installation so MCP clients can test a branch or commit directly through `npx`
- Add `setup`, `list-vaults`, `doctor`, and `init` CLI commands for first-run vault onboarding
- Discover vaults from the local Obsidian registry on macOS, Windows, and Linux
- Open a native folder chooser during explicit interactive setup, with a terminal-path fallback
- Persist canonical vault paths as named per-user profiles so MCP startup no longer requires an environment variable
- Resolve vaults deterministically from an explicit path, environment, saved profile, or one unambiguous Obsidian registry entry
- Validate configured paths before indexing and refuse to silently fall back when an explicit or saved path becomes invalid
- Keep MCP startup non-interactive to avoid stdio initialization timeouts, remote-host UI mismatches, and repeated dialogs

## [0.6.0] - 2026-07-11

### Features

- Add a compatibility-first, generation-aware knowledge catalog for every readable note
- Add observed frontmatter schema discovery and persistent typed queries with aliases, dotted paths, range operators, explicit `UNKNOWN_FIELD`, and pagination
- Search arbitrary frontmatter, descriptions, complete note bodies, and link context with calibrated candidate fusion and match explanations
- Add `inspect_catalog` virtual indexes for folders, fields, types, tags, recency, readiness, and warnings
- Parse standard Markdown links alongside wikilinks and report broken or ambiguous relationships deterministically
- Add canonical node identity, provenance, readiness, warnings, content hashes, extraction profiles, and atomic versioned persistence

### Safety and Reliability

- Enforce server-side maxima for search, frontmatter queries, graph traversal, section reads, metadata, audit logs, and domain inputs
- Add generation-bound cursors and explicit truncation metadata
- Make successful writes synchronously searchable and return `catalog_state` / `catalog_generation`
- Reconcile persisted snapshots before registering tools and expose catalog state through `get_health`
- Wait for watcher readiness before serving tools and handle recursive directory deletion via `unlinkDir`
- Recover malformed-frontmatter notes with visible warnings instead of silently dropping them
- Sample canonical catalog metadata in live audits so date-like YAML values use production normalization
- Fix watcher ignore matching for vaults beneath hidden macOS temporary directories
- Fix synthetic benchmark fixture collisions so requested note cardinality is deterministic
- Add an explicit opt-in, UUID-isolated live-vault CRUD/search test with automatic cleanup

### Breaking Changes

- Replace `semantic_search` with `inspect_catalog`; use `search_vault` for natural-language retrieval and `inspect_catalog` for broad orientation
- `search_vault` now returns a structured response with `results`, `catalog`, `page`, and `warnings` instead of a bare array

### Compatibility

- Existing notes require no migration
- Existing `query_frontmatter(key, value_fragment)` calls remain supported
- Persisted v1/v2 graph files rebuild automatically as catalog v3 snapshots

## [0.5.2] - 2026-04-21

### Fixes

- Adjust padding and dimensions in safe writes animation for improved layout

## [0.5.1] - 2026-04-13

### Docs

- Add animated HTML previews and GIFs for customer workflows, safe writes, search & inspect, and audit log
- Add GIF capture script (`capture-gifs.mjs`) for generating docs assets
- Update README with new showcase GIF references
- Migrate Showrunner skill to `showrunner-video`, add scene-types reference

## [0.5.0] - 2026-04-13

### Features

- Overhaul overview GIF and HTML preview with 10 animated scenes
- Add dedicated code-terminal scenes for install CLI and `.vscode/mcp.json` setup
- Add search capabilities showcase scene (`search_vault`, `semantic_search`, `query_frontmatter`)
- Add "How OIL Saves Tokens" pipeline funnel and updated KPI scorecard

### Docs

- Rewrite overview storyboard: title, problem statement, comparison, quick setup (section header + terminal + mcp.json config), search tools, token funnel, KPI stats, closing
- Highlight `OBSIDIAN_VAULT_PATH` as the only required configuration throughout setup scenes

## [0.4.0] - 2026-04-13

### Features

- Enhance frontmatter ID extraction and section parsing

### Fixes

- Add TPID auto-resolution to `get_customer_context`, fix test setup
- Skip real-vault bench when vault path missing (CI)

## [0.3.1] - 2026-04-07

### Performance

- Eliminate disk I/O from `contentSearch`, remove dead config

## [0.3.0] - 2026-04-04

### Features

- Add new retrieval tools for related entities and semantic search
- Enhance retrieval tools with search functionality and word count utility

### Refactors

- Simplify search functionality and remove semantic model support

## [0.2.0] - 2026-03-28

### Features

- Optimize MCP tool surface — consolidate tools, add domain routing
- Comprehensive account review workflows, delegation frameworks, and CSU commitment validation
- Add eval persistence and regression detection script
- Add Obsidian vault instructions for local knowledge management and CRM integration

### Fixes

- TPID auto-resolution for vault customer lookups + Windows path normalization
- Correct npm command in publish workflow and update subtree remote in sync script
