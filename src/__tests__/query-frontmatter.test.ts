/**
 * query_frontmatter — the four access modes.
 *
 * The tool is the agent's only route to structured vault properties, so each
 * mode is pinned: schema discovery, facet listing, substring match, and
 * multi-field predicates.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setupHarness, type MockMcpServer } from "./harness.js";

let server: MockMcpServer;

beforeAll(async () => {
  ({ server } = await setupHarness());
});

describe("query_frontmatter — schema mode", () => {
  it("lists available keys when called with no arguments", async () => {
    const result = await server.callToolJson("query_frontmatter", {});

    expect(result.mode).toBe("schema");
    expect(result.key_count).toBeGreaterThan(0);
    const keys = result.keys.map((k: { key: string }) => k.key);
    expect(keys).toContain("status");
    expect(keys).toContain("tags");
  });

  it("reports distinct value and note counts per key", async () => {
    const result = await server.callToolJson("query_frontmatter", {});
    const status = result.keys.find((k: { key: string }) => k.key === "status");

    expect(status.distinct_values).toBeGreaterThan(1);
    expect(status.notes).toBeGreaterThan(0);
  });

  // Discovery is the point: an agent must be able to reach a filter value
  // without being told in advance that it exists.
  it("gives the agent a next step", async () => {
    const result = await server.callToolJson("query_frontmatter", {});
    expect(result.next_step).toContain("key");
  });
});

describe("query_frontmatter — facet mode", () => {
  it("lists distinct values with counts for a key", async () => {
    const result = await server.callToolJson("query_frontmatter", { key: "status" });

    expect(result.mode).toBe("facet");
    const values = result.values.map((v: { value: string }) => v.value);
    expect(values).toContain("at-risk");
    expect(result.values.every((v: { count: number }) => v.count > 0)).toBe(true);
  });

  it("orders values by frequency", async () => {
    const result = await server.callToolJson("query_frontmatter", { key: "tags" });
    const counts = result.values.map((v: { count: number }) => v.count);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  it("preserves original value casing for display", async () => {
    const result = await server.callToolJson("query_frontmatter", { key: "customer" });
    const values = result.values.map((v: { value: string }) => v.value);
    expect(values).toContain("Contoso");
  });

  it("returns available_keys when the key does not exist", async () => {
    const result = await server.callToolJson("query_frontmatter", { key: "nope" });

    expect(result.error_code).toBe("NOT_FOUND");
    expect(result.available_keys).toContain("status");
    expect(result.agent_guidance.retryable).toBe(true);
  });
});

describe("query_frontmatter — match mode", () => {
  it("matches a value substring case-insensitively", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      key: "status",
      value_fragment: "AT-RISK",
    });

    expect(result.mode).toBe("match");
    expect(result.paths).toContain("Customers/Northwind.md");
  });

  // The previous implementation reported the post-truncation length as `count`,
  // so a capped result was indistinguishable from a complete one.
  it("reports total_matched before truncation", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      key: "tags",
      value_fragment: "",
      limit: 1,
    });

    expect(result.total_matched).toBeGreaterThan(1);
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("scopes matches to a folder", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      key: "tags",
      value_fragment: "customer",
      folder: "Customers/",
    });

    expect(result.paths.every((p: string) => p.startsWith("Customers/"))).toBe(true);
  });
});

describe("query_frontmatter — predicate mode", () => {
  it("filters on a single field", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      where: { status: "at-risk" },
    });

    expect(result.mode).toBe("query");
    expect(result.results.map((r: { path: string }) => r.path)).toContain(
      "Customers/Northwind.md",
    );
  });

  it("requires every tag in an array predicate to match", async () => {
    const both = await server.callToolJson("query_frontmatter", {
      where: { tags: ["customer", "enterprise"] },
    });
    const impossible = await server.callToolJson("query_frontmatter", {
      where: { tags: ["customer", "definitely-not-a-tag"] },
    });

    expect(both.total_matched).toBeGreaterThan(0);
    expect(impossible.total_matched).toBe(0);
  });

  it("combines a predicate with a folder scope", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      where: { status: "at-risk" },
      folder: "Customers/",
    });

    expect(result.results.every((r: { path: string }) => r.path.startsWith("Customers/"))).toBe(true);
  });

  it("sorts by a frontmatter field, descending on '-' prefix", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      where: { tags: "meeting" },
      order_by: "-date",
    });

    const paths = result.results.map((r: { path: string }) => r.path);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths[0]).toContain("2026-02-25");
  });

  it("returns each result as a path the agent can read directly", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      where: { status: "at-risk" },
    });

    expect(result.results[0].path).toBeTruthy();
    expect(result.results[0].title).toBeTruthy();
  });
});
