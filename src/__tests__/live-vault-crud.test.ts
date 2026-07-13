import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { setupHarness, type TestHarness } from "./harness.js";

/**
 * Explicit opt-in destructive integration test against a real vault.
 *
 * Safety contract:
 * - creates only beneath a UUID-scoped `_oil-validation/` directory;
 * - redirects OIL audit writes into that same temporary directory;
 * - never updates a pre-existing note;
 * - removes the entire scoped directory in `afterAll`;
 * - delete is exercised as an external filesystem mutation because OIL has no
 *   public delete tool; the watcher must remove deleted notes from the catalog.
 */

const liveVaultPath = process.env.OBSIDIAN_VAULT_PATH;
const liveCrudEnabled = process.env.OIL_RUN_LIVE_VAULT_CRUD === "1"
  && process.env.OIL_ALLOW_LIVE_VAULT_WRITES === "1";
const describeLive = liveVaultPath && liveCrudEnabled ? describe : describe.skip;

describeLive("live vault isolated CRUD and retrieval validation", () => {
  const runId = randomUUID();
  const testRoot = `_oil-validation/${runId}`;
  const primaryPath = `${testRoot}/Primary.md`;
  const relatedPath = `${testRoot}/Related.md`;
  const uniqueId = `oil-crud-${runId}`;
  const createBodyMarker = `create-body-${runId}`;
  const appendMarker = `append-body-${runId}`;
  const replaceMarker = `replace-body-${runId}`;

  let harness: TestHarness;
  const report: Record<string, unknown> = {
    run_id: runId,
    test_root: testRoot,
    phases: [],
  };

  beforeAll(async () => {
    const config = structuredClone(await loadConfig(liveVaultPath!));
    config.schema.agentLog = `${testRoot}/_agent-log/`;
    harness = await setupHarness(liveVaultPath!, config);
    harness.watcher.start();
    await harness.watcher.waitUntilReady();
  }, 120_000);

  afterAll(async () => {
    await harness?.watcher.stop();
    await rm(join(liveVaultPath!, testRoot), { recursive: true, force: true });
    await rmdir(join(liveVaultPath!, "_oil-validation")).catch(() => {});
    await harness?.graph.deleteNote(primaryPath);
    await harness?.graph.deleteNote(relatedPath);
    for (const note of harness?.graph.getNotesByFolder(`${testRoot}/`) ?? []) {
      harness.graph.removeNote(note.path);
    }
    console.log(`OIL_LIVE_VAULT_CRUD=${JSON.stringify(report, null, 2)}`);
  });

  it("creates isolated notes and makes them immediately searchable", async () => {
    expect(harness.graph.getNotesByFolder(`${testRoot}/`)).toEqual([]);

    const related = await harness.server.callToolJson("create_note", {
      path: relatedPath,
      content: `---\ntags: [oil-validation]\noil_validation_id: ${uniqueId}-related\n---\n# Related ${runId}\n\nRelated body.\n`,
    });
    expect(related.status).toBe("created");
    expect(related.catalog_state).toBe("current");

    const primary = await harness.server.callToolJson("create_note", {
      path: primaryPath,
      content: `---\ntitle: OIL CRUD ${runId}\naliases: [OIL CRUD Alias ${runId}]\ntags: [oil-validation, crud]\noil_validation_id: ${uniqueId}\nstatus: created\npriority: 7\nenabled: true\nowner:\n  name: Validation Agent\ncustom_unknown_field: preserve-me\n---\n# OIL CRUD ${runId}\n\n${createBodyMarker}\n\n## Validation\n\n- created\n\n[Related](Related.md)\n`,
    });
    expect(primary.status).toBe("created");
    expect(primary.catalog_state).toBe("current");

    const search = await harness.server.callToolJson("search_vault", {
      query: uniqueId,
      limit: 5,
      filter_folder: `${testRoot}/`,
    });
    expect(search.results[0].path).toBe(primaryPath);
    expect(search.results[0].matched_on).toContain("frontmatter.oil_validation_id");
    expect(search.catalog.generation).toBe(primary.catalog_generation);

    const frontmatter = await harness.server.callToolJson("query_frontmatter", {
      key: "oil_validation_id",
      operator: "eq",
      value: uniqueId,
      filter_folder: `${testRoot}/`,
    });
    expect(frontmatter.paths).toEqual([primaryPath]);

    (report.phases as unknown[]).push({
      phase: "create",
      primary_status: primary.status,
      related_status: related.status,
      generation: primary.catalog_generation,
      search_rank: 0,
    });
  }, 30_000);

  it("reads metadata, sections, schema, typed fields, and relationships", async () => {
    const metadata = await harness.server.callToolJson("get_note_metadata", {
      path: primaryPath,
      frontmatter_view: "full",
    });
    expect(metadata.node_id).toBe(primaryPath.replace(/\.md$/, ""));
    expect(metadata.frontmatter.custom_unknown_field).toBe("preserve-me");
    expect(metadata.presentation.title_source).toBe("frontmatter");
    expect(metadata.headings).toContain("Validation");

    const section = await harness.server.callToolJson("read_note_section", {
      path: primaryPath,
      heading: "Validation",
      max_chars: 500,
    });
    expect(section.content).toContain("created");
    expect(section.page.truncated).toBe(false);

    for (const query of [
      { key: "priority", operator: "gte", value: 7 },
      { key: "enabled", operator: "eq", value: true },
      { key: "owner.name", operator: "eq", value: "Validation Agent" },
    ]) {
      const result = await harness.server.callToolJson("query_frontmatter", {
        ...query,
        filter_folder: `${testRoot}/`,
      });
      expect(result.paths, JSON.stringify(query)).toContain(primaryPath);
    }

    const related = await harness.server.callToolJson("get_related_entities", {
      path: primaryPath,
      max_hops: 1,
    });
    expect(related.related.map((entry: { path: string }) => entry.path)).toContain(relatedPath);

    let fieldFound = false;
    let fieldCursor: string | undefined;
    let fieldPages = 0;
    do {
      const fields = await harness.server.callToolJson("inspect_catalog", {
        view: "fields",
        limit: 50,
        ...(fieldCursor ? { cursor: fieldCursor } : {}),
      });
      fieldFound ||= fields.results.some(
        (entry: { key: string }) => entry.key === "oil_validation_id",
      );
      fieldCursor = fields.page.next_cursor;
      fieldPages++;
    } while (!fieldFound && fieldCursor && fieldPages < 20);
    expect(fieldFound).toBe(true);

    const folder = await harness.server.callToolJson("inspect_catalog", {
      view: "folder",
      path: `${testRoot}/`,
      limit: 50,
    });
    expect(folder.results.map((entry: { path: string }) => entry.path)).toEqual(
      expect.arrayContaining([primaryPath, relatedPath]),
    );

    (report.phases as unknown[]).push({
      phase: "read",
      metadata: true,
      section: true,
      typed_queries: 3,
      relationship: true,
      catalog_inspection: true,
      field_pages: fieldPages,
    });
  });

  it("updates by append and replace with immediate search visibility", async () => {
    const beforeAppend = await harness.server.callToolJson("get_note_metadata", { path: primaryPath });
    const append = await harness.server.callToolJson("atomic_append", {
      path: primaryPath,
      heading: "Validation",
      content: `- ${appendMarker}`,
      expected_mtime: beforeAppend.mtime_ms,
    });
    expect(append.status).toBe("executed");
    expect(append.catalog_state).toBe("current");

    const appendedSection = await harness.server.callToolJson("read_note_section", {
      path: primaryPath,
      heading: "Validation",
    });
    expect(appendedSection.content).toContain(appendMarker);
    expect(appendedSection.catalog.generation).toBe(append.catalog_generation);

    const staleAttempt = await harness.server.callToolJson("atomic_append", {
      path: primaryPath,
      heading: "Validation",
      content: "- must-not-write",
      expected_mtime: beforeAppend.mtime_ms,
    });
    expect(staleAttempt.error_code).toBe("CONFLICT");

    const beforeReplace = await harness.server.callToolJson("get_note_metadata", { path: primaryPath });
    const replace = await harness.server.callToolJson("atomic_replace", {
      path: primaryPath,
      expected_mtime: beforeReplace.mtime_ms,
      content: `---\ntitle: OIL CRUD ${runId}\naliases: [OIL CRUD Alias ${runId}]\ntags: [oil-validation, crud, replaced]\noil_validation_id: ${uniqueId}\nstatus: replaced\npriority: 9\nenabled: false\nowner:\n  name: Validation Agent\ncustom_unknown_field: preserve-me\n---\n# OIL CRUD ${runId}\n\n${replaceMarker}\n\n## Validation\n\n- replaced\n\n[Related](Related.md)\n`,
    });
    expect(replace.status).toBe("executed");
    expect(replace.catalog_state).toBe("current");

    const replacedSearch = await harness.server.callToolJson("search_vault", {
      query: replaceMarker,
      filter_folder: `${testRoot}/`,
    });
    expect(replacedSearch.results[0].path).toBe(primaryPath);
    expect(replacedSearch.catalog.generation).toBe(replace.catalog_generation);

    const status = await harness.server.callToolJson("query_frontmatter", {
      key: "status",
      operator: "eq",
      value: "replaced",
      filter_folder: `${testRoot}/`,
    });
    expect(status.paths).toContain(primaryPath);

    const metadata = await harness.server.callToolJson("get_note_metadata", { path: primaryPath });
    expect(metadata.frontmatter.custom_unknown_field).toBe("preserve-me");
    expect(metadata.frontmatter.enabled).toBe(false);

    (report.phases as unknown[]).push({
      phase: "update",
      append: true,
      stale_conflict: true,
      replace: true,
      generation: replace.catalog_generation,
      search_visible: true,
    });
  });

  it("deletes the isolated directory externally and observes catalog removal", async () => {
    await rm(join(liveVaultPath!, testRoot), { recursive: true, force: true });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && harness.graph.getNotesByFolder(`${testRoot}/`).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(harness.graph.getNotesByFolder(`${testRoot}/`)).toEqual([]);

    const search = await harness.server.callToolJson("search_vault", {
      query: uniqueId,
      filter_folder: `${testRoot}/`,
    });
    expect(search.results).toEqual([]);

    const query = await harness.server.callToolJson("query_frontmatter", {
      key: "oil_validation_id",
      operator: "eq",
      value: uniqueId,
      filter_folder: `${testRoot}/`,
    });
    expect(query.error_code).toBe("UNKNOWN_FIELD");

    (report.phases as unknown[]).push({
      phase: "delete",
      filesystem_delete: true,
      watcher_catalog_removal: true,
      search_removed: true,
      observed_field_removed: true,
    });
  }, 20_000);
});
