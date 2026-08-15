/**
 * OIL — Frontmatter flattening
 *
 * Turns nested frontmatter into flat `key.path` → value pairs so custom
 * structures are queryable. A vault that records opportunities as
 *
 *   opportunities:
 *     - name: Cloud Foundation
 *       guid: aabbccdd-…
 *
 * yields `opportunities.name` and `opportunities.guid` as first-class keys.
 * Array indices are deliberately omitted from the path so every element of a
 * collection aggregates under one queryable key.
 */

export interface FlatField {
  /** Dotted path, e.g. "opportunities.guid". Always lowercase. */
  key: string;
  /** Original value, casing preserved for display. */
  value: string;
}

const MAX_DEPTH = 5;
/** Ceiling on fields per note, so one pathological file cannot bloat the index. */
const MAX_FIELDS = 250;
/** Values longer than this are prose, not identifiers; body indexing covers them. */
const MAX_VALUE_CHARS = 400;

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

/**
 * Flatten a frontmatter object into dotted key/value pairs.
 * Returns an empty array for anything that is not a plain object.
 */
export function flattenFrontmatter(frontmatter: unknown): FlatField[] {
  const out: FlatField[] = [];
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return out;
  }

  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;

    if (isScalar(node)) {
      const value = String(node).trim();
      if (value && value.length <= MAX_VALUE_CHARS) out.push({ key: path, value });
      return;
    }

    if (node instanceof Date) {
      out.push({ key: path, value: node.toISOString().slice(0, 10) });
      return;
    }

    if (Array.isArray(node)) {
      // No index in the path: every element aggregates under one key.
      for (const item of node) walk(item, path, depth + 1);
      return;
    }

    if (node && typeof node === "object") {
      for (const [childKey, childValue] of Object.entries(node)) {
        const nextPath = path ? `${path}.${childKey.toLowerCase()}` : childKey.toLowerCase();
        walk(childValue, nextPath, depth + 1);
      }
    }
  };

  for (const [key, value] of Object.entries(frontmatter as Record<string, unknown>)) {
    walk(value, key.toLowerCase(), 0);
  }

  return out;
}

/** Case-insensitive form used for exact-value lookups. */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}
