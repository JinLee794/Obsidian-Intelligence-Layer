/**
 * OIL — Archive policy
 *
 * The single answer to "is this note archived?", shared by every index that
 * partitions on it. Kept free of dependencies so the search, BM25 and semantic
 * layers can all consult it without import cycles.
 *
 * A note is archived when it lives under the archive root (move mode) or carries
 * `archived: true` in its frontmatter (flag mode). Both are honoured whichever
 * mode is configured, so switching modes never strands notes archived earlier.
 * With archiving disabled nothing is archived, and every index behaves exactly
 * as it did before the feature existed.
 */

/**
 * Which partition of the vault a search covers.
 *
 * `fallback` is a search-level strategy rather than a partition: search the
 * active vault first and consult the archive only when that comes up short.
 */
export type ArchiveScope = "active" | "archive" | "all";
export type ArchiveSearchScope = ArchiveScope | "fallback";

/** Frontmatter key that flags a note as archived in place. */
export const ARCHIVED_FLAG = "archived";

interface Policy {
  enabled: boolean;
  root: string;
  defaultScope: ArchiveSearchScope;
  embedArchived: boolean;
}

let policy: Policy = {
  enabled: false,
  root: "Archive/",
  defaultScope: "fallback",
  embedArchived: false,
};
let generation = 0;

/** Normalise a folder setting to a vault-relative prefix ending in "/". */
export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!trimmed) return "";
  return trimmed.replace(/\/*$/, "/");
}

export function setArchivePolicy(next: {
  enabled: boolean;
  root: string;
  defaultScope?: ArchiveSearchScope;
  embedArchived?: boolean;
}): void {
  policy = {
    enabled: next.enabled,
    root: normalizeFolder(next.root) || "Archive/",
    defaultScope: next.defaultScope ?? "fallback",
    embedArchived: next.embedArchived ?? false,
  };
  // Every cached index partitioned on the old policy is now wrong.
  generation++;
}

/** Bumped on every policy change, so partitioned caches know to rebuild. */
export function archivePolicyGeneration(): number {
  return generation;
}

export function archivingEnabled(): boolean {
  return policy.enabled;
}

export function archiveRoot(): string {
  return policy.root;
}

/** Whether archived notes still get embeddings (off: the archive costs nothing). */
export function shouldEmbedArchived(): boolean {
  return !policy.enabled || policy.embedArchived;
}

export function defaultArchiveScope(): ArchiveSearchScope {
  return policy.enabled ? policy.defaultScope : "all";
}

export function isUnderArchiveRoot(path: string, root: string = policy.root): boolean {
  return root !== "" && path.startsWith(root);
}

export function isArchivedNote(
  path: string,
  frontmatter?: Record<string, unknown> | null,
): boolean {
  if (!policy.enabled) return false;
  if (isUnderArchiveRoot(path)) return true;
  return isFlaggedArchived(frontmatter);
}

export function isFlaggedArchived(frontmatter?: Record<string, unknown> | null): boolean {
  const flag = frontmatter?.[ARCHIVED_FLAG];
  return flag === true || flag === "true";
}

/**
 * The partition an index should be built over. With archiving off there is only
 * one partition, which keeps the single shared index the feature-off path used.
 */
export function partitionFor(scope: ArchiveScope | undefined): ArchiveScope {
  if (!policy.enabled) return "all";
  return scope ?? "active";
}

export function inPartition(
  partition: ArchiveScope,
  path: string,
  frontmatter?: Record<string, unknown> | null,
): boolean {
  if (partition === "all") return true;
  return isArchivedNote(path, frontmatter) === (partition === "archive");
}
