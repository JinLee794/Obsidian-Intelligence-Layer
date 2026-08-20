/**
 * Incremental link resolution.
 *
 * Re-indexing a changed note used to clear and rebuild every backlink in the
 * vault, which is correct but costs O(vault) per edit. The cheap path leaves
 * other notes' links standing and only revisits the edited note — safe exactly
 * while the set of names a wikilink can resolve through is unchanged.
 *
 * That "exactly while" is the whole risk, and it fails silently: a lost backlink
 * looks like a note that simply is not referenced. So every case here compares
 * the incrementally maintained graph against a build from scratch over the same
 * final vault, rather than against hand-written expectations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";

let tempDir: string;
let vault: string;
let graph: GraphIndex;

const NOTES = ["Hub.md", "A.md", "B.md", "C.md", "Orphan.md"];

async function writeNote(rel: string, body: string): Promise<void> {
  await writeFile(join(vault, rel), body, "utf-8");
}

/** Every note's links and backlinks, as a comparable shape. */
function linkShape(g: GraphIndex): Record<string, { out: string[]; in: string[] }> {
  const shape: Record<string, { out: string[]; in: string[] }> = {};
  for (const path of g.getNotesByFolder("").map((r) => r.path)) {
    shape[path] = {
      out: g.getForwardLinks(path).map((r) => r.path).sort(),
      in: g.getBacklinks(path).map((r) => r.path).sort(),
    };
  }
  return shape;
}

/**
 * Assert the incrementally maintained `graph` has exactly the link structure a
 * fresh build produces. This is the assertion that matters — the fast path is
 * only worth having if it is indistinguishable from the slow one.
 */
