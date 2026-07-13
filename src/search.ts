import Fuse from "fuse.js";
import type { GraphIndex } from "./graph.js";
import type { GraphNode, OilConfig, SearchResult } from "./types.js";
import { flattenFrontmatter, scalarSearchValues, searchableFrontmatterText } from "./catalog.js";

interface SearchEntry {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  description: string;
  headings: string[];
  frontmatterText: string;
  linkText: string;
  normalized: {
    path: string;
    title: string;
    aliases: string[];
    tags: string[];
    description: string;
    headings: string[];
    linkText: string;
    frontmatter: Array<{ rawKey: string; key: string; values: Array<{ raw: string; lower: string }> }>;
  };
}

export interface SearchFilters {
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
  type?: string;
}

export interface SearchCandidateSet {
  results: SearchResult[];
  totalCandidates: number;
  indicesConsulted: string[];
  candidateGenerationCapped: boolean;
}

let searchCaches = new WeakMap<GraphIndex, {
  generation: string;
  entries: SearchEntry[];
  fuse: Fuse<SearchEntry>;
}>();

function getOrBuildSearchCache(graph: GraphIndex) {
  const cached = searchCaches.get(graph);
  if (cached?.generation === graph.generation) return cached;

  const entries: SearchEntry[] = graph.getNotesByFolder("").flatMap((ref) => {
    const node = graph.getNode(ref.path);
    if (!node) return [];
    const frontmatter = flattenFrontmatter(node.path, node.frontmatter).map((entry) => ({
      rawKey: entry.rawKey,
      key: entry.rawKey.toLowerCase(),
      values: scalarSearchValues(entry.value).map((value) => ({ raw: value, lower: value.toLowerCase() })),
    }));
    const linkText = node.links.flatMap((edge) => [edge.target, edge.label ?? ""]).join(" ");
    return [{
      path: node.path,
      title: node.title,
      aliases: node.aliases,
      tags: node.tags,
      description: node.description,
      headings: node.headings,
      frontmatterText: searchableFrontmatterText(node.frontmatter),
      linkText,
      normalized: {
        path: node.path.toLowerCase(),
        title: node.title.toLowerCase(),
        aliases: node.aliases.map((alias) => alias.toLowerCase()),
        tags: node.tags.map((tag) => tag.toLowerCase()),
        description: node.description.toLowerCase(),
        headings: node.headings.map((heading) => heading.toLowerCase()),
        linkText: linkText.toLowerCase(),
        frontmatter,
      },
    }];
  });

  const fuse = new Fuse(entries, {
    keys: [
      { name: "title", weight: 4 },
      { name: "path", weight: 3.5 },
      { name: "aliases", weight: 3.25 },
      { name: "frontmatterText", weight: 2.5 },
      { name: "tags", weight: 2 },
      { name: "description", weight: 1.5 },
      { name: "headings", weight: 1.25 },
      { name: "linkText", weight: 0.75 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    useExtendedSearch: false,
  });
  const next = { generation: graph.generation, entries, fuse };
  searchCaches.set(graph, next);
  return next;
}

export function invalidateSearchIndex(): void {
  searchCaches = new WeakMap();
}

export function lexicalSearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q || limit <= 0) return [];
  const results: SearchResult[] = [];

  for (const entry of getOrBuildSearchCache(graph).entries) {
    const node = graph.getNode(entry.path);
    if (!node || !passesFilters(node, graph, filters)) continue;
    const match = lexicalFeatures(entry, node, q);
    if (!match) continue;
    results.push({
      path: node.path,
      title: node.title,
      excerpt: match.excerpt,
      score: match.score,
      matchType: "lexical",
      matchedOn: match.matchedOn,
    });
  }

  return results
    .sort(compareSearchResults)
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function fuzzySearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  if (!query.trim() || limit <= 0) return [];
  const raw = getOrBuildSearchCache(graph).fuse.search(query, {
    limit: Math.min(graph.nodeCount, Math.max(Math.floor(limit) * 3, Math.floor(limit))),
  });
  const results: SearchResult[] = [];

  for (const match of raw) {
    const node = graph.getNode(match.item.path);
    if (!node || !passesFilters(node, graph, filters)) continue;
    const fuseScore = match.score ?? 1;
    results.push({
      path: node.path,
      title: node.title,
      excerpt: bestFuzzyExcerpt(node, query),
      score: clampScore(1 - fuseScore),
      matchType: "fuzzy",
      matchedOn: ["fuzzy"],
    });
    if (results.length >= limit) break;
  }
  return results.sort(compareSearchResults);
}

