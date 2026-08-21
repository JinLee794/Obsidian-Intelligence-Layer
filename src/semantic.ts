/**
 * OIL — Semantic tier
 *
 * Note-level embeddings served by a local Ollama instance.
 *
 * Deliberately dependency-free: HTTP over loopback through global `fetch`,
 * brute-force cosine over an in-memory `Float32Array` map, and a base64 sidecar
 * for restart. No native module, no build step, no vector database — measured at
 * 768 dimensions, ranking 50k notes costs tens of milliseconds and the whole
 * index fits in a few hundred MB, well below the point where an ANN structure
 * starts paying for its own complexity.
 *
 * The tier is optional by construction. If Ollama is not running, every entry
 * point degrades to a no-op and the cascade falls back to its lexical tiers, so
 * an install that never touches Ollama behaves exactly as it did before.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIndex } from "./graph.js";
import { flattenFrontmatter } from "./frontmatter.js";
import { describeSemanticDisabledBy } from "./config.js";
import type { ConfigSource, NoteFrontmatter, SemanticConfig } from "./types.js";

/** Sidecar format version. Bump to force a full re-embed. */
const INDEX_VERSION = 1;

/**
 * Characters of body text fed to the embedder per note.
 *
 * Embedding models compress a fixed context into one vector, so feeding a whole
 * note dilutes its topic rather than describing it better. The lead of an
 * Obsidian note — frontmatter, title, first headings — is where the topic lives.
 */
const BODY_BUDGET = 1500;

/** Query vectors are cached so a repeated search costs no round trip. */
const QUERY_CACHE_SIZE = 64;

export type SemanticStatus =
  | "disabled"
  | "cold"
  | "indexing"
  | "ready"
  | "unavailable";

export interface SemanticHit {
  path: string;
  /** Cosine similarity in [-1, 1]; normalised vectors make this a dot product. */
  score: number;
}

export interface SemanticStats {
  status: SemanticStatus;
  model: string;
  note_count: number;
  dimensions: number;
  /** Why the tier is not serving, when it isn't. */
  reason: string | null;
}

/**
 * Count of times this process degraded to a lexical answer because the embedder
 * failed, rather than because there was nothing to find.
 *
 * At runtime the two are deliberately indistinguishable — an unreachable Ollama
 * must not break a user's search. But a *measurement* cannot afford that: a
 * timed-out embedding scored as "the semantic tier found nothing" turns an
 * environmental failure into what reads as a quality number. Counting the
 * failures separately is what lets the eval harness tell them apart and refuse
 * to publish a score, while leaving the served behaviour exactly as it was.
 */
export interface SemanticDegradation {
  /** Query embeddings that failed. Each one silently cost a tier. */
  queryFailures: number;
  /** Index refreshes that failed, leaving vectors stale or absent. */
  indexFailures: number;
  /** The most recent failure's description, or null if there has been none. */
  lastReason: string | null;
}

interface Entry {
  /** Hash of the embedded text — the unit of change detection. */
  hash: string;
  vector: Float32Array;
}

interface PersistedIndex {
  version: number;
  model: string;
  dimensions: number;
  entries: Record<string, { hash: string; vector: string }>;
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

/**
 * Scale to unit length so cosine similarity reduces to a dot product, which
 * removes a square root and two accumulations from the inner ranking loop.
 */
function normalize(values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i];
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  }
  return vector;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString(
    "base64",
  );
}

/**
 * Decode through a fresh ArrayBuffer: `Buffer.from(base64)` may land on a
 * pooled, unaligned offset, and `Float32Array` requires 4-byte alignment.
 * The encoding is host-endian, which is safe because the sidecar never leaves
 * the machine that wrote it — and a mismatch only costs one re-embed.
 */
function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 22);
}

/**
 * Node's fetch reports every transport failure as a bare "fetch failed" and puts
 * the useful part on `cause`. This string reaches users through `get_health` and
 * search responses, so "ECONNREFUSED" versus "ENOTFOUND" is worth keeping.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

/**
 * Frontmatter values that describe plumbing rather than meaning. Identifiers,
 * links and timestamps are precisely what the lexical tiers are good at, and in
 * vector space they are noise that crowds out the fields a person would search.
 */
const NOISE_VALUE = /^(https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\d{4}-\d{2}-\d{2}T\d{2}:)/i;
const NOISE_KEY = /(^|\.)(id|.*id|timestamp|generated|sources|resource|icon|sticker|.*link|.*sync|last_validated)$/i;
/** Frontmatter share of the budget, so structured notes keep room for prose. */
const FRONTMATTER_BUDGET = 600;

