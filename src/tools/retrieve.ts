import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type {
  FrontmatterIndexEntry,
  FrontmatterValueKind,
  GraphNode,
  ObservedFieldSchema,
  OilConfig,
} from "../types.js";
import {
  errorCodeFromUnknown,
  errorResponse,
  jsonResponse,
  noteRef,
} from "../tool-responses.js";
import { validateVaultPath, validationError } from "../validation.js";
import { parseSections, securePath } from "../vault.js";
import { searchVaultCandidates, type SearchFilters } from "../search.js";
import { decodeCursor, encodeCursor, querySignature } from "../pagination.js";

const SEARCH_DEFAULT = 5;
const SEARCH_MAX = 20;
const FRONTMATTER_DEFAULT = 10;
const FRONTMATTER_MAX = 50;
const RELATED_DEFAULT = 10;
const RELATED_MAX = 25;
const CATALOG_DEFAULT = 10;
const CATALOG_MAX = 50;
const SECTION_DEFAULT_CHARS = 4_000;
const SECTION_MAX_CHARS = 8_000;
const FRONTMATTER_MAX_CHARS = 8_000;
const CATALOG_RESPONSE_CHARS = 2_000;

type FrontmatterOperator = "eq" | "contains" | "prefix" | "exists" | "in" | "all" | "gt" | "gte" | "lt" | "lte";

