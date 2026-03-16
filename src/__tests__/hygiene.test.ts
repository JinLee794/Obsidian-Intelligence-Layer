/**
 * Tests for hygiene.ts — freshness scanning, staleness detection, vault health.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { checkCustomerFreshness, checkVaultHealth } from "../hygiene.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;
let config: OilConfig;
let cache: SessionCache;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-hygiene-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  // Create nested customer layout (Customers/<name>/<name>.md)
  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Contoso/opportunities"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Contoso/milestones"), { recursive: true });
  await mkdir(join(vaultRoot, "Customers/Fabrikam"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });

  // Contoso — complete customer file with stale insights
  const past = new Date();
  past.setDate(past.getDate() - 60);
  const staleDate = past.toISOString().slice(0, 10);

  const recent = new Date();
  recent.setDate(recent.getDate() - 5);
  const recentDate = recent.toISOString().slice(0, 10);

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer]
tpid: "12345"
last_validated: "2026-01-15"
---

# Contoso

## Team

- Alice (CSA)
- Bob (Specialist)

## Agent Insights

- ${staleDate} Old stale insight that should be flagged
- ${recentDate} Recent fresh insight

## Connect Hooks

- 2026-02-01 | Individual
  - Hook: Great feedback on migration
`,
    "utf-8",
  );

  // Contoso opportunities — one with guid, one without
  await writeFile(
    join(vaultRoot, "Customers/Contoso/opportunities/Cloud Migration.md"),
    `---
tags: [opportunity]
guid: "abc-123"
status: active
---

# Cloud Migration
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Contoso/opportunities/Security Review.md"),
    `---
tags: [opportunity]
status: qualifying
---

# Security Review
`,
    "utf-8",
  );

  // Contoso milestone — one with id, one without
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
    join(vaultRoot, "Customers/Contoso/milestones/Go Live.md"),
    `---
tags: [milestone]
---

# Go Live
`,
    "utf-8",
  );

  // Fabrikam — minimal customer file
  await writeFile(
    join(vaultRoot, "Customers/Fabrikam/Fabrikam.md"),
    `---
tags: [customer]
---

# Fabrikam

Sparse customer file with no sections.
`,
    "utf-8",
  );

  // Meeting linked to Contoso
  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Contoso Sync.md"),
    `---
tags: [meeting]
customer: Contoso
date: "2026-03-01"
---

# Contoso Sync
`,
    "utf-8",
  );

  // Orphaned meeting — no customer link
  await writeFile(
    join(vaultRoot, "Meetings/2026-03-05 - Random Sync.md"),
    `---
tags: [meeting]
date: "2026-03-05"
---

# Random Sync

No customer reference here.
`,
    "utf-8",
  );

  graph = new GraphIndex(vaultRoot);
  await graph.build();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  cache = new SessionCache();
});

describe("checkCustomerFreshness", () => {
  it("returns freshness for a well-populated customer", async () => {
    const freshness = await checkCustomerFreshness(
      vaultRoot, graph, config, cache, "Contoso",
    );
    expect(freshness.customer).toBe("Contoso");
    expect(freshness.path).toContain("Contoso");
    expect(freshness.lastModified).toBeInstanceOf(Date);
    expect(freshness.lastValidated).toBe("2026-01-15");
    expect(freshness.hasTeam).toBe(true);
    expect(freshness.hasConnectHooks).toBe(true);
  });

  it("detects stale agent insights (>30 days old)", async () => {
    const freshness = await checkCustomerFreshness(
      vaultRoot, graph, config, cache, "Contoso",
    );
    expect(freshness.staleInsights.length).toBeGreaterThanOrEqual(1);
    expect(freshness.staleInsights[0].ageDays).toBeGreaterThan(30);
  });

  it("reports opportunity completeness", async () => {
    const freshness = await checkCustomerFreshness(
      vaultRoot, graph, config, cache, "Contoso",
    );
    expect(freshness.opportunityCompleteness.total).toBe(2);
    expect(freshness.opportunityCompleteness.withGuid).toBe(1);
    expect(freshness.opportunityCompleteness.missingGuid).toContain("Security Review");
  });

  it("returns empty data for missing customer", async () => {
    const freshness = await checkCustomerFreshness(
      vaultRoot, graph, config, cache, "Nonexistent Corp",
    );
    expect(freshness.lastModified).toBeNull();
    expect(freshness.hasTeam).toBe(false);
    expect(freshness.hasConnectHooks).toBe(false);
  });

  it("handles sparse customer file", async () => {
    const freshness = await checkCustomerFreshness(
      vaultRoot, graph, config, cache, "Fabrikam",
    );
    expect(freshness.customer).toBe("Fabrikam");
    expect(freshness.hasTeam).toBe(false);
    expect(freshness.hasConnectHooks).toBe(false);
    expect(freshness.staleInsights).toEqual([]);
  });
});

describe("checkVaultHealth", () => {
  it("returns health report covering all customers", async () => {
    const report = await checkVaultHealth(vaultRoot, graph, config, cache);
    expect(report.totalCustomers).toBe(2);
    expect(report.customers.length).toBe(2);
    expect(report.customers.map((c) => c.customer).sort()).toEqual([
      "Contoso", "Fabrikam",
    ]);
  });

  it("detects orphaned meetings", async () => {
    const report = await checkVaultHealth(vaultRoot, graph, config, cache);
    expect(report.orphanedMeetings).toContain(
      "Meetings/2026-03-05 - Random Sync.md",
    );
    // Contoso Sync is NOT orphaned
    expect(
      report.orphanedMeetings.every((m) => !m.includes("Contoso Sync")),
    ).toBe(true);
  });

  it("filters by customer name", async () => {
    const report = await checkVaultHealth(
      vaultRoot, graph, config, cache, ["Contoso"],
    );
    expect(report.customers.length).toBe(1);
    expect(report.customers[0].customer).toBe("Contoso");
  });

  it("filter is case-insensitive", async () => {
    const report = await checkVaultHealth(
      vaultRoot, graph, config, cache, ["contoso"],
    );
    expect(report.customers.length).toBe(1);
  });
});
