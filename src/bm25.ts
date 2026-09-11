/**
 * OIL — Okapi BM25 ranking
 *
 * Replaces hand-tuned score constants with a real relevance model:
 * term frequency saturation, inverse document frequency, and document length
 * normalisation. Rare terms outrank common ones, a term repeated ten times
 * stops counting like ten separate hits, and a long note no longer wins purely
 * for containing more words.
 *
 * Implemented in-tree rather than pulled from a package: it is a small, stable
 * algorithm, and every BM25 library ships its own tokenizer and index model
 * that would duplicate the graph index this already reads from.
 */

import type { GraphIndex } from "./graph.js";
import type { GraphNode } from "./types.js";
import { flattenFrontmatter, normalizeValue } from "./frontmatter.js";

// Standard Okapi parameters. k1 controls TF saturation, b length normalisation.
const K1 = 1.2;
const B = 0.75;

/** Field boosts, applied as term-frequency multipliers. */
const FIELD_WEIGHTS = {
  title: 3,
  tags: 2.5,
  headings: 1.5,
  // Frontmatter is structured metadata: worth more than prose, below headings.
  frontmatter: 2,
  body: 1,
} as const;

/** `tags` reaches the index via node.tags; skip it here to avoid double counting. */
const FRONTMATTER_SKIP_KEYS = new Set(["tags"]);

/** A query term absent from the vocabulary expands to at most this many prefixes. */
const MAX_PREFIX_EXPANSIONS = 24;
/** Prefix matches are weaker evidence than an exact term match. */
const PREFIX_PENALTY = 0.6;

/**
 * In an entity-shaped vault a note titled exactly "Contoso" is the canonical
 * answer for the query "Contoso" — a fact term statistics cannot express, since
 * a meeting note mentioning the customer repeatedly can out-score it on TF.
 */
const EXACT_TITLE_BOOST = 4;
const PREFIX_TITLE_BOOST = 1.6;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "he", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to",
  "was", "were", "will", "with",
]);

export interface Bm25Hit {
  path: string;
  title: string;
  score: number;
  matchedTerms: string[];
}

/** A note whose frontmatter holds the query as a complete value. */
export interface ExactFieldHit {
  path: string;
  title: string;
  /** Dotted frontmatter path that held the value, e.g. "tpid". */
  key: string;
  value: string;
}

/**
 * Split text into searchable terms.
 *
 * Keeps digits so IDs and dates stay searchable, and keeps single characters
 * out of the index since they carry almost no discriminative signal.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}

interface Bm25Doc {
  path: string;
  title: string;
  length: number;
  /** Normalised title terms, for exact-match detection. */
  titleKey: string;
  /** Terms this document contributes to, so removal costs O(its own terms). */
  terms: string[];
  /** Normalised frontmatter values this document registered. */
  exactKeys: string[];
}

class Bm25Index {
  /** path → document */
  private docs = new Map<string, Bm25Doc>();
  /** term → (path → weighted term frequency) */
  private postings = new Map<string, Map<string, number>>();
  /** normalised whole frontmatter value → the notes and keys carrying it */
  private exactValues = new Map<string, Array<{ path: string; key: string; value: string }>>();
  private totalLength = 0;

  constructor(graph: GraphIndex) {
    for (const ref of graph.getNotesByFolder("")) {
      const node = graph.getNode(ref.path);
      if (node) this.addNote(node);
    }
  }

  private get avgLength(): number {
    return this.docs.size > 0 ? this.totalLength / this.docs.size : 1;
  }

