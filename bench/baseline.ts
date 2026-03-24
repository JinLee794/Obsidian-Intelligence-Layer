/**
 * Baseline loader — dynamically imports a previous OIL build for comparison.
 *
 * Reads BENCH_BASELINE_DIR (set by scripts/bench-against.sh) and imports
 * the baseline's built modules. Uses a MockMcpServer to capture registered
 * tool schemas without running the full MCP server.
 *
 * Gracefully returns null/empty when modules are missing in older versions.
 */

import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { VAULT_PATH, estimateTokens, totalSchemaTokens } from "./harness.js";

// ── Env ──────────────────────────────────────────────────────────────────────

const BASELINE_DIR = process.env.BENCH_BASELINE_DIR ?? "";
const BASELINE_REF = process.env.BENCH_BASELINE_REF ?? "unknown";
const BASELINE_HASH = process.env.BENCH_BASELINE_HASH ?? "";

export function isBaselineAvailable(): boolean {
  return !!BASELINE_DIR && existsSync(resolve(BASELINE_DIR, "dist"));
}

export function getBaselineLabel(): string {
  return BASELINE_REF + (BASELINE_HASH ? ` (${BASELINE_HASH})` : "");
}

// ── Mock MCP server for schema capture ───────────────────────────────────────

type ToolHandler = (...args: unknown[]) => unknown;

interface CapturedTool {
  name: string;
  description: string;
  inputKeys: string[];
  raw: string;
}

class MockMcpServer {
  captured = new Map<string, CapturedTool>();

  registerTool(name: string, config: Record<string, unknown>, _handler: ToolHandler): void {
    const desc = (config.description as string) ?? "";
    const schema = config.inputSchema ?? {};
    const inputKeys = typeof schema === "object" && schema !== null ? Object.keys(schema) : [];
    const raw = JSON.stringify({ name, description: desc, inputSchema: inputKeys });
    this.captured.set(name, { name, description: desc, inputKeys, raw });
  }

  /** Schema strings keyed by tool name — compatible with harness totalSchemaTokens(). */
  toSchemaRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, tool] of this.captured) {
      out[name] = tool.raw;
    }
    return out;
  }
}

// ── Dynamic import helper ────────────────────────────────────────────────────

async function tryImport(absolutePath: string): Promise<unknown | null> {
  if (!existsSync(absolutePath)) return null;
  try {
    return await import(pathToFileURL(absolutePath).href);
  } catch {
    return null;
  }
}

// ── Snapshot types ───────────────────────────────────────────────────────────

export interface VersionSnapshot {
  label: string;
  toolSchemas: Record<string, string>;
  toolCount: number;
  schemaTokens: number;
  toolNames: string[];
  modules: {
    config: Record<string, unknown> | null;
    graph: Record<string, unknown> | null;
    vault: Record<string, unknown> | null;
    search: Record<string, unknown> | null;
    cache: Record<string, unknown> | null;
    query: Record<string, unknown> | null;
  };
}

// ── Build snapshot for current version ───────────────────────────────────────

export async function buildCurrentSnapshot(): Promise<VersionSnapshot> {
  // Import live source modules (already in the test process)
  const config = await import("../src/config.js");
  const graph = await import("../src/graph.js");
  const vault = await import("../src/vault.js");
  const search = await import("../src/search.js");
  const cache = await import("../src/cache.js");

  // Capture tool schemas via MockMcpServer
  const mock = new MockMcpServer();
  const toolModules = [
    await tryImport(resolve(import.meta.dirname, "../dist/tools/retrieve.js")),
    await tryImport(resolve(import.meta.dirname, "../dist/tools/write.js")),
    await tryImport(resolve(import.meta.dirname, "../dist/tools/domain.js")),
    await tryImport(resolve(import.meta.dirname, "../dist/tools/composite.js")),
    await tryImport(resolve(import.meta.dirname, "../dist/tools/orient.js")),
    await tryImport(resolve(import.meta.dirname, "../dist/tools.js")),
  ];

  const cfg = await config.loadConfig(VAULT_PATH);
  const g = new graph.GraphIndex(VAULT_PATH);
  await g.build();
  const c = new cache.SessionCache();

  for (const mod of toolModules) {
    if (!mod || typeof mod !== "object") continue;
    for (const [key, fn] of Object.entries(mod as Record<string, unknown>)) {
      if (typeof fn === "function" && key.startsWith("register")) {
        try {
          // Registration functions have varying arities — pass all possible args
          (fn as Function)(mock, VAULT_PATH, g, c, cfg, null);
        } catch {
          // Some register functions may need different arguments — skip
        }
      }
    }
  }

  const schemas = mock.toSchemaRecord();
  return {
    label: `current (${process.env.npm_package_version ?? "working tree"})`,
    toolSchemas: schemas,
    toolCount: Object.keys(schemas).length,
    schemaTokens: totalSchemaTokens(schemas),
    toolNames: Object.keys(schemas).sort(),
    modules: { config, graph, vault, search, cache, query: null },
  };
}

