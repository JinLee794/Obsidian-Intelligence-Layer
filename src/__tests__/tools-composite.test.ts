/**
 * Tests for tools/composite.ts — MCP composite tools: prefetch, correlate, 
 * promote_findings, check_vault_health, get_drift_report.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerCompositeTools } from "../tools/composite.js";
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

// ─── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-composite-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Contoso/opportunities"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Contoso/milestones"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Fabrikam"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });

  const past = new Date();
  past.setDate(past.getDate() - 60);
  const staleDate = past.toISOString().slice(0, 10);

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer]
tpid: "12345"
accountid: "acc-001"
---

# Contoso

## Team

- Alice (CSA)

## Agent Insights

- ${staleDate} Stale insight

## Connect Hooks

## Opportunities

- Cloud Migration (\`opportunityid: a1b2c3d4-e5f6-7890-abcd-ef1234567890\`)
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
    join(vaultRoot, "Customers/Contoso/milestones/POC Complete.md"),
    `---
tags: [milestone]
milestone_id: "ms-001"
---

# POC Complete
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Fabrikam/Fabrikam.md"),
    `---
tags: [customer]
---

# Fabrikam
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Alice Smith.md"),
    `---
tags: [person]
company: Microsoft
org: internal
customers: [Contoso]
---

# Alice Smith
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

Discussed [[Contoso]] with [[Alice Smith]].
`,
    "utf-8",
  );

  // Orphaned meeting
  await writeFile(
    join(vaultRoot, "Meetings/2026-03-05 - Random.md"),
    `---
tags: [meeting]
date: "2026-03-05"
---

# Random
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("composite tools — prepare_crm_prefetch", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerCompositeTools(server as any, vaultRoot, graph, cache, config);
  });

  it("extracts prefetch IDs for a customer", async () => {
    const result = await server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });

    expect(result.prefetch).toBeDefined();
    expect(result.prefetch.length).toBe(1);

    const contoso = result.prefetch[0];
    expect(contoso.customer).toBe("Contoso");
    expect(contoso.tpid).toBe("12345");
    expect(contoso.accountid).toBe("acc-001");
    expect(contoso.opportunityGuids.length).toBeGreaterThanOrEqual(1);
  });

  it("includes OData filter hints", async () => {
    const result = await server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });

    const contoso = result.prefetch[0];
    expect(contoso.odata_hints).toBeDefined();
    expect(contoso.odata_hints.opportunity_filter).toContain("_msp_opportunityid_value");
  });

  it("handles customer with no IDs", async () => {
    const result = await server.callToolJson("prepare_crm_prefetch", {
      customers: ["Fabrikam"],
    });

    const fab = result.prefetch[0];
    expect(fab.customer).toBe("Fabrikam");
    expect(fab.opportunityGuids).toEqual([]);
  });
});

describe("composite tools — correlate_with_vault", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerCompositeTools(server as any, vaultRoot, graph, cache, config);
  });

  it("correlates known entities", async () => {
    const result = await server.callToolJson("correlate_with_vault", {
      entities: [
        { name: "Contoso", type: "customer" },
        { name: "Alice Smith", type: "person" },
      ],
    });

    expect(result.summary.total).toBe(2);
    expect(result.summary.resolved).toBeGreaterThanOrEqual(1);
  });

  it("reports unresolved entities", async () => {
    const result = await server.callToolJson("correlate_with_vault", {
      entities: [
        { name: "Unknown Corp", type: "customer" },
      ],
    });

    expect(result.summary.unresolved).toBeGreaterThanOrEqual(1);
    expect(result.summary.unresolvedNames).toContain("Unknown Corp");
  });
});

describe("composite tools — promote_findings", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerCompositeTools(server as any, vaultRoot, graph, cache, config);
  });

  it("auto-promotes to Agent Insights", async () => {
    const result = await server.callToolJson("promote_findings", {
      findings: [
        {
          customer: "Contoso",
          section: "Agent Insights",
          content: "Confirmed Azure migration budget approved",
        },
      ],
    });

    expect(result.executed.length).toBe(1);
    expect(result.executed[0].section).toBe("Agent Insights");

    // Verify content was appended
    const content = await readFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      "utf-8",
    );
    expect(content).toContain("Azure migration budget approved");
  });

  it("gates non-auto-confirmed sections", async () => {
    const result = await server.callToolJson("promote_findings", {
      findings: [
        {
          customer: "Contoso",
          section: "Team",
          content: "New member Bob joined",
        },
      ],
    });

    expect(result.pending).toBeDefined();
    expect(result.pending.writeId).toBeTruthy();
  });
});

describe("composite tools — check_vault_health", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerCompositeTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns health report", async () => {
    const result = await server.callToolJson("check_vault_health", {});

    expect(result.report).toBeDefined();
    expect(result.report.totalCustomers).toBe(2);
    expect(result.issues).toBeDefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("filters by customer", async () => {
    const result = await server.callToolJson("check_vault_health", {
      customers: ["Contoso"],
    });

    expect(result.report.customers.length).toBe(1);
    expect(result.report.customers[0].customer).toBe("Contoso");
  });

  it("flags stale insights", async () => {
    const result = await server.callToolJson("check_vault_health", {
      customers: ["Contoso"],
    });

    const staleIssue = result.issues.find((i: string) => i.includes("stale"));
    expect(staleIssue).toBeTruthy();
  });

  it("flags orphaned meetings", async () => {
    const result = await server.callToolJson("check_vault_health", {});

    const orphanIssue = result.issues.find((i: string) => i.includes("not linked"));
    expect(orphanIssue).toBeTruthy();
  });
});

describe("composite tools — get_drift_report", () => {
  let server: MockMcpServer;
  let graph: GraphIndex;
  let cache: SessionCache;

  beforeEach(async () => {
    server = new MockMcpServer();
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    registerCompositeTools(server as any, vaultRoot, graph, cache, config);
  });

  it("returns drift snapshot for customer", async () => {
    const result = await server.callToolJson("get_drift_report", {
      customer: "Contoso",
    });

    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.customer).toBe("Contoso");
    expect(result.snapshot.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(result.comparisonHints).toBeDefined();
  });
});