export function registerRetrieveTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  _cache: SessionCache,
  _config: OilConfig,
): void {
  server.registerTool(
    "search_vault",
    {
      description:
        "Unified bounded catalog search across paths, titles, aliases, frontmatter, tags, descriptions, headings, full note bodies, links, and fuzzy candidates. Use for named entities and topics; use inspect_catalog first only when the vault layout is unknown.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        tier: z.enum(["lexical", "fuzzy"]).optional().describe("Restrict candidate generation to one tier"),
        limit: z.number().optional().describe("Results per page (default 5, maximum 20)"),
        cursor: z.string().optional().describe("Generation-bound continuation cursor"),
        filter_folder: z.string().optional().describe("Restrict to this folder prefix"),
        filter_tags: z.array(z.string()).optional().describe("Restrict to notes with any of these tags"),
        filter_type: z.string().optional().describe("Restrict to the derived or authored note type"),
        filter_frontmatter: z.record(z.string(), z.unknown()).optional().describe("Exact structured frontmatter predicates"),
        sort: z.enum(["relevance", "modified", "title"]).optional().describe("Deterministic result ordering"),
        diversity: z.boolean().optional().describe("Prefer folder diversity for equally relevant broad results"),
      },
    },
    async ({ query, tier, limit, cursor, filter_folder, filter_tags, filter_type, filter_frontmatter, sort, diversity }) => {
      if (!query?.trim()) return validationError("search_vault: query must be a non-empty string");
      if (filter_folder) {
        const folderError = validateVaultPath(filter_folder);
        if (folderError) return validationError(`search_vault: filter_folder — ${folderError}`);
      }

      const requestedLimit = normalizePositiveInteger(limit, SEARCH_DEFAULT);
      const pageLimit = Math.min(requestedLimit, SEARCH_MAX);
      const warnings = [
        ...limitWarnings(requestedLimit, SEARCH_MAX),
        ...catalogStateWarnings(graph),
      ];
      const filters: SearchFilters = {
        ...(filter_folder ? { folder: filter_folder } : {}),
        ...(filter_tags?.length ? { tags: filter_tags } : {}),
        ...(filter_type ? { type: filter_type } : {}),
        ...(filter_frontmatter ? { frontmatter: filter_frontmatter } : {}),
      };
      const signature = querySignature({ query, tier, filters, sort, diversity });
      const decoded = cursor
        ? decodeCursor(cursor, { kind: "search", generation: graph.generation, signature })
        : null;
      if (cursor && !decoded) return invalidCursor(graph, "search_vault");
      const offset = decoded?.offset ?? 0;

      const candidates = searchVaultCandidates(graph, query, tier, filters, graph.nodeCount);
      let ranked = [...candidates.results];
      if (sort === "modified") {
        ranked.sort((a, b) => (graph.getNode(b.path)?.sourceMtimeMs ?? 0) - (graph.getNode(a.path)?.sourceMtimeMs ?? 0) || a.path.localeCompare(b.path));
      } else if (sort === "title") {
        ranked.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
      }
      let diversityApplied = false;
      if (diversity && sort !== "modified" && sort !== "title") {
        const diversified = diversifyByFolder(ranked);
        diversityApplied = diversified.some((result, index) => result.path !== ranked[index]?.path);
        ranked = diversified;
      }

      const pageResults = ranked.slice(offset, offset + pageLimit).map((result) => ({
        path: result.path,
        ref: noteRef(result.path),
        title: result.title,
        score: Number(result.score.toFixed(4)),
        matched_on: (result.matchedOn ?? [result.matchType]).slice(0, 8),
        snippet: result.excerpt.slice(0, 240),
      }));
      const truncated = offset + pageResults.length < ranked.length || candidates.candidateGenerationCapped;
      const nextCursor = truncated && offset + pageResults.length < ranked.length
        ? encodeCursor({ kind: "search", generation: graph.generation, signature, offset: offset + pageResults.length })
        : undefined;
      if (truncated) warnings.push("RESULTS_TRUNCATED");
      if (offset > ranked.length) return invalidCursor(graph, "search_vault");

      return jsonResponse({
        count: pageResults.length,
        results: pageResults,
        indices_consulted: candidates.indicesConsulted,
        total_candidates: candidates.totalCandidates,
        candidate_generation_capped: candidates.candidateGenerationCapped,
        minimum_score: pageResults.length ? pageResults[pageResults.length - 1].score : null,
        diversity_applied: diversityApplied,
        catalog: catalogEnvelope(graph),
        page: {
          returned: pageResults.length,
          total: candidates.candidateGenerationCapped ? undefined : ranked.length,
          truncated,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        },
        warnings: [...new Set(warnings)],
      });
    },
  );

  server.registerTool(
    "get_note_metadata",
    {
      description:
        "Inspect a canonical knowledge node before reading content. Returns bounded frontmatter, identity/presentation provenance, headings, readiness, warnings, relationships, and catalog freshness.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
        frontmatter_view: z.enum(["keys", "summary", "full"]).optional().describe("Frontmatter projection (default full for compatibility)"),
        frontmatter_fields: z.array(z.string()).optional().describe("Only return these source or logical fields"),
      },
    },
    async ({ path, frontmatter_view, frontmatter_fields }) => {
      const pathError = validateVaultPath(path);
      if (pathError) return pathValidationError("get_note_metadata", pathError);
      const node = graph.getNode(path);
      if (!node) return errorResponse("NOT_FOUND", `Knowledge node not found: ${path}`, { path, ref: noteRef(path), catalog: catalogEnvelope(graph) });

      try {
        const fileStats = await stat(securePath(vaultPath, path));
        const projection = projectFrontmatter(node.frontmatter, frontmatter_view ?? "full", frontmatter_fields, graph);
        return jsonResponse({
          path: node.path,
          ref: noteRef(node.path),
          node_id: node.nodeId,
          title: node.title,
          identity: {
            explicit_id: node.explicitId ?? null,
            aliases: node.aliases,
            identity_source: node.explicitId ? "explicit_id" : "path",
          },
          presentation: {
            title: node.title,
            title_source: node.titleSource,
            description: node.description,
            description_source: node.descriptionSource,
            type: node.type,
            type_source: node.typeSource,
          },
          frontmatter: projection.value,
          frontmatter_view: frontmatter_view ?? "full",
          frontmatter_truncated: projection.truncated,
          created_at: fileStats.birthtime.toISOString(),
          modified_at: fileStats.mtime.toISOString(),
          mtime_ms: fileStats.mtimeMs,
          version: fileStats.mtimeMs,
          word_count: node.wordCount,
          headings: node.headings,
          relationships: {
            outgoing_count: node.outLinks.size,
            incoming_count: node.inLinks.size,
            unresolved_count: node.links.filter((edge) => edge.status !== "resolved").length,
          },
          readiness: node.readiness,
          warnings: node.warningDetails.map((warning) => ({
            ...warning,
            ...(warning.candidates ? { candidates: warning.candidates.slice(0, 25) } : {}),
          })),
          catalog_warnings: catalogStateWarnings(graph),
          catalog: catalogEnvelope(graph),
        });
      } catch (error) {
        return errorResponse(errorCodeFromUnknown(error), `Failed to read note metadata: ${error instanceof Error ? error.message : String(error)}`, { path, ref: noteRef(path), catalog: catalogEnvelope(graph) });
      }
    },
  );

  server.registerTool(
    "read_note_section",
    {
      description:
        "Read one heading section with a server-enforced character ceiling. Continue long sections with the returned generation-bound cursor instead of loading the complete note.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
        heading: z.string().describe("Heading text without markdown markers"),
        max_chars: z.number().optional().describe("Characters per page (default 4000, maximum 8000)"),
        cursor: z.string().optional().describe("Continuation cursor returned by an earlier section page"),
      },
    },
    async ({ path, heading, max_chars, cursor }) => {
      const pathError = validateVaultPath(path);
      if (pathError) return pathValidationError("read_note_section", pathError);
      const node = graph.getNode(path);
      if (!node) return errorResponse("NOT_FOUND", `Knowledge node not found: ${path}`, { path, ref: noteRef(path), catalog: catalogEnvelope(graph) });
      const sections = parseSections(node.bodyText);
      const section = sections.get(heading);
      if (section === undefined) {
        return errorResponse("NOT_FOUND", `Section \"${heading}\" not found in ${path}`, {
          path,
          ref: noteRef(path),
          available_headings: [...sections.keys()].slice(0, 100),
          catalog: catalogEnvelope(graph),
        }, {
          retryable: true,
          suggested_tools: ["read_note_section"],
          next_step: "Choose an exact value from available_headings and retry.",
        });
      }

      const requestedMax = normalizePositiveInteger(max_chars, SECTION_DEFAULT_CHARS);
      const pageChars = Math.min(requestedMax, SECTION_MAX_CHARS);
      const signature = querySignature({ path, heading });
      const decoded = cursor
        ? decodeCursor(cursor, { kind: "section", generation: graph.generation, signature })
        : null;
      if (cursor && (!decoded || (decoded.version !== undefined && decoded.version !== node.sourceMtimeMs))) {
        return invalidCursor(graph, "read_note_section");
      }
      const offset = decoded?.offset ?? 0;
      if (offset > section.length) return invalidCursor(graph, "read_note_section");
      const end = Math.min(section.length, offset + pageChars);
      const content = section.slice(offset, end);
      const truncated = end < section.length;
      const nextCursor = truncated
        ? encodeCursor({ kind: "section", generation: graph.generation, signature, offset: end, version: node.sourceMtimeMs })
        : undefined;
      const warnings = [
        ...limitWarnings(requestedMax, SECTION_MAX_CHARS),
        ...catalogStateWarnings(graph),
      ];
      if (truncated) warnings.push("RESULTS_TRUNCATED");

      return jsonResponse({
        path: node.path,
        ref: noteRef(node.path, heading),
        heading,
        content,
        mtime_ms: node.sourceMtimeMs,
        version: node.sourceMtimeMs,
        catalog: catalogEnvelope(graph),
        page: {
          offset,
          returned_chars: content.length,
          total_chars: section.length,
          truncated,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        },
        warnings,
      });
    },
  );

  server.registerTool(
    "query_frontmatter",
    {
      description:
        "Typed lookup over the catalog's persistent observed frontmatter schema. Distinguishes unknown fields from known zero matches and supports exact, containment, existence, set, numeric, and date predicates.",
      inputSchema: {
        key: z.string().describe("Logical or source frontmatter field, including dotted paths"),
        value_fragment: z.string().optional().describe("Backward-compatible alias for operator=contains"),
        operator: z.enum(["eq", "contains", "prefix", "exists", "in", "all", "gt", "gte", "lt", "lte"]).optional(),
        value: z.unknown().optional().describe("Typed comparison value"),
        values: z.array(z.unknown()).optional().describe("Values for in/all operators"),
        key_mode: z.enum(["logical", "raw"]).optional().describe("Resolve configured logical aliases or use the observed raw key"),
        filter_folder: z.string().optional(),
        filter_tags: z.array(z.string()).optional(),
        order_by: z.enum(["path", "title", "source_mtime", "value"]).optional(),
        limit: z.number().optional().describe("Results per page (default 10, maximum 50)"),
        cursor: z.string().optional(),
      },
    },
    async ({ key, value_fragment, operator, value, values, key_mode, filter_folder, filter_tags, order_by, limit, cursor }) => {
      if (!key?.trim()) return validationError("query_frontmatter: key must be non-empty");
      if (filter_folder) {
        const folderError = validateVaultPath(filter_folder);
        if (folderError) return validationError(`query_frontmatter: filter_folder — ${folderError}`);
      }
      const resolved = graph.resolveFrontmatterField(key, key_mode ?? "logical");
      if (!resolved.known) {
        const suggestions = graph.suggestFrontmatterFields(key, 5);
        return errorResponse("UNKNOWN_FIELD", `No observed or configured frontmatter field named ${key}.`, {
          key,
          suggestions: suggestions.map((suggestion) => suggestion.key),
          suggestion_details: suggestions.map((suggestion) => ({ key: suggestion.key, node_count: suggestion.nodeCount, coverage: suggestion.coverage })),
          catalog: catalogEnvelope(graph),
          warnings: catalogStateWarnings(graph),
        }, {
          retryable: true,
          suggested_tools: ["inspect_catalog", "query_frontmatter"],
          next_step: "Choose a suggested or observed field and retry query_frontmatter.",
        });
      }

      const effectiveOperator: FrontmatterOperator = operator ?? (value_fragment !== undefined ? "contains" : "eq");
      const expected = values ?? value ?? value_fragment;
      if (effectiveOperator !== "exists" && expected === undefined) {
        return validationError(`query_frontmatter: ${effectiveOperator} requires value, values, or value_fragment`);
      }
      const entries = graph.getFrontmatterEntries(resolved.key);
      const compatibility = operatorCompatibility(entries, effectiveOperator, expected);
      if (!compatibility.ok) {
        return errorResponse("TYPE_MISMATCH", compatibility.message, {
          key,
          resolved_key: resolved.key,
          operator: effectiveOperator,
          observed_types: observedKinds(entries),
          catalog: catalogEnvelope(graph),
          warnings: catalogStateWarnings(graph),
        });
      }

      const requestedLimit = normalizePositiveInteger(limit, FRONTMATTER_DEFAULT);
      const pageLimit = Math.min(requestedLimit, FRONTMATTER_MAX);
      const signature = querySignature({ key: resolved.key, effectiveOperator, expected, key_mode, filter_folder, filter_tags, order_by });
      const decoded = cursor
        ? decodeCursor(cursor, { kind: "frontmatter", generation: graph.generation, signature })
        : null;
      if (cursor && !decoded) return invalidCursor(graph, "query_frontmatter");
      const offset = decoded?.offset ?? 0;

      const matched = new Map<string, FrontmatterIndexEntry>();
      for (const entry of entries) {
        const node = graph.getNode(entry.path);
        if (!node) continue;
        if (filter_folder && !entry.path.startsWith(filter_folder)) continue;
        if (filter_tags?.length && !filter_tags.some((tag) => node.tags.some((nodeTag) => nodeTag.toLowerCase() === tag.toLowerCase()))) continue;
        if (matchesOperator(entry.value, effectiveOperator, expected)) matched.set(entry.path, entry);
      }
      let allMatches = [...matched.values()];
      allMatches.sort((a, b) => compareFrontmatterMatches(a, b, order_by ?? "path", graph));
      if (offset > allMatches.length) return invalidCursor(graph, "query_frontmatter");
      const pageEntries = allMatches.slice(offset, offset + pageLimit);
      const paths = pageEntries.map((entry) => entry.path);
      const truncated = offset + pageEntries.length < allMatches.length;
      const nextCursor = truncated
        ? encodeCursor({ kind: "frontmatter", generation: graph.generation, signature, offset: offset + pageEntries.length })
        : undefined;
      const warnings = [
        ...limitWarnings(requestedLimit, FRONTMATTER_MAX),
        ...catalogStateWarnings(graph),
      ];
      if (truncated) warnings.push("RESULTS_TRUNCATED");

      return jsonResponse({
        key,
        resolved_key: resolved.key,
        source_key_variants: resolved.variants,
        aliases: resolved.aliases,
        operator: effectiveOperator,
        ...(value_fragment !== undefined ? { value_fragment } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(values !== undefined ? { values } : {}),
        count: paths.length,
        total: allMatches.length,
        paths,
        matches: pageEntries.map((entry) => ({
          path: entry.path,
          ref: noteRef(entry.path),
          source_key: entry.rawKey,
          value: summarizeValue(entry.value),
        })),
        truncated,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        catalog: catalogEnvelope(graph),
        warnings,
      });
    },
  );

  server.registerTool(
    "get_related_entities",
    {
      description:
        "Bounded relationship traversal over resolved Obsidian and Markdown links. Returns compact refs, edge provenance, ambiguity/broken-link summaries, and continuation metadata.",
      inputSchema: {
        path: z.string().describe("Note path relative to vault root"),
        max_hops: z.number().optional().describe("Maximum link hops (default 1, maximum 2)"),
        limit: z.number().optional().describe("Results per page (default 10, maximum 25)"),
        cursor: z.string().optional(),
        filter_folder: z.string().optional(),
        filter_tags: z.array(z.string()).optional(),
      },
    },
    async ({ path, max_hops, limit, cursor, filter_folder, filter_tags }) => {
      const pathError = validateVaultPath(path);
      if (pathError) return pathValidationError("get_related_entities", pathError);
      const origin = graph.getNode(path);
      if (!origin) return errorResponse("NOT_FOUND", `Knowledge node not found: ${path}`, { path, ref: noteRef(path), catalog: catalogEnvelope(graph) });
      const requestedHops = normalizePositiveInteger(max_hops, 1);
      const hops = Math.min(requestedHops, 2);
      const requestedLimit = normalizePositiveInteger(limit, RELATED_DEFAULT);
      const pageLimit = Math.min(requestedLimit, RELATED_MAX);
      const signature = querySignature({ path, hops, filter_folder, filter_tags });
      const decoded = cursor
        ? decodeCursor(cursor, { kind: "related", generation: graph.generation, signature })
        : null;
      if (cursor && !decoded) return invalidCursor(graph, "get_related_entities");
      const offset = decoded?.offset ?? 0;
      const related = graph.getRelatedNotes(path, hops, {
        ...(filter_folder ? { folder: filter_folder } : {}),
        ...(filter_tags?.length ? { tags: filter_tags } : {}),
      });
      if (offset > related.length) return invalidCursor(graph, "get_related_entities");
      const pageRelated = related.slice(offset, offset + pageLimit).map((ref) => ({
        ...ref,
        relationship: directRelationship(origin, ref.path),
      }));
      const truncated = offset + pageRelated.length < related.length;
      const nextCursor = truncated
        ? encodeCursor({ kind: "related", generation: graph.generation, signature, offset: offset + pageRelated.length })
        : undefined;
      const warnings = [
        ...limitWarnings(requestedHops, 2),
        ...limitWarnings(requestedLimit, RELATED_MAX),
        ...catalogStateWarnings(graph),
      ];
      if (truncated) warnings.push("RESULTS_TRUNCATED");

      return jsonResponse({
        path: origin.path,
        ref: noteRef(origin.path),
        max_hops: hops,
        count: pageRelated.length,
        total: related.length,
        related: pageRelated,
        unresolved: origin.links
          .filter((edge) => edge.status !== "resolved")
          .slice(0, RELATED_MAX)
          .map((edge) => ({
            ...edge,
            ...(edge.candidates ? { candidates: edge.candidates.slice(0, RELATED_MAX) } : {}),
          })),
        unresolved_truncated: origin.links.filter((edge) => edge.status !== "resolved").length > RELATED_MAX,
        truncated,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        catalog: catalogEnvelope(graph),
        warnings: [...new Set(warnings)],
      });
    },
  );

  server.registerTool(
    "inspect_catalog",
    {
      description:
        "Orient within an unfamiliar vault using bounded virtual indexes for folders, fields, types, tags, recency, readiness, or warnings. Use before broad retrieval; skip for direct paths, unique names, or known identifiers.",
      inputSchema: {
        view: z.enum(["folders", "folder", "fields", "types", "tags", "recent", "readiness", "warnings"]).optional().describe("Catalog view (default folders)"),
        path: z.string().optional().describe("Folder prefix for the folder view"),
        limit: z.number().optional().describe("Entries per page (default 10, maximum 50)"),
        cursor: z.string().optional(),
      },
    },
    async ({ view, path, limit, cursor }) => {
      const selectedView = view ?? "folders";
      if (path) {
        const pathError = validateVaultPath(path);
        if (pathError) return validationError(`inspect_catalog: path — ${pathError}`);
      }
      const requestedLimit = normalizePositiveInteger(limit, CATALOG_DEFAULT);
      const pageLimit = Math.min(requestedLimit, CATALOG_MAX);
      const signature = querySignature({ view: selectedView, path });
      const decoded = cursor
        ? decodeCursor(cursor, { kind: "catalog", generation: graph.generation, signature })
        : null;
      if (cursor && !decoded) return invalidCursor(graph, "inspect_catalog");
      const offset = decoded?.offset ?? 0;
      const allEntries = catalogViewEntries(graph, selectedView, path);
      if (offset > allEntries.length) return invalidCursor(graph, "inspect_catalog");
      let results = allEntries.slice(offset, offset + pageLimit);
      const warnings = [
        ...limitWarnings(requestedLimit, CATALOG_MAX),
        ...catalogStateWarnings(graph),
      ];

      const buildPayload = () => ({
        view: selectedView,
        ...(path ? { path } : {}),
        count: results.length,
        total: allEntries.length,
        results,
        catalog: catalogEnvelope(graph),
        page: { returned: results.length, total: allEntries.length, truncated: offset + results.length < allEntries.length },
        warnings,
      });
      while (results.length > 1 && JSON.stringify(buildPayload()).length > CATALOG_RESPONSE_CHARS) results.pop();
      const truncated = offset + results.length < allEntries.length;
      const nextCursor = truncated
        ? encodeCursor({ kind: "catalog", generation: graph.generation, signature, offset: offset + results.length })
        : undefined;
      if (truncated) warnings.push("RESULTS_TRUNCATED");

      return jsonResponse({
        view: selectedView,
        ...(path ? { path } : {}),
        count: results.length,
        total: allEntries.length,
        results,
        catalog: catalogEnvelope(graph),
        page: {
          returned: results.length,
          total: allEntries.length,
          truncated,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        },
        warnings: [...new Set(warnings)],
      });
    },
  );
}

