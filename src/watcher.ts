/**
 * OIL — File watcher
 * Monitors the vault for changes and triggers incremental graph index updates.
 */

import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import { isAllowedFile } from "./vault.js";
import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { invalidateSearchIndex } from "./search.js";
import { invalidateFrontmatterIndex } from "./tools/retrieve.js";

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private vaultPath: string;
  private graph: GraphIndex;
  private cache: SessionCache;
  private embeddings: EmbeddingIndex | null;

  /** Debounce timer for batching rapid changes */
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 300;

  constructor(
    vaultPath: string,
    graph: GraphIndex,
    cache: SessionCache,
    embeddings?: EmbeddingIndex | null,
  ) {
    this.vaultPath = vaultPath;
    this.graph = graph;
    this.cache = cache;
    this.embeddings = embeddings ?? null;
  }

  /**
   * Start watching the vault for file changes.
   */
  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.vaultPath, {
      ignored: [
        /(^|[/\\])\../, // dotfiles/dirs
        "**/node_modules/**",
        "**/_oil-index.json",
      ],
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
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // Clear any pending debounced updates
    for (const timer of this.pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.pendingUpdates.clear();
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
      this.graph.removeNote(notePath);
      this.embeddings?.removeNote(notePath);
    } else {
      // add or change — re-index the note first
      await this.graph.updateNote(notePath);
      // Update embedding asynchronously (non-blocking)
      this.embeddings?.updateNote(notePath).catch((err) => {
        console.error(`[OIL] Embedding update failed for ${notePath}:`, err);
      });
    }

    // Invalidate search & frontmatter indexes AFTER graph is current,
    // so rebuilt indexes reflect the updated node data.
    invalidateSearchIndex();
    invalidateFrontmatterIndex();
  }
}
