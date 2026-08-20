/**
 * OIL — Graph index engine
 * Wikilink parser, backlink computation, tag index, N-hop traversal.
 * Built at startup, updated incrementally via file watcher.
 * Persisted to _oil-graph.json for fast restart.
 */

import { readFile, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname, basename, extname } from "node:path";
import matter from "gray-matter";
import type { GraphNode, GraphStats, NoteRef, RelatedNoteRef, TagCount } from "./types.js";
import { listAllNotes, extractWikilinks, isAllowedFile, normalizeLineEndings } from "./vault.js";

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

/** A note read from disk, not yet folded into the index. */
interface ParsedNote {
  path: string;
  mtimeMs: number;
  title: string;
  wikilinks: string[];
  tags: string[];
  headings: string[];
  bodySnippet: string;
  frontmatter: Record<string, unknown>;
}

/**
 * How many vault files to have open at once.
 *
 * Indexing is latency-bound rather than CPU-bound — on a synced or network
 * vault a single stat or read costs tens of milliseconds — so the work wants to
 * be overlapped. Bounded because an unbounded fan-out over a large vault
 * exhausts file descriptors (EMFILE), which is the failure this server is least
 * able to afford.
 */
const IO_CONCURRENCY = 32;

/**
 * Notes to re-index between checkpoint saves.
 *
 * Small enough that a session ending mid-rebuild loses seconds of work rather
 * than all of it; large enough that the save itself stays a rounding error.
 */
const CHECKPOINT_EVERY = 500;

/**
 * Longest a rebuild may run without persisting anything.
 *
 * The note threshold alone assumes a rebuild rate. Where that assumption fails
 * — large notes, a slow disk, an on-access virus scanner — a short session can
 * end having saved nothing at all, and repeat the same work on every connect.
 * Two seconds is well inside the window a client allows between disconnecting
 * and killing the process.
 */
const CHECKPOINT_INTERVAL_MS = 2000;

/**
 * Notes re-read per batch.
 *
 * Decoupled from the checkpoint thresholds so that progress can be measured
 * often enough for a time-based checkpoint to be responsive.
 */
const BATCH_SIZE = 128;

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Graph Index ──────────────────────────────────────────────────────────────

/**
 * Vault note paths are canonically POSIX-style (Obsidian convention), but
 * `path.relative()` on Windows returns backslashes. Normalizing at every
 * index boundary keeps watcher-driven updates matching the indexed keys.
 */