/**
 * Generate candidates from all enabled indices and calibrate the union once.
 * The result is deliberately unsliced so tool-level pagination can report totals.
 */
export function searchVaultCandidates(
  graph: GraphIndex,
  query: string,
  tier?: "lexical" | "fuzzy",
  filters?: SearchFilters,
  candidateCap = graph.nodeCount,
): SearchCandidateSet {
  const cap = Math.max(20, candidateCap);
  if (tier === "lexical") {
    const results = lexicalSearch(graph, query, cap, filters);
    return {
      results,
      totalCandidates: results.length,
      indicesConsulted: ["path", "title", "aliases", "frontmatter", "tags", "description", "headings", "body", "links"],
      candidateGenerationCapped: results.length === cap && graph.nodeCount > cap,
    };
  }
  if (tier === "fuzzy") {
    const results = fuzzySearch(graph, query, cap, filters);
    return {
      results,
      totalCandidates: results.length,
      indicesConsulted: ["fuzzy"],
      candidateGenerationCapped: results.length === cap && graph.nodeCount > cap,
    };
  }

  const lexical = lexicalSearch(graph, query, cap, filters);
  const fuzzyCap = Math.min(cap, 50);
  const fuzzyApplicable = lexical.length < Math.min(cap, 50);
  const fuzzy = fuzzyApplicable ? fuzzySearch(graph, query, fuzzyCap, filters) : [];
  const fuzzyGenerationCapped = fuzzyApplicable
    && fuzzy.length === fuzzyCap
    && graph.nodeCount > fuzzyCap;
  const fused = new Map<string, SearchResult>();
  for (const result of [...lexical, ...fuzzy]) {
    const existing = fused.get(result.path);
    if (!existing) {
      fused.set(result.path, { ...result, matchedOn: [...(result.matchedOn ?? [])] });
      continue;
    }
    const lexicalResult = existing.matchType === "lexical"
      ? existing
      : result.matchType === "lexical"
        ? result
        : undefined;
    const stronger = result.score > existing.score ? result : existing;
    fused.set(result.path, {
      ...stronger,
      matchType: lexicalResult ? "lexical" : stronger.matchType,
      matchedOn: [...new Set([...(existing.matchedOn ?? []), ...(result.matchedOn ?? [])])],
    });
  }

  const results = [...fused.values()].sort(compareSearchResults).slice(0, cap);
  return {
    results,
    totalCandidates: results.length,
    indicesConsulted: [
      "path", "title", "aliases", "frontmatter", "tags", "description", "headings", "body", "links",
      ...(fuzzyApplicable ? ["fuzzy"] : []),
    ],
    candidateGenerationCapped:
      fuzzyGenerationCapped || (results.length === cap && graph.nodeCount > cap),
  };
}

export function searchVault(
  graph: GraphIndex,
  _config: OilConfig,
  query: string,
  tier?: "lexical" | "fuzzy",
  limit = 10,
  filters?: SearchFilters,
): SearchResult[] {
  const safeLimit = Math.min(20, Math.max(0, Math.floor(limit)));
  return searchVaultCandidates(graph, query, tier, filters, Math.max(20, safeLimit * 5))
    .results
    .slice(0, safeLimit);
}