function catalogEnvelope(graph: GraphIndex) {
  return {
    generation: graph.generation,
    state: graph.indexState,
    built_at: graph.lastIndexed.toISOString(),
    reconciled_at: graph.reconciledAt?.toISOString() ?? null,
  };
}

function catalogStateWarnings(graph: GraphIndex): string[] {
  if (graph.indexState === "reconciling") return ["INDEX_RECONCILING"];
  if (graph.indexState === "stale") return ["STALE_INDEX"];
  if (graph.indexState === "failed") return ["INDEX_UNAVAILABLE"];
  return [];
}

function invalidCursor(graph: GraphIndex, tool: string) {
  return errorResponse("INVALID_CURSOR", `${tool}: cursor is invalid, expired, or belongs to another catalog generation.`, {
    catalog: catalogEnvelope(graph),
  }, {
    retryable: true,
    suggested_tools: [tool],
    next_step: `Retry ${tool} without cursor to start from the current catalog generation.`,
  });
}

function pathValidationError(tool: string, message: string) {
  return validationError(`${tool}: ${message}`, "INVALID_INPUT", {
    retryable: true,
    next_step: `Use a vault-relative path without ../ segments or absolute prefixes, then retry ${tool}.`,
  });
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function limitWarnings(requested: number, maximum: number): string[] {
  return requested > maximum ? [`LIMIT_CLAMPED:${requested}->${maximum}`] : [];
}

function diversifyByFolder<T extends { path: string; score: number }>(results: T[]): T[] {
  const exact = results.filter((result) => result.score >= 0.99);
  const remaining = results.filter((result) => result.score < 0.99);
  const buckets = new Map<string, T[]>();
  for (const result of remaining) {
    const folder = result.path.split("/")[0] ?? "";
    const bucket = buckets.get(folder) ?? [];
    bucket.push(result);
    buckets.set(folder, bucket);
  }
  const diversified: T[] = [...exact];
  while ([...buckets.values()].some((bucket) => bucket.length > 0)) {
    for (const folder of [...buckets.keys()].sort()) {
      const result = buckets.get(folder)?.shift();
      if (result) diversified.push(result);
    }
  }
  return diversified;
}

function projectFrontmatter(
  frontmatter: Record<string, unknown>,
  view: "keys" | "summary" | "full",
  fields: string[] | undefined,
  graph: GraphIndex,
): { value: unknown; truncated: boolean } {
  if (view === "keys" && !fields?.length) return { value: Object.keys(frontmatter).sort(), truncated: false };
  let entries = Object.entries(frontmatter);
  if (fields?.length) {
    const requested = new Set(fields.map((field) => graph.resolveFrontmatterField(field).key));
    entries = entries.filter(([key]) => requested.has(graph.resolveFrontmatterField(key, "raw").key));
  }
  if (view === "summary") {
    entries = entries.map(([key, value]) => [key, summarizeValue(value)]);
  }

  const projected: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const candidate = { ...projected, [key]: value };
    if (JSON.stringify(candidate).length <= FRONTMATTER_MAX_CHARS) {
      projected[key] = value;
      continue;
    }
    const bounded = summarizeValue(value);
    if (JSON.stringify({ ...projected, [key]: bounded }).length <= FRONTMATTER_MAX_CHARS) projected[key] = bounded;
    truncated = true;
  }
  return { value: projected, truncated };
}

