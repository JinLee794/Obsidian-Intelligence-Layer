/**
 * Result-quality guarantees that are easy to regress silently.
 *
 * Each of these was reported from real use rather than found by a unit test:
 * scores that mean different things on different code paths, a relevance floor
 * that never rejected anything, and tooling notes competing with knowledge.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import {
  cascadeSearch,
  invalidateSearchIndex,
  setExcludedFolders,
  getExcludedFolders,
} from "../search.js";
import { applyEnvOverrides, DEFAULT_CONFIG } from "../config.js";

let tempDir: string;
let vault: string;
let graph: GraphIndex;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-quality-"));
  vault = join(tempDir, "vault");
  await mkdir(join(vault, "Customers"), { recursive: true });
  await mkdir(join(vault, "sidekick", "skills"), { recursive: true });
  await mkdir(join(vault, "_agent-log"), { recursive: true });

  await writeFile(
    join(vault, "Customers/Contoso.md"),
    `---\ntags: [customer]\n---\n# Contoso\n\n## Status\n\nMigration planning underway.\n`,
    "utf-8",
  );
  await writeFile(
    join(vault, "Customers/Northwind.md"),
    `---\ntags: [customer]\n---\n# Northwind\n\n## Status\n\nRenewal planning underway.\n`,
    "utf-8",
  );
  await writeFile(
    join(vault, "sidekick/skills/planning.md"),
    `---\ntags: [skill]\n---\n# Planning Skill\n\nHow to run migration planning sessions.\n`,
    "utf-8",
  );
  await writeFile(
    join(vault, "_agent-log/2026-08-15.md"),
    `---\ntags: [log]\n---\n# Log\n\nplanning migration write recorded.\n`,
    "utf-8",
  );

  graph = new GraphIndex(vault);
  await graph.build();
  invalidateSearchIndex();
});

afterEach(() => {
  setExcludedFolders([]);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("result scores", () => {
  it("normalises the top hit to 1 on the confident lexical path", async () => {
    const { results, escalation } = await cascadeSearch(graph, "Contoso", 1, undefined);
    expect(escalation).toBeNull();
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("normalises the top hit to 1 on the escalated path too", async () => {
    // Raw reciprocal-rank sums put a single-tier top hit at 1/61 and two
    // agreeing tiers at 2/61, so the same field used to mean different things
    // depending on whether the query escalated.
    const { results, escalation } = await cascadeSearch(graph, "planning", 10, undefined);
    expect(escalation).not.toBeNull();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("keeps every score within a comparable range", async () => {
    const { results } = await cascadeSearch(graph, "planning", 10, undefined);
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("orders results by descending score", async () => {
    const { results } = await cascadeSearch(graph, "planning", 10, undefined);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

describe("excluded folders", () => {
  it("returns tooling notes when nothing is excluded", async () => {
    const { results } = await cascadeSearch(graph, "planning", 10, undefined);
    expect(results.some((r) => r.path.startsWith("sidekick/"))).toBe(true);
  });

  it("drops excluded folders from every tier", async () => {
    setExcludedFolders(["sidekick/", "_agent-log/"]);
    const { results } = await cascadeSearch(graph, "planning", 10, undefined);

    expect(results.some((r) => r.path.startsWith("sidekick/"))).toBe(false);
    expect(results.some((r) => r.path.startsWith("_agent-log/"))).toBe(false);
    expect(results.some((r) => r.path.startsWith("Customers/"))).toBe(true);
  });

  it("normalises a folder without its trailing slash", async () => {
    setExcludedFolders(["sidekick"]);
    expect(getExcludedFolders()).toEqual(["sidekick/"]);
    const { results } = await cascadeSearch(graph, "planning", 10, undefined);
    expect(results.some((r) => r.path.startsWith("sidekick/"))).toBe(false);
  });

  it("lets an explicit folder filter override the exclusion", async () => {
    // Asking for the folder by name is a deliberate request for it, not an
    // accident of ranking.
    setExcludedFolders(["sidekick/"]);
    const { results } = await cascadeSearch(graph, "planning", 10, {
      folder: "sidekick/",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.path.startsWith("sidekick/"))).toBe(true);
  });

  it("ignores blank entries", () => {
    setExcludedFolders(["", "  ", "Templates/"]);
    expect(getExcludedFolders()).toEqual(["Templates/"]);
  });
});

describe("exclude configuration", () => {
  it("reads a comma-separated list from the environment", () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      OIL_EXCLUDE_FOLDERS: "sidekick/, _agent-log/ ,Templates/",
    });
    expect(config.search.excludeFolders).toEqual(["sidekick/", "_agent-log/", "Templates/"]);
  });

  it("leaves the configured value alone when the variable is absent", () => {
    const withYaml = {
      ...DEFAULT_CONFIG,
      search: { ...DEFAULT_CONFIG.search, excludeFolders: ["FromYaml/"] },
    };
    expect(applyEnvOverrides(withYaml, {}).search.excludeFolders).toEqual(["FromYaml/"]);
  });

  it("defaults to excluding nothing", () => {
    expect(DEFAULT_CONFIG.search.excludeFolders).toEqual([]);
  });
});

describe("semantic relevance floor", () => {
  it("defaults above the noise band measured on a real vault", () => {
    // Real queries scored 0.554-0.749 against their best note; gibberish topped
    // out at 0.531 and off-topic English at 0.454. A floor of 0.45 sat below all
    // of it, so "no match" was unreachable.
    expect(DEFAULT_CONFIG.semantic.minScore).toBeGreaterThan(0.45);
    expect(DEFAULT_CONFIG.semantic.minScore).toBeLessThan(0.554);
  });
});

describe("weighted rank fusion", () => {
  it("keeps a note only one tier found ahead of notes several tiers merely mention", async () => {
    // Equal-weight fusion let two tiers agreeing at rank 0 (~0.033) outvote a
    // single confident hit (~0.016), so a correct answer the semantic tier
    // ranked first could fall out of the results entirely.
    const { results, escalation } = await cascadeSearch(graph, "planning", 10, undefined);
    expect(escalation).not.toBeNull();

    const single = results.filter((r) => r.matchedBy.length === 1);
    expect(single.length).toBeGreaterThan(0);
  });

  it("still lets the lexical tier lead when it covered the query", async () => {
    // Down-weighting is tied to coverage, so a query the lexical tier did
    // understand must not be demoted.
    const { results } = await cascadeSearch(graph, "Northwind renewal", 10, undefined);
    expect(results[0].path).toBe("Customers/Northwind.md");
  });

  it("does not disturb a confident lexical answer", async () => {
    const { results, escalation } = await cascadeSearch(graph, "Contoso", 1, undefined);
    expect(escalation).toBeNull();
    expect(results[0].path).toBe("Customers/Contoso.md");
  });
});