/**
 * Strip generated scaffolding from a note body.
 *
 * Vaults synced from a CRM or driven by dataview carry bodies that are mostly
 * query blocks and HTML comments, identical across every note of a type. Left
 * in, they consume the encoder's budget and make unrelated records look alike:
 * measured on one such vault, every customer note sat at ~0.89 cosine to every
 * other, and paraphrase retrieval found 1 of 5 target notes.
 */
function stripScaffolding(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*\|[-\s|:]+\|\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The text that represents a note in vector space.
 *
 * Title and tags lead because they are the note's own statement of what it is
 * about, and a lead-weighted document beats a raw dump when the encoder only
 * sees a couple of thousand characters. Frontmatter follows: in a structured
 * vault, fields like `customer`, `status` and `owner` carry the meaning that
 * prose would otherwise hold, and embedding the body alone misses it entirely.
 */
function embeddingText(node: {
  title: string;
  tags: string[];
  headings: string[];
  bodySnippet: string;
  frontmatter?: NoteFrontmatter;
}): string {
  const parts = [node.title];
  if (node.tags.length > 0) parts.push(node.tags.join(", "));

  const fields: string[] = [];
  let fieldChars = 0;
  for (const field of flattenFrontmatter(node.frontmatter)) {
    if (NOISE_KEY.test(field.key) || NOISE_VALUE.test(field.value)) continue;
    const rendered = `${field.key}: ${field.value}`;
    if (fieldChars + rendered.length > FRONTMATTER_BUDGET) break;
    fields.push(rendered);
    fieldChars += rendered.length;
  }
  if (fields.length > 0) parts.push(fields.join("; "));

  if (node.headings.length > 0) parts.push(node.headings.join(" · "));

  const body = stripScaffolding(node.bodySnippet);
  if (body) parts.push(body.slice(0, BODY_BUDGET));
  return parts.join("\n");
}

// ─── Semantic index ───────────────────────────────────────────────────────────

export class SemanticIndex {
  private readonly vaultPath: string;
  private readonly config: SemanticConfig;
  private readonly endpoint: string;

  private vectors = new Map<string, Entry>();
  private queryCache = new Map<string, Float32Array>();

  private state: SemanticStatus;
  private reason: string | null = null;
  private dimensions = 0;

  /** Failures that were absorbed into a graceful degradation. */
  private queryFailures = 0;
  private indexFailures = 0;
  private lastFailureReason: string | null = null;

  /** Graph version the vectors were last reconciled against. */
  private indexedVersion = -1;
  /** In-flight refresh, so concurrent triggers coalesce instead of stacking. */
  private refreshing: Promise<void> | null = null;
  private modelPulled = false;
  /** True once Ollama has actually answered this process. */
  private verified = false;

  constructor(vaultPath: string, config: SemanticConfig, enabledSource?: ConfigSource) {
    this.vaultPath = vaultPath;
    this.config = config;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.state = config.enabled ? "cold" : "disabled";
    // Name the layer that actually turned the tier off. Reporting a file that
    // may not exist sends whoever is debugging this to the wrong place.
    if (!config.enabled) this.reason = describeSemanticDisabledBy(enabledSource);
  }

  get status(): SemanticStatus {
    return this.state;
  }

  get stats(): SemanticStats {
    return {
      status: this.state,
      model: this.config.model,
      note_count: this.vectors.size,
      dimensions: this.dimensions,
      reason: this.reason,
    };
  }

  /**
   * Failures this process swallowed to keep serving.
   *
   * Monotonic for the life of the index, so a caller can snapshot it around a
   * search and know whether that particular answer was a real one.
   */
  get degradation(): SemanticDegradation {
    return {
      queryFailures: this.queryFailures,
      indexFailures: this.indexFailures,
      lastReason: this.lastFailureReason,
    };
  }

  private get indexPath(): string {
    return join(this.vaultPath, this.config.indexFile);
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load the sidecar written by a previous run.
   *
   * A different model produces a different vector space, so a model change
   * discards everything rather than silently ranking against mixed embeddings.
   */
  async load(): Promise<void> {
    if (this.state === "disabled") return;
    try {
      const parsed = JSON.parse(
        await readFile(this.indexPath, "utf-8"),
      ) as PersistedIndex;

      if (
        parsed.version !== INDEX_VERSION ||
        parsed.model !== this.config.model ||
        !parsed.entries
      ) {
        return;
      }

      for (const [path, entry] of Object.entries(parsed.entries)) {
        this.vectors.set(path, { hash: entry.hash, vector: decodeVector(entry.vector) });
      }
      this.dimensions = parsed.dimensions;
    } catch {
      // No sidecar, or an unreadable one — the next refresh rebuilds it.
    }
  }

  private async save(): Promise<void> {
    const entries: PersistedIndex["entries"] = {};
    for (const [path, entry] of this.vectors) {
      entries[path] = { hash: entry.hash, vector: encodeVector(entry.vector) };
    }
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      model: this.config.model,
      dimensions: this.dimensions,
      entries,
    };

    // Unique per save, not just per process: two indexes over the same vault in
    // one process would otherwise race for the same temp path, and the loser's
    // rename fails with ENOENT after the winner has already moved the file.
    const tempPath = `${this.indexPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(payload), "utf-8");
      try {
        await rename(tempPath, this.indexPath);
      } catch (err) {
        // On Windows a scanner or search indexer can hold the destination open
        // for a moment after it is written, which surfaces as EPERM/EBUSY.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await rename(tempPath, this.indexPath);
      }
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      console.error("[OIL] Semantic: failed to persist vector index:", err);
    }
  }

  // ── Ollama transport ────────────────────────────────────────────────────

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  }

  /**
   * Fetch the model on first use so a fresh install needs nothing but Ollama
   * itself. Runs in the background refresh, so the download never blocks a tool
   * call — searches simply skip the tier until it completes.
   */
  private async pullModel(): Promise<void> {
    console.error(
      `[OIL] Semantic: pulling embedding model '${this.config.model}' — first run, this can take a few minutes.`,
    );
    const res = await this.post("/api/pull", { model: this.config.model, stream: false });
    if (!res.ok) {
      throw new Error(`Ollama could not pull '${this.config.model}' (HTTP ${res.status})`);
    }
    await res.text();
    console.error(`[OIL] Semantic: model '${this.config.model}' ready.`);
  }

  private async embed(inputs: string[]): Promise<Float32Array[]> {
    // The budget is per input, not per call: a fixed per-request timeout fails
    // on the largest batch first, which is exactly when it is least deserved.
    // Measured on CPU-only Ollama, sixteen notes take ~27s against what used to
    // be a flat 20s ceiling.
    const timeout = this.config.timeoutMs * Math.max(1, inputs.length);

    let res = await this.post(
      "/api/embed",
      { model: this.config.model, input: inputs },
      timeout,
    );

    // 404 is Ollama's answer for an unknown model. Pull it once, then retry.
    if (res.status === 404 && !this.modelPulled) {
      this.modelPulled = true;
      await this.pullModel();
      res = await this.post(
        "/api/embed",
        { model: this.config.model, input: inputs },
        timeout,
      );
    }

    if (!res.ok) {
      // Ollama explains itself in the body; without it a 400 is undiagnosable.
      const body = await res.text().catch(() => "");
      const reason = body.trim().slice(0, 200);
      throw new Error(
        `Ollama /api/embed returned HTTP ${res.status}${reason ? `: ${reason}` : ""}`,
      );
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
      throw new Error("Ollama returned an unexpected embedding payload");
    }
    return data.embeddings.map(normalize);
  }

  // ── Indexing ────────────────────────────────────────────────────────────

  /**
   * Reconcile vectors with the graph, embedding only notes whose text changed.
   *
   * Safe to call repeatedly: unchanged notes cost a hash comparison, so a
   * no-op refresh over a large vault is microseconds and no HTTP at all.
   */
  async refresh(graph: GraphIndex): Promise<void> {
    if (this.state === "disabled") return;
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.runRefresh(graph).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Confirm Ollama is actually answering.
   *
   * Skipped once an embedding call has already succeeded this process, so the
   * common path costs nothing. Uses the tag listing rather than an embed so it
   * does not load a model just to answer a health question.
   */
  private async verifyReachable(): Promise<boolean> {
    if (this.verified) return true;
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
      this.verified = true;
      return true;
    } catch (err) {
      const reason = describeError(err);
      if (this.state !== "unavailable") {
        console.error(
          `[OIL] Semantic tier unavailable (${reason}). Search continues on the lexical tiers.`,
        );
      }
      this.state = "unavailable";
      this.reason = reason;
      return false;
    }
  }

  private async runRefresh(graph: GraphIndex): Promise<void> {
    const version = graph.version;

    // Snapshot the desired state up front so notes edited mid-refresh are
    // caught by the version check rather than half-applied.
    const wanted = new Map<string, string>();
    const texts = new Map<string, string>();
    for (const ref of graph.getNotesByFolder("")) {
      const node = graph.getNode(ref.path);
      if (!node) continue;
      const text = embeddingText(node);
      // Ollama rejects an empty input outright, failing the whole batch for one
      // blank note.
      if (!text.trim()) continue;
      wanted.set(ref.path, hashText(text));
      texts.set(ref.path, text);
    }

    let changed = false;
    for (const path of [...this.vectors.keys()]) {
      if (!wanted.has(path)) {
        this.vectors.delete(path);
        changed = true;
      }
    }

    const pending = [...wanted.entries()].filter(
      ([path, hash]) => this.vectors.get(path)?.hash !== hash,
    );

    if (pending.length === 0) {
      this.indexedVersion = version;
      // A complete sidecar is not the same as a working tier: ranking needs the
      // note vectors we already have, but every query still has to be embedded.
      // Reporting `ready` here made `get_health` claim health while searches
      // silently returned nothing.
      const reachable = await this.verifyReachable();
      if (reachable) {
        this.state = "ready";
        this.reason = null;
      }
      if (changed) await this.save();
      return;
    }

    const previous = this.state;
    this.state = "indexing";

    try {
      for (let i = 0; i < pending.length; i += this.config.batchSize) {
        const batch = pending.slice(i, i + this.config.batchSize);
        const vectors = await this.embed(batch.map(([path]) => texts.get(path) ?? ""));
        batch.forEach(([path, hash], offset) => {
          this.vectors.set(path, { hash, vector: vectors[offset] });
        });
        this.dimensions = vectors[0]?.length ?? this.dimensions;
        changed = true;
      }

      this.state = "ready";
      this.reason = null;
      this.verified = true;
      this.indexedVersion = version;
      this.queryCache.clear();
      await this.save();
      console.error(
        `[OIL] Semantic: embedded ${pending.length} note(s) — ${this.vectors.size} vectors ready.`,
      );
    } catch (err) {
      // A missing or broken Ollama is an expected deployment, not an error:
      // hold whatever vectors we already have and let the cascade run lexical.
      this.verified = false;
      this.state = "unavailable";
      this.reason = describeError(err);
      this.indexFailures += 1;
      this.lastFailureReason = this.reason;
      if (previous !== "unavailable") {
        console.error(
          `[OIL] Semantic tier unavailable (${this.reason}). Search continues on the lexical tiers.`,
        );
      }
      if (changed) await this.save();
    }
  }

  /**
   * Kick off a refresh when the graph has moved on, without blocking the caller.
   *
   * This is the only invalidation hook the tier needs: it keys off the same
   * `graph.version` counter as the BM25 and fuzzy indexes, so writes and watcher
   * events re-embed on the next search with no wiring at the call sites.
   */
  ensureFresh(graph: GraphIndex): void {
    if (this.state === "disabled" || this.refreshing) return;
    if (this.indexedVersion === graph.version) return;
    void this.refresh(graph).catch(() => {});
  }

  // ── Query ───────────────────────────────────────────────────────────────

  private async embedQuery(query: string): Promise<Float32Array | null> {
    const cached = this.queryCache.get(query);
    if (cached) return cached;

    try {
      const [vector] = await this.embed([query]);
      if (this.queryCache.size >= QUERY_CACHE_SIZE) {
        this.queryCache.delete(this.queryCache.keys().next().value as string);
      }
      this.queryCache.set(query, vector);
      return vector;
    } catch (err) {
      // Ollama answered once but has stopped; the next refresh must re-check
      // rather than trust the earlier success.
      //
      // The caller still gets a graceful empty answer, but the failure is
      // recorded rather than erased: a search that returned nothing because the
      // embedder timed out is not the same event as one that returned nothing
      // because the vault holds nothing similar, and anything measuring quality
      // has to be able to tell them apart.
      this.verified = false;
      this.state = "unavailable";
      this.reason = describeError(err);
      this.queryFailures += 1;
      this.lastFailureReason = this.reason;
      return null;
    }
  }

  /**
   * Rank notes by cosine similarity to the query.
   *
   * Returns nothing rather than throwing when the tier is cold or Ollama is
   * down, so the cascade never has to special-case its availability.
   */
  async search(
    query: string,
    limit: number,
    accept?: (path: string) => boolean,
  ): Promise<SemanticHit[]> {
    if (this.state === "disabled" || this.vectors.size === 0) return [];

    const queryVector = await this.embedQuery(query);
    if (!queryVector) return [];

    const hits: SemanticHit[] = [];
    for (const [path, entry] of this.vectors) {
      if (accept && !accept(path)) continue;
      const score = dot(queryVector, entry.vector);
      // A floor is essential: cosine ranks *everything*, so without it the tier
      // contributes a full page of unrelated notes to the fusion on any query.
      if (score < this.config.minScore) continue;
      hits.push({ path, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, limit));
  }
}

// ─── Per-graph registration ───────────────────────────────────────────────────

/**
 * Keyed by graph instance, matching how `search.ts` scopes its BM25 and fuzzy
 * indexes. Two vaults in one process never share vectors, and a graph that is
 * garbage collected takes its index with it.
 */
const registry = new WeakMap<GraphIndex, SemanticIndex>();

export function attachSemanticIndex(graph: GraphIndex, index: SemanticIndex): void {
  registry.set(graph, index);
}

export function getSemanticIndex(graph: GraphIndex): SemanticIndex | undefined {
  return registry.get(graph);
}

export function detachSemanticIndex(graph: GraphIndex): void {
  registry.delete(graph);
}
