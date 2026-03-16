/**
 * Tests for SessionCache — LRU note cache, traversal cache, pending writes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionCache } from "../cache.js";
import type { ParsedNote } from "../vault.js";
import type { PendingWrite } from "../types.js";

function makeParsedNote(path: string): ParsedNote {
  return {
    path,
    frontmatter: { tags: ["test"] },
    content: `# ${path}\nSome content`,
    sections: new Map([["Test", "section body"]]),
    rawContent: `---\ntags: [test]\n---\n# ${path}\nSome content`,
  };
}

describe("SessionCache — note cache", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it("returns undefined for uncached note", () => {
    expect(cache.getNote("missing.md")).toBeUndefined();
  });

  it("stores and retrieves a cached note", () => {
    const note = makeParsedNote("notes/test.md");
    cache.putNote("notes/test.md", note);
    expect(cache.getNote("notes/test.md")).toEqual(note);
  });

  it("invalidates a cached note", () => {
    const note = makeParsedNote("notes/test.md");
    cache.putNote("notes/test.md", note);
    cache.invalidateNote("notes/test.md");
    expect(cache.getNote("notes/test.md")).toBeUndefined();
  });

  it("expires stale entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const note = makeParsedNote("notes/test.md");
      cache.putNote("notes/test.md", note);
      expect(cache.getNote("notes/test.md")).toEqual(note);

      // Advance past TTL (5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(cache.getNote("notes/test.md")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks recently accessed paths", () => {
    cache.putNote("a.md", makeParsedNote("a.md"));
    cache.putNote("b.md", makeParsedNote("b.md"));
    cache.putNote("c.md", makeParsedNote("c.md"));

    const recent = cache.getRecentlyAccessed();
    expect(recent).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("moves re-accessed path to end of recent list", () => {
    cache.putNote("a.md", makeParsedNote("a.md"));
    cache.putNote("b.md", makeParsedNote("b.md"));
    cache.putNote("a.md", makeParsedNote("a.md")); // re-access

    const recent = cache.getRecentlyAccessed();
    expect(recent).toEqual(["b.md", "a.md"]);
  });

  it("evicts oldest entries when exceeding max cache size", () => {
    // Max cache is 200 notes; fill to 201
    for (let i = 0; i < 201; i++) {
      cache.putNote(`note-${i}.md`, makeParsedNote(`note-${i}.md`));
    }
    // note-0 should have been evicted (oldest)
    expect(cache.getNote("note-0.md")).toBeUndefined();
    // note-200 should still be cached
    expect(cache.getNote("note-200.md")).toBeDefined();
  });
});

describe("SessionCache — traversal cache", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it("returns undefined for uncached traversal", () => {
    expect(cache.getTraversal("key1")).toBeUndefined();
  });

  it("stores and retrieves traversal results", () => {
    const refs = [{ path: "a.md", title: "A", tags: [] }];
    cache.putTraversal("related:a.md:2", refs);
    expect(cache.getTraversal("related:a.md:2")).toEqual(refs);
  });

  it("expires stale traversal entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const refs = [{ path: "a.md", title: "A", tags: [] }];
      cache.putTraversal("key1", refs);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(cache.getTraversal("key1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates traversal entries that reference an invalidated note", () => {
    const refs = [{ path: "notes/test.md", title: "Test", tags: [] }];
    cache.putNote("notes/test.md", makeParsedNote("notes/test.md"));
    cache.putTraversal("related:notes/test.md", refs);

    cache.invalidateNote("notes/test.md");
    expect(cache.getTraversal("related:notes/test.md")).toBeUndefined();
  });
});

describe("SessionCache — pending writes", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it("adds and retrieves a pending write", () => {
    const write: PendingWrite = {
      id: "w1",
      operation: "write_note",
      path: "notes/new.md",
      diff: "some diff",
      createdAt: new Date(),
    };
    cache.addPendingWrite(write);
    expect(cache.getPendingWrite("w1")).toEqual(write);
  });

  it("returns undefined for unknown write ID", () => {
    expect(cache.getPendingWrite("nonexistent")).toBeUndefined();
  });

  it("removes a pending write", () => {
    const write: PendingWrite = {
      id: "w1",
      operation: "write_note",
      path: "notes/new.md",
      diff: "some diff",
      createdAt: new Date(),
    };
    cache.addPendingWrite(write);
    expect(cache.removePendingWrite("w1")).toBe(true);
    expect(cache.getPendingWrite("w1")).toBeUndefined();
  });

  it("returns false when removing nonexistent write", () => {
    expect(cache.removePendingWrite("nonexistent")).toBe(false);
  });

  it("lists all pending writes", () => {
    const w1: PendingWrite = {
      id: "w1", operation: "write_note", path: "a.md", diff: "d1", createdAt: new Date(),
    };
    const w2: PendingWrite = {
      id: "w2", operation: "patch_note", path: "b.md", diff: "d2", createdAt: new Date(),
    };
    cache.addPendingWrite(w1);
    cache.addPendingWrite(w2);
    expect(cache.listPendingWrites()).toHaveLength(2);
  });

  it("preserves pending writes on clear()", () => {
    const write: PendingWrite = {
      id: "w1", operation: "write_note", path: "a.md", diff: "d1", createdAt: new Date(),
    };
    cache.addPendingWrite(write);
    cache.putNote("a.md", makeParsedNote("a.md"));

    cache.clear();

    // Notes and traversals cleared, but pending writes persist
    expect(cache.getNote("a.md")).toBeUndefined();
    expect(cache.getRecentlyAccessed()).toEqual([]);
    expect(cache.getPendingWrite("w1")).toEqual(write);
  });
});
