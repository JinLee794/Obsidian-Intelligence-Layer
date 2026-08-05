/**
 * OIL — Session cache
 * Lightweight caching scoped to MCP connection lifetime.
 * Caches file reads and graph traversal results. Avoids redundant reads in multi-turn flows.
 */

import type { NoteRef, PendingWrite } from "./types.js";
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
  /** Queue of gated write operations awaiting confirmation */
  private pendingWrites: PendingWrite[] = [];

  private readonly maxRecentlyAccessed = 50;
  private readonly maxNoteCache = 200;
  /** Cache entries expire after 5 minutes */
  private readonly ttlMs = 5 * 60 * 1000;

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

  // ─── Pending Writes ─────────────────────────────────────────────────────

  addPendingWrite(write: PendingWrite): void {
    this.pendingWrites.push(write);
  }

  getPendingWrite(id: string): PendingWrite | undefined {
    return this.pendingWrites.find((w) => w.id === id);
  }

  removePendingWrite(id: string): boolean {
    const idx = this.pendingWrites.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.pendingWrites.splice(idx, 1);
    return true;
  }

  listPendingWrites(): PendingWrite[] {
    return [...this.pendingWrites];
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
    // Pending writes are NOT cleared — they persist until confirmed/rejected.
  }

  getStats(): {
    cachedNotes: number;
    cachedTraversals: number;
    recentlyAccessed: number;
    pendingWrites: number;
  } {
    return {
      cachedNotes: this.noteCache.size,
      cachedTraversals: this.traversalCache.size,
      recentlyAccessed: this.recentlyAccessed.length,
      pendingWrites: this.pendingWrites.length,
    };
  }
}
