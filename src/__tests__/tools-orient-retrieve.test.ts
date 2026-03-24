/**
 * Tests for tools/retrieve.ts — OIL v2 retrieve/search tools.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
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

// ─── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-retrieve-v2-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer, azure]
tpid: "12345"
status: active
---

# Contoso

## CRM Updates

Contoso signed the migration SOW and requested weekly architecture reviews.

## Team

- Alice Smith
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Contoso Sync.md"),
    `---
tags: [meeting]
customer: Contoso
---

# Contoso Sync

Reviewed migration plan and SOW milestones with [[Contoso]].
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("retrieve v2 — get_note_metadata", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("returns metadata including mtime and headings", async () => {
    const result = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    expect(result.frontmatter.tpid).toBe("12345");
    expect(typeof result.word_count).toBe("number");
    expect(result.headings).toContain("CRM Updates");
    expect(typeof result.mtime_ms).toBe("number");
  });
});

describe("retrieve v2 — read_note_section", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("returns only the requested heading content", async () => {
    const result = await server.callToolJson("read_note_section", {
      path: "Customers/Contoso/Contoso.md",
      heading: "CRM Updates",
    });

    expect(result.heading).toBe("CRM Updates");
    expect(result.content).toContain("migration SOW");
    expect(result.content).not.toContain("Alice Smith");
  });

  it("returns available headings when section is missing", async () => {
    const result = await server.callToolJson("read_note_section", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Missing",
    });

    expect(result.error).toContain("not found");
    expect(result.available_headings).toContain("CRM Updates");
  });
});

describe("retrieve v2 — get_related_entities", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("returns linked note refs without content", async () => {
    const result = await server.callToolJson("get_related_entities", {
      path: "Customers/Contoso/Contoso.md",
      max_hops: 1,
    });

    expect(Array.isArray(result.related)).toBe(true);
    expect(result.related.length).toBeGreaterThan(0);
    expect(result.related[0].content).toBeUndefined();
  });
});

describe("retrieve v2 — semantic_search", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("returns bounded snippet results", async () => {
    const result = await server.callToolJson("semantic_search", {
      query: "migration SOW",
      limit: 3,
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.results[0].snippet).toBeTruthy();
    expect(result.results[0].snippet.length).toBeLessThanOrEqual(230);
  });
});

describe("retrieve v2 — query_frontmatter", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("queries frontmatter by key and value fragment", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      key: "status",
      value_fragment: "acti",
    });

    expect(result.paths).toContain("Customers/Contoso/Contoso.md");
  });

  it("reflects index on new tool registration", async () => {
    const notePath = join(vaultRoot, "Customers/Contoso/Contoso.md");
    const content = await readFile(notePath, "utf-8");
    await writeFile(notePath, content.replace("status: active", "status: paused"), "utf-8");
    const now = new Date();
    await utimes(notePath, now, now);

    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    const newServer = new MockMcpServer();
    registerRetrieveTools(newServer as any, vaultRoot, graph, cache, config, null);

    const result = await newServer.callToolJson("query_frontmatter", {
      key: "status",
      value_fragment: "paus",
    });

    expect(result.paths).toContain("Customers/Contoso/Contoso.md");
  });
});
