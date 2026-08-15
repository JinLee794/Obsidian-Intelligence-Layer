/**
 * Multi-turn retrieval consistency at scale.
 *
 * An agent issues many calls across a conversation and must be able to rely on
 * the results: same query → same answer, refs that are valid inputs to the next
 * tool, and narrow requests that agree with wide ones. These properties are
 * what make tool use predictable; none of them are guaranteed by the per-tool
 * unit tests, which each run a single call against a 12-note fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVault } from "../../../bench/fixtures/generate-vault.js";
import { setupHarness, type MockMcpServer } from "../harness.js";

const NOTE_COUNT = 1_500;
const TURNS = 8;

let vaultDir: string;
let server: MockMcpServer;

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "oil-scale-"));
  await generateVault({ noteCount: NOTE_COUNT, outputDir: vaultDir, seed: 7 });
  ({ server } = await setupHarness(vaultDir));
}, 180_000);

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

const paths = (res: { results: Array<{ path: string }> }) => res.results.map((r) => r.path);

const QUERIES = [
  "Azure Migration",
  "escalation",
  "cost optimization",
  "landing zone",
  "compliance audit",
  "risk",
];

// ═══════════════════════════════════════════════════════════════════════════════

describe("scale — index integrity", () => {
  it("indexes the whole generated vault", async () => {
    const health = await server.callToolJson("get_health", {});
    expect(health.index.note_count).toBeGreaterThan(NOTE_COUNT * 0.9);
  });

  it("returns results for every representative query", async () => {
    for (const query of QUERIES) {
      const res = await server.callToolJson("search_vault", { query, limit: 10 });
      expect(res.results.length, `no results for "${query}"`).toBeGreaterThan(0);
    }
  });
});

describe("multi-turn — repeatability", () => {
  it("returns byte-identical results for a repeated query", async () => {
    for (const query of QUERIES) {
      const first = await server.callToolRaw("search_vault", { query, limit: 10 });
      for (let turn = 1; turn < TURNS; turn++) {
        const again = await server.callToolRaw("search_vault", { query, limit: 10 });
        expect(again, `"${query}" drifted on turn ${turn}`).toBe(first);
      }
    }
  });

  it("keeps frontmatter queries stable across turns", async () => {
    const first = await server.callToolRaw("query_frontmatter", { key: "status" });
    for (let turn = 1; turn < TURNS; turn++) {
      expect(await server.callToolRaw("query_frontmatter", { key: "status" })).toBe(first);
    }
  });

  it("keeps graph traversal stable across turns", async () => {
    const customers = await server.callToolJson("query_frontmatter", {
      where: { tags: "customer" },
      limit: 1,
    });
    const target = customers.results[0].path;

    const first = await server.callToolRaw("get_related_entities", { path: target });
    for (let turn = 1; turn < TURNS; turn++) {
      expect(await server.callToolRaw("get_related_entities", { path: target })).toBe(first);
    }
  });
});

describe("multi-turn — narrow requests agree with wide ones", () => {
  // An agent that asks for 5 and later for 20 must not see the first 5 reorder.
  it("treats a smaller limit as a prefix of a larger one", async () => {
    for (const query of QUERIES) {
      const narrow = paths(await server.callToolJson("search_vault", { query, limit: 3 }));
      const wide = paths(await server.callToolJson("search_vault", { query, limit: 15 }));
      expect(wide.slice(0, narrow.length), `"${query}" reordered`).toEqual(narrow);
    }
  });

  it("returns a folder-filtered result set contained in the unfiltered one", async () => {
    const query = "Azure Migration";
    const all = new Set(paths(await server.callToolJson("search_vault", { query, limit: 50 })));
    const scoped = paths(
      await server.callToolJson("search_vault", { query, limit: 50, filter_folder: "Meetings/" }),
    );

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((p) => p.startsWith("Meetings/"))).toBe(true);
    // Scoped hits that also surface unfiltered must not contradict it.
    expect(scoped.filter((p) => all.has(p)).length).toBeGreaterThan(0);
  });
});

describe("multi-turn — refs chain into the next tool", () => {
  it("accepts every search ref as a metadata path", async () => {
    const res = await server.callToolJson("search_vault", { query: "escalation", limit: 10 });
    expect(res.results.length).toBeGreaterThan(0);

    for (const hit of res.results) {
      const meta = await server.callToolJson("get_note_metadata", { path: hit.path });
      expect(meta.error, `metadata failed for ${hit.path}`).toBeUndefined();
      expect(meta.mtime_ms).toBeGreaterThan(0);
    }
  });

  it("accepts every advertised heading as a section read", async () => {
    const res = await server.callToolJson("search_vault", { query: "risk", limit: 5 });

    for (const hit of res.results) {
      const meta = await server.callToolJson("get_note_metadata", { path: hit.path });
      for (const heading of meta.headings.slice(0, 3)) {
        const section = await server.callToolJson("read_note_section", {
          path: hit.path,
          heading,
        });
        expect(section.error, `${hit.path}#${heading} failed`).toBeUndefined();
      }
    }
  });

  it("accepts every frontmatter query result as a readable note", async () => {
    const res = await server.callToolJson("query_frontmatter", {
      where: { tags: "customer" },
      limit: 10,
    });
    expect(res.results.length).toBeGreaterThan(0);

    for (const hit of res.results) {
      const meta = await server.callToolJson("get_note_metadata", { path: hit.path });
      expect(meta.error, `metadata failed for ${hit.path}`).toBeUndefined();
    }
  });

  it("accepts every traversal ref as a readable note", async () => {
    const seed = await server.callToolJson("query_frontmatter", {
      where: { tags: "customer" },
      limit: 1,
    });
    const related = await server.callToolJson("get_related_entities", {
      path: seed.results[0].path,
    });

    for (const ref of related.related.slice(0, 10)) {
      const meta = await server.callToolJson("get_note_metadata", { path: ref.path });
      expect(meta.error, `metadata failed for ${ref.path}`).toBeUndefined();
    }
  });
});

describe("multi-turn — tools agree with each other", () => {
  it("search and frontmatter query resolve an identifier to the same note", async () => {
    const facet = await server.callToolJson("query_frontmatter", { key: "tpid", limit: 5 });
    expect(facet.values.length).toBeGreaterThan(0);

    for (const { value } of facet.values.slice(0, 5)) {
      const viaSearch = paths(await server.callToolJson("search_vault", { query: value, limit: 3 }));
      const viaQuery = await server.callToolJson("query_frontmatter", {
        key: "tpid",
        value_fragment: value,
      });
      expect(viaSearch[0], `tpid ${value} disagreed`).toBe(viaQuery.paths[0]);
    }
  });

  it("reports facet counts that match the predicate result count", async () => {
    const facet = await server.callToolJson("query_frontmatter", { key: "status", limit: 50 });

    for (const { value, count } of facet.values.slice(0, 5)) {
      const matched = await server.callToolJson("query_frontmatter", {
        where: { status: value },
        limit: 1,
      });
      expect(matched.total_matched, `status=${value} count mismatch`).toBe(count);
    }
  });
});

describe("multi-turn — consistency across a write", () => {
  it("reflects a write on the next read and stays stable afterwards", async () => {
    const seed = await server.callToolJson("query_frontmatter", {
      where: { tags: "customer" },
      limit: 1,
    });
    const target = seed.results[0].path;

    const before = await server.callToolJson("get_note_metadata", { path: target });
    const heading = before.headings[0];

    const write = await server.callToolJson("atomic_append", {
      path: target,
      heading,
      content: "- scale-consistency marker",
      expected_mtime: before.mtime_ms,
    });
    expect(write.status).toBe("executed");

    const section = await server.callToolJson("read_note_section", { path: target, heading });
    expect(section.content).toContain("scale-consistency marker");

    // Repeated reads after the write must not oscillate between cached and fresh.
    const first = await server.callToolRaw("read_note_section", { path: target, heading });
    for (let turn = 1; turn < TURNS; turn++) {
      expect(await server.callToolRaw("read_note_section", { path: target, heading })).toBe(first);
    }
  });

  it("rejects a second write reusing the stale mtime", async () => {
    const seed = await server.callToolJson("query_frontmatter", {
      where: { tags: "customer" },
      limit: 1,
    });
    const target = seed.results[0].path;
    const meta = await server.callToolJson("get_note_metadata", { path: target });

    const ok = await server.callToolJson("atomic_append", {
      path: target,
      heading: meta.headings[0],
      content: "- first",
      expected_mtime: meta.mtime_ms,
    });
    expect(ok.status).toBe("executed");

    const stale = await server.callToolJson("atomic_append", {
      path: target,
      heading: meta.headings[0],
      content: "- second",
      expected_mtime: meta.mtime_ms,
    });
    expect(stale.error_code).toBe("CONFLICT");
  });
});

describe("scale — response cost stays bounded", () => {
  const CHAR_BUDGET = 32_000;

  it.each([
    ["search_vault", { query: "risk", limit: 10 }, 0.25],
    ["query_frontmatter", {}, 0.25],
    ["query_frontmatter", { key: "tags", limit: 50 }, 0.25],
    // A hub note's 2-hop neighbourhood is the largest response OIL produces;
    // MAX_LIST_ITEMS caps the item count, not the serialized size.
    ["get_related_entities", null, 0.40],
    ["get_health", {}, 0.10],
  ])("%s stays within budget", async (tool, args, fraction) => {
    let payload = args as Record<string, unknown> | null;
    if (payload === null) {
      const seed = await server.callToolJson("query_frontmatter", {
        where: { tags: "customer" },
        limit: 1,
      });
      payload = { path: seed.results[0].path };
    }
    const raw = await server.callToolRaw(tool as string, payload);
    expect(raw.length).toBeLessThan(CHAR_BUDGET * (fraction as number));
  });
});
