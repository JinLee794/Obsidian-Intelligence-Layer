/**
 * OIL — Graph index engine
 * Wikilink parser, backlink computation, tag index, N-hop traversal.
 * Built at startup, updated incrementally via file watcher.
 * Persisted for fast restart, either as one `_oil-graph.json` (v2) or as a
 * segmented skeleton plus per-folder segments (v3, see graph-segments.ts).
 */

import { readFile, stat, mkdir, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import matter from "gray-matter";
import type {
  BrokenLink,
  GraphLayout,
  GraphNode,
  GraphStats,
  NoteRef,
  RelatedNoteRef,
  TagCount,
} from "./types.js";
import { listAllNotes, extractWikilinks, normalizeWikilinkTarget, isAllowedFile, normalizeLineEndings } from "./vault.js";
import { findConflictCopies, removeFiles, sameMtime, sweepStaleTemps } from "./sidecar-sync.js";
import {
  GRAPH_LAYOUTS,
  SEGMENTED_FORMAT,
  SEGMENTED_VERSION,
  SKELETON_FILE,
  newGeneration,
  normalizeSegmentPolicy,
  readSegment,
  readSkeleton,
  removeSegmentFiles,
  segmentDirFor,
  segmentFileName,
  segmentKeyFor,
  segmentPayload,
  sha1,
  skeletonFrontmatter,
  skeletonStamp,
  sweepSegmentDir,
  writeFileAtomic,
} from "./graph-segments.js";
import type {
  PersistedSkeleton,
  SegmentMeta,
  SegmentNote,
  SegmentPolicy,
  SkeletonNode,
} from "./graph-segments.js";

/** Extensions a wikilink may carry and still target an indexed note. */
const MARKDOWN_LINK_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

// ─── Persisted Graph Format ───────────────────────────────────────────────────

export interface PersistedGraphNode {
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

/** The on-disk layouts a graph can be saved in or loaded from. */
export type PersistedLayout = "single" | "segmented";

export interface GraphIndexOptions {
  /**
   * Where the index persists. "auto" (the default) keeps whichever layout the
   * vault already has — segmented once `migrate-graph --apply` has run, the
   * single v2 file otherwise.
   */
  layout?: GraphLayout;
  /** How notes are grouped into segments; defaults follow the default schema. */
  segmentPolicy?: Partial<SegmentPolicy>;
}

/** What the last successful save wrote. */
export interface GraphSaveReport {
  layout: PersistedLayout;
  /** Files written, the skeleton included. */
  filesWritten: number;
  bytesWritten: number;
  /** Segmented only: segments rewritten, and segments in total. */
  segmentsWritten: number;
  segmentsTotal: number;
}

/** Damage found by the last segmented load; damaged notes are re-read from the vault. */
export interface SegmentHealth {
  segments: number;
  damagedSegments: string[];
  recoveredNotes: number;
}

/** What a segmented save would write, for a dry run. */
export interface SegmentedLayoutPlan {
  skeletonBytes: number;
  segments: Array<{ key: string; notes: number; bytes: number }>;
}

/** The persisted state of a segmented index, as this process last saw it. */
interface SegmentState {
  /** Absolute segment directory. */
  dir: string;
  /**
   * Stamp of the skeleton this state describes. If the skeleton on disk no
   * longer carries it, another process has saved since, and nothing here may
   * be trusted to describe the files on disk.
   */
  stamp: string | null;
  policyJson: string;
  /** Note path → segment key, as persisted. */
  keyOf: Map<string, string>;
  segments: Map<string, SegmentMeta>;
  /** Keys to rewrite next save whatever their hash says: damaged on load, or a write failed. */
  forceDirty: Set<string>;
}

type LoadStatus = "ok" | "missing" | "invalid";

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

/** Segment files to read or write at once. */
const SEGMENT_IO_CONCURRENCY = 8;

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

/**
 * Read Obsidian frontmatter aliases. Obsidian accepts both `aliases` and the
 * singular `alias`, as either a scalar or a list, and OIL matches frontmatter
 * keys case-insensitively — so all of those spellings resolve here.
 */
export function readAliases(frontmatter: Record<string, unknown>): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];

  const aliases: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const normalized = key.toLowerCase();
    if (normalized !== "aliases" && normalized !== "alias") continue;

    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (trimmed) aliases.push(trimmed);
    }
  }
  return aliases;
}

/**
 * True when a wikilink target names a non-markdown file — an attachment embed
 * such as `![[diagram.png]]`. A bare title like "Jin Lee (HLS US SE)" has no
 * extension and is never mistaken for one.
 */
function isAttachmentTarget(target: string): boolean {
  const ext = extname(target).toLowerCase();
  return ext !== "" && !MARKDOWN_LINK_EXTENSIONS.has(ext);
}

