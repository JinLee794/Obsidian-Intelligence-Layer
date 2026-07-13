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
import { registerCoreTools } from "./tools/core.js";
import { registerRetrieveTools } from "./tools/retrieve.js";
import { registerWriteTools } from "./tools/write.js";
import { registerDomainTools } from "./tools/domain.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { resolveVaultPath } from "./vault-path.js";

async function main(): Promise<void> {
  // ── Resolve vault path ─────────────────────────────────────────────────
  const resolvedVault = await resolveVaultPath({
    envPath: process.env.OBSIDIAN_VAULT_PATH,
    profileName: process.env.OIL_VAULT_PROFILE,
  });
  const vaultPath = resolvedVault.path;

  console.error(`[OIL] Starting — vault: ${vaultPath} (${resolvedVault.source})`);
  for (const warning of resolvedVault.warnings) console.error(`[OIL] Vault warning: ${warning}`);

  // ── 1. Load configuration ──────────────────────────────────────────────
  console.error("[OIL] Loading configuration...");
  const config = await loadConfig(vaultPath);
  console.error("[OIL] Configuration loaded.");

  // ── 2. Build graph index (with persistence + background indexing) ─────
  const graph = new GraphIndex(vaultPath, config);
  const graphFile = config.search.graphIndexFile;
  console.error("[OIL] Reconciling catalog snapshot...");
  const startTime = Date.now();
  let changed: number | null = null;
  try {
    changed = await graph.buildIncremental(graphFile);
  } catch (error) {
    if (graph.nodeCount === 0) throw error;
    console.error(
      "[OIL] Catalog reconciliation failed; serving the persisted generation as stale:",
      error,
    );
  }
  const elapsed = Date.now() - startTime;
  const stats = graph.getStats();
  console.error(
    `[OIL] Catalog ${graph.indexState} in ${elapsed}ms — ${stats.noteCount} notes, ${stats.linkCount} links, ${changed ?? "unknown"} source change(s).`,
  );

  // ── 3. Initialise session cache ────────────────────────────────────────
  const cache = new SessionCache();

  // ── 4. Start file watcher ──────────────────────────────────────────────
  const watcher = new VaultWatcher(vaultPath, graph, cache);
  watcher.start();
  await watcher.waitUntilReady();
  console.error("[OIL] File watcher started.");

  // ── 5. Create MCP server and register tools ────────────────────────────
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Core visibility tool
  registerCoreTools(server, vaultPath, graph, cache, watcher, config);

  // Optimized retrieve/search tools
  registerRetrieveTools(server, vaultPath, graph, cache, config);

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
