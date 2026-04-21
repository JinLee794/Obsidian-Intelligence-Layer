/**
 * Context-cost regression — guards per-tool and per-workflow token budget.
 *
 * All ceilings derive from a single TOKEN_BUDGET constant so the rationale
 * is visible and tuning is a one-line change. Latency is intentionally NOT
 * tested here — use `vitest bench` for statistical throughput comparison.
 *
 * Spec §10.2 — Per-task cost scales with tools used, not idle registration.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setupHarness, type MockMcpServer } from "./harness.js";
import type { OilConfig } from "../types.js";

// ── Token budget derivation ─────────────────────────────────────────────────
// Anthropic / OpenAI average ≈ 4 chars per token.
// An 8K-token turn budget → 32K chars hard ceiling.
const TOKEN_BUDGET = 8_000;
const CHAR_BUDGET = TOKEN_BUDGET * 4;

let server: MockMcpServer;

beforeAll(async () => {
  ({ server } = await setupHarness());
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per-tool payload size — fraction of turn budget
// ═══════════════════════════════════════════════════════════════════════════════

describe("Per-tool context cost", () => {
  it.each([
    ["get_customer_context", { customer: "Contoso", view: "brief" }, 0.10],
    ["get_customer_context", { customer: "Contoso", view: "full" }, 0.15],
    ["get_customer_context", { customer: "Contoso", view: "write" }, 0.18],
    ["get_health", {}, 0.06],
    ["search_vault", { query: "migration", limit: 5 }, 0.10],
    ["read_note_section", { path: "Customers/Contoso.md", heading: "Agent Insights" }, 0.08],
  ])(
    "%s stays within %s of turn budget",
    async (tool, args, fraction) => {
      const raw = await server.callToolRaw(tool, args);
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.length).toBeLessThan(CHAR_BUDGET * fraction);
    },
  );

  it("brief < full < write for customer context", async () => {
    const brief = (await server.callToolRaw("get_customer_context", { customer: "Contoso", view: "brief" })).length;
    const full = (await server.callToolRaw("get_customer_context", { customer: "Contoso", view: "full" })).length;
    const write = (await server.callToolRaw("get_customer_context", { customer: "Contoso", view: "write" })).length;
    expect(brief).toBeLessThan(full);
    expect(full).toBeLessThan(write);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Workflow-level context cost — aggregate multi-tool loops
// ═══════════════════════════════════════════════════════════════════════════════

describe("Workflow context cost", () => {
  it("brief-lookup → search → section-read stays within 25% of turn budget", async () => {
    const results = await Promise.all([
      server.callToolRaw("get_customer_context", { customer: "Contoso", view: "brief" }),
      server.callToolRaw("search_vault", { query: "migration", limit: 5 }),
      server.callToolRaw("read_note_section", { path: "Customers/Contoso.md", heading: "Agent Insights" }),
    ]);
    const total = results.reduce((sum, r) => sum + r.length, 0);
    expect(total).toBeLessThan(CHAR_BUDGET * 0.25);
  });

  it("meeting-prep workflow (brief + prefetch + health) within 30% of turn budget", async () => {
    const results = await Promise.all([
      server.callToolRaw("get_customer_context", { customer: "Contoso", view: "brief" }),
      server.callToolRaw("prepare_crm_prefetch", { customers: ["Contoso"] }),
      server.callToolRaw("check_vault_health", { customer: "Contoso" }),
    ]);
    const total = results.reduce((sum, r) => sum + r.length, 0);
    expect(total).toBeLessThan(CHAR_BUDGET * 0.30);
  });

  it("full schema + health fits in one turn budget", async () => {
    const schemaChars = server.totalSchemaChars();
    const health = await server.callToolRaw("get_health", {});
    expect(schemaChars + health.length).toBeLessThan(CHAR_BUDGET);
  });
});
