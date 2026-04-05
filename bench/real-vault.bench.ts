/**
 * Real-vault benchmark — runs against the actual Obsidian vault.
 * Measures latency at true scale (1,696+ notes).
 *
 * Set OBSIDIAN_VAULT_PATH env var or uses default ~/Documents/Obsidian/Jin @ Microsoft/
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { GraphIndex } from "../src/graph.js";
import {
  searchVault,
  lexicalSearch,
  fuzzySearch,
  invalidateSearchIndex,
} from "../src/search.js";
import { readNote } from "../src/vault.js";
import type { OilConfig } from "../src/types.js";

const VAULT = process.env.OBSIDIAN_VAULT_PATH
  ?? resolve(process.env.HOME ?? "", "Documents/Obsidian/Jin @ Microsoft");

const ITERATIONS = 20;

function timedSync<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

function avgSync<T>(fn: () => T, runs: number): { avgMs: number; result: T } {
  // warm
  fn();
  let total = 0;
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const { result: r, ms } = timedSync(fn);
    total += ms;
    result = r;
  }
  return { avgMs: total / runs, result };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let config: OilConfig;
let graph: GraphIndex;
let sampleNote: string;
let sampleCustomer: string;

beforeAll(async () => {
  config = await loadConfig(VAULT);
  graph = new GraphIndex(VAULT);
  await graph.build();

  const stats = graph.getStats();
  console.log(`\n  Vault: ${VAULT}`);
  console.log(`  Notes: ${stats.noteCount}, Links: ${stats.linkCount}, Tags: ${stats.tagCount}`);

  // Pick a real note and customer for queries
  const allRefs = graph.getNotesByFolder("");
  sampleNote = allRefs[0]?.path ?? "";
  const customerRef = allRefs.find((r) => r.path.startsWith("Customers/"));
  sampleCustomer = customerRef?.title ?? allRefs[0]?.title ?? "test";
  console.log(`  Sample note: ${sampleNote}`);
  console.log(`  Sample customer: ${sampleCustomer}\n`);
});

// ─── 1. Cold start ───────────────────────────────────────────────────────────

describe("Real vault — Cold start", () => {
  it("graph build from scratch", async () => {
    const fresh = new GraphIndex(VAULT);
    const { ms } = await timedAsync(() => fresh.build());
    const stats = fresh.getStats();

    console.log(`  Graph build: ${ms.toFixed(1)}ms (${stats.noteCount} notes, ${stats.linkCount} links)`);
    expect(stats.noteCount).toBeGreaterThan(100);
  });
});

// ─── 2. Search tier latency ──────────────────────────────────────────────────

describe("Real vault — Search tier latency", () => {
  const queries = ["migration", "risk", "PriorAuth", "copilot", "escalation"];

  it("lexical search (avg of 20)", () => {
    console.log(`\n  Lexical search (avg of ${ITERATIONS}):`);
    for (const q of queries) {
      const { avgMs, result } = avgSync(
        () => lexicalSearch(graph, q, 10),
        ITERATIONS,
      );
      console.log(`    "${q}": ${avgMs.toFixed(3)}ms → ${result.length} results`);
    }
  });

  it("fuzzy search (avg of 20)", () => {
    invalidateSearchIndex();
    // warm the fuse index
    fuzzySearch(graph, "warmup", 1);

    console.log(`\n  Fuzzy search (avg of ${ITERATIONS}):`);
    for (const q of queries) {
      const { avgMs, result } = avgSync(
        () => fuzzySearch(graph, q, 10),
        ITERATIONS,
      );
      console.log(`    "${q}": ${avgMs.toFixed(3)}ms → ${result.length} results`);
    }
  });

  it("cascade search — searchVault default (avg of 20)", () => {
    console.log(`\n  Cascade (lexical→fuzzy) via searchVault (avg of ${ITERATIONS}):`);
    for (const q of queries) {
      const { avgMs, result } = avgSync(
        () => searchVault(graph, config, q, undefined, 10),
        ITERATIONS,
      );
      const types = [...new Set(result.map((r) => r.matchType))].join("+");
      console.log(`    "${q}": ${avgMs.toFixed(3)}ms → ${result.length} results [${types}]`);
    }
  });
});

// ─── 3. Fuse index build time ────────────────────────────────────────────────

describe("Real vault — Fuse.js index build", () => {
  it("cold fuse index build", () => {
    invalidateSearchIndex();
    const { ms } = timedSync(() => fuzzySearch(graph, "warmup", 1));
    console.log(`\n  Fuse.js index build (cold): ${ms.toFixed(1)}ms`);
  });
});

// ─── 4. In-memory content search vs simulated disk read ──────────────────────

describe("Real vault — Content search: in-memory vs disk", () => {
  it("in-memory bodySnippet scan", () => {
    // Reproduce what contentSearch does now — scan bodySnippet from graph
    const refs = graph.getNotesByFolder("");
    const query = "migration";
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);

    const { ms } = timedSync(() => {
      let hits = 0;
      for (const ref of refs) {
        const node = graph.getNode(ref.path);
        if (!node?.bodySnippet) continue;
        const lower = node.bodySnippet.toLowerCase();
        if (terms.some((t) => lower.includes(t))) hits++;
      }
      return hits;
    });

    console.log(`\n  In-memory bodySnippet scan (${refs.length} notes): ${ms.toFixed(3)}ms`);
  });

  it("disk-read scan (readNote per file) — first 100 notes only", async () => {
    // Sample the first 100 notes to estimate full-vault disk cost
    const refs = graph.getNotesByFolder("").slice(0, 100);
    const query = "migration";
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);

    const start = performance.now();
    let hits = 0;
    for (const ref of refs) {
      try {
        const note = await readNote(VAULT, ref.path);
        const lower = note.content.toLowerCase();
        if (terms.some((t) => lower.includes(t))) hits++;
      } catch { /* skip */ }
    }
    const ms = performance.now() - start;
    const totalNotes = graph.getStats().noteCount;
    const projected = (ms / 100) * totalNotes;

    console.log(`  Disk-read scan (${refs.length} of ${totalNotes} notes): ${ms.toFixed(1)}ms`);
    console.log(`  Projected full-vault disk scan: ~${projected.toFixed(0)}ms`);
    console.log(`  Speedup from in-memory: ~${(projected / 5).toFixed(0)}x (assuming ~5ms in-memory)`);
  });
});

