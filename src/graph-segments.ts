/**
 * OIL — Segmented graph persistence (format v3)
 *
 * The single `_oil-graph.json` is rewritten whole on every save, so one edited
 * note costs a full serialization of the vault — 24 MB at 7.6k notes. The
 * segmented layout keeps a small skeleton (titles, tags, links, mtimes and the
 * frontmatter fields link resolution and routing need) plus one segment file
 * per folder slice holding the bulky fields. A save rewrites only the segments
 * whose notes changed, then the skeleton.
 *
 * Layout, next to the legacy file:
 *
 *   .oil-graph/skeleton.json              always written last
 *   .oil-graph/seg-<slug>-<id>-<gen>.json one per segment key
 *
 * The directory is dot-prefixed so Obsidian, the watcher and the note walker
 * all ignore it.
 *
 * Segment file names carry the generation of the save that wrote them, and the
 * skeleton is replaced last, so a save is committed atomically: until the new
 * skeleton lands, readers keep seeing the old one and the files it names.
 * Superseded files are deleted afterwards.
 *
 * A segment that is missing, unreadable or of the wrong generation — two
 * writers racing, a sync client dropping a file — is treated as damaged: its
 * notes load with mtime 0, so the next revalidation re-reads them from the
 * vault. Nothing here can lose a note; the worst case is re-reading some.
 */

import { readFile, readdir, rmdir, stat, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import type { GraphLayout, OilConfig } from "./types.js";

export const SEGMENTED_FORMAT = "oil-graph-segmented";
export const SEGMENT_FORMAT = "oil-graph-segment";
export const SEGMENTED_VERSION = 3;
export const SKELETON_FILE = "skeleton.json";
/** Segment key for notes at the vault root. */
export const ROOT_SEGMENT = "_root";

export const GRAPH_LAYOUTS: readonly GraphLayout[] = ["auto", "single", "segmented"];

/** Files younger than this may belong to a save still in flight elsewhere. */
const SWEEP_MIN_AGE_MS = 60_000;

/** How notes are grouped into segments. */
export interface SegmentPolicy {
  peopleRoot: string;
  meetingsRoot: string;
  customersRoot: string;
  /** Folders split by year, like meetings. */
  datedFolders: string[];
  dateField: string;
}

export const DEFAULT_SEGMENT_POLICY: SegmentPolicy = {
  peopleRoot: "People/",
  meetingsRoot: "Meetings/",
  customersRoot: "Customers/",
  datedFolders: ["Daily/"],
  dateField: "date",
};

/** The per-note fields kept in the always-loaded skeleton. */
export interface SkeletonNode {
  path: string;
  title: string;
  tags: string[];
  rawOutLinks: string[];
  lastModified: number;
  segment: string;
  /** Aliases plus the routing fields (type, customer, date, status). */
  frontmatter: Record<string, unknown>;
}

export interface SegmentMeta {
  file: string;
  generation: string;
  /** sha1 of the serialized notes, so an unchanged segment is not rewritten. */
  hash: string;
  notes: number;
  bytes: number;
}

export interface PersistedSkeleton {
  format: typeof SEGMENTED_FORMAT;
  version: typeof SEGMENTED_VERSION;
  builtAt: string;
  policy: SegmentPolicy;
  segments: Record<string, SegmentMeta>;
  nodes: SkeletonNode[];
}

/** The per-note fields kept in a segment. */
export interface SegmentNote {
  path: string;
  headings: string[];
  bodySnippet: string;
  frontmatter: Record<string, unknown>;
}

export type SkeletonReadResult =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; skeleton: PersistedSkeleton };

// ─── Policy ──────────────────────────────────────────────────────────────────

