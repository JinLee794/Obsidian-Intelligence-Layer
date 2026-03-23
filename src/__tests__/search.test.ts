/**
 * Tests for search.ts — lexical, fuzzy, and unified search.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  lexicalSearch,
  fuzzySearch,
  searchVault,
  invalidateSearchIndex,
} from "../search.js";
import { GraphIndex } from "../graph.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-search-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "Reference"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso.md"),
    `---\ntags: [customer, azure]\n---\n# Contoso\nKey customer.\n\n## GHCP Seat Analysis\n\n292 active seats.\n\n## Team\n\n- Alice (CSA)\n`,
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Customers/Fabrikam.md"),
    `---\ntags: [customer, m365]\n---\n# Fabrikam\nSecondary customer.\n\n## Azure Migration Plan\n\nPhase 1 complete.\n`,
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Customers/Northwind.md"),
    `---\ntags: [customer, azure, dynamics]\n---\n# Northwind Traders\nLong-time partner.\n`,
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Contoso Sync.md"),
    `---\ntags: [meeting]\ncustomer: Contoso\n---\n# Contoso Sync\nDiscussed migration.\n`,
    "utf-8",
  );
  // Body-only content — person name buried in a markdown table (not in title, tags, or headings)
  await writeFile(
    join(vaultRoot, "Reference/Committed-Milestone-Handoff-Tracker.md"),
    `---\ntags: [reference, tracker]\n---\n# Committed Milestone Handoff Tracker\n\n## Active Handoffs\n\n| Customer | Owner | Status |\n|---|---|---|\n| Contoso | Tony Bell | In Progress |\n| Fabrikam | Jane Smith | Complete |\n| Northwind | Carlos Rivera | Pending |\n`,
    "utf-8",
  );

  graph = new GraphIndex(vaultRoot);
  await graph.build();
  invalidateSearchIndex();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("lexicalSearch", () => {
  it("finds notes by title substring", () => {
    const results = lexicalSearch(graph, "Contoso", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
    expect(results.every((r) => r.matchType === "lexical")).toBe(true);
  });

  it("finds notes by tag substring", () => {
    const results = lexicalSearch(graph, "azure", 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
    expect(results.some((r) => r.title === "Northwind Traders")).toBe(true);
  });

  it("is case-insensitive", () => {
    const results = lexicalSearch(graph, "CONTOSO", 10);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
  });

  it("respects limit", () => {
    const results = lexicalSearch(graph, "customer", 1);
    expect(results.length).toBe(1);
  });

  it("returns empty for no match", () => {
    const results = lexicalSearch(graph, "zzz-no-match", 10);
    expect(results).toEqual([]);
  });

  it("title matches score higher than tag matches", () => {
    const results = lexicalSearch(graph, "Contoso", 10);
    const titleMatch = results.find((r) => r.title === "Contoso");
    expect(titleMatch!.score).toBe(1.0);
  });

  it("applies folder filter", () => {
    const results = lexicalSearch(graph, "Contoso", 10, {
      folder: "Meetings/",
    });
    expect(results.every((r) => r.path.startsWith("Meetings/"))).toBe(true);
  });

  it("applies tag filter", () => {
    const results = lexicalSearch(graph, "customer", 10, {
      tags: ["azure"],
    });
    // Only Contoso and Northwind have the azure tag
    expect(results.every((r) => r.title !== "Fabrikam")).toBe(true);
  });

  it("finds notes by heading substring", () => {
    const results = lexicalSearch(graph, "GHCP Seat", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
  });

  it("heading matches score between title and tag matches", () => {
    const results = lexicalSearch(graph, "GHCP Seat", 10);
    const headingMatch = results.find((r) => r.title === "Contoso");
    expect(headingMatch).toBeDefined();
    expect(headingMatch!.score).toBe(0.85);
  });

  it("finds notes by body content substring", () => {
    const results = lexicalSearch(graph, "Tony Bell", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });

  it("body matches score lower than heading and tag matches", () => {
    const results = lexicalSearch(graph, "Tony Bell", 10);
    const bodyMatch = results.find((r) => r.title === "Committed Milestone Handoff Tracker");
    expect(bodyMatch).toBeDefined();
    expect(bodyMatch!.score).toBe(0.5);
  });

  it("includes contextual excerpt for body-only matches", () => {
    const results = lexicalSearch(graph, "Tony Bell", 10);
    const bodyMatch = results.find((r) => r.title === "Committed Milestone Handoff Tracker");
    expect(bodyMatch).toBeDefined();
    expect(bodyMatch!.excerpt).toContain("Tony Bell");
  });

  it("finds inline data in markdown tables via body search", () => {
    const results = lexicalSearch(graph, "Carlos Rivera", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });
});

describe("fuzzySearch", () => {
  it("finds notes by fuzzy title match", () => {
    const results = fuzzySearch(graph, "Contos", 10);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
    expect(results.every((r) => r.matchType === "fuzzy")).toBe(true);
  });

  it("finds notes with typos", () => {
    const results = fuzzySearch(graph, "Nrothwind", 10);
    expect(results.some((r) => r.title === "Northwind Traders")).toBe(true);
  });

  it("returns scores between 0 and 1", () => {
    const results = fuzzySearch(graph, "Contoso", 10);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("applies folder filter", () => {
    const results = fuzzySearch(graph, "Contoso", 10, {
      folder: "Customers/",
    });
    expect(results.every((r) => r.path.startsWith("Customers/"))).toBe(true);
  });

  it("respects limit", () => {
    const results = fuzzySearch(graph, "customer", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("finds notes by fuzzy heading match", () => {
    invalidateSearchIndex();
    const results = fuzzySearch(graph, "GHCP Seat Analysis", 10);
    expect(results.some((r) => r.title === "Contoso")).toBe(true);
  });

  it("finds notes by heading even with typos", () => {
    invalidateSearchIndex();
    const results = fuzzySearch(graph, "Azure Migraton Plan", 10);
    expect(results.some((r) => r.title === "Fabrikam")).toBe(true);
  });

  it("finds notes by body content via fuzzy match", () => {
    invalidateSearchIndex();
    const results = fuzzySearch(graph, "Tony Bell", 10);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });

  it("finds body content with typos via fuzzy match", () => {
    invalidateSearchIndex();
    const results = fuzzySearch(graph, "Toni Bel", 10);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });
});

describe("searchVault — unified search", () => {
  it("uses config default tier (fuzzy)", async () => {
    const results = await searchVault(graph, config, "Contoso");
    expect(results.length).toBeGreaterThan(0);
  });

  it("can be forced to lexical tier", async () => {
    const results = await searchVault(graph, config, "Contoso", "lexical");
    expect(results.every((r) => r.matchType === "lexical")).toBe(true);
  });

  it("can be forced to fuzzy tier", async () => {
    const results = await searchVault(graph, config, "Contoso", "fuzzy");
    expect(results.every((r) => r.matchType === "fuzzy")).toBe(true);
  });

  it("falls back to fuzzy when semantic requested but unavailable", async () => {
    const results = await searchVault(
      graph, config, "Contoso", "semantic", 10, undefined, null,
    );
    expect(results.every((r) => r.matchType === "fuzzy")).toBe(true);
  });

  it("passes limit through", async () => {
    const results = await searchVault(graph, config, "customer", undefined, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("passes filters through", async () => {
    const results = await searchVault(
      graph, config, "Contoso", "lexical", 10,
      { folder: "Meetings/" },
    );
    expect(results.every((r) => r.path.startsWith("Meetings/"))).toBe(true);
  });
});

describe("invalidateSearchIndex", () => {
  it("forces fuse index rebuild on next search", () => {
    // First search builds index
    fuzzySearch(graph, "Contoso", 10);
    // Invalidate
    invalidateSearchIndex();
    // Next search should still work (rebuilds)
    const results = fuzzySearch(graph, "Contoso", 10);
    expect(results.length).toBeGreaterThan(0);
  });
});
