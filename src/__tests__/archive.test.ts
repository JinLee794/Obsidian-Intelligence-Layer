/**
 * Vault archival — config, planning, apply/restore round trips, and the
 * search partitioning that keeps archived notes out of the active index while
 * leaving them retrievable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GraphIndex } from "../graph.js";
import { loadConfig, parseArchiveConfig } from "../config.js";
import { cascadeSearch } from "../search.js";
import { setArchivePolicy } from "../archive-policy.js";
import {
  applyArchive,
  applyArchivePolicy,
  archiveStatus,
  planArchive,
  restoreArchived,
  setFrontmatterFields,
} from "../archive.js";
import { setupHarness } from "./harness.js";
import type { OilConfig } from "../types.js";

const NOW = new Date("2026-05-10T12:00:00Z");

const CONFIG = `schema:
  customers_root: "Customers/"
  meetings_root: "Meetings/"
  projects_root: "Projects/"
  agent_log: "_agent-log/"
audit:
  log_all_writes: true
archive:
  enabled: true
  mode: {{mode}}
  root: "Archive/"
  max_per_run: {{max}}
  protect:
    tags: [keep]
    frontmatter:
      pinned: true
  rules:
    - name: stale-meetings
      folder: "Meetings/"
      older_than_days: 365
    - name: closed-projects
      folder: "Projects/"
      frontmatter:
        status: [closed, done]
    - name: old-customer-notes
      folder: "Customers/"
      older_than_days: 365
`;

const NOTES: Record<string, string> = {
  "Meetings/2020-01-15 Zephyrine Sync.md":
    "---\ndate: 2020-01-15\ntags: [meeting]\n---\n# Zephyrine Sync\n\nZephyrine roadmap planning with the platform team.\n",
  "Meetings/2020-02-01 Pinned Review.md":
    "---\ndate: 2020-02-01\npinned: true\n---\n# Pinned Review\n\nZephyrine budget review.\n",
  "Meetings/2020-03-01 Kept Notes.md":
    "---\ndate: 2020-03-01\ntags: [keep]\n---\n# Kept Notes\n\nZephyrine retro notes.\n",
  "Meetings/2026-05-01 Recent Standup.md":
    "---\ndate: 2026-05-01\n---\n# Recent Standup\n\nZephyrine standup this week.\n",
  "Projects/Apollo.md": "---\nstatus: closed\n---\n# Apollo\n\nZephyrine apollo launch retrospective.\n",
  "Projects/Hermes.md":
    "---\nstatus: active\n---\n# Hermes\n\nZephyrine hermes delivery.\n\n" +
    "See [[Meetings/2020-01-15 Zephyrine Sync]] and [[Projects/Apollo|Apollo]].\n" +
    "Also [the sync](Meetings/2020-01-15%20Zephyrine%20Sync.md).\n",
  "Customers/Contoso/Contoso.md":
    "---\ntags: [customer]\ndate: 2019-01-01\n---\n# Contoso\n\nHub. [[Customers/Contoso/2020-04-01 Contoso Review]]\n",
  "Customers/Contoso/2020-04-01 Contoso Review.md":
    "---\ndate: 2020-04-01\n---\n# Contoso Review\n\nZephyrine account review for Contoso.\n",
};

let vault: string;

async function buildVault(mode: "move" | "flag" = "move", max = 200): Promise<void> {
  vault = await mkdtemp(join(tmpdir(), "oil-archive-"));
  await writeFile(join(vault, "oil.config.yaml"), CONFIG.replace("{{mode}}", mode).replace("{{max}}", String(max)));
  for (const [path, body] of Object.entries(NOTES)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), body);
  }
}

async function open(): Promise<{ graph: GraphIndex; config: OilConfig }> {
  const config = await loadConfig(vault);
  applyArchivePolicy(config);
  const graph = new GraphIndex(vault);
  await graph.build();
  return { graph, config };
}

const read = (path: string) => readFile(join(vault, path), "utf-8");
const exists = (path: string) =>
  access(join(vault, path)).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  setArchivePolicy({ enabled: false, root: "Archive/" });
  if (vault) await rm(vault, { recursive: true, force: true });
  vault = "";
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("archive config", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("maps snake_case YAML onto the typed config", () => {
    const parsed = parseArchiveConfig({
      enabled: true,
      mode: "flag",
      root: "Cold",
      run: "daily",
      max_per_run: 5,
      protect: { tags: ["#keep"], recent_backlink_days: 14, restored_grace_days: 30 },
      rules: [{ name: "old", folder: "Meetings", older_than_days: 90, date_field: "meeting_date" }],
      index: { search: "never", breadcrumbs: false, embed_archived: true },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.mode).toBe("flag");
    expect(parsed.root).toBe("Cold/");
    expect(parsed.run).toBe("daily");
    expect(parsed.maxPerRun).toBe(5);
    expect(parsed.protect.tags).toEqual(["keep"]);
    expect(parsed.protect.recentBacklinkDays).toBe(14);
    expect(parsed.protect.restoredGraceDays).toBe(30);
    expect(parsed.rules[0]).toMatchObject({ name: "old", olderThanDays: 90, dateField: "meeting_date" });
    expect(parsed.index).toEqual({ search: "never", breadcrumbs: false, embedArchived: true });
  });

  it("is off by default and keeps safe defaults for bad values", () => {
    const parsed = parseArchiveConfig({ mode: "shred", max_per_run: -3, index: { search: "sometimes" } });
    expect(parsed.enabled).toBe(false);
    expect(parsed.mode).toBe("move");
    expect(parsed.maxPerRun).toBeGreaterThan(0);
    expect(parsed.index.search).toBe("fallback");
    expect(parsed.protect.tags).toContain("keep");
  });

  it("drops a rule that names no condition rather than archiving everything", () => {
    const parsed = parseArchiveConfig({ rules: [{ name: "everything" }, { name: "ok", tags: ["done"] }] });
    expect(parsed.rules.map((r) => r.name)).toEqual(["ok"]);
  });
});

// ── Frontmatter editing ──────────────────────────────────────────────────────

describe("setFrontmatterFields", () => {
  it("adds and replaces fields without disturbing the rest of the note", () => {
    const out = setFrontmatterFields("---\ntitle: X\n# a comment\ntags: [a]\n---\nBody\n", {
      title: "Y",
      archived: true,
    });
    expect(out).toBe('---\ntitle: "Y"\n# a comment\ntags: [a]\narchived: true\n---\nBody\n');
  });

  it("preserves CRLF line endings", () => {
    const out = setFrontmatterFields("---\r\ntitle: X\r\n---\r\nBody\r\n", { archived_at: "2026-05-10" });
    expect(out).toBe('---\r\ntitle: X\r\narchived_at: "2026-05-10"\r\n---\r\nBody\r\n');
  });

  it("creates frontmatter when the note has none", () => {
    expect(setFrontmatterFields("# Note\n", { archived: true })).toBe("---\narchived: true\n---\n\n# Note\n");
  });

  it("deletes a key together with its indented continuation lines", () => {
    const out = setFrontmatterFields("---\na: 1\nreason:\n  - x\n  - y\nb: 2\n---\n", { reason: null });
    expect(out).toBe("---\na: 1\nb: 2\n---\n");
  });
});

// ── Planning ─────────────────────────────────────────────────────────────────

describe("planArchive", () => {
  it("selects by rule and explains every protection", async () => {
    await buildVault();
    const { graph, config } = await open();
    const plan = await planArchive(vault, graph, config, NOW);

    expect(plan.candidates.map((c) => c.path).sort()).toEqual([
      "Customers/Contoso/2020-04-01 Contoso Review.md",
      "Meetings/2020-01-15 Zephyrine Sync.md",
      "Projects/Apollo.md",
    ]);
    const sync = plan.candidates.find((c) => c.path.startsWith("Meetings/"))!;
    expect(sync.target).toBe("Archive/Meetings/2020-01-15 Zephyrine Sync.md");
    expect(sync.rule).toBe("stale-meetings");

    const reasons = Object.fromEntries(plan.protected.map((p) => [p.path, p.reason]));
    expect(reasons["Meetings/2020-02-01 Pinned Review.md"]).toMatch(/pinned/);
    expect(reasons["Meetings/2020-03-01 Kept Notes.md"]).toMatch(/#keep/);
    expect(reasons["Customers/Contoso/Contoso.md"]).toMatch(/customer hub/);
    expect(Object.keys(reasons)).not.toContain("Meetings/2026-05-01 Recent Standup.md");
  });

  it("caps a run at max_per_run, oldest first, and reports the rest as deferred", async () => {
    await buildVault("move", 1);
    const { graph, config } = await open();
    const plan = await planArchive(vault, graph, config, NOW);
    expect(plan.candidates.map((c) => c.path)).toEqual(["Meetings/2020-01-15 Zephyrine Sync.md"]);
    expect(plan.deferred).toBe(2);
  });

  it("refuses to apply while archiving is disabled", async () => {
    await buildVault();
    const { graph, config } = await open();
    config.archive.enabled = false;
    await expect(applyArchive(vault, graph, config, { now: NOW })).rejects.toThrow(/disabled/);
  });
});

// ── Move mode ────────────────────────────────────────────────────────────────

describe("archive — move mode", () => {
  it("moves notes, rewrites links, leaves breadcrumbs, and restores cleanly", async () => {
    await buildVault();
    const { graph, config } = await open();
    const run = await applyArchive(vault, graph, config, { now: NOW });

    expect(run.archived).toHaveLength(3);
    expect(run.runId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(await exists("Meetings/2020-01-15 Zephyrine Sync.md")).toBe(false);
    expect(await exists("Customers/Contoso")).toBe(true);
    const moved = await read("Archive/Meetings/2020-01-15 Zephyrine Sync.md");
    expect(moved).toContain('archived_at: "2026-05-10"');
    expect(moved).toContain('archived_from: "Meetings/2020-01-15 Zephyrine Sync.md"');
    expect(moved).not.toContain("archived: true");

    const hermes = await read("Projects/Hermes.md");
    expect(hermes).toContain("[[Archive/Meetings/2020-01-15 Zephyrine Sync]]");
    expect(hermes).toContain("[[Archive/Projects/Apollo|Apollo]]");
    expect(hermes).toContain("(Archive/Meetings/2020-01-15%20Zephyrine%20Sync.md)");
    expect(run.linksRewritten).toBeGreaterThanOrEqual(3);

    const hub = await read("Customers/Contoso/Contoso.md");
    expect(hub).toContain("## Archived Notes");
    expect(hub).toContain("[[Archive/Customers/Contoso/2020-04-01 Contoso Review|2020-04-01 Contoso Review]]");
    expect(run.breadcrumbs).toEqual(["Customers/Contoso/Contoso.md"]);

    const manifest = JSON.parse(await read(".oil-archive.json"));
    expect(manifest.runs[0]).toMatchObject({ id: run.runId, action: "archive", mode: "move" });
    // The audit log is dated by the wall clock, not the injected run time.
    expect(await read(`_agent-log/${new Date().toISOString().slice(0, 10)}.md`)).toContain(run.runId!);

    expect(graph.getNode("Archive/Projects/Apollo.md")).toBeDefined();
    expect(graph.getNode("Projects/Apollo.md")).toBeUndefined();
    const status = await archiveStatus(vault, graph, config);
    expect(status.archived_count).toBe(3);
    expect(status.last_run?.id).toBe(run.runId);

    const restored = await restoreArchived(vault, graph, config, { runId: run.runId! }, { now: NOW });
    expect(restored.restored).toHaveLength(3);
    const back = await read("Meetings/2020-01-15 Zephyrine Sync.md");
    expect(back).not.toMatch(/archived_(at|from)|archive_reason/);
    expect(back).toContain('archive_restored_at: "2026-05-10"');
    expect(await exists("Archive/Meetings/2020-01-15 Zephyrine Sync.md")).toBe(false);
    // Restoring everything leaves no empty folder skeleton behind in the archive.
    expect(await exists("Archive")).toBe(false);
    expect(await read("Projects/Hermes.md")).toBe(NOTES["Projects/Hermes.md"]);

    // A freshly restored note is not swept straight back up.
    const replan = await planArchive(vault, graph, config, NOW);
    expect(replan.candidates).toHaveLength(0);
    expect(replan.protected.filter((p) => /restored within/.test(p.reason))).toHaveLength(3);
  });

  it("restores a single note by its original path", async () => {
    await buildVault();
    const { graph, config } = await open();
    await applyArchive(vault, graph, config, { now: NOW });
    const result = await restoreArchived(vault, graph, config, { path: "Projects/Apollo" }, { now: NOW });
    expect(result.restored).toEqual([{ from: "Archive/Projects/Apollo.md", to: "Projects/Apollo.md", rule: "restore" }]);
    expect(await exists("Projects/Apollo.md")).toBe(true);
    await expect(
      restoreArchived(vault, graph, config, { path: "Projects/Hermes.md" }, { now: NOW }),
    ).rejects.toThrow(/No archived note/);
  });

  it("skips a note whose archive target already exists", async () => {
    await buildVault();
    await mkdir(join(vault, "Archive/Projects"), { recursive: true });
    await writeFile(join(vault, "Archive/Projects/Apollo.md"), "# older copy\n");
    const { graph, config } = await open();
    const run = await applyArchive(vault, graph, config, { now: NOW });
    expect(run.skipped).toEqual([{ path: "Projects/Apollo.md", reason: expect.stringMatching(/already exists/) }]);
    expect(await read("Projects/Apollo.md")).toBe(NOTES["Projects/Apollo.md"]);
  });
});

// ── Search partitioning ──────────────────────────────────────────────────────

describe("archive — search scope", () => {
  const paths = (r: { results: { path: string }[] }) => r.results.map((h) => h.path);

  for (const mode of ["move", "flag"] as const) {
    describe(`${mode} mode`, () => {
      let graph: GraphIndex;
      let archived: string[];

      beforeEach(async () => {
        await buildVault(mode);
        const opened = await open();
        graph = opened.graph;
        const run = await applyArchive(vault, graph, opened.config, { now: NOW });
        archived = run.archived.map((e) => e.to);
        expect(archived).toHaveLength(3);
      });

      it("keeps archived notes out of an active search", async () => {
        const r = await cascadeSearch(graph, "zephyrine", 20, { scope: "active" });
        expect(r.scope).toBe("active");
        for (const a of archived) expect(paths(r)).not.toContain(a);
        expect(paths(r)).toContain("Projects/Hermes.md");
      });

      it("searches only the archive when asked", async () => {
        const r = await cascadeSearch(graph, "zephyrine", 20, { scope: "archive" });
        expect(paths(r).sort()).toEqual([...archived].sort());
        expect(r.results.every((h) => h.archived === true)).toBe(true);
      });

      it("ranks both partitions together for scope all", async () => {
        const r = await cascadeSearch(graph, "zephyrine", 20, { scope: "all" });
        for (const a of archived) expect(paths(r)).toContain(a);
        expect(paths(r)).toContain("Projects/Hermes.md");
        expect(r.results.filter((h) => h.archived).map((h) => h.path).sort()).toEqual([...archived].sort());
      });

      it("falls back to the archive only to fill an unfilled page", async () => {
        const r = await cascadeSearch(graph, "apollo launch retrospective", 5, undefined);
        expect(r.scope).toBe("fallback");
        expect(r.archiveFallback).toBeGreaterThan(0);
        const apollo = r.results.find((h) => h.path.endsWith("Apollo.md"));
        expect(apollo?.archived).toBe(true);
        const firstArchived = r.results.findIndex((h) => h.archived);
        expect(r.results.slice(firstArchived).every((h) => h.archived)).toBe(true);
      });
    });
  }

  it("treats a folder filter inside the archive root as an archive search", async () => {
    await buildVault();
    const { graph, config } = await open();
    await applyArchive(vault, graph, config, { now: NOW });
    const r = await cascadeSearch(graph, "zephyrine", 20, { folder: "Archive/Meetings/" });
    expect(r.scope).toBe("archive");
    expect(paths(r)).toEqual(["Archive/Meetings/2020-01-15 Zephyrine Sync.md"]);
  });

  it("matches an archived note by its original folder when searching the archive", async () => {
    await buildVault();
    const { graph, config } = await open();
    await applyArchive(vault, graph, config, { now: NOW });
    const r = await cascadeSearch(graph, "zephyrine", 20, { folder: "Meetings/", scope: "archive" });
    expect(paths(r)).toEqual(["Archive/Meetings/2020-01-15 Zephyrine Sync.md"]);
  });

  it("changes nothing about search while archiving is off", async () => {
    await buildVault();
    const graph = new GraphIndex(vault);
    await graph.build();
    const r = await cascadeSearch(graph, "zephyrine", 20, { scope: "active" });
    expect(r.scope).toBeUndefined();
    expect(r.results.some((h) => h.archived)).toBe(false);
  });
});

// ── Flag mode ────────────────────────────────────────────────────────────────

describe("archive — flag mode", () => {
  it("flags notes in place and clears the flag on restore", async () => {
    await buildVault("flag");
    const { graph, config } = await open();
    const run = await applyArchive(vault, graph, config, { now: NOW });
    expect(run.archived.every((e) => e.from === e.to)).toBe(true);
    expect(await read("Projects/Apollo.md")).toContain("archived: true");
    expect(await read("Projects/Hermes.md")).toBe(NOTES["Projects/Hermes.md"]);
    expect(await exists("Archive")).toBe(false);

    const result = await restoreArchived(vault, graph, config, { path: "Projects/Apollo.md" }, { now: NOW });
    expect(result.restored).toHaveLength(1);
    expect(await read("Projects/Apollo.md")).not.toContain("archived:");
    const r = await cascadeSearch(graph, "apollo launch retrospective", 5, { scope: "active" });
    expect(r.results.map((h) => h.path)).toContain("Projects/Apollo.md");
  });
});

// ── MCP tool ─────────────────────────────────────────────────────────────────

describe("manage_archive tool", () => {
  it("plans, applies, restores, and reports through get_health and search_vault", async () => {
    await buildVault();
    const { server, config } = await setupHarness(vault);
    applyArchivePolicy(config);

    const plan = await server.callToolJson("manage_archive", { action: "plan" });
    expect(plan.candidates).toHaveLength(3);

    const applied = await server.callToolJson("manage_archive", { action: "apply" });
    expect(applied.archived).toHaveLength(3);
    const runId = applied.run_id ?? applied.runId;
    expect(runId).toBeTruthy();

    const health = await server.callToolJson("get_health", {});
    expect(health.archive).toMatchObject({ enabled: true, mode: "move", archived_count: 3 });

    const active = await server.callToolJson("search_vault", { query: "zephyrine", scope: "active", limit: 20 });
    expect(active.scope).toBe("active");
    expect(active.archive_hint).toMatch(/scope/);
    const activePaths: string[] = active.results.map((h: { path: string }) => h.path);
    expect(activePaths.length).toBeGreaterThan(0);
    expect(activePaths.some((p) => p.startsWith("Archive/"))).toBe(false);

    const archive = await server.callToolJson("search_vault", { query: "zephyrine", scope: "archive", limit: 20 });
    const archivePaths: string[] = archive.results.map((h: { path: string }) => h.path);
    expect(archivePaths).toContain("Archive/Projects/Apollo.md");
    expect(archivePaths.every((p) => p.startsWith("Archive/"))).toBe(true);
    expect(archive.results.every((h: { archived?: boolean }) => h.archived === true)).toBe(true);

    const restored = await server.callToolJson("manage_archive", { action: "restore", run_id: runId });
    expect(restored.restored).toHaveLength(3);

    const bad = await server.callToolJson("manage_archive", { action: "restore", path: "Projects/Hermes.md" });
    expect(bad.error ?? bad.code).toBeTruthy();
  });

  it("explains that archiving is off instead of applying", async () => {
    await buildVault();
    await writeFile(join(vault, "oil.config.yaml"), "archive:\n  enabled: false\n  rules:\n    - name: x\n      folder: Projects/\n");
    const { server } = await setupHarness(vault);
    const res = await server.callToolJson("manage_archive", { action: "apply" });
    expect(JSON.stringify(res)).toMatch(/CAPABILITY_MISSING/);
    expect(await exists("Projects/Apollo.md")).toBe(true);
  });
});
