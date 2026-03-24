/**
 * Generic version comparison benchmark.
 *
 * Compares the current OIL build against any previous commit/tag/release.
 * Set BENCH_BASELINE_DIR to point at a built baseline (scripts/bench-against.sh does this).
 *
 * Dimensions tested:
 * 1. Tool surface comparison (added/removed/changed tools)
 * 2. Schema overhead (per-turn context tax)
 * 3. Cold-start latency
 * 4. Search latency
 * 5. Read latency
 * 6. Retrieval quality (precision/recall on ground-truth queries)
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  isBaselineAvailable,
  getBaselineLabel,
  buildCurrentSnapshot,
  buildBaselineSnapshot,
  type VersionSnapshot,
} from "../baseline.js";
import {
  VAULT_PATH,
  estimateTokens,
  totalSchemaTokens,
  timed,
  computePrecisionRecall,
} from "../harness.js";

// ── Skip entire suite when no baseline is configured ─────────────────────────

const runComparison = isBaselineAvailable();

let current: VersionSnapshot;
let baseline: VersionSnapshot;

beforeAll(async () => {
  if (!runComparison) return;
  const [c, b] = await Promise.all([
    buildCurrentSnapshot(),
    buildBaselineSnapshot(),
  ]);
  current = c;
  baseline = b!;
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TOOL SURFACE
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("1 — Tool Surface Comparison", () => {
  it("tool count", () => {
    console.log(`\n  Tool count:`);
    console.log(`    Current  (${current.label}): ${current.toolCount} tools`);
    console.log(`    Baseline (${baseline.label}): ${baseline.toolCount} tools`);

    const delta = current.toolCount - baseline.toolCount;
    if (delta > 0) console.log(`    Delta: +${delta} tools added`);
    else if (delta < 0) console.log(`    Delta: ${delta} tools removed`);
    else console.log(`    Delta: 0 (same tool count)`);

    expect(current.toolCount).toBeGreaterThan(0);
    expect(baseline.toolCount).toBeGreaterThan(0);
  });

  it("tool surface diff", () => {
    const currentSet = new Set(current.toolNames);
    const baselineSet = new Set(baseline.toolNames);

    const added = current.toolNames.filter((t) => !baselineSet.has(t));
    const removed = baseline.toolNames.filter((t) => !currentSet.has(t));
    const kept = current.toolNames.filter((t) => baselineSet.has(t));

    console.log(`\n  Tool Surface Diff (current vs baseline):`);
    if (added.length) console.log(`    Added   (+${added.length}): ${added.join(", ")}`);
    if (removed.length) console.log(`    Removed (-${removed.length}): ${removed.join(", ")}`);
    console.log(`    Kept    (=${kept.length}): ${kept.join(", ")}`);

    expect(current.toolNames.length).toBeGreaterThan(0);
  });

  it("tool list — current", () => {
    console.log(`\n  Current tools (${current.label}):`);
    for (const name of current.toolNames) {
      console.log(`    • ${name}`);
    }
    expect(current.toolNames.length).toBeGreaterThan(0);
  });

  it("tool list — baseline", () => {
    console.log(`\n  Baseline tools (${baseline.label}):`);
    for (const name of baseline.toolNames) {
      console.log(`    • ${name}`);
    }
    expect(baseline.toolNames.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SCHEMA OVERHEAD
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("2 — Schema Overhead (per-turn context tax)", () => {
  it("total schema tokens", () => {
    console.log(`\n  Schema overhead:`);
    console.log(`    Current  (${current.label}): ${current.toolCount} tools, ~${current.schemaTokens} tokens/turn`);
    console.log(`    Baseline (${baseline.label}): ${baseline.toolCount} tools, ~${baseline.schemaTokens} tokens/turn`);

    const delta = current.schemaTokens - baseline.schemaTokens;
    const pct = baseline.schemaTokens > 0
      ? ((delta / baseline.schemaTokens) * 100).toFixed(1)
      : "N/A";
    console.log(`    Delta: ${delta > 0 ? "+" : ""}${delta} tokens/turn (${delta > 0 ? "+" : ""}${pct}%)`);

    expect(current.schemaTokens).toBeGreaterThan(0);
    expect(baseline.schemaTokens).toBeGreaterThan(0);
  });

  it("per-tool schema cost", () => {
    const currentAvg = current.schemaTokens / current.toolCount;
    const baselineAvg = baseline.schemaTokens / baseline.toolCount;

    console.log(`\n  Average schema tokens per tool:`);
    console.log(`    Current:  ~${currentAvg.toFixed(0)} tokens/tool`);
    console.log(`    Baseline: ~${baselineAvg.toFixed(0)} tokens/tool`);

    expect(currentAvg).toBeGreaterThan(0);
  });

  it("session cost projection", () => {
    const turns = [10, 25, 50];
    console.log(`\n  Projected session schema cost:`);
    console.log(`  ┌──────────┬─────────────┬─────────────┬──────────────┐`);
    console.log(`  │ Turns    │ Current     │ Baseline    │ Delta        │`);
    console.log(`  ├──────────┼─────────────┼─────────────┼──────────────┤`);
    for (const t of turns) {
      const curr = current.schemaTokens * t;
      const base = baseline.schemaTokens * t;
      const delta = curr - base;
      console.log(
        `  │ ${String(t).padStart(6)}   │ ${String(curr).padStart(9)} t │ ${String(base).padStart(9)} t │ ${(delta > 0 ? "+" : "") + String(delta).padStart(10)} t │`,
      );
    }
    console.log(`  └──────────┴─────────────┴─────────────┴──────────────┘`);

    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. COLD-START LATENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("3 — Cold-Start Latency", () => {
  it("graph build — current", async () => {
    const graphMod = current.modules.graph;
    if (!graphMod || !("GraphIndex" in graphMod)) {
      console.log("  ⏭ Current version has no GraphIndex — skipping");
      return;
    }

    const g = new (graphMod as any).GraphIndex(VAULT_PATH);
    const { ms } = await timed(() => g.build());
    const stats = g.getStats();

    console.log(`\n  Current — graph build: ${ms.toFixed(1)}ms`);
    console.log(`    Notes: ${stats.noteCount}, Edges: ${stats.edgeCount ?? stats.linkCount ?? "?"}`);
    expect(ms).toBeGreaterThan(0);
  });

  it("graph build — baseline", async () => {
    const graphMod = baseline.modules.graph;
    if (!graphMod || !("GraphIndex" in graphMod)) {
      console.log("  ⏭ Baseline has no GraphIndex — skipping");
      return;
    }

    const g = new (graphMod as any).GraphIndex(VAULT_PATH);
    const { ms } = await timed(() => g.build());
    const stats = g.getStats();

    console.log(`\n  Baseline — graph build: ${ms.toFixed(1)}ms`);
    console.log(`    Notes: ${stats.noteCount}, Edges: ${stats.edgeCount ?? stats.linkCount ?? "?"}`);
    expect(ms).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SEARCH LATENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("4 — Search Latency", () => {
  const queries = ["Contoso", "migration", "Azure", "milestone"];
  const iterations = 5;

  it("search — current", async () => {
    const searchMod = current.modules.search as any;
    const graphMod = current.modules.graph as any;
    const configMod = current.modules.config as any;

    if (!searchMod?.fuzzySearch || !graphMod?.GraphIndex) {
      console.log("  ⏭ Current version missing search/graph — skipping");
      return;
    }

    const g = new graphMod.GraphIndex(VAULT_PATH);
    await g.build();

    console.log(`\n  Current — search latency (${iterations}-iteration avg):`);
    for (const q of queries) {
      let totalMs = 0;
      let resultCount = 0;
      for (let i = 0; i < iterations; i++) {
        const { result, ms } = await timed(() => searchMod.fuzzySearch(g, q, 5));
        totalMs += ms;
        resultCount = Array.isArray(result) ? result.length : 0;
      }
      console.log(`    "${q}": ${(totalMs / iterations).toFixed(2)}ms avg, ${resultCount} results`);
    }
    expect(true).toBe(true);
  });

  it("search — baseline", async () => {
    const searchMod = baseline.modules.search as any;
    const graphMod = baseline.modules.graph as any;

    if (!graphMod?.GraphIndex) {
      console.log("  ⏭ Baseline missing graph — skipping");
      return;
    }

    const g = new graphMod.GraphIndex(VAULT_PATH);
    await g.build();

    // Try multiple search function names (API may have changed)
    const searchFn =
      searchMod?.fuzzySearch ??
      searchMod?.searchVault ??
      null;

    if (!searchFn) {
      console.log("  ⏭ Baseline has no compatible search function — skipping");
      return;
    }

    console.log(`\n  Baseline — search latency (${iterations}-iteration avg):`);
    for (const q of queries) {
      let totalMs = 0;
      let resultCount = 0;
      for (let i = 0; i < iterations; i++) {
        try {
          const { result, ms } = await timed(() => searchFn(g, q, 5));
          totalMs += ms;
          resultCount = Array.isArray(result) ? result.length : 0;
        } catch {
          // Search API mismatch — try different arg patterns
          try {
            const configMod = baseline.modules.config as any;
            const cfg = configMod?.DEFAULT_CONFIG ?? await configMod?.loadConfig?.(VAULT_PATH);
            const { result, ms } = await timed(() =>
              searchMod.searchVault(g, cfg, q, "fuzzy", 5),
            );
            totalMs += ms;
            resultCount = Array.isArray(result) ? result.length : 0;
          } catch {
            console.log(`    "${q}": ⚠ search call failed (API mismatch)`);
            break;
          }
        }
      }
      if (totalMs > 0) {
        console.log(`    "${q}": ${(totalMs / iterations).toFixed(2)}ms avg, ${resultCount} results`);
      }
    }
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. READ LATENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("5 — Read Latency", () => {
  const testPaths = [
    "Customers/Contoso.md",
    "People/Alice Smith.md",
    "Projects/azure-migration.md",
  ];
  const iterations = 10;

  it("read_note — current", async () => {
    const vaultMod = current.modules.vault as any;
    if (!vaultMod?.readNote) {
      console.log("  ⏭ Current version has no readNote — skipping");
      return;
    }

    console.log(`\n  Current — readNote latency (${iterations}-iteration avg):`);
    for (const p of testPaths) {
      let totalMs = 0;
      let found = false;
      for (let i = 0; i < iterations; i++) {
        try {
          const { ms } = await timed(() => vaultMod.readNote(VAULT_PATH, p));
          totalMs += ms;
          found = true;
        } catch {
          break;
        }
      }
      if (found) {
        console.log(`    ${p}: ${(totalMs / iterations).toFixed(2)}ms avg`);
      } else {
        console.log(`    ${p}: (not found in fixture vault)`);
      }
    }
    expect(true).toBe(true);
  });

  it("read_note — baseline", async () => {
    const vaultMod = baseline.modules.vault as any;
    if (!vaultMod?.readNote) {
      console.log("  ⏭ Baseline has no readNote — skipping");
      return;
    }

    console.log(`\n  Baseline — readNote latency (${iterations}-iteration avg):`);
    for (const p of testPaths) {
      let totalMs = 0;
      let found = false;
      for (let i = 0; i < iterations; i++) {
        try {
          const { ms } = await timed(() => vaultMod.readNote(VAULT_PATH, p));
          totalMs += ms;
          found = true;
        } catch {
          break;
        }
      }
      if (found) {
        console.log(`    ${p}: ${(totalMs / iterations).toFixed(2)}ms avg`);
      } else {
        console.log(`    ${p}: (not found in fixture vault)`);
      }
    }
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. RETRIEVAL QUALITY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("6 — Retrieval Quality", () => {
  const groundTruth = [
    {
      query: "Contoso",
      expected: [
        "Customers/Contoso.md",
        "People/Alice Smith.md",
        "People/Bob Chen.md",
        "Meetings/2026-02-20-Contoso-Migration-Review.md",
        "Projects/azure-migration.md",
        "Weekly/2026-W08.md",
      ],
    },
    {
      query: "migration",
      expected: [
        "Projects/azure-migration.md",
        "Customers/Contoso.md",
        "Meetings/2026-02-20-Contoso-Migration-Review.md",
      ],
    },
  ];

  it("precision/recall — current", async () => {
    const searchMod = current.modules.search as any;
    const graphMod = current.modules.graph as any;

    if (!searchMod?.fuzzySearch || !graphMod?.GraphIndex) {
      console.log("  ⏭ Current version missing search/graph — skipping");
      return;
    }

    const g = new graphMod.GraphIndex(VAULT_PATH);
    await g.build();

    console.log(`\n  Current — retrieval quality:`);
    for (const { query, expected } of groundTruth) {
      const results = searchMod.fuzzySearch(g, query, 10);
      const returned = results.map((r: any) => r.path);
      const { precision, recall, f1 } = computePrecisionRecall(expected, returned);
      console.log(`    "${query}": P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)} (${returned.length} returned)`);
    }
    expect(true).toBe(true);
  });

  it("precision/recall — baseline", async () => {
    const searchMod = baseline.modules.search as any;
    const graphMod = baseline.modules.graph as any;

    if (!graphMod?.GraphIndex) {
      console.log("  ⏭ Baseline missing graph — skipping");
      return;
    }

    const g = new graphMod.GraphIndex(VAULT_PATH);
    await g.build();

    const searchFn = searchMod?.fuzzySearch ?? searchMod?.searchVault ?? null;
    if (!searchFn) {
      console.log("  ⏭ Baseline has no compatible search — skipping");
      return;
    }

    console.log(`\n  Baseline — retrieval quality:`);
    for (const { query, expected } of groundTruth) {
      let returned: string[] = [];
      try {
        const results = searchFn(g, query, 10);
        returned = (Array.isArray(results) ? results : []).map((r: any) => r.path);
      } catch {
        try {
          const configMod = baseline.modules.config as any;
          const cfg = configMod?.DEFAULT_CONFIG ?? await configMod?.loadConfig?.(VAULT_PATH);
          const results = await searchMod.searchVault(g, cfg, query, "fuzzy", 10);
          returned = (Array.isArray(results) ? results : []).map((r: any) => r.path);
        } catch {
          console.log(`    "${query}": ⚠ search failed (API mismatch)`);
          continue;
        }
      }
      const { precision, recall, f1 } = computePrecisionRecall(expected, returned);
      console.log(`    "${query}": P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)} (${returned.length} returned)`);
    }
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!runComparison)("7 — Summary", () => {
  it("side-by-side overview", () => {
    const currentSet = new Set(current.toolNames);
    const baselineSet = new Set(baseline.toolNames);
    const added = current.toolNames.filter((t) => !baselineSet.has(t));
    const removed = baseline.toolNames.filter((t) => !currentSet.has(t));

    const schemaDelta = current.schemaTokens - baseline.schemaTokens;
    const schemaPct = baseline.schemaTokens > 0
      ? ((schemaDelta / baseline.schemaTokens) * 100).toFixed(1)
      : "N/A";

    console.log(`\n  ═══════════════════════════════════════════════════════════════`);
    console.log(`  COMPARISON SUMMARY`);
    console.log(`  Current:  ${current.label}`);
    console.log(`  Baseline: ${baseline.label}`);
    console.log(`  ═══════════════════════════════════════════════════════════════`);
    console.log(`  ┌────────────────────────┬─────────────┬─────────────┐`);
    console.log(`  │ Metric                 │ Current     │ Baseline    │`);
    console.log(`  ├────────────────────────┼─────────────┼─────────────┤`);
    console.log(`  │ Tool count             │ ${String(current.toolCount).padStart(11)} │ ${String(baseline.toolCount).padStart(11)} │`);
    console.log(`  │ Schema tokens/turn     │ ${String(current.schemaTokens).padStart(11)} │ ${String(baseline.schemaTokens).padStart(11)} │`);
    console.log(`  │ Schema Δ               │ ${(schemaDelta > 0 ? "+" : "") + String(schemaDelta).padStart(10)} │             │`);
    console.log(`  │ Schema Δ %             │ ${(schemaDelta > 0 ? "+" : "") + schemaPct.padStart(9)}% │             │`);
    console.log(`  │ Tools added            │ ${String(added.length).padStart(11)} │             │`);
    console.log(`  │ Tools removed          │ ${String(removed.length).padStart(11)} │             │`);
    console.log(`  └────────────────────────┴─────────────┴─────────────┘`);

    if (added.length > 0) console.log(`\n  Added:   ${added.join(", ")}`);
    if (removed.length > 0) console.log(`  Removed: ${removed.join(", ")}`);

    expect(true).toBe(true);
  });
});
