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
import {
  errorCodeFromUnknown,
  errorResponse,
  jsonResponse,
  refField,
  truncateList,
  truncateText,
} from "../tool-responses.js";
import { validateVaultPath, validationError } from "../validation.js";
import { readNote, securePath } from "../vault.js";
import { cascadeSearch, semanticSearch, type CascadeHit } from "../search.js";
import { getSemanticIndex } from "../semantic.js";
import { queryNotes } from "../query.js";
import { flattenFrontmatter, normalizeValue } from "../frontmatter.js";

// ─── Frontmatter Index ────────────────────────────────────────────────────────

interface FacetValue {
  /** First-seen original casing, for display. */
  display: string;
  paths: Set<string>;
}

/** key → normalised value → notes carrying it. */
type FrontmatterFacets = Map<string, Map<string, FacetValue>>;

/**
 * Build frontmatter facets from the current graph.
 *
 * Keys are the flattened dotted paths, so a custom structure like
 * `opportunities[].guid` is queryable as `opportunities.guid`.
 */
function buildFacets(graph: GraphIndex): FrontmatterFacets {
  const facets: FrontmatterFacets = new Map();

  for (const ref of graph.getNotesByFolder("")) {
    const node = graph.getNode(ref.path);
    if (!node) continue;

    for (const field of flattenFrontmatter(node.frontmatter)) {
      let bucket = facets.get(field.key);
      if (!bucket) {
        bucket = new Map();
        facets.set(field.key, bucket);
      }

      const normalized = normalizeValue(field.value);
      if (!normalized) continue;

      let entry = bucket.get(normalized);
      if (!entry) {
        entry = { display: field.value, paths: new Set() };
        bucket.set(normalized, entry);
      }
      entry.paths.add(node.path);
    }
  }

  return facets;
}

// ─── Snippets ─────────────────────────────────────────────────────────────────

function getWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Tell the caller when meaning-based search would have run but could not.
 *
 * The semantic tier is optional and fails quietly by design, which leaves a user
 * inside an MCP client with no way to discover that it exists or why it is off —
 * startup logs go to stderr, which most clients hide. Reported only on a query
 * the lexical tiers could not cover, so it costs nothing when search is working
 * and never nags someone who turned the tier off deliberately.
 */