export function normalizeNotePath(notePath: string): string {
  return notePath.replace(/\\/g, "/");
}

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
  private _version = 0;
  /** Mutations not yet persisted. Drives save-on-shutdown. */
  private _dirty = false;

  /**
   * Recent per-note mutations, so a derived index can refresh only what moved.
   * Bounded: past the limit the oldest entries are dropped and anyone lagging
   * that far is told to rebuild, which is cheaper than tracking forever.
   */
  private mutationLog: Array<{ version: number; path: string }> = [];
  private static readonly MUTATION_LOG_LIMIT = 2048;
  /** Deltas below this version have been discarded or invalidated wholesale. */
  private logFloor = 0;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  get lastIndexed(): Date {
    return this._lastIndexed;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Bumped by every mutation. Derived indexes (search) key their caches on it —
   * node count alone cannot detect an in-place content edit.
   */
  get version(): number {
    return this._version;
  }

  /** True while a build or incremental update is in progress. */
  get building(): boolean {
    return this._building;
  }

  /**
   * True when the in-memory index holds work that is not on disk.
   *
   * Indexing that is never persisted is indexing that runs again next session,
   * so callers save on the way out rather than discarding it.
   */
  get dirty(): boolean {
    return this._dirty;
  }

  /** Persist only if there is something to persist. */
  async flush(graphIndexFile: string): Promise<boolean> {
    if (!this._dirty) return false;
    await this.saveToDisk(graphIndexFile);
    return true;
  }

  private recordMutation(path: string): void {
    this._dirty = true;
    this.mutationLog.push({ version: this._version, path });
    if (this.mutationLog.length > GraphIndex.MUTATION_LOG_LIMIT) {
      const dropped = this.mutationLog.splice(
        0,
        this.mutationLog.length - GraphIndex.MUTATION_LOG_LIMIT,
      );
      this.logFloor = dropped[dropped.length - 1].version;
    }
  }

  /** Forget the delta history — callers at any earlier version must rebuild. */
  private resetMutationLog(): void {
    this.mutationLog.length = 0;
    this.logFloor = this._version;
  }

  /**
   * Notes mutated since `sinceVersion`, or null when that delta is no longer
   * available and the caller has to rebuild from scratch.
   *
   * A path is returned whether it was added, edited or deleted; callers are
   * expected to re-read the node and treat a missing one as a removal.
   */
  changesSince(sinceVersion: number): string[] | null {
    if (sinceVersion < this.logFloor) return null;
    if (sinceVersion >= this._version) return [];

    const paths = new Set<string>();
    for (const entry of this.mutationLog) {
      if (entry.version > sinceVersion) paths.add(entry.path);
    }
    return [...paths];
  }

  // ─── Full Index Build ───────────────────────────────────────────────────

  /**
   * Build the complete graph index by parsing all markdown files.
   */
  async build(): Promise<void> {
    this._building = true;
    this._version++;
    this.nodes.clear();
    this.tagIndex.clear();
    this.titleIndex.clear();
    this.rawOutLinks.clear();
    this.fileMtimes.clear();
    this.resetMutationLog();

    const notePaths = await listAllNotes(this.vaultPath);

    // Phase 1: Read all notes in parallel, then fold them in list order so the
    // result does not depend on which read finished first.
    const parsed = await mapWithConcurrency(notePaths, IO_CONCURRENCY, (notePath) =>
      this.readNote(notePath),
    );
    for (const note of parsed) {
      if (note) this.applyNote(note);
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
    const parsed = await this.readNote(notePath);
    if (parsed) this.applyNote(parsed);
  }

  /**
   * Read and parse a note without touching the index.
   *
   * Split from the mutation half so many notes can be read at once: vault IO is
   * latency-bound, and doing it one note at a time is what made indexing scale
   * with vault size. Returns null for anything unreadable — a file that
   * disappeared mid-walk is normal, not an error.
   */
  private async readNote(notePath: string): Promise<ParsedNote | null> {
    try {
      const fullPath = join(this.vaultPath, notePath);
      const [raw, fileStat] = await Promise.all([
        readFile(fullPath, "utf-8"),
        stat(fullPath).catch(() => null),
      ]);
      // Normalize CRLF up front — heading/tag regexes below use `.` and `$`,
      // neither of which tolerates a trailing "\r".
      const { data: frontmatter, content } = matter(normalizeLineEndings(raw));

      return {
        path: notePath,
        mtimeMs: fileStat?.mtimeMs ?? Date.now(),
        title: this.extractTitle(notePath, content),
        wikilinks: extractWikilinks(content),
        tags: this.extractTags(frontmatter, content),
        headings: this.extractHeadings(content),
        bodySnippet: content.slice(0, 10_000),
        frontmatter: frontmatter as Record<string, unknown>,
      };
    } catch {
      // Skip files that can't be read or parsed
      return null;
    }
  }

  /**
   * Fold a parsed note into the index.
   *
   * Synchronous on purpose: callers apply in a stable order so that a title
   * collision between two notes resolves the same way on every run, whichever
   * read happened to finish first.
   */
  private applyNote(parsed: ParsedNote): void {
    const notePath = parsed.path;

    this.fileMtimes.set(notePath, parsed.mtimeMs);

    this._version++;
    this.recordMutation(notePath);

    // Store raw wikilink targets for persistence
    this.rawOutLinks.set(notePath, parsed.wikilinks);

    const node: GraphNode = {
      path: notePath,
      title: parsed.title,
      tags: parsed.tags,
      headings: parsed.headings,
      bodySnippet: parsed.bodySnippet,
      frontmatter: parsed.frontmatter,
      outLinks: new Set(parsed.wikilinks), // Temporarily stores link targets (names)
      inLinks: new Set(),
    };

    this.nodes.set(notePath, node);

    // Index by title for wikilink resolution
    this.titleIndex.set(parsed.title.toLowerCase(), notePath);
    // Also index by filename without extension
    const fileName = basename(notePath, extname(notePath));
    this.titleIndex.set(fileName.toLowerCase(), notePath);

    // Build tag index
    for (const tag of parsed.tags) {
      let paths = this.tagIndex.get(tag);
      if (!paths) {
        paths = new Set();
        this.tagIndex.set(tag, paths);
      }
      paths.add(notePath);
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
    const key = normalizeNotePath(notePath);
    // Remove old data
    this.removeNote(key);
    // Re-index
    await this.indexNote(key);
    // Full link re-resolution (could be optimised for single-note updates)
    this.resolveAllBacklinks();
  }

  /**
   * Remove a note from the index.
   */
  removeNote(notePath: string): void {
    const key = normalizeNotePath(notePath);
    const node = this.nodes.get(key);
    if (!node) return;
    return this.removeNodeInternal(key, node);
  }

  private removeNodeInternal(notePath: string, node: GraphNode): void {
    this._version++;
    this.recordMutation(notePath);

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

    // Write-then-rename: a plain writeFile truncates the file first, so a
    // second OIL instance reading concurrently sees partial JSON and discards
    // the index, forcing a full rebuild. Rename is atomic for readers.
    const fullPath = join(this.vaultPath, graphIndexFile);
    const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(data), "utf-8");
      // Windows fails the rename with EPERM while another instance has the
      // index open for reading; that clears in milliseconds.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmpPath, fullPath);
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code !== "EPERM" && code !== "EACCES") || attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    await this.sweepStaleTemps(fullPath);
    this._dirty = false;
    console.error(`[OIL] Graph index saved: ${persistedNodes.length} nodes.`);
  }

  /**
   * Remove temp files orphaned when a process was killed between write and
   * rename. Only sweeps files old enough to not belong to a live save.
   */
  private async sweepStaleTemps(indexFullPath: string): Promise<void> {
    try {
      const dir = dirname(indexFullPath);
      const prefix = `${basename(indexFullPath)}.`;
      const cutoff = Date.now() - 60_000;
      const entries = await readdir(dir);
      await Promise.all(
        entries
          .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
          .map(async (name) => {
            const candidate = join(dir, name);
            const info = await stat(candidate).catch(() => null);
            if (info && info.mtimeMs < cutoff) await unlink(candidate).catch(() => {});
          }),
      );
    } catch {
      // Best-effort cleanup only.
    }
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

      this._version++;
      this.nodes.clear();
      this.tagIndex.clear();
      this.titleIndex.clear();
      this.rawOutLinks.clear();
      this.fileMtimes.clear();
      this.resetMutationLog();

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
      // Startup is the reliable moment to clear temp files from a killed save;
      // a read-only session may never write.
      await this.sweepStaleTemps(fullPath);
      return true;
    } catch (err) {
      // A missing index is the normal first-run case; anything else is a
      // silent downgrade to a full rebuild and worth naming.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(
          `[OIL] Graph index unreadable (${code ?? (err as Error).message}) — falling back to full build.`,
        );
      }
      return false;
    }
  }

  /**
   * Incremental rebuild: re-index only notes whose mtime has changed, plus any
   * new notes. Removes deleted notes. Loads from disk only when the index is
   * not already in memory.
   * Returns the number of notes that were re-indexed.
   */
  async buildIncremental(graphIndexFile: string): Promise<number> {
    this._building = true;

    try {
      // Startup loads the index before calling this. Re-reading it would parse
      // the whole file a second time and discard any note the watcher or a
      // write tool has already updated in memory.
      if (this.nodes.size === 0) {
        const loaded = await this.loadFromDisk(graphIndexFile);
        if (!loaded) {
          // No persisted index — do a full build
          await this.build();
          await this.saveToDisk(graphIndexFile);
          return this.nodes.size;
        }
      }

      const vaultNotes = await listAllNotes(this.vaultPath);
      const present = new Set(vaultNotes);
      let reindexed = 0;

      // Remove notes that no longer exist in the vault
      for (const path of [...this.nodes.keys()]) {
        if (!present.has(path)) {
          this.removeNote(path);
          reindexed++;
        }
      }

      // Revalidate against disk. One stat per note, but issued in parallel:
      // sequentially this is the single most expensive thing a warm start does,
      // and on a synced or network vault each stat carries real latency.
      const mtimes = await mapWithConcurrency(vaultNotes, IO_CONCURRENCY, async (notePath) => {
        try {
          return (await stat(join(this.vaultPath, notePath))).mtimeMs;
        } catch {
          return null; // file disappeared
        }
      });

      const changed = vaultNotes.filter((notePath, i) => {
        const currentMtime = mtimes[i];
        if (currentMtime === null) return false;
        const cachedMtime = this.fileMtimes.get(notePath);
        return cachedMtime === undefined || Math.abs(currentMtime - cachedMtime) > 1;
      });

      // Re-read changed notes in batches, persisting as we go. A mass
      // invalidation — a sync, a restore, a `git pull`, any of which rewrites
      // mtimes wholesale — can take longer than the session that discovered it.
      // Without checkpoints that work is lost on disconnect and repeated in
      // full next time, so a short-session client never converges.
      //
      // Checkpoints are triggered by elapsed time as well as note count,
      // because count alone assumes a rebuild rate. A vault of large notes on a
      // slow or scanned disk can spend an entire short session without reaching
      // the note threshold, save nothing, and so repeat that work forever.
      let sinceCheckpoint = 0;
      let lastCheckpoint = Date.now();
      for (let offset = 0; offset < changed.length; offset += BATCH_SIZE) {
        const batch = changed.slice(offset, offset + BATCH_SIZE);
        const parsed = await mapWithConcurrency(batch, IO_CONCURRENCY, (notePath) =>
          this.readNote(notePath),
        );
        for (let i = 0; i < batch.length; i++) {
          this.removeNote(batch[i]);
          const note = parsed[i];
          if (note) this.applyNote(note);
          reindexed++;
          sinceCheckpoint++;
        }

        const isLastBatch = offset + BATCH_SIZE >= changed.length;
        const due =
          sinceCheckpoint >= CHECKPOINT_EVERY ||
          Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS;
        if (!isLastBatch && due) {
          this.resolveAllBacklinks();
          await this.saveToDisk(graphIndexFile).catch((err) =>
            console.error("[OIL] Index checkpoint failed (continuing):", err),
          );
          sinceCheckpoint = 0;
          lastCheckpoint = Date.now();
          console.error(
            `[OIL] Re-indexing ${offset + batch.length}/${changed.length} — progress saved.`,
          );
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

      return reindexed;
    } finally {
      this._building = false;
    }
  }

  // ─── Graph Queries ──────────────────────────────────────────────────────

  /**
   * Get all notes that link TO a given note (backlinks).
   */
  getBacklinks(notePath: string): NoteRef[] {
    const node = this.nodes.get(normalizeNotePath(notePath));
    if (!node) return [];
    return [...node.inLinks]
      .map((p) => this.toNoteRef(p))
      .filter((r): r is NoteRef => r !== null);
  }

  /**
   * Get all notes linked FROM a given note (forward links).
   */
  getForwardLinks(notePath: string): NoteRef[] {
    const node = this.nodes.get(normalizeNotePath(notePath));
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
  ): RelatedNoteRef[] {
    const visited = new Set<string>();
    visited.add(notePath);

    // Distance and direction are what let a caller rank a traversal result;
    // without them every hop looks equally relevant.
    const hopOf = new Map<string, number>();
    const directionOf = new Map<string, "out" | "in" | "both">();

    let frontier = new Set<string>([notePath]);

    for (let hop = 0; hop < hops; hop++) {
      const nextFrontier = new Set<string>();
      for (const current of frontier) {
        const node = this.nodes.get(current);
        if (!node) continue;

        for (const [linked, direction] of [
          ...[...node.outLinks].map((p) => [p, "out"] as const),
          ...[...node.inLinks].map((p) => [p, "in"] as const),
        ]) {
          if (visited.has(linked)) {
            if (hopOf.get(linked) === hop + 1 && directionOf.get(linked) !== direction) {
              directionOf.set(linked, "both");
            }
            continue;
          }
          visited.add(linked);
          hopOf.set(linked, hop + 1);
          directionOf.set(linked, direction);
          nextFrontier.add(linked);
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

    return results
      .map((n) => ({
        path: n.path,
        title: n.title,
        tags: n.tags,
        hops: hopOf.get(n.path) ?? hops,
        via: directionOf.get(n.path) ?? "out",
      }))
      .sort((a, b) => a.hops - b.hops || a.path.localeCompare(b.path));
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
    return this.nodes.get(normalizeNotePath(notePath));
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
