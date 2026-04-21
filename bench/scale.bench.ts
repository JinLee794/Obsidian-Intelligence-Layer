/**
 * Performance benchmarks — measures OIL latency at realistic vault sizes.
 *
 * Uses Vitest bench() for structured output with ops/sec, margin of error,
 * and baseline comparison via `vitest bench --compare`.
 *
 * Run:
 *   npx vitest bench bench/scale.bench.ts
 *   npx vitest bench bench/scale.bench.ts --outputJson bench/baseline.json
 *   npx vitest bench bench/scale.bench.ts --compare bench/baseline.json
 *
 *   BENCH_NOTE_COUNT=2000 npx vitest bench bench/scale.bench.ts
 *   OBSIDIAN_VAULT_PATH=~/my-vault npx vitest bench bench/scale.bench.ts
 */

import { describe, bench, beforeAll, afterAll, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { GraphIndex } from "../src/graph.js";
import { SessionCache } from "../src/cache.js";
import { VaultWatcher } from "../src/watcher.js";
import { registerCoreTools } from "../src/tools/core.js";
import { registerRetrieveTools } from "../src/tools/retrieve.js";
import { registerWriteTools } from "../src/tools/write.js";
import { registerDomainTools } from "../src/tools/domain.js";
import {
  searchVault,
  lexicalSearch,
  fuzzySearch,
  invalidateSearchIndex,
} from "../src/search.js";
import type { OilConfig } from "../src/types.js";
import { generateVault } from "./fixtures/generate-vault.js";

// ── Mock MCP server for tool-layer benchmarks ────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
}>;

