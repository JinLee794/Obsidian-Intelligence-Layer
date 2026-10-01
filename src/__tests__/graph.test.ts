/**
 * Tests for graph.ts — GraphIndex: build, queries, incremental updates, persistence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { GraphIndex } from "../graph.js";
import { mkdtemp, rm, mkdir, writeFile, readFile, unlink, stat, utimes } from "node:fs/promises";
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

  it("NoteRef results carry path as the reference, without duplicating it as ref", () => {
    const sources = [
      graph.getBacklinks("Customers/Contoso.md"),
      graph.getForwardLinks("Customers/Contoso.md"),
      graph.getNotesByFolder("Customers/"),
      graph.getRelatedNotes("Customers/Contoso.md", 1),
      graph.getStats().mostLinkedNotes,
    ];

    for (const refs of sources) {
      expect(refs.length).toBeGreaterThan(0);
      for (const note of refs) {
        expect(typeof note.path).toBe("string");
        expect(note.ref).toBeUndefined();
      }
    }
  });

  it("getRelatedNotes reports hop distance and link direction", () => {
    const related = graph.getRelatedNotes("Customers/Contoso.md", 2);
    expect(related.length).toBeGreaterThan(0);

    for (const note of related) {
      expect(note.hops).toBeGreaterThanOrEqual(1);
      expect(note.hops).toBeLessThanOrEqual(2);
      expect(["out", "in", "both"]).toContain(note.via);
    }

    // Nearest first, so a caller can truncate without losing the closest notes.
    const hops = related.map((n) => n.hops);
    expect([...hops].sort((a, b) => a - b)).toEqual(hops);
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

describe("GraphIndex — incremental startup", () => {
  let dir: string;
  let vault: string;
  const INDEX = "_oil-graph.json";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oil-incr-"));
    vault = join(dir, "vault");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "A.md"), "# A\n\n[[B]]\n", "utf-8");
    await writeFile(join(vault, "B.md"), "# B\n", "utf-8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves in-memory updates instead of reloading a stale index", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX);

    // Edit B on disk but restore its mtime, so only the live update knows.
    const bPath = join(vault, "B.md");
    const before = await stat(bPath);
    await writeFile(bPath, "# B Renamed\n", "utf-8");
    await utimes(bPath, before.atime, before.mtime);

    await graph.updateNote("B.md");
    expect(graph.getNode("B.md")!.title).toBe("B Renamed");

    await graph.buildIncremental(INDEX);

    // A reload from disk would resurrect the stale "B" title.
    expect(graph.getNode("B.md")!.title).toBe("B Renamed");
  });

  it("indexes notes inserted while the index is already loaded", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX);

    await writeFile(join(vault, "C.md"), "# C\n\n[[A]]\n", "utf-8");
    const reindexed = await graph.buildIncremental(INDEX);

    expect(reindexed).toBe(1);
    expect(graph.getNode("C.md")).toBeDefined();
    expect(graph.getNode("A.md")!.inLinks.has("C.md")).toBe(true);
  });

  it("drops notes deleted while the index is already loaded", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX);

    await unlink(join(vault, "B.md"));
    await graph.buildIncremental(INDEX);

    expect(graph.getNode("B.md")).toBeUndefined();
    expect(graph.nodeCount).toBe(1);
  });

  it("persists inserts so a later load sees them", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX);

    await writeFile(join(vault, "C.md"), "# C\n", "utf-8");
    await graph.buildIncremental(INDEX);

    const reloaded = new GraphIndex(vault);
    expect(await reloaded.loadFromDisk(INDEX)).toBe(true);
    expect(reloaded.getNode("C.md")).toBeDefined();
  });

  it("builds from disk when nothing is in memory yet", async () => {
    const seed = new GraphIndex(vault);
    await seed.build();
    await seed.saveToDisk(INDEX);

    const graph = new GraphIndex(vault);
    await graph.buildIncremental(INDEX);

    expect(graph.nodeCount).toBe(2);
  });

  it("removes temp files orphaned by an interrupted save", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();

    const orphan = join(vault, `${INDEX}.11111111-2222-3333-4444-555555555555.tmp`);
    await writeFile(orphan, "partial", "utf-8");
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(orphan, stale, stale);

    await graph.saveToDisk(INDEX);

    await expect(stat(orphan)).rejects.toThrow();
  });

  it("clears the building flag when persistence fails", async () => {    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX);

    await writeFile(join(vault, "C.md"), "# C\n", "utf-8");
    await expect(
      graph.buildIncremental(join("no-such-dir", "graph.json")),
    ).rejects.toThrow();
    expect(graph.building).toBe(false);
  });
});

describe("GraphIndex — discarding a persisted index says so", () => {
  let dir: string;
  let vault: string;
  const INDEX = "_oil-graph.json";
  let errors: string[];
  let restore: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oil-corrupt-"));
    vault = join(dir, "vault");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "A.md"), "# A\n", "utf-8");

    errors = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    restore = () => void (console.error = original);
  });

  afterEach(async () => {
    restore();
    await rm(dir, { recursive: true, force: true });
  });

  const said = () => errors.join("\n");

  /**
   * A persisted index can be rejected four ways, and an operator scanning
   * startup logs has no reason to know which one they hit. So they are asserted
   * together against one pattern: whatever went wrong, the line has to be
   * findable by looking for a discarded index.
   *
   * The truncated case is the reason this exists. It was reported as logging
   * nothing at all, because it took the catch-all path and the wording there
   * shared no words with its three siblings — the line was on stderr the whole
   * time and a search for it came back empty.
   */
  const DISCARDED = /\[OIL\] Graph index.*(corrupt|mismatch).*rebuild/i;

  it("names a truncated file", async () => {
    await writeFile(join(vault, INDEX), '{"version":2,"nodes":[{"pa', "utf-8");
    expect(await new GraphIndex(vault).loadFromDisk(INDEX)).toBe(false);
    expect(said()).toMatch(DISCARDED);
  });

  it("names a version it cannot read", async () => {
    await writeFile(join(vault, INDEX), '{"version":99,"nodes":[]}', "utf-8");
    expect(await new GraphIndex(vault).loadFromDisk(INDEX)).toBe(false);
    expect(said()).toMatch(DISCARDED);
  });

  it("names nodes that are not a list", async () => {
    await writeFile(join(vault, INDEX), '{"version":2,"nodes":{}}', "utf-8");
    expect(await new GraphIndex(vault).loadFromDisk(INDEX)).toBe(false);
    expect(said()).toMatch(DISCARDED);
  });

  it("names a node it cannot make sense of", async () => {
    await writeFile(
      join(vault, INDEX),
      '{"version":2,"nodes":[{"path":"A.md","title":7,"tags":[]}]}',
      "utf-8",
    );
    expect(await new GraphIndex(vault).loadFromDisk(INDEX)).toBe(false);
    expect(said()).toMatch(DISCARDED);
  });

  it("stays quiet when there is simply no index yet", async () => {
    // First run is not a fault, and startup should not imply otherwise.
    expect(await new GraphIndex(vault).loadFromDisk(INDEX)).toBe(false);
    expect(said()).toBe("");
  });
});
