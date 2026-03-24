/**
 * OIL — Retrieve tools
 * Higher-level retrieval tools: search, query, similarity, frontmatter index.
 * All fully autonomous (no confirmation gate).
 */

import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig, NoteRef } from "../types.js";
import { validateVaultPath, validationError } from "../validation.js";
import { readNote, securePath } from "../vault.js";
import { fuzzySearch, searchVault } from "../search.js";
import type { EmbeddingIndex } from "../embeddings.js";
import type { SearchResult } from "../types.js";

// ─── Frontmatter Index ────────────────────────────────────────────────────────

interface FrontmatterIndexEntry {
  path: string;
  value: string;
}

/** Module-level frontmatter index — rebuilt on invalidation. */
let _frontmatterIndex: Map<string, FrontmatterIndexEntry[]> | null = null;

function buildFrontmatterIndex(graph: GraphIndex): Map<string, FrontmatterIndexEntry[]> {
  const index = new Map<string, FrontmatterIndexEntry[]>();
  const all = graph.getNotesByFolder("");

  for (const ref of all) {
    const node = graph.getNode(ref.path);
    if (!node) continue;

    for (const [rawKey, rawValue] of Object.entries(node.frontmatter)) {
      const key = rawKey.toLowerCase();
      const values = normalizeFrontmatterValues(rawValue);
      if (values.length === 0) continue;

      const bucket = index.get(key) ?? [];
      for (const value of values) {
        bucket.push({ path: node.path, value });
      }
      index.set(key, bucket);
    }
  }

  return index;
}

function normalizeFrontmatterValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value).toLowerCase()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
      .map((entry) => String(entry).toLowerCase());
  }
  // Nested objects — stringify so they're at least findable
  if (typeof value === "object" && value !== null) {
    return [JSON.stringify(value).toLowerCase()];
  }
  return [];
}

/**
 * Get or build the frontmatter index. Cached at module level.
 */
function getOrBuildFrontmatterIndex(graph: GraphIndex): Map<string, FrontmatterIndexEntry[]> {
  if (!_frontmatterIndex) {
    _frontmatterIndex = buildFrontmatterIndex(graph);
  }
  return _frontmatterIndex;
}

/**
 * Invalidate the frontmatter index so it rebuilds on next query.
 * Call this from the file watcher when notes change.
 */
export function invalidateFrontmatterIndex(): void {
  _frontmatterIndex = null;
}

// ─── Content Search (fallback) ────────────────────────────────────────────────

/**
 * Full-content term frequency search — reads every note from disk.
 * Expensive but guarantees any detail can be found when fuzzy/lexical miss.
 */
async function contentSearch(
  graph: GraphIndex,
  vaultPath: string,
  query: string,
  limit: number,
): Promise<Array<{ path: string; title: string; score: number }>> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 2);

  if (terms.length === 0) return [];

  const scored: Array<{ path: string; title: string; score: number }> = [];
  const refs = graph.getNotesByFolder("");

  for (const ref of refs) {
    try {
      const note = await readNote(vaultPath, ref.path);
      const lower = note.content.toLowerCase();

      let totalHits = 0;
      for (const term of terms) {
        let idx = lower.indexOf(term);
        while (idx >= 0) {
          totalHits++;
          idx = lower.indexOf(term, idx + term.length);
        }
      }

      if (totalHits > 0) {
        scored.push({
          path: ref.path,
          title: ref.title,
          score: Math.min(totalHits / terms.length / 10, 1),
        });
      }
    } catch {
      continue;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Build a contextual snippet around the first matching term.
 */
function getWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 2);

  const lower = compact.toLowerCase();
  let firstIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      firstIdx = idx;
      break;
    }
  }

  if (firstIdx < 0) {
    return compact.slice(0, 220);
  }

  const start = Math.max(0, firstIdx - 80);
  const end = Math.min(compact.length, firstIdx + 140);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

/**
 * Register all Retrieve tools on the MCP server.
 */