async function expectLinksMatchFullRebuild(): Promise<void> {
  const fresh = new GraphIndex(vault);
  await fresh.build();
  expect(linkShape(graph)).toEqual(linkShape(fresh));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-links-"));
  vault = join(tempDir, "vault");
  await mkdir(vault, { recursive: true });

  await writeNote("Hub.md", `# Hub\n\nSee [[A]], [[B]] and [[C]].\n`);
  await writeNote("A.md", `# A\n\nLinks to [[B]].\n`);
  await writeNote("B.md", `# B\n\nLinks back to [[Hub]].\n`);
  await writeNote("C.md", `# C\n\nLinks to [[A]] and [[Hub]].\n`);
  await writeNote("Orphan.md", `# Orphan\n\nNo links here.\n`);

  graph = new GraphIndex(vault);
  await graph.build();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("incremental link resolution — the cheap path", () => {
  it("keeps other notes' links to the edited note", async () => {
    // Hub, C -> B is the structure at risk: re-indexing B must not drop the
    // links pointing *at* it.
    expect(graph.getBacklinks("B.md").map((r) => r.path).sort()).toEqual([
      "A.md",
      "Hub.md",
    ]);

    await writeNote("B.md", `# B\n\nStill links back to [[Hub]]. Extra prose.\n`);
    await graph.updateNote("B.md");

    expect(graph.getBacklinks("B.md").map((r) => r.path).sort()).toEqual([
      "A.md",
      "Hub.md",
    ]);
    await expectLinksMatchFullRebuild();
  });

  it("drops a link the edited note no longer makes", async () => {
    await writeNote("A.md", `# A\n\nNo longer links anywhere.\n`);
    await graph.updateNote("A.md");

    expect(graph.getForwardLinks("A.md")).toEqual([]);
    expect(graph.getBacklinks("B.md").map((r) => r.path)).toEqual(["Hub.md"]);
    await expectLinksMatchFullRebuild();
  });

  it("adds a link the edited note has started making", async () => {
    await writeNote("Orphan.md", `# Orphan\n\nNow links to [[Hub]].\n`);
    await graph.updateNote("Orphan.md");

    expect(graph.getBacklinks("Hub.md").map((r) => r.path).sort()).toEqual([
      "B.md",
      "C.md",
      "Orphan.md",
    ]);
    await expectLinksMatchFullRebuild();
  });

  it("refreshes tags without stranding the old ones", async () => {
    await writeNote("A.md", `---\ntags: [alpha]\n---\n# A\n\nLinks to [[B]].\n`);
    await graph.updateNote("A.md");
    expect(graph.getNotesByTag("alpha").map((r) => r.path)).toEqual(["A.md"]);

    await writeNote("A.md", `---\ntags: [beta]\n---\n# A\n\nLinks to [[B]].\n`);
    await graph.updateNote("A.md");

    expect(graph.getNotesByTag("alpha")).toEqual([]);
    expect(graph.getNotesByTag("beta").map((r) => r.path)).toEqual(["A.md"]);
  });

  it("survives the same note being re-indexed repeatedly", async () => {
    // Backlinks are sets, so a duplicated entry cannot show up as a count — it
    // shows up as a link that never goes away. Repeat enough to catch drift.
    for (let i = 0; i < 25; i++) {
      await graph.updateNote("A.md");
      await graph.updateNote("Hub.md");
    }
    await expectLinksMatchFullRebuild();
  });
});

describe("incremental link resolution — when the cheap path is unsafe", () => {
  it("re-resolves other notes' links when a title changes", async () => {
    // C links [[A]]. Renaming A's title to something else must make that link
    // resolve by filename only — a whole-vault concern, not a local one.
    await writeNote("A.md", `# Alpha Renamed\n\nLinks to [[B]].\n`);
    await graph.updateNote("A.md");

    await expectLinksMatchFullRebuild();
  });

  it("resolves a dangling link once its target appears", async () => {
    await writeNote("Hub.md", `# Hub\n\nSee [[A]], [[B]], [[C]] and [[Later]].\n`);
    await graph.updateNote("Hub.md");
    expect(graph.getForwardLinks("Hub.md").map((r) => r.path)).not.toContain(
      "Later.md",
    );

    await writeNote("Later.md", `# Later\n\nArrived.\n`);
    await graph.updateNote("Later.md");

    expect(graph.getBacklinks("Later.md").map((r) => r.path)).toEqual(["Hub.md"]);
    await expectLinksMatchFullRebuild();
  });

  it("makes a link dangle again once its target is deleted", async () => {
    await unlink(join(vault, "B.md"));
    graph.removeNote("B.md");

    expect(graph.getForwardLinks("Hub.md").map((r) => r.path).sort()).toEqual([
      "A.md",
      "C.md",
    ]);
    expect(graph.getForwardLinks("A.md")).toEqual([]);
    await expectLinksMatchFullRebuild();
  });

  it("treats an unreadable note as a removal", async () => {
    await unlink(join(vault, "B.md"));
    await graph.updateNote("B.md");

    expect(graph.getNode("B.md")).toBeUndefined();
    await expectLinksMatchFullRebuild();
  });

  it("picks up a title change that makes a previously dangling link resolve", async () => {
    await writeNote("Hub.md", `# Hub\n\nSee [[A]], [[B]], [[C]] and [[Renamed]].\n`);
    await graph.updateNote("Hub.md");
    expect(graph.getForwardLinks("Hub.md").map((r) => r.path)).not.toContain(
      "Orphan.md",
    );

    await writeNote("Orphan.md", `# Renamed\n\nNow answers to a new name.\n`);
    await graph.updateNote("Orphan.md");

    expect(graph.getBacklinks("Orphan.md").map((r) => r.path)).toEqual(["Hub.md"]);
    await expectLinksMatchFullRebuild();
  });
});

describe("batched updates", () => {
  it("matches a full rebuild after a burst of unrelated edits", async () => {
    await writeNote("A.md", `# A\n\nNow links to [[C]].\n`);
    await writeNote("B.md", `# B\n\nNow links to [[C]] as well.\n`);
    await writeNote("C.md", `# C\n\nLinks nowhere now.\n`);

    await graph.updateNotes(["A.md", "B.md", "C.md"]);

    expect(graph.getBacklinks("C.md").map((r) => r.path).sort()).toEqual([
      "A.md",
      "B.md",
      "Hub.md",
    ]);
    await expectLinksMatchFullRebuild();
  });

  it("matches a full rebuild when a burst renames and relinks at once", async () => {
    await writeNote("A.md", `# Alpha\n\nLinks to [[B]].\n`);
    await writeNote("Hub.md", `# Hub\n\nSee [[Alpha]] and [[C]].\n`);

    await graph.updateNotes(["A.md", "Hub.md"]);

    expect(graph.getBacklinks("A.md").map((r) => r.path).sort()).toEqual([
      "C.md",
      "Hub.md",
    ]);
    await expectLinksMatchFullRebuild();
  });

  it("applies a burst of adds and deletes together", async () => {
    await writeNote("New.md", `# New\n\nLinks to [[Hub]].\n`);
    await unlink(join(vault, "Orphan.md"));

    await graph.updateNotes(["New.md", "Orphan.md"]);

    expect(graph.getNode("Orphan.md")).toBeUndefined();
    expect(graph.getBacklinks("Hub.md").map((r) => r.path)).toContain("New.md");
    await expectLinksMatchFullRebuild();
  });

  it("collapses a path repeated within one batch", async () => {
    await writeNote("A.md", `# A\n\nLinks to [[C]].\n`);
    await graph.updateNotes(["A.md", "A.md", "A.md"]);

    expect(graph.getForwardLinks("A.md").map((r) => r.path)).toEqual(["C.md"]);
    await expectLinksMatchFullRebuild();
  });

  it("does nothing for an empty batch", async () => {
    const before = graph.version;
    await graph.updateNotes([]);
    expect(graph.version).toBe(before);
  });

  it("logs one mutation per note rather than a remove and a re-add", async () => {
    // The halved churn is the point: it is what stops a burst from evicting the
    // delta log and forcing every caller into a full rebuild.
    const before = graph.version;
    await graph.updateNotes(["A.md", "B.md"]);

    expect(graph.changesSince(before)?.sort()).toEqual(["A.md", "B.md"]);
  });
});

describe("realistic sequences", () => {
  it("matches a full rebuild after interleaved edits, adds and deletes", async () => {
    await writeNote("A.md", `# A\n\nLinks to [[Hub]] and [[C]].\n`);
    await graph.updateNote("A.md");

    await writeNote("D.md", `# D\n\nLinks to [[A]].\n`);
    await graph.updateNote("D.md");

    await unlink(join(vault, "C.md"));
    graph.removeNote("C.md");

    await writeNote("Hub.md", `# Hub\n\nSee [[A]], [[B]] and [[D]].\n`);
    await graph.updateNote("Hub.md");

    await writeNote("B.md", `# B Renamed\n\nLinks to [[D]].\n`);
    await graph.updateNote("B.md");

    await expectLinksMatchFullRebuild();
  });

  it("leaves no note referenced by a link it does not have", async () => {
    for (const note of NOTES) {
      await writeNote(note, `# ${note.replace(".md", "")}\n\nLinks to [[Hub]].\n`);
      await graph.updateNote(note);
    }

    // Every backlink must be matched by a forward link on the other side.
    for (const path of graph.getNotesByFolder("").map((r) => r.path)) {
      for (const source of graph.getBacklinks(path)) {
        expect(
          graph.getForwardLinks(source.path).map((r) => r.path),
          `${source.path} should link to ${path}`,
        ).toContain(path);
      }
    }
    await expectLinksMatchFullRebuild();
  });
});
