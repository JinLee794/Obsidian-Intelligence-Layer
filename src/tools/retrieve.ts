/**
 * OIL — Retrieve tools
 * Higher-level retrieval tools: search, query, similarity, frontmatter index.
 * All fully autonomous (no confirmation gate).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig, NoteRef } from "../types.js";
import { validateVaultPath, validationError } from "../validation.js";
import { readNote } from "../vault.js";
import { queryNotes } from "../query.js";
import { searchVault } from "../search.js";
import type { EmbeddingIndex } from "../embeddings.js";

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
  cache: SessionCache,
  config: OilConfig,
  embeddings: EmbeddingIndex | null,
): void {
  // ── search_vault ──────────────────────────────────────────────────────

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
      let results = await searchVault(graph, config, query, tier, boundedLimit, {
        folder: filter_folder,
        tags: filter_tags,
      }, embeddings);

      // Content search fallback: if tier 1/2 didn't find enough, search full note bodies
      if (results.length < boundedLimit && tier !== "semantic") {
        const contentMatches = await contentSearch(graph, vaultPath, query, boundedLimit);
        const seen = new Set(results.map((r) => r.path));
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
    "query_notes",
    {
      description: "Frontmatter predicate query — relational-style filtering across all notes. The SQL-like layer for the vault.",
      inputSchema: {
        where: z
          .record(z.string(), z.unknown())
          .describe("Filter predicates: { field: value } matched against frontmatter"),
        and: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Additional predicates that ALL must match"),
        or: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Additional predicates where at LEAST ONE must match"),
        order_by: z
          .string()
          .optional()
          .describe("Field to sort by (prefix with - for descending)"),
        limit: z.number().optional().describe("Max results (default: all)"),
        folder: z.string().optional().describe("Restrict to notes in this folder prefix"),
      },
    },
    async ({ where, and, or, order_by, limit, folder }) => {
      if (folder) {
        const folderErr = validateVaultPath(folder);
        if (folderErr) return validationError(`query_notes: folder — ${folderErr}`);
      }

      const results = queryNotes(graph, config, {
        where,
        and,
        or,
        orderBy: order_by,
        limit,
        folder,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── find_similar_notes ────────────────────────────────────────────────

  server.registerTool(
    "find_similar_notes",
    {
      description: "Tag-based similarity to a given note — surfaces relevant patterns, comparable customers, or risk signals.",
      inputSchema: {
        path: z.string().describe("Note path to find similar notes for"),
        top_n: z.number().optional().describe("Max results (default: 5)"),
        method: z
          .enum(["tags", "semantic"])
          .optional()
          .describe("Similarity method (default: tags; semantic reserved for Phase 4)"),
      },
    },
    async ({ path, top_n, method }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`find_similar_notes: ${pathErr}`);

      const limit = top_n ?? 5;
      const sourceNode = graph.getNode(path);
      if (!sourceNode) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: `Note not found: ${path}` }) },
          ],
        };
      }

      // Semantic similarity when requested and available
      if (
        method === "semantic" &&
        embeddings &&
        (await embeddings.isAvailable())
      ) {
        const semanticResults = await embeddings.findSimilar(path, limit);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(semanticResults, null, 2) },
          ],
        };
      }

      // Tag-based similarity: count shared tags
      const sourceTags = new Set(sourceNode.tags);
      if (sourceTags.size === 0) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ results: [], message: "Source note has no tags" }) },
          ],
        };
      }

      const scored: { ref: NoteRef; score: number }[] = [];
      const allRefs = graph.getNotesByFolder("");
      for (const ref of allRefs) {
        if (ref.path === path) continue;
        const node = graph.getNode(ref.path);
        if (!node) continue;

        const shared = node.tags.filter((t) => sourceTags.has(t)).length;
        if (shared > 0) {
          // Jaccard-like score: shared / union
          const union = new Set([...sourceTags, ...node.tags]).size;
          scored.push({
            ref: { path: ref.path, title: ref.title, tags: ref.tags },
            score: shared / union,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const results = scored.slice(0, limit).map((s) => ({
        ...s.ref,
        similarityScore: Math.round(s.score * 100) / 100,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── read_note ─────────────────────────────────────────────────────────

  server.registerTool(
    "read_note",
    {
      description:
        "Read the full content of a note by path. Returns frontmatter, full markdown body, parsed sections, wikilinks, and tags. Use after search_vault or query_notes to retrieve actual note content.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root (e.g. 'Customers/Contoso.md')"),
        section: z
          .string()
          .optional()
          .describe("Return only the content under this heading (e.g. 'Opportunities')"),
      },
    },
    async ({ path, section }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`read_note: ${pathErr}`);

      try {
        const parsed = await readNote(vaultPath, path);

        if (section) {
          const sectionContent = parsed.sections.get(section);
          if (sectionContent === undefined) {
            const available = Array.from(parsed.sections.keys());
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Section "${section}" not found in ${path}`,
                    availableSections: available,
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  path: parsed.path,
                  title: parsed.title,
                  section,
                  content: sectionContent,
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                path: parsed.path,
                title: parsed.title,
                frontmatter: parsed.frontmatter,
                content: parsed.content,
                sections: Object.fromEntries(parsed.sections),
                wikilinks: parsed.wikilinks,
                tags: parsed.tags,
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to read note: ${err instanceof Error ? err.message : String(err)}`,
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
}