export function registerRetrieveTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  _cache: SessionCache,
  _config: OilConfig,
  embeddings: EmbeddingIndex | null,
): void {
  // Invalidate module-level frontmatter index so it rebuilds from the current graph
  invalidateFrontmatterIndex();

  server.registerTool(
    "search_vault",
    {
      description: "Unified search across lexical and fuzzy tiers. Returns ranked results matching the query.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        tier: z
          .enum(["lexical", "fuzzy", "semantic"])
          .optional()
          .describe("Search tier (default: from config)"),
        limit: z.number().optional().describe("Max results (default: 10)"),
        filter_folder: z.string().optional().describe("Restrict to this folder prefix"),
        filter_tags: z.array(z.string()).optional().describe("Restrict to notes with these tags"),
      },
    },
    async ({ query, tier, limit, filter_folder, filter_tags }) => {
      if (filter_folder) {
        const folderErr = validateVaultPath(filter_folder);
        if (folderErr) return validationError(`search_vault: filter_folder — ${folderErr}`);
      }

      const boundedLimit = limit ?? 10;
      let results = await searchVault(graph, _config, query, tier, boundedLimit, {
        folder: filter_folder,
        tags: filter_tags,
      }, embeddings);

      // Content search fallback: if tier 1/2 didn't find enough, search full note bodies
      if (results.length < boundedLimit && tier !== "semantic") {
        const contentMatches = await contentSearch(graph, vaultPath, query, boundedLimit);
        const seen = new Set(results.map((r: SearchResult) => r.path));
        for (const candidate of contentMatches) {
          if (seen.has(candidate.path)) continue;
          // Respect folder/tag filters from the primary search
          if (filter_folder && !candidate.path.startsWith(filter_folder)) continue;
          if (filter_tags && filter_tags.length > 0) {
            const node = graph.getNode(candidate.path);
            const nodeTags = node?.tags ?? [];
            if (!filter_tags.some((t) => nodeTags.includes(t))) continue;
          }
          try {
            const note = await readNote(vaultPath, candidate.path);
            results.push({
              path: candidate.path,
              title: candidate.title,
              excerpt: buildSnippet(note.content, query),
              score: candidate.score * 0.4, // downweight vs primary tiers
              matchType: "lexical" as const,
            });
            seen.add(candidate.path);
          } catch { continue; }
          if (results.length >= boundedLimit) break;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── query_notes ───────────────────────────────────────────────────────

  server.registerTool(
    "get_note_metadata",
    {
      description:
        "Peek at note metadata before loading full content. Returns frontmatter, creation/modification timestamps, word count, and headings.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
      },
    },
    async ({ path }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`get_note_metadata: ${pathErr}`);

      try {
        const parsed = await readNote(vaultPath, path);
        const fileStats = await stat(securePath(vaultPath, path));

        const result = {
          path: parsed.path,
          title: parsed.title,
          frontmatter: parsed.frontmatter,
          created_at: fileStats.birthtime.toISOString(),
          modified_at: fileStats.mtime.toISOString(),
          mtime_ms: fileStats.mtimeMs,
          word_count: getWordCount(parsed.content),
          headings: [...parsed.sections.keys()],
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read note metadata: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );

  // ── read_note_section ────────────────────────────────────────────────

  server.registerTool(
    "read_note_section",
    {
      description:
        "Read only a specific heading section from a note for token-efficient retrieval.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
        heading: z.string().describe("Heading text to extract (without markdown # markers)"),
      },
    },
    async ({ path, heading }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`read_note_section: ${pathErr}`);

      try {
        const parsed = await readNote(vaultPath, path);
        const section = parsed.sections.get(heading);

        if (section === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Section \"${heading}\" not found in ${path}`,
                  available_headings: [...parsed.sections.keys()],
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path,
                  heading,
                  content: section,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read section: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );

  // ── query_frontmatter ────────────────────────────────────────────────

  server.registerTool(
    "query_frontmatter",
    {
      description:
        "Fast frontmatter index lookup by key and value fragment. O(1) key lookup instead of full vault scan. Use for quick TPID, customer, status, or tag lookups.",
      inputSchema: {
        key: z.string().describe("Frontmatter key to search (e.g. 'tpid', 'customer', 'status')"),
        value_fragment: z.string().describe("Case-insensitive value fragment to match"),
      },
    },
    async ({ key, value_fragment }) => {
      const fmIndex = getOrBuildFrontmatterIndex(graph);
      const entries = fmIndex.get(key.toLowerCase()) ?? [];
      const fragment = value_fragment.toLowerCase();

      const paths = [...new Set(
        entries
          .filter((entry) => entry.value.includes(fragment))
          .map((entry) => entry.path),
      )].slice(0, 20);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { key, value_fragment, count: paths.length, paths },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── get_related_entities ──────────────────────────────────────────────

  server.registerTool(
    "get_related_entities",
    {
      description:
        "Graph traversal: returns notes linked to a given note up to N hops away. Returns refs without full content for token efficiency.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
        max_hops: z.number().optional().describe("Maximum link hops (default: 2)"),
      },
    },
    async ({ path, max_hops }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`get_related_entities: ${pathErr}`);

      const related = graph.getRelatedNotes(path, max_hops ?? 2);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ path, max_hops: max_hops ?? 2, related }, null, 2),
          },
        ],
      };
    },
  );

  // ── semantic_search ──────────────────────────────────────────────────

  server.registerTool(
    "semantic_search",
    {
      description:
        "Semantic search across vault notes. Returns ranked results with short snippets.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      },
    },
    async ({ query, limit }) => {
      const boundedLimit = limit ?? 10;

      // Use embedding index if available, otherwise fall back to fuzzy + content search
      let results: Array<{ path: string; title: string; snippet: string; score: number }>;

      if (embeddings) {
        const searchResults = await searchVault(graph, _config, query, "semantic", boundedLimit, {}, embeddings);
        results = await Promise.all(
          searchResults.map(async (r: SearchResult) => {
            let snippet = r.excerpt ?? "";
            if (!snippet) {
              try {
                const note = await readNote(vaultPath, r.path);
                snippet = buildSnippet(note.content, query);
              } catch { snippet = ""; }
            }
            return { path: r.path, title: r.title, snippet: snippet.slice(0, 220), score: r.score };
          }),
        );
      } else {
        // Fallback: fuzzy search + content search
        const fuzzyResults = fuzzySearch(graph, query, boundedLimit);
        const contentResults = await contentSearch(graph, vaultPath, query, boundedLimit);

        const seen = new Set<string>();
        const merged: Array<{ path: string; title: string; score: number }> = [];
        for (const r of [...fuzzyResults, ...contentResults]) {
          if (!seen.has(r.path)) {
            seen.add(r.path);
            merged.push(r);
          }
        }
        merged.sort((a, b) => b.score - a.score);

        results = await Promise.all(
          merged.slice(0, boundedLimit).map(async (r) => {
            let snippet = "";
            try {
              const note = await readNote(vaultPath, r.path);
              snippet = buildSnippet(note.content, query);
            } catch { /* skip */ }
            return { path: r.path, title: r.title, snippet: snippet.slice(0, 220), score: r.score };
          }),
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: results.length, results }, null, 2),
          },
        ],
      };
    },
  );
}
