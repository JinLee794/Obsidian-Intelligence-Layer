/**
 * Tests for search.ts — lexical, fuzzy, and the tiered cascade.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  lexicalSearch,
  fuzzySearch,
  cascadeSearch,
  invalidateSearchIndex,
} from "../search.js";
import { GraphIndex } from "../graph.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-search-"));
  vaultRoot = join(tempDir, "vault");

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

  it("ranks a title match above a note that only mentions the term", () => {
    const results = lexicalSearch(graph, "Contoso", 10);
    const titleRank = results.findIndex((r) => r.path === "Customers/Contoso.md");
    const mentionRank = results.findIndex((r) =>
      r.path.startsWith("Reference/"),
    );
    expect(titleRank).toBeGreaterThanOrEqual(0);
    expect(mentionRank === -1 || titleRank < mentionRank).toBe(true);
  });

  // BM25's IDF term: "azure" appears in several notes, "dynamics" in one, so
  // the rare term must carry more weight than the common one.
  it("scores a rare term above a common one", () => {
    const rare = lexicalSearch(graph, "dynamics", 10);
    const common = lexicalSearch(graph, "customer", 10);
    expect(rare[0].path).toBe("Customers/Northwind.md");
    expect(rare.length).toBeLessThan(common.length);
  });

  it("ranks notes matching more query terms first", () => {
    const results = lexicalSearch(graph, "Azure migration", 10);
    expect(results[0].path).toBe("Customers/Fabrikam.md");
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

  it("scores every result within a normalised range", () => {
    const results = lexicalSearch(graph, "GHCP Seat", 10);
    const headingMatch = results.find((r) => r.title === "Contoso");
    expect(headingMatch).toBeDefined();
    expect(headingMatch!.score).toBeGreaterThan(0);
    expect(headingMatch!.score).toBeLessThanOrEqual(1);
  });

  it("finds notes by body content substring", () => {
    const results = lexicalSearch(graph, "Tony Bell", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });

  it("matches a partial word so prefix queries still retrieve", () => {
    const results = lexicalSearch(graph, "migrat", 10);
    expect(results.some((r) => r.path === "Customers/Fabrikam.md")).toBe(true);
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

  it("leaves body text to the lexical tier", () => {
    // The fuse index deliberately covers only title, tags and headings. BM25
    // already indexes bodies with term statistics, so duplicating them here
    // bought a slower second pass over the same text and nothing else.
    invalidateSearchIndex();
    const results = fuzzySearch(graph, "Tony Bell", 10);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(false);
  });
});

describe("cascadeSearch — tiered search", () => {
  it("answers an entity query on the lexical tier alone", async () => {
    const { results, tiersUsed, escalation } = await cascadeSearch(graph, "Contoso", 1, undefined);
    expect(results.length).toBe(1);
    expect(tiersUsed).toContain("lexical");
    expect(escalation).toBeNull();
    expect(results[0].matchedBy).toEqual(["lexical"]);
  });

  it("escalates to fuzzy when lexical cannot match the query", async () => {
    // Transposition that BM25 can't match but fuse can.
    const { results, tiersUsed, escalation } = await cascadeSearch(graph, "Cnotoso", 5, undefined);
    expect(tiersUsed).toContain("fuzzy");
    expect(escalation).toBe("partial_term_coverage");
    expect(results.some((r) => r.matchedBy.includes("fuzzy"))).toBe(true);
  });

  it("still finds body-only content through the lexical tier", async () => {
    const { results } = await cascadeSearch(graph, "Tony Bell", 10, undefined);
    expect(results.some((r) => r.title === "Committed Milestone Handoff Tracker")).toBe(true);
  });

  it("respects limit", async () => {
    const { results } = await cascadeSearch(graph, "customer", 1, undefined);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("applies filters across every tier", async () => {
    const { results } = await cascadeSearch(graph, "Contoso", 10, { folder: "Meetings/" });
    expect(results.every((r) => r.path.startsWith("Meetings/"))).toBe(true);
  });

  it("omits the semantic tier when no index is attached", async () => {
    const { tiersUsed } = await cascadeSearch(graph, "Cnotoso", 5, undefined);
    expect(tiersUsed).not.toContain("semantic");
  });

  it("skips the fuzzy tier for natural-language queries", async () => {
    // Fuzzy exists to recover a misspelled name. A long question is never one,
    // and it is the query shape fuse.js is slowest on.
    const { tiersUsed } = await cascadeSearch(
      graph,
      "which customer might be thinking about leaving us soon",
      5,
      undefined,
    );
    expect(tiersUsed).not.toContain("fuzzy");
  });

  it("still runs the fuzzy tier for a misspelled name", async () => {
    const { tiersUsed } = await cascadeSearch(graph, "Nrothwind", 5, undefined);
    expect(tiersUsed).toContain("fuzzy");
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

describe("fuse index lifecycle", () => {
  it("picks up in-place content edits without an explicit invalidation", async () => {
    const editVault = join(tempDir, "edit-vault");
    await mkdir(join(editVault, "Customers"), { recursive: true });
    await writeFile(
      join(editVault, "Customers/Acme.md"),
      `---\ntags: [customer]\n---\n# Acme\n\n## Notes\n\nOriginal body text.\n`,
      "utf-8",
    );

    const editGraph = new GraphIndex(editVault);
    await editGraph.build();

    expect(fuzzySearch(editGraph, "Zephyrus", 10).length).toBe(0);

    // Node count is unchanged by an in-place edit — only the graph version
    // moves — so the heading has to reach the index off the version alone.
    await writeFile(
      join(editVault, "Customers/Acme.md"),
      `---\ntags: [customer]\n---\n# Acme\n\n## Zephyrus rollout\n\nBody text.\n`,
      "utf-8",
    );
    await editGraph.updateNote("Customers/Acme.md");

    expect(fuzzySearch(editGraph, "Zephyrus", 10).length).toBeGreaterThan(0);
  });

  it("does not serve one graph's index to another graph", async () => {
    // Two vaults with identical node counts — the count alone cannot tell the
    // caches apart, so the index must be keyed on the graph instance.
    const vaultA = join(tempDir, "vault-a");
    const vaultB = join(tempDir, "vault-b");
    await mkdir(join(vaultA, "Customers"), { recursive: true });
    await mkdir(join(vaultB, "Customers"), { recursive: true });
    await writeFile(
      join(vaultA, "Customers/Umbrella.md"),
      `---\ntags: [customer]\n---\n# Umbrella\n\nVault A only.\n`,
      "utf-8",
    );
    await writeFile(
      join(vaultB, "Customers/Initech.md"),
      `---\ntags: [customer]\n---\n# Initech\n\nVault B only.\n`,
      "utf-8",
    );

    const graphA = new GraphIndex(vaultA);
    const graphB = new GraphIndex(vaultB);
    await graphA.build();
    await graphB.build();
    expect(graphA.nodeCount).toBe(graphB.nodeCount);

    expect(fuzzySearch(graphA, "Umbrella", 10).length).toBeGreaterThan(0);
    const bResults = fuzzySearch(graphB, "Umbrella", 10);
    expect(bResults.every((r) => r.path.startsWith("Customers/Initech"))).toBe(true);
  });
});
