/**
 * Dirty-vault robustness regression.
 *
 * These tests intentionally build a messy vault: malformed frontmatter,
 * circular links, deep folders with spaces, unsupported attachments, and
 * hidden Obsidian state. The goal is to ensure indexing and retrieval stay
 * operational for the healthy notes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { DEFAULT_CONFIG } from "../config.js";
import { searchVault, invalidateSearchIndex } from "../search.js";
import { listAllNotes } from "../vault.js";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-dirty-vault-"));
  vaultRoot = join(tempDir, "vault");

  await mkdir(join(vaultRoot, "Customers"), { recursive: true });
  await mkdir(join(vaultRoot, "Reference"), { recursive: true });
  await mkdir(join(vaultRoot, "Daily Notes"), { recursive: true });
  await mkdir(join(vaultRoot, "Messy Folder/Sub Folder"), { recursive: true });
  await mkdir(join(vaultRoot, ".obsidian"), { recursive: true });
  await mkdir(join(vaultRoot, "Attachments"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Anchor Customer.md"),
    `---
tags: [customer]
---

# Anchor Customer

Healthy note that should remain searchable.
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Reference/Broken Frontmatter.md"),
    `---
tags: [customer
status: active
---

# Broken Frontmatter

This note should be skipped instead of crashing the index.
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Reference/Circle A.md"),
    `# Circle A

Links to [[Circle B]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Reference/Circle B.md"),
    `# Circle B

Links back to [[Circle A]].
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Daily Notes/2026-04-20 messy note.md"),
    `# 2026-04-20 messy note

${"Filler paragraph. ".repeat(250)}
Escalation-marker: network dependency still blocks cutover.
`,
    "utf-8",
  );

  await writeFile(
    join(vaultRoot, "Messy Folder/Sub Folder/Quarterly Review.md"),
    `# Quarterly Review

Discussed roadmap carryover and migration dependencies.
`,
    "utf-8",
  );

  await writeFile(join(vaultRoot, ".obsidian/Ignored.md"), "# Hidden\n", "utf-8");
  await writeFile(join(vaultRoot, "Attachments/report.pdf"), Buffer.from("%PDF-1.4"));

  graph = new GraphIndex(vaultRoot);
  await graph.build();
  invalidateSearchIndex();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("dirty-vault robustness", () => {
  it("indexes healthy notes while skipping malformed and unsupported files", async () => {
    const notes = await listAllNotes(vaultRoot);

    expect(notes).toContain("Reference/Broken Frontmatter.md");
    expect(notes).toContain("Daily Notes/2026-04-20 messy note.md");
    expect(notes).not.toContain(".obsidian/Ignored.md");
    expect(notes).not.toContain("Attachments/report.pdf");

    expect(graph.getNode("Reference/Broken Frontmatter.md")).toBeUndefined();
    expect(graph.nodeCount).toBe(5);
    expect(graph.getNode("Customers/Anchor Customer.md")).toBeDefined();
  });

  it("keeps search functional when malformed frontmatter exists nearby", () => {
    const results = searchVault(graph, DEFAULT_CONFIG, "Anchor Customer", undefined, 5);
    expect(results.some((result) => result.path === "Customers/Anchor Customer.md")).toBe(true);
  });

  it("handles circular links without duplicate related notes", () => {
    const related = graph.getRelatedNotes("Reference/Circle A.md", 6);
    expect(related).toEqual([
      {
        path: "Reference/Circle B.md",
        title: "Circle B",
        tags: [],
        ref: "Reference/Circle B.md",
      },
    ]);
  });

  it("finds notes in folders with spaces and large bodies", () => {
    const folderResults = searchVault(graph, DEFAULT_CONFIG, "Quarterly Review", undefined, 5);
    expect(folderResults.some((result) => result.path === "Messy Folder/Sub Folder/Quarterly Review.md")).toBe(true);

    const largeBodyResults = searchVault(graph, DEFAULT_CONFIG, "Escalation-marker", undefined, 5);
    expect(largeBodyResults.some((result) => result.path === "Daily Notes/2026-04-20 messy note.md")).toBe(true);
  });
});