/**
 * OIL — Semantic Embedding Engine (Phase 4)
 * Optional Tier 3 search using @xenova/transformers local embeddings.
 * Vector index persisted to _oil-index.json for fast startup.
 *
 * Install for semantic search: npm install @xenova/transformers
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIndex } from "./graph.js";
import type { SearchResult } from "./types.js";
import { readNote } from "./vault.js";
import type { SearchFilters } from "./search.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIMENSION = 384;
const MAX_TEXT_LENGTH = 500;
const SAVE_DEBOUNCE_MS = 5_000;

// Variable import avoids TypeScript module resolution at compile time.
// The module is loaded dynamically at runtime only when needed.
const TRANSFORMERS_MODULE = "@xenova/transformers";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VectorEntry {
  path: string;
  embedding: number[];
  lastModified: number;
}

interface PersistedIndex {
  model: string;
  dimension: number;
  builtAt: string;
  entries: VectorEntry[];
}

// ─── Embedding Index ──────────────────────────────────────────────────────────

export class EmbeddingIndex {
  private entries = new Map<string, VectorEntry>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractor: any = null;
  private _available: boolean | null = null;
  private initialized = false;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private vaultPath: string,
    private indexFile: string,
    private graph: GraphIndex,
  ) {}

  // ─── Availability ──────────────────────────────────────────────────────

  /** Check if @xenova/transformers is installed and importable. */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      await import(TRANSFORMERS_MODULE);
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  // ─── Lazy Initialisation ───────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!(await this.isAvailable())) return;

    const loaded = await this.loadFromDisk();
    if (!loaded) {
      await this.buildFull();
    }
    this.initialized = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    const mod = await import(TRANSFORMERS_MODULE);
    console.error(`[OIL] Loading embedding model (${MODEL_ID})...`);
    this.extractor = await mod.pipeline("feature-extraction", MODEL_ID);
    console.error("[OIL] Embedding model loaded.");
    return this.extractor;
  }

  // ─── Embedding Generation ──────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }

  // ─── Index Build / Load ────────────────────────────────────────────────

  private async loadFromDisk(): Promise<boolean> {
    try {
      const indexPath = join(this.vaultPath, this.indexFile);
      const raw = await readFile(indexPath, "utf-8");
      const data: PersistedIndex = JSON.parse(raw);

      if (data.model !== MODEL_ID || data.dimension !== DIMENSION) {
        console.error("[OIL] Embedding index model mismatch, rebuilding.");
        return false;
      }

      // Validate persisted shape before trusting it
      if (!Array.isArray(data.entries)) {
        console.error("[OIL] Embedding index corrupt: entries is not an array, rebuilding.");
        return false;
      }
      for (const entry of data.entries) {
        if (
          typeof entry.path !== "string" ||
          !Array.isArray(entry.embedding) ||
          typeof entry.lastModified !== "number"
        ) {
          console.error("[OIL] Embedding index corrupt: invalid entry shape, rebuilding.");
          return false;
        }
      }

      for (const entry of data.entries) {
        if (this.graph.getNode(entry.path)) {
          this.entries.set(entry.path, entry);
        }
      }

      // Backfill notes that are in the graph but not in the index
      const allNotes = this.graph.getNotesByFolder("");
      let missing = 0;
      for (const ref of allNotes) {
        if (!this.entries.has(ref.path)) missing++;
      }

      if (missing > 0) {
        console.error(
          `[OIL] Embedding index loaded (${this.entries.size} cached, ${missing} need embedding).`,
        );
        await this.backfillMissing();
      } else {
        console.error(`[OIL] Embedding index loaded: ${this.entries.size} entries.`);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async buildFull(): Promise<void> {
    console.error("[OIL] Building embedding index from scratch...");
    const notes = this.graph.getNotesByFolder("");
    let count = 0;

    for (const ref of notes) {
      try {
        const parsed = await readNote(this.vaultPath, ref.path);
        const node = this.graph.getNode(ref.path);
        const text = prepareNoteText(
          node?.title ?? ref.title,
          node?.tags ?? ref.tags,
          parsed.content,
        );
        const embedding = await this.embed(text);

        this.entries.set(ref.path, {
          path: ref.path,
          embedding,
          lastModified: Date.now(),
        });

        count++;
        if (count % 50 === 0) {
          console.error(`[OIL] Embedded ${count}/${notes.length} notes...`);
        }
      } catch {
        continue;
      }
    }

    this.dirty = true;
    await this.save();
    console.error(`[OIL] Embedding index built: ${count} notes.`);
  }

  private async backfillMissing(): Promise<void> {
    const notes = this.graph.getNotesByFolder("");
    let added = 0;

    for (const ref of notes) {
      if (this.entries.has(ref.path)) continue;

      try {
        const parsed = await readNote(this.vaultPath, ref.path);
        const node = this.graph.getNode(ref.path);
        const text = prepareNoteText(
          node?.title ?? ref.title,
          node?.tags ?? ref.tags,
          parsed.content,
        );
        const embedding = await this.embed(text);

        this.entries.set(ref.path, {
          path: ref.path,
          embedding,
          lastModified: Date.now(),
        });
        added++;
      } catch {
        continue;
      }
    }

    if (added > 0) {
      this.dirty = true;
      await this.save();
      console.error(`[OIL] Backfilled ${added} new embeddings.`);
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────

  /** Semantic search: embed query, compare against all indexed notes. */
  async search(
    query: string,
    topK: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (this.entries.size === 0) return [];

    const queryEmbedding = await this.embed(query);
    const scored: { path: string; score: number }[] = [];

    for (const [path, entry] of this.entries) {
      if (filters?.folder && !path.startsWith(filters.folder)) continue;

      if (filters?.tags?.length) {
        const node = this.graph.getNode(path);
        if (!node || !filters.tags.some((t) => node.tags.includes(t))) continue;
      }

      if (filters?.frontmatter) {
        const node = this.graph.getNode(path);
        if (!node) continue;
        const match = Object.entries(filters.frontmatter).every(
          ([k, v]) => node.frontmatter[k] === v,
        );
        if (!match) continue;
      }

      const score = dotProduct(queryEmbedding, entry.embedding);
      scored.push({ path, score });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map((s) => {
      const node = this.graph.getNode(s.path);
      return {
        path: s.path,
        title: node?.title ?? s.path,
        excerpt: node?.tags.join(", ") ?? "",
        score: Math.round(s.score * 1000) / 1000,
        matchType: "semantic" as const,
      };
    });
  }

  /** Find notes most similar to a given note by embedding distance. */
  async findSimilar(
    notePath: string,
    topK: number,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    const entry = this.entries.get(notePath);
    if (!entry) return [];

    const scored: { path: string; score: number }[] = [];
    for (const [path, other] of this.entries) {
      if (path === notePath) continue;
      const score = dotProduct(entry.embedding, other.embedding);
      scored.push({ path, score });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map((s) => {
      const node = this.graph.getNode(s.path);
      return {
        path: s.path,
        title: node?.title ?? s.path,
        excerpt: node?.tags.join(", ") ?? "",
        score: Math.round(s.score * 1000) / 1000,
        matchType: "semantic" as const,
      };
    });
  }

  // ─── Incremental Updates ───────────────────────────────────────────────

  /** Re-embed a note after it changes on disk. */
  async updateNote(notePath: string): Promise<void> {
    if (!(await this.isAvailable())) return;
    if (!this.initialized) return; // Don't trigger full init from watcher

    const node = this.graph.getNode(notePath);
    if (!node) return;

    try {
      const parsed = await readNote(this.vaultPath, notePath);
      const text = prepareNoteText(node.title, node.tags, parsed.content);
      const embedding = await this.embed(text);

      this.entries.set(notePath, {
        path: notePath,
        embedding,
        lastModified: Date.now(),
      });

      this.scheduleSave();
    } catch {
      // Fail silently — embedding update is non-critical
    }
  }

  /** Remove a note from the embedding index. */
  removeNote(notePath: string): void {
    if (this.entries.delete(notePath)) {
      this.scheduleSave();
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /** Save the index to disk. */
  async save(): Promise<void> {
    if (this.entries.size === 0) return;

    const data: PersistedIndex = {
      model: MODEL_ID,
      dimension: DIMENSION,
      builtAt: new Date().toISOString(),
      entries: [...this.entries.values()],
    };

    const indexPath = join(this.vaultPath, this.indexFile);
    await writeFile(indexPath, JSON.stringify(data), "utf-8");
    this.dirty = false;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save().catch((err) => {
        console.error('[OIL] Scheduled embedding index save failed:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a concise text representation of a note for embedding. */
function prepareNoteText(
  title: string,
  tags: string[],
  content: string,
): string {
  const parts: string[] = [title];
  if (tags.length > 0) parts.push(tags.join(", "));
  parts.push(content.slice(0, MAX_TEXT_LENGTH));
  return parts.join("\n");
}

/** Dot product of two vectors (= cosine similarity when both are normalised). */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
