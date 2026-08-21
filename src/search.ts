/**
 * OIL — Search Engine
 *
 * Three tiers with deliberately disjoint responsibilities:
 *   lexical (BM25)  — exact terms, identifiers, frontmatter values
 *   fuzzy (fuse.js) — misspelled names: "did you mean this note?"
 *   semantic        — meaning, when the words never matched at all
 *
 * `cascadeSearch` is the single entry point. Tiers past the first run only on
 * evidence that the cheaper one failed, so the common entity-name query stays
 * on the millisecond path.
 */

import Fuse from "fuse.js";
import type { GraphIndex } from "./graph.js";
import { bm25Search, exactFieldSearch, invalidateBm25Index, tokenize } from "./bm25.js";
import { getSemanticIndex } from "./semantic.js";
import type { SearchResult } from "./types.js";

// ─── Search Index Entry ───────────────────────────────────────────────────────

/**
 * Body text is deliberately absent.
 *
 * BM25 already indexes the full body with term statistics and prefix expansion,
 * so including it here bought a second, worse pass over the same text — and it
 * was the dominant cost of the tier, scanning every note's 10 KB snippet with
 * an edit-distance matcher. Fuzzy now covers exactly what it is good at:
 * short, name-like fields where a transposition is plausible.
 */
interface SearchEntry {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
}

/**
 * The last-resort variant. Carries a *deduplicated term list* rather than prose:
 * fuzzy matching only ever needs to know which words a note contains, so the
 * repetition and punctuation in raw prose is search surface fuse.js pays for and
 * gets nothing back from. Measured on a 610-note vault, indexing terms instead
 * of prose halves the indexed text (53%), builds 4.6x faster (250ms -> 55ms) and
 * queries 1.7x faster (79ms -> 46ms median), at equal recall.
 *
 * `bodySnippet` rides along unindexed, purely so the excerpt shown to the caller
 * is real prose rather than the token soup that was matched.
 */
interface BodySearchEntry extends SearchEntry {
  bodyTerms: string;
  bodySnippet: string;
}

// ─── Fuse Index Cache ─────────────────────────────────────────────────────────

interface CachedIndex {
  fuse: Fuse<SearchEntry>;
  version: number;
}

interface CachedBodyIndex {
  fuse: Fuse<BodySearchEntry>;
  version: number;
}

/**
 * Keyed by graph instance so two vaults (or two test fixtures) in one process
 * never share an index, and by `graph.version` so any mutation — including an
 * in-place content edit, which leaves the node count unchanged — forces a
 * rebuild without depending on callers remembering to invalidate.
 */
let indexCache = new WeakMap<GraphIndex, CachedIndex>();

/**
 * Separate cache for the body-bearing index, built lazily the first time a query
 * actually needs it. Most processes never build it at all.
 */
let bodyIndexCache = new WeakMap<GraphIndex, CachedBodyIndex>();

/** Shortest body term the last-resort pass will try to fuzzy-match. */
const BODY_TERM_MIN_LENGTH = 4;

/**
 * Above this share of the corpus, rebuilding the fuzzy index beats patching it.
 * fuse.js splices its record array and renumbers every following record on each
 * removal, so patching costs O(changed x notes) while a rebuild is one pass.
 */
const FUZZY_PATCH_MAX_SHARE = 0.05;

function toSearchEntry(node: {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
}): SearchEntry {
  return {
    path: node.path,
    title: node.title,
    tags: node.tags,
    headings: node.headings,
  };
}

/**
 * Build or return the cached fuse.js search index for this graph.
 *
 * On a version change the graph is asked which notes actually moved, so an edit
 * costs one removal pass plus a re-add rather than re-tokenising the vault.
 */
