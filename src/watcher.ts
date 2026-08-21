/**
 * OIL — File watcher
 * Monitors the vault for changes and triggers incremental graph index updates.
 */

import { watch, type FSWatcher } from "chokidar";
import { relative, join } from "node:path";
import { stat } from "node:fs/promises";
import { isAllowedFile } from "./vault.js";
import { normalizeNotePath, type GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import { invalidateSearchIndex } from "./search.js";

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private vaultPath: string;
  private graph: GraphIndex;
  private cache: SessionCache;

  /**
   * chokidar does not report changes until its initial scan completes, which on
   * a large vault takes seconds. Edits made in that window are simply not seen,
   * so readiness is tracked and reported rather than assumed.
   */
  private _ready = false;
  private readyPromise: Promise<void> = Promise.resolve();
  /** Most recent watch fault, surfaced through get_health rather than thrown. */
  private lastError: string | null = null;

  /**
   * Changes seen but not yet applied, keyed by path so repeated events for the
   * same note collapse. Last event wins: an add followed by an unlink is an
   * unlink.
   */
  private pendingChanges = new Map<string, "add" | "change" | "unlink">();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushDeadline: NodeJS.Timeout | null = null;
  private readonly debounceMs = 300;
  /**
   * Longest a steady stream of events may defer a flush.
   *
   * The debounce restarts on every event, so a sync or a `git pull` writing
   * files continuously would otherwise postpone indexing until it finished.
   */
  private readonly maxDeferMs = 2000;
  /** Tail of the in-flight flush, so windows apply one after another. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    vaultPath: string,
    graph: GraphIndex,
    cache: SessionCache,
  ) {
    this.vaultPath = vaultPath;
    this.graph = graph;
    this.cache = cache;
  }

  /**
   * Start watching the vault for file changes.
   */
  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.vaultPath, {
      // chokidar 4 dropped glob support, so `ignored` must be a predicate.
      // It is also handed absolute paths — testing a dot-segment pattern
      // against those would ignore the *entire* vault whenever the vault root
      // itself lives under a dotted directory (e.g. `~/MCAPS-IQ/.vault`),
      // silently disabling every graph and cache invalidation. Always decide
      // based on the path *relative to the vault root*.
      ignored: (fullPath: string) => this.shouldIgnore(fullPath),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on("add", (fullPath) => this.handleChange(fullPath, "add"))
      .on("change", (fullPath) => this.handleChange(fullPath, "change"))
      .on("unlink", (fullPath) => this.handleChange(fullPath, "unlink"))
      // chokidar emits `error` for EMFILE, ENOSPC and permission failures —
      // routine on a synced or virus-scanned vault. An EventEmitter with no
      // `error` listener *throws*, so omitting this turns a recoverable watch
      // fault into a dead MCP server. Degrade to a stale-but-serving index.
      .on("error", (err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error(
          `[OIL] File watcher error (${this.lastError}) — vault changes may be missed until the next restart.`,
        );
      });

    this.readyPromise = new Promise((resolve) => {
      this.watcher?.on("ready", () => {
        this._ready = true;
        resolve();
      });
    });
  }

  /** Resolves once the initial scan is done and changes are actually observed. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this._ready = false;
    this.readyPromise = Promise.resolve();
    // Clear any pending debounced updates
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushDeadline) {
      clearTimeout(this.flushDeadline);
      this.flushDeadline = null;
    }
    this.pendingChanges.clear();
  }

  getStatus(): {
    backend: "chokidar";
    active: boolean;
    ready: boolean;
    pendingUpdates: number;
    last_error: string | null;
  } {
    return {
      backend: "chokidar",
      active: this.watcher !== null,
      ready: this._ready,
      pendingUpdates: this.pendingChanges.size,
      last_error: this.lastError,
    };
  }

  /**
   * Decide whether a watched path should be skipped.
   *
   * Evaluated against the vault-relative path so that dotted segments in the
   * vault root (a very common Obsidian layout, e.g. `<repo>/.vault`) do not
   * cause every file in the vault to be ignored.
   */
  private shouldIgnore(fullPath: string): boolean {
    const rel = normalizeNotePath(relative(this.vaultPath, fullPath));
    if (rel === "") return false; // the vault root itself
    if (rel.startsWith("../")) return true; // outside the vault
    return rel
      .split("/")
      .some((segment) => segment.startsWith(".") || segment === "node_modules");
  }

  /**
   * Handle a file change event with debouncing.
   *
   * Events are collected into a single window rather than each path getting its
   * own timer. A burst — a sync landing, a `git pull`, a bulk rename — then costs
   * one pass over the changed notes and one search invalidation, instead of one
   * of each per file.
   */
  private handleChange(
    fullPath: string,
    event: "add" | "change" | "unlink",
  ): void {
    if (!isAllowedFile(fullPath)) return;

    // `relative()` yields backslashes on Windows; the graph and session cache
    // are both keyed on POSIX-style vault paths, so normalize before dispatch.
    const notePath = normalizeNotePath(relative(this.vaultPath, fullPath));

    this.pendingChanges.set(notePath, event);

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flushChanges(), this.debounceMs);

    // A continuous stream keeps resetting the debounce above, so cap how long
    // the vault is allowed to stay stale.
    if (!this.flushDeadline) {
      this.flushDeadline = setTimeout(() => void this.flushChanges(), this.maxDeferMs);
    }
  }

  /**
   * Apply every change collected in the current window.
   *
   * Serialized: a burst arriving mid-flush queues behind the one in flight
   * rather than mutating the graph underneath it.
   */
  private flushChanges(): Promise<void> {
    this.flushChain = this.flushChain.then(
      () => this.runFlush(),
      () => this.runFlush(),
    );
    return this.flushChain;
  }

  private async runFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushDeadline) {
      clearTimeout(this.flushDeadline);
      this.flushDeadline = null;
    }

    const batch = [...this.pendingChanges];
    this.pendingChanges.clear();
    if (batch.length === 0) return;

    const removed: string[] = [];
    const updated: string[] = [];

    for (const [notePath, event] of batch) {
      if (event === "unlink") {
        removed.push(notePath);
        continue;
      }
      if (await this.isOwnEcho(notePath)) continue;
      updated.push(notePath);
    }

    if (removed.length === 0 && updated.length === 0) return;

    // Invalidate session cache first (always safe)
    for (const notePath of [...removed, ...updated]) {
      this.cache.invalidateNote(notePath);
    }

    if (removed.length > 0) {
      this.graph.removeNotes(removed);
    }
    if (updated.length > 0) {
      await this.graph.updateNotes(updated);
    }

    // Invalidate search index AFTER graph is current,
    // so rebuilt index reflects the updated node data.
    invalidateSearchIndex();
  }

  /**
   * True when this event is the echo of a write OIL just made and already
   * re-indexed inline. Matched on mtime, so an external edit landing on the
   * same path between the two is still picked up.
   */
  private async isOwnEcho(notePath: string): Promise<boolean> {
    try {
      const { mtimeMs } = await stat(join(this.vaultPath, notePath));
      return this.cache.consumeSelfWrite(notePath, mtimeMs);
    } catch {
      return false;
    }
  }
}
