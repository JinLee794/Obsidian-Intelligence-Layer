/**
 * Tests for SessionCache — LRU note cache, self-write marks, traversal cache.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionCache } from "../cache.js";
import type { ParsedNote } from "../vault.js";

function makeParsedNote(path: string): ParsedNote {
  return {
    path,
    title: path,
    frontmatter: { tags: ["test"] },
    content: `# ${path}\nSome content`,
    sections: new Map([["Test", "section body"]]),
    wikilinks: [],
    tags: ["test"],
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

describe("SessionCache — self-write marks", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it("returns false when nothing was marked", () => {
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(false);
  });

  it("matches the exact mtime OIL wrote", () => {
    cache.markSelfWrite("notes/a.md", 1000);
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(true);
  });

  it("is single-use so a later edit is still processed", () => {
    cache.markSelfWrite("notes/a.md", 1000);
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(true);
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(false);
  });

  it("does not match an external edit with a different mtime", () => {
    cache.markSelfWrite("notes/a.md", 1000);
    expect(cache.consumeSelfWrite("notes/a.md", 5000)).toBe(false);
    // The mark survives so OIL's own echo can still be dropped
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(true);
  });

  it("tolerates sub-millisecond filesystem drift", () => {
    cache.markSelfWrite("notes/a.md", 1000);
    expect(cache.consumeSelfWrite("notes/a.md", 1000.5)).toBe(true);
  });

  it("normalizes Windows-style separators", () => {
    cache.markSelfWrite("notes\\a.md", 1000);
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(true);
  });

  it("expires unclaimed marks", () => {
    cache.markSelfWrite("notes/a.md", 1000);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    expect(cache.consumeSelfWrite("notes/a.md", 1000)).toBe(false);
    vi.restoreAllMocks();
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

describe("SessionCache — getStats", () => {
  it("reports zero counts on empty cache", () => {
    const cache = new SessionCache();
    const stats = cache.getStats();
    expect(stats.cachedNotes).toBe(0);
    expect(stats.cachedTraversals).toBe(0);
    expect(stats.recentlyAccessed).toBe(0);
  });

  it("reports correct counts after populating", () => {
    const cache = new SessionCache();
    cache.putNote("a.md", makeParsedNote("a.md"));
    cache.putNote("b.md", makeParsedNote("b.md"));

    const stats = cache.getStats();
    expect(stats.cachedNotes).toBe(2);
    expect(stats.recentlyAccessed).toBe(2);
  });

  it("reflects clear() correctly", () => {
    const cache = new SessionCache();
    cache.putNote("a.md", makeParsedNote("a.md"));

    cache.clear();
    const stats = cache.getStats();
    expect(stats.cachedNotes).toBe(0);
    expect(stats.recentlyAccessed).toBe(0);
  });
});