function getOrBuildIndex(graph: GraphIndex): Fuse<SearchEntry> {
  const cached = indexCache.get(graph);
  if (cached) {
    if (cached.version === graph.version) return cached.fuse;

    const changed = graph.changesSince(cached.version);
    const patchable =
      changed !== null &&
      changed.length <= Math.max(16, graph.nodeCount * FUZZY_PATCH_MAX_SHARE);

    if (changed && patchable) {
      if (changed.length > 0) {
        const changedPaths = new Set(changed);
        cached.fuse.remove((entry) => changedPaths.has(entry.path));
        for (const path of changed) {
          const node = graph.getNode(path);
          if (node) cached.fuse.add(toSearchEntry(node));
        }
      }
      cached.version = graph.version;
      return cached.fuse;
    }
  }

  const entries: SearchEntry[] = [];
  // Iterate all notes via getNotesByFolder("") — matches all
  const allRefs = graph.getNotesByFolder("");
  for (const ref of allRefs) {
    const node = graph.getNode(ref.path);
    if (!node) continue;
    entries.push(toSearchEntry(node));
  }

  const fuse = new Fuse(entries, {
    keys: [
      { name: "title", weight: 3 },
      { name: "tags", weight: 2 },
      { name: "headings", weight: 1 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    useExtendedSearch: false,
  });
  indexCache.set(graph, { fuse, version: graph.version });

  return fuse;
}

/**
 * Drop every cached search index so the next search rebuilds from the graph.
 * Version tracking already covers graph mutations; this remains for callers
 * that need an unconditional reset (tests, benchmarks).
 */
export function invalidateSearchIndex(): void {
  indexCache = new WeakMap();
  bodyIndexCache = new WeakMap();
  invalidateBm25Index();
}

/**
 * Build or return the cached fuzzy index that *does* carry body prose.
 *
 * Rebuilt wholesale rather than patched: it is built lazily and consulted on a
 * small share of queries, so the incremental machinery the cheap index needs
 * would cost more to maintain than it saves here.
 */
function getOrBuildBodyIndex(graph: GraphIndex): Fuse<BodySearchEntry> {
  const cached = bodyIndexCache.get(graph);
  if (cached && cached.version === graph.version) return cached.fuse;

  const entries: BodySearchEntry[] = [];
  for (const ref of graph.getNotesByFolder("")) {
    const node = graph.getNode(ref.path);
    if (!node) continue;
    const body = node.bodySnippet ?? "";
    // Terms shorter than this are not worth a fuzzy match: an edit distance of
    // one is most of a three-letter word, so they match almost anything.
    const terms = [...new Set(tokenize(body))].filter((t) => t.length >= BODY_TERM_MIN_LENGTH);
    entries.push({
      ...toSearchEntry(node),
      bodyTerms: terms.join(" "),
      bodySnippet: body,
    });
  }

  const fuse = new Fuse(entries, {
    keys: [
      { name: "title", weight: 3 },
      { name: "tags", weight: 2 },
      { name: "headings", weight: 1 },
      { name: "bodyTerms", weight: 0.5 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    useExtendedSearch: false,
  });
  bodyIndexCache.set(graph, { fuse, version: graph.version });

  return fuse;
}

// ─── Search Functions ─────────────────────────────────────────────────────────

/**
 * Tier 1 — Lexical search, ranked with Okapi BM25.
 *
 * Scores come from term statistics rather than fixed per-field constants, so
 * a rare term in the body can legitimately outrank a common term in a title.
 */
export function lexicalSearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  const hits = bm25Search(graph, query, limit, (path) =>
    passesFilters(path, graph, filters),
  );
  if (hits.length === 0) return [];

  // Normalise to (0, 1] for a stable, comparable score across queries. BM25 is
  // unbounded, so the raw value is only meaningful relative to this result set.
  const top = hits[0].score || 1;

  return hits.map((hit) => {
    const node = graph.getNode(hit.path);
    return {
      path: hit.path,
      title: hit.title,
      excerpt: buildExcerpt(node?.bodySnippet ?? "", hit.matchedTerms, node?.tags ?? []),
      score: Number((hit.score / top).toFixed(4)),
      matchedTerms: hit.matchedTerms,
      matchType: "lexical" as const,
    };
  });
}

/** Contextual excerpt around the first matched term, falling back to tags. */
function buildExcerpt(body: string, terms: string[], tags: string[]): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return tags.join(", ");

  const lower = compact.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index >= 0) break;
  }
  if (index < 0) return leadExcerpt(compact, tags);

  const start = Math.max(0, index - 60);
  const end = Math.min(compact.length, index + 160);
  return (
    (start > 0 ? "…" : "") + compact.slice(start, end).trim() + (end < compact.length ? "…" : "")
  );
}

/**
 * Opening of the note, for hits with no term to anchor on — a fuzzy title match
 * or a semantic one. Tags alone told an agent almost nothing about why the note
 * was returned.
 */
function leadExcerpt(body: string, tags: string[]): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return tags.join(", ");
  return compact.length > 200 ? `${compact.slice(0, 200).trim()}…` : compact;
}

