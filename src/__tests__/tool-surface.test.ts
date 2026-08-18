/**
 * Tool surface regression — guards tool count and exact names.
 *
 * Any addition/removal shows up as a reviewable inline-snapshot diff.
 * Runs against the 13-note fixture vault with all tool modules registered.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setupHarness, type MockMcpServer } from "./harness.js";

let server: MockMcpServer;

beforeAll(async () => {
  ({ server } = await setupHarness());
});

describe("Tool surface", () => {
  it("exact tool list (snapshot)", () => {
    expect(server.toolNames).toMatchInlineSnapshot(`
      [
        "atomic_append",
        "atomic_replace",
        "check_vault_health",
        "create_note",
        "get_agent_log",
        "get_customer_context",
        "get_health",
        "get_note_metadata",
        "get_related_entities",
        "prepare_crm_prefetch",
        "query_frontmatter",
        "read_note_section",
        "search_vault",
        "semantic_search",
      ]
    `);
  });

  it("tool count matches snapshot", () => {
    expect(server.tools.size).toBe(14);
  });

  // Spec §10.1 — Idle context cost: schema injected into every conversation.
  // Guard the total serialized size (chars) rather than a heuristic "token" estimate.
  it("total schema serialized size ≤ 32000 chars", () => {
    const chars = server.totalSchemaChars();
    expect(chars).toBeLessThanOrEqual(32_000);
  });
});
