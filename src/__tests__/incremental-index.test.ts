/**
 * Incremental index maintenance.
 *
 * The contract these tests defend is equivalence: after any sequence of edits,
 * an incrementally updated index must rank identically to one built from
 * scratch over the same final vault. Incremental indexes fail quietly — a stale
 * posting list or a document length that was never decremented shifts scores
 * rather than throwing — so every assertion compares against a fresh build.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { lexicalSearch, fuzzySearch, invalidateSearchIndex } from "../search.js";
import { exactFieldSearch } from "../bm25.js";

let tempDir: string;
let vault: string;
let graph: GraphIndex;

const QUERIES = ["migration", "customer", "Contoso", "azure platform", "renewal"];

async function writeNote(rel: string, body: string): Promise<void> {
  await writeFile(join(vault, rel), body, "utf-8");
}

/** A graph built from scratch over the current on-disk state. */
async function freshGraph(): Promise<GraphIndex> {
  const fresh = new GraphIndex(vault);
  await fresh.build();
  return fresh;
}

/**
 * Assert the incrementally maintained `graph` ranks exactly like a fresh build.
 * Compares scores and excerpts, not just paths, since a leaked posting or a
 * wrong average document length shows up only in the score.
 */
async function expectEquivalentToFullRebuild(): Promise<void> {
  const fresh = await freshGraph();
  for (const query of QUERIES) {
    expect(lexicalSearch(graph, query, 20), `lexical: ${query}`).toEqual(
      lexicalSearch(fresh, query, 20),
    );

    // fuse.js orders equal-scoring entries by collection position, which an
    // incremental update legitimately permutes, so compare membership.
    const actualFuzzy = fuzzySearch(graph, query, 20).map((r) => r.path).sort();
    const expectedFuzzy = fuzzySearch(fresh, query, 20).map((r) => r.path).sort();
    expect(actualFuzzy, `fuzzy: ${query}`).toEqual(expectedFuzzy);
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-incremental-"));
  vault = join(tempDir, "vault");
  await mkdir(join(vault, "Customers"), { recursive: true });
  await mkdir(join(vault, "Meetings"), { recursive: true });

  await writeNote(
    "Customers/Contoso.md",
    `---\ntags: [customer, azure]\ntpid: TPID-001\n---\n# Contoso\n\n## Platform\n\nAzure migration in progress across three regions.\n`,
  );
  await writeNote(
    "Customers/Northwind.md",
    `---\ntags: [customer, risk]\ntpid: TPID-002\n---\n# Northwind Traders\n\n## Renewal\n\nRenewal at risk after a missed quarterly review.\n`,
  );
  await writeNote(
    "Meetings/2026-03-01 Sync.md",
    `---\ntags: [meeting]\ncustomer: Contoso\n---\n# Contoso Sync\n\nDiscussed the migration plan and platform dependencies.\n`,
  );

  graph = new GraphIndex(vault);
  await graph.build();
  invalidateSearchIndex();

  // Warm both indexes so subsequent assertions exercise the incremental path.
  lexicalSearch(graph, "warmup", 5);
  fuzzySearch(graph, "warmup", 5);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("incremental index maintenance", () => {
  it("matches a full rebuild after an in-place edit", async () => {
    await writeNote(
      "Customers/Contoso.md",
      `---\ntags: [customer, azure]\ntpid: TPID-001\n---\n# Contoso\n\n## Platform\n\nMigration paused pending a renewal conversation.\n`,
    );
    await graph.updateNote("Customers/Contoso.md");

    await expectEquivalentToFullRebuild();
  });

  it("matches a full rebuild after a new note appears", async () => {
    await writeNote(
      "Customers/Fabrikam.md",
      `---\ntags: [customer, azure]\ntpid: TPID-003\n---\n# Fabrikam\n\n## Platform\n\nAzure platform migration kickoff scheduled.\n`,
    );
    await graph.updateNote("Customers/Fabrikam.md");

    await expectEquivalentToFullRebuild();
  });

  it("matches a full rebuild after a deletion", async () => {
    await unlink(join(vault, "Customers/Northwind.md"));
    graph.removeNote("Customers/Northwind.md");

    await expectEquivalentToFullRebuild();
  });

  it("matches a full rebuild after a mixed batch of changes", async () => {
    await writeNote(
      "Customers/Woodgrove.md",
      `---\ntags: [customer]\ntpid: TPID-004\n---\n# Woodgrove\n\n## Renewal\n\nRenewal conversation opened this week.\n`,
    );
    await writeNote(
      "Customers/Contoso.md",
      `---\ntags: [customer, enterprise]\ntpid: TPID-001\n---\n# Contoso\n\n## Platform\n\nCompletely different body about capacity planning.\n`,
    );
    await unlink(join(vault, "Meetings/2026-03-01 Sync.md"));

    await graph.updateNote("Customers/Woodgrove.md");
    await graph.updateNote("Customers/Contoso.md");
    graph.removeNote("Meetings/2026-03-01 Sync.md");

    await expectEquivalentToFullRebuild();
  });

  it("retires vocabulary that no surviving note contains", async () => {
    // "quarterly" exists only in Northwind. After deletion neither an exact
    // term match nor a prefix expansion may resurrect it from a stale posting.
    expect(lexicalSearch(graph, "quarterly", 10).length).toBeGreaterThan(0);

    await unlink(join(vault, "Customers/Northwind.md"));
    graph.removeNote("Customers/Northwind.md");

    expect(lexicalSearch(graph, "quarterly", 10)).toEqual([]);
    expect(lexicalSearch(graph, "quarter", 10)).toEqual([]);
  });

  it("keeps exact frontmatter lookups in step with edits", async () => {
    expect(exactFieldSearch(graph, "TPID-002").length).toBe(1);

    await writeNote(
      "Customers/Northwind.md",
      `---\ntags: [customer, risk]\ntpid: TPID-999\n---\n# Northwind Traders\n\n## Renewal\n\nRenewal at risk after a missed quarterly review.\n`,
    );
    await graph.updateNote("Customers/Northwind.md");

    expect(exactFieldSearch(graph, "TPID-002")).toEqual([]);
    expect(exactFieldSearch(graph, "TPID-999").length).toBe(1);
  });

  it("drops a deleted note from the fuzzy index", async () => {
    expect(fuzzySearch(graph, "Nrothwind", 10).length).toBeGreaterThan(0);

    await unlink(join(vault, "Customers/Northwind.md"));
    graph.removeNote("Customers/Northwind.md");

    const results = fuzzySearch(graph, "Nrothwind", 10);
    expect(results.every((r) => r.path !== "Customers/Northwind.md")).toBe(true);
  });
});

describe("GraphIndex.changesSince", () => {
  it("reports no changes when the version has not moved", () => {
    expect(graph.changesSince(graph.version)).toEqual([]);
  });

  it("reports the paths that actually moved", async () => {
    const before = graph.version;
    await graph.updateNote("Customers/Contoso.md");

    expect(graph.changesSince(before)).toEqual(["Customers/Contoso.md"]);
  });

  it("reports a deleted note", () => {
    const before = graph.version;
    graph.removeNote("Customers/Northwind.md");

    expect(graph.changesSince(before)).toEqual(["Customers/Northwind.md"]);
  });

  it("forces a rebuild for callers from before a full build", async () => {
    const before = graph.version;
    await graph.build();

    expect(graph.changesSince(before)).toBeNull();
  });

  it("forces a rebuild once the delta history has been discarded", async () => {
    const before = graph.version;
    // One entry per update — an in-place re-index, no remove-then-re-add — so
    // this has to clear the 2,048-entry bound on its own to evict the caller's
    // starting point.
    for (let i = 0; i < 2100; i++) {
      await graph.updateNote("Customers/Contoso.md");
    }

    expect(graph.changesSince(before)).toBeNull();
    expect(graph.changesSince(graph.version)).toEqual([]);
    // Thousands of real read-and-parse cycles land well past the default
    // timeout on a busy machine. Measured, the graph work is free: one
    // `updateNote` costs less than the bare `readFile` it has to do (3.7ms vs
    // 4.3ms at the same moment), so this is filesystem contention, not index
    // cost, and it swings ~6x run to run. The count is load-bearing — it has to
    // exceed the log bound — so the budget gives way rather than the coverage.
  }, 120_000);
});