/**
 * Tier 2 — Fuzzy search: fuse.js over titles, tags, headings.
 */
export function fuzzySearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  const fuse = getOrBuildIndex(graph);
  // Filters are applied after fuse ranks, so a filtered search needs a wider
  // candidate pool or it silently under-returns.
  const hasFilters = Boolean(filters?.folder || filters?.tags?.length || filters?.frontmatter);
  const raw = fuse.search(query, { limit: hasFilters ? limit * 10 : limit * 2 });

  const results: SearchResult[] = [];
  // Normalize scores: fuse.js returns 0 = perfect match, threshold = worst.
  // Map to [0.1, 1.0] range so results always have differentiable scores.
  const maxFuseScore = raw.length > 0
    ? Math.max(...raw.map((r) => r.score ?? 0), 0.01)
    : 1;

  for (const match of raw) {
    if (!passesFilters(match.item.path, graph, filters)) continue;

    const fuseScore = match.score ?? 0;
    // Invert and normalize: best match → 1.0, worst in result set → ~0.1
    const normalizedScore = 1 - (fuseScore / maxFuseScore) * 0.9;

    results.push({
      path: match.item.path,
      title: match.item.title,
      excerpt: leadExcerpt(
        graph.getNode(match.item.path)?.bodySnippet ?? "",
        match.item.tags,
      ),
      score: normalizedScore,
      matchedTerms: [],
      matchType: "fuzzy",
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Tier 2b — the last-resort fuzzy pass that can reach note bodies.
 *
 * Bodies are deliberately absent from the tier above: fuse.js over full prose
 * measured 87–97% of that tier's cost on a 1,200-note vault, and BM25 already
 * indexes body text, so paying it on every query bought a second pass over
 * text tier 1 had already read.
 *
 * What BM25 cannot do is match a *misspelled* word — it looks terms up exactly,
 * and its prefix expansion only fires forwards. So a typo whose target appears
 * only in body prose had no tier left at all and `search_vault` returned zero
 * results where 0.5.5 returned the note. This pass exists to close that gap
 * without reopening the cost, which is why the cascade calls it last and rarely.
 */
export function fuzzyBodySearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  const fuse = getOrBuildBodyIndex(graph);
  const hasFilters = Boolean(filters?.folder || filters?.tags?.length || filters?.frontmatter);
  const raw = fuse.search(query, { limit: hasFilters ? limit * 10 : limit * 2 });

  const results: SearchResult[] = [];
  const maxFuseScore = raw.length > 0
    ? Math.max(...raw.map((r) => r.score ?? 0), 0.01)
    : 1;

  for (const match of raw) {
    if (!passesFilters(match.item.path, graph, filters)) continue;

    const fuseScore = match.score ?? 0;
    const normalizedScore = 1 - (fuseScore / maxFuseScore) * 0.9;

    results.push({
      path: match.item.path,
      title: match.item.title,
      excerpt: leadExcerpt(match.item.bodySnippet, match.item.tags),
      score: normalizedScore,
      matchedTerms: [],
      matchType: "fuzzy",
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Tier 3 — Semantic search over local Ollama embeddings.
 *
 * Returns nothing when the tier is disabled, still warming up, or Ollama is not
 * running, which is what makes it safe to call unconditionally: the cascade
 * treats an unavailable tier and an unhelpful one identically.
 */
export async function semanticSearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<SearchResult[]> {
  const index = getSemanticIndex(graph);
  if (!index) return [];

  const hits = await index.search(query, limit, (path) =>
    passesFilters(path, graph, filters),
  );

  return hits.map((hit) => {
    const node = graph.getNode(hit.path);
    return {
      path: hit.path,
      title: node?.title ?? hit.path,
      excerpt: leadExcerpt(node?.bodySnippet ?? "", node?.tags ?? []),
      score: Number(hit.score.toFixed(4)),
      matchedTerms: [],
      matchType: "semantic" as const,
    };
  });
}

// ─── Cascade ──────────────────────────────────────────────────────────────────

/**
 * One search result. `matchedBy` names the tiers that surfaced it, which
 * subsumes a separate match-type field.
 */
export interface CascadeHit {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  heading: string | null;
  matchedBy: string[];
}

export interface CascadeResult {
  results: CascadeHit[];
  /**
   * Tiers that put at least one note into the answer.
   *
   * Deliberately not the same list as `tiersRan`: knowing which tier earned
   * its keep is what tells you whether escalation was worth the cost.
   */
  tiersUsed: string[];
  /**
   * Tiers that actually executed, whether or not they found anything.
   *
   * Without this, a tier that ran and cleared nothing looks exactly like a tier
   * that never ran — and the difference is the whole diagnosis. A reader who
   * sees only `["lexical"]` on an escalated query cannot tell "the semantic
   * tier is not wired up" from "the semantic tier ran and nothing passed the
   * similarity floor", and has no way to find out from the outside.
   */
  tiersRan: string[];
  /** Why the cascade escalated past lexical, or null if it never needed to. */
  escalation: string | null;
  /** Matches before the limit was applied, when the tier can count them. */
  totalMatched?: number;
}

/**
 * Fuzzy matching answers "did you mean this note?", which only makes sense for a
 * query shaped like a name. It is also by far the most expensive tier — measured
 * at 5k notes it costs 360x BM25 for a one-word query and 3000x for four words,
 * because bitap runs per token per document. A natural-language question would
 * therefore pay the most for the tier least able to answer it.
 */
const FUZZY_MAX_QUERY_TOKENS = 3;

/**
 * Floor on the lexical tier's vote once the cascade has escalated. Even a query
 * it only partly matched carries signal, so it is down-weighted rather than
 * silenced.
 */
const LEXICAL_MIN_WEIGHT = 0.3;

/**
 * Rank-fusion damping constant.
 *
 * The classic value is 60, chosen for fusing many IR systems of *similar*
 * quality, where flattening the curve stops any one system's ordering from
 * dominating. These three tiers are of deliberately different quality and are
 * already weighted by evidence, so suppressing their internal ordering as well
 * discards signal twice. Measured on a 360-note vault, dropping to 10 improved
 * four of fifteen golden cases and regressed none — the clearest being a note
 * the semantic tier ranked first, which moved from rank 9 to rank 1.
 */
const RRF_K = 10;

/**
 * Tiered search with escalation on evidence of lexical failure.
 *
 * Escalation is driven by *coverage* rather than result count: BM25 happily
 * returns a full page of documents that each matched a single query term, so
 * "enough results" says nothing about whether any of them answered the query.
 * When no result covers the whole query, the fuzzy and semantic tiers run and
 * all three rankings are fused.
 *
 * The escalation gate is also what keeps the semantic tier affordable. A query
 * BM25 answers completely never pays for an embedding round trip, so the cost
 * lands only on the queries where matching words already failed.
 */
export async function cascadeSearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters: SearchFilters | undefined,
): Promise<CascadeResult> {
  const accept = (path: string) => passesFilters(path, graph, filters);
  const candidateDepth = Math.max(limit * 3, 20);
  const tiersUsed: string[] = [];
  const tiersRan: string[] = [];

  // Reconcile vectors on every search, not just the ones that reach the semantic
  // tier. Escalation is rare in an entity-keyed vault, so hanging re-embedding
  // off it meant a vault could be edited all day and stay stale until some query
  // happened to need meaning. Costs a version comparison when nothing changed.
  getSemanticIndex(graph)?.ensureFresh(graph);
  // ── Tier 0: exact frontmatter value ────────────────────────────────
  // An identifier query is answered by whole-value equality or not at all;
  // letting term scoring handle it produces confident matches on a fragment
  // ("ACC-NORTHWIND-001" hitting the token "northwind" in a title).
  //
  // Gated on the query not naming a note: "Contoso" and "Dave Wilson" are also
  // frontmatter values (customer:, action_owners:), and short-circuiting on
  // those would suppress the very note the user named.
  if (!graph.resolveTitle(query.trim())) {
    tiersRan.push("frontmatter");
    const exact = exactFieldSearch(graph, query, accept);
    if (exact.length > 0) {
      tiersUsed.push("frontmatter");
      // Whole-value equality gives no relevance signal to rank by, and the
      // index's own order is insertion order — which shifts whenever a note is
      // re-indexed after an edit. Sorting by path keeps the window an agent
      // sees stable across turns; a category value like `status: at-risk` can
      // otherwise match hundreds of notes and silently return a different ten.
      const ordered = [...exact].sort((a, b) => a.path.localeCompare(b.path));
      return {
        results: ordered.slice(0, limit).map((hit) => ({
          path: hit.path,
          title: hit.title,
          excerpt: `${hit.key}: ${hit.value}`,
          score: 1,
          heading: null,
          matchedBy: [`frontmatter:${hit.key}`],
        })),
        tiersUsed,
        tiersRan,
        escalation: null,
        totalMatched: ordered.length,
      };
    }
  }
  // ── Tier 1: BM25 ────────────────────────────────────────────────────────
  const lexical = lexicalSearch(graph, query, candidateDepth, filters);
  tiersRan.push("lexical");
  tiersUsed.push("lexical");

  const queryTermCount = tokenize(query).length;
  const fullCoverage =
    lexical.length > 0 && lexical[0].matchedTerms.length >= queryTermCount;

  // Confident lexical answer: full query coverage and enough results.
  if (fullCoverage && lexical.length >= limit) {
    return {
      results: lexical.slice(0, limit).map(toCascadeHit),
      tiersUsed,
      tiersRan,
      escalation: null,
    };
  }

  const escalation = !fullCoverage ? "partial_term_coverage" : "insufficient_results";

  // ── Tier 2: fuzzy — recovers typos and near-miss titles ────────────────
  const fuzzyRan = queryTermCount <= FUZZY_MAX_QUERY_TOKENS;
  const fuzzy = fuzzyRan ? fuzzySearch(graph, query, candidateDepth, filters) : [];
  if (fuzzyRan) tiersRan.push("fuzzy");
  if (fuzzy.length > 0) tiersUsed.push("fuzzy");

  // ── Tier 3: semantic — recovers notes that share no words with the query ─
  //
  // Gated on coverage alone, never on result count. A query whose every term was
  // matched has already been understood; there simply are not more notes about
  // it, and paying for an embedding round trip cannot conjure any.
  const semantic = fullCoverage
    ? []
    : await semanticSearch(graph, query, candidateDepth, filters);
  // Asked, and answered. `semanticSearch` returns an empty list both for "the
  // tier is off or Ollama is down" and for "nothing cleared the floor", so the
  // call alone does not establish that the tier ran — and reporting a tier that
  // could not serve as having run would be the same untruth in a new place.
  // Checked after the await: a mid-search failure flips the status.
  if (!fullCoverage && getSemanticIndex(graph)?.status === "ready") {
    tiersRan.push("semantic");
  }
  if (semantic.length > 0) tiersUsed.push("semantic");

  // ── Tier 2b: last-resort fuzzy pass over body prose ─────────────────────
  //
  // Same gate as the semantic tier: BM25 did not understand the whole query, so
  // a misspelling is on the table and the one place a misspelling can still hide
  // is body text. Measured on a 610-note vault this fires on 6% of realistic
  // queries and 0% of the fully covered ones that already returned at tier 1,
  // which is what keeps the cost win — the expensive pass only runs where the
  // cheap path has demonstrably come up short.
  //
  // Semantic cannot stand in for it: single-word queries against whole-note
  // embeddings land in a 0.39–0.58 cosine band that straddles the relevance
  // floor, so even correctly spelled words like "understaffed" and "peering"
  // score below it.
  const fuzzyBody =
    !fullCoverage && queryTermCount <= FUZZY_MAX_QUERY_TOKENS
      ? fuzzyBodySearch(graph, query, candidateDepth, filters)
      : [];
  if (fuzzyBody.length > 0 && !tiersUsed.includes("fuzzy")) tiersUsed.push("fuzzy");

  // Trust the lexical ranking in proportion to how much of the query it
  // actually matched. A query it barely understood is exactly the case where its
  // opinion should not outweigh a tier that did. Floored so a partial match
  // still counts for something rather than being discarded outright.
  const coverage =
    lexical.length > 0 && queryTermCount > 0
      ? lexical[0].matchedTerms.length / queryTermCount
      : 0;
  const lexicalWeight = Math.max(LEXICAL_MIN_WEIGHT, Math.min(1, coverage));

  const fused = reciprocalRankFusion([
    { name: "lexical", paths: lexical.map((h) => h.path), weight: lexicalWeight },
    { name: "fuzzy", paths: fuzzy.map((h) => h.path) },
    { name: "semantic", paths: semantic.map((h) => h.path) },
    // Half weight: a body-prose fuzzy hit is the weakest evidence in the
    // cascade, so it fills the tail rather than displacing a tier that matched
    // the query where it was actually indexed.
    { name: "fuzzy", paths: fuzzyBody.map((h) => h.path), weight: 0.5 },
  ]);

  const excerpts = new Map(
    [...fuzzyBody, ...semantic, ...fuzzy, ...lexical].map((hit) => [hit.path, hit.excerpt]),
  );

  // Normalise to the top hit, matching the confident-lexical path above. Raw
  // RRF sums are reciprocal ranks — a single-tier top hit is always 1/61 ≈ 0.016
  // and two agreeing tiers 0.033 — so leaving them raw made the same field mean
  // different things depending on whether the query happened to escalate.
  const topScore = fused[0]?.score || 1;

  const results = fused.slice(0, limit).map((entry) => {
    const node = graph.getNode(entry.path);
    return {
      path: entry.path,
      title: node?.title ?? entry.path,
      excerpt: excerpts.get(entry.path) ?? (node?.tags ?? []).join(", "),
      score: Number((entry.score / topScore).toFixed(4)),
      heading: null,
      matchedBy: entry.sources,
    };
  });

  return { results, tiersUsed, tiersRan, escalation };
}

/** Adapt a single-tier hit to the cascade's response shape. */
function toCascadeHit(hit: SearchResult): CascadeHit {
  return {
    path: hit.path,
    title: hit.title,
    excerpt: hit.excerpt,
    score: hit.score,
    heading: null,
    matchedBy: [hit.matchType],
  };
}

/**
 * Reciprocal Rank Fusion, weighted by how much of the query each tier understood.
 *
 * BM25 and fuse.js scores live on incomparable scales, so blending the raw
 * numbers lets whichever tier emits larger values dominate. RRF discards
 * magnitudes and combines ranks instead, needing no per-corpus tuning.
 *
 * Equal weights, however, let a tier that matched one word of a seven-word
 * question outvote one that matched its meaning: two tiers agreeing at rank 0
 * sum to ~0.033, beating a single confident hit at ~0.016. Measured on a
 * 360-note vault, a note the semantic tier ranked first fell out of the top ten
 * entirely because a dozen notes merely mentioned a query word. Each list now
 * carries a weight, so a tier's say is proportional to its evidence.
 */
function reciprocalRankFusion(
  lists: Array<{ name: string; paths: string[]; weight?: number }>,
  k = RRF_K,
): Array<{ path: string; score: number; sources: string[] }> {
  const scores = new Map<string, { score: number; sources: string[] }>();

  for (const list of lists) {
    const seen = new Set<string>();
    list.paths.forEach((path, index) => {
      if (seen.has(path)) return;
      seen.add(path);
      const entry = scores.get(path) ?? { score: 0, sources: [] };
      entry.score += (list.weight ?? 1) / (k + index + 1);
      if (!entry.sources.includes(list.name)) entry.sources.push(list.name);
      scores.set(path, entry);
    });
  }

  return [...scores.entries()]
    .map(([path, entry]) => ({ path, ...entry }))
    .sort((a, b) => b.score - a.score);
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface SearchFilters {
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

/**
 * Folders kept out of search results.
 *
 * Applied here rather than at indexing time so graph traversal, frontmatter
 * queries and the audit log still see every note — the goal is to stop tooling
 * and archives competing with knowledge in a ranked list, not to make them
 * invisible. Set through `search.exclude_folders` or `OIL_EXCLUDE_FOLDERS`.
 */
let excludedFolders: string[] = [];

export function setExcludedFolders(folders: string[]): void {
  excludedFolders = folders.filter((f) => f.trim() !== "").map((f) => f.replace(/\/*$/, "/"));
}

export function getExcludedFolders(): string[] {
  return [...excludedFolders];
}

function passesFilters(
  path: string,
  graph: GraphIndex,
  filters?: SearchFilters,
): boolean {
  // An explicit folder filter is the caller asking for that folder specifically,
  // so it wins over the vault-level exclusion.
  if (!filters?.folder && excludedFolders.some((prefix) => path.startsWith(prefix))) {
    return false;
  }

  if (!filters) return true;

  if (filters.folder && !path.startsWith(filters.folder)) {
    return false;
  }

  if (filters.tags?.length) {
    const node = graph.getNode(path);
    if (!node) return false;
    if (!filters.tags.some((t) => node.tags.includes(t))) {
      return false;
    }
  }

  if (filters.frontmatter) {
    const node = graph.getNode(path);
    if (!node) return false;
    for (const [key, value] of Object.entries(filters.frontmatter)) {
      if (node.frontmatter[key] !== value) return false;
    }
  }

  return true;
}
