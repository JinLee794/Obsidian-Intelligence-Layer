/**
 * Long-session soak — retrieval consistency over many turns at scale.
 *
 * Complements scale-consistency.test.ts, which checks each property in
 * isolation. This runs a realistic interleaved session (search → read →
 * traverse → write → search) across a large vault and asserts nothing drifts
 * between the first turn and the last.
 *
 * Queries are SAMPLED FROM THE VAULT rather than hand-written, so the results
 * are not biased by picking cases known to work.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVault } from "../../../bench/fixtures/generate-vault.js";
import { setupHarness, type MockMcpServer } from "../harness.js";

const NOTE_COUNT = 5_000;
const TURNS = 25;
const SETUP_TIMEOUT = 600_000;
const RUN_TIMEOUT = 300_000;

let vaultDir: string;
let server: MockMcpServer;
let queries: string[];
let notePaths: string[];

/** Deterministic sampling so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "oil-soak-"));
  await generateVault({ noteCount: NOTE_COUNT, outputDir: vaultDir, seed: 11 });
  ({ server } = await setupHarness(vaultDir));

  const rand = mulberry32(99);

  // Build the query set from real vault content: titles, tag values, and
  // frontmatter identifiers. Hand-picked queries would flatter the ranker.
  const all = await server.callToolJson("query_frontmatter", {
    where: { tags: "customer" },
    limit: 40,
  });
  notePaths = all.results.map((r: { path: string }) => r.path);

  const titles: string[] = all.results.map((r: { title: string }) => r.title);
  const tagFacet = await server.callToolJson("query_frontmatter", { key: "tags", limit: 20 });
  const tagValues: string[] = tagFacet.values.map((v: { value: string }) => v.value);
  const tpidFacet = await server.callToolJson("query_frontmatter", { key: "tpid", limit: 15 });
  const tpids: string[] = tpidFacet.values.map((v: { value: string }) => v.value);
  const statusFacet = await server.callToolJson("query_frontmatter", { key: "status", limit: 10 });
  const statuses: string[] = statusFacet.values.map((v: { value: string }) => v.value);

  const pool = [...titles, ...tagValues, ...tpids, ...statuses].filter(Boolean);
  queries = [...pool].sort(() => rand() - 0.5).slice(0, 24);
}, SETUP_TIMEOUT);

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// ═══════════════════════════════════════════════════════════════════════════════

describe(`soak — ${NOTE_COUNT} notes`, () => {
  it("indexes the vault and samples a real query set", async () => {
    const health = await server.callToolJson("get_health", {});
    console.log(
      `SOAK notes=${health.index.note_count} links=${health.index.link_count} tags=${health.index.tag_count} queries=${queries.length}`,
    );
    expect(health.index.note_count).toBeGreaterThan(NOTE_COUNT * 0.9);
    expect(queries.length).toBeGreaterThan(10);
  });

  it("answers every sampled query", async () => {
    const empty: string[] = [];
    for (const q of queries) {
      const res = await server.callToolJson("search_vault", { query: q, limit: 10 });
      if (res.results.length === 0) empty.push(q);
    }
    console.log(`SOAK empty_results=${empty.length}/${queries.length} ${empty.slice(0, 5).join(" | ")}`);
    expect(empty.length).toBe(0);
  }, RUN_TIMEOUT);
});

describe("soak — no drift across a long session", () => {
  it(
    "returns identical results on turn 1 and turn N after interleaved work",
    async () => {
      const baseline = new Map<string, string>();
      for (const q of queries) {
        baseline.set(q, await server.callToolRaw("search_vault", { query: q, limit: 10 }));
      }

      const latencies: number[] = [];

      // Interleave the operations an agent actually performs between searches,
      // including writes, so index invalidation is exercised mid-session.
      for (let turn = 0; turn < TURNS; turn++) {
        const q = queries[turn % queries.length];
        const started = performance.now();
        const res = await server.callToolJson("search_vault", { query: q, limit: 10 });
        latencies.push(performance.now() - started);

        if (res.results.length > 0) {
          const target = res.results[0].path;
          const meta = await server.callToolJson("get_note_metadata", { path: target });
          if (meta.headings?.length) {
            await server.callToolJson("read_note_section", {
              path: target,
              heading: meta.headings[0],
            });
          }
          await server.callToolJson("get_related_entities", { path: target, max_hops: 1 });
        }

        await server.callToolJson("query_frontmatter", { key: "status" });

        // A write every few turns: rebuilds derived indexes mid-session.
        if (turn % 5 === 4 && notePaths.length > 0) {
          const target = notePaths[turn % notePaths.length];
          const meta = await server.callToolJson("get_note_metadata", { path: target });
          if (meta.headings?.length) {
            await server.callToolJson("atomic_append", {
              path: target,
              heading: meta.headings[0],
              content: `- soak turn ${turn}`,
              expected_mtime: meta.mtime_ms,
            });
          }
        }
      }

      console.log(
        `SOAK search latency p50=${percentile(latencies, 0.5).toFixed(1)}ms p95=${percentile(latencies, 0.95).toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms`,
      );

      // Notes touched by writes legitimately change; everything else must not.
      const touched = new Set(notePaths);
      let drifted = 0;
      for (const q of queries) {
        const now = await server.callToolRaw("search_vault", { query: q, limit: 10 });
        if (now === baseline.get(q)) continue;
        const before = JSON.parse(baseline.get(q)!).results.map((r: { path: string }) => r.path);
        const after = JSON.parse(now).results.map((r: { path: string }) => r.path);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          const explained = after.every((p: string, i: number) => p === before[i] || touched.has(p));
          if (!explained) {
            drifted++;
            console.log(`SOAK DRIFT "${q}"\n  before=${before.slice(0, 5).join(",")}\n  after =${after.slice(0, 5).join(",")}`);
          }
        }
      }
      console.log(`SOAK drifted=${drifted}/${queries.length}`);
      expect(drifted).toBe(0);
    },
    RUN_TIMEOUT,
  );
});

describe("soak — ordering and chaining hold at scale", () => {
  it("keeps a smaller limit a prefix of a larger one for every sampled query", async () => {
    let violations = 0;
    for (const q of queries) {
      const narrow = (await server.callToolJson("search_vault", { query: q, limit: 3 })).results.map(
        (r: { path: string }) => r.path,
      );
      const wide = (await server.callToolJson("search_vault", { query: q, limit: 20 })).results.map(
        (r: { path: string }) => r.path,
      );
      if (JSON.stringify(wide.slice(0, narrow.length)) !== JSON.stringify(narrow)) {
        violations++;
        console.log(`SOAK PREFIX-VIOLATION "${q}"`);
      }
    }
    console.log(`SOAK prefix_violations=${violations}/${queries.length}`);
    expect(violations).toBe(0);
  }, RUN_TIMEOUT);

  it("returns refs that are all readable, across every sampled query", async () => {
    let broken = 0;
    let checked = 0;
    for (const q of queries) {
      const res = await server.callToolJson("search_vault", { query: q, limit: 5 });
      for (const hit of res.results) {
        checked++;
        const meta = await server.callToolJson("get_note_metadata", { path: hit.path });
        if (meta.error) {
          broken++;
          console.log(`SOAK BROKEN-REF ${hit.path} (${meta.error_code})`);
        }
      }
    }
    console.log(`SOAK refs_checked=${checked} broken=${broken}`);
    expect(broken).toBe(0);
  }, RUN_TIMEOUT);

  it("agrees between serial and parallel invocation", async () => {
    const sample = queries.slice(0, 8);
    const serial: string[] = [];
    for (const q of sample) {
      serial.push(await server.callToolRaw("search_vault", { query: q, limit: 10 }));
    }
    const parallel = await Promise.all(
      sample.map((q) => server.callToolRaw("search_vault", { query: q, limit: 10 })),
    );
    expect(parallel).toEqual(serial);
  }, RUN_TIMEOUT);
});
