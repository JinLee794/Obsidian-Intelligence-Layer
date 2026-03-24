/**
 * Tests for tools/write.ts — OIL v2 atomic write tools.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerWriteTools } from "../tools/write.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock McpServer ───────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

class MockMcpServer {
  tools = new Map<string, { config: unknown; handler: ToolHandler }>();

  registerTool(name: string, config: unknown, handler: ToolHandler): void {
    this.tools.set(name, { config, handler });
  }

  async callToolJson(name: string, args: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const result = await tool.handler(args);
    return JSON.parse(result.content[0].text);
  }
}

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-write-v2-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer]
---

# Contoso

## Agent Insights

- Initial insight

## Team

- Alice
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("write v2 — atomic_append", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("appends when expected_mtime matches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- New validated insight",
      expected_mtime: stats,
    });

    expect(result.status).toBe("executed");

    const content = await readFile(join(vaultRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(content).toContain("New validated insight");
  });

  it("rejects stale append when mtime mismatches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    await writeFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      `---\ntags: [customer]\n---\n\n# Contoso\n\n## Agent Insights\n\n- Modified by another writer\n`,
      "utf-8",
    );

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- Should fail",
      expected_mtime: stats,
    });

    expect(result.error).toContain("Stale write rejected");
  });
});

describe("write v2 — atomic_replace", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("replaces full content when expected_mtime matches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    const result = await server.callToolJson("atomic_replace", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Replaced\n\nFresh content",
      expected_mtime: stats,
    });

    expect(result.status).toBe("executed");

    const content = await readFile(join(vaultRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(content).toContain("# Replaced");
  });

  it("rejects stale replace when mtime mismatches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    await writeFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      "# Concurrent update\n",
      "utf-8",
    );

    const result = await server.callToolJson("atomic_replace", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Should not write",
      expected_mtime: stats,
    });

    expect(result.error).toContain("Stale write rejected");
  });
});

describe("write/read integration", () => {
  it("uses get_note_metadata mtime_ms for a successful atomic update", async () => {
    const server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
    registerWriteTools(server as any, vaultRoot, graph, cache, config);

    const meta = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- Update with metadata mtime",
      expected_mtime: meta.mtime_ms,
    });

    expect(result.status).toBe("executed");
  });
});

describe("write v2 — create_note", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("creates a new note when the file does not exist", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Daily/2026-03-19.md",
      content: "# 2026-03-19\n\n## Morning Triage\n\n- First item\n",
    });

    expect(result.status).toBe("created");
    expect(result.path).toBe("Daily/2026-03-19.md");
    expect(result.mtime_ms).toBeGreaterThan(0);

    const content = await readFile(join(vaultRoot, "Daily/2026-03-19.md"), "utf-8");
    expect(content).toContain("# 2026-03-19");
    expect(content).toContain("First item");
  });

  it("rejects creation when the file already exists", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Should not overwrite",
    });

    expect(result.error).toContain("already exists");
  });

  it("rejects path traversal attempts", async () => {
    const result = await server.callToolJson("create_note", {
      path: "../../../etc/passwd",
      content: "nope",
    });

    expect(result.error).toBeDefined();
  });
});

async function readCurrentMtime(vaultRoot: string, _config: OilConfig): Promise<number> {
  const server = new MockMcpServer();
  const graph = new GraphIndex(vaultRoot);
  await graph.build();
  const cache = new SessionCache();
  registerRetrieveTools(server as any, vaultRoot, graph, cache, DEFAULT_CONFIG, null);
  const metadata = await server.callToolJson("get_note_metadata", {
    path: "Customers/Contoso/Contoso.md",
  });
  return metadata.mtime_ms;
}
