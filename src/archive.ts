/**
 * OIL — Vault archival
 *
 * Moves notes the vault has finished with out of the way, without losing them.
 *
 * Everything is driven by the `archive:` block of `oil.config.yaml`: rules pick
 * candidates, protections veto them, and a run either moves each note beneath
 * the archive root (keeping its original path, so `Customers/Contoso/x.md`
 * becomes `Archive/Customers/Contoso/x.md`) or flags it `archived: true` where
 * it stands. Either way the note stays on disk, in the graph, and one search
 * scope away — it simply stops competing with live notes for search results and
 * stops costing embedding time.
 *
 * Safety properties, all deliberate:
 * - Planning is a pure read. Nothing is written until `applyArchive` runs.
 * - A run is capped (`max_per_run`), so a bad rule cannot sweep the vault.
 * - Existing files are never overwritten: a target that already exists skips.
 * - Path-qualified wikilinks to a moved note are rewritten; basename links keep
 *   resolving on their own, because the graph resolves by filename.
 * - Every run is recorded in a manifest and the audit log, and is reversible —
 *   by note or by whole run.
 */

import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import type { ArchiveRule, OilConfig } from "./types.js";
import { appendToSection, logWrite } from "./gate.js";
import { detectLineEnding, noteExists, normalizeLineEndings, resolveCustomerPath, securePath } from "./vault.js";
import { invalidateSearchIndex } from "./search.js";
import {
  ARCHIVED_FLAG,
  isArchivedNote,
  isFlaggedArchived,
  isUnderArchiveRoot,
  normalizeFolder,
  setArchivePolicy,
  type ArchiveSearchScope,
} from "./archive-policy.js";

const SEARCH_MODE_SCOPE: Record<OilConfig["archive"]["index"]["search"], ArchiveSearchScope> = {
  fallback: "fallback",
  never: "active",
  always: "all",
};