/** "./Meetings" → "Meetings/"; empty stays empty (the rule is then off). */
function normalizeRoot(root: unknown): string {
  if (typeof root !== "string") return "";
  const trimmed = root.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function normalizeSegmentPolicy(policy: Partial<SegmentPolicy> | undefined): SegmentPolicy {
  const p = policy ?? {};
  const datedFolders = Array.isArray(p.datedFolders) ? p.datedFolders : DEFAULT_SEGMENT_POLICY.datedFolders;
  return {
    peopleRoot: normalizeRoot(p.peopleRoot ?? DEFAULT_SEGMENT_POLICY.peopleRoot),
    meetingsRoot: normalizeRoot(p.meetingsRoot ?? DEFAULT_SEGMENT_POLICY.meetingsRoot),
    customersRoot: normalizeRoot(p.customersRoot ?? DEFAULT_SEGMENT_POLICY.customersRoot),
    datedFolders: datedFolders.map(normalizeRoot).filter(Boolean),
    dateField:
      typeof p.dateField === "string" && p.dateField.trim() ? p.dateField.trim() : DEFAULT_SEGMENT_POLICY.dateField,
  };
}

/** The segment policy a vault's config implies. */
export function segmentPolicyFor(config: OilConfig): SegmentPolicy {
  return normalizeSegmentPolicy({
    peopleRoot: config.schema.peopleRoot,
    meetingsRoot: config.schema.meetingsRoot,
    customersRoot: config.schema.customersRoot,
    dateField: config.frontmatterSchema.dateField,
  });
}

/** GraphIndex constructor options for a vault's config. */
export function graphOptionsFor(config: OilConfig): { layout: GraphLayout; segmentPolicy: SegmentPolicy } {
  return { layout: config.search.graphLayout ?? "auto", segmentPolicy: segmentPolicyFor(config) };
}

/** Read a frontmatter field by exact name, then case-insensitively. */
function readField(frontmatter: Record<string, unknown> | undefined, field: string): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  if (field in frontmatter) return frontmatter[field];
  const wanted = field.toLowerCase();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The year a dated note belongs to: its date field, else a year in its path,
 * else "undated".
 *
 * A YAML date parses to a Date in memory but round-trips through JSON as an
 * ISO string; both give the same year here, so a note does not change segment
 * across a save and reload.
 */
function noteYear(relativePath: string, frontmatter: Record<string, unknown> | undefined, dateField: string): string {
  const value = readField(frontmatter, dateField);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return String(value.getUTCFullYear());
  if (typeof value === "string" && /^\d{4}/.test(value.trim())) return value.trim().slice(0, 4);
  if (typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 9999) return String(value);
  const match = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/.exec(relativePath);
  return match ? match[1] : "undated";
}

/**
 * Which segment a note belongs to.
 *
 * Meetings and dated folders split by year, so old years stay cold; people
 * split by initial; customers by hub folder; anything else by top-level folder.
 */
export function segmentKeyFor(
  notePath: string,
  frontmatter: Record<string, unknown> | undefined,
  policy: SegmentPolicy,
): string {
  const slash = notePath.indexOf("/");
  if (slash < 0) return ROOT_SEGMENT;

  for (const root of [policy.meetingsRoot, ...policy.datedFolders]) {
    if (root && notePath.startsWith(root)) {
      return `${root}${noteYear(notePath.slice(root.length), frontmatter, policy.dateField)}`;
    }
  }
  if (policy.peopleRoot && notePath.startsWith(policy.peopleRoot)) {
    const initial = notePath.charAt(policy.peopleRoot.length).toUpperCase();
    return `${policy.peopleRoot}${/^[A-Z]$/.test(initial) ? initial : "_"}`;
  }
  if (policy.customersRoot && notePath.startsWith(policy.customersRoot)) {
    const rest = notePath.slice(policy.customersRoot.length);
    const hubEnd = rest.indexOf("/");
    return `${policy.customersRoot}${hubEnd < 0 ? "_" : rest.slice(0, hubEnd)}`;
  }
  return notePath.slice(0, slash);
}

const SKELETON_FIELDS = new Set(["aliases", "alias", "type", "customer", "customers", "date", "status"]);

/** The frontmatter subset kept in the skeleton, by case-insensitive key. */
export function skeletonFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  policy: SegmentPolicy,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!frontmatter || typeof frontmatter !== "object") return out;
  const dateField = policy.dateField.toLowerCase();
  for (const [key, value] of Object.entries(frontmatter)) {
    const lower = key.toLowerCase();
    if (SKELETON_FIELDS.has(lower) || lower === dateField) out[key] = value;
  }
  return out;
}