class MockMcpServer {
  tools = new Map<string, { config: any; handler: ToolHandler }>();
  registerTool(name: string, config: any, handler: ToolHandler): void {
    this.tools.set(name, { config, handler });
  }
  async callTool(name: string, args: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.handler(args);
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const REAL_VAULT = process.env.OBSIDIAN_VAULT_PATH ?? "";
const USE_REAL = REAL_VAULT && existsSync(REAL_VAULT);
const NOTE_COUNT = parseInt(process.env.BENCH_NOTE_COUNT ?? "500", 10);

let vaultPath: string;
let tempDir: string | null = null;
let config: OilConfig;
let graph: GraphIndex;
let server: MockMcpServer;

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  if (USE_REAL) {
    vaultPath = REAL_VAULT;
  } else {
    tempDir = await mkdtemp(`${tmpdir()}/oil-scale-bench-`);
    vaultPath = `${tempDir}/vault`;
    await generateVault({ noteCount: NOTE_COUNT, outputDir: vaultPath });
  }

  config = await loadConfig(vaultPath);
  graph = new GraphIndex(vaultPath);
  await graph.build();

  // Register tool layer for end-to-end benchmarks
  server = new MockMcpServer();
  const cache = new SessionCache();
  const watcher = new VaultWatcher(vaultPath, graph, cache);
  registerCoreTools(server as any, vaultPath, graph, cache, watcher, config);
  registerRetrieveTools(server as any, vaultPath, graph, cache, config);
  registerWriteTools(server as any, vaultPath, graph, cache, config);
  registerDomainTools(server as any, vaultPath, graph, cache, config);
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── 1. Cold start ───────────────────────────────────────────────────────────

describe("Cold start", () => {
  bench("graph build", async () => {
    const fresh = new GraphIndex(vaultPath);
    await fresh.build();
  });

  bench("fuse.js index build", () => {
    invalidateSearchIndex();
    fuzzySearch(graph, "warmup", 1);
  });
});

// ── 2. Search tiers ─────────────────────────────────────────────────────────

describe("Lexical search", () => {
  bench("lexical: migration", () => { lexicalSearch(graph, "migration", 10); });
  bench("lexical: risk", () => { lexicalSearch(graph, "risk", 10); });
  bench("lexical: copilot", () => { lexicalSearch(graph, "copilot", 10); });
});

describe("Fuzzy search", () => {
  // Ensure index is warm before fuzzy benchmarks
  beforeAll(() => {
    invalidateSearchIndex();
    fuzzySearch(graph, "warmup", 1);
  });

  bench("fuzzy: migration", () => { fuzzySearch(graph, "migration", 10); });
  bench("fuzzy: risk", () => { fuzzySearch(graph, "risk", 10); });
  bench("fuzzy: copilot", () => { fuzzySearch(graph, "copilot", 10); });
});

describe("Cascade search (lexical→fuzzy)", () => {
  bench("cascade: migration", () => { searchVault(graph, config, "migration", undefined, 10); });
  bench("cascade: risk", () => { searchVault(graph, config, "risk", undefined, 10); });
  bench("cascade: copilot", () => { searchVault(graph, config, "copilot", undefined, 10); });
});

// ── 3. Graph operations ─────────────────────────────────────────────────────

describe("Graph operations", () => {
  let samplePath: string;

  beforeAll(() => {
    // Pick a note from the customer folder (likely to have links)
    const customers = graph.getNotesByFolder("Customers/");
    samplePath = customers.length > 0 ? customers[0].path : "Customers/Contoso.md";
  });

  bench("backlinks lookup", () => {
    graph.getBacklinks(samplePath);
  });

  bench("2-hop neighborhood", () => {
    graph.getRelatedNotes(samplePath, 2);
  });
});

// ── 4. Tool layer (end-to-end through MCP tool interface) ───────────────────

describe("Tool layer (end-to-end)", () => {
  bench("get_health", async () => {
    await server.callTool("get_health", {});
  });

  bench("search_vault: migration", async () => {
    await server.callTool("search_vault", { query: "migration", limit: 10 });
  });

  bench("semantic_search: risk", async () => {
    await server.callTool("semantic_search", { query: "risk", limit: 5 });
  });

  bench("get_note_metadata", async () => {
    const customers = graph.getNotesByFolder("Customers/");
    const path = customers.length > 0 ? customers[0].path : "Customers/Contoso.md";
    await server.callTool("get_note_metadata", { path });
  });

  bench("get_customer_context (brief)", async () => {
    await server.callTool("get_customer_context", { customer: "Contoso", view: "brief" });
  });

  bench("get_customer_context (full)", async () => {
    await server.callTool("get_customer_context", { customer: "Contoso", view: "full" });
  });
});

// ── 5. Write operations ─────────────────────────────────────────────────────

describe("Write operations", () => {
  let writePath: string;

  beforeAll(() => {
    const customers = graph.getNotesByFolder("Customers/");
    writePath = customers.length > 0 ? customers[0].path : "Customers/Contoso.md";
  });

  bench("atomic_append (metadata + write)", async () => {
    const meta = await server.callTool("get_note_metadata", { path: writePath });
    const parsed = JSON.parse(meta.content[0].text);
    await server.callTool("atomic_append", {
      path: writePath,
      heading: "Agent Insights",
      content: "- bench write test",
      expected_mtime: parsed.mtime_ms,
    });
  });

  bench("atomic_replace (metadata + write)", async () => {
    const meta = await server.callTool("get_note_metadata", { path: writePath });
    const parsed = JSON.parse(meta.content[0].text);
    await server.callTool("atomic_replace", {
      path: writePath,
      heading: "Agent Insights",
      old_text: "- bench write test",
      new_text: "- bench write replaced",
      expected_mtime: parsed.mtime_ms,
    });
  });
});

// ── 6. Composite / domain tools ─────────────────────────────────────────────

describe("Composite tools", () => {
  bench("prepare_crm_prefetch", async () => {
    await server.callTool("prepare_crm_prefetch", { customers: ["Contoso"] });
  });

  bench("check_vault_health", async () => {
    await server.callTool("check_vault_health", { customer: "Contoso" });
  });
});

// ── 7. Scaling profile — graph and search at different vault sizes ───────────

describe("Scaling profile", () => {
  bench("graph.getNotesByFolder", () => {
    graph.getNotesByFolder("Customers/");
  });

  bench("graph.getAllNodes iteration", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _node of graph.getAllNodes()) { /* iterate */ }
  });
});
