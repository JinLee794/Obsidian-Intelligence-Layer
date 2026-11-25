/**
 * migrate-graph — moving an existing vault's single `_oil-graph.json` to the
 * segmented layout, checking it, and moving it back.
 *
 * What an existing user relies on: the preview writes nothing; `--apply` keeps
 * the old file as a backup and only reports success once the new layout reloads
 * to the same graph; `--verify` writes nothing; and `--rollback` restores the
 * single file from whatever is left.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphIndex } from "../graph.js";
import {
  applyMigration,
  backupFileFor,
  compareGraphs,
  planMigration,
  readLayoutStatus,
  rollbackMigration,
  verifyGraph,
} from "../graph-migrate.js";
import type { MigrateAction, MigrateOptions, MigrateReport } from "../graph-migrate.js";
import { runMigrateGraphCli } from "../graph-migrate-cli.js";
import { acquireIndexLock } from "../index-lock.js";
import type { PersistedSkeleton } from "../graph-segments.js";
import { INDEX_FILE, PERSON_NOTE, SEGMENT_DIR, SKELETON, exists, seedVault, snapshotTree } from "./segmented-vault.js";

const BACKUP_FILE = backupFileFor(INDEX_FILE);
const quiet = () => {};
const opts: MigrateOptions = { graphIndexFile: INDEX_FILE, log: quiet, lockWaitMs: 2_000 };

let lockRoot: string;
let tempDir: string;
let vault: string;
let notes: string[];

beforeAll(async () => {
  lockRoot = await mkdtemp(join(tmpdir(), "oil-migrate-locks-"));
  process.env.OIL_LOCK_DIR = lockRoot;
});

afterAll(async () => {
  delete process.env.OIL_LOCK_DIR;
  await rm(lockRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-migrate-"));
  vault = join(tempDir, "vault");
  notes = await seedVault(vault);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** What OIL 0.9.x leaves behind: one v2 `_oil-graph.json`. */
async function legacyIndex(): Promise<{ graph: GraphIndex; bytes: number }> {
  const graph = new GraphIndex(vault);
  await graph.build();
  await graph.saveToDisk(INDEX_FILE);
  expect(graph.lastSave?.layout).toBe("single");
  return { graph, bytes: (await stat(join(vault, INDEX_FILE))).size };
}

async function migrated(): Promise<void> {
  await legacyIndex();
  const report = await applyMigration(vault, opts);
  expect(report.ok, report.errors.join("; ")).toBe(true);
}

async function loaded(): Promise<GraphIndex> {
  const graph = new GraphIndex(vault);
  expect(await graph.loadFromDisk(INDEX_FILE)).toBe(true);
  return graph;
}

describe("migrate-graph — preview", () => {
  it("reports the layout it would write and writes nothing", async () => {
    const { bytes } = await legacyIndex();
    const before = await snapshotTree(vault);

    const report = await planMigration(vault, opts);
    expect(report.ok).toBe(true);
    expect(report.changed).toBe(false);
    expect(report.source).toBe("single");
    expect(report.nodes).toBe(notes.length);
    expect(report.before.active).toBe("single");
    expect(report.plan?.legacyBytes).toBe(bytes);
    expect(report.plan?.segments ?? 0).toBeGreaterThan(3);
    expect(report.plan?.typicalFlushBytes ?? Infinity).toBeLessThan(bytes);
    expect(report.messages.join("\n")).toContain("--apply");
    expect(await snapshotTree(vault)).toBe(before);
  });

  it("warns when OIL is configured to convert the index back", async () => {
    await legacyIndex();
    const report = await planMigration(vault, { ...opts, configuredLayout: "single" });
    expect(report.messages.join("\n")).toContain("OIL is configured for the single layout");
  });

  it("plans from the notes when no index exists, and verify says there is none", async () => {
    const before = await snapshotTree(vault);
    const report = await planMigration(vault, opts);
    expect(report.ok).toBe(true);
    expect(report.source).toBe("build");
    expect(report.nodes).toBe(notes.length);
    expect(await snapshotTree(vault)).toBe(before);

    const verified = await verifyGraph(vault, opts);
    expect(verified.ok).toBe(false);
    expect(verified.errors.join("\n")).toMatch(/No persisted graph index/);
  });
});

