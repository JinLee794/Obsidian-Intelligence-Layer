/**
 * Shared test harness — single MockMcpServer + vault setup used by all test files.
 *
 * Eliminates duplicated mock server classes and inconsistent registration paths.
 * Mirrors the production registration in src/index.ts (core + retrieve + write + domain).
 */

import { resolve } from "node:path";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { VaultWatcher } from "../watcher.js";
import { loadConfig } from "../config.js";
import { registerCoreTools } from "../tools/core.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { registerWriteTools } from "../tools/write.js";
import { registerDomainTools } from "../tools/domain.js";
import type { OilConfig } from "../types.js";

// ── Fixture vault path ────────────────────────────────────────────────────────

export const FIXTURE_VAULT = resolve(
  import.meta.dirname,
  "../../bench/fixtures/vault",
);

// ── Mock MCP Server ───────────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
}>;

export class MockMcpServer {
  tools = new Map<string, { config: any; handler: ToolHandler }>();

  registerTool(name: string, config: any, handler: ToolHandler): void {
    this.tools.set(name, { config, handler });
  }

  /** Call a tool and return the raw text of the first content block. */
  async callToolRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const result = await tool.handler(args);
    return result.content[0].text;
  }

  /** Call a tool and JSON-parse the first content block. */
  async callToolJson(name: string, args: Record<string, unknown>) {
    return JSON.parse(await this.callToolRaw(name, args));
  }

  /** Sorted list of registered tool names. */
  get toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Total serialized chars of all tool schemas (name + config JSON). */
  totalSchemaChars(): number {
    let combined = "";
    for (const [name, { config }] of this.tools) {
      combined += JSON.stringify({ name, ...config }) + "\n";
    }
    return combined.length;
  }
}

// ── Setup helper ──────────────────────────────────────────────────────────────

export interface TestHarness {
  server: MockMcpServer;
  graph: GraphIndex;
  config: OilConfig;
  cache: SessionCache;
  watcher: VaultWatcher;
}

/**
 * Build and register all production tools against a vault path.
 * Returns the full set of objects tests may need.
 */
export async function setupHarness(
  vaultPath: string = FIXTURE_VAULT,
): Promise<TestHarness> {
  const config = await loadConfig(vaultPath);
  const graph = new GraphIndex(vaultPath);
  await graph.build();
  const cache = new SessionCache();
  const server = new MockMcpServer();
  const watcher = new VaultWatcher(vaultPath, graph, cache);

  registerCoreTools(server as any, vaultPath, graph, cache, watcher, config);
  registerRetrieveTools(server as any, vaultPath, graph, cache, config);
  registerWriteTools(server as any, vaultPath, graph, cache, config);
  registerDomainTools(server as any, vaultPath, graph, cache, config);

  return { server, graph, config, cache, watcher };
}
