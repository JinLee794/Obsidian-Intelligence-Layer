# Generic Version Comparison Benchmarks

Compare the current OIL build against **any** previous commit, tag, or branch.

## Quick Start

```bash
# From the repo root:
./scripts/bench-against.sh <git-ref>

# Examples:
./scripts/bench-against.sh v0.4.0        # compare against a tag
./scripts/bench-against.sh main~5        # 5 commits ago
./scripts/bench-against.sh abc1234       # specific commit SHA
./scripts/bench-against.sh HEAD~1        # previous commit
./scripts/bench-against.sh feature/foo   # another branch
```

## What It Does

1. **Checks out** the target ref's `mcp/oil` into `/tmp/oil-bench-<hash>`
2. **Installs** dependencies and **builds** the baseline
3. **Runs** the comparison benchmark suite against both versions

## Dimensions Tested

| # | Dimension | Method |
|---|-----------|--------|
| 1 | **Tool surface** | Tool list diff (added / removed / kept) |
| 2 | **Schema overhead** | Per-turn token cost from tool schemas |
| 3 | **Cold-start latency** | Graph index build time |
| 4 | **Search latency** | Fuzzy search across fixture vault |
| 5 | **Read latency** | Note read performance |
| 6 | **Retrieval quality** | Precision / recall on ground-truth queries |
| 7 | **Summary** | Side-by-side overview table |

## How It Works

The comparison dynamically imports both the current and baseline builds:

- **Current**: imported from the working tree's `dist/`
- **Baseline**: imported from `/tmp/oil-bench-<hash>/dist/`

A `MockMcpServer` captures tool registrations from each version's `register*Tools()` functions, enabling schema comparison without running the full MCP server.

Tests **gracefully skip** when a module or API doesn't exist in the baseline (e.g., an older version may not have `GraphIndex` or may have a different search API).

## Environment Variables

| Variable | Set by | Description |
|----------|--------|-------------|
| `BENCH_BASELINE_DIR` | `bench-against.sh` | Path to the built baseline |
| `BENCH_BASELINE_REF` | `bench-against.sh` | Git ref label (e.g., `v0.4.0`) |
| `BENCH_BASELINE_HASH` | `bench-against.sh` | Short commit hash |
| `BENCH_FORCE_REBUILD` | User (optional) | Set to `1` to rebuild a cached baseline |

## Running Without the Script

You can also set the env vars manually:

```bash
# If you already have a built baseline somewhere:
BENCH_BASELINE_DIR=/path/to/old/oil \
BENCH_BASELINE_REF="v0.4.0" \
  npx vitest run --testPathPattern "bench/compare/"
```

## Caching

Baselines are cached in `/tmp/oil-bench-<hash>/`. Re-running with the same ref reuses the cached build. Use `BENCH_FORCE_REBUILD=1` to force a fresh build, or `rm -rf /tmp/oil-bench-*` to clear all caches.

## Comparison with `v04-vs-v05/`

The `v04-vs-v05/` directory contains a **hardcoded** comparison with manually duplicated schema definitions. This `compare/` suite is the **generic** replacement that works with any git ref dynamically. The old suite remains as a historical reference.