  private addNote(node: GraphNode): void {
    const termFreqs = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const term of tokenize(text)) {
        termFreqs.set(term, (termFreqs.get(term) ?? 0) + weight);
      }
    };

    add(node.title, FIELD_WEIGHTS.title);
    add(node.tags.join(" "), FIELD_WEIGHTS.tags);
    add(node.headings.join(" "), FIELD_WEIGHTS.headings);
    add(node.bodySnippet ?? "", FIELD_WEIGHTS.body);

    // Frontmatter is stripped out of bodySnippet, so without this pass every
    // TPID, account id and custom field is invisible to search.
    const pendingExact: Array<{ normalized: string; key: string; value: string }> = [];
    for (const field of flattenFrontmatter(node.frontmatter)) {
      if (FRONTMATTER_SKIP_KEYS.has(field.key)) continue;
      add(field.value, FIELD_WEIGHTS.frontmatter);

      const normalized = normalizeValue(field.value);
      if (normalized) pendingExact.push({ normalized, key: field.key, value: field.value });
    }

    if (termFreqs.size === 0) return;

    for (const pending of pendingExact) {
      const bucket = this.exactValues.get(pending.normalized) ?? [];
      bucket.push({ path: node.path, key: pending.key, value: pending.value });
      this.exactValues.set(pending.normalized, bucket);
    }

    let length = 0;
    for (const [term, freq] of termFreqs) {
      length += freq;
      let posting = this.postings.get(term);
      if (!posting) {
        posting = new Map();
        this.postings.set(term, posting);
      }
      posting.set(node.path, freq);
    }

    this.docs.set(node.path, {
      path: node.path,
      title: node.title,
      length,
      titleKey: tokenize(node.title).join(" "),
      terms: [...termFreqs.keys()],
      exactKeys: pendingExact.map((p) => p.normalized),
    });
    this.totalLength += length;
  }

  private removeNote(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;

    for (const term of doc.terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      posting.delete(path);
      // Dropping empty posting lists keeps the vocabulary honest, which matters
      // because prefix expansion scans every term still in it.
      if (posting.size === 0) this.postings.delete(term);
    }

    for (const normalized of doc.exactKeys) {
      const bucket = this.exactValues.get(normalized);
      if (!bucket) continue;
      const kept = bucket.filter((entry) => entry.path !== path);
      if (kept.length > 0) this.exactValues.set(normalized, kept);
      else this.exactValues.delete(normalized);
    }

    this.totalLength -= doc.length;
    this.docs.delete(path);
  }

  /** Bring one note in line with the graph, whether it was edited or deleted. */
  upsert(graph: GraphIndex, path: string): void {
    this.removeNote(path);
    const node = graph.getNode(path);
    if (node) this.addNote(node);
  }

  get size(): number {
    return this.docs.size;
  }

  /**
   * Expand a query term that is not in the vocabulary to matching prefixes, so
   * a partial word ("custom") still retrieves the notes a substring search
   * would have found ("customer").
   */
  private expand(term: string): Array<{ term: string; weight: number }> {
    if (this.postings.has(term)) return [{ term, weight: 1 }];
    if (term.length < 3) return [];

    const matches: Array<{ term: string; weight: number }> = [];
    for (const candidate of this.postings.keys()) {
      if (candidate.startsWith(term)) {
        matches.push({ term: candidate, weight: PREFIX_PENALTY });
        if (matches.length >= MAX_PREFIX_EXPANSIONS) break;
      }
    }
    return matches;
  }

  /**
   * Notes whose frontmatter holds the query as a *complete* value.
   *
   * Term scoring cannot distinguish "ACC-NORTHWIND-001" matching an account id
   * from it merely sharing the token "northwind" with a title, so identifier
   * lookups need whole-value equality to be answered honestly.
   */
  exactFieldMatches(query: string, accept?: (path: string) => boolean): ExactFieldHit[] {
    const normalized = normalizeValue(query);
    if (!normalized) return [];

    const hits: ExactFieldHit[] = [];
    for (const entry of this.exactValues.get(normalized) ?? []) {
      const doc = this.docs.get(entry.path);
      if (!doc || (accept && !accept(doc.path))) continue;
      hits.push({ path: doc.path, title: doc.title, key: entry.key, value: entry.value });
    }
    return hits;
  }

  search(query: string, limit: number, accept?: (path: string) => boolean): Bm25Hit[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.docs.size === 0) return [];

    const scores = new Map<string, number>();
    const matched = new Map<string, Set<string>>();
    const totalDocs = this.docs.size;
    const avgLength = this.avgLength;

    for (const queryTerm of queryTerms) {
      for (const { term, weight } of this.expand(queryTerm)) {
        const posting = this.postings.get(term);
        if (!posting) continue;

        // Probabilistic IDF, smoothed so a term present in most documents
        // contributes a small positive weight rather than a negative one.
        const df = posting.size;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

        for (const [path, termFreq] of posting) {
          const doc = this.docs.get(path);
          if (!doc) continue;
          const norm = 1 - B + B * (doc.length / avgLength);
          const contribution =
            weight * idf * ((termFreq * (K1 + 1)) / (termFreq + K1 * norm));

          scores.set(path, (scores.get(path) ?? 0) + contribution);

          let terms = matched.get(path);
          if (!terms) {
            terms = new Set();
            matched.set(path, terms);
          }
          terms.add(queryTerm);
        }
      }
    }

    const hits: Bm25Hit[] = [];
    const queryKey = queryTerms.join(" ");

    for (const [path, score] of scores) {
      const doc = this.docs.get(path);
      if (!doc || (accept && !accept(doc.path))) continue;

      let boost = 1;
      if (doc.titleKey === queryKey) boost = EXACT_TITLE_BOOST;
      else if (doc.titleKey.startsWith(`${queryKey} `)) boost = PREFIX_TITLE_BOOST;

      hits.push({
        path: doc.path,
        title: doc.title,
        score: score * boost,
        matchedTerms: [...(matched.get(path) ?? [])],
      });
    }

    // Prefer documents matching more of the query before raw score, so a note
    // hitting every term outranks one that hits a single rare term repeatedly.
    // Path breaks remaining ties: without it the order falls out of posting-list
    // insertion order, so an incrementally updated index could rank equal-scoring
    // notes differently from a freshly built one.
    hits.sort(
      (a, b) =>
        b.matchedTerms.length - a.matchedTerms.length ||
        b.score - a.score ||
        a.path.localeCompare(b.path),
    );
    return hits.slice(0, Math.max(0, limit));
  }
}

