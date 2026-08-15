/**
 * OIL — Frontmatter Predicate Query Engine
 * Relational-style filtering across all notes in the graph index.
 * Supports where/and/or predicates, ordering, and limits.
 */

import type { GraphIndex } from "./graph.js";
import { flattenFrontmatter, normalizeValue } from "./frontmatter.js";
import type { NoteRef, GraphNode, OilConfig } from "./types.js";

// ─── Predicate Types ──────────────────────────────────────────────────────────

export type Predicate = Record<string, unknown>;

export interface QueryOptions {
  where: Predicate;
  and?: Predicate[];
  or?: Predicate[];
  orderBy?: string;
  limit?: number;
  folder?: string;
}

// ─── Query Execution ──────────────────────────────────────────────────────────

/**
 * Execute a frontmatter predicate query across all notes in the graph.
 */
export function queryNotes(
  graph: GraphIndex,
  config: OilConfig,
  options: QueryOptions,
): NoteRef[] {
  const { where, and, or, orderBy, limit, folder } = options;

  // Collect candidate nodes
  let candidates: GraphNode[] = [];
  if (folder) {
    const refs = graph.getNotesByFolder(folder);
    for (const ref of refs) {
      const node = graph.getNode(ref.path);
      if (node) candidates.push(node);
    }
  } else {
    // Iterate all nodes via graph stats + node access
    // We need a way to iterate all nodes — use folder "" as prefix match-all
    const allRefs = graph.getNotesByFolder("");
    for (const ref of allRefs) {
      const node = graph.getNode(ref.path);
      if (node) candidates.push(node);
    }
  }

  // Apply WHERE predicate
  candidates = candidates.filter((n) => matchesPredicate(n, where, config));

  // Apply AND predicates (all must match)
  if (and?.length) {
    candidates = candidates.filter((n) =>
      and.every((pred) => matchesPredicate(n, pred, config)),
    );
  }

  // Apply OR predicates (at least one must match)
  if (or?.length) {
    candidates = candidates.filter((n) =>
      or.some((pred) => matchesPredicate(n, pred, config)),
    );
  }

  // Sort
  if (orderBy) {
    const descending = orderBy.startsWith("-");
    const field = descending ? orderBy.slice(1) : orderBy;

    candidates.sort((a, b) => {
      const aVal = getFieldValue(a, field, config);
      const bVal = getFieldValue(b, field, config);
      const cmp = compareValues(aVal, bVal);
      return descending ? -cmp : cmp;
    });
  }

  // Limit
  const capped = limit ? candidates.slice(0, limit) : candidates;

  return capped.map((n) => ({
    path: n.path,
    title: n.title,
    tags: n.tags,
  }));
}

// ─── Predicate Matching ───────────────────────────────────────────────────────

/**
 * Check if a node matches a predicate object.
 * Each key in the predicate is matched against frontmatter fields, tags, or path.
 */
function matchesPredicate(
  node: GraphNode,
  predicate: Predicate,
  config: OilConfig,
): boolean {
  for (const [key, expected] of Object.entries(predicate)) {
    if (!matchesField(node, key, expected, config)) {
      return false;
    }
  }
  return true;
}

/**
 * Match a single field in the predicate against a graph node.
 */
function matchesField(
  node: GraphNode,
  key: string,
  expected: unknown,
  config: OilConfig,
): boolean {
  // Special field: "tags" — check node.tags array
  if (key === "tags" || key === config.frontmatterSchema.tagsField) {
    return matchesTags(node.tags, expected);
  }

  // Special field: "folder" — check path prefix
  if (key === "folder") {
    return typeof expected === "string" && node.path.startsWith(expected);
  }

  // Map config field names to frontmatter keys
  const frontmatterKey = resolveFieldName(key, config);
  const actual = node.frontmatter[frontmatterKey];

  // Nested/custom field addressed by dotted path, e.g. "opportunities.guid".
  if (actual === undefined && key.includes(".")) {
    const target = key.toLowerCase();
    const values = flattenFrontmatter(node.frontmatter)
      .filter((f) => f.key === target)
      .map((f) => normalizeValue(f.value));
    if (values.length === 0) return false;

    const wanted = Array.isArray(expected) ? expected : [expected];
    return wanted.every(
      (w) => typeof w !== "object" && values.includes(normalizeValue(String(w))),
    );
  }

  // If expected is a string and actual is an array, check inclusion
  if (Array.isArray(actual) && typeof expected === "string") {
    return actual.some(
      (v) =>
        typeof v === "string" &&
        v.toLowerCase() === expected.toLowerCase(),
    );
  }

  // String comparison (case-insensitive)
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.toLowerCase() === expected.toLowerCase();
  }

  // Direct equality
  return actual === expected;
}

/**
 * Match tags — expected can be a string (single tag) or array (all must match).
 */
function matchesTags(nodeTags: string[], expected: unknown): boolean {
  if (typeof expected === "string") {
    return nodeTags.some((t) => t.toLowerCase() === expected.toLowerCase());
  }
  if (Array.isArray(expected)) {
    return expected.every((exp) =>
      typeof exp === "string" &&
      nodeTags.some((t) => t.toLowerCase() === exp.toLowerCase()),
    );
  }
  return false;
}

// ─── Field Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve user-facing field names to frontmatter keys using config mapping.
 */
function resolveFieldName(key: string, config: OilConfig): string {
  const fieldMap: Record<string, string> = {
    customer: config.frontmatterSchema.customerField,
    date: config.frontmatterSchema.dateField,
    status: config.frontmatterSchema.statusField,
    project: config.frontmatterSchema.projectField,
    tpid: config.frontmatterSchema.tpidField,
    accountid: config.frontmatterSchema.accountidField,
  };
  return fieldMap[key] ?? key;
}

/**
 * Get a field value from a node, resolving field names via config.
 */
function getFieldValue(
  node: GraphNode,
  field: string,
  config: OilConfig,
): unknown {
  if (field === "title") return node.title;
  if (field === "path") return node.path;
  const fmKey = resolveFieldName(field, config);
  return node.frontmatter[fmKey];
}

/**
 * Compare two values for sorting — handles strings, numbers, dates.
 */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  // Date strings
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (!isNaN(da) && !isNaN(db)) return da - db;
    return a.localeCompare(b);
  }

  if (typeof a === "number" && typeof b === "number") return a - b;

  return String(a).localeCompare(String(b));
}
