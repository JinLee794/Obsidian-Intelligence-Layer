/**
 * Frontmatter reachability through search.
 *
 * Frontmatter is stripped out of `bodySnippet`, so before it was indexed
 * separately every TPID, account id and custom field was invisible to
 * `search_vault` — and identifier queries that appeared to work were matching
 * a fragment against a title instead.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setupHarness, type MockMcpServer } from "./harness.js";
import { flattenFrontmatter } from "../frontmatter.js";

let server: MockMcpServer;

beforeAll(async () => {
  ({ server } = await setupHarness());
});

const search = (query: string, limit = 5) =>
  server.callToolJson("search_vault", { query, limit });

describe("flattenFrontmatter", () => {
  it("flattens nested objects to dotted paths", () => {
    const flat = flattenFrontmatter({ crm: { account: { id: "ACC-1" } } });
    expect(flat).toContainEqual({ key: "crm.account.id", value: "ACC-1" });
  });

  // Array indices are omitted so every element aggregates under one key —
  // that is what makes "all opportunity GUIDs" a single queryable field.
  it("aggregates array elements under one key", () => {
    const flat = flattenFrontmatter({
      opportunities: [
        { name: "Cloud Foundation", guid: "aaa" },
        { name: "Retail Analytics", guid: "bbb" },
      ],
    });
    const guids = flat.filter((f) => f.key === "opportunities.guid").map((f) => f.value);
    expect(guids).toEqual(["aaa", "bbb"]);
  });

  it("lowercases keys but preserves value casing", () => {
    const flat = flattenFrontmatter({ Customer: "Contoso" });
    expect(flat).toContainEqual({ key: "customer", value: "Contoso" });
  });

  it("ignores non-object input", () => {
    expect(flattenFrontmatter(null)).toEqual([]);
    expect(flattenFrontmatter(["a"])).toEqual([]);
  });
});

describe("search_vault — frontmatter values", () => {
  it("finds a note by a frontmatter identifier", async () => {
    const result = await search("TP-500600");
    expect(result.results[0].path).toBe("Customers/Northwind.md");
  });

  it("attributes the field that matched", async () => {
    const result = await search("TP-500600");
    expect(result.results[0].matched_by).toContain("frontmatter:tpid");
    expect(result.tiers_used).toContain("frontmatter");
  });

  it("finds a note by a fragment of a frontmatter value", async () => {
    const result = await search("500600");
    expect(result.results.map((r: { path: string }) => r.path)).toContain(
      "Customers/Northwind.md",
    );
  });

  it("finds notes by a frontmatter status value", async () => {
    const result = await search("at-risk");
    expect(result.results[0].path).toBe("Customers/Northwind.md");
    expect(result.results[0].matched_by).toContain("frontmatter:status");
  });
});

describe("search_vault — honest attribution", () => {
  // "ACC-NORTHWIND-001" used to rank Northwind via the token "northwind" in the
  // title, indistinguishable from a real account-id hit.
  it("distinguishes a true identifier match from a name-fragment match", async () => {
    const real = await search("ACC-NORTHWIND-001");
    const fragment = await search("NORTHWIND-001");

    expect(real.results[0].matched_by).toContain("frontmatter:accountid");
    expect(fragment.results[0].matched_by).not.toContain("frontmatter:accountid");
  });

  it("reports the tier that produced every result", async () => {
    const result = await search("Contoso");
    expect(result.results[0].matched_by.length).toBeGreaterThan(0);
  });
});

describe("search_vault — no regression on named notes", () => {
  // Meetings carry `customer: Contoso` and `action_owners: [Dave Wilson]`, so an
  // ungated exact-value tier would short-circuit past the note actually named.
  it.each([
    ["Contoso", "Customers/Contoso.md"],
    ["Northwind Traders", "Customers/Northwind.md"],
    ["Dave Wilson", "People/Dave Wilson.md"],
  ])("ranks the note named by %s first", async (query, expected) => {
    const result = await search(query);
    expect(result.results[0].path).toBe(expected);
  });

  it("still recovers typos through the fuzzy tier", async () => {
    const result = await search("Nortwind");
    expect(result.results[0].path).toBe("Customers/Northwind.md");
  });
});

describe("search_vault — stable ordering for category values", () => {
  // A frontmatter value like `status: completed` matches many notes and has no
  // relevance signal to rank by. The index's own order is insertion order,
  // which shifts when a note is re-indexed after an edit — so without an
  // explicit sort an agent asking the same question twice gets a different
  // window of results.
  it("orders exact frontmatter matches deterministically", async () => {
    const result = await search("completed", 10);
    const paths = result.results.map((r: { path: string }) => r.path);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths).toEqual([...paths].sort());
  });

  it("reports how many matched when the limit truncates", async () => {
    const full = await search("completed", 10);
    const capped = await search("completed", 1);

    expect(capped.total_matched).toBe(full.total_matched);
    expect(capped.count).toBe(1);
    expect(capped.truncated).toBe(true);
    expect(capped.next_step).toContain("query_frontmatter");
  });

  it("keeps the same window across repeated calls", async () => {
    const first = await server.callToolRaw("search_vault", { query: "completed", limit: 2 });
    for (let turn = 0; turn < 5; turn++) {
      expect(await server.callToolRaw("search_vault", { query: "completed", limit: 2 })).toBe(first);
    }
  });
});

describe("query_frontmatter — nested custom fields", () => {
  it("exposes flattened keys as facets", async () => {
    const schema = await server.callToolJson("query_frontmatter", {});
    const keys = schema.keys.map((k: { key: string }) => k.key);
    expect(keys).toContain("tpid");
    expect(keys).toContain("accountid");
  });

  it("filters on a dotted path predicate", async () => {
    const result = await server.callToolJson("query_frontmatter", {
      where: { "action_owners": "Dave Wilson" },
    });
    expect(result.total_matched).toBeGreaterThan(0);
  });
});