describe("migrate-graph --apply", () => {
  it("migrates, checks the reload and keeps the old file as a backup", async () => {
    const { graph: legacy } = await legacyIndex();

    const report = await applyMigration(vault, opts);
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.changed).toBe(true);
    expect(report.source).toBe("single");
    expect(report.parity?.ok).toBe(true);
    expect(report.parity?.nodes).toBe(notes.length);
    expect(report.written?.files ?? 0).toBeGreaterThan(1);
    expect(report.after.active).toBe("segmented");
    expect(report.backupFile).toBe(BACKUP_FILE);
    expect(await exists(join(vault, INDEX_FILE))).toBe(false);
    expect(await exists(join(vault, BACKUP_FILE))).toBe(true);
    expect(await exists(join(vault, SKELETON))).toBe(true);

    // What the server loads next is the graph the single file held.
    const reopened = await loaded();
    expect(reopened.loadedLayout).toBe("segmented");
    const parity = compareGraphs(legacy, reopened, "exact");
    expect(parity.ok, JSON.stringify(parity)).toBe(true);
  });

  it("changes nothing when run again", async () => {
    await migrated();
    const before = await snapshotTree(vault);

    const again = await applyMigration(vault, opts);
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.messages.join("\n")).toMatch(/Already migrated/);
    expect(await snapshotTree(vault)).toBe(before);
  });

  it("repairs a damaged segment that verify reports", async () => {
    await migrated();
    const skeleton = JSON.parse(await readFile(join(vault, SKELETON), "utf-8")) as PersistedSkeleton;
    const damaged = Object.values(skeleton.segments).find((meta) => meta.notes > 1);
    if (!damaged) throw new Error("fixture has no multi-note segment");
    await writeFile(join(vault, SEGMENT_DIR, damaged.file), "{ not json", "utf-8");

    const broken = await verifyGraph(vault, opts);
    expect(broken.ok).toBe(false);
    expect(broken.errors.join("\n")).toMatch(/damaged segment/);

    const repaired = await applyMigration(vault, opts);
    expect(repaired.ok, repaired.errors.join("; ")).toBe(true);
    expect(repaired.changed).toBe(true);
    expect(repaired.source).toBe("segmented");
    expect(repaired.messages.join("\n")).toMatch(/Repairing 1 damaged segment/);

    // The recovered notes carry no mtime, so verify re-reads exactly those.
    const verified = await verifyGraph(vault, opts);
    expect(verified.ok, verified.errors.join("; ")).toBe(true);
    expect(verified.health?.damagedSegments).toEqual([]);
    expect(verified.stale).toEqual({ changed: damaged.notes, added: 0, deleted: 0 });
  });

  it("re-creates the index from the notes with --rebuild", async () => {
    await migrated();
    const report = await applyMigration(vault, { ...opts, rebuild: true });
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.changed).toBe(true);
    expect(report.source).toBe("build");
    expect(report.parity?.ok).toBe(true);
  });

  it("leaves the single file in place with --keep-legacy, which verify flags as stale", async () => {
    await legacyIndex();
    const report = await applyMigration(vault, { ...opts, keepLegacy: true });
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.backupFile).toBeUndefined();
    expect(report.messages.join("\n")).toContain("--keep-legacy");
    expect(await exists(join(vault, INDEX_FILE))).toBe(true);
    expect(await exists(join(vault, BACKUP_FILE))).toBe(false);
    expect((await loaded()).loadedLayout).toBe("segmented");

    const verified = await verifyGraph(vault, opts);
    expect(verified.ok, verified.errors.join("; ")).toBe(true);
    expect(verified.messages.join("\n")).toContain("stale");
  });

  it("refuses while another OIL process holds the graph lock", async () => {
    await legacyIndex();
    const log = vi.fn();
    const lease = await acquireIndexLock(vault, "graph", { wait: false, log: quiet });
    expect(lease).not.toBeNull();
    try {
      await expect(applyMigration(vault, { ...opts, log, lockWaitMs: 300 })).rejects.toThrow(/another OIL process/);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/waiting/));
    } finally {
      await lease!.release();
    }
    expect(await exists(join(vault, SEGMENT_DIR))).toBe(false);
    expect(await exists(join(vault, INDEX_FILE))).toBe(true);
  });

  it("warns when OIL is configured to convert the index back", async () => {
    await legacyIndex();
    const report = await applyMigration(vault, { ...opts, configuredLayout: "single" });
    expect(report.ok).toBe(true);
    expect(report.messages.join("\n")).toContain("OIL is configured for the single layout");
  });
});