export class GraphIndex {
  /** path → GraphNode */
  private nodes = new Map<string, GraphNode>();
  /** tag → set of note paths */
  private tagIndex = new Map<string, Set<string>>();
  /** title (lowercase) → path — for resolving wikilinks by title */
  private titleIndex = new Map<string, string>();
  /**
   * Set while the set of names a wikilink can resolve through has changed but
   * the whole-vault resolve that change demands has not run yet.
   *
   * A note's body can be rewritten without affecting how any *other* note's
   * links resolve; its title or filename changing, or the note appearing or
   * disappearing, can affect all of them. Telling those two apart is what lets
   * an ordinary edit skip the full pass.
   *
   * Sticky, rather than a counter compared across an update, because a removal
   * raises it *before* the next batch starts: a batch snapshotting a counter on
   * entry would take that snapshot after the bump, see no difference, and skip
   * the very resolve the removal needed.
   */
  private _namesDirty = false;
  /**
   * Names given up by a removal or a retitle that another live note may still
   * answer to. Recorded rather than chased down there and then, so a bulk
   * delete pays one pass over the vault instead of one per file.
   */
  private orphanedNames = new Set<string>();
  /**
   * frontmatter alias (lowercase) → path. Kept separate from titleIndex so a
   * real filename or H1 title always wins over another note's alias, whatever
   * order notes happen to be indexed in.
   */
  private aliasIndex = new Map<string, string>();
  /** Aliases given up by an edit or removal; the alias analogue of `orphanedNames`. */
  private orphanedAliases = new Set<string>();
  /** path → raw wikilink targets (before resolution) — kept for persistence */
  private rawOutLinks = new Map<string, string[]>();
  /** path → file mtime (ms) — for incremental rebuild */
  private fileMtimes = new Map<string, number>();

  private vaultPath: string;
  private _lastIndexed: Date = new Date();
  private _building = false;
  private _version = 0;
  /**
   * Notes mutated since the last save. Drives save-on-shutdown, and tells a
   * segmented save which segments it has to rewrite.
   */
  private unsavedPaths = new Set<string>();
  /** Set when what is on disk is damaged or superseded and wants rewriting. */
  private _needsRewrite = false;
  /**
   * Saves run one at a time. A save takes the pending set before it writes, so
   * two overlapping saves would each see only part of it — and a segmented save
   * could unlink a segment file the other one's skeleton still references.
   */
  private saveTail: Promise<void> = Promise.resolve();
  private savesInFlight = 0;

  private readonly layout: GraphLayout;
  private readonly segmentPolicy: SegmentPolicy;
  private segState: SegmentState | null = null;
  private _loadedLayout: PersistedLayout | null = null;
  private _lastSave: GraphSaveReport | null = null;
  private _segmentHealth: SegmentHealth | null = null;

  /**
   * Recent per-note mutations, so a derived index can refresh only what moved.
   * Bounded: past the limit the oldest entries are dropped and anyone lagging
   * that far is told to rebuild, which is cheaper than tracking forever.
   */
  private mutationLog: Array<{ version: number; path: string }> = [];
  private static readonly MUTATION_LOG_LIMIT = 2048;
  /** Deltas below this version have been discarded or invalidated wholesale. */
  private logFloor = 0;

  constructor(vaultPath: string, options: GraphIndexOptions = {}) {
    this.vaultPath = vaultPath;
    this.layout = options.layout && GRAPH_LAYOUTS.includes(options.layout) ? options.layout : "auto";
    this.segmentPolicy = normalizeSegmentPolicy(options.segmentPolicy);
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
    // A save in flight has taken the pending set but not landed yet.
    return this.unsavedPaths.size > 0 || this._needsRewrite || this.savesInFlight > 0;
  }

  /** The layout the index was last loaded from; null when built from the notes. */
  get loadedLayout(): PersistedLayout | null {
    return this._loadedLayout;
  }

  /** What the last successful save wrote, or null before the first one. */
  get lastSave(): GraphSaveReport | null {
    return this._lastSave;
  }

  /** Damage found by the last segmented load, or null if it was not segmented. */
  get segmentHealth(): SegmentHealth | null {
    return this._segmentHealth;
  }

  /** Persist only if there is something to persist. */
  async flush(graphIndexFile: string): Promise<boolean> {
    // Let a background save land first: it may cover everything, and returning
    // before it does would let a shutdown exit with the index half-written.
    while (this.savesInFlight > 0) await this.saveTail;
    if (!this.dirty) return false;
    await this.saveToDisk(graphIndexFile);
    return true;
  }

