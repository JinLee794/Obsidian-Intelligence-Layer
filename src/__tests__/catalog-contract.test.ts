import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { setupHarness, type TestHarness } from "./harness.js";

/**
 * Knowledge-catalog contract tests.
 *
 * Passing tests protect behavior that already works.
 * These cases are permanent regression guards for the catalog contract in spec 13.
 */

describe("knowledge catalog contract", () => {
  let tempDir: string;
  let vaultRoot: string;
  let harness: TestHarness;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oil-catalog-contract-"));
    vaultRoot = join(tempDir, "vault");
    await createContractVault(vaultRoot);
    harness = await setupHarness(vaultRoot);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("frontmatter correctness that works today", () => {
    it("retrieves scalar and array frontmatter values case-insensitively", async () => {
      const tpid = await harness.server.callToolJson("query_frontmatter", {
        key: "TPID",
        value_fragment: "zx-9001",
      });
      const alias = await harness.server.callToolJson("query_frontmatter", {
        key: "aliases",
        value_fragment: "north star",
      });

      expect(tpid.paths).toContain("Customers/Frontmatter Only.md");
      expect(alias.paths).toContain("Customers/Frontmatter Only.md");
    });

    it("reflects a frontmatter update after explicit graph reconciliation", async () => {
      const path = "Projects/Mutable.md";
      const fullPath = join(vaultRoot, path);
      const raw = await readFile(fullPath, "utf-8");
      await writeFile(fullPath, raw.replace("status: planned", "status: active"), "utf-8");
      await harness.graph.updateNote(path);

      const result = await harness.server.callToolJson("query_frontmatter", {
        key: "status",
        value_fragment: "active",
      });

      expect(result.paths).toContain(path);
    });

    it("atomic section appends preserve existing frontmatter exactly", async () => {
      const path = "Projects/Mutable.md";
      const beforeRaw = await readFile(join(vaultRoot, path), "utf-8");
      const before = matter(beforeRaw).data;
      const metadata = await harness.server.callToolJson("get_note_metadata", { path });

      const write = await harness.server.callToolJson("atomic_append", {
        path,
        heading: "Agent Insights",
        content: "- User-requested update",
        expected_mtime: metadata.mtime_ms,
      });

      const afterRaw = await readFile(join(vaultRoot, path), "utf-8");
      expect(write.status).toBe("executed");
      expect(matter(afterRaw).data).toEqual(before);
      expect(afterRaw).toContain("User-requested update");
    });

    it("rejects a stale frontmatter-changing replacement without modifying the note", async () => {
      const path = "Projects/Mutable.md";
      const metadata = await harness.server.callToolJson("get_note_metadata", { path });
      const fullPath = join(vaultRoot, path);
      await writeFile(fullPath, "---\nstatus: externally-updated\n---\n# Mutable\n", "utf-8");

      const result = await harness.server.callToolJson("atomic_replace", {
        path,
        content: "---\nstatus: agent-overwrite\n---\n# Mutable\n",
        expected_mtime: metadata.mtime_ms,
      });

      expect(result.error_code).toBe("CONFLICT");
      expect(await readFile(fullPath, "utf-8")).toContain("externally-updated");
    });

    it("persists the requested frontmatter replacement and preserves supplied unknown fields", async () => {
      const path = "Projects/Mutable.md";
      const metadata = await harness.server.callToolJson("get_note_metadata", { path });
      const replacement = `---
tags: [project, shipped]
status: complete
owner:
  name: Alice
custom_user_field: keep-me
---
# Mutable

## Agent Insights

- Completed as requested
`;

      const write = await harness.server.callToolJson("atomic_replace", {
        path,
        content: replacement,
        expected_mtime: metadata.mtime_ms,
      });
      const reread = await harness.server.callToolJson("get_note_metadata", { path });

      expect(write.status).toBe("executed");
      expect(reread.error, JSON.stringify(reread)).toBeUndefined();
      expect(reread.frontmatter).toMatchObject({
        tags: ["project", "shipped"],
        status: "complete",
        owner: { name: "Alice" },
        custom_user_field: "keep-me",
      });
    });
  });

  describe("catalog reliability contracts", () => {
    it("distinguishes an unknown frontmatter field from a known field with zero matches", async () => {
      const result = await harness.server.callToolJson("query_frontmatter", {
        key: "lifecyle_status",
        value_fragment: "active",
      });

      expect(result.error_code).toBe("UNKNOWN_FIELD");
      expect(result.suggestions).toContain("lifecycle_status");
    });

    it("finds a note when the only exact signal is a frontmatter identifier", async () => {
      const response = await harness.server.callToolJson("search_vault", {
        query: "ZX-9001-UNIQUE",
        limit: 5,
      });

      expect(response.results.map((result: { path: string }) => result.path)).toContain(
        "Customers/Frontmatter Only.md",
      );
      expect(response.results[0].path).toBe("Customers/Frontmatter Only.md");
      expect(response.results[0].matched_on).toContain("frontmatter.TPID");
    });

    it("finds exact body evidence beyond the current 10,000-character prefix", async () => {
      const response = await harness.server.callToolJson("search_vault", {
        query: "late-marker-knowledge-987654",
        limit: 5,
      });

      expect(response.results.map((result: { path: string }) => result.path)).toContain(
        "Reference/Long Note.md",
      );
    });

    it("reports pagination when a frontmatter query has more matches than one page", async () => {
      const result = await harness.server.callToolJson("query_frontmatter", {
        key: "batch",
        value_fragment: "overflow",
      });

      expect(result.total).toBe(30);
      expect(result.truncated).toBe(true);
      expect(typeof result.next_cursor).toBe("string");
    });

    it("enforces the hard search-result maximum from spec 13", async () => {
      const response = await harness.server.callToolJson("search_vault", {
        query: "common-overflow-token",
        limit: 1_000,
      });

      expect(response.results.length).toBeLessThanOrEqual(20);
      expect(response.warnings).toContain("LIMIT_CLAMPED:1000->20");
    });

    it("enforces graph hop and result ceilings", async () => {
      const result = await harness.server.callToolJson("get_related_entities", {
        path: "Related/Hub.md",
        max_hops: 99,
      });

      expect(result.max_hops).toBeLessThanOrEqual(2);
      expect(result.related.length).toBeLessThanOrEqual(25);
      expect(result.truncated).toBe(true);
    });

    it("makes a successful frontmatter replacement immediately queryable", async () => {
      const path = "Projects/Mutable.md";
      const metadata = await harness.server.callToolJson("get_note_metadata", { path });
      const write = await harness.server.callToolJson("atomic_replace", {
        path,
        content: "---\nstatus: shipped\nlifecycle_status: complete\n---\n# Mutable\n\nshipped-search-marker\n\n[[Customers/Frontmatter Only]]\n",
        expected_mtime: metadata.mtime_ms,
      });
      expect(write.status).toBe("executed");
      expect(write.catalog_state).toBe("current");

      const query = await harness.server.callToolJson("query_frontmatter", {
        key: "lifecycle_status",
        value_fragment: "complete",
      });
      expect(query.paths).toContain(path);
      expect(query.catalog.generation).toBe(write.catalog_generation);

      const search = await harness.server.callToolJson("search_vault", {
        query: "shipped-search-marker",
      });
      expect(search.results.map((result: { path: string }) => result.path)).toContain(path);
      expect(search.catalog.generation).toBe(write.catalog_generation);

      const related = await harness.server.callToolJson("get_related_entities", {
        path,
        max_hops: 1,
      });
      expect(related.related.map((result: { path: string }) => result.path)).toContain(
        "Customers/Frontmatter Only.md",
      );
      expect(related.catalog.generation).toBe(write.catalog_generation);
    });

    it("keeps a malformed-frontmatter note discoverable with a warning", () => {
      const node = harness.graph.getNode("Reference/Malformed.md") as
        | { warnings?: string[] }
        | undefined;

      expect(node).toBeDefined();
      expect(node?.warnings).toContain("FRONTMATTER_PARSE_ERROR");
    });

    it("searches recoverable body content from malformed-frontmatter notes", async () => {
      const response = await harness.server.callToolJson("search_vault", {
        query: "recoverable-malformed-body",
      });
      expect(response.results[0].path).toBe("Reference/Malformed.md");
    });

    it("does not resolve duplicate titles by index order", () => {
      expect(harness.graph.resolveTitle("Shared Title")).toBeUndefined();
    });

    it("supports typed frontmatter predicates over arrays, nested objects, numbers, booleans, and dates", async () => {
      const cases = [
        { args: { key: "aliases", operator: "all", values: ["North Star Account"] }, path: "Customers/Frontmatter Only.md" },
        { args: { key: "owner.name", operator: "eq", value: "Alice" }, path: "Projects/Mutable.md" },
        { args: { key: "priority", operator: "gte", value: 3 }, path: "Projects/Mutable.md" },
        { args: { key: "enabled", operator: "eq", value: true }, path: "Projects/Mutable.md" },
        { args: { key: "target_date", operator: "lt", value: "2027-01-01" }, path: "Projects/Mutable.md" },
      ];

      for (const testCase of cases) {
        const result = await harness.server.callToolJson("query_frontmatter", testCase.args);
        expect(result.paths, JSON.stringify(testCase.args)).toContain(testCase.path);
      }
    });

    it("continues a frontmatter page without duplicates and invalidates old-generation cursors", async () => {
      const first = await harness.server.callToolJson("query_frontmatter", {
        key: "batch",
        operator: "eq",
        value: "overflow",
        limit: 5,
      });
      const second = await harness.server.callToolJson("query_frontmatter", {
        key: "batch",
        operator: "eq",
        value: "overflow",
        limit: 5,
        cursor: first.next_cursor,
      });
      expect(new Set([...first.paths, ...second.paths]).size).toBe(10);

      const path = "Projects/Mutable.md";
      const raw = await readFile(join(vaultRoot, path), "utf-8");
      await writeFile(join(vaultRoot, path), `${raw}\nCatalog generation update.\n`, "utf-8");
      await harness.graph.updateNote(path);
      const invalid = await harness.server.callToolJson("query_frontmatter", {
        key: "batch",
        operator: "eq",
        value: "overflow",
        limit: 5,
        cursor: first.next_cursor,
      });
      expect(invalid.error_code).toBe("INVALID_CURSOR");
    });

    it("paginates long sections without duplicated or missing text", async () => {
      const path = "Reference/Long Note.md";
      const expected = matter(await readFile(join(vaultRoot, path), "utf-8")).content;
      const headingContent = expected.split("# Long Note\n\n")[1].trim();
      let cursor: string | undefined;
      let assembled = "";
      do {
        const result = await harness.server.callToolJson("read_note_section", {
          path,
          heading: "Long Note",
          max_chars: 500,
          ...(cursor ? { cursor } : {}),
        });
        assembled += result.content;
        cursor = result.page.next_cursor;
      } while (cursor);
      expect(assembled).toBe(headingContent);
    });

    it("exposes observed schema and virtual folders through inspect_catalog", async () => {
      const fields = await harness.server.callToolJson("inspect_catalog", { view: "fields", limit: 50 });
      const folders = await harness.server.callToolJson("inspect_catalog", { view: "folders", limit: 50 });
      expect(fields.results.some((field: { key: string }) => field.key === "lifecycle_status")).toBe(true);
      expect(folders.results.some((folder: { path: string }) => folder.path === "Customers/")).toBe(true);
    });

    it("resolves standard Markdown links and reports ambiguous link candidates", () => {
      const markdownSource = harness.graph.getNode("Related/Markdown Source.md");
      const ambiguousSource = harness.graph.getNode("Related/Ambiguous Source.md");
      expect(markdownSource?.outLinks.has("Customers/Frontmatter Only.md")).toBe(true);
      expect(ambiguousSource?.warnings).toContain("AMBIGUOUS_LINK");
      expect(ambiguousSource?.links[0].candidates).toEqual([
        "Duplicate/A/Shared.md",
        "Duplicate/B/Shared.md",
      ]);
    });
  });
});

