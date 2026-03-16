/**
 * Tests for tools/write.ts — MCP write tool handlers via mock server.
 * Tests patch_note tier routing, meeting note drafting, customer file creation,
 * confirm/reject flows, apply_tags, and promote_findings.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerWriteTools } from "../tools/write.js";
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

  async callTool(name: string, args: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.handler(args);
  }

  /** Parse the JSON text from tool response */
  async callToolJson(name: string, args: Record<string, unknown>) {
    const result = await this.callTool(name, args);
    return JSON.parse(result.content[0].text);
  }
}

// ─── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-write-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer]
tpid: "12345"
---

# Contoso

## Agent Insights

- 2026-03-01 Initial contact made

## Connect Hooks

## Team

- Alice (CSA)

## Opportunities

- Cloud Migration
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("write tools — patch_note", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("auto-confirms patch_note to Agent Insights section", async () => {
    const result = await server.callToolJson("patch_note", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- 2026-03-15 New insight from AI",
    });

    expect(result.status).toBe("executed");
    expect(result.heading).toBe("Agent Insights");

    // Verify content was actually appended
    const content = await readFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      "utf-8",
    );
    expect(content).toContain("New insight from AI");
  });

  it("gates patch_note to non-auto-confirmed sections", async () => {
    const result = await server.callToolJson("patch_note", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Team",
      content: "- Bob (Specialist)",
    });

    expect(result.status).toBe("pending");
    expect(result.writeId).toBeTruthy();
    expect(result.diff).toContain("Team");
  });
});

describe("write tools — log_agent_action", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("logs an agent action to _agent-log/", async () => {
    const result = await server.callToolJson("log_agent_action", {
      action: "Queried CRM for Contoso",
      context: { tool: "crm_query", result_count: 5 },
      session_id: "test-session-123",
    });

    expect(result.status).toBe("executed");
    expect(result.logPath).toContain("_agent-log/");
  });
});

describe("write tools — draft_meeting_note", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("generates a gated meeting note draft", async () => {
    const result = await server.callToolJson("draft_meeting_note", {
      customer: "Contoso",
      content: "Discussed migration timeline. Agreed on Q2 deadline.",
      attendees: ["Alice", "Bob"],
      date: "2026-03-15",
      title: "Migration Review",
    });

    expect(result.status).toBe("pending");
    expect(result.writeId).toBeTruthy();
    expect(result.diff).toContain("Migration Review");
    expect(result.diff).toContain("migration timeline");
  });
});

describe("write tools — create_customer_file", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("generates a gated customer file scaffold", async () => {
    const result = await server.callTool("create_customer_file", {
      customer: "Woodgrove",
      tpid: "98765",
      opportunities: [{ name: "Digital Transformation", guid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }],
      team: [{ name: "Charlie", role: "CSA" }],
    });

    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    // If the tool returned an error (e.g. validation), show it for debugging
    if (parsed.error) {
      console.error("Tool error:", parsed.error);
    }

    expect(parsed.status).toBe("pending");
    expect(parsed.writeId).toBeTruthy();
    expect(parsed.diff).toContain("Woodgrove");
    expect(parsed.diff).toContain("Digital Transformation");
    expect(parsed.diff).toContain("Charlie");
  });

  it("rejects when customer file already exists", async () => {
    const result = await server.callToolJson("create_customer_file", {
      customer: "Contoso",
    });

    expect(result.error).toContain("already exists");
  });
});

describe("write tools — confirm_write + reject_write via manage_pending_writes", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("confirms a pending write via manage_pending_writes", async () => {
    // Queue a gated write
    const draft = await server.callToolJson("write_note", {
      path: "notes/confirm-via-tool.md",
      content: "---\ntags: [test]\n---\n# Confirmed\n",
      mode: "overwrite",
    });
    expect(draft.status).toBe("pending");

    // Confirm it via manage_pending_writes
    const confirmed = await server.callToolJson("manage_pending_writes", {
      action: "confirm",
      write_id: draft.writeId,
    });
    expect(confirmed.success).toBe(true);

    // File should exist
    const content = await readFile(
      join(vaultRoot, "notes/confirm-via-tool.md"),
      "utf-8",
    );
    expect(content).toContain("# Confirmed");
  });

  it("rejects a pending write via manage_pending_writes", async () => {
    const draft = await server.callToolJson("write_note", {
      path: "notes/reject-via-tool.md",
      content: "# Rejected",
    });

    const rejected = await server.callToolJson("manage_pending_writes", {
      action: "reject",
      write_id: draft.writeId,
    });
    expect(rejected.success).toBe(true);
  });

  it("errors on confirming nonexistent write", async () => {
    const result = await server.callToolJson("manage_pending_writes", {
      action: "confirm",
      write_id: "nonexistent",
    });
    expect(result.error || result.success === false).toBeTruthy();
  });

  it("errors when write_id missing for confirm", async () => {
    const result = await server.callToolJson("manage_pending_writes", {
      action: "confirm",
    });
    expect(result.error).toBeTruthy();
  });
});

describe("write tools — manage_pending_writes list", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("lists pending writes as array", async () => {
    // Queue two writes
    await server.callToolJson("write_note", {
      path: "a.md", content: "A",
    });
    await server.callToolJson("write_note", {
      path: "b.md", content: "B",
    });

    const result = await server.callToolJson("manage_pending_writes", {
      action: "list",
    });
    // list returns an array of pending writes
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });
});
