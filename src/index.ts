/**
 * OIL — MCP Server
 * Obsidian Intelligence Layer server entry point.
 * Startup sequence: config → graph index → file watcher → session cache → tools → ready.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { GraphIndex } from "./graph.js";
import { SessionCache } from "./cache.js";
import { VaultWatcher } from "./watcher.js";
import { registerRetrieveTools } from "./tools/retrieve.js";
import { registerWriteTools } from "./tools/write.js";
import { registerDomainTools } from "./tools/domain.js";
import { EmbeddingIndex } from "./embeddings.js";

const SERVER_NAME = "obsidian-intelligence-layer";
const SERVER_VERSION = "0.5.1";

async function main(): Promise<void> {
  // ── Resolve vault path ─────────────────────────────────────────────────
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error(
      "Error: OBSIDIAN_VAULT_PATH environment variable is required.\n" +
        "Set it to the absolute path of your Obsidian vault.",
    );
    process.exit(1);
  }

  console.error(`[OIL] Starting — vault: ${vaultPath}`);

  // ── 1. Load configuration ──────────────────────────────────────────────
  console.error("[OIL] Loading configuration...");
  const config = await loadConfig(vaultPath);
  console.error("[OIL] Configuration loaded.");

  // ── 2. Build graph index (with persistence + background indexing) ─────
  const graph = new GraphIndex(vaultPath);
  const graphFile = config.search.graphIndexFile;
  const bgThreshold = config.search.backgroundIndexThresholdMs;

  const loaded = await graph.loadFromDisk(graphFile);
  if (loaded) {
    // Persisted index loaded — start incremental rebuild in background
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph loaded from disk — ${stats.noteCount} notes. Incremental update in background.`,
    );
    setImmediate(async () => {
      try {
        await graph.buildIncremental(graphFile);
      } catch (err) {
        console.error("[OIL] Background incremental rebuild failed:", err);
      }
    });
  } else {
    // No persisted index — full build, with background fallback if slow
    console.error("[OIL] No persisted graph index — full build...");
    const startTime = Date.now();
    await graph.build();
    const elapsed = Date.now() - startTime;
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph index built in ${elapsed}ms — ${stats.noteCount} notes, ${stats.linkCount} links, ${stats.tagCount} tags.`,
    );
    // Save to disk for next startup
    graph.saveToDisk(graphFile).catch((err) =>
      console.error("[OIL] Failed to save graph index:", err),
    );
  }

  // ── 3. Initialise session cache ────────────────────────────────────────
  const cache = new SessionCache();

  // ── 3b. Create embedding index (lazy — loads on first semantic query) ───
  const embeddings = new EmbeddingIndex(
    vaultPath,
    config.search.semanticIndexFile,
    graph,
  );

  // ── 4. Start file watcher ──────────────────────────────────────────────
  const watcher = new VaultWatcher(vaultPath, graph, cache, embeddings);
  watcher.start();
  console.error("[OIL] File watcher started.");

  // ── 5. Create MCP server and register tools ────────────────────────────
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Optimized retrieve/search tools
  registerRetrieveTools(server, vaultPath, graph, cache, config, embeddings);

  // Atomic write tools with mtime concurrency checks
  registerWriteTools(server, vaultPath, graph, cache, config);

  // High-value domain tools (deterministic assembly, CRM prefetch, health)
  registerDomainTools(server, vaultPath, graph, cache, config);

  console.error("[OIL] Tools registered.");

  // ── 6. Connect transport ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[OIL] MCP server ready.");

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async () => {
    console.error("[OIL] Shutting down...");
    await watcher.stop();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[OIL] Fatal error:", err);
  process.exit(1);
});
