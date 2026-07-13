import { beforeAll, describe, expect, it } from "vitest";
import { listAllNotes } from "../vault.js";
import { searchVault } from "../search.js";
import { setupHarness, type TestHarness } from "./harness.js";

/**
 * Optional read-only audit against a real vault.
 *
 * Run with:
 *   OBSIDIAN_VAULT_PATH=/absolute/path npm run test:vault:live
 *
 * The suite never starts the watcher and never calls write tools. It builds an
 * in-memory snapshot, verifies deterministic structured lookup samples, and
 * reports unified-search recall for values that exist only in frontmatter.
 */

const liveVaultPath = process.env.OBSIDIAN_VAULT_PATH;
const liveAuditEnabled = process.env.OIL_RUN_LIVE_VAULT_AUDIT === "1";
const describeLive = liveVaultPath && liveAuditEnabled ? describe : describe.skip;

describeLive("live vault read-only audit", () => {
  let harness: TestHarness;
  let listedPaths: string[];
  let parseFailures: Array<{ path: string; error: string }>;
  let uniqueSamples: FrontmatterSample[];
  let exactTitleSamples: Array<{ title: string; path: string }>;
  let exactTitleMisses: Array<{ title: string; path: string; actual?: string }>;
  let report: Record<string, unknown>;

  beforeAll(async () => {
    const vaultPath = liveVaultPath!;
    listedPaths = await listAllNotes(vaultPath);
    harness = await setupHarness(vaultPath);
    parseFailures = harness.graph.getCatalogIssues()
      .filter((issue) => issue.code === "FRONTMATTER_PARSE_ERROR")
      .map((issue) => ({ path: issue.path, error: issue.message }));

    const occurrences = new Map<string, FrontmatterSample[]>();
    for (const path of listedPaths) {
      const node = harness.graph.getNode(path);
      if (!node) continue;
      for (const [key, rawValue] of Object.entries(node.frontmatter)) {
        for (const value of normalizeValues(rawValue)) {
          if (!value || value.length > 120) continue;
          const signature = `${key.toLowerCase()}\u0000${value.toLowerCase()}`;
          const bucket = occurrences.get(signature) ?? [];
          bucket.push({ key, value, path });
          occurrences.set(signature, bucket);
        }
      }
    }

    uniqueSamples = [...occurrences.values()]
      .filter((bucket) => bucket.length === 1)
      .map((bucket) => bucket[0])
      .sort((a, b) => `${a.key}:${a.value}:${a.path}`.localeCompare(`${b.key}:${b.value}:${b.path}`))
      .slice(0, 50);

    const structuredFailures: FrontmatterSample[] = [];
    const frontmatterOnlySamples: FrontmatterSample[] = [];
    const unifiedSearchMisses: FrontmatterSample[] = [];

    const titleOccurrences = new Map<string, Array<{ title: string; path: string }>>();
    for (const ref of harness.graph.getNotesByFolder("")) {
      const key = ref.title.toLowerCase();
      const bucket = titleOccurrences.get(key) ?? [];
      bucket.push({ title: ref.title, path: ref.path });
      titleOccurrences.set(key, bucket);
    }
    exactTitleSamples = [...titleOccurrences.values()]
      .filter((bucket) => bucket.length === 1 && bucket[0].title.length <= 120)
      .map((bucket) => bucket[0])
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 20);
    exactTitleMisses = [];
    for (const sample of exactTitleSamples) {
      const results = searchVault(harness.graph, harness.config, sample.title, undefined, 5);
      if (results[0]?.path !== sample.path) {
        exactTitleMisses.push({ ...sample, actual: results[0]?.path });
      }
    }

    for (const sample of uniqueSamples) {
      const query = await harness.server.callToolJson("query_frontmatter", {
        key: sample.key,
        value_fragment: sample.value,
      });
      if (!query.paths?.includes(sample.path)) structuredFailures.push(sample);

      const node = harness.graph.getNode(sample.path);
      if (!node || isSearchableWithoutFrontmatter(node, sample.value)) continue;

      frontmatterOnlySamples.push(sample);
      const results = searchVault(harness.graph, harness.config, sample.value, undefined, 10);
      if (!results.some((result) => result.path === sample.path)) {
        unifiedSearchMisses.push(sample);
      }
      if (frontmatterOnlySamples.length >= 20) break;
    }

    const unknownField = await harness.server.callToolJson("query_frontmatter", {
      key: "__oil_live_audit_unknown_field__",
      value_fragment: "missing",
    });

    report = {
      vault_path: vaultPath,
      listed_files: listedPaths.length,
      indexed_nodes: harness.graph.nodeCount,
      parse_failures: parseFailures.length,
      parse_failure_examples: parseFailures.slice(0, 10),
      unique_frontmatter_samples: uniqueSamples.length,
      structured_query_failures: structuredFailures,
      frontmatter_only_samples_tested: frontmatterOnlySamples.length,
      unified_search_frontmatter_misses: unifiedSearchMisses,
      unified_search_frontmatter_recall:
        frontmatterOnlySamples.length === 0
          ? null
          : (frontmatterOnlySamples.length - unifiedSearchMisses.length) /
            frontmatterOnlySamples.length,
          exact_title_samples_tested: exactTitleSamples.length,
          exact_title_rank1_misses: exactTitleMisses,
      unknown_field_has_error_code: unknownField.error_code === "UNKNOWN_FIELD",
      graph_stats: harness.graph.getStats(),
    };

    console.log(`OIL_LIVE_VAULT_AUDIT=${JSON.stringify(report, null, 2)}`);
  }, 120_000);

  it("indexes every readable supported file, including recoverable malformed frontmatter", () => {
    expect(harness.graph.nodeCount).toBe(listedPaths.length);
    expect(harness.graph.getWarningCounts().FRONTMATTER_PARSE_ERROR ?? 0).toBe(
      parseFailures.length,
    );
  });

  it("retrieves deterministic unique frontmatter samples through structured lookup", async () => {
    expect(uniqueSamples.length).toBeGreaterThan(0);

    for (const sample of uniqueSamples) {
      const result = await harness.server.callToolJson("query_frontmatter", {
        key: sample.key,
        value_fragment: sample.value,
      });
      expect(
        result.paths,
        `Expected ${sample.path} for ${sample.key}=${sample.value}`,
      ).toContain(sample.path);
    }
  }, 120_000);

  it("returns unique exact titles at rank one across the existing vault", () => {
    expect(exactTitleSamples.length).toBeGreaterThan(0);
    expect(exactTitleMisses).toEqual([]);
  });

  it("produces a bounded diagnostic report without modifying the vault", () => {
    expect(report).toHaveProperty("listed_files");
    expect(report).toHaveProperty("unified_search_frontmatter_recall");
    expect((report.parse_failure_examples as unknown[]).length).toBeLessThanOrEqual(10);
    expect((report.unified_search_frontmatter_misses as unknown[]).length).toBeLessThanOrEqual(20);
  });
});

interface FrontmatterSample {
  key: string;
  value: string;
  path: string;
}

function normalizeValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeValues(entry));
  }
  if (value && typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [];
}

function isSearchableWithoutFrontmatter(
  node: {
    title: string;
    tags: string[];
    headings: string[];
    bodySnippet: string;
    path: string;
  },
  value: string,
): boolean {
  const needle = value.toLowerCase();
  return [
    node.title,
    node.path,
    ...node.tags,
    ...node.headings,
    node.bodySnippet,
  ].some((candidate) => candidate.toLowerCase().includes(needle));
}
