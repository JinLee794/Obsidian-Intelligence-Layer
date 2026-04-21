/**
 * Tool contract integration tests.
 *
 * Validates the quality of context OIL provides to agents:
 *
 * 1. Response contract conformance — do tool outputs carry refs, error codes, versions?
 * 2. Error taxonomy — are error paths structured and machine-branchable?
 * 3. View mode correctness — do views return the right structure?
 * 4. Freshness round-trip — read → write → verify version chain integrity
 * 5. Audit reliability — does every write produce a retrievable log entry?
 * 6. TPID resolution fidelity — does customer lookup propagate correctly end-to-end?
 *
 * Token/char budget concerns live in token-budgets.test.ts (snapshot-based).
 * These run unconditionally in CI against an isolated temp vault.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../../graph.js";
import { SessionCache } from "../../cache.js";
import { VaultWatcher } from "../../watcher.js";
import { loadConfig } from "../../config.js";
import { registerCoreTools } from "../../tools/core.js";
import { registerRetrieveTools } from "../../tools/retrieve.js";
import { registerWriteTools } from "../../tools/write.js";
import { registerDomainTools } from "../../tools/domain.js";
import { MockMcpServer } from "../harness.js";

// ── Fixture vault ────────────────────────────────────────────────────────────

let tempDir: string;
let vaultRoot: string;
let server: MockMcpServer;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tool-contracts-"));
  vaultRoot = join(tempDir, "vault");

  // Build an isolated fixture vault
  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Fabrikam"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer, enterprise]
tpid: "100200"
status: active
---

# Contoso

## Team

- Alice Smith (CSA)
- Bob Chen (CSAM)

## Opportunities

- Azure Migration — GUID: \`a1b2c3d4-0000-0000-0000-000000000001\`

## Milestones

- M1: Landing Zone — ID: \`MS-001\`

## Agent Insights

- 2026-02-15: Pipeline on track.
- 2026-02-20: Bob flagged delay on M1.

## Connect Hooks

- 2026-02-18 | Architecture review saved 3 weeks
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Fabrikam/Fabrikam.md"),
    `---
tags: [customer]
tpid: "200300"
status: active
---

# Fabrikam

## Team

- Dave Wilson (CSA)

## Agent Insights

- 2026-02-10: Onboarding complete.
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01-Contoso-Sync.md"),
    `---
tags: [meeting]
customer: Contoso
date: "2026-03-01"
---

# Contoso Sync

Reviewed migration with [[Contoso]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Alice Smith.md"),
    `---
tags: [person]
customers: [Contoso]
---

# Alice Smith

CSA for [[Contoso]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "_agent-log/2026-03-18.md"),
    `---
date: 2026-03-18
tags: [agent-log]
---

# Agent Log — 2026-03-18

### 14:30:00 — atomic_append [auto]
- **Path:** \`Customers/Contoso/Contoso.md\`
- **Detail:** append to §Agent Insights
`,
    "utf-8",
  );

  // Register all production tools
  server = new MockMcpServer();
  const config = await loadConfig(vaultRoot);
  const graph = new GraphIndex(vaultRoot);
  await graph.build();
  const cache = new SessionCache();
  const watcher = new VaultWatcher(vaultRoot, graph, cache);

  registerCoreTools(server as any, vaultRoot, graph, cache, watcher, config);
  registerRetrieveTools(server as any, vaultRoot, graph, cache, config);
  registerWriteTools(server as any, vaultRoot, graph, cache, config);
  registerDomainTools(server as any, vaultRoot, graph, cache, config);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RESPONSE CONTRACT CONFORMANCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Response contract conformance", () => {
  it("read tools return stable ref fields", async () => {
    const checks: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "get_note_metadata", args: { path: "Customers/Contoso/Contoso.md" } },
      { tool: "read_note_section", args: { path: "Customers/Contoso/Contoso.md", heading: "Team" } },
      { tool: "get_related_entities", args: { path: "Customers/Contoso/Contoso.md" } },
    ];

    for (const { tool, args } of checks) {
      const result = await server.callToolJson(tool, args);
      expect(typeof result.ref).toBe("string");
      expect(result.ref.length).toBeGreaterThan(0);
    }
  });

  it("read tools return version/freshness on mutable data", async () => {
    const metadata = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });
    expect(typeof metadata.version).toBe("number");
    expect(typeof metadata.mtime_ms).toBe("number");
    expect(metadata.version).toBe(metadata.mtime_ms);

    const section = await server.callToolJson("read_note_section", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Team",
    });
    expect(typeof section.version).toBe("number");
    expect(typeof section.mtime_ms).toBe("number");
  });

  it("search results carry ref on every hit", async () => {
    const semantic = await server.callToolJson("semantic_search", { query: "migration", limit: 5 });
    const vault = await server.callToolJson("search_vault", { query: "Contoso", limit: 5 });

    expect(semantic.results.every((r: any) => typeof r.ref === "string")).toBe(true);
    expect(vault.every((r: any) => typeof r.ref === "string")).toBe(true);
  });

  it("query_frontmatter returns ref in matches array", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      key: "tpid",
      value_fragment: "100",
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m: any) => typeof m.ref === "string")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ERROR TAXONOMY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error taxonomy", () => {
  const errorCases: Array<{
    label: string;
    tool: string;
    args: Record<string, unknown>;
    expectedCode: string;
  }> = [
    {
      label: "path traversal → INVALID_INPUT",
      tool: "get_note_metadata",
      args: { path: "../../../etc/passwd" },
      expectedCode: "INVALID_INPUT",
    },
    {
      label: "missing section → NOT_FOUND",
      tool: "read_note_section",
      args: { path: "Customers/Contoso/Contoso.md", heading: "Nonexistent Section" },
      expectedCode: "NOT_FOUND",
    },
    {
      label: "stale mtime → CONFLICT",
      tool: "atomic_append",
      args: {
        path: "Customers/Contoso/Contoso.md",
        heading: "Agent Insights",
        content: "- test",
        expected_mtime: 1,
      },
      expectedCode: "CONFLICT",
    },
    {
      label: "create existing → CONFLICT",
      tool: "create_note",
      args: { path: "Customers/Contoso/Contoso.md", content: "dup" },
      expectedCode: "CONFLICT",
    },
    {
      label: "unknown TPID → NOT_FOUND",
      tool: "get_customer_context",
      args: { customer: "99999999" },
      expectedCode: "NOT_FOUND",
    },
  ];

  for (const { label, tool, args, expectedCode } of errorCases) {
    it(label, async () => {
      const result = await server.callToolJson(tool, args);
      expect(result.error_code).toBe(expectedCode);
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    });
  }

  it("path errors explain the vault-relative retry rule", async () => {
    const result = await server.callToolJson("get_note_metadata", {
      path: "../../../etc/passwd",
    });

    expect(result.agent_guidance.retryable).toBe(true);
    expect(result.agent_guidance.next_step).toContain("vault-relative path");
  });

  it("missing section errors steer the agent to available headings", async () => {
    const result = await server.callToolJson("read_note_section", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Nonexistent Section",
    });

    expect(result.agent_guidance.retryable).toBe(true);
    expect(result.agent_guidance.next_step).toContain("available_headings");
    expect(result.available_headings).toContain("Team");
  });

  it("stale write errors steer the agent to re-read before retrying", async () => {
    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- stale guidance test",
      expected_mtime: 1,
    });

    expect(result.agent_guidance.retryable).toBe(true);
    expect(result.agent_guidance.suggested_tools).toContain("get_note_metadata");
    expect(result.agent_guidance.next_step).toContain("get_note_metadata");
  });

  it("create conflicts steer the agent to atomic_replace", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Customers/Contoso/Contoso.md",
      content: "dup",
    });

    expect(result.agent_guidance.retryable).toBe(false);
    expect(result.agent_guidance.suggested_tools).toContain("atomic_replace");
    expect(result.agent_guidance.next_step).toContain("atomic_replace");
  });

  it("unknown TPID errors point the agent at lookup recovery paths", async () => {
    const result = await server.callToolJson("get_customer_context", {
      customer: "99999999",
    });

    expect(result.agent_guidance.retryable).toBe(true);
    expect(result.agent_guidance.suggested_tools).toContain("query_frontmatter");
    expect(result.agent_guidance.next_step).toContain("customer name");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. VIEW MODE CORRECTNESS
// ═══════════════════════════════════════════════════════════════════════════════

describe("View mode correctness", () => {
  it("brief < full payload size", async () => {
    const brief = await server.callToolRaw("get_customer_context", { customer: "Contoso", view: "brief" });
    const full = await server.callToolRaw("get_customer_context", { customer: "Contoso", view: "full" });

    expect(brief.length).toBeLessThan(full.length);
  });

  it("brief view omits verbose arrays, keeps actionable fields", async () => {
    const brief = await server.callToolJson("get_customer_context", { customer: "Contoso", view: "brief" });

    expect(brief.frontmatter).toBeDefined();
    expect(brief.summary).toBeDefined();
    expect(brief.agentInsights).toBeUndefined();
    expect(brief.connectHooks).toBeUndefined();
  });

  it("write view includes deterministic write targets", async () => {
    const write = await server.callToolJson("get_customer_context", { customer: "Contoso", view: "write" });

    expect(write.write_targets).toBeDefined();
    expect(write.write_targets.customer_note).toBe("Customers/Contoso/Contoso.md");
    expect(typeof write.customer_mtime_ms).toBe("number");
    expect(write.write_targets.headings.agent_insights).toBe("Agent Insights");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. VISIBILITY CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Visibility contract", () => {
  it("get_health provides actionable runtime state", async () => {
    const health = await server.callToolJson("get_health", {});

    expect(health.server.version).toBeDefined();
    expect(health.tool_surface.total).toBeGreaterThan(0);
    expect(typeof health.index.note_count).toBe("number");
    expect(typeof health.cache.cachedNotes).toBe("number");
    expect(typeof health.watcher.active).toBe("boolean");
    expect(typeof health.audit.enabled).toBe("boolean");
  });

  it("get_health includes all structural sections", async () => {
    const health = await server.callToolJson("get_health", {});
    expect(health.server).toBeDefined();
    expect(health.tool_surface).toBeDefined();
    expect(health.index).toBeDefined();
    expect(health.cache).toBeDefined();
    expect(health.watcher).toBeDefined();
    expect(health.audit).toBeDefined();
    expect(health.config).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. FRESHNESS ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════════════

describe("Freshness round-trip", () => {
  it("read → write → re-read shows version progression", async () => {
    const meta1 = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    const write = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- 2026-04-19: Freshness round-trip test entry",
      expected_mtime: meta1.mtime_ms,
    });

    expect(write.status).toBe("executed");
    expect(write.version).toBeGreaterThan(meta1.version);

    const meta2 = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });
    expect(meta2.version).toBeGreaterThanOrEqual(write.version);
  });

  it("stale write rejected with CONFLICT", async () => {
    const meta = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    // Write once to advance the mtime
    await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- advance mtime",
      expected_mtime: meta.mtime_ms,
    });

    // Now use the old mtime — should CONFLICT
    const stale = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- should fail",
      expected_mtime: meta.mtime_ms,
    });

    expect(stale.error_code).toBe("CONFLICT");
  });

  it("write version matches subsequent section read", async () => {
    const meta = await server.callToolJson("get_note_metadata", {
      path: "Customers/Fabrikam/Fabrikam.md",
    });

    const write = await server.callToolJson("atomic_append", {
      path: "Customers/Fabrikam/Fabrikam.md",
      heading: "Agent Insights",
      content: "- 2026-04-19: Version chain test",
      expected_mtime: meta.mtime_ms,
    });

    const section = await server.callToolJson("read_note_section", {
      path: "Customers/Fabrikam/Fabrikam.md",
      heading: "Agent Insights",
    });

    expect(section.version).toBeGreaterThanOrEqual(write.version);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. AUDIT RELIABILITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Audit reliability", () => {
  it("create_note produces a retrievable audit entry", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Daily/2026-04-19.md",
      content: "# 2026-04-19\n\n## Morning\n\n- Audit test\n",
    });

    expect(result.status).toBe("created");

    const date = new Date().toISOString().slice(0, 10);
    const log = await server.callToolJson("get_agent_log", { date });

    expect(log.log).toContain("create_note");
    expect(log.log).toContain("Daily/2026-04-19.md");
  });

  it("atomic_append produces a retrievable audit entry", async () => {
    const meta = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- 2026-04-19: Audit reliability check",
      expected_mtime: meta.mtime_ms,
    });

    const date = new Date().toISOString().slice(0, 10);
    const log = await server.callToolJson("get_agent_log", { date });

    expect(log.log).toContain("atomic_append");
  });

  it("get_health reports audit availability", async () => {
    const health = await server.callToolJson("get_health", {});
    const today = new Date().toISOString().slice(0, 10);
    expect(health.audit.last_log_date).toBe(today);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. TPID RESOLUTION FIDELITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("TPID resolution fidelity", () => {
  it("TPID resolves to correct customer", async () => {
    const byName = await server.callToolJson("get_customer_context", { customer: "Contoso" });
    const byTpid = await server.callToolJson("get_customer_context", { customer: "100200" });

    expect(byTpid.customer).toBe("Contoso");
    expect(byTpid.customer_ref).toBe(byName.customer_ref);
    expect(byTpid.frontmatter.tpid).toBe("100200");
  });

  it("TPID works across all view modes", async () => {
    for (const view of ["brief", "full", "write"] as const) {
      const result = await server.callToolJson("get_customer_context", {
        customer: "100200",
        view,
      });
      expect(result.customer).toBe("Contoso");
      expect(result.view).toBe(view);
    }
  });

  it("unknown TPID returns NOT_FOUND", async () => {
    const result = await server.callToolJson("get_customer_context", {
      customer: "99999999",
    });
    expect(result.error_code).toBe("NOT_FOUND");
    expect(result.error).toContain("TPID");
  });
});