function summarizeValue(value: unknown): unknown {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= 240) return value;
  return `${serialized.slice(0, 237)}...`;
}

function operatorCompatibility(
  entries: FrontmatterIndexEntry[],
  operator: FrontmatterOperator,
  expected: unknown,
): { ok: boolean; message: string } {
  if (entries.length === 0) return { ok: true, message: "" };
  const kinds = new Set(entries.map((entry) => entry.kind));
  if (operator === "all" && !kinds.has("array")) {
    return { ok: false, message: "Operator all requires an observed array field." };
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    const supported = kinds.has("number") || kinds.has("date");
    if (!supported || comparableValue(expected) === null) {
      return { ok: false, message: `${operator} requires numeric or ISO date-like field values and a compatible comparison value.` };
    }
  }
  return { ok: true, message: "" };
}

function matchesOperator(actual: unknown, operator: FrontmatterOperator, expected: unknown): boolean {
  if (operator === "exists") return true;
  if (operator === "eq") return equalValue(actual, expected);
  if (operator === "contains") {
    if (Array.isArray(actual)) return actual.some((value) => matchesOperator(value, operator, expected));
    return serializeComparable(actual).toLowerCase().includes(serializeComparable(expected).toLowerCase());
  }
  if (operator === "prefix") {
    if (Array.isArray(actual)) return actual.some((value) => matchesOperator(value, operator, expected));
    return serializeComparable(actual).toLowerCase().startsWith(serializeComparable(expected).toLowerCase());
  }
  if (operator === "in") {
    const options = Array.isArray(expected) ? expected : [expected];
    return options.some((option) => equalValue(actual, option));
  }
  if (operator === "all") {
    if (!Array.isArray(actual)) return false;
    const required = Array.isArray(expected) ? expected : [expected];
    return required.every((requiredValue) => actual.some((value) => equalValue(value, requiredValue)));
  }
  const actualComparable = comparableValue(actual);
  const expectedComparable = comparableValue(expected);
  if (actualComparable === null || expectedComparable === null) return false;
  if (operator === "gt") return actualComparable > expectedComparable;
  if (operator === "gte") return actualComparable >= expectedComparable;
  if (operator === "lt") return actualComparable < expectedComparable;
  return actualComparable <= expectedComparable;
}

function equalValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((value) => equalValue(value, expected));
  if (typeof actual === "string" && typeof expected === "string") return actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

function comparableValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  }
  return null;
}

function serializeComparable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return JSON.stringify(value) ?? String(value);
}

function observedKinds(entries: FrontmatterIndexEntry[]): Partial<Record<FrontmatterValueKind, number>> {
  const result: Partial<Record<FrontmatterValueKind, number>> = {};
  for (const entry of entries) result[entry.kind] = (result[entry.kind] ?? 0) + 1;
  return result;
}

function compareFrontmatterMatches(
  a: FrontmatterIndexEntry,
  b: FrontmatterIndexEntry,
  orderBy: "path" | "title" | "source_mtime" | "value",
  graph: GraphIndex,
): number {
  if (orderBy === "title") return (graph.getNode(a.path)?.title ?? "").localeCompare(graph.getNode(b.path)?.title ?? "") || a.path.localeCompare(b.path);
  if (orderBy === "source_mtime") return (graph.getNode(b.path)?.sourceMtimeMs ?? 0) - (graph.getNode(a.path)?.sourceMtimeMs ?? 0) || a.path.localeCompare(b.path);
  if (orderBy === "value") return serializeComparable(a.value).localeCompare(serializeComparable(b.value)) || a.path.localeCompare(b.path);
  return a.path.localeCompare(b.path);
}

