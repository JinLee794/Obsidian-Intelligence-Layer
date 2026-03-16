/**
 * Tests for query.ts — frontmatter predicate query engine.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryNotes } from "../query.js";
import { GraphIndex } from "../graph.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-query-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso.md"),
    `---
tags: [customer, active]
tpid: "12345"
status: engaged
---

# Contoso
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Customers/Fabrikam.md"),
    `---
tags: [customer]
status: prospecting
---

# Fabrikam
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-03-01 - Sync.md"),
    `---
tags: [meeting]
customer: Contoso
date: "2026-03-01"
status: completed
---

# Sync
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Meetings/2026-02-15 - Kickoff.md"),
    `---
tags: [meeting]
customer: Fabrikam
date: "2026-02-15"
status: scheduled
---

# Kickoff
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "People/Alice.md"),
    `---
tags: [person, internal]
company: Microsoft
org: internal
---

# Alice
`,
    "utf-8",
  );

  graph = new GraphIndex(vaultRoot);
  await graph.build();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("queryNotes — WHERE predicate", () => {
  it("matches by tags (single)", () => {
    const results = queryNotes(graph, config, { where: { tags: "customer" } });
    expect(results.length).toBe(2);
    expect(results.map((r) => r.title).sort()).toEqual(["Contoso", "Fabrikam"]);
  });

  it("matches by tags (array — all must match)", () => {
    const results = queryNotes(graph, config, {
      where: { tags: ["customer", "active"] },
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Contoso");
  });

  it("matches by frontmatter field (status)", () => {
    const results = queryNotes(graph, config, {
      where: { status: "engaged" },
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Contoso");
  });

  it("matches by customer field", () => {
    const results = queryNotes(graph, config, {
      where: { customer: "Contoso" },
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Sync");
  });

  it("field matching is case-insensitive", () => {
    const results = queryNotes(graph, config, {
      where: { customer: "contoso" },
    });
    expect(results.length).toBe(1);
  });

  it("returns empty for no match", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "nonexistent" },
    });
    expect(results).toEqual([]);
  });
});

describe("queryNotes — AND / OR predicates", () => {
  it("AND narrows results", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      and: [{ status: "completed" }],
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Sync");
  });

  it("OR broadens results", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "customer" },
      or: [{ status: "engaged" }, { status: "prospecting" }],
    });
    expect(results.length).toBe(2);
  });

  it("AND + OR combined", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      and: [{ tags: "meeting" }],
      or: [{ customer: "Contoso" }, { customer: "Fabrikam" }],
    });
    expect(results.length).toBe(2);
  });
});

describe("queryNotes — folder filter", () => {
  it("restricts to folder prefix", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      folder: "Meetings/",
    });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.path.startsWith("Meetings/"))).toBe(true);
  });

  it("returns empty if folder has no matches", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "customer" },
      folder: "Meetings/",
    });
    expect(results.length).toBe(0);
  });
});

describe("queryNotes — ordering and limits", () => {
  it("orders by date ascending", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      orderBy: "date",
    });
    expect(results[0].title).toBe("Kickoff"); // 2026-02-15
    expect(results[1].title).toBe("Sync"); // 2026-03-01
  });

  it("orders by date descending", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      orderBy: "-date",
    });
    expect(results[0].title).toBe("Sync");
    expect(results[1].title).toBe("Kickoff");
  });

  it("limits results", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "meeting" },
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it("orderBy title sorts alphabetically", () => {
    const results = queryNotes(graph, config, {
      where: { tags: "customer" },
      orderBy: "title",
    });
    expect(results[0].title).toBe("Contoso");
    expect(results[1].title).toBe("Fabrikam");
  });
});

describe("queryNotes — folder predicate in where", () => {
  it("filters by folder in predicate", () => {
    const results = queryNotes(graph, config, {
      where: { folder: "People/" },
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Alice");
  });
});
