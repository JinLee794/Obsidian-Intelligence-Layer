import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCustomerPath } from "../../vault.js";
import { setupHarness, type TestHarness } from "../harness.js";

let vault: string;
let harness: TestHarness;
const canonical = "CONTOSO CORPORATION";
const hubPath = `Customers/${canonical}/${canonical}.md`;
const views = ["brief", "full", "write"] as const;

async function put(path: string, content: string): Promise<void> {
  const file = join(vault, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

const context = (customer: string, view: typeof views[number] = "full") =>
  harness.server.callToolJson("get_customer_context", {
    customer, view, include_similar: true,
  });

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), "oil-customer-resolution-"));
  await put("oil.config.yaml", "frontmatter_schema:\n  title_field: account_title\n");
  await put(hubPath, `---
tags: [customer, enterprise]
tpid: "100200"
account_title: Contoso Account
title: Unconfigured Title
aliases: [Contoso, Shared Account, Fabrikam, Unindexed, Contoso, 42, null]
---
# Contoso Hub

## Team
- Alice Example (CSA)

## Connect Hooks
- Synthetic delivery outcome.

## Tasks
- [ ] Hub task for [[Alice Example]]

[[Contoso Sync]]
`);
  await put(`Customers/${canonical}/opportunities/Platform.md`, `---
account_title: Synthetic platform
opportunityId: "00000000-0000-0000-0000-000000000001"
aliases: [Opportunity Only, Contoso]
---
# Platform
`);
  await put(`Customers/${canonical}/milestones/Landing.md`, `---
account_title: Synthetic landing
milestoneId: MS-001
aliases: [Milestone Only]
---
# Landing
`);
  await put(`Customers/${canonical}/insights/2026-Q4.md`, "- Partitioned synthetic insight.\n");
  await put(`Customers/${canonical}/Notes.md`, "---\nalias: Nonhub Only\n---\n# Nonhub Title\n");
  await put(`Customers/${canonical}/Subfolder/Nested.md`, "---\nalias: Deep Only\n---\n# Nested\n");
  await put("People/Alice Example.md", `---
customers: [${canonical}]
aliases: [Person Only]
---
# Alice Example

CSA for [[${canonical}]].
`);
  await put("Meetings/Contoso Sync.md", `---
customer: ${canonical}
aliases: [Meeting Only]
---
# Contoso Sync

Discussed [[${canonical}]].
- [ ] Meeting task
`);
  await put("Customers/Fabrikam.md", `---
alias: Fabric
tpid: "200300"
tags: [customer, enterprise]
---
# Fabrikam Hub

## Opportunities
- Synthetic flat opportunity

## Milestones
- Synthetic flat milestone

## Agent Insights
- Flat insight.
`);
  await put("Customers/Northwind/Northwind.md", "---\nAliases: North Wind\n---\n# Northwind\n");
  await put("Customers/Woodgrove/Woodgrove.md", `---
ALIAS: [Wood Grove, Shared Account]
account_title: Duplicate Title
---
# Woodgrove
`);
  await put("Customers/Adventure/Adventure.md", "---\naccount_title: Duplicate Title\n---\n# Adventure\n");
  await put("Customers/Dual.md", "---\nalias: Flat Dual\n---\n# Flat Dual Hub\n");
  await put("Customers/Dual/Dual.md", "---\nalias: Nested Dual\n---\n# Nested Dual Hub\n");
  await put("Customers/Space  Corp/Space  Corp.md", "---\nalias: First Space\n---\n# Space A\n");
  await put("Customers/Space Corp/Space Corp.md", "---\nalias: Second Space\n---\n# Space B\n");
  await put("Customers/Fresh/Fresh.md", "---\nalias: Fresh Alias\n---\n# Fresh\n\n## Agent Insights\n- Old insight.\n");
  harness = await setupHarness(vault);
});