/**
 * Keyed by graph instance. On a version change the graph is asked which notes
 * actually moved, so a one-note edit re-indexes one note rather than discarding
 * every posting list — measured at 10k notes, that is the difference between a
 * ~1s stall on the next query and an imperceptible one.
 */
let indexCache = new WeakMap<GraphIndex, { index: Bm25Index; version: number }>();

function getOrBuildIndex(graph: GraphIndex): Bm25Index {
  const cached = indexCache.get(graph);
  if (cached) {
    if (cached.version === graph.version) return cached.index;

    const changed = graph.changesSince(cached.version);
    if (changed) {
      for (const path of changed) cached.index.upsert(graph, path);
      cached.version = graph.version;
      return cached.index;
    }
  }

  const index = new Bm25Index(graph);
  indexCache.set(graph, { index, version: graph.version });
  return index;
}

/** Drop cached indexes. Version tracking covers edits; this is for tests. */
export function invalidateBm25Index(): void {
  indexCache = new WeakMap();
}

export function bm25Search(
  graph: GraphIndex,
  query: string,
  limit: number,
  accept?: (path: string) => boolean,
): Bm25Hit[] {
  return getOrBuildIndex(graph).search(query, limit, accept);
}

/** Notes whose frontmatter carries the query as a complete value. */
export function exactFieldSearch(
  graph: GraphIndex,
  query: string,
  accept?: (path: string) => boolean,
): ExactFieldHit[] {
  return getOrBuildIndex(graph).exactFieldMatches(query, accept);
}