  private recordMutation(path: string): void {
    this.unsavedPaths.add(path);
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
    this.aliasIndex.clear();
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
    this.orphanedNames.clear();
    this.orphanedAliases.clear();
    this._namesDirty = false;

    this._lastIndexed = new Date();
    this._loadedLayout = null;
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
    this.indexTitle(parsed.title.toLowerCase(), notePath);
    // Also index by filename without extension
    const fileName = basename(notePath, extname(notePath));
    this.indexTitle(fileName.toLowerCase(), notePath);
    // Obsidian resolves `[[alias]]` via frontmatter aliases — mirror that.
    this.indexAliases(notePath, parsed.frontmatter as Record<string, unknown>);

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
   *
   * Resolution reads from `rawOutLinks`, not from `node.outLinks`. The latter
   * has already been rewritten from names to paths by any earlier pass, with
   * whatever failed to resolve dropped — so re-resolving from it could never
   * recover a link that dangled at build time, and the index diverged
   * permanently from a rebuild once a link's target arrived late.
   */
  private resolveLinks(): void {
    for (const path of this.nodes.keys()) {
      this.resolveLinksForNote(path);
    }
  }

  /** Resolve just these notes' wikilinks, updating their targets' backlinks. */
  private resolveLinksFor(notePaths: readonly string[]): void {
    for (const notePath of notePaths) {
      this.resolveLinksForNote(notePath);
    }
  }

  private resolveLinksForNote(notePath: string): void {
    const node = this.nodes.get(notePath);
    if (!node) return;

    const resolvedLinks = new Set<string>();
    for (const linkTarget of this.rawOutLinks.get(notePath) ?? node.outLinks) {
      const resolved = this.resolveWikilink(linkTarget);
      if (!resolved) continue;
      resolvedLinks.add(resolved);
      this.nodes.get(resolved)?.inLinks.add(notePath);
    }

    node.outLinks = resolvedLinks;
  }

  /**
   * Register a note's frontmatter aliases so `[[alias]]` resolves to it.
   */
  private indexAliases(
    notePath: string,
    frontmatter: Record<string, unknown>,
  ): void {
    for (const alias of readAliases(frontmatter)) {
      const key = alias.toLowerCase();
      if (this.aliasIndex.get(key) === notePath) continue;
      this.aliasIndex.set(key, notePath);
      this._namesDirty = true;
    }
  }

  /** Drop aliases this note claims, other than those in `keep`. */
  private unindexAliases(
    notePath: string,
    frontmatter: Record<string, unknown>,
    keep: ReadonlySet<string> = new Set(),
  ): void {
    for (const alias of readAliases(frontmatter)) {
      const key = alias.toLowerCase();
      if (keep.has(key) || this.aliasIndex.get(key) !== notePath) continue;
      this.aliasIndex.delete(key);
      this.orphanedAliases.add(key);
      this._namesDirty = true;
    }
  }

  /**
   * Resolve a wikilink target to a note path.
   * Tries: exact path match → title match → filename match → frontmatter alias.
   */
  private resolveWikilink(target: string): string | undefined {
    // Direct path match (e.g., "Customers/Contoso")
    const withExt = target.endsWith(".md") ? target : `${target}.md`;
    if (this.nodes.has(withExt)) return withExt;

    // Title/filename match
    const byTitle = this.titleIndex.get(target.toLowerCase());
    if (byTitle) return byTitle;

    // Frontmatter alias match
    return this.aliasIndex.get(target.toLowerCase());
  }

  // ─── Incremental Updates ────────────────────────────────────────────────

  /**
   * Re-index a single note after it changes on disk.
   */
  async updateNote(notePath: string): Promise<void> {
    await this.updateNotes([notePath]);
  }

  /**
   * Re-index a batch of notes, resolving links once for the whole batch.
   *
   * This used to be one note at a time, and each one triggered a full
   * whole-vault backlink resolve — measured at 85% of the cost of an edit on a
   * 6,000-note vault, and paid again for every file in a burst. A `git pull` or
   * a sync touching 200 notes therefore cost 200 whole-vault resolves.
   *
   * Two things fix that. The batch resolves once rather than once per note; and
   * where the batch has not changed any note's title or filename — an ordinary
   * body edit, which is nearly every edit — only the edited notes' own links can
   * have changed meaning, so the resolve is confined to them. Everyone else's
   * backlinks are left standing rather than cleared and rebuilt.
   */
  async updateNotes(notePaths: readonly string[]): Promise<void> {
    const keys = [...new Set(notePaths.map((p) => normalizeNotePath(p)))];
    if (keys.length === 0) return;

    const parsed = await mapWithConcurrency(keys, IO_CONCURRENCY, (key) => this.readNote(key));

    const touched: string[] = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const note = parsed[i];

      if (!note) {
        // Unreadable or gone: fall back to a plain removal, which also detaches
        // it from every note that linked to it. Deferred, so a batch of them
        // resolves once at the end rather than once apiece.
        this.removeNoteDeferred(key);
        continue;
      }

      // Other notes' links to this one are unaffected by its contents being
      // rewritten, so they are carried across rather than destroyed and
      // rebuilt. Detaching only the *outgoing* half is what makes this cheap.
      const existing = this.nodes.get(key);
      const inherited = existing ? new Set(existing.inLinks) : null;
      if (existing) {
        this.detachOutLinks(key, existing);
        // A renamed note must give up the name it used to answer to. Only when
        // it actually changed, so that the ordinary body edit leaves the epoch
        // untouched and keeps the cheap path.
        const previousTitle = existing.title.toLowerCase();
        if (previousTitle !== note.title.toLowerCase()) {
          this.unindexTitle(previousTitle, key);
        }
        const nextAliases = new Set(
          readAliases(note.frontmatter as Record<string, unknown>).map((a) => a.toLowerCase()),
        );
        this.unindexAliases(key, existing.frontmatter as Record<string, unknown>, nextAliases);
      }

      this.applyNote(note);
      if (inherited) {
        const refreshed = this.nodes.get(key);
        if (refreshed) refreshed.inLinks = inherited;
      }
      touched.push(key);
    }

    if (this._namesDirty) {
      // A name entered or left the index, so links anywhere in the vault may
      // resolve differently now. Nothing less than a full pass is correct.
      this.resolveAllBacklinks();
    } else {
      this.resolveLinksFor(touched);
    }
  }

  /**
   * Detach a note's outgoing links without disturbing its incoming ones.
   *
   * The tag index goes too, since `applyNote` will re-add both from the freshly
   * parsed note.
   */
  private detachOutLinks(notePath: string, node: GraphNode): void {
    for (const targetPath of node.outLinks) {
      this.nodes.get(targetPath)?.inLinks.delete(notePath);
    }
    for (const tag of node.tags) {
      this.tagIndex.get(tag)?.delete(notePath);
    }
  }

