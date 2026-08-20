import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { VaultWatcher } from "../watcher.js";
import type { OilConfig } from "../types.js";
import { getSemanticIndex } from "../semantic.js";
import type { Hydration } from "../hydration.js";
import { jsonResponse } from "../tool-responses.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export function registerCoreTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  cache: SessionCache,
  watcher: VaultWatcher,
  config: OilConfig,
  hydration?: Hydration,
): void {
  server.registerTool(
    "get_health",
    {
      description:
        "Summary-level runtime visibility for OIL. Returns server identity, startup state, index freshness, cache stats, watcher status, and audit availability without loading full logs.",
      inputSchema: {},
    },
    async () => {
      const audit = await getAuditSummary(vaultPath, config);
      const graphStats = graph.getStats();

      return jsonResponse({
        server: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          runtime_profile: "current-client-optimized",
        },
        // Never gated: this is how a caller learns why the other tools are
        // waiting, so it has to answer while the vault is still warming.
        startup: hydration?.snapshot ?? {
          phase: "ready",
          attempts: 0,
          reason: null,
          duration_ms: null,
        },
        index: {
          note_count: graphStats.noteCount,
          link_count: graphStats.linkCount,
          tag_count: graphStats.tagCount,
          last_indexed: graph.lastIndexed.toISOString(),
          building: graph.building,
        },
        semantic: getSemanticIndex(graph)?.stats ?? {
          status: "disabled",
          model: config.semantic.model,
          note_count: 0,
          dimensions: 0,
          reason: "Semantic tier not attached",
        },
        cache: cache.getStats(),
        watcher: watcher.getStatus(),
        audit,
        config: {
          meetings_root: config.schema.meetingsRoot,
          customers_root: config.schema.customersRoot,
          agent_log: config.schema.agentLog,
        },
      });
    },
  );
}

async function getAuditSummary(vaultPath: string, config: OilConfig): Promise<{
  enabled: boolean;
  path: string;
  last_log_date: string | null;
  last_write_at: string | null;
}> {
  const logDir = join(vaultPath, config.schema.agentLog);

  try {
    const entries = await readdir(logDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    if (candidates.length === 0) {
      return {
        enabled: config.audit.logAllWrites,
        path: config.schema.agentLog,
        last_log_date: null,
        last_write_at: null,
      };
    }

    const latest = candidates[candidates.length - 1];
    const latestPath = join(logDir, latest);
    const fileStats = await stat(latestPath);

    return {
      enabled: config.audit.logAllWrites,
      path: config.schema.agentLog,
      last_log_date: latest.replace(/\.md$/, ""),
      last_write_at: fileStats.mtime.toISOString(),
    };
  } catch {
    return {
      enabled: config.audit.logAllWrites,
      path: config.schema.agentLog,
      last_log_date: null,
      last_write_at: null,
    };
  }
}