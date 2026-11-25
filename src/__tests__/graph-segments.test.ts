/**
 * Segmented graph layout — the skeleton plus per-segment files that replace the
 * single `_oil-graph.json` once a vault is migrated.
 *
 * Two promises are checked here. A vault nobody migrated keeps the single file
 * exactly as before; and a migrated vault reloads to the same graph, links and
 * backlinks included, while a one-note edit rewrites one segment rather than
 * the whole index.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphIndex } from "../graph.js";
import { compareGraphs } from "../graph-migrate.js";
import {
  DEFAULT_SEGMENT_POLICY,
  ROOT_SEGMENT,
  normalizeSegmentPolicy,
  segmentDirFor,
  segmentKeyFor,
} from "../graph-segments.js";
import type { PersistedSkeleton } from "../graph-segments.js";
import { INDEX_FILE, PERSON_NOTE, SEGMENT_DIR, SKELETON, exists, seedVault } from "./segmented-vault.js";

describe("segmentKeyFor", () => {
  const policy = DEFAULT_SEGMENT_POLICY;

  it("splits meetings by the year of their date field, parsed or not", () => {
    expect(segmentKeyFor("Meetings/Contoso sync.md", { date: "2024-03-05" }, policy)).toBe("Meetings/2024");
    expect(segmentKeyFor("Meetings/Contoso sync.md", { date: new Date("2023-11-30T00:00:00Z") }, policy)).toBe(
      "Meetings/2023",
    );
    expect(segmentKeyFor("Meetings/Contoso sync.md", { Date: "2021-01-02" }, policy)).toBe("Meetings/2021");
  });

  it("falls back to a year in the path, then to 'undated'", () => {
    expect(segmentKeyFor("Meetings/2021/Kickoff.md", {}, policy)).toBe("Meetings/2021");
    expect(segmentKeyFor("Daily/2024-05-01.md", undefined, policy)).toBe("Daily/2024");
    expect(segmentKeyFor("Meetings/Kickoff.md", {}, policy)).toBe("Meetings/undated");
  });

  it("splits people by initial, customers by hub, and the rest by top-level folder", () => {
    expect(segmentKeyFor("People/alice adams.md", {}, policy)).toBe("People/A");
    expect(segmentKeyFor("People/2nd Line Support.md", {}, policy)).toBe("People/_");
    expect(segmentKeyFor("Customers/Contoso/Notes/Call.md", {}, policy)).toBe("Customers/Contoso");
    expect(segmentKeyFor("Customers/Overview.md", {}, policy)).toBe("Customers/_");
    expect(segmentKeyFor("Projects/Q3/Plan.md", {}, policy)).toBe("Projects");
    expect(segmentKeyFor("Index.md", {}, policy)).toBe(ROOT_SEGMENT);
  });

  it("normalizes configured roots, and an empty root turns its rule off", () => {
    const custom = normalizeSegmentPolicy({ meetingsRoot: "", peopleRoot: "./Contacts\\Team", datedFolders: ["Journal"] });
    expect(custom.peopleRoot).toBe("Contacts/Team/");
    expect(custom.datedFolders).toEqual(["Journal/"]);
    expect(custom.customersRoot).toBe(DEFAULT_SEGMENT_POLICY.customersRoot);
    expect(segmentKeyFor("Meetings/Contoso sync.md", { date: "2024-03-05" }, custom)).toBe("Meetings");
    expect(segmentKeyFor("Contacts/Team/bob.md", {}, custom)).toBe("Contacts/Team/B");
    expect(segmentKeyFor("Journal/2020-01-01.md", {}, custom)).toBe("Journal/2020");
  });

  it("puts the segment directory beside the configured index file", () => {
    expect(segmentDirFor("_oil-graph.json")).toBe(".oil-graph");
    expect(segmentDirFor(join("indexes", "_custom.json"))).toBe(join("indexes", ".custom"));
  });
});

describe("segmented layout — persistence", () => {
  let tempDir: string;
  let vault: string;
  let notes: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oil-segments-"));
    vault = join(tempDir, "vault");
    notes = await seedVault(vault);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function savedSegmented(): Promise<GraphIndex> {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX_FILE, { layout: "segmented" });
    return graph;
  }

  async function readSkeletonFile(): Promise<PersistedSkeleton> {
    return JSON.parse(await readFile(join(vault, SKELETON), "utf-8")) as PersistedSkeleton;
  }

  it("keeps an unmigrated vault on the single v2 file", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX_FILE);

    expect(graph.lastSave?.layout).toBe("single");
    const persisted = JSON.parse(await readFile(join(vault, INDEX_FILE), "utf-8"));
    expect(persisted.version).toBe(2);
    expect(persisted.nodes).toHaveLength(notes.length);

    const reopened = new GraphIndex(vault);
    expect(await reopened.loadFromDisk(INDEX_FILE)).toBe(true);
    expect(reopened.loadedLayout).toBe("single");
    await reopened.updateNotes([PERSON_NOTE]);
    await reopened.saveToDisk(INDEX_FILE);
    expect(await exists(join(vault, SEGMENT_DIR))).toBe(false);
  });

  it("reloads to the same graph, links and backlinks included", async () => {
    const original = await savedSegmented();
    expect(await exists(join(vault, INDEX_FILE))).toBe(false);

    const reopened = new GraphIndex(vault);
    expect(await reopened.loadFromDisk(INDEX_FILE)).toBe(true);
    expect(reopened.loadedLayout).toBe("segmented");
    const parity = compareGraphs(original, reopened, "exact");
    expect(parity.ok, JSON.stringify(parity)).toBe(true);
    expect(parity.nodes).toBe(notes.length);

    const files = (await readdir(join(vault, SEGMENT_DIR))).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength((original.lastSave?.segmentsTotal ?? 0) + 1);
  });

  it("rewrites only the edited note's segment and the skeleton", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX_FILE);
    const singleBytes = (await stat(join(vault, INDEX_FILE))).size;
    await graph.saveToDisk(INDEX_FILE, { layout: "segmented" });

    const reopened = new GraphIndex(vault);
    await reopened.loadFromDisk(INDEX_FILE);
    expect(reopened.loadedLayout).toBe("segmented");
    const full = join(vault, PERSON_NOTE);
    await writeFile(full, `${await readFile(full, "utf-8")}\nEdited.\n`, "utf-8");
    await reopened.updateNotes([PERSON_NOTE]);
    await reopened.saveToDisk(INDEX_FILE);

    const saved = reopened.lastSave;
    expect(saved?.layout).toBe("segmented");
    expect(saved?.segmentsWritten).toBe(1);
    expect(saved?.filesWritten).toBe(2);
    expect(saved?.bytesWritten ?? Infinity).toBeLessThan(singleBytes / 2);

    // The previous generation of the rewritten segment is cleaned up.
    const files = (await readdir(join(vault, SEGMENT_DIR))).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength((saved?.segmentsTotal ?? 0) + 1);
  });

  it("warm-starts with no rework, re-reads only what changed, and stays segmented", async () => {
    await savedSegmented();
    expect(await new GraphIndex(vault).buildIncremental(INDEX_FILE)).toBe(0);

    const later = new Date(Date.now() + 5_000);
    await utimes(join(vault, "Meetings", "2023-02-15 Fabrikam sync.md"), later, later);
    const graph = new GraphIndex(vault);
    expect(await graph.buildIncremental(INDEX_FILE)).toBe(1);
    expect(graph.loadedLayout).toBe("segmented");
    expect(graph.lastSave?.layout).toBe("segmented");

    expect(await new GraphIndex(vault).buildIncremental(INDEX_FILE)).toBe(0);
    expect(await exists(join(vault, INDEX_FILE))).toBe(false);
  });

  it("keeps a damaged segment's notes through the skeleton and heals on the next start", async () => {
    await savedSegmented();
    const skeleton = await readSkeletonFile();
    const damaged = Object.entries(skeleton.segments).find(([, meta]) => meta.notes > 1);
    if (!damaged) throw new Error("fixture has no multi-note segment");
    const [key, meta] = damaged;
    await writeFile(join(vault, SEGMENT_DIR, meta.file), "{ not json", "utf-8");

    const graph = new GraphIndex(vault);
    expect(await graph.loadFromDisk(INDEX_FILE)).toBe(true);
    expect(graph.segmentHealth?.damagedSegments).toEqual([key]);
    expect(graph.segmentHealth?.recoveredNotes).toBe(meta.notes);
    expect(graph.nodeCount).toBe(skeleton.nodes.length);

    expect(await new GraphIndex(vault).buildIncremental(INDEX_FILE)).toBe(meta.notes);
    const healed = new GraphIndex(vault);
    await healed.loadFromDisk(INDEX_FILE);
    expect(healed.segmentHealth?.damagedSegments).toEqual([]);
  });

  it("rebuilds from a corrupt skeleton and keeps the segmented layout", async () => {
    await savedSegmented();
    await writeFile(join(vault, SKELETON), "{ truncated", "utf-8");

    expect(await new GraphIndex(vault).loadFromDisk(INDEX_FILE)).toBe(false);
    const graph = new GraphIndex(vault);
    expect(await graph.buildIncremental(INDEX_FILE)).toBe(notes.length);
    expect(graph.lastSave?.layout).toBe("segmented");
    expect(await new GraphIndex(vault).buildIncremental(INDEX_FILE)).toBe(0);
  });

  it("converts on the next save when the layout is set explicitly", async () => {
    const unmigrated = new GraphIndex(vault);
    await unmigrated.build();
    await unmigrated.saveToDisk(INDEX_FILE);

    const toSegmented = new GraphIndex(vault, { layout: "segmented" });
    expect(await toSegmented.loadFromDisk(INDEX_FILE)).toBe(true);
    expect(toSegmented.loadedLayout).toBe("single");
    await toSegmented.saveToDisk(INDEX_FILE);
    expect(toSegmented.lastSave?.layout).toBe("segmented");
    // Runtime saves never delete the single file; only migrate-graph retires it.
    expect(await exists(join(vault, INDEX_FILE))).toBe(true);
    const auto = new GraphIndex(vault);
    await auto.loadFromDisk(INDEX_FILE);
    expect(auto.loadedLayout).toBe("segmented");

    await rm(join(vault, INDEX_FILE));
    const toSingle = new GraphIndex(vault, { layout: "single" });
    expect(await toSingle.loadFromDisk(INDEX_FILE)).toBe(true);
    await toSingle.updateNotes([PERSON_NOTE]);
    await toSingle.saveToDisk(INDEX_FILE);
    expect(await exists(join(vault, INDEX_FILE))).toBe(true);
    expect(await exists(join(vault, SEGMENT_DIR))).toBe(false);
  });
});