  /**
   * Remove a note from the index.
   */
  removeNote(notePath: string): void {
    this.removeNotes([notePath]);
  }

  /**
   * Remove a batch of notes, resolving once for the whole batch.
   *
   * A removal can change what a wikilink points at — it frees the names the
   * note answered to — so it needs the whole-vault pass. Taking it once per
   * batch rather than once per note is what keeps a bulk delete off the
   * O(vault)-per-file path that a burst of edits already avoids.
   */
  removeNotes(notePaths: readonly string[]): void {
    for (const notePath of notePaths) {
      this.removeNoteDeferred(notePath);
    }
    this.settleNameChanges();
  }

  /** Remove without settling names — for callers that resolve once at the end. */
  private removeNoteDeferred(notePath: string): void {
    const key = normalizeNotePath(notePath);
    const node = this.nodes.get(key);
    if (!node) return;
    this.removeNodeInternal(key, node);
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
    this.unindexTitle(title, notePath);
    const fileName = basename(notePath, extname(notePath)).toLowerCase();
    this.unindexTitle(fileName, notePath);
    this.unindexAliases(notePath, node.frontmatter as Record<string, unknown>);
  }

  /**
   * Record a name that a wikilink may resolve through.
   *
   * Routed through here so the epoch can be bumped, which is what tells a
   * single-note update whether it is allowed to take the cheap path: while the
   * set of resolvable names is unchanged, no *other* note's links can have
   * started or stopped resolving, so only the edited note's own links need
   * revisiting.
   */
  private indexTitle(key: string, notePath: string): void {
    if (this.titleIndex.get(key) === notePath) return;
    this.titleIndex.set(key, notePath);
    this._namesDirty = true;
  }

  /** Drop a name, if this note is the one currently claiming it. */
  private unindexTitle(key: string, notePath: string): void {
    if (this.titleIndex.get(key) !== notePath) return;
    this.titleIndex.delete(key);
    // Another note may answer to this name and be waiting to inherit it.
    this.orphanedNames.add(key);
    this._namesDirty = true;
  }

  /**
   * Give away names that a removal or a retitle left unclaimed but which other
   * live notes still answer to.
   *
   * Only one note can own a name, so the index stores the claimant and nothing
   * else. That makes losing the claimant indistinguishable from the name never
   * having existed, and strands every link pointing at it: a rebuild resolves
   * them to the surviving note, while the live index resolved them nowhere and
   * never recovered, because no later edit revisits a name it does not hold.
   *
   * One pass over the vault per batch rather than a search per removal, so a
   * bulk delete costs what a single one does. Notes are visited in insertion
   * order and the last match wins, which is the rule a build from scratch uses;
   * where insertion order has itself drifted from disk order, so does the pick,
   * but only between notes that are equally valid answers to the name.
   */
  private reclaimOrphanedNames(): void {
    const unclaimed = new Set(
      [...this.orphanedNames].filter((name) => !this.titleIndex.has(name)),
    );
    const unclaimedAliases = new Set(
      [...this.orphanedAliases].filter((name) => !this.aliasIndex.has(name)),
    );
    this.orphanedNames.clear();
    this.orphanedAliases.clear();
    if (unclaimed.size === 0 && unclaimedAliases.size === 0) return;

    for (const [notePath, node] of this.nodes) {
      if (unclaimed.size > 0) {
        const title = node.title.toLowerCase();
        if (unclaimed.has(title)) this.indexTitle(title, notePath);
        const fileName = basename(notePath, extname(notePath)).toLowerCase();
        if (fileName !== title && unclaimed.has(fileName)) this.indexTitle(fileName, notePath);
      }
      if (unclaimedAliases.size > 0) {
        for (const alias of readAliases(node.frontmatter as Record<string, unknown>)) {
          const key = alias.toLowerCase();
          if (unclaimedAliases.has(key)) this.aliasIndex.set(key, notePath);
        }
      }
    }
  }

  /** Run the whole-vault resolve an outstanding name change requires. */
  private settleNameChanges(): void {
    if (this._namesDirty) this.resolveAllBacklinks();
  }

