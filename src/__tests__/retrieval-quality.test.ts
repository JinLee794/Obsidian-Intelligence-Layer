/**
 * Retrieval quality regression — rank-position assertions on the fixture vault.
 *
 * Unlike containment checks ("is X somewhere in top-5?"), these tests assert
 * the *exact* rank position ceiling. A silent degradation from rank 0 → rank 3
 * now fires as a test failure, giving a clear signal that search quality dropped.
 *
 * Recall minimums and tier-agreement tests are kept as complements.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { GraphIndex } from "../graph.js";
import { loadConfig } from "../config.js";
import { fuzzySearch, searchVault } from "../search.js";
import type { OilConfig } from "../types.js";

const VAULT_PATH = resolve(import.meta.dirname, "../../bench/fixtures/vault");

let graph: GraphIndex;
let config: OilConfig;

beforeAll(async () => {
  config = await loadConfig(VAULT_PATH);
  graph = new GraphIndex(VAULT_PATH);
  await graph.build();
});

/** Return 0-based rank of `target` in results, or -1 if absent. */
function rankOf(results: { path: string }[], target: string): number {
  return results.findIndex((r) => r.path === target);
}

/** Return 0-based rank of first result whose path starts with `prefix`. */
function firstRankInFolder(results: { path: string }[], prefix: string): number {
  return results.findIndex((r) => r.path.startsWith(prefix));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rank-position ceilings — the primary note is at or above this rank
// ═══════════════════════════════════════════════════════════════════════════════

describe("Rank-position ceilings", () => {
  it("'Contoso' → customer note is rank 0 (top-1)", () => {
    const results = searchVault(graph, config, "Contoso", undefined, 10);
    const rank = rankOf(results, "Customers/Contoso.md");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(0);
  });

  it("'migration' → project or meeting in top-2", () => {
    const results = searchVault(graph, config, "migration", undefined, 10);
    const projectRank = rankOf(results, "Projects/azure-migration.md");
    const meetingRank = rankOf(results, "Meetings/2026-02-20-Contoso-Migration-Review.md");
    const bestRank = [projectRank, meetingRank].filter((r) => r >= 0);
    expect(bestRank.length).toBeGreaterThan(0);
    expect(Math.min(...bestRank)).toBeLessThanOrEqual(1);
  });

  it("'Dave Wilson' → person note is rank 0 (top-1)", () => {
    const results = searchVault(graph, config, "Dave Wilson", undefined, 10);
    const rank = rankOf(results, "People/Dave Wilson.md");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(0);
  });

  it("'AI copilot' → project note in top-2", () => {
    const results = searchVault(graph, config, "AI copilot", undefined, 10);
    const rank = rankOf(results, "Projects/ai-copilot-pilot.md");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(1);
  });

  it("'risk' → Northwind (at-risk customer) in top-3", () => {
    const results = searchVault(graph, config, "risk", undefined, 10);
    const rank = rankOf(results, "Customers/Northwind.md");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Recall minimums — queries return enough relevant results
// ═══════════════════════════════════════════════════════════════════════════════

describe("Recall minimums", () => {
  it("'Contoso' returns ≥3 results (customer + meeting + people)", () => {
    const results = searchVault(graph, config, "Contoso", undefined, 10);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("'migration' returns ≥2 results from Projects/ or Meetings/", () => {
    const results = searchVault(graph, config, "migration", undefined, 10);
    const relevant = results.filter(
      (r) => r.path.startsWith("Projects/") || r.path.startsWith("Meetings/"),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(2);
  });

  it("'risk' surfaces results across ≥2 folders", () => {
    const results = searchVault(graph, config, "risk", undefined, 10);
    const folders = new Set(results.map((r) => r.path.split("/")[0]));
    expect(folders.size).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tier agreement — cascade and fuzzy agree on unambiguous queries
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cascade / fuzzy tier agreement", () => {
  it("top-1 agreement on unambiguous entity queries", () => {
    for (const q of ["Contoso", "Dave Wilson", "AI copilot"]) {
      const cascade = searchVault(graph, config, q, undefined, 5);
      const fuzzy = fuzzySearch(graph, q, 5);
      expect(cascade[0].path).toBe(fuzzy[0].path);
    }
  });

  it("fuzzy finds same primary note as cascade for 'migration'", () => {
    const cascade = searchVault(graph, config, "migration", undefined, 5);
    const fuzzy = fuzzySearch(graph, "migration", 5);
    // Both should include the migration project or meeting
    const cascadePaths = cascade.map((r) => r.path);
    const fuzzyPaths = fuzzy.map((r) => r.path);
    const migrationNotes = [
      "Projects/azure-migration.md",
      "Meetings/2026-02-20-Contoso-Migration-Review.md",
    ];
    expect(migrationNotes.some((n) => cascadePaths.includes(n))).toBe(true);
    expect(migrationNotes.some((n) => fuzzyPaths.includes(n))).toBe(true);
  });
});
