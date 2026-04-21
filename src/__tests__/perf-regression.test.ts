/**
 * Performance regression — assertion-based latency ceilings.
 *
 * Unlike statistical benchmarks (vitest bench) that require human interpretation,
 * these tests fail CI when a latency ceiling is breached. Thresholds are generous
 * enough to avoid flakes, tight enough to catch 5–10× regressions.
 *
 * For profiling and ops/sec comparison, use: npx vitest bench bench/scale.bench.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { loadConfig } from "../config.js";
import { searchVault, invalidateSearchIndex, fuzzySearch } from "../search.js";
import { setupHarness, FIXTURE_VAULT, type MockMcpServer } from "./harness.js";
import { generateVault } from "../../bench/fixtures/generate-vault.js";
import type { OilConfig } from "../types.js";

let server: MockMcpServer;
let graph: GraphIndex;
let config: OilConfig;

beforeAll(async () => {
  ({ server, graph, config } = await setupHarness());
});

// ── Helper ──────────────────────────────────────────────────────────────────

/** Time an async operation in ms (median of N runs). */
async function medianMs(fn: () => unknown | Promise<unknown>, runs = 5): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Cold-start ceilings
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cold-start ceilings", () => {
  it("graph build on fixture vault ≤500ms", async () => {
    const ms = await medianMs(async () => {
      const g = new GraphIndex(FIXTURE_VAULT);
      await g.build();
    }, 3);
    expect(ms).toBeLessThan(500);
  });

  it("fuse.js index build on fixture vault ≤500ms", async () => {
    const ms = await medianMs(() => {
      invalidateSearchIndex();
      fuzzySearch(graph, "warmup", 1);
    }, 3);
    expect(ms).toBeLessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Search latency ceilings
// ═══════════════════════════════════════════════════════════════════════════════

describe("Search latency ceilings", () => {
  it("cascade search ≤50ms", async () => {
    // Warm up index
    searchVault(graph, config, "warmup", undefined, 5);

    const ms = await medianMs(() => {
      searchVault(graph, config, "migration", undefined, 10);
    });
    expect(ms).toBeLessThan(50);
  });

  it("fuzzy search ≤50ms (warm index)", async () => {
    fuzzySearch(graph, "warmup", 1); // warm

    const ms = await medianMs(() => {
      fuzzySearch(graph, "risk", 10);
    });
    expect(ms).toBeLessThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Tool layer latency ceilings
// ═══════════════════════════════════════════════════════════════════════════════

describe("Tool layer latency ceilings", () => {
  it("get_health ≤50ms", async () => {
    const ms = await medianMs(() => server.callToolRaw("get_health", {}));
    expect(ms).toBeLessThan(50);
  });

  it("get_customer_context (brief) ≤100ms", async () => {
    const ms = await medianMs(() =>
      server.callToolRaw("get_customer_context", { customer: "Contoso", view: "brief" }),
    );
    expect(ms).toBeLessThan(100);
  });

  it("get_customer_context (full) ≤150ms", async () => {
    const ms = await medianMs(() =>
      server.callToolRaw("get_customer_context", { customer: "Contoso", view: "full" }),
    );
    expect(ms).toBeLessThan(150);
  });

  it("search_vault tool ≤100ms", async () => {
    // Warm
    await server.callToolRaw("search_vault", { query: "warmup", limit: 1 });

    const ms = await medianMs(() =>
      server.callToolRaw("search_vault", { query: "migration", limit: 10 }),
    );
    expect(ms).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Scaling regression — latency grows sub-linearly with vault size
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scaling regression", () => {
  let smallDir: string | null = null;
  let largeDir: string | null = null;

  afterAll(async () => {
    if (smallDir) await rm(smallDir, { recursive: true, force: true });
    if (largeDir) await rm(largeDir, { recursive: true, force: true });
  });

  async function buildAndTimeSearch(noteCount: number): Promise<{ buildMs: number; searchMs: number; dir: string }> {
    const dir = await mkdtemp(`${tmpdir()}/oil-perf-`);
    const vaultPath = `${dir}/vault`;
    await generateVault({ noteCount, outputDir: vaultPath });

    const cfg = await loadConfig(vaultPath);
    const g = new GraphIndex(vaultPath);

    const buildT0 = performance.now();
    await g.build();
    const buildMs = performance.now() - buildT0;

    // Warm the index
    searchVault(g, cfg, "warmup", undefined, 1);

    const searchMs = await medianMs(() => {
      searchVault(g, cfg, "migration", undefined, 10);
    });

    return { buildMs, searchMs, dir };
  }

  it("4× notes → search latency < 4× (sub-linear)", async () => {
    const small = await buildAndTimeSearch(500);
    smallDir = small.dir;

    const large = await buildAndTimeSearch(2000);
    largeDir = large.dir;

    // 4× notes should yield less than 4× search time.
    // Use a generous multiplier to avoid flakes — we're catching O(n²), not fine-tuning.
    // Floor at 1ms to avoid ratio blowup when both measurements are sub-millisecond.
    const smallMs = Math.max(small.searchMs, 1);
    const largeMs = Math.max(large.searchMs, 1);
    expect(largeMs).toBeLessThan(smallMs * 4);
  }, 60_000);

  it("4× notes → graph build < 6× (roughly linear)", async () => {
    // Reuse the vaults from the previous test — but if they were cleaned up, regenerate.
    if (!smallDir || !largeDir) {
      const small = await buildAndTimeSearch(500);
      smallDir = small.dir;
      const large = await buildAndTimeSearch(2000);
      largeDir = large.dir;
    }

    const smallCfg = await loadConfig(`${smallDir}/vault`);
    const largeCfg = await loadConfig(`${largeDir}/vault`);

    const smallBuild = await medianMs(async () => {
      const g = new GraphIndex(`${smallDir}/vault`);
      await g.build();
    }, 3);

    const largeBuild = await medianMs(async () => {
      const g = new GraphIndex(`${largeDir}/vault`);
      await g.build();
    }, 3);

    // Graph build should be roughly linear — 6× multiplier catches quadratic blowup.
    expect(largeBuild).toBeLessThan(smallBuild * 6);
  }, 60_000);
});