describe("migrate-graph --verify", () => {
  it("matches a fresh build, and counts what the index has not caught up with", async () => {
    await migrated();
    const clean = await verifyGraph(vault, opts);
    expect(clean.ok, clean.errors.join("; ")).toBe(true);
    expect(clean.source).toBe("segmented");
    expect(clean.parity?.nodes).toBe(notes.length);
    expect(clean.stale).toEqual({ changed: 0, added: 0, deleted: 0 });

    const before = await snapshotTree(vault);
    const person = join(vault, PERSON_NOTE);
    await writeFile(person, `${await readFile(person, "utf-8")}\nMet [[Tailspin]] again.\n`, "utf-8");
    const later = new Date(Date.now() + 10_000);
    await utimes(person, later, later);
    await writeFile(join(vault, "People", "Ian Ives.md"), "---\ntype: person\n---\n\n# Ian Ives\n\nWorks with [[Contoso]].\n");
    await unlink(join(vault, "Projects", "Roadmap.md"));
    const edited = await snapshotTree(vault);
    expect(edited).not.toBe(before);

    const stale = await verifyGraph(vault, opts);
    expect(stale.ok, stale.errors.join("; ")).toBe(true);
    expect(stale.stale).toEqual({ changed: 1, added: 1, deleted: 1 });
    expect(stale.messages.join("\n")).toMatch(/behind the vault/);
    expect(await snapshotTree(vault)).toBe(edited);
  });
});

describe("migrate-graph --rollback", () => {
  it("returns to the single file with the same graph, and is idempotent", async () => {
    await migrated();
    const segmented = await loaded();

    const report = await rollbackMigration(vault, opts);
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.changed).toBe(true);
    expect(report.source).toBe("segmented");
    expect(report.after.active).toBe("single");
    expect(await exists(join(vault, SEGMENT_DIR))).toBe(false);
    expect(await exists(join(vault, BACKUP_FILE))).toBe(true);
    expect(report.messages.join("\n")).toContain(BACKUP_FILE);

    const single = await loaded();
    expect(single.loadedLayout).toBe("single");
    const parity = compareGraphs(segmented, single, "exact");
    expect(parity.ok, JSON.stringify(parity)).toBe(true);

    const again = await rollbackMigration(vault, opts);
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.messages.join("\n")).toMatch(/Already on the single-file layout/);
  });

  it("restores from the backup when the segmented index is gone", async () => {
    const { graph: legacy } = await legacyIndex();
    expect((await applyMigration(vault, opts)).ok).toBe(true);
    await rm(join(vault, SEGMENT_DIR), { recursive: true, force: true });
    const status = await readLayoutStatus(vault, INDEX_FILE);
    expect(status.active).toBe("none");
    expect(status.backup.present).toBe(true);

    const report = await rollbackMigration(vault, opts);
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.source).toBe("backup");
    expect(compareGraphs(legacy, await loaded(), "exact").ok).toBe(true);
  });
});

describe("migrate-graph command", () => {
  const saved = { vault: process.env.OBSIDIAN_VAULT_PATH, layout: process.env.OIL_GRAPH_LAYOUT };
  const cli = (action: MigrateAction, json = false) =>
    runMigrateGraphCli({ action, json, keepLegacy: false, rebuild: false });

  /** Silence the command's output and keep it for assertions. */
  function capture() {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const printed = () => out.mock.calls.map((args) => String(args[0])).join("\n");
    return { out, err, printed };
  }

  beforeEach(() => {
    process.env.OBSIDIAN_VAULT_PATH = vault;
    delete process.env.OIL_GRAPH_LAYOUT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["OBSIDIAN_VAULT_PATH", saved.vault],
      ["OIL_GRAPH_LAYOUT", saved.layout],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("previews, applies and verifies a vault through its config", async () => {
    await legacyIndex();
    const { out, printed } = capture();

    expect(await cli("plan")).toBe(0);
    expect(printed()).toContain("Re-run with --apply");
    expect(await exists(join(vault, SEGMENT_DIR))).toBe(false);

    out.mockClear();
    expect(await cli("apply", true)).toBe(0);
    const report = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as MigrateReport;
    expect(report.action).toBe("apply");
    expect(report.after.active).toBe("segmented");
    expect(report.backupFile).toBe(BACKUP_FILE);

    out.mockClear();
    expect(await cli("verify")).toBe(0);
    expect(printed()).toContain("Verified.");
  });

  it("passes OIL_GRAPH_LAYOUT through, so the warning reaches the user", async () => {
    await legacyIndex();
    const { printed } = capture();
    process.env.OIL_GRAPH_LAYOUT = "single";
    expect(await cli("plan")).toBe(0);
    expect(printed()).toContain("OIL is configured for the single layout");
  });

  it("exits non-zero when verification fails or no vault is set", async () => {
    const { err, printed } = capture();
    expect(await cli("verify")).toBe(1);
    expect(printed()).toContain("Verification failed");

    delete process.env.OBSIDIAN_VAULT_PATH;
    expect(await cli("plan")).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/OBSIDIAN_VAULT_PATH/));
  });
});
