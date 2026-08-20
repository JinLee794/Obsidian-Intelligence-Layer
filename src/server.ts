/**
 * OIL — Server assembly
 *
 * Separated from the process entry point so the startup contract can be tested
 * over an in-memory transport, without spawning a process or a real client.
 *
 * The ordering here is the contract: everything the MCP handshake needs is
 * cheap and bounded, and everything that touches the vault at scale runs behind
 * the hydration gate. `createOilServer` returns as soon as the tool surface
 * exists, so the caller can connect a transport immediately.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stat } from "node:fs/promises";
import { loadConfig, DEFAULT_CONFIG, applyEnvOverrides } from "./config.js";
import { GraphIndex } from "./graph.js";
import { SessionCache } from "./cache.js";
import { VaultWatcher } from "./watcher.js";
import { SemanticIndex, attachSemanticIndex } from "./semantic.js";
import { setExcludedFolders } from "./search.js";
import { Hydration, type HydrationOptions } from "./hydration.js";
import { registerCoreTools } from "./tools/core.js";
import { registerRetrieveTools } from "./tools/retrieve.js";
import { registerWriteTools } from "./tools/write.js";
import { registerDomainTools } from "./tools/domain.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { OilConfig } from "./types.js";

/**
 * Tools that must answer while the vault is still warming.
 *
 * `get_health` is how a caller — human or agent — finds out *why* the other
 * tools are waiting. Gating it behind the same promise would make the one
 * diagnostic that matters unavailable exactly when it is needed.
 */
const UNGATED_TOOLS = new Set(["get_health"]);

/** Ceiling on the one vault read that happens before the handshake. */
const CONFIG_READ_DEADLINE_MS = 3_000;

export interface OilServer {
  server: McpServer;
  hydration: Hydration;
  config: OilConfig;
  graph: GraphIndex;
  cache: SessionCache;
  watcher: VaultWatcher;
  semantic: SemanticIndex;
  shutdown: () => Promise<void>;
}

export interface CreateOilServerOptions {
  /** Overrides for the hydration gate — tests use this to shorten backoff. */
  hydration?: HydrationOptions;
  /** Skip the background watcher. Tests that assert on hydration alone use this. */
  watch?: boolean;
}

export async function createOilServer(
  vaultPath: string,
  options: CreateOilServerOptions = {},
): Promise<OilServer> {
  // ── Configuration ───────────────────────────────────────────────────────
  // One small read of the vault root, bounded: a hung network mount must not
  // be able to hold the handshake open, and defaults are always serviceable.
  const config = await withDeadline(
    loadConfig(vaultPath),
    CONFIG_READ_DEADLINE_MS,
    () => {
      console.error(
        `[OIL] Config read exceeded ${CONFIG_READ_DEADLINE_MS}ms — starting on defaults.`,
      );
      return applyEnvOverrides({ ...DEFAULT_CONFIG });
    },
  );
  setExcludedFolders(config.search.excludeFolders);
  if (config.search.excludeFolders.length > 0) {
    console.error(`[OIL] Search excludes: ${config.search.excludeFolders.join(", ")}`);
  }

  // ── In-memory components (construction only — no vault I/O) ─────────────
  const graph = new GraphIndex(vaultPath);
  const cache = new SessionCache();
  const semantic = new SemanticIndex(vaultPath, config.semantic);
  attachSemanticIndex(graph, semantic);
  const watcher = new VaultWatcher(vaultPath, graph, cache);

  // ── Hydration: everything that scales with the vault ────────────────────
  const hydration = new Hydration(
    () => hydrate(vaultPath, config, graph, semantic, watcher, options.watch !== false),
    options.hydration,
  );

  // ── Tool surface ────────────────────────────────────────────────────────
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const gated = gateToolsOnHydration(server, hydration);

  registerCoreTools(gated, vaultPath, graph, cache, watcher, config, hydration);
  registerRetrieveTools(gated, vaultPath, graph, cache, config);
  registerWriteTools(gated, vaultPath, graph, cache, config);
  registerDomainTools(gated, vaultPath, graph, cache, config);

  return {
    server,
    hydration,
    config,
    graph,
    cache,
    watcher,
    semantic,
    shutdown: async () => {
      hydration.stop();
      await watcher.stop();
      // Indexing that is not persisted is indexing the next session repeats.
      // A session that ends mid-rebuild used to discard everything it had just
      // read, so a client whose sessions are shorter than a full re-index never
      // converged — it paid the same cost on every connect.
      await graph
        .flush(config.search.graphIndexFile)
        .then((saved) => {
          if (saved) console.error("[OIL] Index progress saved on shutdown.");
        })
        .catch((err) => console.error("[OIL] Could not save index on shutdown:", err));
      await server.close();
    },
  };
}