// ── Build snapshot for baseline version ──────────────────────────────────────

export async function buildBaselineSnapshot(): Promise<VersionSnapshot | null> {
  if (!isBaselineAvailable()) return null;
  const dist = resolve(BASELINE_DIR, "dist");

  // Import baseline modules
  const config = await tryImport(join(dist, "config.js"));
  const graph = await tryImport(join(dist, "graph.js"));
  const vault = await tryImport(join(dist, "vault.js"));
  const search = await tryImport(join(dist, "search.js"));
  const cache = await tryImport(join(dist, "cache.js"));
  const query = await tryImport(join(dist, "query.js"));

  // Try all known tool module paths
  const toolPaths = [
    join(dist, "tools/retrieve.js"),
    join(dist, "tools/write.js"),
    join(dist, "tools/domain.js"),
    join(dist, "tools/composite.js"),
    join(dist, "tools/orient.js"),
    join(dist, "tools.js"),      // older single-file layout
  ];

  const toolModules = await Promise.all(toolPaths.map(tryImport));

  // Build baseline instances for tool registration
  const mock = new MockMcpServer();
  let cfg: unknown = null;
  let g: unknown = null;
  let c: unknown = null;

  try {
    if (config && typeof (config as any).loadConfig === "function") {
      cfg = await (config as any).loadConfig(VAULT_PATH);
    } else if (config && typeof (config as any).DEFAULT_CONFIG === "object") {
      cfg = (config as any).DEFAULT_CONFIG;
    }
  } catch { /* baseline may not support current vault */ }

  try {
    if (graph && typeof (graph as any).GraphIndex === "function") {
      g = new (graph as any).GraphIndex(VAULT_PATH);
      if (typeof (g as any).build === "function") await (g as any).build();
    }
  } catch { /* graph init may fail on old versions */ }

  try {
    if (cache && typeof (cache as any).SessionCache === "function") {
      c = new (cache as any).SessionCache();
    }
  } catch { /* no-op */ }

  // Register tools from each module
  for (const mod of toolModules) {
    if (!mod || typeof mod !== "object") continue;
    for (const [key, fn] of Object.entries(mod as Record<string, unknown>)) {
      if (typeof fn === "function" && key.startsWith("register")) {
        try {
          (fn as Function)(mock, VAULT_PATH, g, c, cfg, null);
        } catch {
          // Different signature — try fewer args
          try { (fn as Function)(mock, VAULT_PATH, g, c, cfg); }
          catch {
            try { (fn as Function)(mock, VAULT_PATH, g, c); }
            catch { /* give up on this register function */ }
          }
        }
      }
    }
  }

  const schemas = mock.toSchemaRecord();
  return {
    label: getBaselineLabel(),
    toolSchemas: schemas,
    toolCount: Object.keys(schemas).length,
    schemaTokens: totalSchemaTokens(schemas),
    toolNames: Object.keys(schemas).sort(),
    modules: {
      config: config as any,
      graph: graph as any,
      vault: vault as any,
      search: search as any,
      cache: cache as any,
      query: query as any,
    },
  };
}