// ─── 5. Graph operations ─────────────────────────────────────────────────────

describe("Real vault — Graph operations", () => {
  it("backlinks lookup", () => {
    const { avgMs, result } = avgSync(
      () => graph.getBacklinks(sampleNote),
      ITERATIONS,
    );
    console.log(`\n  Backlinks for "${sampleNote}": ${avgMs.toFixed(4)}ms (${result.length} backlinks)`);
  });

  it("2-hop neighborhood", () => {
    const { avgMs, result } = avgSync(
      () => graph.getRelatedNotes(sampleNote, 2),
      ITERATIONS,
    );
    console.log(`  2-hop neighborhood: ${avgMs.toFixed(4)}ms (${result.length} related notes)`);
  });
});

// ─── 6. Frontmatter index build ──────────────────────────────────────────────

describe("Real vault — Frontmatter index build", () => {
  it("full rebuild", () => {
    const refs = graph.getNotesByFolder("");
    const { ms } = timedSync(() => {
      const index = new Map<string, Array<{ path: string; value: string }>>();
      for (const ref of refs) {
        const node = graph.getNode(ref.path);
        if (!node) continue;
        for (const [rawKey, rawValue] of Object.entries(node.frontmatter)) {
          const key = rawKey.toLowerCase();
          const values = typeof rawValue === "string" ? [rawValue.toLowerCase()]
            : Array.isArray(rawValue) ? rawValue.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())
            : [];
          if (values.length === 0) continue;
          const bucket = index.get(key) ?? [];
          for (const v of values) bucket.push({ path: node.path, value: v });
          index.set(key, bucket);
        }
      }
      return index;
    });

    console.log(`\n  Frontmatter index rebuild: ${ms.toFixed(1)}ms (${refs.length} notes)`);
  });
});