function lexicalFeatures(
  entry: SearchEntry,
  node: GraphNode,
  query: string,
): { score: number; matchedOn: string[]; excerpt: string } | null {
  let score = 0;
  const matchedOn: string[] = [];
  let excerpt = node.tags.join(", ") || node.description.slice(0, 220);
  const consider = (matched: boolean, candidateScore: number, signal: string, candidateExcerpt?: string): void => {
    if (!matched) return;
    matchedOn.push(signal);
    if (candidateScore > score) {
      score = candidateScore;
      if (candidateExcerpt !== undefined) excerpt = candidateExcerpt;
    }
  };

  const path = entry.normalized.path;
  const title = entry.normalized.title;
  consider(path === query, 1, "path", node.path);
  consider(title === query, 1, "title", node.description || node.title);
  consider(path.includes(query) && path !== query, 0.98, "path", node.path);
  consider(title.includes(query) && title !== query, 0.97, "title", node.description || node.title);

  for (let index = 0; index < node.aliases.length; index++) {
    const alias = node.aliases[index];
    const lower = entry.normalized.aliases[index];
    consider(lower === query, 0.99, "alias", alias);
    consider(lower.includes(query) && lower !== query, 0.95, "alias", alias);
  }

  for (const signal of entry.normalized.frontmatter) {
    const keyMatch = signal.key.includes(query);
    consider(keyMatch, 0.72, `frontmatter.${signal.rawKey}`, signal.rawKey);
    for (const value of signal.values) {
      consider(value.lower === query, 0.99, `frontmatter.${signal.rawKey}`, `${signal.rawKey}: ${value.raw}`);
      consider(value.lower.includes(query) && value.lower !== query, 0.9, `frontmatter.${signal.rawKey}`, `${signal.rawKey}: ${value.raw}`);
    }
  }

  consider(entry.normalized.description.includes(query), 0.8, "description", node.description.slice(0, 220));
  for (let index = 0; index < node.headings.length; index++) {
    consider(entry.normalized.headings[index].includes(query), 0.85, "heading", node.headings[index]);
  }
  for (const tag of entry.normalized.tags) {
    consider(tag.includes(query), 0.7, "tag", node.tags.join(", "));
  }
  if (entry.normalized.linkText.includes(query)) {
    const edge = node.links.find((candidate) => `${candidate.target} ${candidate.label ?? ""}`.toLowerCase().includes(query));
    consider(true, 0.65, "link", edge?.context ?? edge?.target);
  }

  const bodyIndex = node.bodyText.toLowerCase().indexOf(query);
  consider(bodyIndex >= 0, 0.5, "body", bodyIndex >= 0 ? contextualSnippet(node.bodyText, bodyIndex, query.length) : undefined);
  return score > 0 ? { score, matchedOn: [...new Set(matchedOn)], excerpt: excerpt.slice(0, 240) } : null;
}

function passesFilters(node: GraphNode, graph: GraphIndex, filters?: SearchFilters): boolean {
  if (!filters) return true;
  if (filters.folder && !node.path.startsWith(filters.folder)) return false;
  if (filters.type && node.type.toLowerCase() !== filters.type.toLowerCase()) return false;
  if (filters.tags?.length && !filters.tags.some(
    (tag) => node.tags.some((nodeTag) => nodeTag.toLowerCase() === tag.toLowerCase()),
  )) return false;
  if (filters.frontmatter) {
    for (const [requestedKey, expected] of Object.entries(filters.frontmatter)) {
      const resolved = graph.resolveFrontmatterField(requestedKey);
      if (!resolved.known) return false;
      const values = graph.getFrontmatterEntries(resolved.key)
        .filter((entry) => entry.path === node.path)
        .map((entry) => entry.value);
      if (!values.some((actual) => valuesEqual(actual, expected))) return false;
    }
  }
  return true;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((value) => valuesEqual(value, expected));
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

function contextualSnippet(content: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + queryLength + 140);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ").trim()}${end < content.length ? "…" : ""}`;
}

function bestFuzzyExcerpt(node: GraphNode, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = node.bodyText.toLowerCase();
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0) return contextualSnippet(node.bodyText, index, term.length).slice(0, 220);
  }
  return (node.description || node.tags.join(", ") || node.title).slice(0, 220);
}

function compareSearchResults(a: SearchResult, b: SearchResult): number {
  return b.score - a.score
    || (a.matchType === b.matchType ? 0 : a.matchType === "lexical" ? -1 : 1)
    || a.path.localeCompare(b.path);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}
