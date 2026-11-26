// Variant B: one logical graph split into an always-loaded skeleton and lazily
// loaded segments.
//
// The skeleton is a real `GraphIndex` whose nodes are slimmed at read time
// (no bodySnippet/headings, frontmatter cut to aliases/type/customer/customers/
// date/status). Link resolution, backlinks, the title/alias index and the
// incremental/checkpoint machinery are therefore A's own code, unchanged, and
// vault-wide link parity holds by construction rather than by reimplementation.
//
// Heavy per-note data (bodySnippet, headings, full frontmatter) lives in
// segments keyed by folder (Meetings also by year). Each segment is its own
// JSON file, loaded on first use, and only dirty segments are rewritten.
// BM25 postings are built per segment on first search; the global statistics
// that IDF and length normalisation need (N, total length, per-term df, in the
// same insertion order as A's posting map) are persisted in stats.json so a
// scoped search over a few segments scores exactly like A's global index.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { GraphIndex } from "../../src/graph.js";
import { tokenize } from "../../src/bm25.js";
import { flattenFrontmatter, normalizeValue } from "../../src/frontmatter.js";

// Mirrors of src/bm25.ts constants (not exported there).
const K1 = 1.2;
const B = 0.75;
const W_TITLE = 3, W_TAGS = 2.5, W_HEADINGS = 1.5, W_FRONTMATTER = 2, W_BODY = 1;
const FRONTMATTER_SKIP_KEYS = new Set(["tags"]);
const MAX_PREFIX_EXPANSIONS = 24;
const PREFIX_PENALTY = 0.6;
const EXACT_TITLE_BOOST = 4;
const PREFIX_TITLE_BOOST = 1.6;

const SKELETON_FM_KEYS = new Set(["aliases", "alias", "type", "customer", "customers", "date", "status"]);

export type SegmentPolicy = "folder" | "fine";

export interface SegRecord {
  headings: string[];
  bodySnippet: string;
  frontmatter: Record<string, unknown>;
}

interface SegDoc {
  title: string;
  titleKey: string;
  length: number;
}

interface Segment {
  key: string;
  records: Map<string, SegRecord>;
  loaded: boolean;
  dirty: boolean;
  docs: Map<string, SegDoc> | null;
  postings: Map<string, Map<string, number>> | null;
  /** Exact frontmatter values, built alongside postings as Bm25Index does. */
  exact: Map<string, Array<{ path: string; key: string }>> | null;
}

function exactEntries(rec: SegRecord): Array<{ normalized: string; key: string }> {
  const out: Array<{ normalized: string; key: string }> = [];
  for (const field of flattenFrontmatter(rec.frontmatter)) {
    if (FRONTMATTER_SKIP_KEYS.has(field.key)) continue;
    const normalized = normalizeValue(field.value);
    if (normalized) out.push({ normalized, key: field.key });
  }
  return out;
}

export interface Hit {
  path: string;
  title: string;
  score: number;
  matchedTerms: string[];
}

function yearOf(path: string, fm: Record<string, unknown> | undefined): string {
  const d = fm?.date;
  if (typeof d === "string" && /^\d{4}/.test(d)) return d.slice(0, 4);
  const m = /\b(19|20)\d{2}\b/.exec(path.slice(path.lastIndexOf("/") + 1));
  return m ? m[0] : "undated";
}

/** Segment key from skeleton-only data, so routing never needs a segment. */
export function segmentKeyFor(
  path: string,
  fm: Record<string, unknown> | undefined,
  policy: SegmentPolicy,
): string {
  const slash = path.indexOf("/");
  if (slash < 0) return "_root";
  const top = path.slice(0, slash);
  if (top === "Meetings" || (policy === "fine" && top === "Daily")) return `${top}/${yearOf(path, fm)}`;
  if (policy === "fine") {
    if (top === "Customers") {
      const second = path.indexOf("/", slash + 1);
      if (second > 0) return path.slice(0, second);
    }
    if (top === "People") {
      const c = path.charAt(slash + 1).toUpperCase();
      return `People/${/[A-Z]/.test(c) ? c : "_"}`;
    }
  }
  return top;
}

function slimFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fm || typeof fm !== "object") return out;
  for (const [k, v] of Object.entries(fm)) {
    if (SKELETON_FM_KEYS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Same term extraction, field order and weights as Bm25Index.addNote. */
function docTerms(title: string, tags: readonly string[], rec: SegRecord): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
  };
  add(title, W_TITLE);
  add(tags.join(" "), W_TAGS);
  add(rec.headings.join(" "), W_HEADINGS);
  add(rec.bodySnippet ?? "", W_BODY);
  for (const field of flattenFrontmatter(rec.frontmatter)) {
    if (FRONTMATTER_SKIP_KEYS.has(field.key)) continue;
    add(field.value, W_FRONTMATTER);
  }
  return tf;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Content hash kept in the skeleton, so an mtime-only change (sync, checkout,
 * restore) is recognised without loading the segment that holds the note.
 */
const HASH_KEY = "__oil_h";
function recordHash(rec: SegRecord): string {
  return createHash("sha1")
    .update(JSON.stringify([rec.headings, rec.bodySnippet, rec.frontmatter]))
    .digest("base64url")
    .slice(0, 16);
}

async function atomicWrite(fullPath: string, text: string): Promise<void> {
  const tmp = `${fullPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, "utf-8");
  await rename(tmp, fullPath);
}

// GraphIndex.readNote is TS-private; at runtime it is an ordinary prototype
// method, which is what lets the skeleton intercept it.
const baseReadNote = (GraphIndex.prototype as any).readNote as (this: GraphIndex, p: string) => Promise<any>;

export class SegmentedGraph extends GraphIndex {
  readonly root: string;
  readonly policy: SegmentPolicy;
  readonly dir: string;
  readonly skeletonFile: string;
  segments = new Map<string, Segment>();
  segOf = new Map<string, string>();
  df = new Map<string, number>();
  N = 0;
  totalLength = 0;
  statsDirty = false;
  io = { segmentLoads: 0, segmentCharsRead: 0 };
  private pending = new Map<
    string,
    { rec: SegRecord; hash: string; prev: { title: string; tags: string[]; hash: unknown } | null }
  >();

  constructor(root: string, policy: SegmentPolicy = "folder") {
    super(root);
    this.root = root;
    this.policy = policy;
    this.dir = `_oil-shards-${policy}`;
    this.skeletonFile = join(this.dir, "skeleton.json");
  }

  // ── skeleton interception ────────────────────────────────────────────────

  // Installed as `readNote` on the prototype below the class: declaring a
  // member with the base's TS-private name would make the subclass
  // incompatible with GraphIndex.
  async readSlimNote(notePath: string): Promise<any> {
    const prevNode = this.getNode(notePath);
    const prev = prevNode
      ? { title: prevNode.title, tags: [...prevNode.tags], hash: prevNode.frontmatter?.[HASH_KEY] }
      : null;
    const note = await baseReadNote.call(this, notePath);
    if (!note) return note;
    const rec: SegRecord = { headings: note.headings, bodySnippet: note.bodySnippet, frontmatter: note.frontmatter };
    const hash = recordHash(rec);
    this.pending.set(note.path, { rec, hash, prev });
    const slim = slimFrontmatter(note.frontmatter);
    slim[HASH_KEY] = hash;
    return { ...note, headings: [], bodySnippet: "", frontmatter: slim };
  }

  async build(): Promise<void> {
    this.segments.clear();
    this.segOf.clear();
    this.df.clear();
    this.N = 0;
    this.totalLength = 0;
    this.pending.clear();
    await super.build();
    // Fold in node order, so df insertion order matches A's posting map.
    for (const ref of this.getNotesByFolder("")) {
      const node = this.getNode(ref.path)!;
      const p = this.pending.get(ref.path);
      if (!p) continue;
      const key = segmentKeyFor(ref.path, node.frontmatter, this.policy);
      const seg = this.segment(key, true);
      seg.records.set(ref.path, p.rec);
      seg.dirty = true;
      this.segOf.set(ref.path, key);
      this.addDoc(ref.path, node.title, node.tags, p.rec, seg);
    }
    this.pending.clear();
    this.statsDirty = true;
  }

  async updateNotes(paths: readonly string[]): Promise<void> {
    await super.updateNotes(paths);
    await this.absorbPending();
  }

  /** Apply re-read notes to their segments and the global statistics. */
  private async absorbPending(): Promise<void> {
    if (this.pending.size === 0) return;
    // mtime-only change (sync, checkout): same hash, title, tags and segment,
    // so neither the segment nor the statistics change and nothing is loaded.
    const batch = [...this.pending].filter(([path, p]) => {
      const node = this.getNode(path);
      return !(
        node && p.prev && p.prev.hash === p.hash && p.prev.title === node.title &&
        sameList(p.prev.tags, node.tags) &&
        this.segOf.get(path) === segmentKeyFor(path, node.frontmatter, this.policy)
      );
    });
    this.pending.clear();
    if (batch.length === 0) return;
    const need = new Set<string>();
    for (const [path] of batch) {
      const old = this.segOf.get(path);
      if (old) need.add(old);
      const node = this.getNode(path);
      if (node) need.add(segmentKeyFor(path, node.frontmatter, this.policy));
    }
    await this.ensureLoaded(need);

    for (const [path, { rec, prev }] of batch) {
      const node = this.getNode(path);
      const oldKey = this.segOf.get(path);
      const oldSeg = oldKey ? this.segments.get(oldKey) : undefined;
      const oldRec = oldSeg?.records.get(path);
      const newKey = node ? segmentKeyFor(path, node.frontmatter, this.policy) : undefined;
      if (oldRec && oldSeg) {
        this.removeDoc(path, prev?.title ?? node?.title ?? "", prev?.tags ?? node?.tags ?? [], oldRec, oldSeg);
        oldSeg.records.delete(path);
        oldSeg.dirty = true;
      }
      if (node && newKey) {
        const seg = this.segment(newKey, true);
        seg.records.set(path, rec);
        seg.dirty = true;
        this.segOf.set(path, newKey);
        this.addDoc(path, node.title, node.tags, rec, seg);
      } else {
        this.segOf.delete(path);
      }
    }
  }

  private addDoc(path: string, title: string, tags: readonly string[], rec: SegRecord, seg: Segment): void {
    const terms = docTerms(title, tags, rec);
    if (terms.size === 0) return;
    let length = 0;
    for (const [term, freq] of terms) {
      length += freq;
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
      if (seg.postings) {
        let posting = seg.postings.get(term);
        if (!posting) seg.postings.set(term, (posting = new Map()));
        posting.set(path, freq);
      }
    }
    this.N++;
    this.totalLength += length;
    this.statsDirty = true;
    seg.docs?.set(path, { title, titleKey: tokenize(title).join(" "), length });
    if (seg.exact) {
      for (const e of exactEntries(rec)) {
        const bucket = seg.exact.get(e.normalized) ?? [];
        bucket.push({ path, key: e.key });
        seg.exact.set(e.normalized, bucket);
      }
    }
  }

  private removeDoc(path: string, title: string, tags: readonly string[], rec: SegRecord, seg: Segment): void {
    const terms = docTerms(title, tags, rec);
    if (terms.size === 0) return;
    let length = 0;
    for (const [term, freq] of terms) {
      length += freq;
      const n = (this.df.get(term) ?? 0) - 1;
      // Dropped at zero and re-appended on re-add, as A's posting map does.
      if (n <= 0) this.df.delete(term);
      else this.df.set(term, n);
      const posting = seg.postings?.get(term);
      if (posting) {
        posting.delete(path);
        if (posting.size === 0) seg.postings!.delete(term);
      }
    }
    this.N--;
    this.totalLength -= length;
    this.statsDirty = true;
    seg.docs?.delete(path);
    if (seg.exact) {
      for (const e of exactEntries(rec)) {
        const kept = (seg.exact.get(e.normalized) ?? []).filter((x) => x.path !== path);
        if (kept.length > 0) seg.exact.set(e.normalized, kept);
        else seg.exact.delete(e.normalized);
      }
    }
  }

  // ── segments ─────────────────────────────────────────────────────────────

  private segment(key: string, loaded = false): Segment {
    let seg = this.segments.get(key);
    if (!seg) {
      seg = { key, records: new Map(), loaded, dirty: false, docs: null, postings: null, exact: null };
      this.segments.set(key, seg);
    }
    return seg;
  }

  segFile(key: string): string {
    return join(this.root, this.dir, `seg-${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  get statsFile(): string {
    return join(this.root, this.dir, "stats.json");
  }

  async ensureLoaded(keys: Iterable<string>): Promise<void> {
    const todo: Segment[] = [];
    for (const key of keys) {
      const seg = this.segment(key);
      if (!seg.loaded) todo.push(seg);
    }
    await Promise.all(
      todo.map(async (seg) => {
        let text: string;
        try {
          text = await readFile(this.segFile(seg.key), "utf-8");
        } catch {
          seg.loaded = true;
          return;
        }
        this.io.segmentLoads++;
        this.io.segmentCharsRead += text.length;
        const data = JSON.parse(text) as { notes: Array<SegRecord & { path: string }> };
        for (const n of data.notes) {
          // A record edited in memory before its segment loaded wins.
          if (!seg.records.has(n.path)) {
            seg.records.set(n.path, { headings: n.headings, bodySnippet: n.bodySnippet, frontmatter: n.frontmatter });
          }
        }
        seg.loaded = true;
      }),
    );
  }

  get loadedSegmentCount(): number {
    let n = 0;
    for (const s of this.segments.values()) if (s.loaded) n++;
    return n;
  }

  allSegmentKeys(): Set<string> {
    return new Set(this.segOf.values());
  }

  /** Router: the segments holding any note the predicate admits. */
  route(accept: (path: string) => boolean): Set<string> {
    const keys = new Set<string>();
    for (const [path, key] of this.segOf) if (accept(path)) keys.add(key);
    return keys;
  }

  private buildSegIndex(seg: Segment): void {
    const docs = new Map<string, SegDoc>();
    const postings = new Map<string, Map<string, number>>();
    const exact = new Map<string, Array<{ path: string; key: string }>>();
    for (const [path, rec] of seg.records) {
      const node = this.getNode(path);
      if (!node) continue;
      const terms = docTerms(node.title, node.tags, rec);
      if (terms.size === 0) continue;
      for (const e of exactEntries(rec)) {
        const bucket = exact.get(e.normalized) ?? [];
        bucket.push({ path, key: e.key });
        exact.set(e.normalized, bucket);
      }
      let length = 0;
      for (const [term, freq] of terms) {
        length += freq;
        let posting = postings.get(term);
        if (!posting) postings.set(term, (posting = new Map()));
        posting.set(path, freq);
      }
      docs.set(path, { title: node.title, titleKey: tokenize(node.title).join(" "), length });
    }
    seg.docs = docs;
    seg.postings = postings;
    seg.exact = exact;
  }

  /** Full segment record, for tools that need the body or full frontmatter. */
  async getRecord(path: string): Promise<SegRecord | undefined> {
    const key = this.segOf.get(path);
    if (!key) return undefined;
    await this.ensureLoaded([key]);
    return this.segments.get(key)?.records.get(path);
  }

  // ── search (same scoring as Bm25Index.search, with global statistics) ────

  private expand(term: string): Array<{ term: string; weight: number }> {
    if (this.df.has(term)) return [{ term, weight: 1 }];
    if (term.length < 3) return [];
    const matches: Array<{ term: string; weight: number }> = [];
    for (const candidate of this.df.keys()) {
      if (candidate.startsWith(term)) {
        matches.push({ term: candidate, weight: PREFIX_PENALTY });
        if (matches.length >= MAX_PREFIX_EXPANSIONS) break;
      }
    }
    return matches;
  }

  async search(query: string, limit: number, accept?: (path: string) => boolean): Promise<Hit[]> {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.N === 0) return [];
    const keys = accept ? this.route(accept) : this.allSegmentKeys();
    await this.ensureLoaded(keys);
    const segs: Segment[] = [];
    for (const key of keys) {
      const seg = this.segments.get(key)!;
      if (!seg.postings) this.buildSegIndex(seg);
      segs.push(seg);
    }

    const expanded = queryTerms.map((t) => this.expand(t));
    const totalDocs = this.N;
    const avgLength = this.N > 0 ? this.totalLength / this.N : 1;
    const scores = new Map<string, number>();
    const matched = new Map<string, Set<string>>();
    const docOf = new Map<string, SegDoc>();

    for (const seg of segs) {
      for (let qi = 0; qi < queryTerms.length; qi++) {
        for (const { term, weight } of expanded[qi]) {
          const posting = seg.postings!.get(term);
          if (!posting) continue;
          const df = this.df.get(term)!;
          const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
          for (const [path, termFreq] of posting) {
            const doc = seg.docs!.get(path);
            if (!doc) continue;
            docOf.set(path, doc);
            const norm = 1 - B + B * (doc.length / avgLength);
            const contribution = weight * idf * ((termFreq * (K1 + 1)) / (termFreq + K1 * norm));
            scores.set(path, (scores.get(path) ?? 0) + contribution);
            let terms = matched.get(path);
            if (!terms) matched.set(path, (terms = new Set()));
            terms.add(queryTerms[qi]);
          }
        }
      }
    }

    const hits: Hit[] = [];
    const queryKey = queryTerms.join(" ");
    for (const [path, score] of scores) {
      if (accept && !accept(path)) continue;
      const doc = docOf.get(path)!;
      let boost = 1;
      if (doc.titleKey === queryKey) boost = EXACT_TITLE_BOOST;
      else if (doc.titleKey.startsWith(`${queryKey} `)) boost = PREFIX_TITLE_BOOST;
      hits.push({ path, title: doc.title, score: score * boost, matchedTerms: [...(matched.get(path) ?? [])] });
    }
    hits.sort(
      (a, b) => b.matchedTerms.length - a.matchedTerms.length || b.score - a.score || a.path.localeCompare(b.path),
    );
    return hits.slice(0, Math.max(0, limit));
  }

  // ── persistence ──────────────────────────────────────────────────────────

  /** Load skeleton + global stats only. Segments load on demand. */
  async loadWarm(): Promise<boolean> {
    const ok = await this.loadFromDisk(this.skeletonFile);
    if (!ok) return false;
    const stats = JSON.parse(await readFile(this.statsFile, "utf-8")) as {
      N: number;
      totalLength: number;
      df: Array<[string, number]>;
    };
    this.N = stats.N;
    this.totalLength = stats.totalLength;
    this.df = new Map(stats.df);
    this.statsDirty = false;
    this.segments.clear();
    this.segOf.clear();
    this.pending.clear();
    for (const ref of this.getNotesByFolder("")) {
      this.segOf.set(ref.path, segmentKeyFor(ref.path, this.getNode(ref.path)!.frontmatter, this.policy));
    }
    return true;
  }

  /**
   * Dirty segments and stats first, skeleton last: the skeleton's mtimes are
   * the commit point, so a crash between files leaves notes that look stale
   * and get re-read, never a skeleton claiming content no segment holds.
   */
  async saveToDisk(file: string): Promise<void> {
    await this.absorbPending();
    await mkdir(join(this.root, this.dir), { recursive: true });
    for (const seg of this.segments.values()) {
      if (!seg.dirty) continue;
      const notes: Array<SegRecord & { path: string }> = [];
      for (const [path, rec] of seg.records) if (this.getNode(path)) notes.push({ path, ...rec });
      await atomicWrite(this.segFile(seg.key), JSON.stringify({ version: 1, key: seg.key, notes }));
      seg.dirty = false;
    }
    if (this.statsDirty) {
      await atomicWrite(
        this.statsFile,
        JSON.stringify({ version: 1, N: this.N, totalLength: this.totalLength, df: [...this.df] }),
      );
      this.statsDirty = false;
    }
    await super.saveToDisk(file);
  }

  async save(): Promise<void> {
    await this.saveToDisk(this.skeletonFile);
  }

  async flushAll(): Promise<boolean> {
    return this.flush(this.skeletonFile);
  }

  async revalidate(): Promise<number> {
    return this.buildIncremental(this.skeletonFile);
  }
}

(SegmentedGraph.prototype as any).readNote = SegmentedGraph.prototype.readSlimNote;