/** Make the vault's archive settings the ones every index partitions on. */
export function applyArchivePolicy(config: OilConfig): void {
  setArchivePolicy({
    enabled: config.archive.enabled,
    root: config.archive.root,
    defaultScope: SEARCH_MODE_SCOPE[config.archive.index.search],
    embedArchived: config.archive.index.embedArchived,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MANIFEST_VERSION = 1;
const MANIFEST_RUN_LIMIT = 50;
const BREADCRUMB_HEADING = "Archived Notes";
const BREADCRUMB_LINK_LIMIT = 20;

/** Frontmatter written by an archive pass, removed again on restore. */
const ARCHIVE_FIELDS = ["archived", "archived_at", "archived_from", "archive_reason"] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArchiveCandidate {
  path: string;
  /** Where the note will live after the run (equal to `path` in flag mode). */
  target: string;
  rule: string;
  reason: string;
  ageDays: number | null;
}

export interface ArchivePlan {
  enabled: boolean;
  mode: "move" | "flag";
  root: string;
  candidates: ArchiveCandidate[];
  /** Notes a rule selected but a protection kept. */
  protected: { path: string; reason: string }[];
  /** Candidates beyond `max_per_run`, left for the next run. */
  deferred: number;
}

export interface ArchiveEntry {
  from: string;
  to: string;
  rule: string;
}

export interface ArchiveRunResult {
  runId: string | null;
  mode: "move" | "flag";
  archived: ArchiveEntry[];
  skipped: { path: string; reason: string }[];
  linksRewritten: number;
  breadcrumbs: string[];
  deferred: number;
}

export interface RestoreResult {
  runId: string | null;
  restored: ArchiveEntry[];
  skipped: { path: string; reason: string }[];
  linksRewritten: number;
}

interface ManifestRun {
  id: string;
  at: string;
  action: "archive" | "restore";
  mode: "move" | "flag";
  entries: ArchiveEntry[];
}

interface Manifest {
  version: number;
  lastRunAt: string | null;
  runs: ManifestRun[];
}

export interface ArchiveOptions {
  cache?: SessionCache;
  now?: Date;
  /** A plan computed earlier (e.g. the one a caller just reviewed). */
  plan?: ArchivePlan;
}

// ─── Planning ─────────────────────────────────────────────────────────────────

/**
 * Work out what a run would archive, without touching the vault.
 *
 * Rules are evaluated in order and the first match wins, so the reason a note
 * is archived is always a single, nameable rule.
 */
export async function planArchive(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  now: Date = new Date(),
): Promise<ArchivePlan> {
  const archive = config.archive;
  const root = normalizeFolder(archive.root) || "Archive/";
  const plan: ArchivePlan = {
    enabled: archive.enabled,
    mode: archive.mode,
    root,
    candidates: [],
    protected: [],
    deferred: 0,
  };
  if (archive.rules.length === 0) return plan;

  const systemFolders = [
    root,
    config.schema.agentLog,
    config.schema.templatesRoot,
  ].map(normalizeFolder).filter(Boolean);
  const protectedFolders = archive.protect.folders.map(normalizeFolder).filter(Boolean);
  const mtimes = new Map<string, number | null>();
  const mtimeOf = async (path: string): Promise<number | null> => {
    if (!mtimes.has(path)) mtimes.set(path, await fileMtime(vaultPath, path));
    return mtimes.get(path) ?? null;
  };

  const matches: ArchiveCandidate[] = [];
  for (const ref of graph.getNotesByFolder("")) {
    const node = graph.getNode(ref.path);
    if (!node) continue;
    const path = node.path;
    const fm = (node.frontmatter ?? {}) as Record<string, unknown>;

    // Already archived, by either mechanism — whatever the configured mode.
    if (isUnderArchiveRoot(path, root) || isFlaggedArchived(fm)) continue;
    if (systemFolders.some((folder) => path.startsWith(folder))) continue;

    let matched: { rule: ArchiveRule; ageDays: number | null } | null = null;
    for (const rule of archive.rules) {
      const result = await ruleMatches(rule, path, node.tags, fm, config, now, mtimeOf);
      if (result.matched) {
        matched = { rule, ageDays: result.ageDays };
        break;
      }
    }
    if (!matched) continue;

    const veto = await protection(path, node.tags, fm, node.inLinks, {
      config,
      protectedFolders,
      now,
      mtimeOf,
    });
    if (veto) {
      plan.protected.push({ path, reason: veto });
      continue;
    }

    matches.push({
      path,
      target: archive.mode === "move" ? `${root}${path}` : path,
      rule: matched.rule.name,
      reason: describeRule(matched.rule, matched.ageDays),
      ageDays: matched.ageDays,
    });
  }

  // Oldest first, so a capped run makes progress on the stalest notes.
  matches.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.path.localeCompare(b.path));
  const cap = Math.max(0, Math.floor(archive.maxPerRun));
  plan.candidates = matches.slice(0, cap);
  plan.deferred = Math.max(0, matches.length - plan.candidates.length);
  return plan;
}

async function ruleMatches(
  rule: ArchiveRule,
  path: string,
  tags: string[],
  fm: Record<string, unknown>,
  config: OilConfig,
  now: Date,
  mtimeOf: (path: string) => Promise<number | null>,
): Promise<{ matched: boolean; ageDays: number | null }> {
  const no = { matched: false, ageDays: null };
  if (rule.folder && !path.startsWith(normalizeFolder(rule.folder))) return no;
  if (rule.tags && !hasAnyTag(tags, rule.tags)) return no;
  if (rule.frontmatter && !frontmatterMatchesAll(fm, rule.frontmatter)) return no;

  let ageDays: number | null = null;
  const dateField = rule.dateField ?? config.frontmatterSchema.dateField;
  const dated = parseDate(fm[dateField]);
  const when = dated ?? (await mtimeOf(path));
  if (when !== null) ageDays = Math.floor((now.getTime() - when) / DAY_MS);

  if (rule.olderThanDays !== undefined) {
    if (ageDays === null || ageDays < rule.olderThanDays) return no;
  }
  return { matched: true, ageDays };
}

async function protection(
  path: string,
  tags: string[],
  fm: Record<string, unknown>,
  inLinks: Set<string>,
  ctx: {
    config: OilConfig;
    protectedFolders: string[];
    now: Date;
    mtimeOf: (path: string) => Promise<number | null>;
  },
): Promise<string | null> {
  const { config, now } = ctx;
  const protect = config.archive.protect;

  if (isCustomerHub(path, config)) return "customer hub note";

  const folder = ctx.protectedFolders.find((prefix) => path.startsWith(prefix));
  if (folder) return `protected folder ${folder}`;

  const tag = protect.tags.find((t) => hasAnyTag(tags, [t]));
  if (tag) return `tagged #${tag}`;

  for (const [key, expected] of Object.entries(protect.frontmatter)) {
    if (valueMatches(fm[key], expected)) return `frontmatter ${key}: ${String(fm[key])}`;
  }

  if (protect.restoredGraceDays > 0) {
    const restored = parseDate(fm.archive_restored_at);
    if (restored !== null && now.getTime() - restored < protect.restoredGraceDays * DAY_MS) {
      return `restored within ${protect.restoredGraceDays} days`;
    }
  }

  if (protect.recentBacklinkDays > 0) {
    const horizon = now.getTime() - protect.recentBacklinkDays * DAY_MS;
    for (const source of inLinks) {
      const mtime = await ctx.mtimeOf(source);
      if (mtime !== null && mtime >= horizon) return `linked from recently edited ${source}`;
    }
  }
  return null;
}

/** `Customers/X/X.md` or `Customers/X.md` — the hub a customer's notes hang off. */
function isCustomerHub(path: string, config: OilConfig): boolean {
  const root = config.schema.customersRoot;
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length).replace(/\.md$/i, "").split("/");
  return rest.length === 1 || (rest.length === 2 && rest[0] === rest[1]);
}

function describeRule(rule: ArchiveRule, ageDays: number | null): string {
  const parts: string[] = [];
  if (rule.folder) parts.push(`in ${rule.folder}`);
  if (rule.olderThanDays !== undefined) parts.push(`${ageDays ?? "?"}d old (> ${rule.olderThanDays}d)`);
  if (rule.frontmatter) {
    parts.push(
      Object.entries(rule.frontmatter)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
        .join(", "),
    );
  }
  if (rule.tags) parts.push(rule.tags.map((t) => `#${t}`).join("|"));
  return `${rule.name}: ${parts.join("; ")}`;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/** Archive everything the plan selects, and record the run. */
export async function applyArchive(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  options: ArchiveOptions = {},
): Promise<ArchiveRunResult> {
  const now = options.now ?? new Date();
  if (!config.archive.enabled) {
    // Archived notes are only kept out of the active index while the feature is
    // on; moving them with it off would just scatter live notes into a folder.
    throw new Error("Archiving is disabled — set `archive.enabled: true` in oil.config.yaml.");
  }
  const plan = options.plan ?? (await planArchive(vaultPath, graph, config, now));
  const mode = config.archive.mode;
  const result: ArchiveRunResult = {
    runId: null,
    mode,
    archived: [],
    skipped: [],
    linksRewritten: 0,
    breadcrumbs: [],
    deferred: plan.deferred,
  };
  if (plan.candidates.length === 0) return result;

  const stamp = now.toISOString().slice(0, 10);
  const linkers = new Set<string>();
  const moves = new Map<string, string>();

  for (const candidate of plan.candidates) {
    const { path, target, rule, reason } = candidate;
    try {
      if (mode === "move" && (await noteExists(vaultPath, target))) {
        result.skipped.push({ path, reason: `target ${target} already exists` });
        continue;
      }
      const fields: Record<string, string | boolean | null> = {
        archived_at: stamp,
        archived_from: path,
        archive_reason: reason,
      };
      if (mode === "flag") fields[ARCHIVED_FLAG] = true;
      await editFrontmatter(vaultPath, path, fields);

      if (mode === "move") {
        const to = securePath(vaultPath, target);
        try {
          await mkdir(dirname(to), { recursive: true });
          await rename(securePath(vaultPath, path), to);
        } catch (err) {
          // Leave the note as it was found rather than half-archived in place.
          await editFrontmatter(vaultPath, path, {
            archived_at: null,
            archived_from: null,
            archive_reason: null,
          }).catch(() => {});
          throw err;
        }
        await pruneEmptyFolders(vaultPath, path);
        moves.set(path, target);
      }
      for (const source of graph.getNode(path)?.inLinks ?? []) linkers.add(source);
      result.archived.push({ from: path, to: target, rule });
    } catch (err) {
      result.skipped.push({ path, reason: errorMessage(err) });
    }
  }
  if (result.archived.length === 0) return result;

  result.linksRewritten = await rewriteLinks(vaultPath, moves, linkers);

  // The graph must see the moves before breadcrumbs resolve customer hubs.
  await syncGraph(graph, options.cache, vaultPath, {
    removed: [...moves.keys()],
    updated: [...result.archived.map((e) => e.to), ...remap(linkers, moves)],
  });

  if (config.archive.index.breadcrumbs) {
    result.breadcrumbs = await writeBreadcrumbs(vaultPath, config, result.archived, stamp);
    await syncGraph(graph, options.cache, vaultPath, { removed: [], updated: result.breadcrumbs });
  }

  result.runId = await recordRun(vaultPath, config, {
    action: "archive",
    mode,
    entries: result.archived,
    at: now,
  });
  await logWrite(vaultPath, config, {
    operation: "archive",
    path: config.archive.manifestFile,
    detail: `run ${result.runId}: ${result.archived.length} note(s) ${mode === "move" ? `moved to ${plan.root}` : "flagged archived"}; ${result.linksRewritten} link(s) rewritten${result.skipped.length ? `; ${result.skipped.length} skipped` : ""}${result.deferred ? `; ${result.deferred} deferred to the next run` : ""}`,
  }).catch(() => {});
  return result;
}

// ─── Restore ──────────────────────────────────────────────────────────────────

/**
 * Bring archived notes back — one note by path, or every note from one run.
 *
 * Accepts the archived path or the note's original path, so a caller never has
 * to know which mode archived it.
 */
export async function restoreArchived(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  target: { path?: string; runId?: string },
  options: ArchiveOptions = {},
): Promise<RestoreResult> {
  const now = options.now ?? new Date();
  const root = normalizeFolder(config.archive.root) || "Archive/";
  const result: RestoreResult = { runId: null, restored: [], skipped: [], linksRewritten: 0 };

  let paths: string[];
  if (target.runId) {
    const manifest = await readManifest(vaultPath, config);
    const run = manifest.runs.find((r) => r.id === target.runId && r.action === "archive");
    if (!run) throw new Error(`No archive run '${target.runId}' in ${config.archive.manifestFile}.`);
    paths = run.entries.map((e) => e.to);
  } else if (target.path) {
    paths = [await locateArchived(vaultPath, graph, root, target.path)];
  } else {
    throw new Error("restore needs a note path or a run id.");
  }

  const stamp = now.toISOString().slice(0, 10);
  const moves = new Map<string, string>();
  const linkers = new Set<string>();

  for (const path of paths) {
    try {
      if (!(await noteExists(vaultPath, path))) {
        result.skipped.push({ path, reason: "no longer exists" });
        continue;
      }
      const node = graph.getNode(path);
      const fm = (node?.frontmatter ?? {}) as Record<string, unknown>;
      const underRoot = isUnderArchiveRoot(path, root);
      if (!underRoot && !isFlaggedArchived(fm)) {
        result.skipped.push({ path, reason: "not archived" });
        continue;
      }

      let destination = path;
      if (underRoot) {
        const from = typeof fm.archived_from === "string" ? fm.archived_from : "";
        destination = from && !isUnderArchiveRoot(from, root) ? from : path.slice(root.length);
        if (await noteExists(vaultPath, destination)) {
          result.skipped.push({ path, reason: `${destination} already exists` });
          continue;
        }
      }

      const clear: Record<string, string | boolean | null> = { archive_restored_at: stamp };
      for (const key of ARCHIVE_FIELDS) clear[key] = null;
      await editFrontmatter(vaultPath, path, clear);

      if (destination !== path) {
        const to = securePath(vaultPath, destination);
        await mkdir(dirname(to), { recursive: true });
        await rename(securePath(vaultPath, path), to);
        await pruneEmptyFolders(vaultPath, path);
        moves.set(path, destination);
      }
      for (const source of node?.inLinks ?? []) linkers.add(source);
      result.restored.push({ from: path, to: destination, rule: "restore" });
    } catch (err) {
      result.skipped.push({ path, reason: errorMessage(err) });
    }
  }
  if (result.restored.length === 0) return result;

  result.linksRewritten = await rewriteLinks(vaultPath, moves, linkers);
  await syncGraph(graph, options.cache, vaultPath, {
    removed: [...moves.keys()],
    updated: [...result.restored.map((e) => e.to), ...remap(linkers, moves)],
  });

  result.runId = await recordRun(vaultPath, config, {
    action: "restore",
    mode: config.archive.mode,
    entries: result.restored,
    at: now,
  });
  await logWrite(vaultPath, config, {
    operation: "archive_restore",
    path: config.archive.manifestFile,
    detail: `run ${result.runId}: ${result.restored.length} note(s) restored${target.runId ? ` from run ${target.runId}` : ""}; ${result.linksRewritten} link(s) rewritten`,
  }).catch(() => {});
  return result;
}

/**
 * Remove folders a move left empty, walking up from the note's old location.
 * `rmdir` refuses a non-empty folder, so this can only ever remove nothing.
 */
async function pruneEmptyFolders(vaultPath: string, movedFrom: string): Promise<void> {
  const parts = movedFrom.split("/").slice(0, -1);
  while (parts.length > 0) {
    try {
      await rmdir(securePath(vaultPath, parts.join("/")));
    } catch {
      return;
    }
    parts.pop();
  }
}

async function locateArchived(
  vaultPath: string,
  graph: GraphIndex,
  root: string,
  input: string,
): Promise<string> {
  const path = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const withExt = /\.md$/i.test(path) ? path : `${path}.md`;
  for (const candidate of [withExt, `${root}${withExt}`]) {
    if (await noteExists(vaultPath, candidate)) {
      const fm = graph.getNode(candidate)?.frontmatter as Record<string, unknown> | undefined;
      if (isUnderArchiveRoot(candidate, root) || isFlaggedArchived(fm)) return candidate;
    }
  }
  throw new Error(`No archived note at '${input}' (looked in place and under ${root}).`);
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface ArchiveStatus {
  enabled: boolean;
  mode: "move" | "flag";
  root: string;
  run: string;
  search: string;
  rules: number;
  archived_count: number;
  last_run: { id: string; at: string; action: string; notes: number } | null;
}

export async function archiveStatus(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
): Promise<ArchiveStatus> {
  const archive = config.archive;
  let archived = 0;
  if (archive.enabled) {
    for (const ref of graph.getNotesByFolder("")) {
      if (isArchivedNote(ref.path, graph.getNode(ref.path)?.frontmatter)) archived++;
    }
  }
  const manifest = await readManifest(vaultPath, config);
  const last = manifest.runs.at(-1);
  return {
    enabled: archive.enabled,
    mode: archive.mode,
    root: normalizeFolder(archive.root) || "Archive/",
    run: archive.run,
    search: archive.index.search,
    rules: archive.rules.length,
    archived_count: archived,
    last_run: last
      ? { id: last.id, at: last.at, action: last.action, notes: last.entries.length }
      : null,
  };
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

const SCHEDULE_CHECK_MS = 60 * 60 * 1000;

/**
 * Run archival on the configured cadence. Returns a stop function.
 *
 * `daily` is checked hourly against the manifest's last run rather than set as
 * a 24h timer, so a server that restarts every few hours still archives once a
 * day instead of never.
 */
export function startArchiveScheduler(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache?: SessionCache,
  onRun: (result: ArchiveRunResult) => void = () => {},
): () => void {
  const archive = config.archive;
  if (!archive.enabled || archive.run === "manual" || archive.rules.length === 0) {
    return () => {};
  }

  let running = false;
  const runOnce = async (reason: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await applyArchive(vaultPath, graph, config, { cache });
      if (result.archived.length > 0 || result.skipped.length > 0) {
        console.error(
          `[OIL] Archive (${reason}): ${result.archived.length} archived, ${result.skipped.length} skipped${result.deferred ? `, ${result.deferred} deferred` : ""}.`,
        );
      }
      if (result.archived.length > 0) onRun(result);
      // A run that archived nothing still counts as a run for `daily`.
      if (result.runId === null) await touchManifest(vaultPath, config, new Date());
    } catch (err) {
      console.error(`[OIL] Archive (${reason}) failed:`, err);
    } finally {
      running = false;
    }
  };

  if (archive.run === "on_start") {
    void runOnce("on start");
    return () => {};
  }

  const runIfDue = async (): Promise<void> => {
    const manifest = await readManifest(vaultPath, config);
    const last = manifest.lastRunAt ? Date.parse(manifest.lastRunAt) : NaN;
    if (!Number.isFinite(last) || Date.now() - last >= DAY_MS) await runOnce("daily");
  };
  void runIfDue();
  const timer = setInterval(() => void runIfDue(), SCHEDULE_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

async function readManifest(vaultPath: string, config: OilConfig): Promise<Manifest> {
  try {
    const raw = await readFile(securePath(vaultPath, config.archive.manifestFile), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    return {
      version: MANIFEST_VERSION,
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { version: MANIFEST_VERSION, lastRunAt: null, runs: [] };
  }
}

async function writeManifest(vaultPath: string, config: OilConfig, manifest: Manifest): Promise<void> {
  const full = securePath(vaultPath, config.archive.manifestFile);
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  await rename(tmp, full);
}

async function recordRun(
  vaultPath: string,
  config: OilConfig,
  run: { action: "archive" | "restore"; mode: "move" | "flag"; entries: ArchiveEntry[]; at: Date },
): Promise<string> {
  const manifest = await readManifest(vaultPath, config);
  const iso = run.at.toISOString();
  const id = `${iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex")}`;
  manifest.runs.push({ id, at: iso, action: run.action, mode: run.mode, entries: run.entries });
  manifest.runs = manifest.runs.slice(-MANIFEST_RUN_LIMIT);
  if (run.action === "archive") manifest.lastRunAt = iso;
  await writeManifest(vaultPath, config, manifest);
  return id;
}

async function touchManifest(vaultPath: string, config: OilConfig, at: Date): Promise<void> {
  const manifest = await readManifest(vaultPath, config);
  manifest.lastRunAt = at.toISOString();
  await writeManifest(vaultPath, config, manifest);
}

// ─── Links ────────────────────────────────────────────────────────────────────

/**
 * Point path-qualified links at a note's new location.
 *
 * Only links that spell out the old path need help — `[[Customers/X/meeting]]`
 * would dangle after a move, while `[[meeting]]` keeps resolving by filename.
 * Markdown links (`[text](Customers/X/meeting.md)`) are handled the same way.
 */
async function rewriteLinks(
  vaultPath: string,
  moves: Map<string, string>,
  sources: Set<string>,
): Promise<number> {
  if (moves.size === 0) return 0;
  const patterns = [...moves].map(([from, to]) => linkPatterns(from, to)).flat();
  let rewritten = 0;

  for (const original of sources) {
    const path = moves.get(original) ?? original;
    let full: string;
    try {
      full = securePath(vaultPath, path);
    } catch {
      continue;
    }
    let text: string;
    try {
      text = await readFile(full, "utf-8");
    } catch {
      continue;
    }
    let next = text;
    let count = 0;
    for (const { pattern, replace } of patterns) {
      next = next.replace(pattern, (...args) => {
        count++;
        return replace(...(args as [string, ...string[]]));
      });
    }
    if (count > 0) {
      await writeFile(full, next, "utf-8");
      rewritten += count;
    }
  }
  return rewritten;
}

function linkPatterns(
  from: string,
  to: string,
): { pattern: RegExp; replace: (...args: string[]) => string }[] {
  const fromBase = from.replace(/\.md$/i, "");
  const toBase = to.replace(/\.md$/i, "");
  const wiki = new RegExp(`(!?\\[\\[)${escapeRegExp(fromBase)}(\\.md)?(?=[|#\\]])`, "gi");
  const encodedFrom = encodeURI(from);
  const md = new RegExp(
    `(\\]\\()(?:${escapeRegExp(from)}|${escapeRegExp(encodedFrom)})(?=[)#])`,
    "gi",
  );
  return [
    { pattern: wiki, replace: (_m, open, ext) => `${open}${toBase}${ext ?? ""}` },
    {
      pattern: md,
      replace: (_m, open) => `${open}${from === encodedFrom ? to : encodeURI(to)}`,
    },
  ];
}

function remap(paths: Set<string>, moves: Map<string, string>): string[] {
  return [...paths].map((p) => moves.get(p) ?? p);
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

/**
 * Leave a trail on each affected customer's hub note.
 *
 * Archived notes leave a customer's working set, but whoever opens the hub
 * should still see that history exists and be one click from it.
 */
async function writeBreadcrumbs(
  vaultPath: string,
  config: OilConfig,
  entries: ArchiveEntry[],
  stamp: string,
): Promise<string[]> {
  const root = config.schema.customersRoot;
  const byCustomer = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    if (!entry.from.startsWith(root)) continue;
    const customer = entry.from.slice(root.length).split("/")[0];
    if (!customer || customer.endsWith(".md")) continue;
    const list = byCustomer.get(customer) ?? [];
    list.push(entry);
    byCustomer.set(customer, list);
  }

  const written: string[] = [];
  for (const [customer, list] of byCustomer) {
    const hub = await resolveCustomerPath(vaultPath, config, customer);
    if (!(await noteExists(vaultPath, hub))) continue;
    const links = list.slice(0, BREADCRUMB_LINK_LIMIT).map((e) => {
      const target = e.to.replace(/\.md$/i, "");
      const label = target.split("/").at(-1) ?? target;
      return `[[${target}|${label}]]`;
    });
    const more = list.length > BREADCRUMB_LINK_LIMIT ? ` and ${list.length - BREADCRUMB_LINK_LIMIT} more` : "";
    const line = `- ${stamp} — archived ${list.length} note${list.length === 1 ? "" : "s"}: ${links.join(", ")}${more}`;
    try {
      await appendToSection(vaultPath, hub, BREADCRUMB_HEADING, line);
      written.push(hub);
    } catch {
      // A breadcrumb is a courtesy; failing to leave one never fails the run.
    }
  }
  return written;
}

// ─── Frontmatter editing ──────────────────────────────────────────────────────

/**
 * Set or remove top-level frontmatter fields by editing text, not by
 * re-serialising: a round trip through a YAML library would reorder keys,
 * restyle lists and drop comments in a note the user owns.
 */
async function editFrontmatter(
  vaultPath: string,
  path: string,
  fields: Record<string, string | boolean | null>,
): Promise<void> {
  const full = securePath(vaultPath, path);
  const original = await readFile(full, "utf-8");
  const next = setFrontmatterFields(original, fields);
  if (next !== original) await writeFile(full, next, "utf-8");
}

export function setFrontmatterFields(
  original: string,
  fields: Record<string, string | boolean | null>,
): string {
  const eol = detectLineEnding(original);
  const raw = normalizeLineEndings(original);
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;

  let lines: string[];
  let body: string;
  const block = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(text);
  if (block) {
    lines = block[1] ? block[1].split("\n") : [];
    body = text.slice(block[0].length);
  } else {
    lines = [];
    body = text;
  }

  for (const [key, value] of Object.entries(fields)) {
    const at = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line));
    // A key's value may continue on indented lines (a block list, say).
    let end = at + 1;
    if (at >= 0) while (end < lines.length && /^[ \t]+\S|^[ \t]*-\s/.test(lines[end])) end++;

    if (value === null) {
      if (at >= 0) lines.splice(at, end - at);
      continue;
    }
    const rendered = `${key}: ${typeof value === "boolean" ? String(value) : JSON.stringify(value)}`;
    if (at >= 0) lines.splice(at, end - at, rendered);
    else lines.push(rendered);
  }

  const result =
    lines.length === 0 && !block
      ? text
      : `---\n${lines.join("\n")}${lines.length ? "\n" : ""}---\n${block ? body : body ? `\n${body}` : ""}`;
  const out = bom + result;
  return eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out;
}

// ─── Graph sync ───────────────────────────────────────────────────────────────

async function syncGraph(
  graph: GraphIndex,
  cache: SessionCache | undefined,
  vaultPath: string,
  change: { removed: string[]; updated: string[] },
): Promise<void> {
  const updated = [...new Set(change.updated)];
  for (const path of [...change.removed, ...updated]) cache?.invalidateNote(path);
  if (change.removed.length) graph.removeNotes(change.removed);
  try {
    await graph.updateNotes(updated);
  } catch {
    // The watcher converges the graph anyway; a failed re-index never fails a run.
  }
  if (cache) {
    for (const path of updated) {
      const mtime = await fileMtime(vaultPath, path);
      if (mtime !== null) cache.markSelfWrite(path, mtime);
    }
  }
  invalidateSearchIndex();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fileMtime(vaultPath: string, path: string): Promise<number | null> {
  try {
    return (await stat(securePath(vaultPath, path))).mtimeMs;
  } catch {
    return null;
  }
}

function parseDate(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const normTag = (tag: string) => tag.replace(/^#/, "").toLowerCase();

function hasAnyTag(tags: string[], wanted: string[]): boolean {
  const have = new Set(tags.map(normTag));
  return wanted.some((t) => have.has(normTag(t)));
}

function frontmatterMatchesAll(fm: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => valueMatches(fm[key], value));
}

/**
 * Loose, YAML-shaped equality: case-insensitive strings, a list in the config
 * means "any of", and a list in the note matches if any element does.
 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((e) => valueMatches(actual, e));
  if (Array.isArray(actual)) return actual.some((a) => valueMatches(a, expected));
  if (actual === undefined || actual === null) return expected === null;
  if (typeof expected === "boolean") return actual === expected || String(actual).toLowerCase() === String(expected);
  return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
