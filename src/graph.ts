/**
 * OIL — Graph index engine
 * Wikilink parser, backlink computation, tag index, N-hop traversal.
 * Built at startup, updated incrementally via file watcher.
 * Persisted to _oil-graph.json for fast restart.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import matter from "gray-matter";
import type { GraphNode, GraphStats, NoteRef, TagCount } from "./types.js";
import { listAllNotes, extractWikilinks, isAllowedFile } from "./vault.js";

// ─── Persisted Graph Format ───────────────────────────────────────────────────

interface PersistedGraphNode {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  bodySnippet?: string;
  frontmatter: Record<string, unknown>;
  rawOutLinks: string[];
  lastModified: number;
}

interface PersistedGraph {
  version: 1 | 2;
  builtAt: string;
  nodes: PersistedGraphNode[];
}

// ─── Graph Index ──────────────────────────────────────────────────────────────

export class GraphIndex {
  /** path → GraphNode */
  private nodes = new Map<string, GraphNode>();
  /** tag → set of note paths */
  private tagIndex = new Map<string, Set<string>>();
  /** title (lowercase) → path — for resolving wikilinks by title */
  private titleIndex = new Map<string, string>();
  /** path → raw wikilink targets (before resolution) — kept for persistence */
  private rawOutLinks = new Map<string, string[]>();
  /** path → file mtime (ms) — for incremental rebuild */
  private fileMtimes = new Map<string, number>();

  private vaultPath: string;
  private _lastIndexed: Date = new Date();
  private _building = false;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  get lastIndexed(): Date {
    return this._lastIndexed;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  /** True while a build or incremental update is in progress. */
  get building(): boolean {
    return this._building;
  }

  // ─── Full Index Build ───────────────────────────────────────────────────

  /**
   * Build the complete graph index by parsing all markdown files.
   */
  async build(): Promise<void> {
    this._building = true;
    this.nodes.clear();
    this.tagIndex.clear();
    this.titleIndex.clear();
    this.rawOutLinks.clear();
    this.fileMtimes.clear();

    const notePaths = await listAllNotes(this.vaultPath);

    // Phase 1: Parse all notes, collect outlinks and metadata
    for (const notePath of notePaths) {
      await this.indexNote(notePath);
    }

    // Phase 2: Resolve wikilinks → paths and compute backlinks
    this.resolveLinks();

    this._lastIndexed = new Date();
    this._building = false;
  }

  /**
   * Parse a single note and add it to the index.
   */
  private async indexNote(notePath: string): Promise<void> {
    try {
      const fullPath = join(this.vaultPath, notePath);
      const raw = await readFile(fullPath, "utf-8");
      const { data: frontmatter, content } = matter(raw);

      // Track mtime for incremental rebuild
      try {
        const fileStat = await stat(fullPath);
        this.fileMtimes.set(notePath, fileStat.mtimeMs);
      } catch {
        // Use current time if stat fails
        this.fileMtimes.set(notePath, Date.now());
      }

      const title = this.extractTitle(notePath, content);
      const wikilinks = extractWikilinks(content);
      const tags = this.extractTags(frontmatter, content);
      const headings = this.extractHeadings(content);
      const bodySnippet = content.slice(0, 10_000);

      // Store raw wikilink targets for persistence
      this.rawOutLinks.set(notePath, wikilinks);

      const node: GraphNode = {
        path: notePath,
        title,
        tags,
        headings,
        bodySnippet,
        frontmatter: frontmatter as Record<string, unknown>,
        outLinks: new Set(wikilinks), // Temporarily stores link targets (names)
        inLinks: new Set(),
      };

      this.nodes.set(notePath, node);

      // Index by title for wikilink resolution
      this.titleIndex.set(title.toLowerCase(), notePath);
      // Also index by filename without extension
      const fileName = basename(notePath, extname(notePath));
      this.titleIndex.set(fileName.toLowerCase(), notePath);

      // Build tag index
      for (const tag of tags) {
        let paths = this.tagIndex.get(tag);
        if (!paths) {
          paths = new Set();
          this.tagIndex.set(tag, paths);
        }
        paths.add(notePath);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  /**
   * Resolve wikilink targets from names to paths, and compute backlinks.
   */
  private resolveLinks(): void {
    for (const [path, node] of this.nodes) {
      const resolvedLinks = new Set<string>();

      for (const linkTarget of node.outLinks) {
        const resolved = this.resolveWikilink(linkTarget);
        if (resolved) {
          resolvedLinks.add(resolved);
          // Add backlink on the target node
          const targetNode = this.nodes.get(resolved);
          if (targetNode) {
            targetNode.inLinks.add(path);
          }
        }
      }

      node.outLinks = resolvedLinks;
    }
  }

  /**
   * Resolve a wikilink target to a note path.
   * Tries: exact path match → title match → filename match.
   */
  private resolveWikilink(target: string): string | undefined {
    // Direct path match (e.g., "Customers/Contoso")
    const withExt = target.endsWith(".md") ? target : `${target}.md`;
    if (this.nodes.has(withExt)) return withExt;

    // Title/filename match
    return this.titleIndex.get(target.toLowerCase());
  }

  // ─── Incremental Updates ────────────────────────────────────────────────

  /**
   * Re-index a single note after it changes on disk.
   */
  async updateNote(notePath: string): Promise<void> {
    // Remove old data
    this.removeNote(notePath);
    // Re-index
    await this.indexNote(notePath);
    // Full link re-resolution (could be optimised for single-note updates)
    this.resolveAllBacklinks();
  }

  /**
   * Remove a note from the index.
   */
  removeNote(notePath: string): void {
    const node = this.nodes.get(notePath);
    if (!node) return;

    // Remove from tag index
    for (const tag of node.tags) {
      this.tagIndex.get(tag)?.delete(notePath);
    }

    // Remove backlinks pointing to this note
    for (const targetPath of node.outLinks) {
      this.nodes.get(targetPath)?.inLinks.delete(notePath);
    }

    // Remove incoming link references from source nodes
    for (const sourcePath of node.inLinks) {
      this.nodes.get(sourcePath)?.outLinks.delete(notePath);
    }

    this.nodes.delete(notePath);
    this.rawOutLinks.delete(notePath);
    this.fileMtimes.delete(notePath);
    // Clean title index
    const title = node.title.toLowerCase();
    if (this.titleIndex.get(title) === notePath) {
      this.titleIndex.delete(title);
    }
    const fileName = basename(notePath, extname(notePath)).toLowerCase();
    if (this.titleIndex.get(fileName) === notePath) {
      this.titleIndex.delete(fileName);
    }
  }

  /**
   * Recompute all backlinks from scratch (used after incremental updates).
   */
  private resolveAllBacklinks(): void {
    // Clear all backlinks
    for (const node of this.nodes.values()) {
      node.inLinks.clear();
    }
    // Recompute
    this.resolveLinks();
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  /**
   * Save the graph index to disk for fast restart.
   */
  async saveToDisk(graphIndexFile: string): Promise<void> {
    const persistedNodes: PersistedGraphNode[] = [];
    for (const [path, node] of this.nodes) {
      persistedNodes.push({
        path,
        title: node.title,
        tags: node.tags,
        headings: node.headings,
        bodySnippet: node.bodySnippet,
        frontmatter: node.frontmatter,
        rawOutLinks: this.rawOutLinks.get(path) ?? [],
        lastModified: this.fileMtimes.get(path) ?? 0,
      });
    }

    const data: PersistedGraph = {
      version: 2,
      builtAt: this._lastIndexed.toISOString(),
      nodes: persistedNodes,
    };

    const fullPath = join(this.vaultPath, graphIndexFile);
    await writeFile(fullPath, JSON.stringify(data), "utf-8");
    console.error(`[OIL] Graph index saved: ${persistedNodes.length} nodes.`);
  }

  /**
   * Load the graph index from disk. Returns true if loaded successfully.
   */
  async loadFromDisk(graphIndexFile: string): Promise<boolean> {
    try {
      const fullPath = join(this.vaultPath, graphIndexFile);
      const raw = await readFile(fullPath, "utf-8");
      const data: PersistedGraph = JSON.parse(raw);

      if (data.version !== 1 && data.version !== 2) {
        console.error("[OIL] Graph index version mismatch, will rebuild.");
        return false;
      }

      // Validate persisted shape before trusting it
      if (!Array.isArray(data.nodes)) {
        console.error("[OIL] Graph index corrupt: nodes is not an array, will rebuild.");
        return false;
      }
      for (const pn of data.nodes) {
        if (typeof pn.path !== "string" || typeof pn.title !== "string" || !Array.isArray(pn.tags)) {
          console.error("[OIL] Graph index corrupt: invalid node shape, will rebuild.");
          return false;
        }
      }

      this.nodes.clear();
      this.tagIndex.clear();
      this.titleIndex.clear();
      this.rawOutLinks.clear();
      this.fileMtimes.clear();

      for (const pn of data.nodes) {
        const node: GraphNode = {
          path: pn.path,
          title: pn.title,
          tags: pn.tags,
          headings: pn.headings ?? [],
          bodySnippet: pn.bodySnippet ?? "",
          frontmatter: pn.frontmatter,
          outLinks: new Set(pn.rawOutLinks), // Will be resolved below
          inLinks: new Set(),
        };

        this.nodes.set(pn.path, node);
        this.rawOutLinks.set(pn.path, pn.rawOutLinks);
        this.fileMtimes.set(pn.path, pn.lastModified);
        this.titleIndex.set(pn.title.toLowerCase(), pn.path);
        const fileName = basename(pn.path, extname(pn.path));
        this.titleIndex.set(fileName.toLowerCase(), pn.path);

        for (const tag of pn.tags) {
          let paths = this.tagIndex.get(tag);
          if (!paths) {
            paths = new Set();
            this.tagIndex.set(tag, paths);
          }
          paths.add(pn.path);
        }
      }

      // Resolve wikilinks → paths and compute backlinks
      this.resolveLinks();

      this._lastIndexed = new Date(data.builtAt);
      console.error(`[OIL] Graph index loaded from disk: ${this.nodes.size} nodes.`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Incremental rebuild: load from disk, then re-index only notes whose
   * mtime has changed, plus any new notes. Removes deleted notes.
   * Returns the number of notes that were re-indexed.
   */
  async buildIncremental(graphIndexFile: string): Promise<number> {
    this._building = true;

    const loaded = await this.loadFromDisk(graphIndexFile);
    if (!loaded) {
      // No persisted index — do a full build
      await this.build();
      await this.saveToDisk(graphIndexFile);
      return this.nodes.size;
    }

    const vaultNotes = new Set(await listAllNotes(this.vaultPath));
    let reindexed = 0;

    // Remove notes that no longer exist in the vault
    for (const path of [...this.nodes.keys()]) {
      if (!vaultNotes.has(path)) {
        this.removeNote(path);
        reindexed++;
      }
    }

    // Check each vault note against persisted mtime
    for (const notePath of vaultNotes) {
      const fullPath = join(this.vaultPath, notePath);
      let currentMtime: number;
      try {
        const fileStat = await stat(fullPath);
        currentMtime = fileStat.mtimeMs;
      } catch {
        continue; // file disappeared
      }

      const cachedMtime = this.fileMtimes.get(notePath);
      if (cachedMtime === undefined || Math.abs(currentMtime - cachedMtime) > 1) {
        // Note is new or changed — re-index it
        this.removeNote(notePath);
        await this.indexNote(notePath);
        reindexed++;
      }
    }

    if (reindexed > 0) {
      // Re-resolve all links since graph topology may have changed
      this.resolveAllBacklinks();
      this._lastIndexed = new Date();
      await this.saveToDisk(graphIndexFile);
      console.error(`[OIL] Incremental rebuild: ${reindexed} note(s) updated.`);
    } else {
      console.error("[OIL] Graph index up to date — no changes detected.");
    }

    this._building = false;
    return reindexed;
  }

  // ─── Graph Queries ──────────────────────────────────────────────────────

  /**
   * Get all notes that link TO a given note (backlinks).
   */
  getBacklinks(notePath: string): NoteRef[] {
    const node = this.nodes.get(notePath);
    if (!node) return [];
    return [...node.inLinks]
      .map((p) => this.toNoteRef(p))
      .filter((r): r is NoteRef => r !== null);
  }

  /**
   * Get all notes linked FROM a given note (forward links).
   */
  getForwardLinks(notePath: string): NoteRef[] {
    const node = this.nodes.get(notePath);
    if (!node) return [];
    return [...node.outLinks]
      .map((p) => this.toNoteRef(p))
      .filter((r): r is NoteRef => r !== null);
  }

  /**
   * Get graph neighbours up to N hops, with optional filters.
   */
  getRelatedNotes(
    notePath: string,
    hops: number = 2,
    filter?: {
      tags?: string[];
      folder?: string;
      frontmatter?: Record<string, unknown>;
    },
  ): NoteRef[] {
    const visited = new Set<string>();
    visited.add(notePath);

    let frontier = new Set<string>([notePath]);

    for (let hop = 0; hop < hops; hop++) {
      const nextFrontier = new Set<string>();
      for (const current of frontier) {
        const node = this.nodes.get(current);
        if (!node) continue;

        for (const linked of [...node.outLinks, ...node.inLinks]) {
          if (!visited.has(linked)) {
            visited.add(linked);
            nextFrontier.add(linked);
          }
        }
      }
      frontier = nextFrontier;
    }

    // Remove the origin note
    visited.delete(notePath);

    // Apply filters
    let results = [...visited]
      .map((p) => this.nodes.get(p))
      .filter((n): n is GraphNode => n !== undefined);

    if (filter?.tags?.length) {
      results = results.filter((n) =>
        filter.tags!.some((t) => n.tags.includes(t)),
      );
    }
    if (filter?.folder) {
      results = results.filter((n) => n.path.startsWith(filter.folder!));
    }
    if (filter?.frontmatter) {
      results = results.filter((n) =>
        Object.entries(filter.frontmatter!).every(
          ([k, v]) => n.frontmatter[k] === v,
        ),
      );
    }

    return results.map((n) => ({
      path: n.path,
      title: n.title,
      tags: n.tags,
    }));
  }

  /**
   * Get notes by tag.
   */
  getNotesByTag(tag: string): NoteRef[] {
    const paths = this.tagIndex.get(tag);
    if (!paths) return [];
    return [...paths]
      .map((p) => this.toNoteRef(p))
      .filter((r): r is NoteRef => r !== null);
  }

  /**
   * Get notes in a specific folder (prefix match).
   */
  getNotesByFolder(folder: string): NoteRef[] {
    const results: NoteRef[] = [];
    for (const [path, node] of this.nodes) {
      if (path.startsWith(folder)) {
        results.push({ path: node.path, title: node.title, tags: node.tags });
      }
    }
    return results;
  }

  /**
   * Get the GraphNode for a path (or undefined).
   */
  getNode(notePath: string): GraphNode | undefined {
    return this.nodes.get(notePath);
  }

  /**
   * Look up a note path by title or filename.
   */
  resolveTitle(title: string): string | undefined {
    return this.titleIndex.get(title.toLowerCase());
  }

  /**
   * Get overall graph statistics.
   */
  getStats(): GraphStats {
    let linkCount = 0;
    for (const node of this.nodes.values()) {
      linkCount += node.outLinks.size;
    }

    return {
      noteCount: this.nodes.size,
      linkCount,
      tagCount: this.tagIndex.size,
      topTags: this.getTopTags(20),
      mostLinkedNotes: this.getMostLinkedNotes(10),
    };
  }

  /**
   * Get the top N tags by usage count.
   */
  getTopTags(n: number): TagCount[] {
    const tagCounts: TagCount[] = [];
    for (const [tag, paths] of this.tagIndex) {
      tagCounts.push({ tag, count: paths.size });
    }
    return tagCounts.sort((a, b) => b.count - a.count).slice(0, n);
  }

  /**
   * Get the N most-linked notes (highest in-degree).
   */
  getMostLinkedNotes(n: number): NoteRef[] {
    const entries = [...this.nodes.values()]
      .sort((a, b) => b.inLinks.size - a.inLinks.size)
      .slice(0, n);

    return entries.map((node) => ({
      path: node.path,
      title: node.title,
      tags: node.tags,
    }));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private extractTitle(notePath: string, content: string): string {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();
    return basename(notePath, extname(notePath));
  }

  private extractTags(
    frontmatter: Record<string, unknown>,
    content: string,
  ): string[] {
    const tags = new Set<string>();

    const fmTags = frontmatter.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string") tags.add(t);
      }
    } else if (typeof fmTags === "string") {
      tags.add(fmTags);
    }

    const inlineTagRegex = /(?:^|\s)#([a-zA-Z][\w-/]*)/g;
    let match;
    while ((match = inlineTagRegex.exec(content)) !== null) {
      tags.add(match[1]);
    }

    return [...tags];
  }

  /**
   * Extract markdown headings (## and ###) from content for search indexing.
   * Skips the H1 (used as title) and stops at depth 3 to avoid noise.
   */
  private extractHeadings(content: string): string[] {
    const headings: string[] = [];
    const headingRegex = /^#{2,3}\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      headings.push(match[1].trim());
    }
    return headings;
  }

  private toNoteRef(path: string): NoteRef | null {
    const node = this.nodes.get(path);
    if (!node) return null;
    return { path: node.path, title: node.title, tags: node.tags };
  }
}
