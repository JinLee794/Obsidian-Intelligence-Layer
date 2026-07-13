/**
 * OIL — File watcher
 * Monitors the vault for changes and triggers incremental graph index updates.
 */

import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import { isAllowedFile } from "./vault.js";
import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import { invalidateSearchIndex } from "./search.js";

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private vaultPath: string;
  private graph: GraphIndex;
  private cache: SessionCache;
  private ready = false;
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;

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

    this.ready = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

    this.watcher = watch(this.vaultPath, {
      ignored: (candidatePath) => {
        const vaultRelative = relative(this.vaultPath, candidatePath);
        if (!vaultRelative || vaultRelative.startsWith("..")) return false;
        return vaultRelative
          .split(/[/\\]/)
          .some((segment) => segment.startsWith(".") || segment === "node_modules");
      },
      persistent: true,
      ignoreInitial: true,
      // Polling avoids native-watch descriptor exhaustion in sandboxed VS Code
      // sessions and remains portable across macOS, Windows, and Linux.
      usePolling: true,
      interval: 100,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on("add", (fullPath) => this.handleChange(fullPath, "add"))
      .on("change", (fullPath) => this.handleChange(fullPath, "change"))
      .on("unlink", (fullPath) => this.handleChange(fullPath, "unlink"))
      .on("unlinkDir", (fullPath) => {
        void this.processDirectoryRemoval(fullPath);
      })
      .on("ready", () => {
        this.ready = true;
        this.resolveReady?.();
        this.resolveReady = null;
      });
  }

  async waitUntilReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Vault watcher did not become ready within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.ready = false;
    this.resolveReady?.();
    this.resolveReady = null;
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
      ready: this.ready,
      pendingUpdates: this.pendingUpdates.size,
    };
  }

  /**
   * Handle a file change event with debouncing.
   */
  private handleChange(
    fullPath: string,
    event: "add" | "change" | "unlink",
  ): void {
    if (!isAllowedFile(fullPath)) return;

    const notePath = relative(this.vaultPath, fullPath);

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
    // Invalidate session cache first (always safe)
    this.cache.invalidateNote(notePath);

    if (event === "unlink") {
      await this.graph.deleteNote(notePath);
    } else {
      // add or change — re-index the note
      if (await this.graph.isNoteCurrent(notePath)) return;
      await this.graph.updateNote(notePath);
    }

    // Invalidate search index AFTER graph is current,
    // so rebuilt index reflects the updated node data.
    invalidateSearchIndex();
  }

  private async processDirectoryRemoval(fullPath: string): Promise<void> {
    const relativeDir = relative(this.vaultPath, fullPath).replace(/\\/g, "/");
    if (!relativeDir || relativeDir.startsWith("..")) return;
    const prefix = relativeDir.endsWith("/") ? relativeDir : `${relativeDir}/`;
    const affected = this.graph.getNotesByFolder(prefix);
    for (const note of affected) {
      this.cache.invalidateNote(note.path);
      await this.graph.deleteNote(note.path);
    }
    if (affected.length > 0) invalidateSearchIndex();
  }
}