  /**
   * Recompute all backlinks from scratch (used after incremental updates).
   */
  private resolveAllBacklinks(): void {
    // Names first: a link cannot resolve through a name no note claims, so
    // re-homing has to happen before anything is resolved against the index.
    this.reclaimOrphanedNames();
    // Clear all backlinks
    for (const node of this.nodes.values()) {
      node.inLinks.clear();
    }
    // Recompute
    this.resolveLinks();
    this._namesDirty = false;
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  /** Every node in its persisted form, in index order. */
  toPersistedNodes(): PersistedGraphNode[] {
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
    return persistedNodes;
  }

  /**
   * Take the notes mutated since the last save. Swapped out rather than
   * cleared afterwards, so an edit landing while a save is in flight stays
   * pending for the next one instead of being forgotten.
   */
  private takePending(): Set<string> {
    const pending = this.unsavedPaths;
    this.unsavedPaths = new Set();
    return pending;
  }

  private restorePending(pending: Set<string>): void {
    for (const path of pending) this.unsavedPaths.add(path);
  }

  /**
   * Save the graph index to disk for fast restart.
   *
   * The layout comes from `options.layout`, else the configured layout; under
   * "auto" it follows whatever is on disk — segmented once a skeleton exists,
   * the single file otherwise. That is re-checked on every save, so a running
   * server follows a migration or a rollback made by another process.
   */
  async saveToDisk(graphIndexFile: string, options: { layout?: PersistedLayout } = {}): Promise<void> {
    this.savesInFlight++;
    const run = this.saveTail.then(() => this.saveNow(graphIndexFile, options));
    this.saveTail = run.catch(() => {});
    try {
      await run;
    } finally {
      this.savesInFlight--;
    }
  }

  private async saveNow(graphIndexFile: string, options: { layout?: PersistedLayout }): Promise<void> {
    const explicit = options.layout ?? (this.layout === "auto" ? undefined : this.layout);
    const layout = explicit ?? (await this.layoutOnDisk(graphIndexFile));
    if (layout === "segmented") {
      await this.saveSegmented(graphIndexFile);
    } else {
      // Only a deliberate choice of the single file clears a segmented layout
      // away; under "auto" the files may belong to a migration in progress.
      await this.saveSingle(graphIndexFile, explicit === "single");
    }
  }

  /** Which layout the vault currently has, judged by whether a skeleton exists. */
  private async layoutOnDisk(graphIndexFile: string): Promise<PersistedLayout> {
    const dir = join(this.vaultPath, segmentDirFor(graphIndexFile));
    return (await skeletonStamp(dir)) !== null ? "segmented" : "single";
  }

  private async saveSingle(graphIndexFile: string, clearSegmented: boolean): Promise<void> {
    const pending = this.takePending();
    const fullPath = join(this.vaultPath, graphIndexFile);
    const data: PersistedGraph = {
      version: 2,
      builtAt: this._lastIndexed.toISOString(),
      nodes: this.toPersistedNodes(),
    };
    const text = JSON.stringify(data);

    // Write-then-rename: a plain writeFile truncates the file first, so a
    // second OIL instance reading concurrently sees partial JSON and discards
    // the index, forcing a full rebuild. Rename is atomic for readers.
    try {
      await writeFileAtomic(fullPath, text);
    } catch (err) {
      this.restorePending(pending);
      throw err;
    }
    this.segState = null;
    this._needsRewrite = false;
    this._lastSave = {
      layout: "single",
      filesWritten: 1,
      bytesWritten: Buffer.byteLength(text),
      segmentsWritten: 0,
      segmentsTotal: 0,
    };
    await sweepStaleTemps(fullPath);
    await this.removeConflictCopies(graphIndexFile);
    if (clearSegmented) await this.removeSegmentedLayout(graphIndexFile);
    console.error(`[OIL] Graph index saved: ${data.nodes.length} nodes.`);
  }

  /**
   * Split the index into skeleton nodes and per-segment bulk.
   * Synchronous, so the result is one consistent snapshot.
   */
  private groupForSegments(): {
    skeletonNodes: SkeletonNode[];
    groups: Map<string, SegmentNote[]>;
    keyOf: Map<string, string>;
  } {
    const skeletonNodes: SkeletonNode[] = [];
    const groups = new Map<string, SegmentNote[]>();
    const keyOf = new Map<string, string>();
    for (const [path, node] of this.nodes) {
      const key = segmentKeyFor(path, node.frontmatter, this.segmentPolicy);
      keyOf.set(path, key);
      skeletonNodes.push({
        path,
        title: node.title,
        tags: node.tags,
        rawOutLinks: this.rawOutLinks.get(path) ?? [],
        lastModified: this.fileMtimes.get(path) ?? 0,
        segment: key,
        frontmatter: skeletonFrontmatter(node.frontmatter, this.segmentPolicy),
      });
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push({
        path,
        headings: node.headings,
        bodySnippet: node.bodySnippet ?? "",
        frontmatter: node.frontmatter,
      });
    }
    return { skeletonNodes, groups, keyOf };
  }

  /**
   * Save as a skeleton plus segments, rewriting only segments whose notes
   * changed since the last save this process made (or loaded).
   */
  private async saveSegmented(graphIndexFile: string): Promise<void> {
    const dir = join(this.vaultPath, segmentDirFor(graphIndexFile));
    const policyJson = JSON.stringify(this.segmentPolicy);
    // Awaited before the snapshot below. From taking the pending set to
    // serializing, nothing may yield: an edit landing in between could reach
    // the skeleton (with its new mtime) but not its segment, if that segment
    // was otherwise clean — and the mtime would then hide the stale body.
    const stampOnDisk = await skeletonStamp(dir);
    const base = this.segState?.dir === dir ? this.segState : null;
    // Reuse is safe only against the very skeleton this process last wrote or
    // read; after another process has saved, every segment is rewritten.
    const prev =
      base && stampOnDisk !== null && base.stamp === stampOnDisk && base.policyJson === policyJson ? base : null;

    const pending = this.takePending();
    const { skeletonNodes, groups, keyOf } = this.groupForSegments();

    const dirty = new Set<string>();
    if (prev) {
      for (const path of pending) {
        const before = prev.keyOf.get(path);
        if (before !== undefined) dirty.add(before);
        const after = keyOf.get(path);
        if (after !== undefined) dirty.add(after);
      }
      for (const key of prev.forceDirty) dirty.add(key);
      for (const [key, notes] of groups) {
        if (prev.segments.get(key)?.notes !== notes.length) dirty.add(key);
      }
    }

    const generation = newGeneration();
    const segments = new Map<string, SegmentMeta>();
    const writes: Array<{ file: string; text: string }> = [];
    for (const [key, notes] of groups) {
      const old = prev?.segments.get(key);
      if (old && !dirty.has(key)) {
        segments.set(key, old);
        continue;
      }
      const notesJson = JSON.stringify(notes);
      const hash = sha1(notesJson);
      if (old && old.hash === hash && !prev!.forceDirty.has(key)) {
        segments.set(key, old);
        continue;
      }
      const file = segmentFileName(key, generation);
      const text = segmentPayload(key, generation, notesJson);
      segments.set(key, { file, generation, hash, notes: notes.length, bytes: Buffer.byteLength(text) });
      writes.push({ file, text });
    }
    const skeleton: PersistedSkeleton = {
      format: SEGMENTED_FORMAT,
      version: SEGMENTED_VERSION,
      builtAt: this._lastIndexed.toISOString(),
      policy: this.segmentPolicy,
      segments: Object.fromEntries(segments),
      nodes: skeletonNodes,
    };
    const skeletonText = JSON.stringify(skeleton);

    let stamp: string;
    try {
      // Not recursive: a vault directory that has gone away should fail the
      // save, not be recreated around the index.
      await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      await mapWithConcurrency(writes, SEGMENT_IO_CONCURRENCY, (w) => writeFileAtomic(join(dir, w.file), w.text));
      // The commit point: until this rename lands, readers see the old skeleton.
      stamp = await writeFileAtomic(join(dir, SKELETON_FILE), skeletonText);
    } catch (err) {
      this.restorePending(pending);
      // Nothing references this generation; the old skeleton is still whole.
      await Promise.all(writes.map((w) => unlink(join(dir, w.file)).catch(() => {})));
      throw err;
    }

    const referenced = new Set([...segments.values()].map((meta) => meta.file));
    if (base) {
      const superseded = [...base.segments.values()].filter((meta) => !referenced.has(meta.file));
      await Promise.all(superseded.map((meta) => unlink(join(dir, meta.file)).catch(() => {})));
    }
    this.segState = { dir, stamp, policyJson, keyOf, segments, forceDirty: new Set() };
    this._needsRewrite = false;
    const segmentBytes = writes.reduce((sum, w) => sum + Buffer.byteLength(w.text), 0);
    this._lastSave = {
      layout: "segmented",
      filesWritten: writes.length + 1,
      bytesWritten: segmentBytes + Buffer.byteLength(skeletonText),
      segmentsWritten: writes.length,
      segmentsTotal: segments.size,
    };
    await this.removeConflictCopies(graphIndexFile);
    console.error(
      `[OIL] Graph index saved: ${skeletonNodes.length} nodes ` +
        `(segmented: ${writes.length}/${segments.size} segments rewritten).`,
    );
  }

  /** What a segmented save would write, without writing anything. */
  planSegmentedLayout(): SegmentedLayoutPlan {
    const { skeletonNodes, groups } = this.groupForSegments();
    const generation = "0";
    const segments: SegmentedLayoutPlan["segments"] = [];
    const metas: Record<string, SegmentMeta> = {};
    for (const [key, notes] of groups) {
      const notesJson = JSON.stringify(notes);
      const text = segmentPayload(key, generation, notesJson);
      const bytes = Buffer.byteLength(text);
      const file = segmentFileName(key, generation);
      segments.push({ key, notes: notes.length, bytes });
      metas[key] = { file, generation, hash: sha1(notesJson), notes: notes.length, bytes };
    }
    const skeleton: PersistedSkeleton = {
      format: SEGMENTED_FORMAT,
      version: SEGMENTED_VERSION,
      builtAt: this._lastIndexed.toISOString(),
      policy: this.segmentPolicy,
      segments: metas,
      nodes: skeletonNodes,
    };
    segments.sort((a, b) => a.key.localeCompare(b.key));
    return { skeletonBytes: Buffer.byteLength(JSON.stringify(skeleton)), segments };
  }

  /**
   * Delete the segmented layout for `graphIndexFile`, skeleton first.
   * Returns the number of files removed.
   */
  async removeSegmentedLayout(graphIndexFile: string): Promise<number> {
    const dir = join(this.vaultPath, segmentDirFor(graphIndexFile));
    if (this.segState?.dir === dir) this.segState = null;
    return removeSegmentFiles(dir);
  }

  /**
   * Delete sync-conflict copies of the persisted graph.
   *
   * The graph is derived entirely from the notes and revalidated against them
   * on every start, so a forked copy holds nothing the canonical file cannot
   * recover — it is only bloat. A candidate is removed only once it parses as a
   * graph index, so a user file that merely shares the name is left alone.
   *
   * With a segmented layout in use, stray files in its directory — superseded
   * segments, temp files, conflict copies of the skeleton — are cleared too.
   */
  async removeConflictCopies(graphIndexFile: string): Promise<number> {
    const copies = await findConflictCopies(join(this.vaultPath, graphIndexFile));
    const ours: string[] = [];
    for (const copy of copies) {
      try {
        const data = JSON.parse(await readFile(copy, "utf-8")) as Partial<PersistedGraph>;
        if (typeof data.version === "number" && Array.isArray(data.nodes)) ours.push(copy);
      } catch {
        // Not ours, or unreadable — leave it.
      }
    }
    const removed = await removeFiles(ours);
    if (removed > 0) {
      console.error(`[OIL] Removed ${removed} sync-conflict cop${removed === 1 ? "y" : "ies"} of the graph index.`);
    }
    const seg = this.segState;
    if (seg && seg.dir === join(this.vaultPath, segmentDirFor(graphIndexFile))) {
      // Only while the skeleton on disk is the one `seg` describes: after
      // another process has saved, files it references would look like strays.
      if (seg.stamp !== null && (await skeletonStamp(seg.dir)) === seg.stamp) {
        const referenced = new Set([...seg.segments.values()].map((meta) => meta.file));
        await sweepSegmentDir(seg.dir, referenced);
      }
    }
    return removed;
  }

  /**
   * Replace the in-memory index with persisted nodes.
   *
   * Titles are indexed last-wins in the given order, exactly as the single
   * file has always loaded, so both layouts resolve an ambiguous name alike.
   */
  private hydrateFrom(nodes: readonly PersistedGraphNode[], builtAt: string, layout: PersistedLayout): void {
    this._version++;
    this.nodes.clear();
    this.tagIndex.clear();
    this.titleIndex.clear();
    this.aliasIndex.clear();
    this.rawOutLinks.clear();
    this.fileMtimes.clear();
    this.resetMutationLog();

    for (const pn of nodes) {
      // Re-normalize: an index saved by an older release may hold targets
      // the current parser no longer produces (e.g. a table link's `\`).
      const rawLinks = Array.isArray(pn.rawOutLinks)
        ? [...new Set(pn.rawOutLinks.map(normalizeWikilinkTarget).filter(Boolean))]
        : pn.rawOutLinks;
      const node: GraphNode = {
        path: pn.path,
        title: pn.title,
        tags: pn.tags,
        headings: pn.headings ?? [],
        bodySnippet: pn.bodySnippet ?? "",
        frontmatter: pn.frontmatter,
        outLinks: new Set(rawLinks), // Will be resolved below
        inLinks: new Set(),
      };

      this.nodes.set(pn.path, node);
      this.rawOutLinks.set(pn.path, rawLinks);
      this.fileMtimes.set(pn.path, pn.lastModified);
      this.titleIndex.set(pn.title.toLowerCase(), pn.path);
      const fileName = basename(pn.path, extname(pn.path));
      this.titleIndex.set(fileName.toLowerCase(), pn.path);
      this.indexAliases(pn.path, pn.frontmatter as Record<string, unknown>);

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
    this.orphanedNames.clear();
    this.orphanedAliases.clear();
    this._namesDirty = false;

    this.unsavedPaths.clear();
    this._needsRewrite = false;
    this.segState = null;
    this._segmentHealth = null;
    this._loadedLayout = layout;
    this._lastIndexed = new Date(builtAt);
  }

  /** Load the single `_oil-graph.json` (v1/v2). */
  private async loadSingle(graphIndexFile: string): Promise<LoadStatus> {
    try {
      const fullPath = join(this.vaultPath, graphIndexFile);
      const raw = await readFile(fullPath, "utf-8");
      const data: PersistedGraph = JSON.parse(raw);

      if (data.version !== 1 && data.version !== 2) {
        console.error("[OIL] Graph index version mismatch, will rebuild.");
        return "invalid";
      }

      // Validate persisted shape before trusting it
      if (!Array.isArray(data.nodes)) {
        console.error("[OIL] Graph index corrupt: nodes is not an array, will rebuild.");
        return "invalid";
      }
      for (const pn of data.nodes) {
        if (typeof pn.path !== "string" || typeof pn.title !== "string" || !Array.isArray(pn.tags)) {
          console.error("[OIL] Graph index corrupt: invalid node shape, will rebuild.");
          return "invalid";
        }
      }

      this.hydrateFrom(data.nodes, data.builtAt, "single");
      console.error(`[OIL] Graph index loaded from disk: ${this.nodes.size} nodes.`);
      // Startup is the reliable moment to clear temp files from a killed save;
      // a read-only session may never write.
      await sweepStaleTemps(fullPath);
      return "ok";
    } catch (err) {
      // A missing index is the normal first-run case; anything else is a
      // silent downgrade to a full rebuild and worth naming.
      //
      // This says "corrupt" and "rebuild" because its three siblings above do,
      // and an operator scanning startup logs for a discarded index should not
      // have to know which of four failure modes they hit to find the line. A
      // truncated file lands here rather than on the shape checks, and the
      // earlier wording ("unreadable ... falling back to full build") shared no
      // vocabulary with them — enough to convince a reader the case logged
      // nothing at all.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      console.error(
        `[OIL] Graph index corrupt or unreadable (${code ?? (err as Error).message}) — will rebuild.`,
      );
      return "invalid";
    }
  }

  /**
   * Load a segmented index: the skeleton, then every segment it names.
   *
   * A segment that cannot be read does not fail the load. Its notes come back
   * from the skeleton alone — title, tags, links and aliases intact, body and
   * headings empty — with mtime 0, so the next revalidation re-reads them from
   * the vault and the next save rewrites the segment.
   */
  private async loadSegmented(graphIndexFile: string): Promise<LoadStatus> {
    const dir = join(this.vaultPath, segmentDirFor(graphIndexFile));
    // Stamped before reading: if the skeleton is replaced in between, the
    // stamp is the older one, so the next save rewrites in full rather than
    // trusting a state that describes neither.
    const stamp = await skeletonStamp(dir);
    const result = await readSkeleton(dir);
    if (result.status === "missing") return "missing";
    if (result.status === "invalid") {
      console.error(`[OIL] Graph index corrupt (segmented skeleton: ${result.reason}) — will rebuild.`);
      return "invalid";
    }
    const skeleton = result.skeleton;

    const keys = Object.keys(skeleton.segments);
    const loaded = await mapWithConcurrency(keys, SEGMENT_IO_CONCURRENCY, (key) =>
      readSegment(dir, key, skeleton.segments[key]),
    );
    const contents = new Map<string, Map<string, SegmentNote>>();
    const damaged = new Set<string>();
    keys.forEach((key, i) => {
      const notes = loaded[i];
      if (notes) contents.set(key, new Map(notes.map((note) => [note.path, note])));
      else damaged.add(key);
    });

    let recovered = 0;
    const nodes: PersistedGraphNode[] = skeleton.nodes.map((sk) => {
      const full = contents.get(sk.segment)?.get(sk.path);
      if (!full) {
        recovered++;
        damaged.add(sk.segment);
        return {
          path: sk.path,
          title: sk.title,
          tags: sk.tags,
          headings: [],
          bodySnippet: "",
          frontmatter: sk.frontmatter,
          rawOutLinks: sk.rawOutLinks,
          lastModified: 0,
        };
      }
      return {
        path: sk.path,
        title: sk.title,
        tags: sk.tags,
        headings: full.headings,
        bodySnippet: full.bodySnippet,
        frontmatter: full.frontmatter,
        rawOutLinks: sk.rawOutLinks,
        lastModified: sk.lastModified,
      };
    });

    this.hydrateFrom(nodes, skeleton.builtAt, "segmented");
    const policyJson = JSON.stringify(skeleton.policy);
    this.segState = {
      dir,
      stamp,
      policyJson,
      keyOf: new Map(skeleton.nodes.map((sk) => [sk.path, sk.segment])),
      segments: new Map(Object.entries(skeleton.segments)),
      forceDirty: new Set(damaged),
    };
    this._segmentHealth = {
      segments: keys.length,
      damagedSegments: [...damaged].sort(),
      recoveredNotes: recovered,
    };
    // Damage is repaired, and a changed grouping policy applied, by the next save.
    if (damaged.size > 0 || policyJson !== JSON.stringify(this.segmentPolicy)) this._needsRewrite = true;

    console.error(
      `[OIL] Graph index loaded from disk: ${this.nodes.size} nodes (segmented, ${keys.length} segments).`,
    );
    if (damaged.size > 0) {
      console.error(
        `[OIL] Graph index: ${damaged.size} segment(s) damaged — ${recovered} note(s) will be re-read from the vault.`,
      );
    }
    await sweepSegmentDir(dir, new Set(), { tempsOnly: true });
    return "ok";
  }

  /**
   * Load the graph index from disk. Returns true if loaded successfully.
   *
   * Prefers the segmented layout and falls back to the single file (the other
   * way round when configured for "single"). Loading anything other than the
   * configured layout, or falling back past a damaged one, marks the index
   * dirty so the next save converts or repairs it.
   */
  async loadFromDisk(graphIndexFile: string): Promise<boolean> {
    const order: PersistedLayout[] = this.layout === "single" ? ["single", "segmented"] : ["segmented", "single"];
    let fellBack = false;
    for (const which of order) {
      const status = await this.loadOne(graphIndexFile, which);
      if (status === "ok") {
        if (fellBack || (this.layout !== "auto" && this.layout !== which)) this._needsRewrite = true;
        return true;
      }
      if (status === "invalid") fellBack = true;
    }
    return false;
  }

  /** Load one specific layout, ignoring the other. Returns true if loaded. */
  async loadLayout(graphIndexFile: string, which: PersistedLayout): Promise<boolean> {
    return (await this.loadOne(graphIndexFile, which)) === "ok";
  }

  private loadOne(graphIndexFile: string, which: PersistedLayout): Promise<LoadStatus> {
    return which === "segmented" ? this.loadSegmented(graphIndexFile) : this.loadSingle(graphIndexFile);
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
          this.removeNoteDeferred(path);
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
        return cachedMtime === undefined || !sameMtime(currentMtime, cachedMtime);
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
          this.removeNoteDeferred(batch[i]);
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
        if (this._needsRewrite) {
          // Loaded past a damaged layout, or from a layout other than the
          // configured one: nothing changed in the vault, but disk wants fixing.
          await this.saveToDisk(graphIndexFile);
        } else {
          await this.removeConflictCopies(graphIndexFile);
        }
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
   * Wikilink targets that resolve to no note, paired with the note that wrote
   * them. Runs the graph's own resolver, so anything reported here is exactly a
   * link the graph could not follow — the report cannot drift from reality.
   *
   * Attachment embeds (`![[chart.png]]`) are skipped: the graph only indexes
   * markdown, so a non-markdown target is a file reference, not a broken link.
   */
  getBrokenLinks(): BrokenLink[] {
    const broken: BrokenLink[] = [];
    for (const [path, targets] of this.rawOutLinks) {
      for (const target of targets) {
        if (isAttachmentTarget(target)) continue;
        if (this.resolveWikilink(target)) continue;
        broken.push({ path, target });
      }
    }
    return broken;
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
