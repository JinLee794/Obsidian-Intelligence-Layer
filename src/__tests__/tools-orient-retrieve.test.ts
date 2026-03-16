/**
 * Tests for tools/orient.ts and tools/retrieve.ts — MCP orient + retrieve tools.
 * Orient: get_vault_context, get_customer_context, get_person_context,
 *   resolve_people_to_customers, query_graph.
 * Retrieve: search_vault, query_notes, find_similar_notes, read_note.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerOrientTools } from "../tools/orient.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-orient-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Contoso/opportunities"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Fabrikam"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer, azure, active]
tpid: "12345"
---

# Contoso

## Team

- [[Alice Smith]] (CSA)

## Opportunities

- Cloud Migration (\`opportunityid: a1b2c3d4-e5f6-7890-abcd-ef1234567890\`)

## Agent Insights

- 2026-03-01 Initial contact established

## Connect Hooks

- 2026-03-10 | Individual
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Contoso/opportunities/Cloud Migration.md"),
    `---
tags: [opportunity]
guid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
status: active
---

# Cloud Migration
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Fabrikam/Fabrikam.md"),
    `---
tags: [customer, m365]
---

# Fabrikam
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Alice Smith.md"),
    `---
tags: [person, internal]
company: Microsoft
org: internal
customers: [Contoso]
email: alice@microsoft.com
---

# Alice Smith

CSA for [[Contoso]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Contoso Sync.md"),
    `---
tags: [meeting]
customer: Contoso
date: "2026-03-01"
---

# Contoso Sync

Discussed [[Contoso]] migration with [[Alice Smith]].

## Action Items

- [ ] Follow up on timeline — Alice
- [x] Send proposal — Bob
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Orient Tools ─────────────────────────────────────────────────────────────

describe("orient — get_vault_context", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerOrientTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns vault overview", async () => {
    const result = await server.callToolJson("get_vault_context", {});

    expect(result.noteCount).toBeGreaterThan(0);
    expect(result.folderStructure).toBeDefined();
    expect(result.topTags).toBeDefined();
    expect(result.mostLinkedNotes).toBeDefined();
    expect(result.schemaVersion).toBe("0.1.0");
  });
});

describe("orient — get_customer_context", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerOrientTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns full customer context", async () => {
    const result = await server.callToolJson("get_customer_context", {
      customer: "Contoso",
    });

    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.tpid).toBe("12345");
    expect(result.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(result.team.length).toBeGreaterThanOrEqual(1);
  });

  it("returns error for nonexistent customer", async () => {
    const result = await server.callToolJson("get_customer_context", {
      customer: "NonexistentCorp",
    });

    expect(result.error).toBeTruthy();
  });
});

describe("orient — get_person_context", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerOrientTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns person context with customer links", async () => {
    const result = await server.callToolJson("get_person_context", {
      name: "Alice Smith",
    });

    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.company).toBe("Microsoft");
    expect(result.linkedCustomers).toBeDefined();
    expect(result.linkedCustomers).toContain("Contoso");
  });
});

describe("orient — resolve_people_to_customers", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerOrientTools(server as any, vaultRoot, graph, cache, config);
  });

  it("resolves known people to their customers", async () => {
    const result = await server.callToolJson("resolve_people_to_customers", {
      names: ["Alice Smith"],
    });

    // Tool returns autoUse / needsConfirmation / skipped
    const aliceEntry = result.autoUse?.["Alice Smith"] ?? result.needsConfirmation?.["Alice Smith"];
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry.customers).toContain("Contoso");
  });

  it("reports unresolved names", async () => {
    const result = await server.callToolJson("resolve_people_to_customers", {
      names: ["Unknown Person"],
    });

    expect(result.skipped).toContain("Unknown Person");
  });
});

describe("orient — query_graph", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerOrientTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns backlinks for a note", async () => {
    const result = await server.callToolJson("query_graph", {
      path: "Customers/Contoso/Contoso.md",
      direction: "in",
    });

    // Returns an array directly
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns forward links for a note", async () => {
    const result = await server.callToolJson("query_graph", {
      path: "Customers/Contoso/Contoso.md",
      direction: "out",
    });

    expect(Array.isArray(result)).toBe(true);
  });

  it("returns related notes with N-hop traversal", async () => {
    const result = await server.callToolJson("query_graph", {
      path: "Meetings/2026-03-01 - Contoso Sync.md",
      direction: "neighborhood",
      hops: 2,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Retrieve Tools ───────────────────────────────────────────────────────────

describe("retrieve — search_vault", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("searches by query", async () => {
    const result = await server.callToolJson("search_vault", {
      query: "Contoso",
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r: any) => r.title === "Contoso")).toBe(true);
  });

  it("filters by folder", async () => {
    const result = await server.callToolJson("search_vault", {
      query: "Contoso",
      filter_folder: "Meetings/",
    });

    expect(result.every((r: any) => r.path.startsWith("Meetings/"))).toBe(true);
  });

  it("limits results", async () => {
    const result = await server.callToolJson("search_vault", {
      query: "customer",
      limit: 1,
    });

    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe("retrieve — query_notes", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("queries by frontmatter predicate", async () => {
    const result = await server.callToolJson("query_notes", {
      where: { tags: "customer" },
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  it("supports AND predicates", async () => {
    const result = await server.callToolJson("query_notes", {
      where: { tags: "customer" },
      and: [{ tags: "azure" }],
    });

    expect(result.length).toBe(1);
    expect(result[0].title).toBe("Contoso");
  });

  it("supports ordering", async () => {
    const result = await server.callToolJson("query_notes", {
      where: { tags: "customer" },
      order_by: "title",
    });

    expect(result[0].title).toBe("Contoso");
    expect(result[1].title).toBe("Fabrikam");
  });
});

describe("retrieve — find_similar_notes", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("finds notes similar by tags", async () => {
    const result = await server.callToolJson("find_similar_notes", {
      path: "Customers/Contoso/Contoso.md",
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Fabrikam shares the "customer" tag
    expect(result.some((r: any) => r.title === "Fabrikam")).toBe(true);
  });

  it("returns error for nonexistent path", async () => {
    const result = await server.callToolJson("find_similar_notes", {
      path: "nonexistent.md",
    });

    expect(result.error).toBeTruthy();
  });
});

describe("retrieve — read_note", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config, null);
  });

  it("reads a full note", async () => {
    const result = await server.callToolJson("read_note", {
      path: "Customers/Contoso/Contoso.md",
    });

    expect(result.path).toBe("Customers/Contoso/Contoso.md");
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.tpid).toBe("12345");
    expect(result.content).toContain("# Contoso");
  });

  it("reads a specific section", async () => {
    const result = await server.callToolJson("read_note", {
      path: "Customers/Contoso/Contoso.md",
      section: "Team",
    });

    expect(result.content).toBeDefined();
    expect(result.content).toContain("Alice Smith");
  });

  it("returns error for nonexistent note", async () => {
    const result = await server.callToolJson("read_note", {
      path: "nonexistent.md",
    });

    expect(result.error).toBeTruthy();
  });
});