afterAll(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe("Customer hub identity lookup", () => {
  it.each([
    ["Contoso", canonical, hubPath],
    ["  cOnToSo  ", canonical, hubPath],
    [" contoso   corporation ", canonical, hubPath],
    ["Contoso Account", canonical, hubPath],
    ["Contoso Hub", canonical, hubPath],
    [" fabric ", "Fabrikam", "Customers/Fabrikam.md"],
    ["Fabrikam Hub", "Fabrikam", "Customers/Fabrikam.md"],
    [" NORTH   WIND ", "Northwind", "Customers/Northwind/Northwind.md"],
    ["wood grove", "Woodgrove", "Customers/Woodgrove/Woodgrove.md"],
  ])("resolves %s to %s at its canonical path", async (input, customer, path) => {
    const result = await context(input);
    expect(result.error).toBeUndefined();
    expect(result.customer).toBe(customer);
    expect(result.customer_path).toBe(path);
  });

  it("keeps exact canonical names ahead of another hub's aliases", async () => {
    const result = await context("Fabrikam");
    expect(result.customer).toBe("Fabrikam");
    expect(result.customer_path).toBe("Customers/Fabrikam.md");
    expect(result.agentInsights).toEqual(["Flat insight."]);
    expect(result.opportunities).toHaveLength(1);
    expect(result.milestones).toHaveLength(1);
  });

  it.each(["Dual", "Flat Dual", "Nested Dual", "Flat Dual Hub", "Nested Dual Hub"])(
    "keeps nested precedence for %s when both layouts exist",
    async (name) => {
      const result = await context(name);
      expect(result.customer).toBe("Dual");
      expect(result.customer_path).toBe("Customers/Dual/Dual.md");
      expect(result.frontmatter.alias).toBe("Nested Dual");
    },
  );

  it.each([
    ["Shared Account", [
      { customer: canonical, customer_path: hubPath },
      { customer: "Woodgrove", customer_path: "Customers/Woodgrove/Woodgrove.md" },
    ]],
    ["duplicate title", [
      { customer: "Adventure", customer_path: "Customers/Adventure/Adventure.md" },
      { customer: "Woodgrove", customer_path: "Customers/Woodgrove/Woodgrove.md" },
    ]],
    [" fabrikam ", [
      { customer: canonical, customer_path: hubPath },
      { customer: "Fabrikam", customer_path: "Customers/Fabrikam.md" },
    ]],
    [" space   corp ", [
      { customer: "Space  Corp", customer_path: "Customers/Space  Corp/Space  Corp.md" },
      { customer: "Space Corp", customer_path: "Customers/Space Corp/Space Corp.md" },
    ]],
  ])("returns explicit, sorted ambiguity for %s", async (input, candidates) => {
    for (const view of views) {
      const result = await context(input, view);
      expect(result.error_code).toBe("CONFLICT");
      expect(result.error).toMatch(/ambiguous/i);
      expect(result.candidates).toEqual(candidates);
      expect(result.customer_path).toBeUndefined();
      expect(result.write_targets).toBeUndefined();
      expect(result.agent_guidance.next_step).toMatch(/exact customer name/);
    }
  });

  it.each(["Space  Corp", "Space Corp"])("preserves exact identity despite normalization collisions: %s", async (input) => {
    const result = await context(input);
    expect(result.customer).toBe(input);
    expect(result.customer_path).toBe(`Customers/${input}/${input}.md`);
  });

  it.each([
    "Unknown Customer", "Contos", "CORPORATION", "Contoso Subsidiary",
    "Opportunity Only", "Milestone Only", "Nonhub Only", "Nonhub Title",
    "Deep Only", "Person Only", "Meeting Only", "Unconfigured Title", "42",
  ])("does not invent a hub for %s", async (input) => {
    const result = await context(input);
    expect(result.error_code).toBe("NOT_FOUND");
    expect(result.agent_guidance.suggested_tools).toContain("query_frontmatter");
    expect(result.customer_path).toBeUndefined();
  });

  it.each(["", "   ", "../Contoso", "Contoso/Other", "Contoso\\Other", "Contoso\0"])(
    "preserves input safety for %j", async (input) => {
      expect((await context(input)).error_code).toBe("INVALID_INPUT");
    },
  );

  it("leaves literal path construction unchanged for aliases and new notes", async () => {
    expect(await resolveCustomerPath(vault, harness.config, "Contoso"))
      .toBe("Customers/Contoso/Contoso.md");
    expect(await resolveCustomerPath(vault, harness.config, "New Customer"))
      .toBe("Customers/New Customer/New Customer.md");
    expect(await resolveCustomerPath(vault, harness.config, "Fabrikam"))
      .toBe("Customers/Fabrikam.md");
    expect(await resolveCustomerPath(vault, harness.config, "Dual"))
      .toBe("Customers/Dual/Dual.md");
  });

  it("preserves literal exact reads ahead of aliases for a hub not yet in the graph", async () => {
    await put("Customers/Unindexed/Unindexed.md", "# Unindexed\n");
    const result = await context("Unindexed");
    expect(result.customer_path).toBe("Customers/Unindexed/Unindexed.md");
    expect(result.error).toBeUndefined();
  });

  it("keeps filesystem nested precedence and flat fallback when the graph is behind", async () => {
    await put("Customers/Transition.md", "---\nalias: Transition Alias\n---\n# Flat Transition\n");
    await harness.graph.updateNote("Customers/Transition.md");
    await put("Customers/Transition/Transition.md", "# Nested Transition\n");
    expect((await context("Transition Alias")).customer_path).toBe("Customers/Transition/Transition.md");
    await harness.graph.updateNote("Customers/Transition/Transition.md");
    await rm(join(vault, "Customers/Transition/Transition.md"));
    const result = await context("Transition Alias");
    expect(result.customer_path).toBe("Customers/Transition.md");
    expect(result.error).toBeUndefined();
  });

  it("honors a configured customer root without accepting the default root's aliases", async () => {
    const other = await mkdtemp(join(tmpdir(), "oil-customer-root-"));
    try {
      await writeFile(join(other, "oil.config.yaml"), "schema:\n  customers_root: Accounts/\n");
      await mkdir(join(other, "Accounts"));
      await mkdir(join(other, "Customers"));
      await writeFile(join(other, "Accounts", "Example.md"), "---\nalias: Account Alias\n---\n# Account Title\n");
      await writeFile(join(other, "Customers", "Other.md"), "---\nalias: Default Only\n---\n# Other\n");
      const alternate = await setupHarness(other);
      const result = await alternate.server.callToolJson("get_customer_context", { customer: "account alias" });
      expect(result.customer).toBe("Example");
      expect(result.customer_path).toBe("Accounts/Example.md");
      const excluded = await alternate.server.callToolJson("get_customer_context", { customer: "Default Only" });
      expect(excluded.error_code).toBe("NOT_FOUND");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("Canonical-equivalent customer context", () => {
  it.each(views)("assembles identical %s data, versions and targets through aliases, names and TPIDs", async (view) => {
    const expected = await context(canonical, view);
    expect(expected.customer_path).toBe(hubPath);
    expect(expected.customer_version).toBe(expected.customer_mtime_ms);
    expect(expected.opportunities).toEqual([{
      name: "Synthetic platform", guid: "00000000-0000-0000-0000-000000000001",
    }]);
    expect(expected.milestones).toEqual([{ name: "Synthetic landing", id: "MS-001" }]);
    expect(expected.team).toHaveLength(1);
    expect(expected.linkedPeople.map((ref: { path: string }) => ref.path)).toEqual(["People/Alice Example.md"]);
    expect(expected.recentMeetings.map((ref: { path: string }) => ref.path)).toEqual(["Meetings/Contoso Sync.md"]);
    expect(expected.openItems.map((item: { text: string }) => item.text)).toEqual([
      "Hub task for [[Alice Example]]", "Meeting task",
    ]);
    if (view === "brief") {
      expect(expected.summary.agent_insight_count).toBeGreaterThan(0);
      expect(expected.summary.connect_hooks_present).toBe(true);
      expect(expected.summary.similar_customer_count).toBeGreaterThan(0);
    } else {
      expect(expected.agentInsights).toContain("Partitioned synthetic insight.");
      expect(expected.connectHooks).toContain("Synthetic delivery outcome.");
      expect(expected.similarCustomers.length).toBeGreaterThan(0);
    }
    if (view === "write") expect(expected.write_targets.customer_note).toBe(hubPath);
    for (const input of ["Contoso", " CONTOSO ", "contoso   corporation", "Contoso Account", "100200", " 100200 "]) {
      expect(await context(input, view)).toEqual(expected);
    }
  });

  it.each(views)("preserves flat hub TPID and alias equivalence in %s", async (view) => {
    const expected = await context("Fabrikam", view);
    expect(await context("Fabric", view)).toEqual(expected);
    expect(await context("200300", view)).toEqual(expected);
  });

  it("keeps unknown TPID behavior unchanged", async () => {
    const result = await context("99999999");
    expect(result.error_code).toBe("NOT_FOUND");
    expect(result.error).toContain("TPID");
    expect(result.agent_guidance.suggested_tools).toContain("query_frontmatter");
  });

  it("revalidates the same canonical cache entry and updates aliases with graph changes", async () => {
    const before = await context("Fresh Alias", "write");
    const file = join(vault, "Customers/Fresh/Fresh.md");
    await put("Customers/Fresh/Fresh.md", "---\nalias: New Fresh Alias\n---\n# Fresh\n\n## Agent Insights\n- New insight.\n");
    const changedAt = new Date(before.customer_mtime_ms + 5000);
    await utimes(file, changedAt, changedAt);

    const refreshed = await context("Fresh Alias", "write");
    expect(refreshed.agentInsights).toEqual(["New insight."]);
    expect(refreshed.customer_version).toBe((await stat(file)).mtimeMs);
    expect(refreshed.customer_version).toBeGreaterThan(before.customer_version);
    expect(await context("Fresh", "write")).toEqual(refreshed);

    await harness.graph.updateNote("Customers/Fresh/Fresh.md");
    expect((await context("Fresh Alias")).error_code).toBe("NOT_FOUND");
    expect(await context("New Fresh Alias", "write")).toEqual(refreshed);
    harness.graph.removeNote("Customers/Fresh/Fresh.md");
    await rm(file);
    expect((await context("New Fresh Alias")).error_code).toBe("NOT_FOUND");
  });
});
