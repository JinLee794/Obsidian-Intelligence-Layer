/**
 * OIL — Graph index migration
 *
 * Moves a vault's persisted graph index between the single file (v2,
 * `_oil-graph.json`) and the segmented layout (v3, `.oil-graph/`), and checks
 * an index against the notes it was built from.
 *
 * The index is derived data — OIL revalidates every note's mtime on each start
 * — so a migration cannot lose notes. What it must never do is leave a vault
 * with no loadable index, or with one that disagrees with its source. Every
 * write is therefore checked by loading what was written into a fresh index
 * and comparing it with the source, note by note and link by link; on any
 * difference the write is undone and the original layout stays in place.
 *
 *   plan      report what a migration would write; changes nothing
 *   apply     single → segmented; the old file is kept as a backup
 *   verify    load the active layout and compare it with a fresh build
 *   rollback  segmented → single
 */

import { readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { GraphIndex, readAliases } from "./graph.js";
import type { PersistedGraphNode, PersistedLayout, SegmentHealth, SegmentedLayoutPlan } from "./graph.js";
import { SKELETON_FILE, normalizeSegmentPolicy, readSkeleton, segmentDirFor } from "./graph-segments.js";
import type { SegmentPolicy } from "./graph-segments.js";
import { acquireIndexLock } from "./index-lock.js";
import type { IndexLease } from "./index-lock.js";
import { sameMtime } from "./sidecar-sync.js";
import type { GraphLayout } from "./types.js";
import { listAllNotes } from "./vault.js";

export type MigrateAction = "plan" | "apply" | "verify" | "rollback";

export interface MigrateOptions {
  /** The legacy index file, relative to the vault (config `search.graph_index_file`). */
  graphIndexFile: string;
  segmentPolicy?: Partial<SegmentPolicy>;
  /** The layout OIL is configured to use; only used to warn about conflicts. */
  configuredLayout?: GraphLayout;
  /** apply: keep the single file rather than renaming it to the backup. */
  keepLegacy?: boolean;
  /** apply: build from the notes instead of converting the persisted index. */
  rebuild?: boolean;
  /** How long apply/rollback wait for an OIL process indexing this vault. */
  lockWaitMs?: number;
  log?: (message: string) => void;
}

export interface LayoutStatus {
  /** The layout OIL would load, given the configured preference. */
  active: PersistedLayout | "none";
  single: { file: string; present: boolean; bytes: number };
  segmented: {
    dir: string;
    present: boolean;
    valid: boolean;
    /** Why the skeleton was rejected, when present but not valid. */
    reason?: string;
    nodes: number;
    segments: number;
    files: number;
    bytes: number;
    skeletonBytes: number;
  };
  backup: { file: string; present: boolean; bytes: number };
}

export interface PlanSummary {
  /** Size of the single file today, 0 when there is none. */
  legacyBytes: number;
  skeletonBytes: number;
  segments: number;
  totalBytes: number;
  largestSegment: { key: string; notes: number; bytes: number } | null;
  medianSegmentBytes: number;
  /** What a one-note edit rewrites: the skeleton plus one median-sized segment. */
  typicalFlushBytes: number;
  segmentList: SegmentedLayoutPlan["segments"];
}

export interface ParityReport {
  nodes: number;
  /** Notes the reference has and the checked index lacks, and vice versa (samples). */
  missing: string[];
  extra: string[];
  /** Notes whose persisted fields differ (sample), and how many in all. */
  contentMismatches: string[];
  contentMismatchCount: number;
  /** Notes whose resolved out- or in-links differ (sample), and how many in all. */
  linkMismatches: string[];
  linkMismatchCount: number;
  /**
   * Notes whose links differ only through a name two or more notes answer to.
   * Such a name resolves to whichever claimant was indexed last, and indexing
   * order drifts as notes come and go, so the single file differs from a fresh
   * build in exactly the same way. Reported, not failed.
   */
  ambiguousLinkDiffs: number;
  ok: boolean;
}

export interface MigrateReport {
  action: MigrateAction;
  vault: string;
  ok: boolean;
  /** Whether anything in the vault was written, renamed or removed. */
  changed: boolean;
  before: LayoutStatus;
  after: LayoutStatus;
  /** Where the index that was converted or checked came from. */
  source?: PersistedLayout | "backup" | "build";
  nodes?: number;
  plan?: PlanSummary;
  parity?: ParityReport;
  health?: SegmentHealth | null;
  /** verify: notes the persisted index had not caught up with. */
  stale?: { changed: number; added: number; deleted: number };
  /** apply: the backup the single file was renamed to, relative to the vault. */
  backupFile?: string;
  written?: { files: number; bytes: number };
  messages: string[];
  errors: string[];
}

const SAMPLE_LIMIT = 20;
const STAT_CONCURRENCY = 32;
const DEFAULT_LOCK_WAIT_MS = 60_000;

/**
 * Where `apply` moves the single file: `_oil-graph.json` → `_oil-graph.v2-backup.json`.
 *
 * Chosen so the sync-conflict sweep, which removes `_oil-graph-<x>.json` and
 * `_oil-graph (<x>).json`, never mistakes the backup for a conflict copy.
 */
export function backupFileFor(graphIndexFile: string): string {
  const ext = extname(graphIndexFile) || ".json";
  const stem = basename(graphIndexFile, extname(graphIndexFile));
  return join(dirname(graphIndexFile), `${stem}.v2-backup${ext}`);
}

async function fileSize(fullPath: string): Promise<number | null> {
  try {
    const info = await stat(fullPath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** What is on disk for this vault's graph index, without loading it. */
export async function readLayoutStatus(
  vaultPath: string,
  graphIndexFile: string,
  configuredLayout: GraphLayout = "auto",
): Promise<LayoutStatus> {
  const segDir = segmentDirFor(graphIndexFile);
  const dirPath = join(vaultPath, segDir);
  const backupRel = backupFileFor(graphIndexFile);
  const [singleBytes, backupBytes, skeleton] = await Promise.all([
    fileSize(join(vaultPath, graphIndexFile)),
    fileSize(join(vaultPath, backupRel)),
    readSkeleton(dirPath),
  ]);

  let files = 0;
  let bytes = 0;
  let skeletonBytes = 0;
  try {
    for (const name of await readdir(dirPath)) {
      if (!name.endsWith(".json")) continue;
      const size = await fileSize(join(dirPath, name));
      if (size === null) continue;
      files++;
      bytes += size;
      if (name === SKELETON_FILE) skeletonBytes = size;
    }
  } catch {
    // No segment directory.
  }

  const segmented: LayoutStatus["segmented"] = {
    dir: segDir,
    present: skeleton.status !== "missing",
    valid: skeleton.status === "ok",
    nodes: skeleton.status === "ok" ? skeleton.skeleton.nodes.length : 0,
    segments: skeleton.status === "ok" ? Object.keys(skeleton.skeleton.segments).length : 0,
    files,
    bytes,
    skeletonBytes,
  };
  if (skeleton.status === "invalid") segmented.reason = skeleton.reason;
  const single = { file: graphIndexFile, present: singleBytes !== null, bytes: singleBytes ?? 0 };

  let active: LayoutStatus["active"] = "none";
  if (configuredLayout === "single") active = single.present ? "single" : segmented.valid ? "segmented" : "none";
  else active = segmented.valid ? "segmented" : single.present ? "single" : "none";

  return { active, single, segmented, backup: { file: backupRel, present: backupBytes !== null, bytes: backupBytes ?? 0 } };
}

function summarizePlan(plan: SegmentedLayoutPlan, legacyBytes: number): PlanSummary {
  const sizes = plan.segments.map((s) => s.bytes).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
  const largest = plan.segments.reduce<PlanSummary["largestSegment"]>(
    (best, s) => (!best || s.bytes > best.bytes ? s : best),
    null,
  );
  return {
    legacyBytes,
    skeletonBytes: plan.skeletonBytes,
    segments: plan.segments.length,
    totalBytes: plan.skeletonBytes + sizes.reduce((sum, n) => sum + n, 0),
    largestSegment: largest,
    medianSegmentBytes: median,
    typicalFlushBytes: plan.skeletonBytes + median,
    segmentList: plan.segments,
  };
}

// ─── Parity ──────────────────────────────────────────────────────────────────

function persistedByPath(graph: GraphIndex): Map<string, PersistedGraphNode> {
  return new Map(graph.toPersistedNodes().map((node) => [node.path, node]));
}

function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  for (const x of b) if (!a.has(x)) out.push(x);
  return out;
}

/**
 * Notes that answer to a name another note also answers to. Titles and
 * filenames share one namespace and aliases another; a title always beats an
 * alias, so only a collision within a namespace makes resolution order-dependent.
 */
function ambiguousPaths(nodes: Iterable<PersistedGraphNode>): Set<string> {
  const names = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  const claim = (index: Map<string, Set<string>>, key: string, path: string) => {
    let paths = index.get(key);
    if (!paths) {
      paths = new Set();
      index.set(key, paths);
    }
    paths.add(path);
  };
  for (const node of nodes) {
    claim(names, node.title.toLowerCase(), node.path);
    claim(names, basename(node.path, extname(node.path)).toLowerCase(), node.path);
    for (const alias of readAliases(node.frontmatter)) claim(aliases, alias.toLowerCase(), node.path);
  }
  const out = new Set<string>();
  for (const index of [names, aliases]) {
    for (const paths of index.values()) if (paths.size > 1) for (const path of paths) out.add(path);
  }
  return out;
}

function stripMtime(node: PersistedGraphNode): string {
  return JSON.stringify({ ...node, lastModified: 0 });
}

/**
 * Compare `actual` with `reference`.
 *
 * "exact": a save-and-reload round trip — every persisted field and every
 * resolved link must match. "fresh": `reference` is a new build from the
 * notes — mtimes compare across precisions, and link differences confined to
 * ambiguous names are counted, not failed.
 */
export function compareGraphs(reference: GraphIndex, actual: GraphIndex, mode: "exact" | "fresh"): ParityReport {
  const expected = persistedByPath(reference);
  const got = persistedByPath(actual);
  const missing = [...expected.keys()].filter((path) => !got.has(path));
  const extra = [...got.keys()].filter((path) => !expected.has(path));
  const ambiguous = mode === "fresh" ? ambiguousPaths([...expected.values(), ...got.values()]) : new Set<string>();

  const contentMismatches: string[] = [];
  const linkMismatches: string[] = [];
  let ambiguousLinkDiffs = 0;
  for (const [path, want] of expected) {
    const have = got.get(path);
    if (!have) continue;
    const sameContent =
      mode === "exact"
        ? JSON.stringify(want) === JSON.stringify(have)
        : stripMtime(want) === stripMtime(have) && sameMtime(want.lastModified, have.lastModified);
    if (!sameContent) contentMismatches.push(path);

    const a = reference.getNode(path);
    const b = actual.getNode(path);
    if (!a || !b) continue;
    const outDiff = symmetricDifference(a.outLinks, b.outLinks);
    const inDiff = symmetricDifference(a.inLinks, b.inLinks);
    if (outDiff.length === 0 && inDiff.length === 0) continue;
    const explained =
      mode === "fresh" && outDiff.every((p) => ambiguous.has(p)) && (inDiff.length === 0 || ambiguous.has(path));
    if (explained) ambiguousLinkDiffs++;
    else linkMismatches.push(path);
  }

  return {
    nodes: expected.size,
    missing: missing.slice(0, SAMPLE_LIMIT),
    extra: extra.slice(0, SAMPLE_LIMIT),
    contentMismatches: contentMismatches.slice(0, SAMPLE_LIMIT),
    contentMismatchCount: contentMismatches.length,
    linkMismatches: linkMismatches.slice(0, SAMPLE_LIMIT),
    linkMismatchCount: linkMismatches.length,
    ambiguousLinkDiffs,
    ok: missing.length === 0 && extra.length === 0 && contentMismatches.length === 0 && linkMismatches.length === 0,
  };
}

function describeParity(parity: ParityReport, what: string): string[] {
  const out: string[] = [];
  const total = (sample: string[], count: number) => `${count}${count > sample.length ? ` (first ${sample.length})` : ""}`;
  if (parity.missing.length) out.push(`${what}: notes missing: ${parity.missing.join(", ")}`);
  if (parity.extra.length) out.push(`${what}: unexpected notes: ${parity.extra.join(", ")}`);
  if (parity.contentMismatchCount) {
    out.push(
      `${what}: ${total(parity.contentMismatches, parity.contentMismatchCount)} note(s) differ: ${parity.contentMismatches.join(", ")}`,
    );
  }
  if (parity.linkMismatchCount) {
    out.push(
      `${what}: ${total(parity.linkMismatches, parity.linkMismatchCount)} note(s) have different links: ${parity.linkMismatches.join(", ")}`,
    );
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function newGraph(vaultPath: string, options: MigrateOptions, layout: GraphLayout): GraphIndex {
  return new GraphIndex(vaultPath, { layout, segmentPolicy: options.segmentPolicy });
}

/**
 * Take the graph lock so a migration cannot interleave with an OIL process's
 * startup indexing. Fails rather than proceeding unlocked: unlike indexing,
 * a migration can always be retried later.
 */
async function takeGraphLock(vaultPath: string, options: MigrateOptions): Promise<IndexLease> {
  const log = options.log ?? ((message: string) => console.error(message));
  const deadline = Date.now() + (options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  let announced = false;
  for (;;) {
    const lease = await acquireIndexLock(vaultPath, "graph", { wait: false, log });
    if (lease) return lease;
    if (Date.now() >= deadline) {
      throw new Error(
        "another OIL process is indexing this vault. Let it finish (or close your MCP clients) and retry.",
      );
    }
    if (!announced) {
      announced = true;
      log("[OIL] Another OIL process is indexing this vault — waiting for it to finish.");
    }
    await new Promise((r) => setTimeout(r, Math.min(1_000, Math.max(50, deadline - Date.now()))));
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Bring a loaded index up to date with the vault in memory only — what OIL's
 * startup revalidation would do, minus the save.
 */
async function refreshInMemory(
  graph: GraphIndex,
  vaultPath: string,
): Promise<{ changed: number; added: number; deleted: number }> {
  const notes = await listAllNotes(vaultPath);
  const present = new Set(notes);
  const cached = new Map(graph.toPersistedNodes().map((node) => [node.path, node.lastModified]));
  const deleted = [...cached.keys()].filter((path) => !present.has(path));
  const mtimes = await mapLimit(notes, STAT_CONCURRENCY, async (path) => {
    try {
      return (await stat(join(vaultPath, path))).mtimeMs;
    } catch {
      return null;
    }
  });
  const changed: string[] = [];
  const added: string[] = [];
  notes.forEach((path, i) => {
    const mtime = mtimes[i];
    if (mtime === null) return;
    const before = cached.get(path);
    if (before === undefined) added.push(path);
    else if (!sameMtime(mtime, before)) changed.push(path);
  });
  if (deleted.length) graph.removeNotes(deleted);
  if (changed.length || added.length) await graph.updateNotes([...changed, ...added]);
  return { changed: changed.length, added: added.length, deleted: deleted.length };
}

function baseReport(action: MigrateAction, vaultPath: string, before: LayoutStatus): MigrateReport {
  return { action, vault: vaultPath, ok: false, changed: false, before, after: before, messages: [], errors: [] };
}

function configuredLayoutWarning(options: MigrateOptions, wanted: PersistedLayout): string | null {
  const configured = options.configuredLayout ?? "auto";
  if (configured === "auto" || configured === wanted) return null;
  return (
    `OIL is configured for the ${configured} layout (search.graph_layout in oil.config.yaml, or OIL_GRAPH_LAYOUT) ` +
    `and will convert the index back on its next save. Set it to "auto" or "${wanted}".`
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Report what `apply` would write. Writes nothing. */
export async function planMigration(vaultPath: string, options: MigrateOptions): Promise<MigrateReport> {
  const file = options.graphIndexFile;
  const before = await readLayoutStatus(vaultPath, file, options.configuredLayout);
  const report = baseReport("plan", vaultPath, before);
  const graph = newGraph(vaultPath, options, "auto");

  if (before.segmented.valid && (await graph.loadLayout(file, "segmented"))) report.source = "segmented";
  else if (before.single.present && (await graph.loadLayout(file, "single"))) report.source = "single";
  else {
    await graph.build();
    report.source = "build";
    report.messages.push("No loadable index found; the plan is based on a fresh build from the notes.");
  }
  report.nodes = graph.nodeCount;
  report.plan = summarizePlan(graph.planSegmentedLayout(), before.single.bytes);

  if (before.active === "segmented") {
    report.messages.push(
      "This vault already uses the segmented layout. `--apply --rebuild` re-creates it; `--rollback` returns to the single file.",
    );
  } else {
    report.messages.push("Nothing was changed. Re-run with --apply to migrate.");
  }
  const warning = configuredLayoutWarning(options, "segmented");
  if (warning) report.messages.push(warning);
  report.ok = true;
  return report;
}

/** Convert to the segmented layout, verify the result, then retire the single file. */
export async function applyMigration(vaultPath: string, options: MigrateOptions): Promise<MigrateReport> {
  const file = options.graphIndexFile;
  const lease = await takeGraphLock(vaultPath, options);
  try {
    const before = await readLayoutStatus(vaultPath, file, "auto");
    const report = baseReport("apply", vaultPath, before);
    const graph = newGraph(vaultPath, options, "segmented");

    let alreadyDone = false;
    if (before.segmented.valid && !options.rebuild && (await graph.loadLayout(file, "segmented"))) {
      report.source = "segmented";
      report.health = graph.segmentHealth;
      alreadyDone = (graph.segmentHealth?.damagedSegments.length ?? 0) === 0;
    }

    if (alreadyDone) {
      report.nodes = graph.nodeCount;
      report.messages.push("Already migrated: the segmented layout is in place and loads cleanly.");
    } else {
      if (options.rebuild) {
        await graph.build();
        report.source = "build";
      } else if (report.source !== "segmented") {
        if (before.single.present && (await graph.loadLayout(file, "single"))) report.source = "single";
        else {
          await graph.build();
          report.source = "build";
          report.messages.push("No loadable index found; built one from the notes.");
        }
      } else {
        const health = graph.segmentHealth;
        report.messages.push(
          `Repairing ${health?.damagedSegments.length ?? 0} damaged segment(s); ` +
            `${health?.recoveredNotes ?? 0} note(s) will be re-read from the vault on OIL's next start.`,
        );
      }
      report.nodes = graph.nodeCount;
      report.plan = summarizePlan(graph.planSegmentedLayout(), before.single.bytes);

      await graph.saveToDisk(file, { layout: "segmented" });
      report.changed = true;
      const saved = graph.lastSave;
      if (saved) report.written = { files: saved.filesWritten, bytes: saved.bytesWritten };

      const check = newGraph(vaultPath, options, "segmented");
      const loaded = await check.loadLayout(file, "segmented");
      report.health = check.segmentHealth;
      const damaged = check.segmentHealth?.damagedSegments ?? [];
      if (loaded) report.parity = compareGraphs(graph, check, "exact");

      if (!loaded || damaged.length > 0 || !report.parity?.ok) {
        if (!loaded) report.errors.push("The segmented index just written does not load.");
        if (damaged.length) report.errors.push(`Segments unreadable after writing: ${damaged.join(", ")}.`);
        if (report.parity) report.errors.push(...describeParity(report.parity, "Segmented vs source"));
        // Undo. Prefer the untouched single file; otherwise persist the
        // source as one, so the vault is never left without an index.
        if (before.single.present && report.source === "single") {
          await graph.removeSegmentedLayout(file);
          report.errors.push("The segmented files were removed; the single file is unchanged.");
        } else {
          await graph.saveToDisk(file, { layout: "single" });
          report.errors.push("Saved the source index as a single file instead.");
        }
        report.after = await readLayoutStatus(vaultPath, file, "auto");
        return report;
      }
    }

    const after = await readLayoutStatus(vaultPath, file, "auto");
    if (after.single.present && !options.keepLegacy) {
      await rename(join(vaultPath, file), join(vaultPath, after.backup.file));
      report.changed = true;
      report.backupFile = after.backup.file;
      report.messages.push(
        `Kept the previous index as ${after.backup.file}. \`--rollback\` restores the single file; delete the backup once you are satisfied.`,
      );
    } else if (after.single.present) {
      report.messages.push(`Left ${file} in place (--keep-legacy). OIL ignores it while the segmented layout loads.`);
    }
    const warning = configuredLayoutWarning(options, "segmented");
    if (warning) report.messages.push(warning);
    report.after = await readLayoutStatus(vaultPath, file, "auto");
    report.ok = true;
    return report;
  } finally {
    await lease.release();
  }
}

/**
 * Load the active layout, bring it up to date in memory, and compare it with
 * a fresh build from the notes. Writes nothing.
 */
export async function verifyGraph(vaultPath: string, options: MigrateOptions): Promise<MigrateReport> {
  const file = options.graphIndexFile;
  const before = await readLayoutStatus(vaultPath, file, options.configuredLayout);
  const report = baseReport("verify", vaultPath, before);
  if (before.active === "none") {
    report.errors.push(
      before.segmented.present
        ? `The segmented index is invalid (${before.segmented.reason ?? "unknown"}) and there is no single file.`
        : "No persisted graph index found. Start OIL once, or run `migrate-graph --apply`.",
    );
    return report;
  }

  const graph = newGraph(vaultPath, options, "auto");
  if (!(await graph.loadLayout(file, before.active))) {
    report.errors.push(`The ${before.active} index does not load.`);
    return report;
  }
  report.source = before.active;
  report.nodes = graph.nodeCount;
  report.health = graph.segmentHealth;
  const damaged = graph.segmentHealth?.damagedSegments ?? [];
  if (damaged.length) {
    report.errors.push(
      `${damaged.length} damaged segment(s): ${damaged.join(", ")}. OIL re-reads their notes on its next start; ` +
        "`migrate-graph --apply --rebuild` rewrites them now.",
    );
  }

  if (before.active === "segmented") {
    const skeleton = await readSkeleton(join(vaultPath, before.segmented.dir));
    const wanted = JSON.stringify(normalizeSegmentPolicy(options.segmentPolicy));
    if (skeleton.status === "ok" && JSON.stringify(skeleton.skeleton.policy) !== wanted) {
      report.messages.push("Segment grouping differs from the current config; OIL regroups on its next save.");
    }
    if (before.single.present) {
      report.messages.push(`${file} is also present; it is stale and ignored while the segmented layout loads.`);
    }
    const warning = configuredLayoutWarning(options, "segmented");
    if (warning) report.messages.push(warning);
  } else if (before.segmented.present && !before.segmented.valid) {
    report.messages.push(`Ignoring an invalid segmented index (${before.segmented.reason ?? "unknown"}).`);
  }

  report.stale = await refreshInMemory(graph, vaultPath);
  const { changed, added, deleted } = report.stale;
  if (changed + added + deleted > 0) {
    report.messages.push(
      `The persisted index is behind the vault by ${changed} changed, ${added} new and ${deleted} deleted note(s); ` +
        "OIL catches up on its next start.",
    );
  }

  const fresh = newGraph(vaultPath, options, "auto");
  await fresh.build();
  report.parity = compareGraphs(fresh, graph, "fresh");
  if (report.parity.ambiguousLinkDiffs > 0) {
    report.messages.push(
      `${report.parity.ambiguousLinkDiffs} note(s) link through names several notes share; ` +
        "those resolve by indexing order, as with the single file. Not an error.",
    );
  }
  report.errors.push(...describeParity(report.parity, "Index vs fresh build"));
  report.ok = report.errors.length === 0;
  return report;
}

/** Return to the single file, from the segmented index or else the backup. */
export async function rollbackMigration(vaultPath: string, options: MigrateOptions): Promise<MigrateReport> {
  const file = options.graphIndexFile;
  const lease = await takeGraphLock(vaultPath, options);
  try {
    const before = await readLayoutStatus(vaultPath, file, "auto");
    const report = baseReport("rollback", vaultPath, before);

    if (!before.segmented.present && before.single.present) {
      report.source = "single";
      report.messages.push("Already on the single-file layout; nothing to roll back.");
      report.ok = true;
      return report;
    }

    const graph = newGraph(vaultPath, options, "single");
    if (before.segmented.valid && (await graph.loadLayout(file, "segmented"))) {
      report.source = "segmented";
      const health = graph.segmentHealth;
      if (health && health.damagedSegments.length) {
        report.messages.push(
          `${health.recoveredNotes} note(s) came from damaged segments; OIL re-reads them on its next start.`,
        );
      }
    } else if (before.single.present && (await graph.loadLayout(file, "single"))) {
      report.source = "single";
    } else if (before.backup.present && (await graph.loadLayout(before.backup.file, "single"))) {
      report.source = "backup";
    } else {
      await graph.build();
      report.source = "build";
      report.messages.push("No loadable index found; built one from the notes.");
    }
    report.nodes = graph.nodeCount;

    // Explicit "single": writes the file, then removes the segmented layout.
    await graph.saveToDisk(file, { layout: "single" });
    report.changed = true;
    const saved = graph.lastSave;
    if (saved) report.written = { files: saved.filesWritten, bytes: saved.bytesWritten };

    const check = newGraph(vaultPath, options, "single");
    const loaded = await check.loadLayout(file, "single");
    if (loaded) report.parity = compareGraphs(graph, check, "exact");
    if (!loaded || !report.parity?.ok) {
      if (!loaded) report.errors.push("The single file just written does not load.");
      if (report.parity) report.errors.push(...describeParity(report.parity, "Single vs source"));
      if (report.source === "segmented") {
        await graph.saveToDisk(file, { layout: "segmented" });
        report.errors.push("Restored the segmented layout from memory.");
      }
      report.after = await readLayoutStatus(vaultPath, file, "auto");
      return report;
    }

    const after = await readLayoutStatus(vaultPath, file, "auto");
    if (after.backup.present) {
      report.messages.push(`${after.backup.file} was left in place; delete it when you no longer need it.`);
    }
    const warning = configuredLayoutWarning(options, "single");
    if (warning) report.messages.push(warning);
    report.after = after;
    report.ok = true;
    return report;
  } finally {
    await lease.release();
  }
}

export function migrateGraph(vaultPath: string, action: MigrateAction, options: MigrateOptions): Promise<MigrateReport> {
  switch (action) {
    case "apply":
      return applyMigration(vaultPath, options);
    case "verify":
      return verifyGraph(vaultPath, options);
    case "rollback":
      return rollbackMigration(vaultPath, options);
    default:
      return planMigration(vaultPath, options);
  }
}