/**
 * Bring the vault online.
 *
 * Ordered so a failure is attributable: the preflight names a bad path before
 * a directory walk turns it into a bare ENOENT stack, and the watcher only
 * starts once there is a graph for it to invalidate.
 */
async function hydrate(
  vaultPath: string,
  config: OilConfig,
  graph: GraphIndex,
  semantic: SemanticIndex,
  watcher: VaultWatcher,
  watch: boolean,
): Promise<void> {
  await preflightVault(vaultPath);

  const graphFile = config.search.graphIndexFile;
  const loaded = await graph.loadFromDisk(graphFile);

  if (loaded) {
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph loaded from disk — ${stats.noteCount} notes. Incremental update in background.`,
    );
  } else {
    console.error("[OIL] No persisted graph index — full build...");
    const startTime = Date.now();
    await graph.build();
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph index built in ${Date.now() - startTime}ms — ${stats.noteCount} notes, ${stats.linkCount} links, ${stats.tagCount} tags.`,
    );
    // Persistence is a startup optimisation for the *next* run, never a reason
    // to fail this one — and never a reason to make callers wait for it either.
    deferred(() => graph.saveToDisk(graphFile), "Graph index save");
  }

  // Vectors come from the sidecar; embedding anything new is deferred so a cold
  // vault — or a model that still has to be pulled — never delays readiness.
  // Until it catches up, search runs on the lexical tiers.
  await semantic.load();
  if (config.semantic.enabled) {
    console.error(
      `[OIL] Semantic tier: ${semantic.stats.note_count} cached vector(s), model '${config.semantic.model}'. Refreshing in background.`,
    );
    deferred(() => semantic.refresh(graph), "Semantic refresh");
  }

  if (watch) {
    watcher.start();
    console.error("[OIL] File watcher started.");
    void watcher
      .whenReady()
      .then(() => console.error("[OIL] File watcher ready — vault changes are now observed."))
      .catch((err) => console.error("[OIL] File watcher never became ready:", err));
  }

  if (loaded) {
    // Revalidation is deferred past readiness — the loaded index already serves
    // — and past the watcher's own recursive scan. Both traverse the whole
    // vault, and running them together doubles the IO a session costs at
    // exactly the moment it is least idle. The watcher is *started* first
    // regardless, so a note changed during the walk is still observed.
    deferred(async () => {
      if (watch) await watcher.whenReady().catch(() => undefined);
      await graph.buildIncremental(graphFile);
    }, "Background incremental rebuild");
  }
}

/**
 * Fail a bad vault path by name.
 *
 * Without this the first symptom is `ENOENT: scandir` from deep inside the
 * directory walk — which reads as a crashed server rather than "that path is
 * not there yet", the common case for a cloud-synced or network vault on a
 * machine that just woke up.
 */
async function preflightVault(vaultPath: string): Promise<void> {
  let info;
  try {
    info = await stat(vaultPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `Vault path does not exist: ${vaultPath}. If it is on a synced or network drive it may not be mounted yet — OIL will keep retrying.`
        : `Vault path is unreadable (${code ?? "unknown error"}): ${vaultPath}`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vaultPath}`);
  }
}

/**
 * Wrap every registered tool so it waits for a usable vault.
 *
 * Done here rather than in each tool module so the guarantee cannot be
 * forgotten when a tool is added: registration is the only way onto the
 * surface, and everything that goes through it is gated by construction.
 */
function gateToolsOnHydration(server: McpServer, hydration: Hydration): McpServer {
  type RegisterTool = McpServer["registerTool"];
  const register = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => ReturnType<RegisterTool>;

  const proxy = Object.create(server) as McpServer;
  (proxy as unknown as { registerTool: unknown }).registerTool = (...args: unknown[]) => {
    const [name, config, handler] = args as [string, unknown, (...a: unknown[]) => unknown];
    if (UNGATED_TOOLS.has(name)) return register(name, config, handler);

    return register(name, config, async (...callArgs: unknown[]) => {
      await hydration.whenReady();
      return handler(...callArgs);
    });
  };
  return proxy;
}

/**
 * Run background work without letting its failure reach the process.
 *
 * A bare `void promise` here would be an unhandled rejection, and Node 20+
 * exits the process on those — turning a failed background refresh into a dead
 * MCP server.
 */
function deferred(task: () => Promise<unknown>, label: string): void {
  setImmediate(() => {
    void (async () => {
      try {
        await task();
      } catch (err) {
        console.error(`[OIL] ${label} failed:`, err);
      }
    })();
  });
}

async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
