import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { VaultWatcher } from "../watcher.js";
import { DEFAULT_CONFIG } from "../config.js";
import { registerCoreTools } from "../tools/core.js";
import { SERVER_VERSION } from "../version.js";
import { MockMcpServer } from "./harness.js";

let tempDir: string;
let vaultRoot: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-core-"));
  vaultRoot = join(tempDir, "vault");

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    "# Contoso\n",
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "_agent-log/2026-03-19.md"),
    "# Agent Log — 2026-03-19\n",
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("core tools — get_health", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    const watcher = new VaultWatcher(vaultRoot, graph, cache);
    registerCoreTools(server as any, vaultRoot, graph, cache, watcher, DEFAULT_CONFIG);
  });

  it("returns summary runtime visibility without reading the full audit log", async () => {
    const result = await server.callToolJson("get_health", {});

    expect(result.server.name).toBe("obsidian-intelligence-layer");
    expect(result.server.version).toBe("0.5.2");
    expect(result.tool_surface.total).toBe(14);
    expect(result.index.note_count).toBeGreaterThan(0);
    expect(result.cache.cachedNotes).toBe(0);
    expect(result.watcher.active).toBe(false);
    expect(result.audit.path).toBe("_agent-log/");
    expect(result.audit.last_log_date).toBe("2026-03-19");
  });

  it("reports audit as null when log directory is missing", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "oil-core-empty-"));
    const emptyVault = join(emptyDir, "vault");
    await mkdir(emptyVault, { recursive: true });

    const emptyServer = new MockMcpServer();
    const graph = new GraphIndex(emptyVault);
    await graph.build();
    const cache = new SessionCache();
    const watcher = new VaultWatcher(emptyVault, graph, cache);
    registerCoreTools(emptyServer as any, emptyVault, graph, cache, watcher, DEFAULT_CONFIG);

    const result = await emptyServer.callToolJson("get_health", {});
    expect(result.audit.last_log_date).toBeNull();
    expect(result.audit.last_write_at).toBeNull();
    expect(result.index.note_count).toBe(0);

    await rm(emptyDir, { recursive: true, force: true });
  });

  it("includes config section with expected paths", async () => {
    const result = await server.callToolJson("get_health", {});
    expect(result.config.meetings_root).toBeDefined();
    expect(result.config.customers_root).toBeDefined();
    expect(result.config.agent_log).toBe("_agent-log/");
  });

  // Spec §10.8 — Accounting clarity: tiered breakdown sums to total
  it("tool_surface tiers sum to declared total", async () => {
    const health = await server.callToolJson("get_health", {});
    const surface = health.tool_surface;
    const sumOfTiers = surface.core + surface.primitives + surface.aggregators;
    expect(sumOfTiers).toBe(surface.total);
  });

  // Spec §10.9 — Version identity
  it("get_health version matches SERVER_VERSION", async () => {
    const health = await server.callToolJson("get_health", {});
    expect(health.server.version).toBe(SERVER_VERSION);
  });

  it("SERVER_VERSION matches package.json", async () => {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, "../../package.json"), "utf-8"),
    );
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});