function directRelationship(origin: GraphNode, relatedPath: string) {
  const outgoing = origin.links.find((edge) => edge.resolvedPath === relatedPath);
  if (outgoing) return outgoing;
  return origin.inLinks.has(relatedPath) ? { direction: "incoming", source: relatedPath, target: origin.path } : null;
}

function catalogViewEntries(
  graph: GraphIndex,
  view: "folders" | "folder" | "fields" | "types" | "tags" | "recent" | "readiness" | "warnings",
  path?: string,
): unknown[] {
  const nodes = graph.getNotesByFolder(path ?? "").flatMap((ref) => {
    const node = graph.getNode(ref.path);
    return node ? [node] : [];
  });
  if (view === "folders" || view === "folder") return folderEntries(nodes, view === "folder" ? path ?? "" : "");
  if (view === "fields") return graph.getObservedSchema().map(compactFieldSchema);
  if (view === "types") return countValues(nodes.map((node) => node.type), "type");
  if (view === "tags") return graph.getTopTags(CATALOG_MAX).map((entry) => ({ tag: entry.tag, node_count: entry.count }));
  if (view === "recent") {
    return nodes.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs || a.path.localeCompare(b.path)).map(compactNode);
  }
  if (view === "readiness") {
    return countValues(nodes.flatMap((node) => node.readiness), "facet");
  }

  const grouped = new Map<string, { count: number; examples: string[] }>();
  for (const node of nodes) {
    for (const warning of node.warnings) {
      const bucket = grouped.get(warning) ?? { count: 0, examples: [] };
      bucket.count++;
      if (bucket.examples.length < 3) bucket.examples.push(node.path);
      grouped.set(warning, bucket);
    }
  }
  for (const issue of graph.getCatalogIssues()) {
    const bucket = grouped.get(issue.code) ?? { count: 0, examples: [] };
    bucket.count++;
    if (bucket.examples.length < 3) bucket.examples.push(issue.path);
    grouped.set(issue.code, bucket);
  }
  return [...grouped].map(([code, value]) => ({ code, ...value })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function folderEntries(nodes: GraphNode[], prefix: string): unknown[] {
  const normalizedPrefix = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  const folders = new Map<string, number>();
  const notes: unknown[] = [];
  for (const node of nodes) {
    const relative = node.path.slice(normalizedPrefix.length);
    if (relative.includes("/")) {
      const child = `${normalizedPrefix}${relative.split("/")[0]}/`;
      folders.set(child, (folders.get(child) ?? 0) + 1);
    } else if (prefix) notes.push(compactNode(node));
  }
  return [
    ...[...folders].map(([folder, noteCount]) => ({ kind: "folder", path: folder, note_count: noteCount })).sort((a, b) => a.path.localeCompare(b.path)),
    ...notes,
  ];
}

function compactNode(node: GraphNode) {
  return {
    kind: "note",
    path: node.path,
    ref: noteRef(node.path),
    title: node.title,
    description: node.description.slice(0, 180),
    type: node.type,
    modified_at: new Date(node.sourceMtimeMs).toISOString(),
  };
}

function compactFieldSchema(schema: ObservedFieldSchema) {
  return {
    key: schema.key,
    variants: schema.variants,
    aliases: schema.aliases,
    node_count: schema.nodeCount,
    coverage: Number(schema.coverage.toFixed(4)),
    types: schema.types,
    examples: schema.examples.slice(0, 3),
    warnings: schema.warnings,
  };
}

function countValues(values: string[], property: string): unknown[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, nodeCount]) => ({ [property]: value, node_count: nodeCount }))
    .sort((a, b) => (b.node_count as number) - (a.node_count as number) || String(a[property]).localeCompare(String(b[property])));
}