function semanticNotice(
  graph: GraphIndex,
  escalation: string | null,
  tiersUsed: string[],
): Record<string, string> {
  if (!escalation || tiersUsed.includes("semantic")) return {};

  const status = getSemanticIndex(graph)?.stats;
  if (!status || status.status === "disabled" || status.status === "ready") return {};

  // A search schedules its own background retry, which flips the tier to
  // `indexing` before this runs. `reason` is only ever set by a failure, so it
  // distinguishes a genuine first index from a retry after one.
  if (status.reason) {
    return {
      semantic_status:
        `Meaning-based search is unavailable (${status.reason}), so this used keyword matching only. ` +
        "It needs Ollama running locally; run `obsidian-intelligence-layer doctor` to check, or set OIL_SEMANTIC=off to silence this.",
    };
  }

  return {
    semantic_status:
      "Meaning-based search is still indexing this vault; keyword results only for now.",
  };
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
 * Shared body of the `semantic_search` tool.
 *
 * An empty list is ambiguous here in a way it never is inside the cascade:
 * there is no other tier to fall back on, so say which case it was.
 */
async function semanticOnlySearch(
  graph: GraphIndex,
  query: string,
  limit: number,
  filters: { folder?: string; tags?: string[] },
) {
  const index = getSemanticIndex(graph);
  index?.ensureFresh(graph);

  const results = await semanticSearch(graph, query, limit, filters);

  if (results.length === 0) {
    const status = index?.stats.status;
    if (status !== "ready") {
      // semanticNotice stays silent for a deliberately disabled tier, which is
      // right for search_vault and wrong here — the caller asked for this tier.
      const notice = semanticNotice(graph, "explicit", []);
      return jsonResponse({
        count: 0,
        tiers_used: [],
        tiers_ran: [],
        results: [],
        ...(Object.keys(notice).length > 0
          ? notice
          : {
              semantic_status:
                "Meaning-based search is turned off for this server, so this tool has nothing to search.",
            }),
        next_step: "Retry with search_vault, which answers from the keyword tiers.",
      });
    }
  }

  return jsonResponse({
    count: results.length,
    tiers_used: ["semantic"],
    // Reaching here means the tier was ready and searched, whether or not
    // anything cleared the floor.
    tiers_ran: ["semantic"],
    results: results.map((hit) => ({
      path: hit.path,
      title: hit.title,
      excerpt: hit.excerpt,
      score: hit.score,
      matched_by: ["semantic"],
    })),
    ...(results.length === 0
      ? {
          next_step:
            "Nothing cleared the similarity floor. Try search_vault, which also matches on wording.",
        }
      : {}),
  });
}

/**
 * Register all Retrieve tools on the MCP server.
 */
export function registerRetrieveTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  _cache: SessionCache,
  config: OilConfig,
): void {
  server.registerTool(
    "search_vault",
    {
      description:
        "Primary search over vault notes. Cascades BM25 keyword ranking → fuzzy → meaning-based matching, escalating only when the cheaper tier fails to cover the query. Use for any 'find notes about X' request.",
      inputSchema: {
        query: z.string().describe("Search query text or natural-language description"),
        limit: z.number().optional().describe("Max results (default: 10)"),
        filter_folder: z.string().optional().describe("Restrict to this folder prefix"),
        filter_tags: z.array(z.string()).optional().describe("Restrict to notes with these tags"),
      },
    },
    async ({ query, limit, filter_folder, filter_tags }) => {
      if (!query || !query.trim()) {
        return validationError("search_vault: query must be a non-empty string");
      }
      if (filter_folder) {
        const folderErr = validateVaultPath(filter_folder);
        if (folderErr) return validationError(`search_vault: filter_folder — ${folderErr}`);
      }

      const boundedLimit = limit ?? 10;
      const { results, tiersUsed, tiersRan, escalation, totalMatched } = await cascadeSearch(
        graph,
        query,
        boundedLimit,
        { folder: filter_folder, tags: filter_tags },
      );

      return jsonResponse({
        count: results.length,
        ...(totalMatched !== undefined ? { total_matched: totalMatched } : {}),
        ...(totalMatched !== undefined && totalMatched > results.length
          ? {
              truncated: true,
              next_step:
                "This query matched a frontmatter value on more notes than were returned. Use query_frontmatter with `where` to filter, or raise `limit`.",
            }
          : {}),
        tiers_used: tiersUsed,
        tiers_ran: tiersRan,
        escalated: escalation,
        ...semanticNotice(graph, escalation, tiersUsed),
        results: results.map(({ matchedBy, heading, ...rest }: CascadeHit) => ({
          ...rest,
          ...refField(rest.path, heading || undefined),
          matched_by: matchedBy,
        })),
      });
    },
  );

  // ── semantic_search ───────────────────────────────────────────────────

  server.registerTool(
    "semantic_search",
    {
      description:
        "Meaning-based search only, with no keyword tier mixed in. Use when a query shares no vocabulary with the notes that answer it — conceptual questions, paraphrases, or 'what have we discussed like X'. For ordinary lookups prefer search_vault. Requires a local Ollama; returns guidance instead of results when unavailable.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the idea to match"),
        limit: z.number().optional().describe("Max results (default: 10)"),
        filter_folder: z.string().optional().describe("Restrict to this folder prefix"),
        filter_tags: z.array(z.string()).optional().describe("Restrict to notes with these tags"),
      },
    },
    async ({ query, limit, filter_folder, filter_tags }) => {
      if (!query || !query.trim()) {
        return validationError("semantic_search: query must be a non-empty string");
      }
      if (filter_folder) {
        const folderErr = validateVaultPath(filter_folder);
        if (folderErr) return validationError(`semantic_search: filter_folder — ${folderErr}`);
      }

      return semanticOnlySearch(graph, query, limit ?? 10, {
        folder: filter_folder,
        tags: filter_tags,
      });
    },
  );

  // ── query_notes ───────────────────────────────────────────────────────

  server.registerTool(
    "get_note_metadata",    {
      description:
        "Peek at note metadata before loading full content. Returns frontmatter, creation/modification timestamps, word count, and headings.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
      },
    },
    async ({ path }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) {
        return validationError(
          `get_note_metadata: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Customers/Contoso.md without ../ segments or absolute prefixes, then retry get_note_metadata.",
          },
        );
      }

      try {
        const parsed = await readNote(vaultPath, path);
        const fileStats = await stat(securePath(vaultPath, path));
        const headings = truncateList([...parsed.sections.keys()]);

        const result = {
          path: parsed.path,
          title: parsed.title,
          frontmatter: parsed.frontmatter,
          created_at: fileStats.birthtime.toISOString(),
          modified_at: fileStats.mtime.toISOString(),
          mtime_ms: fileStats.mtimeMs,
          version: fileStats.mtimeMs,
          word_count: getWordCount(parsed.content),
          headings: headings.items,
          heading_count: headings.total_count,
          ...(headings.truncated ? { headings_truncated: true } : {}),
        };

        return jsonResponse(result);
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Failed to read note metadata: ${err instanceof Error ? err.message : String(err)}`,
          { path },
        );
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
      if (pathErr) {
        return validationError(
          `read_note_section: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Customers/Contoso.md without ../ segments or absolute prefixes, then retry read_note_section.",
          },
        );
      }

      try {
        const parsed = await readNote(vaultPath, path);
        const section = parsed.sections.get(heading);

        if (section === undefined) {
          const headings = truncateList([...parsed.sections.keys()]);
          return errorResponse(
            "NOT_FOUND",
            `Section \"${heading}\" not found in ${path}`,
            {
              path,
              available_headings: headings.items,
              ...(headings.truncated ? { heading_count: headings.total_count } : {}),
            },
            {
              retryable: true,
              suggested_tools: ["read_note_section"],
              next_step:
                "Choose a heading from available_headings and retry read_note_section with that exact heading text.",
            },
          );
        }

        const fileStats = await stat(securePath(vaultPath, path));
        const body = truncateText(section);

        return jsonResponse({
          path,
          ...refField(path, heading),
          content: body.text,
          ...(body.truncated
            ? {
                truncated: true,
                total_chars: body.total_chars,
                note: "Section exceeded the response budget and was cut. Read a narrower sub-heading for the remainder.",
              }
            : {}),
          mtime_ms: fileStats.mtimeMs,
          version: fileStats.mtimeMs,
        });
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Failed to read section: ${err instanceof Error ? err.message : String(err)}`,
          { path, ...refField(path, heading) },
        );
      }
    },
  );

  // ── query_frontmatter ────────────────────────────────────────────────

  server.registerTool(
    "query_frontmatter",
    {
      description:
        "Structured lookup over note frontmatter and tags, resolved from the in-memory graph. Call with no arguments to discover which keys exist, with `key` alone to list that key's values and counts, with `key`+`value_fragment` to match a substring, or with `where` to filter on several fields at once. Prefer this over search_vault whenever the answer is a property (status, tag, owner, date) rather than wording.",
      inputSchema: {
        key: z.string().optional().describe("Frontmatter key. Omit with no `where` to list all keys."),
        value_fragment: z.string().optional().describe("Case-insensitive substring of the value. Omit to list the key's distinct values."),
        where: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Exact-match predicates across fields, e.g. { status: 'at-risk', tags: ['enterprise'] }. Array values must all match."),
        folder: z.string().optional().describe("Restrict to this folder prefix"),
        order_by: z.string().optional().describe("Frontmatter field to sort by; prefix with '-' for descending"),
        limit: z.number().optional().describe("Max results (default: 20)"),
      },
    },
    async ({ key, value_fragment, where, folder, order_by, limit }) => {
      if (folder) {
        const folderErr = validateVaultPath(folder);
        if (folderErr) return validationError(`query_frontmatter: folder — ${folderErr}`);
      }

      const boundedLimit = Math.max(1, limit ?? 20);

      // ── Predicate mode ──────────────────────────────────────────────
      if (where && Object.keys(where).length > 0) {
        const matched = queryNotes(graph, config, {
          where: where as Record<string, unknown>,
          folder,
          orderBy: order_by,
        });

        return jsonResponse({
          mode: "query",
          where,
          total_matched: matched.length,
          returned: Math.min(matched.length, boundedLimit),
          ...(matched.length > boundedLimit ? { truncated: true } : {}),
          results: matched.slice(0, boundedLimit).map((ref) => ({
            path: ref.path,
            title: ref.title,
            tags: ref.tags,
          })),
        });
      }

      const facets = buildFacets(graph);
      const inFolder = (path: string) => !folder || path.startsWith(folder);

      // ── Schema mode — what can I filter on? ─────────────────────────
      if (!key) {
        const keys = [...facets.entries()]
          .map(([name, values]) => {
            const notes = new Set<string>();
            for (const entry of values.values()) {
              for (const path of entry.paths) if (inFolder(path)) notes.add(path);
            }
            return { key: name, distinct_values: values.size, notes: notes.size };
          })
          .filter((k) => k.notes > 0)
          .sort((a, b) => b.notes - a.notes);

        return jsonResponse({
          mode: "schema",
          ...(folder ? { folder } : {}),
          key_count: keys.length,
          keys,
          next_step:
            "Call query_frontmatter with `key` to list that key's values, or `where` to filter notes.",
        });
      }

      const bucket = facets.get(key.toLowerCase());
      if (!bucket) {
        return errorResponse(
          "NOT_FOUND",
          `No frontmatter key "${key}" found in this vault.`,
          { key, available_keys: [...facets.keys()].sort() },
          {
            retryable: true,
            suggested_tools: ["query_frontmatter"],
            next_step: "Pick a key from available_keys, or call query_frontmatter with no arguments.",
          },
        );
      }

      // ── Facet mode — what values does this key take? ────────────────
      if (value_fragment === undefined) {
        const values = [...bucket.values()]
          .map((entry) => ({
            value: entry.display,
            count: [...entry.paths].filter(inFolder).length,
          }))
          .filter((v) => v.count > 0)
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

        return jsonResponse({
          mode: "facet",
          key,
          ...(folder ? { folder } : {}),
          distinct_values: values.length,
          returned: Math.min(values.length, boundedLimit),
          ...(values.length > boundedLimit ? { truncated: true } : {}),
          values: values.slice(0, boundedLimit),
        });
      }

      // ── Match mode — substring against the key's values ─────────────
      const fragment = value_fragment.toLowerCase();
      const matchedPaths = new Set<string>();
      for (const [normalized, entry] of bucket) {
        if (!normalized.includes(fragment)) continue;
        for (const path of entry.paths) if (inFolder(path)) matchedPaths.add(path);
      }

      const paths = [...matchedPaths];
      return jsonResponse({
        mode: "match",
        key,
        value_fragment,
        // Reported before truncation so the caller can tell a partial result
        // from a complete one.
        total_matched: paths.length,
        returned: Math.min(paths.length, boundedLimit),
        ...(paths.length > boundedLimit ? { truncated: true } : {}),
        paths: paths.slice(0, boundedLimit),
      });
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
      if (pathErr) {
        return validationError(
          `get_related_entities: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Customers/Contoso.md without ../ segments or absolute prefixes, then retry get_related_entities.",
          },
        );
      }

      const related = truncateList(graph.getRelatedNotes(path, max_hops ?? 2));

      return jsonResponse({
        path,
        max_hops: max_hops ?? 2,
        count: related.total_count,
        ...(related.truncated ? { truncated: true } : {}),
        related: related.items,
      });
    },
  );
}
