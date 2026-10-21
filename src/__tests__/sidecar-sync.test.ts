import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findConflictCopies, sameMtime } from "../sidecar-sync.js";

describe("findConflictCopies", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oil-sidecar-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("recognises how each sync client names a forked file, and nothing else", async () => {
    const copies = [
      "_oil-graph-DESKTOP-6RN95DV.json",
      "_oil-graph-DESKTOP-6RN95DV-2.json",
      "_oil-graph-Jin’s MacBook Pro (2).json",
      "_oil-graph (Jin's conflicted copy 2026-10-19).json",
      "_oil-graph (1).json",
      "_oil-graph.sync-conflict-20261019-084440-ABCDEFG.json",
    ];
    const unrelated = [
      "_oil-graph.json",
      "_oil-graph.json.93214aa800ad.tmp",
      "_oil-vectors.json",
      "_oil-vectors-DESKTOP-6RN95DV.json",
      "_oil-graphite.json",
      "_oil-graph-notes.md",
    ];
    await Promise.all([...copies, ...unrelated].map((name) => writeFile(join(dir, name), "{}")));

    const found = (await findConflictCopies(join(dir, "_oil-graph.json"))).map((p) => basename(p));
    expect(found.sort()).toEqual([...copies].sort());
  });

  it("returns nothing when the directory is missing", async () => {
    expect(await findConflictCopies(join(dir, "nope", "_oil-graph.json"))).toEqual([]);
  });
});

describe("sameMtime", () => {
  it("treats a whole-second mtime as equal to a finer one that truncates to it", () => {
    // Observed: Windows reports …380599.3184, OneDrive on macOS reports …380000.
    expect(sameMtime(1790950380599.3184, 1790950380000)).toBe(true);
    expect(sameMtime(1790950380000, 1790950380999.9)).toBe(true);
  });

  it("still sees real changes", () => {
    expect(sameMtime(1790950381000, 1790950380599)).toBe(false);
    expect(sameMtime(1790950380599.3, 1790950380123.1)).toBe(false);
    expect(sameMtime(1790950380000, 1790950379000)).toBe(false);
  });

  it("tolerates sub-millisecond jitter", () => {
    expect(sameMtime(1790950380599.3, 1790950380599.9)).toBe(true);
  });
});
