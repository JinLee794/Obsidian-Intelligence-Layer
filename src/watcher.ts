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

  /** Debounce timer for batching rapid changes */
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 300;

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
      .on("unlink", (fullPath) => this.handleChange(fullPath, "unlink"));

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
    for (const timer of this.pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.pendingUpdates.clear();
  }

  getStatus(): {
    backend: "chokidar";
    active: boolean;
    ready: boolean;
    pendingUpdates: number;
  } {
    return {
      backend: "chokidar",
      active: this.watcher !== null,
      ready: this._ready,
      pendingUpdates: this.pendingUpdates.size,
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
   */
  private handleChange(
    fullPath: string,
    event: "add" | "change" | "unlink",
  ): void {
    if (!isAllowedFile(fullPath)) return;

    // `relative()` yields backslashes on Windows; the graph and session cache
    // are both keyed on POSIX-style vault paths, so normalize before dispatch.
    const notePath = normalizeNotePath(relative(this.vaultPath, fullPath));

    // Cancel any pending update for this path
    const existing = this.pendingUpdates.get(notePath);
    if (existing) clearTimeout(existing);

    // Debounce the update
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(notePath);
      this.processChange(notePath, event);
    }, this.debounceMs);

    this.pendingUpdates.set(notePath, timer);
  }

  /**
   * Process a debounced file change.
   */
  private async processChange(
    notePath: string,
    event: "add" | "change" | "unlink",
  ): Promise<void> {
    if (event !== "unlink" && (await this.isOwnEcho(notePath))) return;

    // Invalidate session cache first (always safe)
    this.cache.invalidateNote(notePath);

    if (event === "unlink") {
      this.graph.removeNote(notePath);
    } else {
      // add or change — re-index the note
      await this.graph.updateNote(notePath);
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