async function createContractVault(vaultRoot: string): Promise<void> {
  for (const folder of ["Customers", "Projects", "Reference", "Bulk", "Related", "Duplicate/A", "Duplicate/B"]) {
    await mkdir(join(vaultRoot, folder), { recursive: true });
  }

  await writeFile(
    join(vaultRoot, "Customers/Frontmatter Only.md"),
    `---
tags: [customer]
TPID: ZX-9001-UNIQUE
aliases: [North Star Account]
lifecycle_status: blocked
---
# Generic Account

This body intentionally omits the structured identifier and lifecycle value.
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Projects/Mutable.md"),
    `---
tags: [project]
status: planned
owner:
  name: Alice
priority: 4
enabled: true
target_date: 2026-12-31
---
# Mutable

## Agent Insights

- Initial state
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Reference/Long Note.md"),
    `---
tags: [reference]
---
# Long Note

${"ordinary filler text ".repeat(800)}
late-marker-knowledge-987654
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Reference/Malformed.md"),
    `---
tags: [reference
status: active
---
# Recoverable Malformed Note

recoverable-malformed-body
`,
    "utf-8",
  );

  const links: string[] = [];
  for (let index = 0; index < 30; index++) {
    const suffix = String(index).padStart(2, "0");
    await writeFile(
      join(vaultRoot, `Bulk/Note-${suffix}.md`),
      `---
tags: [bulk]
batch: overflow
---
# Bulk Note ${suffix}

common-overflow-token item ${suffix}
`,
      "utf-8",
    );
    await writeFile(
      join(vaultRoot, `Related/Leaf-${suffix}.md`),
      `# Related Leaf ${suffix}
`,
      "utf-8",
    );
    links.push(`[[Related/Leaf-${suffix}]]`);
  }

  await writeFile(
    join(vaultRoot, "Related/Hub.md"),
    `# Related Hub

${links.join("\n")}
`,
    "utf-8",
  );
  await writeFile(join(vaultRoot, "Duplicate/A/Shared.md"), "# Shared Title\n", "utf-8");
  await writeFile(join(vaultRoot, "Duplicate/B/Shared.md"), "# Shared Title\n", "utf-8");
  await writeFile(
    join(vaultRoot, "Related/Markdown Source.md"),
    "# Markdown Source\n\n[Account](../Customers/Frontmatter%20Only.md#Generic Account)\n",
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Related/Ambiguous Source.md"),
    "# Ambiguous Source\n\n[[Shared Title]]\n",
    "utf-8",
  );
}
