/**
 * Tests for graph.ts — GraphIndex: build, queries, incremental updates, persistence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GraphIndex } from "../graph.js";
import { mkdtemp, rm, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-graph-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(join(vaultRoot, "Customers"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });

  // Create notes with frontmatter, wikilinks, #tags
  await writeFile(
    join(vaultRoot, "Customers/Contoso.md"),
    `---
tags: [customer, active]
tpid: "12345"
---

# Contoso

Key account. See [[Alice Smith]] and [[Bob Jones]].

## Opportunities

- Contoso Cloud Migration

## Team

- Alice (CSA)
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Fabrikam.md"),
    `---
tags: [customer]
---

# Fabrikam

Secondary account. Links to [[Contoso]].

#pipeline #active
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Alice Smith.md"),
    `---
tags: [person]
company: Microsoft
org: internal
---

# Alice Smith

CSA for [[Contoso]] and [[Fabrikam]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Bob Jones.md"),
    `---
tags: [person]
company: Contoso
org: customer
---

# Bob Jones

CTO at [[Contoso]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Contoso Sync.md"),
    `---
tags: [meeting]
customer: Contoso
date: "2026-03-01"
---

# Contoso Sync

Discussed [[Contoso]] migration plan with [[Alice Smith]].
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("GraphIndex — full build", () => {
  let graph: GraphIndex;

  beforeAll(async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
  });

  it("indexes all notes", () => {
    expect(graph.nodeCount).toBe(5);
  });

  it("parses frontmatter tags", () => {
    const node = graph.getNode("Customers/Contoso.md");
    expect(node).toBeDefined();
    expect(node!.tags).toContain("customer");
    expect(node!.tags).toContain("active");
  });

  it("extracts inline hashtags", () => {
    const node = graph.getNode("Customers/Fabrikam.md");
    expect(node).toBeDefined();
    expect(node!.tags).toContain("pipeline");
    expect(node!.tags).toContain("active");
  });

  it("extracts H1 title", () => {
    const node = graph.getNode("Customers/Contoso.md");
    expect(node!.title).toBe("Contoso");
  });

  it("falls back to filename if no H1", async () => {
    await writeFile(
      join(vaultRoot, "no-h1.md"),
      "---\ntags: [test]\n---\nNo heading here.\n",
      "utf-8",
    );
    const g2 = new GraphIndex(vaultRoot);
    await g2.build();
    const node = g2.getNode("no-h1.md");
    expect(node!.title).toBe("no-h1");
    await unlink(join(vaultRoot, "no-h1.md"));
  });

  it("resolves wikilinks to forward links", () => {
    const contoso = graph.getNode("Customers/Contoso.md");
    expect(contoso!.outLinks.has("People/Alice Smith.md")).toBe(true);
    expect(contoso!.outLinks.has("People/Bob Jones.md")).toBe(true);
  });

  it("computes backlinks", () => {
    const alice = graph.getNode("People/Alice Smith.md");
    // Alice is linked from Contoso and the meeting
    expect(alice!.inLinks.has("Customers/Contoso.md")).toBe(true);
    expect(alice!.inLinks.has("Meetings/2026-03-01 - Contoso Sync.md")).toBe(true);
  });

  it("builds tag index", () => {
    const customerNotes = graph.getNotesByTag("customer");
    expect(customerNotes.length).toBe(2);
    expect(customerNotes.map((n) => n.title).sort()).toEqual(["Contoso", "Fabrikam"]);
  });

  it("resolves title to path", () => {
    expect(graph.resolveTitle("Contoso")).toBe("Customers/Contoso.md");
    expect(graph.resolveTitle("Alice Smith")).toBe("People/Alice Smith.md");
  });
});

describe("GraphIndex — queries", () => {
  let graph: GraphIndex;

  beforeAll(async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
  });

  it("getBacklinks returns notes linking TO a note", () => {
    const backlinks = graph.getBacklinks("Customers/Contoso.md");
    const paths = backlinks.map((n) => n.path);
    expect(paths).toContain("Customers/Fabrikam.md");
    expect(paths).toContain("People/Alice Smith.md");
    expect(paths).toContain("Meetings/2026-03-01 - Contoso Sync.md");
  });

  it("getForwardLinks returns notes linked FROM a note", () => {
    const forward = graph.getForwardLinks("Customers/Contoso.md");
    const paths = forward.map((n) => n.path);
    expect(paths).toContain("People/Alice Smith.md");
    expect(paths).toContain("People/Bob Jones.md");
  });

  it("getNotesByFolder returns notes with path prefix", () => {
    const customers = graph.getNotesByFolder("Customers/");
    expect(customers.length).toBe(2);
  });

  it("getNotesByFolder with empty string returns all", () => {
    const all = graph.getNotesByFolder("");
    expect(all.length).toBe(5);
  });

  it("getRelatedNotes returns N-hop neighbours", () => {
    const related = graph.getRelatedNotes("Meetings/2026-03-01 - Contoso Sync.md", 1);
    const paths = related.map((n) => n.path);
    // Direct links: Contoso, Alice Smith
    expect(paths).toContain("Customers/Contoso.md");
    expect(paths).toContain("People/Alice Smith.md");
  });

  it("getRelatedNotes with 2 hops reaches further", () => {
    const related = graph.getRelatedNotes("Meetings/2026-03-01 - Contoso Sync.md", 2);
    const paths = related.map((n) => n.path);
    // 2 hops: also Bob Jones (via Contoso) and Fabrikam (via Contoso)
    expect(paths).toContain("People/Bob Jones.md");
    expect(paths).toContain("Customers/Fabrikam.md");
  });

  it("getRelatedNotes applies tag filter", () => {
    const related = graph.getRelatedNotes("Meetings/2026-03-01 - Contoso Sync.md", 2, {
      tags: ["customer"],
    });
    const paths = related.map((n) => n.path);
    expect(paths).toContain("Customers/Contoso.md");
    expect(paths).toContain("Customers/Fabrikam.md");
    // People should be excluded
    expect(paths.every((p) => !p.startsWith("People/"))).toBe(true);
  });

  it("getRelatedNotes applies folder filter", () => {
    const related = graph.getRelatedNotes("Customers/Contoso.md", 2, {
      folder: "People/",
    });
    const paths = related.map((n) => n.path);
    expect(paths.every((p) => p.startsWith("People/"))).toBe(true);
  });

  it("getStats returns correct counts", () => {
    const stats = graph.getStats();
    expect(stats.noteCount).toBe(5);
    expect(stats.linkCount).toBeGreaterThan(0);
    expect(stats.tagCount).toBeGreaterThan(0);
    expect(stats.topTags.length).toBeGreaterThan(0);
    expect(stats.mostLinkedNotes.length).toBeGreaterThan(0);
  });

  it("getMostLinkedNotes ranks Contoso highest", () => {
    const stats = graph.getStats();
    // Contoso is linked from Fabrikam, Alice, Bob, and the meeting
    expect(stats.mostLinkedNotes[0].title).toBe("Contoso");
  });
});

describe("GraphIndex — incremental update", () => {
  let graph: GraphIndex;

  beforeEach(async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
  });

  it("updateNote re-indexes a changed note", async () => {
    // Add a new wikilink to Fabrikam
    const fabPath = join(vaultRoot, "Customers/Fabrikam.md");
    const original = await readFile(fabPath, "utf-8");
    await writeFile(
      fabPath,
      original + "\nAlso see [[Bob Jones]].\n",
      "utf-8",
    );

    await graph.updateNote("Customers/Fabrikam.md");

    const fabNode = graph.getNode("Customers/Fabrikam.md");
    expect(fabNode!.outLinks.has("People/Bob Jones.md")).toBe(true);

    // Also check backlink was added
    const bob = graph.getNode("People/Bob Jones.md");
    expect(bob!.inLinks.has("Customers/Fabrikam.md")).toBe(true);

    // Restore original
    await writeFile(fabPath, original, "utf-8");
  });

  it("removeNote removes from all indices", () => {
    graph.removeNote("People/Bob Jones.md");
    expect(graph.getNode("People/Bob Jones.md")).toBeUndefined();
    expect(graph.nodeCount).toBe(4);

    // Backlinks from Bob should be cleaned
    const contoso = graph.getNode("Customers/Contoso.md");
    expect(contoso!.outLinks.has("People/Bob Jones.md")).toBe(false);
  });
});

describe("GraphIndex — persistence", () => {
  it("saves and loads from disk", async () => {
    const graph1 = new GraphIndex(vaultRoot);
    await graph1.build();

    await graph1.saveToDisk("_oil-graph.json");

    const graph2 = new GraphIndex(vaultRoot);
    const loaded = await graph2.loadFromDisk("_oil-graph.json");
    expect(loaded).toBe(true);
    expect(graph2.nodeCount).toBe(graph1.nodeCount);

    // Verify backlinks are recomputed after load
    const contoso = graph2.getNode("Customers/Contoso.md");
    expect(contoso!.inLinks.size).toBeGreaterThan(0);

    // Clean up
    await unlink(join(vaultRoot, "_oil-graph.json"));
  });

  it("returns false for missing graph file", async () => {
    const graph = new GraphIndex(vaultRoot);
    const loaded = await graph.loadFromDisk("_nonexistent.json");
    expect(loaded).toBe(false);
  });
});
