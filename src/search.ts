/**
 * OIL — Search Engine
 * Tier 1: Lexical (substring match). Tier 2: Fuzzy (fuse.js).
 * Default behaviour: lexical first, fuzzy fallback when lexical returns < limit.
 */

import Fuse from "fuse.js";
import type { GraphIndex } from "./graph.js";
import type { SearchResult, OilConfig } from "./types.js";

// ─── Search Index Entry ───────────────────────────────────────────────────────

interface SearchEntry {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  bodySnippet: string;
}

// ─── Fuse Index Cache ─────────────────────────────────────────────────────────

let fuseIndex: Fuse<SearchEntry> | null = null;
let indexedNodeCount = 0;

/**
 * Build or return the cached fuse.js search index.
 * Rebuilds when the graph node count changes.
 */
function getOrBuildIndex(graph: GraphIndex): Fuse<SearchEntry> {
  if (fuseIndex && graph.nodeCount === indexedNodeCount) {
    return fuseIndex;
  }

  const entries: SearchEntry[] = [];
  // Iterate all notes via getNotesByFolder("") — matches all
  const allRefs = graph.getNotesByFolder("");
  for (const ref of allRefs) {
    const node = graph.getNode(ref.path);
    if (!node) continue;

    entries.push({
      path: node.path,
      title: node.title,
      tags: node.tags,
      headings: node.headings,
      bodySnippet: node.bodySnippet ?? "",
    });
  }

  fuseIndex = new Fuse(entries, {
    keys: [
      { name: "title", weight: 3 },
      { name: "tags", weight: 2 },
      { name: "headings", weight: 1 },
      { name: "bodySnippet", weight: 0.5 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    useExtendedSearch: false,
  });
  indexedNodeCount = graph.nodeCount;

  return fuseIndex;
}

/**
 * Invalidate the fuse index so it rebuilds on next search.
 */
export function invalidateSearchIndex(): void {
  fuseIndex = null;
  indexedNodeCount = 0;
}

// ─── Search Functions ─────────────────────────────────────────────────────────

/**
 * Tier 1 — Lexical search: substring match on titles and tags.
 */
export function lexicalSearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  const allRefs = graph.getNotesByFolder("");
  for (const ref of allRefs) {
    if (!passesFilters(ref.path, graph, filters)) continue;

    const node = graph.getNode(ref.path);
    const titleMatch = ref.title.toLowerCase().includes(q);
    const tagMatch = ref.tags.some((t) => t.toLowerCase().includes(q));
    const headingMatch = node?.headings.some((h) => h.toLowerCase().includes(q)) ?? false;
    const bodyMatch = node?.bodySnippet?.toLowerCase().includes(q) ?? false;

    if (titleMatch || tagMatch || headingMatch || bodyMatch) {
      // Build a contextual excerpt for body matches
      let excerpt = ref.tags.join(", ");
      if (bodyMatch && !titleMatch && !tagMatch && !headingMatch && node?.bodySnippet) {
        const idx = node.bodySnippet.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 40);
        const end = Math.min(node.bodySnippet.length, idx + q.length + 40);
        excerpt = (start > 0 ? "…" : "") + node.bodySnippet.slice(start, end).trim() + (end < node.bodySnippet.length ? "…" : "");
      }
      results.push({
        path: ref.path,
        title: ref.title,
        excerpt,
        score: titleMatch ? 1.0 : headingMatch ? 0.85 : tagMatch ? 0.7 : 0.5,
        matchType: "lexical",
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
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
  const raw = fuse.search(query, { limit: limit * 2 });

  const results: SearchResult[] = [];
  for (const match of raw) {
    if (!passesFilters(match.item.path, graph, filters)) continue;

    results.push({
      path: match.item.path,
      title: match.item.title,
      excerpt: match.item.tags.join(", "),
      score: 1 - (match.score ?? 0),
      matchType: "fuzzy",
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Unified search — cascades lexical → fuzzy by default.
 * When no explicit tier is given, tries lexical first (3ms).
 * Falls back to fuzzy (65-180ms) only when lexical returns fewer than `limit` results.
 * An explicit tier skips the cascade and runs only that tier.
 */
export function searchVault(
  graph: GraphIndex,
  _config: OilConfig,
  query: string,
  tier?: "lexical" | "fuzzy",
  limit: number = 10,
  filters?: SearchFilters,
): SearchResult[] {
  // Explicit tier — run only that tier
  if (tier === "lexical") return lexicalSearch(graph, query, limit, filters);
  if (tier === "fuzzy") return fuzzySearch(graph, query, limit, filters);

  // Default: lexical first, fuzzy fallback if insufficient results
  const lexResults = lexicalSearch(graph, query, limit, filters);
  if (lexResults.length >= limit) return lexResults;

  // Lexical didn't fill the limit — augment with fuzzy
  const fuzzyResults = fuzzySearch(graph, query, limit, filters);
  const seen = new Set(lexResults.map((r) => r.path));
  const merged = [...lexResults];
  for (const r of fuzzyResults) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    merged.push(r);
    if (merged.length >= limit) break;
  }
  return merged;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface SearchFilters {
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

function passesFilters(
  path: string,
  graph: GraphIndex,
  filters?: SearchFilters,
): boolean {
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
