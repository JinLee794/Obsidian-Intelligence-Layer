import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const specPath = join(repoRoot, "_specs/13-knowledge-node-catalog.md");
const specIndexPath = join(repoRoot, "_specs/README.md");

describe("knowledge catalog specification contract", () => {
  it("keeps the active spec indexed and explicitly compatibility-first", async () => {
    const [spec, index] = await Promise.all([
      readFile(specPath, "utf-8"),
      readFile(specIndexPath, "utf-8"),
    ]);

    expect(index).toContain("[Knowledge Node Catalog](./13-knowledge-node-catalog.md)");
    expect(spec).toContain("**Version:** 0.2");
    expect(spec).toContain("**Status:** Implemented in OIL 0.6.0");
    expect(spec).toContain("**Compatibility model:** Compatibility-first");
    expect(spec).toContain("no required migration of existing Obsidian notes");
  });

  it("preserves the MCP-substrate and skill-policy boundary", async () => {
    const spec = await readFile(specPath, "utf-8");

    expect(spec).toContain("### 2.1 MCP and skill boundary");
    expect(spec).toContain("The knowledge nodes are data, not tools.");
    expect(spec).toContain("Catalog MCP + policy skill");
    expect(spec).toContain("it MUST NOT register one tool or eagerly enumerated resource per note");
  });

  it("keeps context ceilings and staged retrieval normative", async () => {
    const spec = await readFile(specPath, "utf-8");

    expect(spec).toContain("### 10.6 Staged retrieval and context budgets");
    expect(spec).toContain("### 10.7 Hard bounds");
    expect(spec).toContain("| Search results | 5 | 20 |");
    expect(spec).toContain("| Graph hops | 1 | 2 |");
    expect(spec).toContain("A shared response shaper MUST enforce the stage's serialized-character budget");
  });

  it("retains empirical evidence and the measured storage decision", async () => {
    const spec = await readFile(specPath, "utf-8");

    expect(spec).toContain("### 7.5 Storage backend decision");
    expect(spec).toContain("enhanced in-memory indices with versioned, atomically replaced JSON persistence");
    expect(spec).toContain("### 15.13 Empirical 10,000-note investigation");
    expect(spec).toContain("| Actual indexable files | 9,514 |");
    expect(spec).toContain("| Persisted graph size | ~5.0 MB |");
  });

  it("keeps confirmed issues tied to executable implementation phases", async () => {
    const spec = await readFile(specPath, "utf-8");

    for (const required of [
      "### 15.1 Frontmatter query is not actually a persistent O(1) index",
      "### 15.3 Full-content recall is capped",
      "### 15.9 Retrieval bounds are not enforced",
      "### 15.10 OIL writes are not immediately searchable by contract",
      "### Phase 0 — Characterize failures",
      "### Phase 1 — Context safety and consistency",
      "### Phase 2 — Canonical records and observed schema",
      "### Phase 3 — Unified search and full-content chunks",
    ]) {
      expect(spec).toContain(required);
    }
  });
});