// ─── Naming ──────────────────────────────────────────────────────────────────

/**
 * The segment directory for a legacy index file name, relative to the vault:
 * `_oil-graph.json` → `.oil-graph`.
 */
export function segmentDirFor(graphIndexFile: string): string {
  const stem = basename(graphIndexFile, extname(graphIndexFile)).replace(/^[._]+/, "") || "oil-graph";
  return join(dirname(graphIndexFile), `.${stem}`);
}

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** A fresh, unique generation id for one save. */
export function newGeneration(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Generations become part of a file name, so only this shape is accepted from disk. */
const GENERATION_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * A filesystem-safe, collision-free file name for one generation of a segment.
 *
 * The generation is in the name so a save writes new files beside the old
 * ones and commits by replacing the skeleton: a reader holding either skeleton
 * finds every file it names.
 */
export function segmentFileName(key: string, generation: string): string {
  const slug =
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x";
  return `seg-${slug}-${sha1(key).slice(0, 10)}-${generation}.json`;
}

/**
 * A segment file's text, assembled around notes already serialized for
 * hashing so the bulk of it is stringified once.
 */
export function segmentPayload(key: string, generation: string, notesJson: string): string {
  return (
    `{"format":${JSON.stringify(SEGMENT_FORMAT)},"version":${SEGMENTED_VERSION},` +
    `"key":${JSON.stringify(key)},"generation":${JSON.stringify(generation)},"notes":${notesJson}}`
  );
}

// ─── IO ──────────────────────────────────────────────────────────────────────

/**
 * Identifies one version of a file. A rename keeps all three parts, so the
 * stamp of a temp file is the stamp of the file it is renamed into.
 */
function stampOf(info: { mtimeMs: number; size: number; ino: number }): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`;
}

/**
 * The stamp of the skeleton in `dir`, or null when there is none. A process
 * compares it with the stamp it last wrote or read to tell whether another
 * process has replaced the skeleton since.
 */
export async function skeletonStamp(dir: string): Promise<string | null> {
  try {
    return stampOf(await stat(join(dir, SKELETON_FILE)));
  } catch {
    return null;
  }
}

/**
 * Write-then-rename, so a concurrent reader never sees a truncated file.
 * Windows fails the rename with EPERM while another process has the target
 * open for reading; that clears in milliseconds, so it is retried briefly.
 *
 * Returns the stamp of the written file, taken before the rename so it cannot
 * describe a file another process renamed in afterwards.
 */
export async function writeFileAtomic(fullPath: string, data: string): Promise<string> {
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    const stamp = stampOf(await stat(tmpPath));
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmpPath, fullPath);
        return stamp;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EACCES") || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Read and validate the skeleton in `dir` (absolute). */
export async function readSkeleton(dir: string): Promise<SkeletonReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, SKELETON_FILE), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    return { status: "invalid", reason: code ?? (err as Error).message };
  }

  let data: Partial<PersistedSkeleton>;
  try {
    data = JSON.parse(raw) as Partial<PersistedSkeleton>;
  } catch (err) {
    return { status: "invalid", reason: `unparseable: ${(err as Error).message}` };
  }
  if (!data || data.format !== SEGMENTED_FORMAT) return { status: "invalid", reason: "not a segmented graph skeleton" };
  if (data.version !== SEGMENTED_VERSION) return { status: "invalid", reason: `version ${String(data.version)}` };
  if (typeof data.builtAt !== "string") return { status: "invalid", reason: "builtAt missing" };
  if (!data.segments || typeof data.segments !== "object" || Array.isArray(data.segments)) {
    return { status: "invalid", reason: "segments is not an object" };
  }
  for (const [key, meta] of Object.entries(data.segments)) {
    if (
      !meta ||
      typeof meta.file !== "string" ||
      typeof meta.generation !== "string" ||
      !GENERATION_PATTERN.test(meta.generation) ||
      meta.file !== segmentFileName(key, meta.generation)
    ) {
      return { status: "invalid", reason: `bad segment entry '${key}'` };
    }
  }
  if (!Array.isArray(data.nodes)) return { status: "invalid", reason: "nodes is not an array" };
  for (const node of data.nodes) {
    if (
      !node ||
      typeof node.path !== "string" ||
      typeof node.title !== "string" ||
      !isStringArray(node.tags) ||
      !isStringArray(node.rawOutLinks) ||
      typeof node.lastModified !== "number" ||
      typeof node.segment !== "string" ||
      !node.frontmatter ||
      typeof node.frontmatter !== "object"
    ) {
      return { status: "invalid", reason: "invalid node shape" };
    }
  }
  return {
    status: "ok",
    skeleton: { ...(data as PersistedSkeleton), policy: normalizeSegmentPolicy(data.policy) },
  };
}

/**
 * Read one segment, or null when it is missing, unreadable, or not the
 * generation the skeleton expects.
 */
export async function readSegment(dir: string, key: string, meta: SegmentMeta): Promise<SegmentNote[] | null> {
  try {
    const data = JSON.parse(await readFile(join(dir, meta.file), "utf-8")) as {
      format?: unknown;
      version?: unknown;
      key?: unknown;
      generation?: unknown;
      notes?: unknown;
    };
    if (
      data.format !== SEGMENT_FORMAT ||
      data.version !== SEGMENTED_VERSION ||
      data.key !== key ||
      data.generation !== meta.generation ||
      !Array.isArray(data.notes)
    ) {
      return null;
    }
    const notes = data.notes as SegmentNote[];
    for (const note of notes) {
      if (
        !note ||
        typeof note.path !== "string" ||
        !isStringArray(note.headings) ||
        typeof note.bodySnippet !== "string" ||
        !note.frontmatter ||
        typeof note.frontmatter !== "object"
      ) {
        return null;
      }
    }
    return notes;
  } catch {
    return null;
  }
}

/**
 * Delete a segmented layout: the skeleton first, so a concurrent reader sees
 * "no segmented index" rather than half of one, then segments and temp files.
 * Removes the directory once empty. Returns the number of files removed.
 */
export async function removeSegmentFiles(dir: string): Promise<number> {
  let removed = 0;
  try {
    await unlink(join(dir, SKELETON_FILE));
    removed++;
  } catch {
    // Already gone, or never there.
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const ours = /^seg-.+\.json$/.test(name) || name.endsWith(".tmp") || /^skeleton.*\.json$/.test(name);
    if (!ours) continue;
    try {
      await unlink(join(dir, name));
      removed++;
    } catch {
      // Locked or gone — harmless; nothing references it any more.
    }
  }
  await rmdir(dir).catch(() => {});
  return removed;
}

/** True when `fullPath` parses as one of our segmented-format files. */
async function isOurs(fullPath: string): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(fullPath, "utf-8")) as { format?: unknown };
    return data.format === SEGMENT_FORMAT || data.format === SEGMENTED_FORMAT;
  } catch {
    return false;
  }
}

/**
 * Clear debris from the segment directory: temp files from a killed save,
 * segments no skeleton references any more, and sync-conflict copies.
 *
 * Only files older than a minute are touched, so a save still in flight in
 * another process keeps the files it has written but not yet referenced. A
 * `.json` is removed only once it parses as ours. Returns the number removed.
 */
export async function sweepSegmentDir(
  dir: string,
  referenced: ReadonlySet<string>,
  options: { tempsOnly?: boolean; now?: number } = {},
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const now = options.now ?? Date.now();
  let removed = 0;
  for (const name of entries) {
    const isTemp = name.endsWith(".tmp");
    const isStrayJson = !options.tempsOnly && name.endsWith(".json") && name !== SKELETON_FILE && !referenced.has(name);
    if (!isTemp && !isStrayJson) continue;
    const fullPath = join(dir, name);
    try {
      const info = await stat(fullPath);
      if (!info.isFile() || now - info.mtimeMs < SWEEP_MIN_AGE_MS) continue;
      if (isStrayJson && !(await isOurs(fullPath))) continue;
      await unlink(fullPath);
      removed++;
    } catch {
      // Gone already, or locked by a reader — try again next time.
    }
  }
  return removed;
}
