/**
 * OIL — Session cache
 * Lightweight caching scoped to MCP connection lifetime.
 * Caches file reads and graph traversal results. Avoids redundant reads in multi-turn flows.
 */

import type { NoteRef } from "./types.js";
import type { ParsedNote } from "./vault.js";

/**
 * Vault paths are canonically POSIX-style. Windows callers (notably the
 * chokidar watcher, which uses `path.relative()`) produce backslash paths;
 * without normalization `invalidateNote()` silently misses the cached entry
 * and readers serve stale content until the TTL lapses.
 */
function cacheKey(path: string): string {
  return path.replace(/\\/g, "/");
}

interface NoteCacheEntry {
  note: ParsedNote;
  cachedAt: number;
  /** mtime of the file at the moment it was cached, when known. */
  sourceMtimeMs?: number;
}

export class SessionCache {
  /** Recently accessed note paths (ordered, most recent last) */
  private recentlyAccessed: string[] = [];
  /** Cached parsed notes: path → ParsedNote */
  private noteCache = new Map<string, NoteCacheEntry>();
  /** Cached graph traversal results */
  private traversalCache = new Map<string, { refs: NoteRef[]; cachedAt: number }>();
  /** Writes OIL made itself: path → the mtime it produced and already indexed */
  private selfWrites = new Map<string, { mtimeMs: number; expiresAt: number }>();

  private readonly maxRecentlyAccessed = 50;
  private readonly maxNoteCache = 200;
  /** Cache entries expire after 5 minutes */
  private readonly ttlMs = 5 * 60 * 1000;
  /** Unclaimed self-write marks expire well after the watcher's debounce */
  private readonly selfWriteTtlMs = 30 * 1000;

  // ─── Note Cache ─────────────────────────────────────────────────────────

  /**
   * Get a cached note, or undefined if not cached, stale, or superseded on disk.
   *
   * Pass `currentMtimeMs` when the caller already stat()'d the file — the entry
   * is then revalidated against the file's real mtime instead of relying on the
   * TTL and the file watcher, which cannot see edits made while OIL is offline.
   */
  getNote(path: string, currentMtimeMs?: number): ParsedNote | undefined {
    const key = cacheKey(path);
    const entry = this.noteCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.noteCache.delete(key);
      return undefined;
    }
    if (
      currentMtimeMs !== undefined &&
      entry.sourceMtimeMs !== undefined &&
      Math.abs(entry.sourceMtimeMs - currentMtimeMs) > 1
    ) {
      this.noteCache.delete(key);
      return undefined;
    }
    return entry.note;
  }

  /**
   * Cache a parsed note. Supply `sourceMtimeMs` to enable mtime revalidation.
   */
  putNote(path: string, note: ParsedNote, sourceMtimeMs?: number): void {
    const key = cacheKey(path);
    this.noteCache.set(key, { note, cachedAt: Date.now(), sourceMtimeMs });
    this.trackAccess(key);
    this.evictIfNeeded();
  }

  /**
   * Invalidate a cached note (e.g., after file change).
   */
  invalidateNote(path: string): void {
    const key = cacheKey(path);
    this.noteCache.delete(key);
    // Also invalidate any traversal caches that might include this path
    for (const [traversalKey, entry] of this.traversalCache) {
      if (
        traversalKey.includes(key) ||
        entry.refs.some((r) => cacheKey(r.path) === key)
      ) {
        this.traversalCache.delete(traversalKey);
      }
    }
  }

  // ─── Self-Write Marks ───────────────────────────────────────────────────

  /**
   * Record that OIL itself produced `mtimeMs` for `path` and has already
   * re-indexed it inline. The file watcher will see its own echo ~300ms later
   * and can skip the redundant re-index.
   */
  markSelfWrite(path: string, mtimeMs: number): void {
    this.pruneSelfWrites();
    this.selfWrites.set(cacheKey(path), {
      mtimeMs,
      expiresAt: Date.now() + this.selfWriteTtlMs,
    });
  }

  /**
   * True when `mtimeMs` is exactly the state OIL last wrote, meaning the change
   * event is our own echo. Consumes the mark, so a later external edit — even
   * one landing on the same path — is still processed normally.
   */
  consumeSelfWrite(path: string, mtimeMs: number): boolean {
    const key = cacheKey(path);
    const entry = this.selfWrites.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.selfWrites.delete(key);
      return false;
    }
    // File systems vary by sub-millisecond precision.
    if (Math.abs(entry.mtimeMs - mtimeMs) > 1) return false;
    this.selfWrites.delete(key);
    return true;
  }

  private pruneSelfWrites(): void {
    const now = Date.now();
    for (const [key, entry] of this.selfWrites) {
      if (now > entry.expiresAt) this.selfWrites.delete(key);
    }
  }

  // ─── Graph Traversal Cache ──────────────────────────────────────────────

  /**
   * Get cached graph traversal results.
   */
  getTraversal(cacheKey: string): NoteRef[] | undefined {
    const entry = this.traversalCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.traversalCache.delete(cacheKey);
      return undefined;
    }
    return entry.refs;
  }

  /**
   * Cache graph traversal results.
   */
  putTraversal(cacheKey: string, refs: NoteRef[]): void {
    this.traversalCache.set(cacheKey, { refs, cachedAt: Date.now() });
  }

  // ─── Recently Accessed ─────────────────────────────────────────────────

  private trackAccess(path: string): void {
    const idx = this.recentlyAccessed.indexOf(path);
    if (idx !== -1) this.recentlyAccessed.splice(idx, 1);
    this.recentlyAccessed.push(path);
    if (this.recentlyAccessed.length > this.maxRecentlyAccessed) {
      this.recentlyAccessed.shift();
    }
  }

  getRecentlyAccessed(): string[] {
    return [...this.recentlyAccessed];
  }

  // ─── Housekeeping ──────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    if (this.noteCache.size <= this.maxNoteCache) return;
    // Evict oldest entries
    const sorted = [...this.noteCache.entries()].sort(
      (a, b) => a[1].cachedAt - b[1].cachedAt,
    );
    const toEvict = sorted.slice(0, sorted.length - this.maxNoteCache);
    for (const [key] of toEvict) {
      this.noteCache.delete(key);
    }
  }

  /**
   * Clear all caches (e.g., on full re-index).
   */
  clear(): void {
    this.noteCache.clear();
    this.traversalCache.clear();
    this.recentlyAccessed.length = 0;
  }

  getStats(): {
    cachedNotes: number;
    cachedTraversals: number;
    recentlyAccessed: number;
  } {
    return {
      cachedNotes: this.noteCache.size,
      cachedTraversals: this.traversalCache.size,
      recentlyAccessed: this.recentlyAccessed.length,
    };
  }
}
