# Changelog

All notable changes to this project will be documented in this file.

## [0.5.5] - 2026-08-07

### Fixes

- Build `dist` during Git dependency installation so the declared `obsidian-intelligence-layer` executable is present and runnable
- Document an explicit `npx --package` MCP configuration that resolves the packaged executable consistently

### Tests

- Pack and install the release artifact in a clean temporary project, verify the CLI entrypoint and platform shim, complete a real MCP initialization handshake, and list the server tools
- Require lint, unit tests, and the package startup smoke test in the publish workflow and before manual publication

## [0.5.4] - 2026-08-07

### Fixes

- Write the persisted graph index atomically (temp file + rename) so a concurrent reader can no longer observe a partially written file and discard the index, which forced repeated full rebuilds
- Await index persistence during cold start so an early shutdown cannot leave the vault without an index and trigger another full rebuild on the next start
- Retry the index rename on transient Windows `EPERM`/`EACCES` while another instance holds the file open
- Skip the redundant second index read during warm start, which re-parsed the whole file and discarded live watcher and write updates
- Reset the `building` flag when index persistence fails
- Sweep temp files orphaned by an interrupted save instead of leaving them in the vault

### Improvements

- Report why the graph index could not be read instead of silently falling back to a full rebuild

### Tests

- Add regression coverage for incremental startup: live-update preservation, insert and delete handling, temp-file cleanup, and building-flag reset

## [0.5.3] - 2026-08-04

### Fixes

- Normalize CRLF line endings across parser boundaries so section retrieval works for Windows-authored notes
- Prevent stale reads by normalizing Windows paths, fixing watcher exclusions for dotted vault roots, revalidating cached notes by modification time, and reindexing writes inline

### Tests

- Add regression coverage for CRLF parsing, retrieval, cache revalidation, watcher invalidation, write consistency, and response truncation

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
